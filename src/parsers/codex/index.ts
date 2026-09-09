/**
 * Parser Codex rollout JSONL (~/.codex/sessions, ~/.codex/archived_sessions).
 *
 * Формат (изучен на живых файлах, июль 2026): одна строка = событие
 *   {"timestamp": ISO, "type": ..., "payload": {...}}
 *
 * Ключевые типы:
 * - session_meta: id диалога, cwd, git, originator, cli_version;
 * - turn_context: model текущего turn'а (model switch между turn'ами);
 * - response_item/message: role user|developer|assistant, контент
 *   input_text/output_text/input_image. user-сообщения включают
 *   авто-контекст (<environment_context>, "# Context from my IDE setup");
 * - response_item/reasoning: summary[] + encrypted_content → thought;
 * - response_item/function_call|custom_tool_call(+_output): tool calls,
 *   связка по call_id;
 * - event_msg/user_message: «как набрано» — подтверждает human-authored
 *   (response_item user-сообщение содержит обёртки IDE/CLI);
 * - event_msg/agent_message: дублирует текст последнего assistant
 *   response_item и несёт phase ("commentary"/"final_answer") — это
 *   явный final marker (план §8.3);
 * - event_msg/token_count: info.last_token_usage (request scope) +
 *   info.total_token_usage (session cumulative); codex пишет событие по разу
 *   на каждый rate-limit bucket с идентичным info — копии отбрасываются
 *   (eventCounts["event_msg.token_count_bucket_duplicate"]);
 * - compacted, world_state, task_*, mcp_*, patch_apply_*, web_search_*,
 *   thread_rolled_back, sub_agent_activity, inter_agent_communication_metadata:
 *   операционные события — не сообщения; учитываются в metadata.eventCounts,
 *   raw остаётся в immutable snapshot. task_complete.duration_ms учитывается
 *   только если payload.started_at не раньше старта ЭТОГО файла: у fork'ов
 *   replay истории parent несёт исходные duration (иначе child получает чужие
 *   часы — eventCounts["event_msg.task_complete.inherited_duration"]);
 *
 * Неизвестные типы событий НЕ роняют диалог: сохраняются как unknown
 * чанки + diagnostic (план §19.2 сценарий 11).
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
import { isSqliteFile } from "../shared/sqlite.ts";
import { isCodexMetadataSqlite } from "./sqlite-metadata.ts";

export const CODEX_PARSER_NAME = "codex";
export const CODEX_PARSER_VERSION = 10;

type ResponseStatus = "completed" | "aborted" | "incomplete";

/** Операционные event_msg/верхние типы: не сообщения, только счётчики. */
const OPERATIONAL_EVENT_TYPES = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
  "context_compacted",
  "thread_rolled_back",
  "thread_settings_applied", // обрабатывается отдельно (model/effort)
  "sub_agent_activity",
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "patch_apply_begin",
  "patch_apply_end",
  "web_search_begin",
  "web_search_end",
  "exec_command_begin",
  "exec_command_end",
  "agent_reasoning",
  "agent_reasoning_delta",
  "agent_message_delta",
  "token_count", // обрабатывается отдельно
]);

const OPERATIONAL_TOP_LEVEL = new Set([
  "world_state",
  "inter_agent_communication_metadata",
]);

interface ModelState {
  model?: string;
  reasoningEffort?: string;
  provider?: string;
}

interface ActiveTurn {
  id?: string;
  startedAt?: Date;
  lastTimestamp?: Date;
  messageStartIndex: number;
  userMessages: Array<{
    message: ParsedMessage;
    timestamp: Date;
    sourceLocator: string;
  }>;
}

