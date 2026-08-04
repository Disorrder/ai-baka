/**
 * Parser OMP agent sessions (~/.omp/agent/sessions/<workspace>/<session>.jsonl).
 *
 * Формат (изучен на живых файлах, июль 2026): одна строка = событие
 *   {"type":"session"|"model_change"|"thinking_level_change"|"message"|...}
 *
 * Один JSONL transcript = один диалог. Типы событий:
 * - session: id, cwd, title;
 * - title/title_change: заголовок;
 * - model_change/thinking_level_change: текущие настройки модели;
 * - message: message.role user|assistant|toolResult, content[]:
 *   {type:"text"|"thinking"|"toolCall"}, usage/duration/ttft на assistant;
 * - custom/tool execution, credential_pin, ttsr_injection: операционные,
 *   учитываются в metadata.eventCounts;
 * - custom_message/compaction: сохраняются как невидимые system/assistant
 *   сообщения, чтобы не терять полезный текст;
 * - неизвестные type/part → unknown chunk + diagnostic, raw сохраняется
 *   полностью в immutable snapshot.
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
import type { NormalizedRole } from "../../domain/enums.ts";
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

export const OMP_PARSER_NAME = "omp";
export const OMP_PARSER_VERSION = 2;

interface ModelState {
  model?: string;
  provider?: string;
  thinkingLevel?: string;
}

export class OmpParser implements HarnessParser {
  readonly parserName = OMP_PARSER_NAME;
  readonly parserVersion = OMP_PARSER_VERSION;
  readonly sourceFormatVersions = ["omp-session-jsonl-1"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    const diagnostics: ParsedDiagnostic[] = [];
    const info = await stat(snapshotPath).catch(() => undefined);
    if (!info?.isFile()) {
      diagnostics.push({
        code: "unsupported_path",
        message: `${snapshotPath}: not an OMP session .jsonl file`,
        severity: "error",
        sourceLocator: snapshotPath,
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

export const ompParser = new OmpParser();

function emptySnapshot(diagnostics: ParsedDiagnostic[]): ParsedSourceSnapshot {
  return {
    sourceKind: "file_tree",
    dialogues: (async function* () {})(),
    diagnostics,
  };
}

class DialogueBuilder {
  private messages: ParsedMessage[] = [];
  private externalId: string | undefined;
  private title: string | undefined;
  private workspacePath: string | undefined;
  private sessionVersion: number | undefined;
  private startedAt: Date | undefined;
  private updatedAt: Date | undefined;
  private modelState: ModelState = {};
  private eventCounts: Record<string, number> = {};
  private unknownTypes = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly context: ParseContext | undefined,
    private readonly diagnostics: ParsedDiagnostic[],
  ) {}

  event(record: Record<string, unknown>, line: number): void {
    const timestamp = parseTimestamp(record.timestamp) ?? parseTimestamp(record.updatedAt);
    this.trackTime(timestamp);
    const locator = `${this.path}#L${line}`;
    const type = asString(record.type);

    switch (type) {
      case "session":
        this.session(record);
        return;
      case "title":
      case "title_change":
        this.titleEvent(record, type);
        return;
      case "model_change":
        this.modelChange(record);
        return;
      case "thinking_level_change":
        this.thinkingLevelChange(record);
        return;
      case "message":
        this.message(record, timestamp, locator);
        return;
      case "custom":
        this.count(`custom.${asString(record.customType) ?? "<missing>"}`);
        return;
      case "custom_message":
        this.customMessage(record, timestamp, locator);
        return;
      case "compaction":
        this.compaction(record, timestamp, locator);
        return;
      case "credential_pin":
      case "ttsr_injection":
        this.count(`top:${type}`);
        return;
      default:
        this.unknown(`top:${type ?? "<missing>"}`, record, timestamp, locator);
    }
  }

  finish(): ParsedDialogue | undefined {
    if (!this.externalId && this.messages.length === 0) {
      this.diagnostics.push({
        code: "empty_snapshot",
        message: `${this.path}: no session id and no messages`,
        severity: "error",
      });
      return undefined;
    }

    const workspacePath = this.workspacePath ?? this.context?.workspaceHint;
    return {
      ...(this.externalId !== undefined ? { externalId: this.externalId } : {}),
      ...(this.title !== undefined && this.title.length > 0 ? { title: this.title } : {}),
      ...(workspacePath !== undefined
        ? { workspace: { path: workspacePath, name: basename(workspacePath) } }
        : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      messages: this.messages,
      metadata: {
        ...(this.sessionVersion !== undefined ? { sessionVersion: this.sessionVersion } : {}),
        eventCounts: this.eventCounts,
      },
    };
  }

  private session(record: Record<string, unknown>): void {
    this.externalId ??= asString(record.id);
    this.workspacePath ??= asString(record.cwd);
    this.sessionVersion ??= asNumber(record.version);
    const title = asString(record.title);
    if (title) this.title = title;
    this.count("top:session");
  }

  private titleEvent(record: Record<string, unknown>, type: string): void {
    const title = asString(record.title);
    if (title !== undefined) this.title = title;
    this.trackTime(parseTimestamp(record.updatedAt));
    this.count(`top:${type}`);
  }

  private modelChange(record: Record<string, unknown>): void {
    const raw = asString(record.model);
    if (raw) {
      const slash = raw.indexOf("/");
      if (slash > 0) {
        this.modelState.provider = raw.slice(0, slash);
        this.modelState.model = raw.slice(slash + 1);
      } else {
        this.modelState.model = raw;
      }
    }
    this.count("top:model_change");
  }

  private thinkingLevelChange(record: Record<string, unknown>): void {
    const level = asString(record.thinkingLevel);
    if (level) this.modelState.thinkingLevel = level;
    this.count("top:thinking_level_change");
  }

  private message(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const rawMessage = asObject(record.message) ?? {};
    const rawRole = asString(rawMessage.role) ?? "unknown";
    const role = normalizeRole(rawRole);
    const messageTimestamp = parseTimestamp(rawMessage.timestamp) ?? timestamp;
    const chunks = this.contentChunks(rawMessage, role, locator);
    const model = role === "assistant" ? this.modelInvocation(rawMessage) : undefined;
    const metadata: Record<string, unknown> = {};
    const duration = asNumber(rawMessage.duration);
    const ttft = asNumber(rawMessage.ttft);
    const api = asString(rawMessage.api);
    const stopReason = asString(rawMessage.stopReason);
    const responseId = asString(rawMessage.responseId);
    if (duration !== undefined) metadata.durationMs = duration;
    if (ttft !== undefined) metadata.ttftMs = ttft;
    if (api !== undefined) metadata.api = api;
    if (stopReason !== undefined) metadata.stopReason = stopReason;
    if (responseId !== undefined) metadata.responseId = responseId;

    const cost = asObject(asObject(rawMessage.usage)?.cost);
    if (cost) metadata.cost = cleanCost(cost);

    const parsed = this.pushMessage({
      externalId: asString(record.id),
      role,
      rawRole,
      humanAuthored: role === "user" ? asString(rawMessage.attribution) !== "agent" : false,
      visibleToUser: role === "tool" ? false : true,
      timestamp: messageTimestamp,
      model,
      chunks,
      metadata,
    });

    const usage = asObject(rawMessage.usage);
    if (role === "assistant" && usage) {
      parsed.usageEvents.push(ompUsageEvent(usage, "omp.message.usage"));
    }
  }

  private customMessage(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const customType = asString(record.customType) ?? "custom_message";
    const attribution = asString(record.attribution);
    const display = record.display !== false;
    const role: NormalizedRole =
      attribution === "user" ? "user" : attribution === "agent" ? "assistant" : "system";
    const content = asString(record.content) ?? "";
    const details = asObject(record.details);
    this.pushMessage({
      externalId: asString(record.id),
      role,
      rawRole: `custom_message.${customType}`,
      humanAuthored: attribution === "user",
      visibleToUser: display,
      timestamp,
      chunks: [
        this.chunk({
          kind: role === "system" ? "system" : "text",
          rawKind: customType,
          content,
          rawEventType: `custom_message.${customType}`,
          sourceLocator: locator,
          metadata: {},
        }),
      ],
      metadata: {
        customType,
        display,
        ...(details ? { detailKeys: Object.keys(details).sort() } : {}),
      },
    });
  }

  private compaction(
    record: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const payload = {
      summary: asString(record.summary),
      shortSummary: asString(record.shortSummary),
      tokensBefore: asNumber(record.tokensBefore),
      firstKeptEntryId: asString(record.firstKeptEntryId),
    };
    this.pushMessage({
      externalId: asString(record.id),
      role: "system",
      rawRole: "compaction",
      humanAuthored: false,
      visibleToUser: false,
      timestamp,
      chunks: [
        this.chunk({
          kind: "object",
          rawKind: "compaction",
          content: JSON.stringify(payload),
          rawEventType: "compaction",
          sourceLocator: locator,
          metadata: {},
        }),
      ],
      metadata: { tokensBefore: payload.tokensBefore },
    });
  }

  private contentChunks(
    rawMessage: Record<string, unknown>,
    role: NormalizedRole,
    locator: string,
  ): ParsedChunk[] {
    const content = rawMessage.content;
    if (typeof content === "string") {
      return [
        this.chunk({
          kind: role === "tool" ? "tool_result" : "text",
          rawKind: "text",
          content,
          sourceLocator: locator,
          toolCallId: asString(rawMessage.toolCallId),
          toolName: asString(rawMessage.toolName),
          metadata: {},
        }),
      ];
    }

    const chunks: ParsedChunk[] = [];
    for (const part of asArray(content)) {
      const obj = asObject(part);
      if (!obj) {
        chunks.push(this.unknownPartChunk(part, "message.content", locator));
        continue;
      }
      const partType = asString(obj.type);
      if (partType === "text") {
        chunks.push(
          this.chunk({
            kind: role === "tool" ? "tool_result" : "text",
            rawKind: "text",
            content: asString(obj.text) ?? "",
            sourceLocator: locator,
            toolCallId: asString(rawMessage.toolCallId),
            toolName: asString(rawMessage.toolName),
            metadata: {},
          }),
        );
      } else if (partType === "thinking") {
        chunks.push(
          this.chunk({
            kind: "thought",
            rawKind: "thinking",
            content: asString(obj.thinking) ?? "",
            sourceLocator: locator,
            metadata: {
              ...(asString(obj.thinkingSignature) !== undefined
                ? { thinkingSignature: asString(obj.thinkingSignature) }
                : {}),
            },
          }),
        );
      } else if (partType === "toolCall") {
        chunks.push(
          this.chunk({
            kind: "tool_call",
            rawKind: "toolCall",
            content: JSON.stringify(obj.arguments ?? asString(obj.partialArgs) ?? {}),
            toolCallId: asString(obj.id),
            toolName: asString(obj.name),
            rawEventType: "toolCall",
            sourceLocator: locator,
            metadata: {
              ...(asNumber(obj.streamIndex) !== undefined ? { streamIndex: asNumber(obj.streamIndex) } : {}),
              ...(asString(obj.intent) !== undefined ? { intent: asString(obj.intent) } : {}),
            },
          }),
        );
      } else {
        chunks.push(this.unknownPartChunk(part, "message.content", locator));
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
      content: JSON.stringify(part ?? null),
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
      externalId: asString(record.id),
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

  private modelInvocation(rawMessage: Record<string, unknown>): ParsedModelInvocation | undefined {
    const model = asString(rawMessage.model) ?? this.modelState.model;
    if (!model) return undefined;
    const provider = asString(rawMessage.provider) ?? this.modelState.provider;
    const rawName = provider ? `${provider}/${model}` : model;
    const normalized = normalizeModelName(rawName);
    return {
      rawModelName: rawName,
      vendor: normalized.vendor,
      canonicalName: normalized.canonicalName,
      reasoningEffort: this.modelState.thinkingLevel ?? normalized.reasoningEffort,
      serviceProvider: normalized.serviceProvider ?? provider,
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

function normalizeRole(rawRole: string): NormalizedRole {
  if (rawRole === "user") return "user";
  if (rawRole === "assistant") return "assistant";
  if (rawRole === "toolResult" || rawRole === "tool") return "tool";
  if (rawRole === "system") return "system";
  if (rawRole === "developer") return "developer";
  return "unknown";
}

function cleanCost(cost: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    const value = asNumber(cost[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * OMP reports non-cached input and cache buckets separately: totalTokens is
 * input + cacheRead + cacheWrite + output. Canonical usage expects
 * cachedInputTokens to be a subset of inputTokens, so inputTokens is widened
 * to all prompt-side tokens to preserve normalized totals.
 */
function ompUsageEvent(usage: Record<string, unknown>, source: string): ParsedUsageEvent {
  const input = asNumber(usage.input);
  const cacheRead = asNumber(usage.cacheRead);
  const cacheWrite = asNumber(usage.cacheWrite);
  const output = asNumber(usage.output);
  const reasoning = asNumber(usage.reasoningTokens);
  const total = asNumber(usage.totalTokens);

  const event: ParsedUsageEvent = { scope: "request", source, raw: usage };
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    event.inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (cacheRead !== undefined) event.cachedInputTokens = cacheRead;
  if (cacheWrite !== undefined) event.cacheWriteInputTokens = cacheWrite;
  if (output !== undefined) event.outputTokens = output;
  if (reasoning !== undefined) event.reasoningOutputTokens = reasoning;
  if (total !== undefined) event.totalTokensReported = total;
  return event;
}
