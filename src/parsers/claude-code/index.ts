/**
 * Parser Claude Code transcripts (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl).
 *
 * Формат (изучен на живых файлах, июль 2026): одна строка = запись
 *   {"type": ..., "sessionId": ..., "uuid": ..., "parentUuid": ...,
 *    "timestamp": ISO, "cwd": ..., "gitBranch": ..., "version": ...,
 *    "isSidechain": bool, "message"?: {...}}
 *
 * Ключевые типы записей:
 * - user: message.content — строка (промпт) или массив блоков
 *   text/image/tool_result. origin.kind === "human" подтверждает
 *   human-authored; isMeta и авто-контекст (<command-name>, Caveat:,
 *   <local-command-*>, <system-reminder>) — не человеческий текст.
 *   Запись, состоящая только из tool_result блоков — это результат
 *   инструмента (role tool), а не промпт.
 * - assistant: message — объект Anthropic API (model, id msg_*, content
 *   blocks: thinking/redacted_thinking/text/tool_use, stop_reason, usage).
 *   Одно API-сообщение стримится НЕСКОЛЬКИМИ строками с одним message.id и
 *   одним и тем же usage: строки с одинаковым id склеиваются в одно
 *   ParsedMessage, usage привязывается один раз (иначе double-count,
 *   план §19.2 сценарий 18).
 * - usage Anthropic: input_tokens НЕ включает кэш; cache_read_input_tokens
 *   и cache_creation_input_tokens — отдельные корзины. Нормализация:
 *   inputTokens = input + cache_read + cache_creation (полный вход),
 *   cachedInputTokens = cache_read, cacheWriteInputTokens = cache_creation.
 *   Обе корзины — подмножества input и повторно не прибавляются.
 * - isSidechain: true — транскрипт субагента (Task tool) внутри того же
 *   файла: остаётся в корпусе с metadata.sidechain, но не виден
 *   пользователю и не входит в финальный ответ основной цепочки.
 * - attachment (hook_*, task_reminder, ...), system (stop_hook_summary и
 *   др.), queue-operation, last-prompt, mode, permission-mode,
 *   custom-title, ai-title, file-history-*, frame-link — служебные записи:
 *   не сообщения, учитываются в metadata.eventCounts; custom-title/ai-title
 *   дают заголовок, last-prompt — metadata.lastPrompt.
 * - записи без type с полем display — строки ~/.claude/history.jsonl
 *   (глобальный индекс, не транскрипт): считаются операционными.
 *
 * Неизвестные типы записей и content-блоков НЕ роняют диалог: unknown
 * чанк + diagnostic (план §19.2 сценарий 11).
 */

import { basename } from "node:path";

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

export const CLAUDE_CODE_PARSER_NAME = "claude-code";
export const CLAUDE_CODE_PARSER_VERSION = 3;

/** Служебные верхнеуровневые типы: не сообщения, только счётчики. */
const OPERATIONAL_TOP_LEVEL = new Set([
  "queue-operation",
  "last-prompt",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "file-history-delta",
  "frame-link",
  "attachment",
  "system",
]);

export class ClaudeCodeParser implements HarnessParser {
  readonly parserName = CLAUDE_CODE_PARSER_NAME;
  readonly parserVersion = CLAUDE_CODE_PARSER_VERSION;
  readonly sourceFormatVersions = ["claude-code-transcript-1"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    const { records, errors } = await readJsonlFile(snapshotPath);
    const diagnostics: ParsedDiagnostic[] = errors.map((error) => ({
      code: "jsonl_parse_error",
      message: `${snapshotPath}:${error.line}: ${error.error}`,
      severity: "error",
      sourceLocator: `${snapshotPath}#L${error.line}`,
    }));
    const builder = new DialogueBuilder(snapshotPath, context, diagnostics);
    for (const { line, value } of records) builder.record(value, line);
    const dialogue = builder.finish();
    return {
      sourceKind: "file_tree",
      dialogues: (async function* () {
        if (dialogue) yield dialogue;
      })(),
      diagnostics,
    };
  }
}

export const claudeCodeParser = new ClaudeCodeParser();

