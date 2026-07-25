/**
 * Parser OpenCode, docs/sources.md.
 *
 * Источник — SQLite-база `opencode.db` (snapshot через VACUUM INTO /
 * Online Backup, план §9.2). Parser открывает базу ТОЛЬКО read-only.
 * `storage/session_diff` (file-level diffs) не разбирается: содержимое
 * диалогов полностью в таблицах session/message/part.
 *
 * Схема БД (изучена на живой базе, opencode 1.2.x–1.18.x):
 * - project(id, worktree, vcs, name, ...) — проекты;
 * - session(id, project_id, parent_id, directory, title, version, agent,
 *   model JSON, tokens_input/output/reasoning/cache_read/cache_write,
 *   time_created, time_updated) — один row = один диалог; parent_id
 *   связывает subtask-сессии (хранится в metadata диалога);
 * - message(id, session_id, time_created, data JSON) — data:
 *   {role: user|assistant, time:{created,completed?}, agent, mode,
 *   model:{providerID,modelID} (user), parentID, modelID, providerID,
 *   cost, tokens:{total,input,output,reasoning,cache:{read,write}},
 *   finish: stop|tool-calls|null, error?, summary?, format?} (assistant);
 * - part(id, message_id, session_id, time_created, data JSON) — data.type:
 *   text{text} | reasoning{text,time{start,end}} |
 *   tool{callID,tool,state{status:completed|error,input,output?/error?}} |
 *   step-start | step-finish{reason,cost,tokens} | patch{hash,files} |
 *   subtask{prompt,description,agent,model,command} |
 *   file{mime,filename,url,source}.
 *
 * Usage mapping opencode → ParsedUsageEvent (проверено по total на живых
 * данных: total = input + output + cache.read + cache.write, т.е. поле
 * `input` НЕ включает cached tokens; reasoning у части провайдеров входит
 * в output, у части нет — поэтому total хранится только как reported):
 *   inputTokens        = input + cache.read + cache.write
 *   cachedInputTokens  = cache.read (подмножество input, §7.3)
 *   outputTokens       = output
 *   reasoningOutputTokens = reasoning (НЕ прибавляется повторно к output)
 *   totalTokensReported   = total (как сообщил источник)
 * message.data.tokens → scope "request" (одно assistant message = один
 * LLM-вызов). step-finish.tokens дублирует message.tokens — usage event
 * НЕ создаётся (защита от double-counting), part считается операционным.
 * session.tokens_* (проверено: точная сумма по сообщениям сессии) → одно
 * событие scope "session_cumulative" на последнем assistant message;
 * normalizeUsageEvents его не суммирует с request (сценарий 18).
 *
 * РЕШЕНИЯ (задокументированные):
 * - tool part содержит и input, и output → два чанка tool_call +
 *   tool_result внутри того же assistant message, связанные callID
 *   (сценарий 17);
 * - step-start/step-finish — операционные: не чанки, а metadata.eventCounts;
 * - user message: humanAuthored = true; при наличии data.format
 *   (structured output через SDK/`opencode run`) — "unknown";
 * - неизвестный part type → kind unknown + diagnostic, диалог не роняется.
 */

import { Database } from "bun:sqlite";
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
import { asNumber, asObject, asString, parseTimestamp } from "../shared/jsonl.ts";
import { normalizeModelName } from "../shared/model-normalization.ts";
import { isSqliteFile } from "../shared/sqlite.ts";

export const OPENCODE_PARSER_NAME = "opencode";
export const OPENCODE_PARSER_VERSION = 1;

/** Part types, которые не становятся чанками (операционные маркеры шага). */
const OPERATIONAL_PART_TYPES = new Set(["step-start", "step-finish"]);

interface ProjectRow {
  id: string;
  worktree: string | null;
  vcs: string | null;
  name: string | null;
}

