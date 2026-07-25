/**
 * Parser Claude Desktop (docs/sources.md).
 *
 * Реальное содержимое источника (изучено на живой машине, июль 2026):
 * документированные корни `IndexedDB`/`Session Storage` — Chromium LevelDB
 * с кэшем webapp (drafts, starred), диалогов там нет. Транскрипты диалогов
 * local agent mode (cowork) лежат рядом, в
 * `~/Library/Application Support/Claude/local-agent-mode-sessions/`:
 *
 *   <accountId>/<agentId>/local_<sessionId>.json     — метаданные сессии
 *   <accountId>/<agentId>/local_<sessionId>/audit.jsonl — полный транскрипт
 *
 * audit.jsonl — NDJSON в протоколе Claude Code; каждая строка — событие
 * {type, uuid, session_id, parent_tool_use_id, _audit_timestamp, _audit_hmac}:
 * - user: message.content — строка (промпт человека, возможно с обёрткой
 *   <uploaded_files>) или массив блоков text / tool_result (tool_use_id);
 * - assistant: message{model,id,content[],stop_reason,usage}; блоки
 *   thinking(+signature) / text / tool_use(id,name,input,caller).
 *   Одно API-сообщение стримится НЕСКОЛЬКИМИ строками с одним message.id:
 *   строки склеиваются в одно ParsedMessage, request usage привязывается
 *   один раз (иначе дубли текста и double-count usage — сценарий 18,
 *   как в claude-code parser'е);
 *   usage в семантике Anthropic: input_tokens НЕ включает cache —
 *   inputTokens = input + cache_creation + cache_read (как в kimi-code);
 * - system/init: cwd, cliSessionId, model, permissionMode, версии;
 * - result/success: граница turn'а — cumulative usage за весь запуск CLI
 *   (scope turn), stop_reason, num_turns, total_cost_usd, modelUsage;
 * - rate_limit_event, system/api_retry, system/permission_*: операционные —
 *   не сообщения, только metadata.eventCounts (образец — codex/kimi-code).
 *
 * События с parent_tool_use_id — sidechain субагента (Task): не
 * human-authored, не видимы пользователю, metadata.parentToolUseId.
 *
 * parse() принимает: каталог сессии local_*, файл audit.jsonl (метаданные
 * ищутся соседним local_*.json — работает на живом дереве; в плоском raw
 * архиве sibling отсутствует, тогда метаданные выводятся из событий),
 * standalone local_*.json (диалог не создаётся — diagnostic
 * session_metadata_only) и прочие файлы (LevelDB IndexedDB/Session Storage
 * и т.п. — diagnostic unsupported_file, raw при этом архивируется).
 *
 * Неизвестные типы событий и блоков НЕ роняют диалог: unknown чанк +
 * diagnostic (план §19.2 сценарий 11).
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  ParsedChunk,
  ParsedDiagnostic,
  ParsedDialogue,
  ParsedMessage,
  ParsedModelInvocation,
  ParsedSourceSnapshot,
  ParsedUsageEvent,
} from "../../domain/canonical-types.ts";
import type { HarnessParser, ParseContext } from "../shared/parser.ts";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  parseTimestamp,
  readJsonlFile,
} from "../shared/jsonl.ts";
import { normalizeModelName } from "../shared/model-normalization.ts";

export const CLAUDE_DESKTOP_PARSER_NAME = "claude-desktop";
export const CLAUDE_DESKTOP_PARSER_VERSION = 2;

/** Операционные subtype system/*: не сообщения, только счётчики. */
const OPERATIONAL_SYSTEM_SUBTYPES = new Set([
  "api_retry",
  "permission_request",
  "permission_response",
]);

const OPERATIONAL_TOP_LEVEL = new Set(["rate_limit_event"]);

interface SessionLayout {
  auditPath: string;
  /** Соседний local_<id>.json (может отсутствовать в плоском raw). */
  metadataPath?: string | undefined;
  /** Имя каталога сессии, если путь попадает под схему local_*. */
  dirSessionId?: string | undefined;
}

interface ModelState {
  model?: string;
  effort?: string;
}