export class CodexParser implements HarnessParser {
  readonly parserName = CODEX_PARSER_NAME;
  readonly parserVersion = CODEX_PARSER_VERSION;
  readonly sourceFormatVersions = ["rollout-jsonl-1"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    // Known service databases are raw-only, not failed transcripts. Unknown
    // schemas and databases containing archived messages remain unsupported.
    if ((await isSqliteFile(snapshotPath)) === true) {
      const metadataOnly = isCodexMetadataSqlite(snapshotPath);
      return {
        sourceKind: "file_tree",
        dialogues: (async function* () {})(),
        diagnostics: [
          {
            code: metadataOnly ? "raw_only_metadata" : "unsupported_file",
            message: metadataOnly
              ? `${snapshotPath}: recognized Codex service database; archived as raw only`
              : `${snapshotPath}: unrecognized or dialogue-bearing sqlite database; archived as raw only`,
            severity: metadataOnly ? "info" : "error",
            sourceLocator: snapshotPath,
          },
        ],
      };
    }
    const { records, errors } = await readJsonlFile(snapshotPath);
    const diagnostics: ParsedDiagnostic[] = errors.map((error) => ({
      code: "jsonl_parse_error",
      message: `${snapshotPath}:${error.line}: ${error.error}`,
      severity: "error",
      sourceLocator: `${snapshotPath}#L${error.line}`,
    }));
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

export const codexParser = new CodexParser();

class DialogueBuilder {
  private messages: ParsedMessage[] = [];
  private externalId: string | undefined;
  private workspace: ParsedDialogue["workspace"];
  private metadata: Record<string, unknown> = {};
  private sessionMetaCount = 0;
  private startedAt: Date | undefined;
  private updatedAt: Date | undefined;
  private modelState: ModelState = {};
  private eventCounts: Record<string, number> = {};
  private unknownTypes = new Set<string>();
  /** Текст последнего user message из event_msg/user_message (dedupe). */
  private lastUserEventText: string | undefined;
  /** info предыдущего token_count — дедуп rate-limit bucket-копий. */
  private lastTokenCountInfoKey: string | undefined;
  private activeTurn: ActiveTurn | undefined;
  private turnSequence = 0;
  /** Время старта ЭТОГО файла из session_meta — граница replay-истории fork'а. */
  private sessionStartedAt: Date | undefined;

  constructor(
    private readonly path: string,
    private readonly context: ParseContext | undefined,
    private readonly diagnostics: ParsedDiagnostic[],
  ) {}

  event(record: Record<string, unknown>, line: number): void {
    const timestamp = parseTimestamp(record.timestamp);
    this.trackTime(timestamp);
    this.trackTurnTime(timestamp);
    const type = asString(record.type);
    const payload = asObject(record.payload) ?? {};
    const turnId = codexTurnId(payload);
    if (turnId && this.activeTurn && this.activeTurn.id?.startsWith("synthetic:")) {
      this.activeTurn.id = turnId;
    }
    const locator = `${this.path}#L${line}`;

    switch (type) {
      case "session_meta":
        this.sessionMeta(payload);
        return;
      case "turn_context":
        this.turnContext(payload);
        return;
      case "response_item":
        this.responseItem(payload, timestamp, locator);
        return;
      case "event_msg":
        this.eventMsg(payload, timestamp, locator);
        return;
      case "compacted":
        this.pushMessage({
          role: "system",
          rawRole: "compacted",
          humanAuthored: false,
          visibleToUser: false,
          timestamp,
          chunks: [
            this.chunk({
              kind: "object",
              rawKind: "compacted",
              content: JSON.stringify(payload).slice(0, 4000),
              rawEventType: "compacted",
              sourceLocator: locator,
              metadata: {
                replacementCount: asArray(payload.replacement_history).length,
              },
            }),
          ],
          metadata: {},
        });
        return;
      default:
        if (type && OPERATIONAL_TOP_LEVEL.has(type)) {
          this.count(`top:${type}`);
          return;
        }
        this.unknown(`top:${type ?? "<missing>"}`, payload, timestamp, locator);
    }
  }

  finish(): ParsedDialogue | undefined {
    if (this.activeTurn) {
      this.finishActiveTurn("incomplete", {}, this.activeTurn.lastTimestamp ?? this.updatedAt, `${this.path}#EOF`);
    }
    if (!this.externalId && this.messages.length === 0) {
      this.diagnostics.push({
        code: "empty_snapshot",
        message: `${this.path}: no session_meta and no messages`,
        severity: "error",
      });
      return undefined;
    }
    this.metadata.eventCounts = this.eventCounts;
    return {
      ...(this.externalId !== undefined ? { externalId: this.externalId } : {}),
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      messages: this.messages,
      metadata: this.metadata,
    };
  }

  // --- top-level события ---

  private sessionMeta(payload: Record<string, unknown>): void {
    const id = asString(payload.id) ?? asString(payload.session_id);
    const isPrimary = this.sessionMetaCount === 0;
    this.sessionMetaCount += 1;
    if (isPrimary) {
      this.externalId = id;
      const source = asObject(payload.source);
      const spawn = asObject(asObject(source?.subagent)?.thread_spawn);
      const parentSourceDialogueId =
        asString(payload.forked_from_id) ??
        asString(payload.parent_thread_id) ??
        asString(spawn?.parent_thread_id);
      if (parentSourceDialogueId) {
        this.metadata.lineage = {
          parentSourceDialogueId,
          ...(asNumber(spawn?.depth) !== undefined ? { depth: asNumber(spawn?.depth) } : {}),
          ...(asString(spawn?.agent_nickname) !== undefined
            ? { nickname: asString(spawn?.agent_nickname) }
            : {}),
          ...(asString(spawn?.agent_role) !== undefined
            ? { role: asString(spawn?.agent_role) }
            : {}),
        };
      }
    } else {
      const related = asArray(this.metadata.relatedSessionMetas);
      related.push({
        ...(id !== undefined ? { id } : {}),
        ...(asString(payload.forked_from_id) !== undefined
          ? { forkedFromId: asString(payload.forked_from_id) }
          : {}),
        ...(payload.source !== undefined ? { source: payload.source } : {}),
      });
      this.metadata.relatedSessionMetas = related;
      this.count("top:session_meta.related");
    }
    const cwd = asString(payload.cwd) ?? this.context?.workspaceHint;
    const git = asObject(payload.git);
    const repo = asString(git?.repository_url);
    if ((cwd || repo) && (!this.workspace || isPrimary)) {
      this.workspace = {
        ...(cwd !== undefined ? { path: cwd, name: basename(cwd) } : {}),
        ...(repo !== undefined ? { repositoryIdentity: repo } : {}),
      };
    }
    this.metadata.originator ??= asString(payload.originator);
    this.metadata.cliVersion ??= asString(payload.cli_version);
    this.metadata.modelProvider ??= asString(payload.model_provider);
    this.metadata.source ??= asString(payload.source);
    this.modelState.provider ??= asString(payload.model_provider);
    const ts = parseTimestamp(payload.timestamp);
    if (isPrimary) {
      this.sessionStartedAt = ts ?? this.sessionStartedAt;
      this.trackTime(ts);
    }
  }

  private turnContext(payload: Record<string, unknown>): void {
    const model = asString(payload.model);
    if (model) this.modelState.model = model;
    if (!this.workspace) {
      const cwd = asString(payload.cwd) ?? this.context?.workspaceHint;
      if (cwd) this.workspace = { path: cwd, name: basename(cwd) };
    }
    this.count("top:turn_context");
  }

  private responseItem(
    payload: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const type = asString(payload.type);
    switch (type) {
      case "message":
        this.itemMessage(payload, timestamp, locator);
        return;
      case "reasoning":
        this.itemReasoning(payload, timestamp, locator);
        return;
      case "function_call":
      case "custom_tool_call":
        this.itemToolCall(payload, type, timestamp, locator);
        return;
      case "function_call_output":
      case "custom_tool_call_output":
        this.itemToolResult(payload, type, timestamp, locator);
        return;
      case "tool_search_call":
        this.itemToolCall(
          { ...payload, name: payload.name ?? "tool_search", arguments: JSON.stringify(payload.arguments ?? {}) },
          type,
          timestamp,
          locator,
        );
        return;
      case "tool_search_output":
        this.itemToolResult(payload, type, timestamp, locator);
        return;
      case "agent_message":
        // Межагентные сообщения sub-agent'ов: не пользовательский текст.
        this.pushMessage({
          role: "assistant",
          rawRole: "agent_message",
          humanAuthored: false,
          visibleToUser: false,
          timestamp,
          model: this.modelInvocation(),
          chunks: [
            this.chunk({
              kind: "object",
              rawKind: type,
              content: contentPartsText(payload.content),
              rawEventType: `response_item.${type}`,
              sourceLocator: locator,
              metadata: {
                author: asString(payload.author),
                recipient: asString(payload.recipient),
              },
            }),
          ],
          metadata: {},
        });
        return;
      default:
        this.unknown(`response_item.${type ?? "<missing>"}`, payload, timestamp, locator);
    }
  }

  private itemMessage(
    payload: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const role = asString(payload.role) ?? "unknown";
    const parts = asArray(payload.content);
    const chunks: ParsedChunk[] = [];
    let sawAutoContext = false;
    let sawHumanText = false;
    for (const part of parts) {
      const obj = asObject(part);
      const partType = asString(obj?.type) ?? "unknown";
      if (partType === "input_text" || partType === "output_text") {
        const text = asString(obj?.text) ?? "";
        const auto = role === "user" && isAutoContext(text);
        if (auto) sawAutoContext = true;
        else if (text.trim().length > 0) sawHumanText = true;
        chunks.push(
          this.chunk({
            kind: role === "developer" || role === "system" ? "developer" : "text",
            rawKind: partType,
            content: text,
            sourceLocator: locator,
            metadata: auto ? { autoContext: true } : {},
          }),
        );
      } else if (partType === "input_image") {
        chunks.push(
          this.chunk({
            kind: "attachment",
            rawKind: partType,
            sourceLocator: locator,
            metadata: { image: true },
          }),
        );
      } else {
        chunks.push(
          this.chunk({
            kind: "unknown",
            rawKind: partType,
            content: JSON.stringify(part ?? null),
            rawEventType: `content.${partType}`,
            sourceLocator: locator,
            metadata: {},
          }),
        );
      }
    }

    const normalizedRole =
      role === "user"
        ? "user"
        : role === "assistant"
          ? "assistant"
          : role === "developer" || role === "system"
            ? "developer"
            : "unknown";

    let humanAuthored: boolean | "unknown" = false;
    let visibleToUser: boolean | "unknown" = true;
    if (normalizedRole === "user") {
      // event_msg/user_message может подтвердить авторство позже.
      humanAuthored = sawHumanText ? "unknown" : false;
      visibleToUser = sawAutoContext && !sawHumanText ? false : true;
    } else if (normalizedRole === "developer" || normalizedRole === "unknown") {
      visibleToUser = false;
    }

    this.pushMessage({
      externalId: asString(payload.id),
      role: normalizedRole,
      rawRole: role,
      humanAuthored,
      visibleToUser,
      timestamp,
      model: normalizedRole === "assistant" ? this.modelInvocation() : undefined,
      chunks,
      metadata: {},
    });
  }

  private itemReasoning(
    payload: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const summary = asArray(payload.summary)
      .map((part) => asString(asObject(part)?.text))
      .filter((text): text is string => Boolean(text))
      .join("\n");
    const encrypted = asString(payload.encrypted_content);
    this.pushMessage({
      externalId: asString(payload.id),
      role: "assistant",
      rawRole: "reasoning",
      humanAuthored: false,
      visibleToUser: false,
      timestamp,
      model: this.modelInvocation(),
      chunks: [
        this.chunk({
          kind: "thought",
          rawKind: "reasoning",
          content: summary,
          sourceLocator: locator,
          metadata: { encrypted: encrypted !== undefined, hasSummary: summary.length > 0 },
        }),
      ],
      metadata: {},
    });
  }

  private itemToolCall(
    payload: Record<string, unknown>,
    rawType: string,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const input = asString(payload.input) ?? asString(payload.arguments) ?? "";
    this.pushMessage({
      externalId: asString(payload.id),
      role: "assistant",
      rawRole: rawType,
      humanAuthored: false,
      visibleToUser: false,
      timestamp,
      model: this.modelInvocation(),
      chunks: [
        this.chunk({
          kind: "tool_call",
          rawKind: rawType,
          content: input,
          toolCallId: asString(payload.call_id) ?? asString(payload.id),
          toolName: asString(payload.name),
          rawEventType: `response_item.${rawType}`,
          sourceLocator: locator,
          metadata: { status: asString(payload.status) },
        }),
      ],
      metadata: {},
    });
  }

  private itemToolResult(
    payload: Record<string, unknown>,
    rawType: string,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const content = contentPartsText(payload.output) || asString(payload.output) || "";
    const reportedDurationMs = parseWorkedForDurationMs(content);
    const durationMetadata =
      reportedDurationMs !== undefined
        ? {
            reportedDurationMs,
            reportedDurationSource: "codex.tool_output.worked_for",
            reportedDurationKind: "tool_execution",
          }
        : {};
    this.pushMessage({
      role: "tool",
      rawRole: rawType,
      humanAuthored: false,
      visibleToUser: false,
      timestamp,
      chunks: [
        this.chunk({
          kind: "tool_result",
          rawKind: rawType,
          content,
          toolCallId: asString(payload.call_id),
          rawEventType: `response_item.${rawType}`,
          sourceLocator: locator,
          metadata: durationMetadata,
        }),
      ],
      metadata: durationMetadata,
    });
  }

  private eventMsg(
    payload: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const type = asString(payload.type);
    switch (type) {
      case "task_started":
        this.beginTurn(payload, timestamp);
        return;
      case "task_complete":
        this.finishActiveTurn("completed", payload, timestamp, locator);
        return;
      case "turn_aborted":
        this.finishActiveTurn("aborted", payload, timestamp, locator);
        return;
      case "user_message":
        this.userMessageEvent(payload, timestamp, locator);
        return;
      case "agent_message":
        this.agentMessageEvent(payload, timestamp, locator);
        return;
      case "token_count":
        this.tokenCountEvent(payload);
        return;
      case "thread_settings_applied": {
        const settings = asObject(payload.thread_settings);
        const model = asString(settings?.model);
        const effort = asString(settings?.reasoning_effort);
        const provider = asString(settings?.model_provider_id);
        if (model) this.modelState.model = model;
        if (effort) this.modelState.reasoningEffort = effort;
        if (provider) this.modelState.provider = provider;
        this.count("event_msg.thread_settings_applied");
        return;
      }
      default:
        if (type && OPERATIONAL_EVENT_TYPES.has(type)) {
          this.count(`event_msg.${type}`);
          return;
        }
        this.unknown(`event_msg.${type ?? "<missing>"}`, payload, timestamp, locator);
    }
  }

  /** event_msg/user_message подтверждает human-authored user-сообщение. */
  private userMessageEvent(
    payload: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const text = asString(payload.message) ?? "";
    this.lastUserEventText = text;
    const matched = this.findUserMessageFor(text);
    if (matched) {
      matched.humanAuthored = true;
      matched.metadata.userMessageText = text;
      matched.metadata.confirmedBy = "event_msg.user_message";
    } else {
      this.pushMessage({
        role: "user",
        rawRole: "user",
        humanAuthored: true,
        visibleToUser: true,
        timestamp,
        chunks: [
          this.chunk({
            kind: "text",
            rawKind: "user_message",
            content: text,
            rawEventType: "event_msg.user_message",
            sourceLocator: locator,
            metadata: {},
          }),
        ],
        metadata: { userMessageText: text, confirmedBy: "event_msg.user_message" },
      });
    }
    const target = matched ?? this.messages[this.messages.length - 1];
    // Sub-agent rollout повторяет parent prompt как user_message, но его
    // собственная работа начинается с межагентного NEW_TASK. Для дочерней
    // сессии точным источником служит duration каждого task turn.
    if (target && timestamp && this.metadata.lineage === undefined) {
      this.addTurnUserMessage(target, timestamp, locator);
    }
    const images = asArray(payload.images).length + asArray(payload.local_images).length;
    if (images > 0) {
      target?.chunks.push(
        this.chunk({
          kind: "attachment",
          rawKind: "image",
          sourceLocator: locator,
          metadata: { imageCount: images },
        }),
      );
    }
  }

  /** event_msg/agent_message несёт phase — явный final marker (§8.3). */
  private agentMessageEvent(
    payload: Record<string, unknown>,
    timestamp: Date | undefined,
    locator: string,
  ): void {
    const text = asString(payload.message) ?? "";
    const phase = asString(payload.phase);
    const matched = this.findAssistantMessageFor(text);
    if (matched) {
      if (phase) matched.metadata.phase = phase;
    } else {
      this.pushMessage({
        role: "assistant",
        rawRole: "assistant",
        humanAuthored: false,
        visibleToUser: true,
        timestamp,
        model: this.modelInvocation(),
        chunks: [
          this.chunk({
            kind: "text",
            rawKind: "agent_message",
            content: text,
            rawEventType: "event_msg.agent_message",
            sourceLocator: locator,
            metadata: {},
          }),
        ],
        metadata: phase ? { phase } : {},
      });
    }
  }

  /** token_count: last = per-request, total = session cumulative. */
  private tokenCountEvent(payload: Record<string, unknown>): void {
    const info = asObject(payload.info);
    // Codex пишет один и тот же вызов по разу на каждый rate-limit bucket
    // (rate_limits.limit_id: "codex", "codex_bengalfox", ...): info при этом
    // идентичен. Кумулятивный счётчик растёт только от новых вызовов, поэтому
    // повтор предыдущего info — всегда bucket-копия, а не новый вызов.
    const infoKey = tokenCountInfoKey(info);
    if (infoKey !== undefined) {
      if (infoKey === this.lastTokenCountInfoKey) {
        this.count("event_msg.token_count_bucket_duplicate");
        return;
      }
      this.lastTokenCountInfoKey = infoKey;
    }
    const events: ParsedUsageEvent[] = [];
    const last = asObject(info?.last_token_usage);
    if (last) {
      events.push({
        scope: "request",
        ...usageFields(last),
        source: "codex.token_count.last_token_usage",
        raw: last,
      });
    }
    const total = asObject(info?.total_token_usage);
    if (total) {
      events.push({
        scope: "session_cumulative",
        ...usageFields(total),
        source: "codex.token_count.total_token_usage",
        raw: total,
      });
    }
    if (events.length === 0) return;
    const target = [...this.messages].reverse().find((m) => m.role === "assistant");
    if (target) {
      target.usageEvents.push(...events);
      const window = asNumber(info?.model_context_window);
      if (window !== undefined) target.metadata.modelContextWindow = window;
    } else {
      this.diagnostics.push({
        code: "orphan_usage_event",
        message: `${this.path}: token_count before any assistant message`,
        severity: "warning",
      });
    }
  }

  private unknown(
    rawEventType: string,
    payload: Record<string, unknown>,
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
          content: JSON.stringify(payload),
          rawEventType,
          sourceLocator: locator,
          metadata: {},
        }),
      ],
      metadata: {},
    });
  }

  // --- helpers ---

  private modelInvocation(): ParsedModelInvocation | undefined {
    if (!this.modelState.model) return undefined;
    const normalized = normalizeModelName(this.modelState.model);
    return {
      rawModelName: this.modelState.model,
      vendor: normalized.vendor,
      canonicalName: normalized.canonicalName,
      reasoningEffort:
        this.modelState.reasoningEffort ?? normalized.reasoningEffort,
      serviceProvider:
        this.modelState.provider ?? normalized.serviceProvider,
    };
  }

  private findUserMessageFor(text: string): ParsedMessage | undefined {
    if (!text) return undefined;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (message.role !== "user" || message.humanAuthored === true) continue;
      const joined = message.chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.content ?? "")
        .join("");
      if (joined === text || joined.includes(text)) return message;
    }
    return undefined;
  }

  private findAssistantMessageFor(text: string): ParsedMessage | undefined {
    if (!text) return undefined;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (message.role !== "assistant") continue;
      const joined = message.chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.content ?? "")
        .join("\n");
      if (joined === text) return message;
    }
    return undefined;
  }

  private pushMessage(
    partial: Omit<ParsedMessage, "sequence" | "usageEvents" | "model" | "externalId"> & {
      externalId?: string;
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

  private trackTurnTime(timestamp: Date | undefined): void {
    if (!timestamp || !this.activeTurn) return;
    if (!this.activeTurn.lastTimestamp || timestamp > this.activeTurn.lastTimestamp) {
      this.activeTurn.lastTimestamp = timestamp;
    }
  }

  private beginTurn(payload: Record<string, unknown>, timestamp: Date | undefined): void {
    if (this.activeTurn) {
      this.finishActiveTurn("incomplete", {}, timestamp ?? this.activeTurn.lastTimestamp);
    }
    this.turnSequence += 1;
    this.activeTurn = {
      id: codexTurnId(payload) ?? `synthetic:${this.turnSequence}`,
      startedAt: timestamp,
      lastTimestamp: timestamp,
      messageStartIndex: this.messages.length,
      userMessages: [],
    };
    this.count("event_msg.task_started");
  }

  private addTurnUserMessage(
    message: ParsedMessage,
    timestamp: Date,
    sourceLocator: string,
  ): void {
    if (!this.activeTurn) {
      this.turnSequence += 1;
      this.activeTurn = {
        id: `synthetic:${this.turnSequence}`,
        startedAt: timestamp,
        lastTimestamp: timestamp,
        messageStartIndex: this.messages.length,
        userMessages: [],
      };
    }
    if (this.activeTurn.userMessages.some((entry) => entry.message === message)) return;
    this.activeTurn.userMessages.push({ message, timestamp, sourceLocator });
  }

  private finishActiveTurn(
    status: ResponseStatus,
    payload: Record<string, unknown>,
    timestamp: Date | undefined,
    locator?: string,
  ): void {
    const turn = this.activeTurn;
    if (!turn) {
      this.count(`event_msg.${status === "completed" ? "task_complete" : status === "aborted" ? "turn_aborted" : "task_incomplete"}`);
      return;
    }
    const completedAt = timestamp ?? turn.lastTimestamp ?? turn.startedAt;
    const explicitDurationMs = asNumber(payload.duration_ms);
    // Forked/subagent rollout: replay истории parent содержит task_complete с
    // ИСХОДНЫМИ payload.started_at/completed_at/duration_ms — turn ЗАВЕРШИЛСЯ
    // до создания этого файла (envelope timestamp при этом spawn-time). Такой
    // duration — работа parent, а не этой сессии; иначе child получает чужие
    // длительности. Tolerance 5s: payload epoch округлён до секунд.
    const payloadEndMs = epochMs(payload.completed_at) ?? epochMs(payload.started_at);
    const inheritedCompletion =
      explicitDurationMs !== undefined &&
      payloadEndMs !== undefined &&
      this.sessionStartedAt !== undefined &&
      payloadEndMs < this.sessionStartedAt.getTime() - 5000;
    if (inheritedCompletion) this.count("event_msg.task_complete.inherited_duration");
    const eventDurationMs =
      completedAt && turn.startedAt
        ? completedAt.getTime() - turn.startedAt.getTime()
        : undefined;
    const useExplicitDuration =
      explicitDurationMs !== undefined && explicitDurationMs >= 0 && !inheritedCompletion;
    const durationMs = useExplicitDuration
      ? explicitDurationMs
      : status !== "incomplete" && eventDurationMs !== undefined && eventDurationMs >= 0
        ? eventDurationMs
        : undefined;
    if (durationMs !== undefined) {
      const turnMessages = this.messages.slice(turn.messageStartIndex);
      const anchor = [...turnMessages].reverse().find((message) => message.role === "assistant") ??
        turnMessages.at(-1);
      if (anchor) {
        anchor.metadata.durationMs = Math.round(durationMs);
        anchor.metadata.durationSource =
          useExplicitDuration
            ? "codex.task_complete.duration_ms"
            : `codex.task_events.${status}`;
        anchor.metadata.durationKind = "turn_execution";
        if (turn.id) anchor.metadata.durationTurnId = turn.id;
      }
    }
    if (completedAt) {
      for (const entry of turn.userMessages) {
        const waitMs = completedAt.getTime() - entry.timestamp.getTime();
        if (!Number.isFinite(waitMs) || waitMs < 0) continue;
        entry.message.responseWaitMs = Math.round(waitMs);
        entry.message.responseStatus = status;
        entry.message.responseCompletedAt = completedAt;
        if (turn.id) entry.message.responseTurnId = turn.id;
        entry.message.metadata.responseWaitMs = Math.round(waitMs);
        entry.message.metadata.responseStatus = status;
        entry.message.metadata.responseCompletedAt = completedAt.toISOString();
        if (turn.id) entry.message.metadata.responseTurnId = turn.id;
        if (status === "aborted") {
          const reason = asString(payload.reason);
          if (reason) entry.message.metadata.responseAbortReason = reason;
        }
        if (locator) entry.message.metadata.responseEndLocator = locator;
        entry.message.metadata.responseWaitSource = "codex.task_events";
      }
    }
    this.count(`event_msg.${status === "completed" ? "task_complete" : status === "aborted" ? "turn_aborted" : "task_incomplete"}`);
    this.activeTurn = undefined;
  }
}

function codexTurnId(payload: Record<string, unknown>): string | undefined {
  return asString(payload.turn_id) ??
    asString(asObject(payload.internal_chat_message_metadata_passthrough)?.turn_id);
}

/** Epoch из payload codex: секунды (1.7e9) или миллисекунды — по величине. */
function epochMs(value: unknown): number | undefined {
  const numeric = asNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

/** Авто-вставленный контекст Codex (не human-authored). */
function isAutoContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("# Context from my IDE setup") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<user_instructions>")
  );
}

