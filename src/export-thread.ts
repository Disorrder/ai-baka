/**
 * Machine-readable export of one dialogue (docs/plan.md §17).
 *
 * The export is deliberately a whitelist of canonical corpus/provenance
 * fields. It never reads raw snapshots, ingest_error.raw_payload,
 * source_location.original_path, source_root.path or raw_archive_path.
 * Relative source paths are opt-in because even archive-relative names may
 * disclose a workspace/session identifier.
 */

import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import { selectAll, selectOne } from "./db/repositories/helpers.ts";

export const THREAD_EXPORT_FORMAT = "ai-baka-thread-export";
export const THREAD_EXPORT_FORMAT_VERSION = 1;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ExportedChunk {
  id: string;
  sequence: number;
  kind: string;
  role: string;
  rawKind?: string;
  content: string;
  contentSha256: string;
  contentBytes: number;
  tokenCountReported?: number;
  sourceLocator?: string;
  toolCallId?: string;
  toolName?: string;
  rawEventType?: string;
  metadata?: JsonValue;
}

export interface ExportedMessage {
  id: string;
  sequence: number;
  role: string;
  rawRole?: string;
  externalId?: string;
  humanAuthored: boolean;
  visibleToUser: boolean;
  timestamp?: string;
  model?: {
    id: string;
    vendor?: string;
    canonicalName?: string;
    rawName?: string;
    reasoningEffort?: string;
    serviceProvider?: string;
  };
  usage?: JsonValue;
  rawUsageEvents?: JsonValue;
  metadata?: JsonValue;
  chunks: ExportedChunk[];
}

export interface ExportedSourceProvenance {
  id: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  snapshotKind: string;
  capturedAt: string;
  parserName: string;
  parserVersion: string;
  parseStatus: string;
  canonicalHash?: string;
  dialoguesDiscovered?: number;
  sourceLocationId: string;
  sourceRootId: string;
  harness: string;
  sourceKind: string;
  relativePath?: string;
}

export interface ExportedDialogueRevision {
  id: string;
  current: boolean;
  sourceDialogueId?: string;
  parserName: string;
  parserVersion: string;
  canonicalHash: string;
  status: string;
  messageCount: number;
  chunkCount: number;
  startedAt?: string;
  updatedAt?: string;
  createdAt: string;
  source?: ExportedSourceProvenance;
  messages: ExportedMessage[];
}

export interface ThreadExportDocument {
  format: typeof THREAD_EXPORT_FORMAT;
  formatVersion: typeof THREAD_EXPORT_FORMAT_VERSION;
  dialogue: {
    id: string;
    identityKey: string;
    harnessInstallationId: string;
    harness: string;
    hostId: string;
    osAccountId?: string;
    workspaceId?: string;
    externalId?: string;
    title?: string;
    currentRevisionId?: string;
    primaryModelId?: string;
    startedAt?: string;
    updatedAt?: string;
    firstSeenAt: string;
    lastSeenAt: string;
  };
  revisions: ExportedDialogueRevision[];
}

export interface ExportThreadOptions {
  /** Omit or use "-" to receive stdout-ready JSON without writing a file. */
  outputPath?: string;
  /** Safe default is false: absolute paths are never exported. */
  includeRelativeSourcePaths?: boolean;
  /** Existing output is preserved unless overwrite is explicitly authorized. */
  force?: boolean;
}

export interface ExportThreadResult {
  document: ThreadExportDocument;
  /** Stable, pretty-printed JSON ending in one newline. */
  json: string;
  /** Absolute path when an atomic file write was requested. */
  outputPath?: string;
}

export class ThreadExportNotFoundError extends Error {}
export class ThreadExportIntegrityError extends Error {}

