/**
 * Parser Cursor state.vscdb (SQLite snapshot, docs/sources.md).
 *
 * Источник: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
 * (и per-workspace `workspaceStorage/<hash>/state.vscdb` — та же структура).
 * Snapshot делается sync-слоем через VACUUM INTO (§9.2); parser открывает
 * файл ТОЛЬКО read-only (bun:sqlite, как src/sources/snapshot/raw-snapshot.ts).
 *
 * Формат (изучен на живой базе, июль 2026):
 * - таблица cursorDiskKV (key TEXT, value JSON):
 *   - `composerData:<composerId>` — диалог: name (заголовок), createdAt /
 *     lastUpdatedAt (epoch ms), fullConversationHeadersOnly
 *     ([{bubbleId, type: 1=user|2=assistant}]) — порядок сообщений
 *     (старый формат — массив `conversation` с той же структурой),
 *     usageData ({<rawModelName>: {costInCents, amount}}) — накопительная
 *     стоимость по моделям (session cumulative, НЕ токены);
 *   - `bubbleId:<composerId>:<bubbleId>` — сообщение: type (1 user /
 *     2 assistant), text, images[], tokenCount {inputTokens, outputTokens}
 *     (часто 0; ненулевое — оценка Cursor, isEstimated), isThought,
 *     allThinkingBlocks[], toolFormerData {name, toolCallId, rawArgs, params,
 *     result, status} — вызов инструмента И его результат в одном bubble,
 *     capabilityType, usageUuid. Per-message timestamps в формате нет;
 *   - `checkpointId:<composerId>:*`, `codeBlockDiff:<composerId>:*`,
 *     `messageRequestContext:<composerId>:*`, `agentKv:*` — операционные
 *     ключи; чанками не становятся, учитываются в metadata.eventCounts,
 *     raw остаётся в immutable snapshot;
 * - таблица composerHeaders (новый формат): composerId, workspaceId,
 *   createdAt, lastUpdatedAt, isArchived, isSubagent, value (JSON с
 *   workspaceIdentifier.uri.fsPath);
 * - ItemTable `composer.composerHeaders` — {allComposers: [...]} с
 *   workspaceIdentifier.uri.fsPath (связка composer → workspace path).
 * - ItemTable `aiService.generations` / `aiService.prompts` (старые chat
 *   tabs в workspace DB): ответов не содержат, не парсятся — eventCounts.
 *
 * Модель на уровне сообщения в формате отсутствует: имя модели берётся из
 * usageData composerData. Если модель ровно одна — она назначается всем
 * assistant messages (raw_model_name → shared normalizeModelName); если
 * несколько — атрибуция невозможна, список уходит в metadata.models.
 *
 * Неизвестные bubble type / битый JSON НЕ роняют диалог: unknown чанк +
 * diagnostic (план §19.2 сценарий 11). Битый composerData пропускает один
 * диалог, остальные диалоги snapshot'а парсятся.
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
import type { HarnessParser, ParseContext } from "../shared/parser.ts";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  parseTimestamp,
} from "../shared/jsonl.ts";
import { normalizeModelName } from "../shared/model-normalization.ts";

export const CURSOR_PARSER_NAME = "cursor";
export const CURSOR_PARSER_VERSION = 1;

/** Операционные префиксы cursorDiskKV: не сообщения, только счётчики. */
const OPERATIONAL_KEY_PREFIXES = [
  "checkpointId",
  "codeBlockDiff",
  "codeBlockPartialInlineDiffFates",
  "messageRequestContext",
  "agentKv",
];

interface ComposerHeader {
  workspacePath?: string;
  createdAt?: Date;
  lastUpdatedAt?: Date;
  isArchived?: boolean;
  isSubagent?: boolean;
  name?: string;
}

interface ComposerEntry {
  composerId: string;
  /** JSON composerData (может отсутствовать у header-only composer'а). */
  data: Record<string, unknown> | undefined;
  header: ComposerHeader | undefined;
}