/** Склеить текст из content-частей Codex (input_text/output_text/text). */
function contentPartsText(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((part) => {
      const obj = asObject(part);
      return asString(obj?.text) ?? "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseWorkedForDurationMs(content: string): number | undefined {
  const match = /\bWorked for\s+((?:(?:\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\s*)+)/iu.exec(content);
  if (!match) return undefined;
  let seconds = 0;
  const parts = match[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/giu);
  for (const part of parts) {
    const value = Number(part[1]);
    if (!Number.isFinite(value)) continue;
    const unit = part[2]!.toLowerCase();
    if (unit.startsWith("h")) seconds += value * 3600;
    else if (unit === "m" || unit.startsWith("min")) seconds += value * 60;
    else seconds += value;
  }
  return seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

function usageVectorKey(usage: Record<string, unknown> | undefined): string {
  if (!usage) return "-";
  return [
    asNumber(usage.input_tokens) ?? "",
    asNumber(usage.cached_input_tokens) ?? "",
    asNumber(usage.output_tokens) ?? "",
    asNumber(usage.reasoning_output_tokens) ?? "",
    asNumber(usage.total_tokens) ?? "",
  ].join(":");
}

/** Ключ дедупликации token_count: last + cumulative, rate_limits игнорируются. */
function tokenCountInfoKey(info: Record<string, unknown> | undefined): string | undefined {
  if (!info) return undefined;
  const last = asObject(info.last_token_usage);
  const total = asObject(info.total_token_usage);
  if (!last && !total) return undefined;
  return `${usageVectorKey(last)}|${usageVectorKey(total)}`;
}

function usageFields(usage: Record<string, unknown>): Omit<ParsedUsageEvent, "scope" | "source" | "raw"> {
  const out: Omit<ParsedUsageEvent, "scope" | "source" | "raw"> = {};
  const input = asNumber(usage.input_tokens);
  const cached = asNumber(usage.cached_input_tokens);
  const output = asNumber(usage.output_tokens);
  const reasoning = asNumber(usage.reasoning_output_tokens);
  const total = asNumber(usage.total_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (cached !== undefined) out.cachedInputTokens = cached;
  if (output !== undefined) out.outputTokens = output;
  if (reasoning !== undefined) out.reasoningOutputTokens = reasoning;
  if (total !== undefined) out.totalTokensReported = total;
  return out;
}