interface DialogueRow {
  id: RecordId;
  identity_key: string;
  harness_installation: RecordId;
  harness_slug: string;
  host: RecordId;
  os_account?: RecordId;
  workspace?: RecordId;
  external_id?: string;
  title?: string;
  current_revision?: RecordId;
  primary_model?: RecordId;
  started_at?: Date | string;
  updated_at?: Date | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

interface RevisionRow {
  id: RecordId;
  source_revision?: RecordId;
  source_dialogue_id?: string;
  parser_name: string;
  parser_version: string;
  canonical_hash: string;
  status: string;
  message_count: number;
  chunk_count: number;
  started_at?: Date | string;
  updated_at?: Date | string;
  created_at: Date | string;
}

interface MessageRow {
  id: RecordId;
  dialogue_revision: RecordId;
  external_id?: string;
  sequence: number;
  role: string;
  raw_role?: string;
  human_authored: boolean;
  visible_to_user: boolean;
  timestamp?: Date | string;
  model?: RecordId;
  model_vendor?: string;
  model_canonical_name?: string;
  raw_model_name?: string;
  reasoning_effort?: string;
  service_provider?: string;
  usage?: unknown;
  raw_usage_events?: unknown;
  metadata?: unknown;
}

interface ChunkRow {
  id: RecordId;
  dialogue_revision: RecordId;
  message: RecordId;
  sequence: number;
  kind: string;
  raw_kind?: string;
  role: string;
  content: string;
  content_sha256: string;
  content_bytes: number;
  token_count_reported?: number;
  source_locator?: string;
  tool_call_id?: string;
  tool_name?: string;
  raw_event_type?: string;
  metadata?: unknown;
}

interface SourceRow {
  id: RecordId;
  sha256: string;
  size_bytes: number;
  mtime_ms: number;
  snapshot_kind: string;
  captured_at: Date | string;
  parser_name: string;
  parser_version: string;
  parse_status: string;
  canonical_hash?: string;
  dialogues_discovered?: number;
  source_location: RecordId;
  source_root: RecordId;
  harness_slug: string;
  source_kind: string;
  relative_path?: string;
}

function recordText(value: RecordId | string): string {
  return typeof value === "string" ? value : value.toString();
}

function optionalRecord(value: RecordId | undefined): string | undefined {
  return value ? recordText(value) : undefined;
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ThreadExportIntegrityError(`invalid datetime in corpus: ${value}`);
  }
  return parsed.toISOString();
}

/** Convert SDK/Surreal values to plain JSON while sorting object keys. */
function stableJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RecordId) return value.toString();
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ThreadExportIntegrityError("non-finite number in canonical corpus");
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      result[key] = stableJsonValue(child);
    }
    return result;
  }
  throw new ThreadExportIntegrityError(`unsupported canonical value: ${typeof value}`);
}

function dialogueRecordId(input: string | RecordId): RecordId {
  if (input instanceof RecordId) {
    if (input.table.name !== "dialogue") {
      throw new Error(`expected dialogue record id, got ${input.toString()}`);
    }
    return input;
  }
  const value = input.trim();
  if (!value) throw new Error("dialogue id is empty");
  const prefix = "dialogue:";
  return new RecordId("dialogue", value.startsWith(prefix) ? value.slice(prefix.length) : value);
}

/**
 * Load and assemble a deterministic export document. Queries select only the
 * canonical whitelist above; adding a sensitive DB field cannot leak it into
 * exports accidentally.
 */
