/**
 * Provenance-репозитории (docs/plan.md §7.2): source_root, sync_run,
 * source_scan, source_location, source_revision, ingest_error.
 *
 * option-полям передаём undefined (→ NONE), НЕ null (NULL отклоняется
 * coerce'ом схемы — проверено на SurrealDB 3.2.3).
 */

import type { RecordId, Surreal } from "surrealdb";
import { clean, selectAll, selectOne } from "./helpers.ts";

export interface SourceRootInput {
  harnessInstallation: RecordId;
  path: string;
  sourceKind: string;
  parserName: string;
  snapshotStrategy: string;
  enabled: boolean;
}

export async function ensureSourceRoot(
  db: Surreal,
  input: SourceRootInput,
): Promise<RecordId> {
  const now = new Date();
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM source_root WHERE harness_installation = $inst AND path = $path LIMIT 1",
    { inst: input.harnessInstallation, path: input.path },
  );
  if (existing) {
    await db.query(
      `UPDATE $id SET source_kind = $kind, parser_name = $parser, snapshot_strategy = $strategy,
         enabled = $enabled, last_seen_at = $now`,
      {
        id: existing.id,
        kind: input.sourceKind,
        parser: input.parserName,
        strategy: input.snapshotStrategy,
        enabled: input.enabled,
        now,
      },
    );
    return existing.id;
  }
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY source_root SET harness_installation = $inst, path = $path, source_kind = $kind,
       parser_name = $parser, snapshot_strategy = $strategy, enabled = $enabled,
       first_seen_at = $now, last_seen_at = $now`,
    {
      inst: input.harnessInstallation,
      path: input.path,
      kind: input.sourceKind,
      parser: input.parserName,
      strategy: input.snapshotStrategy,
      enabled: input.enabled,
      now,
    },
  );
  return created!.id;
}

export interface SyncRunInput {
  kind: string;
  host: RecordId;
  bakaCommit: string;
  schemaVersion: number;
  configurationFingerprint?: string;
}

export async function createSyncRun(db: Surreal, input: SyncRunInput): Promise<RecordId> {
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY sync_run SET kind = $kind, status = "running", started_at = $now, host = $host,
       baka_commit = $commit, schema_version = $schema, configuration_fingerprint = $fingerprint`,
    {
      kind: input.kind,
      now: new Date(),
      host: input.host,
      commit: input.bakaCommit,
      schema: input.schemaVersion,
      fingerprint: input.configurationFingerprint ?? undefined,
    },
  );
  return created!.id;
}

export async function finishSyncRun(
  db: Surreal,
  id: RecordId,
  input: { status: string; counters: Record<string, unknown>; errorSummary?: string },
): Promise<void> {
  await db.query(
    "UPDATE $id SET status = $status, finished_at = $now, counters = $counters, error_summary = $error",
    {
      id,
      status: input.status,
      now: new Date(),
      counters: clean(input.counters),
      error: input.errorSummary ?? undefined,
    },
  );
}

export interface SourceScanInput {
  syncRun: RecordId;
  sourceRoot: RecordId;
  status: string;
  filesSeen: number;
  startedAt: Date;
}