export class CursorParser implements HarnessParser {
  readonly parserName = CURSOR_PARSER_NAME;
  readonly parserVersion = CURSOR_PARSER_VERSION;
  readonly sourceFormatVersions = ["cursor-state-vscdb-1"] as const;

  async parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot> {
    const diagnostics: ParsedDiagnostic[] = [];
    const dialogues: ParsedDialogue[] = [];

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
      return { sourceKind: "sqlite", dialogues: empty(), diagnostics };
    }

    try {
      const tables = tableSet(db);
      if (!tables.has("cursorDiskKV")) {
        // Workspace DB без cursorDiskKV: диалогов нет, это не ошибка.
        countAiService(db, tables, diagnostics, snapshotPath);
        return { sourceKind: "sqlite", dialogues: empty(), diagnostics };
      }

      const headers = readComposerHeaders(db, tables, snapshotPath, diagnostics);
      const composers = readComposers(db, headers, snapshotPath, diagnostics);
      const operationalCounts = countOperationalKeys(db);

      for (const composer of composers) {
        const dialogue = buildDialogue(
          db,
          composer,
          operationalCounts.get(composer.composerId),
          snapshotPath,
          context,
          diagnostics,
        );
        if (dialogue) dialogues.push(dialogue);
      }
      countAiService(db, tables, diagnostics, snapshotPath);
    } finally {
      db.close();
    }

    return {
      sourceKind: "sqlite",
      dialogues: (async function* () {
        yield* dialogues;
      })(),
      diagnostics,
    };
  }
}

export const cursorParser = new CursorParser();

async function* empty(): AsyncGenerator<ParsedDialogue> {}

// --- чтение snapshot'а ---