export async function buildThreadExport(
  db: Surreal,
  dialogueId: string | RecordId,
  options: Pick<ExportThreadOptions, "includeRelativeSourcePaths"> = {},
): Promise<ThreadExportDocument> {
  const rid = dialogueRecordId(dialogueId);
  const dialogue = await selectOne<DialogueRow>(
    db,
    `SELECT id, identity_key, harness_installation,
       harness_installation.harness.slug AS harness_slug,
       harness_installation.host AS host, os_account, workspace, external_id, title,
       current_revision, primary_model, started_at, updated_at, first_seen_at, last_seen_at
     FROM ONLY $dialogue`,
    { dialogue: rid },
  );
  if (!dialogue) throw new ThreadExportNotFoundError(`dialogue not found: ${rid.toString()}`);

  const revisions = await selectAll<RevisionRow>(
    db,
    `SELECT id, source_revision, source_dialogue_id, parser_name, parser_version,
       canonical_hash, status, message_count, chunk_count, started_at, updated_at, created_at
     FROM dialogue_revision WHERE dialogue = $dialogue ORDER BY created_at ASC, id ASC`,
    { dialogue: rid },
  );
  const messages = await selectAll<MessageRow>(
    db,
    `SELECT id, dialogue_revision, external_id, sequence, role, raw_role, human_authored,
       visible_to_user, timestamp, model, model.vendor.slug AS model_vendor,
       model.canonical_name AS model_canonical_name, raw_model_name, reasoning_effort,
       service_provider, usage, raw_usage_events, metadata
     FROM message WHERE dialogue = $dialogue
     ORDER BY dialogue_revision ASC, sequence ASC, id ASC`,
    { dialogue: rid },
  );
  const chunks = await selectAll<ChunkRow>(
    db,
    `SELECT id, dialogue_revision, message, sequence, kind, raw_kind, role, content,
       content_sha256, content_bytes, token_count_reported, source_locator, tool_call_id,
       tool_name, raw_event_type, metadata
     FROM chunk WHERE dialogue = $dialogue
     ORDER BY dialogue_revision ASC, message ASC, sequence ASC, id ASC`,
    { dialogue: rid },
  );

  const sourceIds = revisions.flatMap((revision) =>
    revision.source_revision ? [revision.source_revision] : [],
  );
  const sources = sourceIds.length === 0
    ? []
    : await selectAll<SourceRow>(
      db,
      `SELECT id, sha256, size_bytes, mtime_ms, snapshot_kind, captured_at, parser_name,
         parser_version, parse_status, canonical_hash, dialogues_discovered, source_location,
         source_location.source_root AS source_root,
         source_location.source_root.harness_installation.harness.slug AS harness_slug,
         source_location.source_root.source_kind AS source_kind,
         source_location.relative_path AS relative_path
       FROM source_revision WHERE id IN $ids ORDER BY id ASC`,
      { ids: sourceIds },
    );

  const chunksByMessage = new Map<string, ChunkRow[]>();
  for (const chunk of chunks) {
    const key = recordText(chunk.message);
    const list = chunksByMessage.get(key) ?? [];
    list.push(chunk);
    chunksByMessage.set(key, list);
  }
  const messagesByRevision = new Map<string, MessageRow[]>();
  for (const message of messages) {
    const key = recordText(message.dialogue_revision);
    const list = messagesByRevision.get(key) ?? [];
    list.push(message);
    messagesByRevision.set(key, list);
  }
  const sourcesById = new Map(sources.map((source) => [recordText(source.id), source]));
  const revisionIds = new Set(revisions.map((revision) => recordText(revision.id)));
  const messageIds = new Set(messages.map((message) => recordText(message.id)));
  const orphanMessage = messages.find((message) => !revisionIds.has(recordText(message.dialogue_revision)));
  const orphanChunk = chunks.find((chunk) => !messageIds.has(recordText(chunk.message)));
  if (orphanMessage || orphanChunk) {
    throw new ThreadExportIntegrityError(
      `dialogue ${recordText(dialogue.id)} contains orphan canonical records`,
    );
  }

  const currentRevision = optionalRecord(dialogue.current_revision);
  const mappedRevisions: ExportedDialogueRevision[] = revisions.map((revision) => {
    const revisionId = recordText(revision.id);
    const sourceRow = revision.source_revision
      ? sourcesById.get(recordText(revision.source_revision))
      : undefined;
    if (revision.source_revision && !sourceRow) {
      throw new ThreadExportIntegrityError(
        `source provenance missing for ${recordText(revision.source_revision)}`,
      );
    }
    const exportedMessages = (messagesByRevision.get(revisionId) ?? []).map((message) => {
      const modelId = optionalRecord(message.model);
      const mapped: ExportedMessage = {
        id: recordText(message.id),
        sequence: message.sequence,
        role: message.role,
        humanAuthored: message.human_authored,
        visibleToUser: message.visible_to_user,
        chunks: (chunksByMessage.get(recordText(message.id)) ?? []).map((chunk) => ({
          id: recordText(chunk.id),
          sequence: chunk.sequence,
          kind: chunk.kind,
          role: chunk.role,
          ...(chunk.raw_kind !== undefined ? { rawKind: chunk.raw_kind } : {}),
          content: chunk.content,
          contentSha256: chunk.content_sha256,
          contentBytes: chunk.content_bytes,
          ...(chunk.token_count_reported !== undefined
            ? { tokenCountReported: chunk.token_count_reported }
            : {}),
          ...(chunk.source_locator !== undefined ? { sourceLocator: chunk.source_locator } : {}),
          ...(chunk.tool_call_id !== undefined ? { toolCallId: chunk.tool_call_id } : {}),
          ...(chunk.tool_name !== undefined ? { toolName: chunk.tool_name } : {}),
          ...(chunk.raw_event_type !== undefined ? { rawEventType: chunk.raw_event_type } : {}),
          ...(chunk.metadata !== undefined ? { metadata: stableJsonValue(chunk.metadata) } : {}),
        })),
        ...(message.external_id !== undefined ? { externalId: message.external_id } : {}),
        ...(message.raw_role !== undefined ? { rawRole: message.raw_role } : {}),
        ...(message.timestamp !== undefined ? { timestamp: iso(message.timestamp) } : {}),
        ...(modelId
          ? {
            model: {
              id: modelId,
              ...(message.model_vendor !== undefined ? { vendor: message.model_vendor } : {}),
              ...(message.model_canonical_name !== undefined
                ? { canonicalName: message.model_canonical_name }
                : {}),
              ...(message.raw_model_name !== undefined ? { rawName: message.raw_model_name } : {}),
              ...(message.reasoning_effort !== undefined
                ? { reasoningEffort: message.reasoning_effort }
                : {}),
              ...(message.service_provider !== undefined
                ? { serviceProvider: message.service_provider }
                : {}),
            },
          }
          : {}),
        ...(message.usage !== undefined ? { usage: stableJsonValue(message.usage) } : {}),
        ...(message.raw_usage_events !== undefined
          ? { rawUsageEvents: stableJsonValue(message.raw_usage_events) }
          : {}),
        ...(message.metadata !== undefined ? { metadata: stableJsonValue(message.metadata) } : {}),
      };
      return mapped;
    });

    const source: ExportedSourceProvenance | undefined = sourceRow
      ? {
        id: recordText(sourceRow.id),
        sha256: sourceRow.sha256,
        sizeBytes: sourceRow.size_bytes,
        mtimeMs: sourceRow.mtime_ms,
        snapshotKind: sourceRow.snapshot_kind,
        capturedAt: iso(sourceRow.captured_at),
        parserName: sourceRow.parser_name,
        parserVersion: sourceRow.parser_version,
        parseStatus: sourceRow.parse_status,
        sourceLocationId: recordText(sourceRow.source_location),
        sourceRootId: recordText(sourceRow.source_root),
        harness: sourceRow.harness_slug,
        sourceKind: sourceRow.source_kind,
        ...(sourceRow.canonical_hash !== undefined ? { canonicalHash: sourceRow.canonical_hash } : {}),
        ...(sourceRow.dialogues_discovered !== undefined
          ? { dialoguesDiscovered: sourceRow.dialogues_discovered }
          : {}),
        ...(options.includeRelativeSourcePaths && sourceRow.relative_path !== undefined
          ? { relativePath: sourceRow.relative_path }
          : {}),
      }
      : undefined;

    return {
      id: revisionId,
      current: revisionId === currentRevision,
      parserName: revision.parser_name,
      parserVersion: revision.parser_version,
      canonicalHash: revision.canonical_hash,
      status: revision.status,
      messageCount: revision.message_count,
      chunkCount: revision.chunk_count,
      createdAt: iso(revision.created_at),
      messages: exportedMessages,
      ...(revision.source_dialogue_id !== undefined
        ? { sourceDialogueId: revision.source_dialogue_id }
        : {}),
      ...(revision.started_at !== undefined ? { startedAt: iso(revision.started_at) } : {}),
      ...(revision.updated_at !== undefined ? { updatedAt: iso(revision.updated_at) } : {}),
      ...(source ? { source } : {}),
    };
  });

  return {
    format: THREAD_EXPORT_FORMAT,
    formatVersion: THREAD_EXPORT_FORMAT_VERSION,
    dialogue: {
      id: recordText(dialogue.id),
      identityKey: dialogue.identity_key,
      harnessInstallationId: recordText(dialogue.harness_installation),
      harness: dialogue.harness_slug,
      hostId: recordText(dialogue.host),
      firstSeenAt: iso(dialogue.first_seen_at),
      lastSeenAt: iso(dialogue.last_seen_at),
      ...(optionalRecord(dialogue.os_account)
        ? { osAccountId: optionalRecord(dialogue.os_account)! }
        : {}),
      ...(optionalRecord(dialogue.workspace)
        ? { workspaceId: optionalRecord(dialogue.workspace)! }
        : {}),
      ...(dialogue.external_id !== undefined ? { externalId: dialogue.external_id } : {}),
      ...(dialogue.title !== undefined ? { title: dialogue.title } : {}),
      ...(currentRevision ? { currentRevisionId: currentRevision } : {}),
      ...(optionalRecord(dialogue.primary_model)
        ? { primaryModelId: optionalRecord(dialogue.primary_model)! }
        : {}),
      ...(dialogue.started_at !== undefined ? { startedAt: iso(dialogue.started_at) } : {}),
      ...(dialogue.updated_at !== undefined ? { updatedAt: iso(dialogue.updated_at) } : {}),
    },
    revisions: mappedRevisions,
  };
}