export async function createSourceScan(
  db: Surreal,
  input: SourceScanInput,
): Promise<RecordId> {
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY source_scan SET sync_run = $run, source_root = $root, status = $status,
       files_seen = $seen, files_new = 0, files_changed = 0, files_missing = 0, errors = 0,
       started_at = $started`,
    {
      run: input.syncRun,
      root: input.sourceRoot,
      status: input.status,
      seen: input.filesSeen,
      started: input.startedAt,
    },
  );
  return created!.id;
}

export async function finishSourceScan(
  db: Surreal,
  id: RecordId,
  counters: { filesNew: number; filesChanged: number; filesMissing: number; errors: number },
): Promise<void> {
  await db.query(
    `UPDATE $id SET files_new = $new, files_changed = $changed, files_missing = $missing,
       errors = $errors, finished_at = $now`,
    {
      id,
      new: counters.filesNew,
      changed: counters.filesChanged,
      missing: counters.filesMissing,
      errors: counters.errors,
      now: new Date(),
    },
  );
}

/** Состояние location + fingerprint текущей revision (для reconciler'а). */
export interface LocationRow {
  id: RecordId;
  relative_path: string;
  basename: string;
  presence_status: string;
  missing_complete_scans: number;
  renamed_from?: RecordId;
  sha256?: string;
  size_bytes?: number;
  mtime_ms?: number;
  head_hash?: string;
  raw_archive_path?: string;
}

export async function listLocations(
  db: Surreal,
  sourceRoot: RecordId,
): Promise<LocationRow[]> {
  return selectAll<LocationRow>(
    db,
    `SELECT id, relative_path, basename, presence_status, missing_complete_scans, renamed_from,
       current_revision.sha256 AS sha256,
       current_revision.size_bytes AS size_bytes,
       current_revision.mtime_ms AS mtime_ms,
       current_revision.head_hash AS head_hash,
       current_revision.raw_archive_path AS raw_archive_path
     FROM source_location WHERE source_root = $root`,
    { root: sourceRoot },
  );
}

export async function ensureSourceLocation(
  db: Surreal,
  input: { sourceRoot: RecordId; relativePath: string; originalPath: string; basename: string },
): Promise<{ id: RecordId; created: boolean }> {
  const now = new Date();
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM source_location WHERE source_root = $root AND relative_path = $rel LIMIT 1",
    { root: input.sourceRoot, rel: input.relativePath },
  );
  if (existing) return { id: existing.id, created: false };
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY source_location SET source_root = $root, relative_path = $rel,
       original_path = $orig, basename = $base, presence_status = "active",
       missing_complete_scans = 0, first_seen_at = $now, last_seen_at = $now`,
    {
      root: input.sourceRoot,
      rel: input.relativePath,
      orig: input.originalPath,
      base: input.basename,
      now,
    },
  );
  return { id: created!.id, created: true };
}

/** Обновление presence-состояния (deletion state machine, §10.6). */
export async function updateLocationPresence(
  db: Surreal,
  id: RecordId,
  input: {
    presenceStatus: string;
    missingCompleteScans: number;
    seen: boolean;
    missingSinceAt?: Date;
    deletedAt?: Date;
  },
): Promise<void> {
  const now = new Date();
  if (input.seen) {
    // Файл присутствует: сброс отсутствия (missing_since_at/deleted_at → NONE).
    await db.query(
      `UPDATE $id SET presence_status = $status, missing_complete_scans = $scans,
         last_seen_at = $now, missing_since_at = NONE, deleted_at = NONE`,
      { id, status: input.presenceStatus, scans: input.missingCompleteScans, now },
    );
    return;
  }
  // Отсутствует: меняем только переданные поля (missing_since_at/deleted_at
  // не затираем, если перехода состояния не было).
  const sets = ["presence_status = $status", "missing_complete_scans = $scans"];
  const vars: Record<string, unknown> = {
    id,
    status: input.presenceStatus,
    scans: input.missingCompleteScans,
  };
  if (input.missingSinceAt) {
    sets.push("missing_since_at = $missingSince");
    vars.missingSince = input.missingSinceAt;
  }
  if (input.deletedAt) {
    sets.push("deleted_at = $deletedAt");
    vars.deletedAt = input.deletedAt;
  }
  await db.query(`UPDATE $id SET ${sets.join(", ")}`, vars);
}

export async function setLocationRenamedFrom(
  db: Surreal,
  id: RecordId,
  renamedFrom: RecordId,
): Promise<void> {
  await db.query("UPDATE $id SET renamed_from = $from", { id, from: renamedFrom });
}

