/**
 * Parser Qwen Code (~/.qwen/projects/<project-slug>/chats/<sessionId>.jsonl).
 *
 * Формат (изучен на живых файлах, июль 2026): одна строка = событие
 *   {"uuid", "parentUuid", "sessionId", "timestamp" (ISO), "type",
 *    "subtype"?, "cwd", "version", "gitBranch", "message"?, ...}
 *
 * Один chat-файл = один диалог. Типы событий:
 * - user (без subtype): промпт человека; message.parts = [{text}],
 *   возможны {inlineData:{data,mimeType,displayName}} (вложения);
 * - user:mid_turn_user_message — человеческое сообщение посреди turn'а;
 * - user:notification — автоматическое уведомление (<task-notification>,
 *   завершение субагента); НЕ human-authored;
 * - user:cron — expansion слэш-команды/skill'а, уходит в модель;
 *   НЕ human-authored, не виден как промпт;
 * - assistant: message.role "model", parts:
 *   {text, thought:true} → thought; {text} → text;
 *   {functionCall:{id,name,args}} → tool_call.
 *   На записи: model, usageMetadata {promptTokenCount, candidatesTokenCount,
 *   thoughtsTokenCount, cachedContentTokenCount, totalTokenCount},
 *   contextWindowSize. usageMetadata — per-request usage (scope request);
 * - tool_result: message.role "user", parts [{functionResponse:{id,name,
 *   response:{output}}}], плюс top-level toolCallResult {callId,status,
 *   resultDisplay}; связка с tool_call по id;
 * - system subtypes attribution_snapshot | file_history_snapshot |
 *   ui_telemetry | slash_command | at_command | rewind — операционные:
 *   не сообщения, только metadata.eventCounts (raw остаётся в snapshot'е).
 *   ui_telemetry qwen-code.api_response дублирует usageMetadata и токены —
 *   сознательно НЕ превращается в usage events (double counting);
 * - неизвестные type/subtype/part → unknown чанк + diagnostic, диалог
 *   не роняется (план §19.2 сценарий 11).
 *
 * Субагенты: subagents/<sessionId>/agent-<name>-call_*.jsonl — отдельные
 * файлы со своими snapshot'ами; записи помечены agentId/agentName/
 * isSidechain:true. Parser разбирает их как самостоятельные диалоги:
 * externalId = agentId, sessionId родителя — в metadata.parentSessionId.
 * Промпт субагента написан родительским агентом → human_authored = false.
 *
 * title в формате отсутствует (нет summary-записей) — не заполняется.
 */

import { stat } from "node:fs/promises";
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
  asNumber,
  asObject,
  asString,
  parseTimestamp,
  readJsonlFile,
} from "../shared/jsonl.ts";
import { normalizeModelName } from "../shared/model-normalization.ts";

export const QWEN_CODE_PARSER_NAME = "qwen-code";
export const QWEN_CODE_PARSER_VERSION = 1;

/** Операционные system-subtypes: не сообщения, только счётчики. */
const OPERATIONAL_SYSTEM_SUBTYPES = new Set([
  "attribution_snapshot",
  "file_history_snapshot",
  "ui_telemetry",
  "slash_command",
  "at_command",
  "rewind",
]);

