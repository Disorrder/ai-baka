/**
 * Read-only adapter над snapshot-копией legacy SQLite (docs/plan.md §15).
 * Оригинальная legacy DB сюда не передаётся: caller обязан сначала вызвать
 * ensureLegacySnapshot. Все SELECT выполняются с PRAGMA query_only.
 */

import { Database } from "bun:sqlite";
import type {
  NormalizedChunkKind,
  NormalizedRole,
} from "../domain/enums.ts";
import type {
  ParsedChunk,
  ParsedDialogue,
  ParsedMessage,
  ParsedUsageEvent,
} from "../domain/canonical-types.ts";
import { normalizeModelName } from "../parsers/shared/model-normalization.ts";
import { sha256hex } from "../db/transactions.ts";

export const LEGACY_TABLES = [
  "agent_systems",
  "projects",
  "source_files",
  "raw_backups",
  "threads",
  "thread_records",
  "messages",
  "message_chunks",
] as const;

export type LegacyTable = (typeof LEGACY_TABLES)[number];
export type LegacySqlValue = string | number | bigint | Uint8Array | null;
export type LegacySqlRow = Record<string, LegacySqlValue> & { id: number | string };

export interface LegacyAgentRow extends LegacySqlRow {
  id: number;
  slug: string;
}

export interface LegacyProjectRow extends LegacySqlRow {
  id: number;
  agent_id: number;
  external_id: string;
}

export interface LegacySourceFileRow extends LegacySqlRow {
  id: number;
  agent_id: number;
  original_path: string;
  status: string;
  sha256: string;
}

export interface LegacyRawBackupRow extends LegacySqlRow {
  id: number;
  source_file_id: number;
  archive_path: string;
}

export interface LegacyThreadRow extends LegacySqlRow {
  id: number;
  agent_id: number;
  external_id: string;
}

export interface LegacyThreadRecordRow extends LegacySqlRow {
  id: number;
  thread_id: number;
  source_file_id: number | null;
  sequence: number;
  payload: string;
}

export interface LegacyMessageRow extends LegacySqlRow {
  id: number;
  thread_id: number;
  sequence: number;
}

export interface LegacyChunkRow extends LegacySqlRow {
  id: number;
  message_id: number;
  sequence: number;
}

/**
 * Source provenance is the atomic ownership unit of the migration writer.
 * Keeping every raw_backups child beside its source row prevents callers from
 * accidentally committing the parent while a child identity is omitted.
 */
export interface LegacySourceBundle {
  source: LegacySourceFileRow;
  rawBackups: LegacyRawBackupRow[];
}