class DialogueBuilder {
  private messages: ParsedMessage[] = [];
  private externalId: string | undefined;
  private title: string | undefined;
  private workspace: ParsedDialogue["workspace"];
  private metadata: Record<string, unknown> = {};
  private startedAt: Date | undefined;
  private updatedAt: Date | undefined;
  private eventCounts: Record<string, number> = {};
  private unknownTypes = new Set<string>();
  /** message.id (msg_*) уже получивших usage — дедупликация стриминга. */
  private usageSeen = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly context: ParseContext | undefined,
    private readonly diagnostics: ParsedDiagnostic[],
  ) {}

  record(record: Record<string, unknown>, line: number): void {
    const timestamp = parseTimestamp(record.timestamp);
    this.trackTime(timestamp);
    const locator = `${this.path}#L${line}`;
    const type = asString(record.type);

    this.externalId ??= asString(record.sessionId);
    this.trackWorkspace(record);
    this.metadata.version ??= asString(record.version);
    this.metadata.entrypoint ??= asString(record.entrypoint);
    const branch = asString(record.gitBranch);
    if (branch) this.metadata.gitBranch = branch;

    switch (type) {
      case "user":
        this.userRecord(record, timestamp, locator);
        return;
      case "assistant":
        this.assistantRecord(record, timestamp, locator);
        return;
      case "custom-title":
        this.title = asString(record.customTitle) ?? this.title;
        this.count("custom-title");
        return;
      case "ai-title":
        this.title ??= asString(record.aiTitle);
        this.count("ai-title");
        return;
      case "summary":
        // Старый формат: первая строка {"type":"summary","summary":...}.
        this.title ??= asString(record.summary);
        this.count("summary");
        return;
      default:
        if (type && OPERATIONAL_TOP_LEVEL.has(type)) {
          if (type === "last-prompt") {
            this.metadata.lastPrompt = asString(record.lastPrompt);
          }
          if (type === "attachment") {
            const attachment = asObject(record.attachment);
            this.count(`attachment.${asString(attachment?.type) ?? "<unknown>"}`);
          } else if (type === "system") {
            this.count(`system.${asString(record.subtype) ?? "<unknown>"}`);
          } else {
            this.count(type);
          }
          return;
        }
        if (!type && asString(record.display) !== undefined) {
          // Строка history.jsonl — глобальный индекс, не транскрипт.
          this.count("history_entry");
          return;
        }
        this.unknown(type ?? "<missing>", record, timestamp, locator);
    }
  }

  finish(): ParsedDialogue | undefined {
    if (!this.externalId && this.messages.length === 0) {
      this.diagnostics.push({
        code: "empty_snapshot",
        message: `${this.path}: no sessionId and no messages`,
        severity: "error",
      });
      return undefined;
    }
    this.metadata.eventCounts = this.eventCounts;
    return {
      ...(this.externalId !== undefined ? { externalId: this.externalId } : {}),
      ...(this.title !== undefined ? { title: this.title } : {}),
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      messages: this.messages,
      metadata: this.metadata,
    };
  }

  // --- user ---

  private userRecord(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const message = asObject(record.message) ?? {};
    const content = message.content;
    const sidechain = record.isSidechain === true;
    const isMeta = record.isMeta === true;
    const origin = asObject(record.origin);
    const originKind = asString(origin?.kind);

    const blocks: Record<string, unknown>[] = typeof content === "string"
      ? [{ type: "text", text: content }]
      : asArray(content).map((block) => asObject(block) ?? {});

    const chunks: ParsedChunk[] = [];
    let sawToolResult = false;
    let sawHumanText = false;
    let sawAutoText = false;
    for (const block of blocks) {
      const blockType = asString(block.type) ?? "<missing>";
      switch (blockType) {
        case "text": {
          const text = asString(block.text) ?? "";
          const auto = isAutoContext(text);
          if (auto) sawAutoText = true;
          else if (text.trim().length > 0) sawHumanText = true;
          chunks.push(
            this.chunk({
              kind: "text",
              rawKind: "text",
              content: text,
              sourceLocator: locator,
              metadata: auto ? { autoContext: true } : {},
            }),
          );
          break;
        }
        case "image":
        case "document": {
          const source = asObject(block.source);
          chunks.push(
            this.chunk({
              kind: "attachment",
              rawKind: blockType,
              sourceLocator: locator,
              metadata: { mediaType: asString(source?.media_type) },
            }),
          );
          break;
        }
        case "tool_result": {
          sawToolResult = true;
          chunks.push(this.toolResultChunk(block, locator));
          break;
        }
        default:
          chunks.push(this.unknownBlockChunk(`content.${blockType}`, block, locator));
      }
    }

    const toolResultOnly = sawToolResult && !sawHumanText && !sawAutoText;
    let humanAuthored: boolean | "unknown";
    if (isMeta || toolResultOnly) humanAuthored = false;
    else if (originKind === "human") humanAuthored = true;
    else if (originKind !== undefined) humanAuthored = false;
    else humanAuthored = sawHumanText ? "unknown" : false;

    const visibleToUser = toolResultOnly || isMeta || (!sawHumanText && sawAutoText)
      ? false
      : !sidechain;

    this.pushMessage({
      externalId: asString(record.uuid),
      role: toolResultOnly ? "tool" : "user",
      rawRole: "user",
      humanAuthored,
      visibleToUser,
      timestamp,
      chunks,
      metadata: {
        ...(originKind !== undefined ? { originKind } : {}),
        ...(isMeta ? { isMeta: true } : {}),
        ...(sidechain ? { sidechain: true } : {}),
        ...(asString(record.promptId) !== undefined
          ? { promptId: asString(record.promptId) }
          : {}),
      },
    });
  }

  // --- assistant ---

  private assistantRecord(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const message = asObject(record.message) ?? {};
    const apiId = asString(message.id);
    const sidechain = record.isSidechain === true;

    // Стриминг: несколько строк с одним message.id — одно API-сообщение.
    // Склеиваем чанки в предыдущее сообщение с тем же id.
    const existing = apiId !== undefined ? this.findAssistantByApiId(apiId) : undefined;

    const chunks: ParsedChunk[] = [];
    for (const block of asArray(message.content)) {
      const obj = asObject(block) ?? {};
      const blockType = asString(obj.type) ?? "<missing>";
      switch (blockType) {
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
        case "thinking":
          chunks.push(
            this.chunk({
              kind: "thought",
              rawKind: "thinking",
              content: asString(obj.thinking) ?? "",
              sourceLocator: locator,
              metadata: { signed: asString(obj.signature) !== undefined },
            }),
          );
          break;
        case "redacted_thinking":
          chunks.push(
            this.chunk({
              kind: "thought",
              rawKind: "redacted_thinking",
              sourceLocator: locator,
              metadata: { redacted: true },
            }),
          );
          break;
        case "tool_use":
        case "server_tool_use":
          chunks.push(
            this.chunk({
              kind: "tool_call",
              rawKind: blockType,
              content: JSON.stringify(obj.input ?? null),
              toolCallId: asString(obj.id),
              toolName: asString(obj.name),
              sourceLocator: locator,
              metadata: {},
            }),
          );
          break;
        case "web_search_tool_result":
          chunks.push(this.toolResultChunk(obj, locator));
          break;
        case "image":
        case "document": {
          const source = asObject(obj.source);
          chunks.push(
            this.chunk({
              kind: "attachment",
              rawKind: blockType,
              sourceLocator: locator,
              metadata: { mediaType: asString(source?.media_type) },
            }),
          );
          break;
        }
        default:
          chunks.push(this.unknownBlockChunk(`content.${blockType}`, obj, locator));
      }
    }

    const usage = this.usageEvent(message, apiId);

    if (existing) {
      // sequence выставляем вручную с учётом уже добавленных чанков.
      for (const chunk of chunks) {
        chunk.sequence = existing.chunks.length;
        existing.chunks.push(chunk);
      }
      if (usage) existing.usageEvents.push(usage);
      if (timestamp && (!existing.timestamp || timestamp < existing.timestamp)) {
        existing.timestamp = timestamp;
      }
      return;
    }

    const model = asString(message.model);
    this.pushMessage({
      externalId: apiId ?? asString(record.uuid),
      role: "assistant",
      rawRole: "assistant",
      humanAuthored: false,
      visibleToUser: !sidechain,
      timestamp,
      model: model ? this.modelInvocation(model) : undefined,
      chunks,
      metadata: {
        ...(asString(record.uuid) !== undefined ? { uuid: asString(record.uuid) } : {}),
        ...(asString(message.stop_reason) !== undefined
          ? { stopReason: asString(message.stop_reason) }
          : {}),
        ...(asString(record.requestId) !== undefined
          ? { requestId: asString(record.requestId) }
          : {}),
        ...(sidechain ? { sidechain: true } : {}),
      },
    });
    if (usage) this.messages[this.messages.length - 1]!.usageEvents.push(usage);
  }

  /** usage одного API-сообщения, один раз на message.id (сценарий 18). */
  private usageEvent(
    message: Record<string, unknown>,
    apiId: string | undefined,
  ): ParsedUsageEvent | undefined {
    const usage = asObject(message.usage);
    if (!usage) return undefined;
    if (apiId !== undefined) {
      if (this.usageSeen.has(apiId)) {
        this.count("usage.deduped");
        return undefined;
      }
      this.usageSeen.add(apiId);
    }
    const input = asNumber(usage.input_tokens) ?? 0;
    const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
    const cacheCreation = asNumber(usage.cache_creation_input_tokens) ?? 0;
    const output = asNumber(usage.output_tokens);
    const event: ParsedUsageEvent = {
      scope: "request",
      // Anthropic: input_tokens не включает кэш — полный вход собираем
      // из трёх корзин; cache read и creation сохраняются отдельно.
      inputTokens: input + cacheRead + cacheCreation,
      ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
      ...(cacheCreation > 0 ? { cacheWriteInputTokens: cacheCreation } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
      source: "claude-code.message.usage",
      raw: usage,
    };
    return event;
  }

  // --- общие чанки ---

  private toolResultChunk(
    block: Record<string, unknown>,
    locator: string,
  ): ParsedChunk {
    const content = block.content;
    let text = "";
    let images = 0;
    if (typeof content === "string") {
      text = content;
    } else {
      const parts: string[] = [];
      for (const part of asArray(content)) {
        const obj = asObject(part);
        if (!obj) continue;
        if (asString(obj.type) === "text") parts.push(asString(obj.text) ?? "");
        else if (asString(obj.type) === "image") images++;
        else parts.push(JSON.stringify(part));
      }
      text = parts.filter((part) => part.length > 0).join("\n");
    }
    return this.chunk({
      kind: "tool_result",
      rawKind: asString(block.type) ?? "tool_result",
      content: text,
      toolCallId: asString(block.tool_use_id),
      sourceLocator: locator,
      metadata: {
        ...(block.is_error === true ? { isError: true } : {}),
        ...(images > 0 ? { imageCount: images } : {}),
      },
    });
  }

  private unknownBlockChunk(
    rawEventType: string,
    block: Record<string, unknown>,
    locator: string,
  ): ParsedChunk {
    if (!this.unknownTypes.has(rawEventType)) {
      this.unknownTypes.add(rawEventType);
      this.diagnostics.push({
        code: "unknown_event",
        message: `${this.path}: unknown content block ${rawEventType} (preserved as unknown chunk)`,
        severity: "warning",
        sourceLocator: locator,
      });
    }
    this.count(`unknown:${rawEventType}`);
    return this.chunk({
      kind: "unknown",
      rawKind: rawEventType,
      content: JSON.stringify(block),
      rawEventType,
      sourceLocator: locator,
      metadata: {},
    });
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
        message: `${this.path}: unknown event ${rawEventType} (preserved as unknown chunk)`,
        severity: "warning",
        sourceLocator: locator,
      });
    }
    this.count(`unknown:${rawEventType}`);
    this.pushMessage({
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

  // --- helpers ---

  private findAssistantByApiId(apiId: string): ParsedMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (message.role !== "assistant") return undefined;
      if (message.externalId === apiId) return message;
    }
    return undefined;
  }

  private modelInvocation(rawModelName: string): ParsedModelInvocation {
    const normalized = normalizeModelName(rawModelName);
    return {
      rawModelName,
      vendor: normalized.vendor,
      canonicalName: normalized.canonicalName,
      ...(normalized.reasoningEffort !== undefined
        ? { reasoningEffort: normalized.reasoningEffort }
        : {}),
      serviceProvider: normalized.serviceProvider ?? "anthropic",
    };
  }

  private trackWorkspace(record: Record<string, unknown>): void {
    if (this.workspace) return;
    const cwd = asString(record.cwd) ?? this.context?.workspaceHint;
    if (cwd) this.workspace = { path: cwd, name: basename(cwd) };
  }

  private pushMessage(
    partial: Omit<ParsedMessage, "sequence" | "usageEvents" | "model" | "externalId"> & {
      externalId?: string;
      model?: ParsedModelInvocation | undefined;
    },
  ): void {
    const message: ParsedMessage = {
      sequence: this.messages.length,
      usageEvents: [],
      ...partial,
      chunks: partial.chunks.map((chunk, index) => ({ ...chunk, sequence: index })),
    };
    this.messages.push(message);
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

/** Авто-вставленный контент Claude Code (не human-authored). */
function isAutoContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<command-message>") ||
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("Caveat:") ||
    trimmed.startsWith("<system-reminder")
  );
}