interface SessionRow {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  agent: string | null;
  model: string | null;
  time_created: number | null;
  time_updated: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

interface MessageRow {
  id: string;
  time_created: number | null;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number | null;
  data: string;
}

export class OpenCodeParser implements HarnessParser {
  readonly parserName = OPENCODE_PARSER_NAME;
  readonly parserVersion = OPENCODE_PARSER_VERSION;
  readonly sourceFormatVersions = ["1"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    const diagnostics: ParsedDiagnostic[] = [];

    // storage/session_diff — JSON-дампы, не sqlite: raw архивируется,
    // parser их не читает (unsupported, а не SQLiteError "file is not
    // a database" на первом query — bun:sqlite открывает файл лениво).
    if ((await isSqliteFile(snapshotPath)) === false) {
      diagnostics.push({
        code: "unsupported_file",
        message: `${snapshotPath}: not a sqlite database (archived as raw only)`,
        severity: "error",
        sourceLocator: snapshotPath,
      });
      return { sourceKind: "sqlite", dialogues: emptyDialogues(), diagnostics };
    }

    let db: Database;
    try {
      db = new Database(snapshotPath, { readonly: true });
    } catch (error) {
      diagnostics.push({
        code: "sqlite_open_error",
        message: `${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`,
        severity: "error",
        sourceLocator: snapshotPath,
      });
      return { sourceKind: "sqlite", dialogues: emptyDialogues(), diagnostics };
    }

    try {
      if (!tableExists(db, "session")) {
        diagnostics.push({
          code: "missing_table",
          message: `${snapshotPath}: no session table (not an opencode.db?)`,
          severity: "error",
          sourceLocator: snapshotPath,
        });
        return { sourceKind: "sqlite", dialogues: emptyDialogues(), diagnostics };
      }

      const projects = new Map<string, ProjectRow>();
      if (tableExists(db, "project")) {
        for (const row of db
          .query<ProjectRow, []>("select id, worktree, vcs, name from project")
          .all()) {
          projects.set(row.id, row);
        }
      }

      const hasMessage = tableExists(db, "message");
      const hasPart = tableExists(db, "part");
      const sessions = db
        .query<SessionRow, []>(
          `select id, project_id, parent_id, directory, title, version, agent, model,
                  time_created, time_updated,
                  tokens_input, tokens_output, tokens_reasoning,
                  tokens_cache_read, tokens_cache_write
           from session order by time_created, id`,
        )
        .all();

      const dialogues: ParsedDialogue[] = [];
      for (const session of sessions) {
        dialogues.push(buildDialogue(db, session, projects, hasMessage, hasPart, context, diagnostics));
      }
      return {
        sourceKind: "sqlite",
        dialogues: (async function* () {
          for (const dialogue of dialogues) yield dialogue;
        })(),
        diagnostics,
      };
    } finally {
      db.close();
    }
  }
}

export const openCodeParser = new OpenCodeParser();

async function* emptyDialogues(): AsyncIterable<ParsedDialogue> {
  // пустой поток — только diagnostics
}

// --- сборка диалога ---

function buildDialogue(
  db: Database,
  session: SessionRow,
  projects: Map<string, ProjectRow>,
  hasMessage: boolean,
  hasPart: boolean,
  context: ParseContext | undefined,
  diagnostics: ParsedDiagnostic[],
): ParsedDialogue {
  const eventCounts: Record<string, number> = {};
  const count = (key: string) => {
    eventCounts[key] = (eventCounts[key] ?? 0) + 1;
  };

  const messageRows = hasMessage
    ? db
        .query<MessageRow, [string]>(
          "select id, time_created, data from message where session_id = ? order by time_created, id",
        )
        .all(session.id)
    : [];
  const partsByMessage = new Map<string, PartRow[]>();
  if (hasPart) {
    for (const part of db
      .query<PartRow, [string]>(
        "select id, message_id, time_created, data from part where session_id = ? order by time_created, id",
      )
      .all(session.id)) {
      const list = partsByMessage.get(part.message_id) ?? [];
      list.push(part);
      partsByMessage.set(part.message_id, list);
    }
  }

  const unknownPartTypes = new Set<string>();
  const messages: ParsedMessage[] = messageRows.map((row, sequence) =>
    buildMessage(
      session.id,
      row,
      partsByMessage.get(row.id) ?? [],
      sequence,
      count,
      unknownPartTypes,
      diagnostics,
    ),
  );

  // Session-cumulative usage: точная сумма по сообщениям (проверено на живых
  // данных) — одно событие на последнем assistant message.
  const sessionUsage = sessionUsageEvent(session);
  if (sessionUsage) {
    const target = [...messages].reverse().find((m) => m.role === "assistant");
    if (target) {
      target.usageEvents.push(sessionUsage);
    } else {
      count("usage.session_cumulative.orphan");
    }
  }

  const project = session.project_id ? projects.get(session.project_id) : undefined;
  const workspacePath = session.directory ?? project?.worktree ?? context?.workspaceHint;
  const sessionModel = asObject(parseJsonSafe(session.model));

  return {
    externalId: session.id,
    ...(asString(session.title) !== undefined ? { title: session.title! } : {}),
    ...(workspacePath !== undefined
      ? {
          workspace: {
            path: workspacePath,
            name: asString(project?.name) ?? basename(workspacePath),
            metadata: {
              ...(session.project_id !== null ? { projectId: session.project_id } : {}),
              ...(asString(project?.vcs) !== undefined ? { vcs: project!.vcs } : {}),
            },
          },
        }
      : {}),
    ...(parseTimestamp(session.time_created) !== undefined
      ? { startedAt: parseTimestamp(session.time_created)! }
      : {}),
    ...(parseTimestamp(session.time_updated) !== undefined
      ? { updatedAt: parseTimestamp(session.time_updated)! }
      : {}),
    messages,
    metadata: {
      ...(asString(session.version) !== undefined ? { opencodeVersion: session.version } : {}),
      ...(asString(session.agent) !== undefined ? { agent: session.agent } : {}),
      ...(asString(session.parent_id) !== undefined ? { parentId: session.parent_id } : {}),
      ...(sessionModel !== undefined ? { model: sessionModel } : {}),
      eventCounts,
    },
  };
}

// --- сборка сообщения ---

function buildMessage(
  sessionId: string,
  row: MessageRow,
  parts: PartRow[],
  sequence: number,
  count: (key: string) => void,
  unknownPartTypes: Set<string>,
  diagnostics: ParsedDiagnostic[],
): ParsedMessage {
  const locator = `session/${sessionId}/message/${row.id}`;
  const data = asObject(parseJsonSafe(row.data));
  if (!data) {
    diagnostics.push({
      code: "message_data_parse_error",
      message: `${locator}: message data is not valid JSON`,
      severity: "error",
      sourceLocator: locator,
    });
    count("message_data_parse_error");
    return {
      externalId: row.id,
      sequence,
      role: "unknown",
      humanAuthored: false,
      visibleToUser: "unknown",
      ...(parseTimestamp(row.time_created) !== undefined
        ? { timestamp: parseTimestamp(row.time_created)! }
        : {}),
      usageEvents: [],
      chunks: [
        {
          sequence: 0,
          kind: "unknown",
          rawKind: "message",
          content: row.data.slice(0, 4000),
          rawEventType: "message_data_parse_error",
          sourceLocator: locator,
          metadata: {},
        },
      ],
      metadata: {},
    };
  }

  const rawRole = asString(data.role) ?? "unknown";
  const role: NormalizedRole =
    rawRole === "user" || rawRole === "assistant" ? rawRole : "unknown";
  const time = asObject(data.time);
  const timestamp = parseTimestamp(time?.created) ?? parseTimestamp(row.time_created);
  const completedAt = parseTimestamp(time?.completed);

  const chunks: ParsedChunk[] = [];
  for (const part of parts) {
    chunks.push(
      ...buildPartChunks(sessionId, row.id, part, count, unknownPartTypes, diagnostics),
    );
  }

  const message: ParsedMessage = {
    externalId: row.id,
    sequence,
    role,
    ...(rawRole !== role ? { rawRole } : {}),
    humanAuthored:
      role === "user" ? (asObject(data.format) ? "unknown" : true) : false,
    visibleToUser: role === "unknown" ? "unknown" : true,
    ...(timestamp !== undefined ? { timestamp } : {}),
    usageEvents: [],
    chunks: chunks.map((chunk, index) => ({ ...chunk, sequence: index })),
    metadata: {
      ...(asString(data.agent) !== undefined ? { agent: data.agent } : {}),
      ...(asString(data.mode) !== undefined ? { mode: data.mode } : {}),
      ...(asString(data.parentID) !== undefined ? { parentId: data.parentID } : {}),
      ...(asString(data.finish) !== undefined ? { finish: data.finish } : {}),
      ...(asNumber(data.cost) !== undefined ? { cost: data.cost } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(asObject(data.error) !== undefined ? { error: data.error } : {}),
      ...(asObject(data.summary) !== undefined ? { summary: data.summary } : {}),
      ...(asObject(data.format) !== undefined ? { format: data.format } : {}),
      // user: выбранная на момент промпта модель — не модель генерации.
      ...(role === "user" && asObject(data.model) !== undefined ? { model: data.model } : {}),
    },
  };

  if (role === "assistant") {
    const modelID = asString(data.modelID);
    if (modelID) {
      const normalized = normalizeModelName(modelID);
      const invocation: ParsedModelInvocation = {
        rawModelName: modelID,
        vendor: normalized.vendor,
        canonicalName: normalized.canonicalName,
        ...(normalized.reasoningEffort !== undefined
          ? { reasoningEffort: normalized.reasoningEffort }
          : {}),
        serviceProvider: asString(data.providerID) ?? normalized.serviceProvider,
      };
      message.model = invocation;
    }
    const tokens = asObject(data.tokens);
    if (tokens) {
      message.usageEvents.push(opencodeUsageEvent(tokens, "request", "opencode.message.tokens"));
    }
  }

  return message;
}

// --- parts → chunks ---

function buildPartChunks(
  sessionId: string,
  messageId: string,
  part: PartRow,
  count: (key: string) => void,
  unknownPartTypes: Set<string>,
  diagnostics: ParsedDiagnostic[],
): ParsedChunk[] {
  const locator = `session/${sessionId}/message/${messageId}/part/${part.id}`;
  const data = asObject(parseJsonSafe(part.data));
  if (!data) {
    diagnostics.push({
      code: "part_data_parse_error",
      message: `${locator}: part data is not valid JSON`,
      severity: "error",
      sourceLocator: locator,
    });
    count("part_data_parse_error");
    return [
      {
        sequence: -1,
        kind: "unknown",
        rawKind: "part",
        content: part.data.slice(0, 4000),
        rawEventType: "part_data_parse_error",
        sourceLocator: locator,
        metadata: {},
      },
    ];
  }

  const type = asString(data.type) ?? "<missing>";

  if (OPERATIONAL_PART_TYPES.has(type)) {
    // step-start/step-finish — границы LLM-шага; step-finish.tokens
    // дублирует message.tokens → без usage event (no double-counting).
    count(`part.${type}`);
    return [];
  }

  const base = { sequence: -1, sourceLocator: locator };

  switch (type) {
    case "text":
      count("part.text");
      return [
        { ...base, kind: "text", rawKind: "text", content: asString(data.text) ?? "", metadata: {} },
      ];

    case "reasoning":
      count("part.reasoning");
      return [
        {
          ...base,
          kind: "thought",
          rawKind: "reasoning",
          content: asString(data.text) ?? "",
          metadata: { ...(asObject(data.time) !== undefined ? { time: data.time } : {}) },
        },
      ];

    case "tool": {
      count("part.tool");
      const state = asObject(data.state) ?? {};
      const status = asString(state.status) ?? "unknown";
      const callId = asString(data.callID);
      const toolName = asString(data.tool);
      const shared = {
        ...(callId !== undefined ? { toolCallId: callId } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
        rawEventType: "tool",
      };
      const resultContent =
        asString(state.output) ?? asString(state.error) ?? JSON.stringify(state);
      return [
        {
          ...base,
          kind: "tool_call",
          rawKind: "tool",
          content: JSON.stringify(state.input ?? {}),
          ...shared,
          metadata: { status },
        },
        {
          ...base,
          kind: "tool_result",
          rawKind: "tool",
          content: resultContent,
          ...shared,
          metadata: {
            status,
            ...(asObject(state.time) !== undefined ? { time: state.time } : {}),
          },
        },
      ];
    }

    case "patch":
      count("part.patch");
      return [
        {
          ...base,
          kind: "object",
          rawKind: "patch",
          content: JSON.stringify({ hash: data.hash ?? null, files: data.files ?? [] }),
          rawEventType: "patch",
          metadata: {},
        },
      ];

    case "subtask": {
      count("part.subtask");
      const content = asString(data.prompt) ?? asString(data.description) ?? "";
      return [
        {
          ...base,
          kind: "object",
          rawKind: "subtask",
          content,
          rawEventType: "subtask",
          metadata: {
            ...(asString(data.description) !== undefined ? { description: data.description } : {}),
            ...(asString(data.agent) !== undefined ? { agent: data.agent } : {}),
            ...(data.model !== undefined ? { model: data.model } : {}),
            ...(asString(data.command) !== undefined ? { command: data.command } : {}),
          },
        },
      ];
    }

    case "file": {
      count("part.file");
      const source = asObject(data.source);
      const sourceText = asObject(source?.text);
      return [
        {
          ...base,
          kind: "attachment",
          rawKind: "file",
          content: asString(sourceText?.value) ?? asString(data.filename),
          rawEventType: "file",
          metadata: {
            ...(asString(data.mime) !== undefined ? { mime: data.mime } : {}),
            ...(asString(data.filename) !== undefined ? { filename: data.filename } : {}),
            ...(asString(data.url) !== undefined ? { url: data.url } : {}),
          },
        },
      ];
    }

    default: {
      count(`part.unknown.${type}`);
      if (!unknownPartTypes.has(type)) {
        unknownPartTypes.add(type);
        diagnostics.push({
          code: "unknown_part_type",
          message: `${locator}: unknown part type ${type} (preserved as unknown chunk)`,
          severity: "warning",
          sourceLocator: locator,
        });
      }
      return [
        {
          ...base,
          kind: "unknown",
          rawKind: type,
          content: JSON.stringify(data).slice(0, 4000),
          rawEventType: type,
          metadata: {},
        },
      ];
    }
  }
}

// --- usage mapping ---

function opencodeUsageEvent(
  tokens: Record<string, unknown>,
  scope: ParsedUsageEvent["scope"],
  source: string,
): ParsedUsageEvent {
  const cache = asObject(tokens.cache);
  const input = asNumber(tokens.input) ?? 0;
  const cacheRead = asNumber(cache?.read) ?? 0;
  const cacheWrite = asNumber(cache?.write) ?? 0;
  const event: ParsedUsageEvent = {
    scope,
    // opencode `input` НЕ включает cached tokens (проверено по total).
    inputTokens: input + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    source,
    raw: tokens,
  };
  const output = asNumber(tokens.output);
  if (output !== undefined) event.outputTokens = output;
  const reasoning = asNumber(tokens.reasoning);
  if (reasoning !== undefined) event.reasoningOutputTokens = reasoning;
  const total = asNumber(tokens.total);
  if (total !== undefined) event.totalTokensReported = total;
  return event;
}

/** tokens_* сессии — cumulative по всей сессии; undefined, если всё по нулям. */
function sessionUsageEvent(session: SessionRow): ParsedUsageEvent | undefined {
  const input = session.tokens_input ?? 0;
  const output = session.tokens_output ?? 0;
  const reasoning = session.tokens_reasoning ?? 0;
  const cacheRead = session.tokens_cache_read ?? 0;
  const cacheWrite = session.tokens_cache_write ?? 0;
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return undefined;
  return {
    scope: "session_cumulative",
    inputTokens: input + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    source: "opencode.session.tokens",
    raw: {
      tokens_input: session.tokens_input,
      tokens_output: session.tokens_output,
      tokens_reasoning: session.tokens_reasoning,
      tokens_cache_read: session.tokens_cache_read,
      tokens_cache_write: session.tokens_cache_write,
    },
  };
}

// --- helpers ---

function tableExists(db: Database, table: string): boolean {
  return Boolean(
    db
      .query<{ name: string }, [string]>(
        "select name from sqlite_master where type = 'table' and name = ?",
      )
      .get(table),
  );
}

function parseJsonSafe(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