function sqlNumber(value: LegacySqlValue | undefined, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function sqlString(value: LegacySqlValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function parseDate(value: LegacySqlValue | undefined): Date | undefined {
  const raw = sqlString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** JSON-safe снимок исходной SQLite row для migration_quarantine. */
export function legacyRowPayload(row: LegacySqlRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array
      ? { encoding: "base64", data: Buffer.from(value).toString("base64") }
      : typeof value === "bigint"
        ? value.toString()
        : value;
  }
  return out;
}

function normalizeRole(raw: string | undefined): { role: NormalizedRole; rawRole?: string } {
  switch (raw) {
    case "user":
    case "assistant":
    case "system":
    case "developer":
    case "tool":
      return { role: raw };
    case "model":
      return { role: "assistant", rawRole: raw };
    default:
      return { role: "unknown", ...(raw ? { rawRole: raw } : {}) };
  }
}

function normalizeKind(raw: string | undefined): NormalizedChunkKind {
  switch (raw) {
    case "input_text":
    case "output_text":
    case "text":
      return "text";
    case "reasoning":
    case "thinking":
      return "thought";
    case "tool":
    case "tool_use":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    case "image":
    case "input_image":
    case "file":
    case "document":
      return "attachment";
    case "object":
    case "patch":
    case "step-finish":
    case "step-start":
    case "subtask":
      return "object";
    default:
      return "unknown";
  }
}

/** RFC 6901 JSON pointer; legacy content_path использует именно этот вид. */
export function resolveJsonPointer(value: unknown, pointer: string | undefined): unknown {
  if (!pointer || pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parsePayload(row: LegacyThreadRecordRow | undefined): unknown {
  if (!row || typeof row.payload !== "string" || row.payload.length === 0) return undefined;
  try {
    return JSON.parse(row.payload) as unknown;
  } catch {
    return undefined;
  }
}

export class LegacyNormalizedContentError extends Error {}

function contentString(value: unknown, locator: string): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) {
    throw new LegacyNormalizedContentError(`${locator}: content pointer не разрешён`);
  }
  return JSON.stringify(value);
}

function verifyNormalizedContent(row: LegacyChunkRow, content: string): void {
  const locator = `message_chunks:${row.id}`;
  const expectedSha = sqlString(row.content_sha256);
  if (!expectedSha) {
    throw new LegacyNormalizedContentError(`${locator}: content_sha256 отсутствует`);
  }
  const actualSha = sha256hex(content);
  if (actualSha !== expectedSha.toLowerCase()) {
    throw new LegacyNormalizedContentError(
      `${locator}: content_sha256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    );
  }
  const rawBytes = row.content_bytes;
  if (rawBytes === null || rawBytes === undefined) {
    throw new LegacyNormalizedContentError(`${locator}: content_bytes отсутствует`);
  }
  const expectedBytes = sqlNumber(rawBytes, Number.NaN);
  const actualBytes = Buffer.byteLength(content, "utf8");
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes !== actualBytes) {
    throw new LegacyNormalizedContentError(
      `${locator}: content_bytes mismatch: expected ${String(rawBytes)}, got ${actualBytes}`,
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(object: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstPointer(value: unknown, pointers: string[]): unknown {
  for (const pointer of pointers) {
    const found = resolveJsonPointer(value, pointer);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

function numericField(object: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function usageFromPayload(payload: unknown): ParsedUsageEvent[] {
  const raw = firstPointer(payload, [
    "/message/usage",
    "/payload/usage",
    "/data/usage",
    "/usage",
  ]);
  const usage = objectValue(raw);
  if (!usage) return [];
  const event: ParsedUsageEvent = {
    scope: "request",
    source: "legacy.normalized.payload",
    raw,
  };
  const inputTokens = numericField(usage, ["input_tokens", "inputTokens", "prompt_tokens"]);
  const cachedInputTokens = numericField(usage, [
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cachedInputTokens",
  ]);
  const outputTokens = numericField(usage, ["output_tokens", "outputTokens", "completion_tokens"]);
  const reasoningOutputTokens = numericField(usage, [
    "reasoning_output_tokens",
    "reasoning_tokens",
    "reasoningOutputTokens",
  ]);
  const totalTokensReported = numericField(usage, ["total_tokens", "totalTokens"]);
  if (inputTokens !== undefined) event.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) event.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) event.outputTokens = outputTokens;
  if (reasoningOutputTokens !== undefined) event.reasoningOutputTokens = reasoningOutputTokens;
  if (totalTokensReported !== undefined) event.totalTokensReported = totalTokensReported;
  return [event];
}

function modelFromPayload(payload: unknown): ParsedMessage["model"] {
  const value = firstPointer(payload, [
    "/message/model",
    "/payload/model",
    "/data/model",
    "/model",
    "/model_name",
  ]);
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const normalized = normalizeModelName(value);
  return { rawModelName: value, ...normalized };
}

export interface LegacyThreadBundle {
  thread: LegacyThreadRow;
  records: LegacyThreadRecordRow[];
  messages: LegacyMessageRow[];
  chunks: LegacyChunkRow[];
}

/**
 * Восстановление Canonical DTO из legacy normalized rows. content_path и
 * metadata_path разрешаются относительно исходного thread_record.payload;
 * raw kind/role и legacy ids остаются в DTO metadata.
 */
export function dialogueFromNormalized(bundle: LegacyThreadBundle): ParsedDialogue {
  const records = new Map(bundle.records.map((row) => [row.id, row]));
  const chunksByMessage = new Map<number, LegacyChunkRow[]>();
  for (const row of bundle.chunks) {
    const list = chunksByMessage.get(row.message_id) ?? [];
    list.push(row);
    chunksByMessage.set(row.message_id, list);
  }

  const messages: ParsedMessage[] = [];
  for (const row of [...bundle.messages].sort((a, b) => a.sequence - b.sequence || a.id - b.id)) {
    const sourceRecordId = sqlNumber(row.source_record_id, -1);
    const sourceRecord = records.get(sourceRecordId);
    const payload = parsePayload(sourceRecord);
    const role = normalizeRole(sqlString(row.role));
    const chunks: ParsedChunk[] = [];
    for (const chunkRow of (chunksByMessage.get(row.id) ?? [])
      .sort((a, b) => a.sequence - b.sequence || a.id - b.id)) {
      const chunkSourceId = sqlNumber(chunkRow.source_record_id, sourceRecordId);
      const chunkRecord = records.get(chunkSourceId) ?? sourceRecord;
      const chunkPayload = parsePayload(chunkRecord);
      const contentPath = sqlString(chunkRow.content_path);
      const metadataPath = sqlString(chunkRow.metadata_path);
      const metadataValue = resolveJsonPointer(chunkPayload, metadataPath);
      if (metadataPath && metadataValue === undefined) {
        throw new LegacyNormalizedContentError(
          `message_chunks:${chunkRow.id}: metadata pointer ${metadataPath} не разрешён`,
        );
      }
      const metadataObject = objectValue(metadataValue);
      const rawKind = sqlString(chunkRow.kind);
      const contentValue = resolveJsonPointer(chunkPayload, contentPath);
      const content = contentString(
        contentValue,
        `message_chunks:${chunkRow.id}${contentPath ? ` ${contentPath}` : ""}`,
      );
      verifyNormalizedContent(chunkRow, content);
      chunks.push({
        sequence: sqlNumber(chunkRow.sequence),
        kind: normalizeKind(rawKind),
        ...(rawKind ? { rawKind } : {}),
        content,
        sourceLocator: `legacy:thread_records:${chunkRecord?.id ?? "unknown"}${contentPath ?? ""}`,
        ...(firstString(metadataObject, ["tool_call_id", "call_id", "id"])
          ? { toolCallId: firstString(metadataObject, ["tool_call_id", "call_id", "id"]) }
          : {}),
        ...(firstString(metadataObject, ["tool_name", "name"])
          ? { toolName: firstString(metadataObject, ["tool_name", "name"]) }
          : {}),
        metadata: {
          legacyChunkId: chunkRow.id,
          legacySourceRecordId: chunkRecord?.id ?? null,
          ...(metadataObject ? { legacyMetadata: metadataObject } : {}),
        },
      });
    }
    const model = role.role === "assistant" ? modelFromPayload(payload) : undefined;
    messages.push({
      externalId: sqlString(row.external_id),
      sequence: sqlNumber(row.sequence),
      role: role.role,
      ...(role.rawRole ? { rawRole: role.rawRole } : {}),
      humanAuthored: role.role === "user",
      visibleToUser: role.role === "user" || role.role === "assistant",
      timestamp: parseDate(row.timestamp),
      ...(model ? { model } : {}),
      usageEvents: usageFromPayload(payload),
      chunks,
      metadata: {
        legacyMessageId: row.id,
        legacySourceRecordId: sourceRecord?.id ?? null,
        recovery: "legacy_normalized",
        ...(payload === undefined && sourceRecord ? { payloadUnparseable: true } : {}),
      },
    });
  }

  const projectPath = sqlString(bundle.thread.project_path);
  const projectName = sqlString(bundle.thread.project_name);
  return {
    externalId: bundle.thread.external_id,
    title: sqlString(bundle.thread.title),
    ...(projectPath || projectName
      ? { workspace: { ...(projectPath ? { path: projectPath } : {}), ...(projectName ? { name: projectName } : {}) } }
      : {}),
    startedAt: parseDate(bundle.thread.started_at),
    updatedAt: parseDate(bundle.thread.updated_at),
    messages,
    metadata: { legacyThreadId: bundle.thread.id, recovery: "legacy_normalized" },
  };
}

export function validateLegacyDialogue(dialogue: ParsedDialogue): string[] {
  const problems: string[] = [];
  const messageSequences = new Set<number>();
  for (const message of dialogue.messages) {
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 0) {
      problems.push(`invalid message sequence ${message.sequence}`);
    } else if (messageSequences.has(message.sequence)) {
      problems.push(`duplicate message sequence ${message.sequence}`);
    }
    messageSequences.add(message.sequence);
    const chunkSequences = new Set<number>();
    for (const chunk of message.chunks) {
      if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0) {
        problems.push(`invalid chunk sequence ${message.sequence}:${chunk.sequence}`);
      } else if (chunkSequences.has(chunk.sequence)) {
        problems.push(`duplicate chunk sequence ${message.sequence}:${chunk.sequence}`);
      }
      chunkSequences.add(chunk.sequence);
    }
  }
  if (dialogue.messages.length === 0) problems.push("dialogue has no messages");
  return problems;
}

function tableCount(db: Database, table: LegacyTable): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
}

function rows<T>(db: Database, sql: string, params: Array<string | number | null> = []): T[] {
  return db.query<T, Array<string | number | null>>(sql).all(...params);
}

export class LegacySnapshotReader {
  private readonly db: Database;
  readonly totals: Record<LegacyTable, number>;

  constructor(readonly snapshotPath: string) {
    this.db = new Database(snapshotPath, { readonly: true, create: false });
    this.db.run("PRAGMA query_only = ON");
    const present = new Set(
      this.db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all().map((row) => row.name),
    );
    for (const table of LEGACY_TABLES) {
      if (!present.has(table)) throw new Error(`legacy snapshot: отсутствует таблица ${table}`);
    }
    this.totals = Object.fromEntries(
      LEGACY_TABLES.map((table) => [table, tableCount(this.db, table)]),
    ) as Record<LegacyTable, number>;
  }

  close(): void {
    this.db.close();
  }

  agents(): LegacyAgentRow[] {
    return rows<LegacyAgentRow>(this.db, "SELECT * FROM agent_systems ORDER BY id");
  }

  projects(): LegacyProjectRow[] {
    return rows<LegacyProjectRow>(this.db, "SELECT * FROM projects ORDER BY id");
  }

  sourceFiles(): LegacySourceFileRow[] {
    return rows<LegacySourceFileRow>(this.db, "SELECT * FROM source_files ORDER BY id");
  }

  rawBackups(): LegacyRawBackupRow[] {
    return rows<LegacyRawBackupRow>(this.db, "SELECT * FROM raw_backups ORDER BY source_file_id, id");
  }

  sourceBundles(): LegacySourceBundle[] {
    const backupsBySource = new Map<number, LegacyRawBackupRow[]>();
    for (const backup of this.rawBackups()) {
      const current = backupsBySource.get(backup.source_file_id) ?? [];
      current.push(backup);
      backupsBySource.set(backup.source_file_id, current);
    }
    return this.sourceFiles().map((source) => ({
      source,
      rawBackups: backupsBySource.get(source.id) ?? [],
    }));
  }

  threads(): LegacyThreadRow[] {
    return rows<LegacyThreadRow>(this.db, "SELECT * FROM threads ORDER BY id");
  }

  threadBundle(thread: LegacyThreadRow): LegacyThreadBundle {
    const projectId = sqlNumber(thread.project_id, -1);
    const project = projectId >= 0
      ? this.db.query<LegacyProjectRow, [number]>("SELECT * FROM projects WHERE id = ? LIMIT 1").get(projectId)
      : undefined;
    const enriched = {
      ...thread,
      project_path: project?.path ?? null,
      project_name: project?.name ?? null,
    } as LegacyThreadRow;
    return {
      thread: enriched,
      records: rows<LegacyThreadRecordRow>(
        this.db,
        "SELECT * FROM thread_records WHERE thread_id = ? ORDER BY sequence, id",
        [thread.id],
      ),
      messages: rows<LegacyMessageRow>(
        this.db,
        "SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence, id",
        [thread.id],
      ),
      chunks: rows<LegacyChunkRow>(
        this.db,
        `SELECT mc.* FROM message_chunks mc
         JOIN messages m ON m.id = mc.message_id
         WHERE m.thread_id = ? ORDER BY m.sequence, mc.sequence, mc.id`,
        [thread.id],
      ),
    };
  }

  orphanThreadRecords(): LegacyThreadRecordRow[] {
    return rows<LegacyThreadRecordRow>(
      this.db,
      `SELECT tr.* FROM thread_records tr LEFT JOIN threads t ON t.id = tr.thread_id
       WHERE t.id IS NULL ORDER BY tr.id`,
    );
  }

  orphanMessages(): LegacyMessageRow[] {
    return rows<LegacyMessageRow>(
      this.db,
      `SELECT m.* FROM messages m LEFT JOIN threads t ON t.id = m.thread_id
       WHERE t.id IS NULL ORDER BY m.id`,
    );
  }

  orphanChunks(): LegacyChunkRow[] {
    return rows<LegacyChunkRow>(
      this.db,
      `SELECT mc.* FROM message_chunks mc
       LEFT JOIN messages m ON m.id = mc.message_id
       LEFT JOIN threads t ON t.id = m.thread_id
       WHERE m.id IS NULL OR t.id IS NULL ORDER BY mc.id`,
    );
  }
}

export function stringColumn(row: LegacySqlRow, name: string): string | undefined {
  return sqlString(row[name]);
}

export function numberColumn(row: LegacySqlRow, name: string, fallback = 0): number {
  return sqlNumber(row[name], fallback);
}

/** Exact legacy deletion evidence used by the canonical import admission gate. */
export function isLegacySourceDeleted(row: LegacySourceFileRow): boolean {
  return stringColumn(row, "status") === "deleted_in_source" ||
    stringColumn(row, "deleted_at") !== undefined;
}