/** current_revision — последняя увиденная; last_successful — последняя распарсенная. */
export async function setLocationRevisions(
  db: Surreal,
  id: RecordId,
  input: { currentRevision: RecordId; lastSuccessfulRevision?: RecordId },
): Promise<void> {
  if (input.lastSuccessfulRevision) {
    await db.query(
      "UPDATE $id SET current_revision = $cur, last_successful_revision = $ok, last_seen_at = $now",
      { id, cur: input.currentRevision, ok: input.lastSuccessfulRevision, now: new Date() },
    );
    return;
  }
  await db.query("UPDATE $id SET current_revision = $cur, last_seen_at = $now", {
    id,
    cur: input.currentRevision,
    now: new Date(),
  });
}

export interface SourceRevisionInput {
  sourceLocation: RecordId;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  headHash?: string;
  rawArchivePath: string;
  snapshotKind: string;
  parserName: string;
  parserVersion: number;
  syncRun: RecordId;
}

/** Upsert по (source_location, sha256): повторный sync не создаёт дублей. */
export async function ensureSourceRevision(
  db: Surreal,
  input: SourceRevisionInput,
): Promise<{ id: RecordId; created: boolean; parseStatus?: string }> {
  const existing = await selectOne<{ id: RecordId; parse_status: string }>(
    db,
    "SELECT id, parse_status FROM source_revision WHERE source_location = $loc AND sha256 = $sha LIMIT 1",
    { loc: input.sourceLocation, sha: input.sha256 },
  );
  if (existing) return { id: existing.id, created: false, parseStatus: existing.parse_status };
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY source_revision SET source_location = $loc, sha256 = $sha, size_bytes = $size,
       mtime_ms = $mtime, head_hash = $head, raw_archive_path = $raw, snapshot_kind = $snapKind,
       captured_at = $now, parser_name = $parser, parser_version = $parserVersion,
       parse_status = "pending", sync_run = $run`,
    {
      loc: input.sourceLocation,
      sha: input.sha256,
      size: input.sizeBytes,
      mtime: Math.round(input.mtimeMs),
      head: input.headHash ?? undefined,
      raw: input.rawArchivePath,
      snapKind: input.snapshotKind,
      now: new Date(),
      parser: input.parserName,
      parserVersion: String(input.parserVersion),
      run: input.syncRun,
    },
  );
  return { id: created!.id, created: true };
}

export async function updateSourceRevisionParse(
  db: Surreal,
  id: RecordId,
  input: { parseStatus: string; dialoguesDiscovered?: number; canonicalHash?: string },
): Promise<void> {
  await db.query(
    "UPDATE $id SET parse_status = $status, dialogues_discovered = $dialogues, canonical_hash = $hash",
    {
      id,
      status: input.parseStatus,
      dialogues: input.dialoguesDiscovered ?? undefined,
      hash: input.canonicalHash ?? undefined,
    },
  );
}

export interface IngestErrorInput {
  syncRun: RecordId;
  sourceRevision?: RecordId;
  sourceRecordKey?: string;
  stage: string;
  errorCode: string;
  errorMessage: string;
  rawPayload?: unknown;
  parserVersion?: number;
}

export async function createIngestError(
  db: Surreal,
  input: IngestErrorInput,
): Promise<RecordId> {
  const now = new Date();
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY ingest_error SET sync_run = $run, source_revision = $rev,
       source_record_key = $recordKey, stage = $stage, error_code = $code,
       error_message = $message, raw_payload = $payload, parser_version = $parserVersion,
       first_failed_at = $now, last_failed_at = $now`,
    {
      run: input.syncRun,
      rev: input.sourceRevision ?? undefined,
      recordKey: input.sourceRecordKey ?? undefined,
      stage: input.stage,
      code: input.errorCode,
      message: input.errorMessage.slice(0, 4000),
      payload: input.rawPayload !== undefined ? clean(input.rawPayload) : undefined,
      parserVersion: input.parserVersion !== undefined ? String(input.parserVersion) : undefined,
      now,
    },
  );
  return created!.id;
}

/** Активные embedding spaces (jobs создаются только под них, §13.5). */
export async function listActiveEmbeddingSpaces(db: Surreal): Promise<Array<{ id: RecordId; slug: string }>> {
  return selectAll<{ id: RecordId; slug: string }>(
    db,
    "SELECT id, slug FROM embedding_space WHERE active = true",
  );
}
