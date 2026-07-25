/**
 * Parser Kimi Code (Kimi CLI), docs/sources.md.
 *
 * Диалог = каталог `<sessionId>/`:
 *   state.json                  — title, workDir, createdAt/updatedAt, forkedFrom
 *   agents/main/wire.jsonl      — event stream основного агента
 *   agents/agent-N/wire.jsonl   — wire-файлы субагентов
 *
 * parse() принимает каталог сессии ИЛИ отдельный файл
 * (`agents/<id>/wire.jsonl` / `state.json`) — путь к сессии выводится из
 * структуры каталогов; это работает и для живого дерева, и для fixtures.
 * Workspace: state.json.workDir, fallback — context.workspaceHint
 * (sync-слой знает workDir из session_index.jsonl).
 *
 * Формат wire.jsonl (protocol_version "1.4", изучен на живых файлах):
 * одна строка = событие {"type": ..., "time": epoch_ms, ...}:
 * - metadata: protocol_version, created_at;
 * - config.update: profileName/systemPrompt/modelAlias/thinkingEffort;
 * - turn.prompt / turn.steer: ввод user'а или системный триггер
 *   (origin.kind: user | system_trigger | background_task | subagent);
 * - context.append_message: сообщение user'а (дублирует turn.prompt —
 *   дедуплицируется по тексту);
 * - context.append_loop_event: event.type ∈ step.begin | step.end |
 *   content.part (part.type: text | think) | tool.call | tool.result;
 *   step = один LLM-вызов → одно assistant message;
 * - llm.request: provider/model/modelAlias/thinkingEffort текущего вызова;
 * - usage.record: usageScope "turn" — накопительный usage turn'а;
 * - operational: permission.set_mode, tools.set_active_tools,
 *   tools.update_store, llm.tools_snapshot.
 *
 * Субагенты (РЕШЕНИЕ, задокументировано): wire-файлы agents/agent-N —
 * часть того же диалога; их сообщения получают metadata.subagentId =
 * "agent-N" (у основного агента поле отсутствует). Сообщения всех
 * агентов сливаются в один поток, отсортированный по timestamp.
 *
 * Usage mapping kimi → ParsedUsageEvent:
 *   inputTokens        = inputOther + inputCacheRead + inputCacheCreation
 *   cachedInputTokens  = inputCacheRead  (подмножество input, §7.3)
 *   outputTokens       = output
 *   inputCacheCreation сохраняется только в raw (это cache write).
 * step.end.usage → scope request; usage.record(scope "turn") → scope turn.
 */

import { readFile, readdir, stat } from "node:fs/promises";
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
import type { NormalizedRole, UsageScope } from "../../domain/enums.ts";
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

export const KIMI_CODE_PARSER_NAME = "kimi-code";
export const KIMI_CODE_PARSER_VERSION = 1;

const OPERATIONAL_TYPES = new Set([
  "metadata",
  "permission.set_mode",
  "tools.set_active_tools",
  "tools.update_store",
  "llm.tools_snapshot",
]);

interface ModelState {
  model?: string;
  modelAlias?: string;
  thinkingEffort?: string;
  provider?: string;
}

interface AgentMessages {
  agentId: string;
  messages: ParsedMessage[];
}

export class KimiCodeParser implements HarnessParser {
  readonly parserName = KIMI_CODE_PARSER_NAME;
  readonly parserVersion = KIMI_CODE_PARSER_VERSION;
  readonly sourceFormatVersions = ["1.4"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    const diagnostics: ParsedDiagnostic[] = [];
    const layout = await resolveSessionLayout(snapshotPath, diagnostics);

    let state: Record<string, unknown> | undefined;
    if (layout.statePath) {
      try {
        state = asObject(JSON.parse(await readFile(layout.statePath, "utf8")));
      } catch (error) {
        diagnostics.push({
          code: "state_json_error",
          message: `${layout.statePath}: ${error instanceof Error ? error.message : String(error)}`,
          severity: "warning",
          sourceLocator: layout.statePath,
        });
      }
    }

    const agents: AgentMessages[] = [];
    const eventCounts: Record<string, number> = {};
    let protocolVersion: string | undefined;
    for (const wire of layout.wireFiles) {
      const parsed = await parseWireFile(wire.path, wire.agentId, diagnostics, eventCounts);
      protocolVersion ??= parsed.protocolVersion;
      agents.push({ agentId: wire.agentId, messages: parsed.messages });
    }

    const messages = mergeAgentMessages(agents);
    const dialogue = buildDialogue(layout, state, messages, eventCounts, protocolVersion, context, diagnostics);
    return {
      sourceKind: "file_tree",
      dialogues: (async function* () {
        if (dialogue) yield dialogue;
      })(),
      diagnostics,
    };
  }
}