export class ClaudeDesktopParser implements HarnessParser {
  readonly parserName = CLAUDE_DESKTOP_PARSER_NAME;
  readonly parserVersion = CLAUDE_DESKTOP_PARSER_VERSION;
  readonly sourceFormatVersions = ["audit-jsonl-1"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    const diagnostics: ParsedDiagnostic[] = [];
    const layout = await resolveLayout(snapshotPath, diagnostics);
    if (!layout) {
      return { sourceKind: "file_backed", dialogues: empty(), diagnostics };
    }

    let sessionMeta: Record<string, unknown> | undefined;
    if (layout.metadataPath) {
      try {
        sessionMeta = asObject(JSON.parse(await readFile(layout.metadataPath, "utf8")));
      } catch (error) {
        diagnostics.push({
          code: "session_metadata_error",
          message: `${layout.metadataPath}: ${error instanceof Error ? error.message : String(error)}`,
          severity: "warning",
          sourceLocator: layout.metadataPath,
        });
      }
    }

    const { records, errors } = await readJsonlFile(layout.auditPath);
    for (const error of errors) {
      diagnostics.push({
        code: "jsonl_parse_error",
        message: `${layout.auditPath}:${error.line}: ${error.error}`,
        severity: "error",
        sourceLocator: `${layout.auditPath}#L${error.line}`,
      });
    }

    const builder = new DialogueBuilder(layout, sessionMeta, context, diagnostics);
    for (const { line, value } of records) builder.event(value, line);
    const dialogue = builder.finish();
    return {
      sourceKind: "file_backed",
      dialogues: (async function* () {
        if (dialogue) yield dialogue;
      })(),
      diagnostics,
    };
  }
}

export const claudeDesktopParser = new ClaudeDesktopParser();

async function* empty(): AsyncIterable<ParsedDialogue> {}

/**
 * Определить, что за файл пришёл на вход. Возвращает undefined для файлов,
 * из которых диалог не извлекается (diagnostic уже записан).
 */
async function resolveLayout(
  snapshotPath: string,
  diagnostics: ParsedDiagnostic[],
): Promise<SessionLayout | undefined> {
  const info = await stat(snapshotPath).catch(() => undefined);

  if (info?.isDirectory()) {
    const auditPath = join(snapshotPath, "audit.jsonl");
    const auditStat = await stat(auditPath).catch(() => undefined);
    if (!auditStat?.isFile()) {
      diagnostics.push({
        code: "no_audit_file",
        message: `${snapshotPath}: no audit.jsonl inside`,
        severity: "error",
        sourceLocator: snapshotPath,
      });
      return undefined;
    }
    const name = basename(snapshotPath);
    const metadataPath = join(dirname(snapshotPath), `${name}.json`);
    const metadataStat = await stat(metadataPath).catch(() => undefined);
    return {
      auditPath,
      metadataPath: metadataStat?.isFile() ? metadataPath : undefined,
      dirSessionId: name.startsWith("local_") ? name : undefined,
    };
  }

  const name = basename(snapshotPath);
  if (name.endsWith(".jsonl")) {
    // audit.jsonl или плоский raw-снимок транскрипта.
    const parent = dirname(snapshotPath);
    const dirName = basename(parent);
    let metadataPath: string | undefined;
    if (dirName.startsWith("local_")) {
      const candidate = join(dirname(parent), `${dirName}.json`);
      const candidateStat = await stat(candidate).catch(() => undefined);
      if (candidateStat?.isFile()) metadataPath = candidate;
    }
    return {
      auditPath: snapshotPath,
      metadataPath,
      dirSessionId: dirName.startsWith("local_") ? dirName : undefined,
    };
  }

  if (name.endsWith(".json")) {
    diagnostics.push({
      code: "session_metadata_only",
      message: `${snapshotPath}: standalone session metadata (parsed only as auxiliary to audit.jsonl)`,
      severity: "warning",
      sourceLocator: snapshotPath,
    });
    return undefined;
  }

  // LevelDB (IndexedDB/Session Storage) и любые прочие файлы корня.
  diagnostics.push({
    code: "unsupported_file",
    message: `${snapshotPath}: not a claude-desktop transcript (LevelDB/binary source, archived as raw only)`,
    severity: "warning",
    sourceLocator: snapshotPath,
  });
  return undefined;
}

class DialogueBuilder {
  private messages: ParsedMessage[] = [];
  private metadata: Record<string, unknown> = {};
  private eventCounts: Record<string, number> = {};
  private unknownTypes = new Set<string>();
  private modelState: ModelState = {};
  private startedAt: Date | undefined;
  private updatedAt: Date | undefined;
  /** session_id из user/assistant событий (без префикса local_). */
  private eventSessionId: string | undefined;
  private lastAssistant: ParsedMessage | undefined;
  /** message.id (msg_*) уже получивших usage — дедупликация стриминга. */
  private usageSeen = new Set<string>();