export function serializeThreadExport(document: ThreadExportDocument): string {
  return `${JSON.stringify(stableJsonValue(document), null, 2)}\n`;
}

/** Private fsynced temp; no-clobber publication by default, overwrite only with force. */
export async function writeThreadExportAtomically(
  outputPath: string,
  json: string,
  options: Pick<ExportThreadOptions, "force"> = {},
): Promise<string> {
  const absolute = path.resolve(outputPath);
  const directory = path.dirname(absolute);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.part`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(json, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.force) {
      const existing = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error(`refusing to overwrite non-regular output: ${absolute}`);
      }
      await rename(temporary, absolute);
    } else {
      // link(2) publishes the already-fsynced inode atomically and fails with
      // EEXIST instead of replacing an existing file or symlink.
      await link(temporary, absolute);
      await unlink(temporary);
    }
    // Best effort directory fsync: unsupported on some platforms/filesystems.
    const directoryHandle = await open(directory, "r").catch(() => undefined);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => {});
      await directoryHandle.close().catch(() => {});
    }
    return absolute;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function exportThread(
  db: Surreal,
  dialogueId: string | RecordId,
  options: ExportThreadOptions = {},
): Promise<ExportThreadResult> {
  const document = await buildThreadExport(db, dialogueId, options);
  const json = serializeThreadExport(document);
  if (!options.outputPath || options.outputPath === "-") return { document, json };
  const outputPath = await writeThreadExportAtomically(options.outputPath, json, options);
  return { document, json, outputPath };
}