export const kimiCodeParser = new KimiCodeParser();

// --- разбор пути ---

interface SessionLayout {
  sessionDir: string | undefined;
  sessionId: string | undefined;
  statePath: string | undefined;
  wireFiles: Array<{ path: string; agentId: string }>;
}

async function resolveSessionLayout(
  snapshotPath: string,
  diagnostics: ParsedDiagnostic[],
): Promise<SessionLayout> {
  const layout: SessionLayout = {
    sessionDir: undefined,
    sessionId: undefined,
    statePath: undefined,
    wireFiles: [],
  };

  const info = await stat(snapshotPath).catch(() => undefined);
  let sessionDir: string | undefined;
  if (info?.isDirectory()) {
    sessionDir = snapshotPath;
  } else {
    const name = basename(snapshotPath);
    const parent = dirname(snapshotPath);
    if (name === "wire.jsonl" && basename(parent).length > 0 && basename(dirname(parent)) === "agents") {
      // <session>/agents/<agent>/wire.jsonl
      sessionDir = dirname(dirname(parent));
      layout.wireFiles.push({ path: snapshotPath, agentId: basename(parent) });
    } else if (name === "state.json") {
      sessionDir = parent;
    } else if (name === "wire.jsonl") {
      // Одиночный wire-файл вне структуры (например, плоский raw snapshot).
      layout.wireFiles.push({ path: snapshotPath, agentId: "main" });
    } else {
      diagnostics.push({
        code: "unsupported_path",
        message: `${snapshotPath}: not a session dir, wire.jsonl or state.json`,
        severity: "error",
      });
      return layout;
    }
  }

  if (sessionDir) {
    layout.sessionDir = sessionDir;
    layout.sessionId = basename(sessionDir);
    if (layout.wireFiles.length === 0) {
      const agentsDir = join(sessionDir, "agents");
      const entries = await readdir(agentsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const wirePath = join(agentsDir, entry.name, "wire.jsonl");
        const wireStat = await stat(wirePath).catch(() => undefined);
        if (wireStat?.isFile()) layout.wireFiles.push({ path: wirePath, agentId: entry.name });
      }
      // main первым, затем субагенты по имени.
      layout.wireFiles.sort((a, b) =>
        a.agentId === b.agentId ? 0 : a.agentId === "main" ? -1 : b.agentId === "main" ? 1 : a.agentId.localeCompare(b.agentId),
      );
      const statePath = join(sessionDir, "state.json");
      const stateStat = await stat(statePath).catch(() => undefined);
      if (stateStat?.isFile()) layout.statePath = statePath;
    }
  }
  if (layout.wireFiles.length === 0) {
    diagnostics.push({
      code: "no_wire_files",
      message: `${snapshotPath}: no agents/*/wire.jsonl found`,
      severity: "error",
    });
  }
  return layout;
}

// --- wire.jsonl одного агента ---

interface WireParseResult {
  messages: ParsedMessage[];
  protocolVersion: string | undefined;
}