  constructor(
    private readonly layout: SessionLayout,
    private readonly sessionMeta: Record<string, unknown> | undefined,
    private readonly context: ParseContext | undefined,
    private readonly diagnostics: ParsedDiagnostic[],
  ) {}

  event(record: Record<string, unknown>, line: number): void {
    const locator = `${this.layout.auditPath}#L${line}`;
    const timestamp =
      parseTimestamp(record.timestamp) ?? parseTimestamp(record._audit_timestamp);
    this.trackTime(timestamp);
    const type = asString(record.type);

    switch (type) {
      case "user":
        this.userEvent(record, timestamp, locator);
        return;
      case "assistant":
        this.assistantEvent(record, timestamp, locator);
        return;
      case "system":
        this.systemEvent(record, timestamp, locator);
        return;
      case "result":
        this.resultEvent(record);
        return;
      default:
        if (type && OPERATIONAL_TOP_LEVEL.has(type)) {
          this.count(type);
          return;
        }
        this.unknown(type ?? "<missing>", record, timestamp, locator);
    }
  }

  finish(): ParsedDialogue | undefined {
    if (this.messages.length === 0 && !this.sessionMeta) {
      this.diagnostics.push({
        code: "empty_snapshot",
        message: `${this.layout.auditPath}: no session metadata and no messages`,
        severity: "error",
      });
      return undefined;
    }
    this.metadata.eventCounts = this.eventCounts;

    const meta = this.sessionMeta;
    const externalId =
      asString(meta?.sessionId) ??
      this.layout.dirSessionId ??
      (this.eventSessionId ? `local_${this.eventSessionId}` : undefined);
    const startedAt = parseTimestamp(meta?.createdAt) ?? this.startedAt;
    const updatedAt = parseTimestamp(meta?.lastActivityAt) ?? this.updatedAt;

    return {
      ...(externalId !== undefined ? { externalId } : {}),
      ...(asString(meta?.title) !== undefined ? { title: asString(meta?.title) } : {}),
      ...(this.workspace() !== undefined ? { workspace: this.workspace() } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      messages: this.messages,
      metadata: this.metadata,
    };
  }

  // --- события ---

  private userEvent(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const message = asObject(record.message) ?? {};
    const content = message.content;
    const parentToolUseId = asString(record.parent_tool_use_id);
    const sidechain = parentToolUseId !== undefined;
    this.eventSessionId ??= sidechain ? undefined : asString(record.session_id);

    const extra: Record<string, unknown> = sidechain ? { parentToolUseId } : {};

    if (typeof content === "string") {
      this.pushMessage({
        externalId: asString(record.uuid),
        role: "user",
        rawRole: "user",
        // Промпт основной цепочки набран человеком; sidechain — промпт субагента.
        humanAuthored: !sidechain,
        visibleToUser: !sidechain,
        timestamp,
        chunks: this.userTextChunks(content, locator),
        metadata: extra,
      });
      return;
    }

    const blocks = asArray(content);
    // Текстовые блоки → user message; каждый tool_result → tool message.
    // Порядок блоков сохраняется порядком сообщений.
    const textChunks: ParsedChunk[] = [];
    const flushText = () => {
      if (textChunks.length === 0) return;
      this.pushMessage({
        externalId: asString(record.uuid),
        role: "user",
        rawRole: "user",
        humanAuthored: !sidechain,
        visibleToUser: !sidechain,
        timestamp,
        chunks: textChunks.splice(0, textChunks.length),
        metadata: { ...extra },
      });
    };
    for (const block of blocks) {
      const obj = asObject(block) ?? {};
      const blockType = asString(obj.type) ?? "unknown";
      if (blockType === "text") {
        const text = asString(obj.text) ?? "";
        if (text.trimStart().startsWith("<system-reminder>")) {
          flushText();
          this.pushMessage({
            externalId: asString(record.uuid),
            role: "system",
            rawRole: "user",
            humanAuthored: false,
            visibleToUser: false,
            timestamp,
            chunks: [
              this.chunk({
                kind: "system",
                rawKind: "text",
                content: text,
                sourceLocator: locator,
                metadata: { systemReminder: true },
              }),
            ],
            metadata: { ...extra },
          });
        } else {
          textChunks.push(...this.userTextChunks(text, locator));
        }
      } else if (blockType === "tool_result") {
        flushText();
        this.pushMessage({
          externalId: asString(record.uuid),
          role: "tool",
          rawRole: "user",
          humanAuthored: false,
          visibleToUser: false,
          timestamp,
          chunks: [
            this.chunk({
              kind: "tool_result",
              rawKind: "tool_result",
              content: toolResultText(obj),
              toolCallId: asString(obj.tool_use_id),
              rawEventType: "user.tool_result",
              sourceLocator: locator,
              metadata: { isError: obj.is_error === true },
            }),
          ],
          metadata: { ...extra },
        });
      } else if (blockType === "image") {
        textChunks.push(
          this.chunk({
            kind: "attachment",
            rawKind: "image",
            sourceLocator: locator,
            metadata: { image: true },
          }),
        );
      } else {
        this.unknownBlock(`user.content.${blockType}`, obj, locator, textChunks);
      }
    }
    flushText();
  }

  private assistantEvent(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const message = asObject(record.message) ?? {};
    const parentToolUseId = asString(record.parent_tool_use_id);
    const sidechain = parentToolUseId !== undefined;
    this.eventSessionId ??= sidechain ? undefined : asString(record.session_id);

    const chunks: ParsedChunk[] = [];
    for (const block of asArray(message.content)) {
      const obj = asObject(block) ?? {};
      const blockType = asString(obj.type) ?? "unknown";
      switch (blockType) {
        case "thinking":
          chunks.push(
            this.chunk({
              kind: "thought",
              rawKind: "thinking",
              content: asString(obj.thinking) ?? "",
              sourceLocator: locator,
              metadata: { hasSignature: asString(obj.signature) !== undefined },
            }),
          );
          break;
        case "text":
          chunks.push(
            this.chunk({
              kind: "text",
              rawKind: "text",
              content: asString(obj.text) ?? "",
              sourceLocator: locator,
              metadata: {},
            }),
          );
          break;
        case "tool_use":
          chunks.push(
            this.chunk({
              kind: "tool_call",
              rawKind: "tool_use",
              content: JSON.stringify(obj.input ?? {}),
              toolCallId: asString(obj.id),
              toolName: asString(obj.name),
              rawEventType: "assistant.tool_use",
              sourceLocator: locator,
              metadata: { caller: asString(asObject(obj.caller)?.type ?? obj.caller) },
            }),
          );
          break;
        default:
          this.unknownBlock(`assistant.content.${blockType}`, obj, locator, chunks);
      }
    }

    const model = asString(message.model);
    if (model) this.modelState.model = model;
    const apiId = asString(message.id);

    // Стриминг: несколько строк с одним message.id — одно API-сообщение.
    // Склеиваем чанки в предыдущее сообщение с тем же id (как claude-code).
    const existing = apiId !== undefined ? this.findAssistantByMessageId(apiId) : undefined;
    const usage = asObject(message.usage);
    if (existing) {
      // sequence выставляем вручную с учётом уже добавленных чанков.
      for (const chunk of chunks) {
        chunk.sequence = existing.chunks.length;
        existing.chunks.push(chunk);
      }
      // Видимость могла появиться с text-чанком продолжения стриминга.
      if (!sidechain && chunks.some((c) => c.kind === "text")) {
        existing.visibleToUser = true;
      }
      if (message.stop_reason != null) existing.metadata.stopReason = message.stop_reason;
      if (timestamp && (!existing.timestamp || timestamp < existing.timestamp)) {
        existing.timestamp = timestamp;
      }
      const event = this.requestUsageEvent(usage, apiId);
      if (event) existing.usageEvents.push(event);
      if (!sidechain) this.lastAssistant = existing;
      return;
    }

    const visible = chunks.some((c) => c.kind === "text");
    const parsed = this.pushMessage({
      externalId: asString(record.uuid),
      role: "assistant",
      rawRole: "assistant",
      humanAuthored: false,
      visibleToUser: sidechain ? false : visible,
      timestamp,
      model: this.modelInvocation(),
      chunks,
      metadata: {
        ...(apiId !== undefined ? { messageId: apiId } : {}),
        ...(message.stop_reason != null ? { stopReason: message.stop_reason } : {}),
        ...(sidechain ? { parentToolUseId } : {}),
      },
    });

    const event = this.requestUsageEvent(usage, apiId);
    if (event) parsed.usageEvents.push(event);
    if (!sidechain) this.lastAssistant = parsed;
  }

  /** usage одного API-сообщения, один раз на message.id (сценарий 18). */
  private requestUsageEvent(
    usage: Record<string, unknown> | undefined,
    apiId: string | undefined,
  ): ParsedUsageEvent | undefined {
    if (!usage) return undefined;
    if (apiId !== undefined) {
      if (this.usageSeen.has(apiId)) {
        this.count("usage.deduped");
        return undefined;
      }
      this.usageSeen.add(apiId);
    }
    return anthropicUsageEvent(usage, "request", "claude-desktop.assistant.message.usage");
  }

  private findAssistantByMessageId(apiId: string): ParsedMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (message.role !== "assistant") return undefined;
      if (message.metadata.messageId === apiId) return message;
    }
    return undefined;
  }

  private systemEvent(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const subtype = asString(record.subtype);
    if (subtype === "init") {
      const model = asString(record.model);
      if (model) this.modelState.model ??= model;
      this.metadata.cliSessionId = asString(record.session_id);
      this.metadata.claudeCodeVersion = asString(record.claude_code_version);
      this.metadata.permissionMode = asString(record.permissionMode);
      this.metadata.cwd = asString(record.cwd);
      this.count("system.init");
      return;
    }
    if (subtype && OPERATIONAL_SYSTEM_SUBTYPES.has(subtype)) {
      this.count(`system.${subtype}`);
      return;
    }
    this.unknown(`system.${subtype ?? "<missing>"}`, record, timestamp, locator);
  }

  /** result — граница turn'а: cumulative usage + marker финального ответа. */
  private resultEvent(record: Record<string, unknown>): void {
    const subtype = asString(record.subtype) ?? "unknown";
    this.count(`result.${subtype}`);
    const target = this.lastAssistant;
    if (!target) {
      this.diagnostics.push({
        code: "orphan_result_event",
        message: `${this.layout.auditPath}: result before any assistant message`,
        severity: "warning",
      });
      return;
    }
    const usage = asObject(record.usage);
    if (usage) {
      const raw = asObject(record.modelUsage)
        ? { usage, modelUsage: record.modelUsage }
        : usage;
      target.usageEvents.push(
        anthropicUsageEvent(usage, "turn", "claude-desktop.result.usage", raw),
      );
    }
    // Явный marker конца turn'а для extractor'а (план §8.3 п.1).
    target.metadata.turnResult = {
      subtype,
      ...(record.stop_reason != null ? { stopReason: record.stop_reason } : {}),
      ...(asNumber(record.num_turns) !== undefined ? { numTurns: asNumber(record.num_turns) } : {}),
      ...(asNumber(record.duration_ms) !== undefined ? { durationMs: asNumber(record.duration_ms) } : {}),
      ...(asNumber(record.total_cost_usd) !== undefined ? { totalCostUsd: asNumber(record.total_cost_usd) } : {}),
    };
  }

  // --- helpers ---

  /** Текст user'а: обёртка <uploaded_files> → attachment chunk, остаток → text. */
  private userTextChunks(text: string, locator: string): ParsedChunk[] {
    const chunks: ParsedChunk[] = [];
    let rest = text;
    const match = /^\s*<uploaded_files>([\s\S]*?)<\/uploaded_files>\s*/.exec(rest);
    if (match) {
      const files = [...match[1]!.matchAll(/<file_path>([^<]+)<\/file_path>/g)].map((m) => m[1]!);
      chunks.push(
        this.chunk({
          kind: "attachment",
          rawKind: "uploaded_files",
          sourceLocator: locator,
          metadata: { uploadedFiles: files },
        }),
      );
      rest = rest.slice(match[0].length);
    }
    chunks.push(
      this.chunk({
        kind: "text",
        rawKind: "text",
        content: rest,
        sourceLocator: locator,
        metadata: {},
      }),
    );
    return chunks;
  }

  private unknownBlock(
    rawEventType: string,
    block: Record<string, unknown>,
    locator: string,
    chunks: ParsedChunk[],
  ): void {
    if (!this.unknownTypes.has(rawEventType)) {
      this.unknownTypes.add(rawEventType);
      this.diagnostics.push({
        code: "unknown_event",
        message: `${this.layout.auditPath}: unknown content block ${rawEventType} (preserved as unknown chunk)`,
        severity: "warning",
        sourceLocator: locator,
      });
    }
    this.count(`unknown:${rawEventType}`);
    chunks.push(
      this.chunk({
        kind: "unknown",
        rawKind: rawEventType,
        content: JSON.stringify(block),
        rawEventType,
        sourceLocator: locator,
        metadata: {},
      }),
    );
  }

  private unknown(
    rawEventType: string,
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    if (!this.unknownTypes.has(rawEventType)) {
      this.unknownTypes.add(rawEventType);
      this.diagnostics.push({
        code: "unknown_event",
        message: `${this.layout.auditPath}: unknown event ${rawEventType} (preserved as unknown chunk)`,
        severity: "warning",
        sourceLocator: locator,
      });
    }
    this.count(`unknown:${rawEventType}`);
    this.pushMessage({
      externalId: asString(record.uuid),
      role: "unknown",
      rawRole: rawEventType,
      humanAuthored: false,
      visibleToUser: false,
      timestamp,
      chunks: [
        this.chunk({
          kind: "unknown",
          rawKind: rawEventType,
          content: JSON.stringify(record),
          rawEventType,
          sourceLocator: locator,
          metadata: {},
        }),
      ],
      metadata: {},
    });
  }

  private workspace(): ParsedDialogue["workspace"] {
    const meta = this.sessionMeta;
    const folders = asArray(meta?.userSelectedFolders)
      .map((f) => asString(f))
      .filter((f): f is string => Boolean(f));
    if (folders.length > 0) {
      this.metadata.folders = folders;
      return { path: folders[0], name: basename(folders[0]!) };
    }
    const cwd = asString(meta?.cwd) ?? asString(this.metadata.cwd);
    // "/sessions/<vm-name>" — путь внутри VM cowork, не локальный workspace.
    if (cwd && !cwd.startsWith("/sessions/")) {
      return { path: cwd, name: basename(cwd) };
    }
    const hint = this.context?.workspaceHint;
    if (hint) return { path: hint, name: basename(hint) };
    return undefined;
  }

  private modelInvocation(): ParsedModelInvocation | undefined {
    const raw = this.modelState.model;
    if (!raw) return undefined;
    const normalized = normalizeModelName(raw);
    const effort = asString(this.sessionMeta?.effort) ?? this.modelState.effort;
    return {
      rawModelName: raw,
      vendor: normalized.vendor,
      canonicalName: normalized.canonicalName,
      reasoningEffort: effort ?? normalized.reasoningEffort,
      serviceProvider: normalized.serviceProvider,
    };
  }

  private pushMessage(
    partial: Omit<ParsedMessage, "sequence" | "usageEvents" | "model" | "externalId"> & {
      externalId?: string | undefined;
      model?: ParsedModelInvocation | undefined;
    },
  ): ParsedMessage {
    const message: ParsedMessage = {
      sequence: this.messages.length,
      usageEvents: [],
      ...partial,
      chunks: partial.chunks.map((chunk, index) => ({ ...chunk, sequence: index })),
    };
    this.messages.push(message);
    return message;
  }

  private chunk(
    partial: Omit<ParsedChunk, "sequence" | "content" | "toolCallId" | "toolName" | "rawKind"> & {
      content?: string;
      rawKind?: string | undefined;
      toolCallId?: string | undefined;
      toolName?: string | undefined;
    },
  ): ParsedChunk {
    return { sequence: -1, ...partial } as ParsedChunk;
  }

  private count(key: string): void {
    this.eventCounts[key] = (this.eventCounts[key] ?? 0) + 1;
  }

  private trackTime(timestamp: Date | undefined): void {
    if (!timestamp) return;
    if (!this.startedAt || timestamp < this.startedAt) this.startedAt = timestamp;
    if (!this.updatedAt || timestamp > this.updatedAt) this.updatedAt = timestamp;
  }
}

/** Текст tool_result: строка или массив текстовых блоков. */
function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  return asArray(content)
    .map((part) => asString(asObject(part)?.text) ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Anthropic usage → ParsedUsageEvent: input_tokens НЕ включает cache,
 * поэтому inputTokens = input + cache_creation + cache_read;
 * cachedInputTokens = cache_read (подмножество input, план §7.3).
 */
function anthropicUsageEvent(
  usage: Record<string, unknown>,
  scope: ParsedUsageEvent["scope"],
  source: string,
  raw?: unknown,
): ParsedUsageEvent {
  const input = asNumber(usage.input_tokens) ?? 0;
  const cacheCreation = asNumber(usage.cache_creation_input_tokens) ?? 0;
  const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
  const event: ParsedUsageEvent = {
    scope,
    inputTokens: input + cacheCreation + cacheRead,
    cachedInputTokens: cacheRead,
    source,
    raw: raw ?? usage,
  };
  const output = asNumber(usage.output_tokens);
  if (output !== undefined) event.outputTokens = output;
  return event;
}