function tableSet(db: Database): Set<string> {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** composerHeaders table + ItemTable composer.composerHeaders → header map. */
function readComposerHeaders(
  db: Database,
  tables: Set<string>,
  path: string,
  diagnostics: ParsedDiagnostic[],
): Map<string, ComposerHeader> {
  const headers = new Map<string, ComposerHeader>();

  const merge = (composerId: string, header: ComposerHeader): void => {
    const existing = headers.get(composerId) ?? {};
    headers.set(composerId, { ...header, ...definedOnly(existing) });
  };

  if (tables.has("composerHeaders")) {
    const rows = db
      .query("SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders")
      .all() as Array<{
      composerId: string | null;
      createdAt: number | null;
      lastUpdatedAt: number | null;
      isArchived: number | null;
      isSubagent: number | null;
      value: string | null;
    }>;
    for (const row of rows) {
      if (!row.composerId) continue;
      let value: Record<string, unknown> | undefined;
      if (row.value) {
        try {
          value = asObject(JSON.parse(row.value));
        } catch (error) {
          diagnostics.push({
            code: "composer_header_parse_error",
            message: `${path}: composerHeaders ${row.composerId}: ${error instanceof Error ? error.message : String(error)}`,
            severity: "warning",
            sourceLocator: `composerHeaders/${row.composerId}`,
          });
        }
      }
      merge(row.composerId, {
        workspacePath: workspaceFsPath(value?.workspaceIdentifier),
        createdAt: parseTimestamp(row.createdAt ?? undefined),
        lastUpdatedAt: parseTimestamp(row.lastUpdatedAt ?? undefined),
        isArchived: row.isArchived === 1,
        isSubagent: row.isSubagent === 1,
        name: asString(value?.name),
      });
    }
  }

  if (tables.has("ItemTable")) {
    const row = db
      .query("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
      .get() as { value: unknown } | null;
    const text = valueText(row?.value);
    if (text) {
      try {
        const parsed = asObject(JSON.parse(text));
        for (const entry of asArray(parsed?.allComposers)) {
          const obj = asObject(entry);
          const composerId = asString(obj?.composerId);
          if (!composerId) continue;
          merge(composerId, {
            workspacePath: workspaceFsPath(obj?.workspaceIdentifier),
            createdAt: parseTimestamp(obj?.createdAt),
            lastUpdatedAt: parseTimestamp(obj?.lastUpdatedAt),
            isArchived: obj?.isArchived === true,
            isSubagent: obj?.isSubagent === true,
            name: asString(obj?.name),
          });
        }
      } catch (error) {
        diagnostics.push({
          code: "composer_headers_parse_error",
          message: `${path}: ItemTable composer.composerHeaders: ${error instanceof Error ? error.message : String(error)}`,
          severity: "warning",
          sourceLocator: "ItemTable/composer.composerHeaders",
        });
      }
    }
  }
  return headers;
}

/** composerId'ы = union composerData keys и composerHeaders. */
function readComposers(
  db: Database,
  headers: Map<string, ComposerHeader>,
  path: string,
  diagnostics: ParsedDiagnostic[],
): ComposerEntry[] {
  const composers = new Map<string, ComposerEntry>();
  for (const [composerId, header] of headers) {
    composers.set(composerId, { composerId, data: undefined, header });
  }
  const rows = db
    .query("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
    .all() as Array<{ key: string | null; value: unknown }>;
  for (const row of rows) {
    const composerId = row.key?.slice("composerData:".length);
    if (!composerId) continue;
    let data: Record<string, unknown> | undefined;
    const text = valueText(row.value);
    if (text) {
      try {
        data = asObject(JSON.parse(text));
      } catch (error) {
        // Битый composerData: пропускаем один диалог, остальные парсятся.
        diagnostics.push({
          code: "composer_data_parse_error",
          message: `${path}: ${row.key}: ${error instanceof Error ? error.message : String(error)}`,
          severity: "error",
          sourceLocator: `cursorDiskKV/${row.key}`,
        });
        composers.delete(composerId);
        continue;
      }
    }
    composers.set(composerId, {
      composerId,
      data,
      header: composers.get(composerId)?.header,
    });
  }
  return [...composers.values()];
}

/** Операционные ключи по composerId → metadata.eventCounts. */
function countOperationalKeys(db: Database): Map<string, Record<string, number>> {
  const counts = new Map<string, Record<string, number>>();
  const likeClause = OPERATIONAL_KEY_PREFIXES.map((prefix) => `key LIKE '${prefix}:%'`).join(" OR ");
  const rows = db
    .query(`SELECT key FROM cursorDiskKV WHERE ${likeClause}`)
    .all() as Array<{ key: string | null }>;
  for (const row of rows) {
    if (!row.key) continue;
    const [prefix, composerId] = row.key.split(":");
    if (!prefix || !composerId) continue;
    const entry = counts.get(composerId) ?? {};
    entry[prefix] = (entry[prefix] ?? 0) + 1;
    counts.set(composerId, entry);
  }
  return counts;
}

/** aiService.generations/prompts (старые chat tabs) — только diagnostic. */
function countAiService(
  db: Database,
  tables: Set<string>,
  diagnostics: ParsedDiagnostic[],
  path: string,
): void {
  if (!tables.has("ItemTable")) return;
  for (const key of ["aiService.generations", "aiService.prompts"]) {
    const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(key) as
      | { value: unknown }
      | null;
    const text = valueText(row?.value);
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        diagnostics.push({
          code: "unsupported_ai_service_entries",
          message: `${path}: ${key} содержит ${parsed.length} записей старого chat-tabs формата (не парсятся, raw сохранён)`,
          severity: "warning",
          sourceLocator: `ItemTable/${key}`,
        });
      }
    } catch {
      // Не JSON — не формат чатов, игнорируем.
    }
  }
}

// --- сборка диалога ---

function buildDialogue(
  db: Database,
  composer: ComposerEntry,
  operational: Record<string, number> | undefined,
  path: string,
  context: ParseContext | undefined,
  diagnostics: ParsedDiagnostic[],
): ParsedDialogue | undefined {
  const { composerId, data, header } = composer;

  // Порядок сообщений: fullConversationHeadersOnly, fallback — conversation.
  const headersOnly = asArray(data?.fullConversationHeadersOnly).length > 0
    ? asArray(data?.fullConversationHeadersOnly)
    : asArray(data?.conversation);
  const bubbleRefs = headersOnly
    .map((entry) => {
      const obj = asObject(entry);
      const bubbleId = asString(obj?.bubbleId);
      return bubbleId ? { bubbleId, type: asNumber(obj?.type) } : undefined;
    })
    .filter((ref): ref is { bubbleId: string; type: number | undefined } => ref !== undefined);

  const title = asString(data?.name) ?? header?.name;
  if (bubbleRefs.length === 0 && !title) {
    // Пустой draft (например, empty-state-draft) — не диалог.
    return undefined;
  }

  // Модели диалога из usageData (см. комментарий в шапке файла).
  const usageData = asObject(data?.usageData);
  const modelNames = Object.keys(usageData ?? {}).filter((name) => name.length > 0);
  const modelInvocation =
    modelNames.length === 1 ? cursorModelInvocation(modelNames[0]!) : undefined;

  const messages: ParsedMessage[] = [];
  for (const ref of bubbleRefs) {
    const locator = `cursorDiskKV/bubbleId:${composerId}:${ref.bubbleId}`;
    const row = db
      .query("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`bubbleId:${composerId}:${ref.bubbleId}`) as { value: unknown } | null;
    const text = valueText(row?.value);
    if (text === undefined) {
      diagnostics.push({
        code: "missing_bubble",
        message: `${path}: bubble ${ref.bubbleId} диалога ${composerId} отсутствует в cursorDiskKV`,
        severity: "warning",
        sourceLocator: locator,
      });
      continue;
    }
    let bubble: Record<string, unknown>;
    try {
      bubble = asObject(JSON.parse(text)) ?? {};
    } catch (error) {
      diagnostics.push({
        code: "bubble_parse_error",
        message: `${path}: bubble ${ref.bubbleId}: ${error instanceof Error ? error.message : String(error)}`,
        severity: "error",
        sourceLocator: locator,
      });
      messages.push(
        messageOf(messages.length, {
          externalId: ref.bubbleId,
          role: "unknown",
          rawRole: "unparseable_bubble",
          humanAuthored: false,
          visibleToUser: false,
          chunks: [
            chunkOf({
              kind: "unknown",
              rawKind: "unparseable_bubble",
              content: text.slice(0, 4000),
              rawEventType: "bubble_parse_error",
              sourceLocator: locator,
              metadata: {},
            }),
          ],
          metadata: {},
        }),
      );
      continue;
    }
    const parsed = bubbleToMessages(bubble, ref, modelInvocation, locator, path, diagnostics);
    for (const message of parsed) {
      messages.push(messageOf(messages.length, message));
    }
  }

  // usageData — session cumulative стоимость (не токены): на последнее
  // assistant message, scope сохраняется, в суммы не попадает (§7.3).
  if (usageData && Object.keys(usageData).length > 0) {
    const target = [...messages].reverse().find((message) => message.role === "assistant");
    if (target) {
      target.usageEvents.push({
        scope: "session_cumulative",
        isEstimated: true,
        source: "cursor.composer.usageData",
        raw: usageData,
      });
    }
  }

  const workspacePath = header?.workspacePath ?? context?.workspaceHint;
  const startedAt = parseTimestamp(data?.createdAt) ?? header?.createdAt;
  const updatedAt = parseTimestamp(data?.lastUpdatedAt) ?? header?.lastUpdatedAt;

  return {
    externalId: composerId,
    ...(title !== undefined ? { title } : {}),
    ...(workspacePath !== undefined
      ? { workspace: { path: workspacePath, name: basename(workspacePath) } }
      : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    messages,
    metadata: {
      ...(asString(data?.unifiedMode) !== undefined ? { unifiedMode: asString(data?.unifiedMode) } : {}),
      ...(data?.isAgentic !== undefined ? { isAgentic: data.isAgentic } : {}),
      ...(header?.isArchived !== undefined ? { isArchived: header.isArchived } : {}),
      ...(header?.isSubagent !== undefined ? { isSubagent: header.isSubagent } : {}),
      ...(modelNames.length > 1 ? { models: modelNames } : {}),
      eventCounts: operational ?? {},
    },
  };
}

type MessagePartial = Omit<ParsedMessage, "sequence" | "usageEvents" | "model" | "externalId"> & {
  externalId?: string;
  model?: ParsedModelInvocation | undefined;
  usageEvents?: ParsedUsageEvent[];
};

function messageOf(sequence: number, partial: MessagePartial): ParsedMessage {
  return {
    sequence,
    usageEvents: [],
    ...partial,
    chunks: partial.chunks.map((chunk, index) => ({ ...chunk, sequence: index })),
  };
}

function chunkOf(
  partial: Omit<ParsedChunk, "sequence" | "content" | "rawKind" | "toolCallId" | "toolName"> & {
    content?: string;
    rawKind?: string | undefined;
    toolCallId?: string | undefined;
    toolName?: string | undefined;
  },
): ParsedChunk {
  return { sequence: -1, ...partial } as ParsedChunk;
}

/** Bubble → 1..2 сообщения (tool bubble = assistant tool_call + tool result). */
function bubbleToMessages(
  bubble: Record<string, unknown>,
  ref: { bubbleId: string; type: number | undefined },
  model: ParsedModelInvocation | undefined,
  locator: string,
  path: string,
  diagnostics: ParsedDiagnostic[],
): MessagePartial[] {
  const type = asNumber(bubble.type) ?? ref.type;
  const text = typeof bubble.text === "string" ? bubble.text : undefined;
  const tool = asObject(bubble.toolFormerData);
  const tokenCount = asObject(bubble.tokenCount);
  const usageEvents: ParsedUsageEvent[] = [];
  const inputTokens = asNumber(tokenCount?.inputTokens);
  const outputTokens = asNumber(tokenCount?.outputTokens);
  if ((inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0) {
    usageEvents.push({
      scope: "request",
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      isEstimated: true,
      source: "cursor.bubble.tokenCount",
      raw: tokenCount,
    });
  }

  const baseMetadata: Record<string, unknown> = {
    ...(asNumber(bubble.capabilityType) !== undefined
      ? { capabilityType: asNumber(bubble.capabilityType) }
      : {}),
    ...(asString(bubble.usageUuid) !== undefined ? { usageUuid: asString(bubble.usageUuid) } : {}),
  };

  if (type === 1) {
    // User bubble: text — набранный человеком промпт; приложенный контекст
    // хранится в отдельных полях bubble и в text не попадает.
    const chunks: ParsedChunk[] = [];
    if (text !== undefined) {
      chunks.push(
        chunkOf({ kind: "text", rawKind: "text", content: text, sourceLocator: locator, metadata: {} }),
      );
    }
    for (const _image of asArray(bubble.images)) {
      chunks.push(
        chunkOf({ kind: "attachment", rawKind: "image", sourceLocator: locator, metadata: { image: true } }),
      );
    }
    return [
      {
        externalId: ref.bubbleId,
        role: "user",
        rawRole: "user",
        humanAuthored: true,
        visibleToUser: true,
        chunks,
        metadata: baseMetadata,
        ...(usageEvents.length > 0 ? { usageEvents } : {}),
      },
    ];
  }

  if (type === 2) {
    const chunks: ParsedChunk[] = [];
    const thoughtBlocks = asArray(bubble.allThinkingBlocks);
    for (const block of thoughtBlocks) {
      const blockText = asString(asObject(block)?.text) ?? asString(asObject(block)?.thinking);
      if (blockText) {
        chunks.push(
          chunkOf({ kind: "thought", rawKind: "allThinkingBlocks", content: blockText, sourceLocator: locator, metadata: {} }),
        );
      }
    }
    const isThought = bubble.isThought === true;
    if (text !== undefined && text.length > 0) {
      chunks.push(
        chunkOf({
          kind: isThought ? "thought" : "text",
          rawKind: isThought ? "isThought" : "text",
          content: text,
          sourceLocator: locator,
          metadata: {},
        }),
      );
    } else if (text !== undefined && !tool) {
      // Пустое сообщение (план §11.2): text-чанк с пустым содержимым.
      chunks.push(
        chunkOf({ kind: "text", rawKind: "text", content: "", sourceLocator: locator, metadata: { empty: true } }),
      );
    }

    const out: MessagePartial[] = [];
    if (tool) {
      const toolCallId = asString(tool.toolCallId);
      chunks.push(
        chunkOf({
          kind: "tool_call",
          rawKind: "toolFormerData",
          content: asString(tool.rawArgs) ?? asString(tool.params) ?? "",
          toolCallId,
          toolName: asString(tool.name),
          rawEventType: "toolFormerData",
          sourceLocator: locator,
          metadata: { status: asString(tool.status) },
        }),
      );
      out.push({
        externalId: ref.bubbleId,
        role: "assistant",
        rawRole: "assistant",
        humanAuthored: false,
        visibleToUser: text !== undefined && text.length > 0 && !isThought,
        chunks,
        model,
        metadata: baseMetadata,
        ...(usageEvents.length > 0 ? { usageEvents } : {}),
      });
      const result = asString(tool.result);
      if (result !== undefined) {
        out.push({
          role: "tool",
          rawRole: "toolFormerData.result",
          humanAuthored: false,
          visibleToUser: false,
          chunks: [
            chunkOf({
              kind: "tool_result",
              rawKind: "toolFormerData.result",
              content: result,
              toolCallId,
              rawEventType: "toolFormerData",
              sourceLocator: locator,
              metadata: {},
            }),
          ],
          metadata: {},
        });
      }
      return out;
    }

    out.push({
      externalId: ref.bubbleId,
      role: "assistant",
      rawRole: "assistant",
      humanAuthored: false,
      visibleToUser: !isThought && thoughtBlocks.length === 0,
      chunks,
      model,
      metadata: baseMetadata,
      ...(usageEvents.length > 0 ? { usageEvents } : {}),
    });
    return out;
  }

  // Неизвестный bubble type (§19.2 сценарий 11): unknown, диалог цел.
  diagnostics.push({
    code: "unknown_event",
    message: `${path}: unknown bubble type ${String(type)} (preserved as unknown chunk)`,
    severity: "warning",
    sourceLocator: locator,
  });
  return [
    {
      externalId: ref.bubbleId,
      role: "unknown",
      rawRole: `bubble_type_${String(type)}`,
      humanAuthored: false,
      visibleToUser: false,
      chunks: [
        chunkOf({
          kind: "unknown",
          rawKind: `bubble_type_${String(type)}`,
          content: JSON.stringify(bubble).slice(0, 4000),
          rawEventType: `bubble.type.${String(type)}`,
          sourceLocator: locator,
          metadata: {},
        }),
      ],
      metadata: {},
    },
  ];
}

// --- helpers ---

function cursorModelInvocation(rawModelName: string): ParsedModelInvocation {
  const normalized = normalizeModelName(rawModelName);
  return {
    rawModelName,
    vendor: normalized.vendor,
    canonicalName: normalized.canonicalName,
    reasoningEffort: normalized.reasoningEffort,
    serviceProvider: normalized.serviceProvider,
  };
}

/** cursorDiskKV/ItemTable value: TEXT или BLOB → строка. */
function valueText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

/** workspaceIdentifier.uri.fsPath (URI-объект VS Code). */
function workspaceFsPath(identifier: unknown): string | undefined {
  const uri = asObject(asObject(identifier)?.uri);
  return asString(uri?.fsPath) ?? asString(uri?.path);
}

function definedOnly(header: ComposerHeader): ComposerHeader {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(header)) {
    if (value !== undefined) out[key] = value;
  }
  return out as ComposerHeader;
}