export class QwenCodeParser implements HarnessParser {
  readonly parserName = QWEN_CODE_PARSER_NAME;
  readonly parserVersion = QWEN_CODE_PARSER_VERSION;
  readonly sourceFormatVersions = ["qwen-chat-jsonl-1"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    const diagnostics: ParsedDiagnostic[] = [];
    const info = await stat(snapshotPath).catch(() => undefined);
    if (!info?.isFile()) {
      diagnostics.push({
        code: "unsupported_path",
        message: `${snapshotPath}: not a chat .jsonl file`,
        severity: "error",
      });
      return emptySnapshot(diagnostics);
    }

    const { records, errors } = await readJsonlFile(snapshotPath);
    for (const error of errors) {
      diagnostics.push({
        code: "jsonl_parse_error",
        message: `${snapshotPath}:${error.line}: ${error.error}`,
        severity: "error",
        sourceLocator: `${snapshotPath}#L${error.line}`,
      });
    }

    const builder = new DialogueBuilder(snapshotPath, context, diagnostics);
    for (const { line, value } of records) builder.event(value, line);
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

export const qwenCodeParser = new QwenCodeParser();

function emptySnapshot(diagnostics: ParsedDiagnostic[]): ParsedSourceSnapshot {
  return {
    sourceKind: "file_tree",
    dialogues: (async function* () {})(),
    diagnostics,
  };
}

class DialogueBuilder {
  private messages: ParsedMessage[] = [];
  private sessionId: string | undefined;
  private agentId: string | undefined;
  private agentName: string | undefined;
  private isSidechain = false;
  private cwd: string | undefined;
  private cliVersion: string | undefined;
  private gitBranch: string | undefined;
  private startedAt: Date | undefined;
  private updatedAt: Date | undefined;
  private eventCounts: Record<string, number> = {};
  private unknownTypes = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly context: ParseContext | undefined,
    private readonly diagnostics: ParsedDiagnostic[],
  ) {}

  event(record: Record<string, unknown>, line: number): void {
    const timestamp = parseTimestamp(record.timestamp);
    this.trackTime(timestamp);
    const locator = `${this.path}#L${line}`;

    this.sessionId ??= asString(record.sessionId);
    this.agentId ??= asString(record.agentId);
    this.agentName ??= asString(record.agentName);
    if (record.isSidechain === true) this.isSidechain = true;
    this.cwd ??= asString(record.cwd);
    this.cliVersion ??= asString(record.version);
    this.gitBranch ??= asString(record.gitBranch);

    const type = asString(record.type);
    const subtype = asString(record.subtype);

    switch (type) {
      case "user":
        this.userRecord(record, subtype, timestamp, locator);
        return;
      case "assistant":
        this.assistantRecord(record, timestamp, locator);
        return;
      case "tool_result":
        this.toolResultRecord(record, timestamp, locator);
        return;
      case "system":
        if (subtype && OPERATIONAL_SYSTEM_SUBTYPES.has(subtype)) {
          this.count(`system.${subtype}`);
          return;
        }
        this.unknown(`system.${subtype ?? "<missing>"}`, record, timestamp, locator);
        return;
      default:
        this.unknown(type ?? "<missing>", record, timestamp, locator);
    }
  }

  finish(): ParsedDialogue | undefined {
    const externalId = this.isSidechain
      ? (this.agentId ?? this.sessionId)
      : this.sessionId;
    if (!externalId && this.messages.length === 0) {
      this.diagnostics.push({
        code: "empty_snapshot",
        message: `${this.path}: no sessionId and no messages`,
        severity: "error",
      });
      return undefined;
    }
    const workspacePath = this.cwd ?? this.context?.workspaceHint;
    return {
      ...(externalId !== undefined ? { externalId } : {}),
      ...(workspacePath !== undefined
        ? { workspace: { path: workspacePath, name: basename(workspacePath) } }
        : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      messages: this.messages,
      metadata: {
        sessionId: this.sessionId,
        cliVersion: this.cliVersion,
        gitBranch: this.gitBranch,
        ...(this.isSidechain ? { isSidechain: true } : {}),
        ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
        ...(this.agentName !== undefined ? { agentName: this.agentName } : {}),
        ...(this.isSidechain && this.sessionId !== undefined
          ? { parentSessionId: this.sessionId }
          : {}),
        eventCounts: this.eventCounts,
      },
    };
  }

  // --- записи-сообщения ---

  private userRecord(
    record: Record<string, unknown>,
    subtype: string | undefined,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    // Промпт человека: без subtype либо mid_turn. В sidechain-файле
    // "user" — задание от родительского агента, не человека.
    const human = !this.isSidechain && (subtype === undefined || subtype === "mid_turn_user_message");
    const automated = subtype === "notification" || subtype === "cron";
    if (!human && !automated && !this.isSidechain && subtype !== undefined) {
      // Неизвестный user-subtype: сохраняем содержимое, авторство неизвестно.
      this.unknownUserSubtype(subtype, locator);
    }
    this.pushMessage({
      externalId: asString(record.uuid),
      role: "user",
      rawRole: subtype ? `user.${subtype}` : "user",
      humanAuthored: human ? true : automated || this.isSidechain ? false : "unknown",
      // cron-expansion — служебный ввод модели; notification показывается в UI.
      visibleToUser: subtype === "cron" || this.isSidechain ? false : true,
      timestamp,
      chunks: this.partChunks(record.message, locator),
      metadata: {
        ...(subtype !== undefined ? { subtype } : {}),
        ...(asString(record.parentUuid) !== undefined
          ? { parentUuid: asString(record.parentUuid) }
          : {}),
      },
    });
  }

  private assistantRecord(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const message = this.pushMessage({
      externalId: asString(record.uuid),
      role: "assistant",
      rawRole: asString(asObject(record.message)?.role) ?? "model",
      humanAuthored: false,
      visibleToUser: !this.isSidechain,
      timestamp,
      model: this.modelInvocation(record),
      chunks: this.partChunks(record.message, locator),
      metadata: {
        ...(asNumber(record.contextWindowSize) !== undefined
          ? { contextWindowSize: asNumber(record.contextWindowSize) }
          : {}),
      },
    });
    const usage = asObject(record.usageMetadata);
    if (usage) {
      message.usageEvents.push(qwenUsageEvent(usage, "qwen-code.usageMetadata"));
    }
  }

  private toolResultRecord(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const message = asObject(record.message);
    const toolCallResult = asObject(record.toolCallResult);
    const chunks: ParsedChunk[] = [];
    const parts = Array.isArray(message?.parts) ? (message.parts as unknown[]) : [];
    if (parts.length === 0) {
      chunks.push(
        this.chunk({
          kind: "tool_result",
          rawKind: "tool_result",
          content: asString(toolCallResult?.resultDisplay) ?? "",
          toolCallId: asString(toolCallResult?.callId),
          rawEventType: "tool_result",
          sourceLocator: locator,
          metadata: { status: asString(toolCallResult?.status) },
        }),
      );
    }
    for (const part of parts) {
      const obj = asObject(part);
      const response = asObject(obj?.functionResponse);
      if (!response) {
        chunks.push(this.unknownPartChunk(part, "tool_result", locator));
        continue;
      }
      const inner = asObject(response.response);
      chunks.push(
        this.chunk({
          kind: "tool_result",
          rawKind: "functionResponse",
          content:
            asString(inner?.output) ??
            asString(toolCallResult?.resultDisplay) ??
            JSON.stringify(inner ?? null),
          toolCallId: asString(response.id) ?? asString(toolCallResult?.callId),
          toolName: asString(response.name),
          rawEventType: "tool_result",
          sourceLocator: locator,
          metadata: { status: asString(toolCallResult?.status) },
        }),
      );
    }
    this.pushMessage({
      externalId: asString(record.uuid),
      role: "tool",
      rawRole: "tool_result",
      humanAuthored: false,
      visibleToUser: false,
      timestamp,
      chunks,
      metadata: {},
    });
  }

  // --- parts ---

  private partChunks(messageRaw: unknown, locator: string): ParsedChunk[] {
    const message = asObject(messageRaw);
    const parts = Array.isArray(message?.parts) ? (message.parts as unknown[]) : [];
    const chunks: ParsedChunk[] = [];
    for (const part of parts) {
      const obj = asObject(part);
      if (!obj) {
        chunks.push(this.unknownPartChunk(part, "part", locator));
        continue;
      }
      if (obj.text !== undefined) {
        const thought = obj.thought === true;
        chunks.push(
          this.chunk({
            kind: thought ? "thought" : "text",
            rawKind: thought ? "thought" : "text",
            content: typeof obj.text === "string" ? obj.text : "",
            sourceLocator: locator,
            metadata: {},
          }),
        );
      } else if (obj.functionCall !== undefined) {
        const call = asObject(obj.functionCall) ?? {};
        chunks.push(
          this.chunk({
            kind: "tool_call",
            rawKind: "functionCall",
            content: JSON.stringify(call.args ?? {}),
            toolCallId: asString(call.id),
            toolName: asString(call.name),
            rawEventType: "functionCall",
            sourceLocator: locator,
            metadata: {},
          }),
        );
      } else if (obj.inlineData !== undefined) {
        const data = asObject(obj.inlineData) ?? {};
        chunks.push(
          this.chunk({
            kind: "attachment",
            rawKind: "inlineData",
            sourceLocator: locator,
            metadata: {
              mimeType: asString(data.mimeType),
              displayName: asString(data.displayName),
              dataBytes: typeof data.data === "string" ? data.data.length : undefined,
            },
          }),
        );
      } else {
        chunks.push(this.unknownPartChunk(part, "part", locator));
      }
    }
    return chunks;
  }

  private unknownPartChunk(part: unknown, context: string, locator: string): ParsedChunk {
    const keys = asObject(part) ? Object.keys(asObject(part)!).sort().join(",") : typeof part;
    const rawEventType = `${context}.unknown_part:${keys || "empty"}`;
    if (!this.unknownTypes.has(rawEventType)) {
      this.unknownTypes.add(rawEventType);
      this.diagnostics.push({
        code: "unknown_event",
        message: `${this.path}: unknown content part (${keys}) in ${context}`,
        severity: "warning",
        sourceLocator: locator,
      });
    }
    this.count(`unknown:${rawEventType}`);
    return this.chunk({
      kind: "unknown",
      rawKind: keys,
      content: JSON.stringify(part ?? null).slice(0, 4000),
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
          content: JSON.stringify(record).slice(0, 4000),
          rawEventType,
          sourceLocator: locator,
          metadata: {},
        }),
      ],
      metadata: {},
    });
  }

  private unknownUserSubtype(subtype: string, locator: string): void {
    const rawEventType = `user.${subtype}`;
    if (!this.unknownTypes.has(rawEventType)) {
      this.unknownTypes.add(rawEventType);
      this.diagnostics.push({
        code: "unknown_event",
        message: `${this.path}: unknown user subtype ${subtype} (humanAuthored=unknown)`,
        severity: "warning",
        sourceLocator: locator,
      });
    }
    this.count(`unknown:${rawEventType}`);
  }

  // --- helpers ---

  private modelInvocation(record: Record<string, unknown>): ParsedModelInvocation | undefined {
    const rawName = asString(record.model);
    if (!rawName) return undefined;
    const normalized = normalizeModelName(rawName);
    return {
      rawModelName: rawName,
      vendor: normalized.vendor,
      canonicalName: normalized.canonicalName,
      ...(normalized.reasoningEffort !== undefined
        ? { reasoningEffort: normalized.reasoningEffort }
        : {}),
      ...(normalized.serviceProvider !== undefined
        ? { serviceProvider: normalized.serviceProvider }
        : {}),
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
    partial: Omit<ParsedChunk, "sequence" | "content" | "toolCallId" | "toolName"> & {
      content?: string;
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

/**
 * usageMetadata Qwen → ParsedUsageEvent (scope request, §7.3):
 * cachedContentTokenCount — подмножество prompt; thoughtsTokenCount —
 * подмножество candidates; totalTokenCount хранится как reported.
 */
function qwenUsageEvent(usage: Record<string, unknown>, source: string): ParsedUsageEvent {
  const event: ParsedUsageEvent = { scope: "request", source, raw: usage };
  const input = asNumber(usage.promptTokenCount);
  const cached = asNumber(usage.cachedContentTokenCount);
  const output = asNumber(usage.candidatesTokenCount);
  const thoughts = asNumber(usage.thoughtsTokenCount);
  const total = asNumber(usage.totalTokenCount);
  if (input !== undefined) event.inputTokens = input;
  if (cached !== undefined) event.cachedInputTokens = cached;
  if (output !== undefined) event.outputTokens = output;
  if (thoughts !== undefined) event.reasoningOutputTokens = thoughts;
  if (total !== undefined) event.totalTokensReported = total;
  return event;
}