async function parseWireFile(
  path: string,
  agentId: string,
  diagnostics: ParsedDiagnostic[],
  eventCounts: Record<string, number>,
): Promise<WireParseResult> {
  const { records, errors } = await readJsonlFile(path);
  for (const error of errors) {
    diagnostics.push({
      code: "jsonl_parse_error",
      message: `${path}:${error.line}: ${error.error}`,
      severity: "error",
      sourceLocator: `${path}#L${error.line}`,
    });
  }

  const isSubagent = agentId !== "main";
  const messages: ParsedMessage[] = [];
  const modelState: ModelState = {};
  let protocolVersion: string | undefined;
  /** Текущее assistant message (открыто step.begin, закрыто step.end). */
  let current: ParsedMessage | undefined;
  /** Текст последнего turn.prompt для дедупликации append_message. */
  let lastPromptText: string | undefined;
  const unknownTypes = new Set<string>();

  const count = (key: string) => {
    eventCounts[`${agentId}:${key}`] = (eventCounts[`${agentId}:${key}`] ?? 0) + 1;
  };

  const subagentMetadata = (): Record<string, unknown> =>
    isSubagent ? { subagentId: agentId } : {};

  const modelInvocation = (): ParsedModelInvocation | undefined => {
    const rawName = modelState.modelAlias ?? modelState.model;
    if (!rawName) return undefined;
    const normalized = normalizeModelName(rawName);
    return {
      rawModelName: rawName,
      vendor: normalized.vendor,
      canonicalName: normalized.canonicalName,
      reasoningEffort: modelState.thinkingEffort ?? normalized.reasoningEffort,
      serviceProvider: modelState.provider ?? normalized.serviceProvider,
    };
  };

  const pushMessage = (
    partial: Omit<ParsedMessage, "sequence" | "usageEvents" | "metadata" | "model" | "externalId"> & {
      metadata?: Record<string, unknown>;
      model?: ParsedModelInvocation | undefined;
    },
  ): ParsedMessage => {
    const message: ParsedMessage = {
      sequence: -1, // переназначается при merge
      usageEvents: [],
      ...partial,
      metadata: { ...subagentMetadata(), ...partial.metadata },
      chunks: partial.chunks.map((chunk, index) => ({ ...chunk, sequence: index })),
    };
    messages.push(message);
    return message;
  };

  const chunkOf = (
    partial: Omit<ParsedChunk, "sequence" | "content" | "toolCallId" | "toolName"> & {
      content?: string;
      toolCallId?: string | undefined;
      toolName?: string | undefined;
    },
  ): ParsedChunk => ({ sequence: -1, ...partial }) as ParsedChunk;

  const unknownChunk = (
    rawEventType: string,
    payload: unknown,
    timestamp: Date | undefined,
    locator: string,
  ): void => {
    if (!unknownTypes.has(rawEventType)) {
      unknownTypes.add(rawEventType);
      diagnostics.push({
        code: "unknown_event",
        message: `${path}: unknown event ${rawEventType} (preserved as unknown chunk)`,
        severity: "warning",
        sourceLocator: locator,
      });
    }
    count(`unknown:${rawEventType}`);
    pushMessage({
      role: "unknown",
      rawRole: rawEventType,
      humanAuthored: false,
      visibleToUser: false,
      timestamp,
      chunks: [
        chunkOf({
          kind: "unknown",
          rawKind: rawEventType,
          content: JSON.stringify(payload ?? null).slice(0, 4000),
          rawEventType,
          sourceLocator: locator,
          metadata: {},
        }),
      ],
    });
  };

  const inputChunks = (input: unknown, locator: string): ParsedChunk[] =>
    asArray(input).map((part) => {
      const obj = asObject(part);
      const partType = asString(obj?.type) ?? "unknown";
      if (partType === "text") {
        return chunkOf({
          kind: "text",
          rawKind: "text",
          content: asString(obj?.text) ?? "",
          sourceLocator: locator,
          metadata: {},
        });
      }
      return chunkOf({
        kind: partType === "image" || partType === "file" ? "attachment" : "unknown",
        rawKind: partType,
        content: partType === "image" || partType === "file" ? undefined : JSON.stringify(part ?? null),
        rawEventType: `input.${partType}`,
        sourceLocator: locator,
        metadata: {},
      });
    });

  for (const { line, value } of records) {
    const locator = `${path}#L${line}`;
    const type = asString(value.type);
    const timestamp = parseTimestamp(value.time);

    switch (type) {
      case "metadata":
        protocolVersion = asString(value.protocol_version) ?? protocolVersion;
        count("metadata");
        break;

      case "config.update": {
        const alias = asString(value.modelAlias);
        const effort = asString(value.thinkingEffort);
        if (alias) modelState.modelAlias = alias;
        if (effort) modelState.thinkingEffort = effort;
        count("config.update");
        break;
      }

      case "llm.request": {
        const model = asString(value.model);
        const alias = asString(value.modelAlias);
        const effort = asString(value.thinkingEffort);
        const provider = asString(value.provider);
        if (model) modelState.model = model;
        if (alias) modelState.modelAlias = alias;
        if (effort) modelState.thinkingEffort = effort;
        if (provider) modelState.provider = provider;
        count("llm.request");
        break;
      }

      case "turn.prompt":
      case "turn.steer": {
        const origin = asObject(value.origin);
        const originKind = asString(origin?.kind) ?? "unknown";
        const chunks = inputChunks(value.input, locator);
        const text = chunks.map((c) => c.content ?? "").join("\n");
        lastPromptText = text;
        pushMessage({
          role: "user",
          rawRole: type,
          humanAuthored: originKind === "user",
          visibleToUser: originKind === "user",
          timestamp,
          chunks,
          metadata: {
            origin: origin ?? {},
            ...(type === "turn.steer" ? { steer: true } : {}),
          },
        });
        break;
      }

      case "context.append_message": {
        const message = asObject(value.message) ?? {};
        const role = asString(message.role) ?? "unknown";
        const origin = asObject(message.origin);
        const originKind = asString(origin?.kind) ?? "unknown";
        const chunks = inputChunks(message.content, locator);
        const text = chunks.map((c) => c.content ?? "").join("\n");
        // append_message дублирует turn.prompt (тот же текст, ~1 мс позже).
        if (role === "user" && text === lastPromptText) {
          lastPromptText = undefined;
          count("context.append_message.deduped");
          break;
        }
        pushMessage({
          role: role as NormalizedRole,
          rawRole: role,
          humanAuthored: role === "user" ? originKind === "user" : false,
          visibleToUser: role === "user" ? originKind === "user" : "unknown",
          timestamp,
          chunks,
          metadata: { origin: origin ?? {} },
        });
        break;
      }

      case "context.append_loop_event": {
        const event = asObject(value.event) ?? {};
        const eventType = asString(event.type);
        switch (eventType) {
          case "step.begin":
            current = pushMessage({
              role: "assistant",
              rawRole: "assistant",
              humanAuthored: false,
              visibleToUser: true,
              timestamp,
              model: modelInvocation(),
              chunks: [],
              metadata: {
                turnId: asString(event.turnId),
                step: asNumber(event.step),
              },
            });
            break;

          case "content.part": {
            const part = asObject(event.part) ?? {};
            const partType = asString(part.type) ?? "unknown";
            const target = ensureCurrent();
            if (partType === "text" || partType === "think") {
              target.chunks.push(
                chunkOf({
                  kind: partType === "think" ? "thought" : "text",
                  rawKind: partType,
                  content: asString(part[partType]) ?? asString(part.text) ?? "",
                  sourceLocator: locator,
                  metadata: {},
                }),
              );
              resequence(target);
            } else {
              target.chunks.push(
                chunkOf({
                  kind: "unknown",
                  rawKind: partType,
                  content: JSON.stringify(part).slice(0, 4000),
                  rawEventType: `content.part.${partType}`,
                  sourceLocator: locator,
                  metadata: {},
                }),
              );
              resequence(target);
              if (!unknownTypes.has(`content.part.${partType}`)) {
                unknownTypes.add(`content.part.${partType}`);
                diagnostics.push({
                  code: "unknown_event",
                  message: `${path}: unknown content part ${partType}`,
                  severity: "warning",
                  sourceLocator: locator,
                });
              }
            }
            break;
          }

          case "tool.call": {
            const target = ensureCurrent();
            target.chunks.push(
              chunkOf({
                kind: "tool_call",
                rawKind: "tool.call",
                content: JSON.stringify(event.args ?? {}),
                toolCallId: asString(event.toolCallId),
                toolName: asString(event.name),
                rawEventType: "tool.call",
                sourceLocator: locator,
                metadata: {},
              }),
            );
            resequence(target);
            break;
          }

          case "tool.result": {
            const result = asObject(event.result);
            pushMessage({
              role: "tool",
              rawRole: "tool.result",
              humanAuthored: false,
              visibleToUser: false,
              timestamp,
              chunks: [
                chunkOf({
                  kind: "tool_result",
                  rawKind: "tool.result",
                  content: asString(result?.output) ?? JSON.stringify(event.result ?? null),
                  toolCallId: asString(event.toolCallId),
                  rawEventType: "tool.result",
                  sourceLocator: locator,
                  metadata: {},
                }),
              ],
            });
            break;
          }

          case "step.end": {
            const target = current;
            if (target) {
              const usage = asObject(event.usage);
              if (usage) {
                target.usageEvents.push(kimiUsageEvent(usage, "request", "kimi-code.step.end.usage"));
              }
              target.metadata.finishReason = asString(event.finishReason);
              target.metadata.messageId = asString(event.messageId);
              current = undefined;
            } else {
              count("step.end.orphan");
            }
            break;
          }

          default:
            unknownChunk(`loop.${eventType ?? "<missing>"}`, event, timestamp, locator);
        }
        break;
      }

      case "usage.record": {
        const usage = asObject(value.usage);
        const scope = mapUsageScope(asString(value.usageScope));
        if (!usage) break;
        const event = kimiUsageEvent(usage, scope, `kimi-code.usage.record.${asString(value.usageScope) ?? "unknown"}`);
        const target = [...messages].reverse().find((m) => m.role === "assistant");
        if (target) {
          target.usageEvents.push(event);
        } else {
          diagnostics.push({
            code: "orphan_usage_event",
            message: `${path}: usage.record before any assistant message`,
            severity: "warning",
            sourceLocator: locator,
          });
        }
        break;
      }

      default:
        if (type && OPERATIONAL_TYPES.has(type)) {
          count(type);
        } else {
          unknownChunk(type ?? "<missing>", value, timestamp, locator);
        }
    }
  }

  function ensureCurrent(): ParsedMessage {
    if (!current) {
      // loop event без step.begin — не теряем (план: unknown не роняет диалог).
      current = pushMessage({
        role: "assistant",
        rawRole: "assistant",
        humanAuthored: false,
        visibleToUser: true,
        chunks: [],
        metadata: { implicitStep: true },
        model: modelInvocation(),
      });
    }
    return current;
  }

  function resequence(message: ParsedMessage): void {
    message.chunks = message.chunks.map((chunk, index) => ({ ...chunk, sequence: index }));
  }

  return { messages, protocolVersion };
}

// --- сборка диалога ---

/** Слияние сообщений агентов: по timestamp, при равенстве — main раньше. */
function mergeAgentMessages(agents: AgentMessages[]): ParsedMessage[] {
  const tagged = agents.flatMap((agent, agentIndex) =>
    agent.messages.map((message, index) => ({ message, agentIndex, index })),
  );
  tagged.sort((a, b) => {
    const ta = a.message.timestamp?.getTime() ?? Number.POSITIVE_INFINITY;
    const tb = b.message.timestamp?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    if (a.agentIndex !== b.agentIndex) return a.agentIndex - b.agentIndex;
    return a.index - b.index;
  });
  return tagged.map(({ message }, sequence) => ({ ...message, sequence }));
}

function buildDialogue(
  layout: SessionLayout,
  state: Record<string, unknown> | undefined,
  messages: ParsedMessage[],
  eventCounts: Record<string, number>,
  protocolVersion: string | undefined,
  context: ParseContext | undefined,
  diagnostics: ParsedDiagnostic[],
): ParsedDialogue | undefined {
  if (messages.length === 0 && !state) {
    diagnostics.push({
      code: "empty_snapshot",
      message: `${layout.sessionDir ?? "?"}: no state.json and no messages`,
      severity: "error",
    });
    return undefined;
  }
  const workDir = asString(state?.workDir) ?? context?.workspaceHint;
  const forkedFrom = asString(state?.forkedFrom);
  const agentsMeta = asObject(state?.agents);
  const subagentIds = agentsMeta
    ? Object.entries(agentsMeta)
        .filter(([, value]) => asObject(value)?.type === "sub")
        .map(([key]) => key)
    : [];
  return {
    ...(layout.sessionId !== undefined ? { externalId: layout.sessionId } : {}),
    ...(asString(state?.title) !== undefined ? { title: asString(state?.title) } : {}),
    ...(workDir !== undefined
      ? { workspace: { path: workDir, name: basename(workDir) } }
      : {}),
    ...(parseTimestamp(state?.createdAt) !== undefined ? { startedAt: parseTimestamp(state?.createdAt) } : {}),
    ...(parseTimestamp(state?.updatedAt) !== undefined ? { updatedAt: parseTimestamp(state?.updatedAt) } : {}),
    messages,
    metadata: {
      protocolVersion,
      ...(forkedFrom !== undefined ? { forkedFrom } : {}),
      ...(subagentIds.length > 0 ? { subagentIds } : {}),
      lastPrompt: asString(state?.lastPrompt),
      eventCounts,
    },
  };
}

// --- usage mapping ---

function mapUsageScope(scope: string | undefined): UsageScope {
  switch (scope) {
    case "turn":
      return "turn";
    case "session":
    case "session_cumulative":
      return "session_cumulative";
    case "request":
      return "request";
    default:
      return "unknown";
  }
}

function kimiUsageEvent(
  usage: Record<string, unknown>,
  scope: UsageScope,
  source: string,
): ParsedUsageEvent {
  const inputOther = asNumber(usage.inputOther) ?? 0;
  const cacheRead = asNumber(usage.inputCacheRead) ?? 0;
  const cacheCreation = asNumber(usage.inputCacheCreation) ?? 0;
  const output = asNumber(usage.output);
  const event: ParsedUsageEvent = {
    scope,
    inputTokens: inputOther + cacheRead + cacheCreation,
    cachedInputTokens: cacheRead,
    source,
    raw: usage,
  };
  if (output !== undefined) event.outputTokens = output;
  const reasoning = asNumber(usage.reasoning ?? usage.reasoningOutput);
  if (reasoning !== undefined) event.reasoningOutputTokens = reasoning;
  return event;
}
