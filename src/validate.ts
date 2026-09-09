/**
 * `baka validate` (docs/plan.md §17.3) — полная проверка инвариантов (§23).
 *
 * Проверки намеренно read-only. Физические embedding-таблицы обходятся
 * постранично: они создаются динамически в space:create и не перечислены в
 * schema migrations. Doctor переиспользует `runValidationWithDb`, чтобы не
 * открывать второе соединение и не расходиться с CLI validate.
 */

import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "./config.ts";
import { connectDb } from "./db/client.ts";
import { checkSchemaVersion, listMigrations } from "./db/migrations.ts";
import { selectAll } from "./db/repositories/helpers.ts";
import { listSpaces } from "./embeddings/spaces.ts";
import { hashFile } from "./sources/snapshot/hashing.ts";
import {
  inspectMigrationQuarantineLifecycle,
  type MigrationQuarantineLifecycle,
} from "./migration/exclusions.ts";

export interface ValidationIssue {
  check: string;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  /** Verified informational state; documented exclusions are not failures. */
  migrationQuarantine?: Omit<MigrationQuarantineLifecycle, "issues">;
}

const SAFE_TABLE_NAME = /^[a-zA-Z0-9_]+$/;
const DEFAULT_VECTOR_PAGE_SIZE = 250;

export class UnsafeArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchivePathError";
  }
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve a DB raw path to an existing regular, non-symlink file in archiveRoot. */
export async function resolveArchiveRegularFile(
  archiveRoot: string,
  rawArchivePath: string,
): Promise<string> {
  if (!rawArchivePath || path.isAbsolute(rawArchivePath)) {
    throw new UnsafeArchivePathError("raw_archive_path должен быть непустым относительным путём");
  }
  const lexicalRoot = path.resolve(archiveRoot);
  const lexicalFile = path.resolve(lexicalRoot, rawArchivePath);
  if (!containedBy(lexicalRoot, lexicalFile)) {
    throw new UnsafeArchivePathError("raw_archive_path выходит за archiveRoot");
  }
  const info = await lstat(lexicalFile);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new UnsafeArchivePathError("raw snapshot должен быть обычным не-symlink файлом");
  }
  const [realRoot, realFile] = await Promise.all([realpath(lexicalRoot), realpath(lexicalFile)]);
  if (!containedBy(realRoot, realFile)) {
    throw new UnsafeArchivePathError("realpath raw snapshot выходит за archiveRoot");
  }
  const realInfo = await lstat(realFile);
  if (realInfo.isSymbolicLink() || !realInfo.isFile()) {
    throw new UnsafeArchivePathError("realpath raw snapshot не является обычным файлом");
  }
  return realFile;
}

/** Рекурсивный список обычных raw-файлов; symlink'и не разыменовываются. */
export async function listRawFiles(rawDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const rootInfo = await lstat(rawDir);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return out;
  } catch {
    return out;
  }
  const realRoot = await realpath(rawDir);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith("._")) continue;
      const full = path.join(directory, entry.name);
      const info = await lstat(full).catch(() => undefined);
      if (!info || info.isSymbolicLink()) continue;
      const resolved = await realpath(full).catch(() => undefined);
      if (!resolved || !containedBy(realRoot, resolved)) continue;
      if (info.isDirectory()) {
        await walk(full);
      } else if (info.isFile()) {
        out.push(resolved);
      }
    }
  };
  await walk(path.resolve(rawDir));
  return out.sort();
}

interface EmbeddingJobAuditRow {
  id: unknown;
  search_document: unknown;
  embedding_space: unknown;
  input_sha256: string;
  status: string;
}

interface EmbeddingVectorAuditRow {
  id: unknown;
  search_document: unknown;
  embedding_space: unknown;
  input_sha256: string;
  vector: number[];
}

function embeddingPair(document: unknown, space: unknown): string {
  return `${String(document)}\u0000${String(space)}`;
}

/**
 * §17.3 / §23.11–13: dimension, completed job ↔ vector в обе стороны.
 * Экспортировано как узкий test seam для synthetic Surreal mock.
 */
export async function validateEmbeddingState(
  db: Surreal,
  options: { pageSize?: number } = {},
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const pageSize = options.pageSize ?? DEFAULT_VECTOR_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error("validation vector pageSize должен быть 1..1000");
  }

  // Один снимок job-состояния нужен для симметричной проверки. UNIQUE
  // (search_document, embedding_space) не даёт двум jobs скрыть друг друга.
  const jobs = await selectAll<EmbeddingJobAuditRow>(
    db,
    "SELECT id, search_document, embedding_space, input_sha256, status FROM embedding_job",
  );
  const completedByPair = new Map<string, EmbeddingJobAuditRow>();
  for (const job of jobs) {
    if (job.status === "completed") {
      completedByPair.set(embeddingPair(job.search_document, job.embedding_space), job);
    }
  }

  const documents = new Map(
    (
      await selectAll<{ id: unknown; content_sha256: string }>(
        db,
        "SELECT id, content_sha256 FROM search_document",
      )
    ).map((row) => [String(row.id), row.content_sha256]),
  );
  const spaces = await listSpaces(db);
  const spaceIds = new Set(spaces.map((space) => String(space.id)));
  for (const job of jobs) {
    const documentHash = documents.get(String(job.search_document));
    if (documentHash === undefined) {
      issues.push({
        check: "embedding_job_document_missing",
        detail: `${String(job.id)}: search_document ${String(job.search_document)} отсутствует`,
      });
    } else if (job.input_sha256 !== documentHash) {
      issues.push({
        check: "embedding_job_input_hash_mismatch",
        detail: `${String(job.id)}: job ${job.input_sha256}, search_document ${documentHash}`,
      });
    }
    if (!spaceIds.has(String(job.embedding_space))) {
      issues.push({
        check: "embedding_job_space_missing",
        detail: `${String(job.id)}: embedding_space ${String(job.embedding_space)} отсутствует`,
      });
    }
  }
  const spacesByTable = new Map<string, typeof spaces>();
  for (const space of spaces) {
    spacesByTable.set(space.physical_table, [
      ...(spacesByTable.get(space.physical_table) ?? []),
      space,
    ]);
  }
  for (const [table, owners] of spacesByTable) {
    if (owners.length > 1) {
      issues.push({
        check: "embedding_physical_table_shared",
        detail: `${table}: spaces ${owners.map((space) => space.slug).join(", ")}`,
      });
    }
  }

  const vectorsByPair = new Set<string>();
  for (const space of spaces) {
    if (!SAFE_TABLE_NAME.test(space.physical_table)) {
      issues.push({
        check: "invalid_embedding_table_name",
        detail: `${space.slug}: небезопасное physical_table ${JSON.stringify(space.physical_table)}`,
      });
      continue;
    }
    let start = 0;
    try {
      for (;;) {
        const rows = await selectAll<EmbeddingVectorAuditRow>(
          db,
          `SELECT id, search_document, embedding_space, input_sha256, vector
           FROM ${space.physical_table} ORDER BY id LIMIT $limit START $start`,
          { limit: pageSize, start },
        );
        for (const row of rows) {
          const actual = Array.isArray(row.vector) ? row.vector.length : -1;
          if (actual !== space.dimensions) {
            issues.push({
              check: "embedding_dimension_mismatch",
              detail: `${String(row.id)} (space ${space.slug}): ожидалось ${space.dimensions}, получено ${actual}`,
            });
          }
          const owningPair = embeddingPair(row.search_document, space.id);
          const completedJob = completedByPair.get(owningPair);
          if (!sameRecordId(row.embedding_space, space.id)) {
            issues.push({
              check: "embedding_vector_space_mismatch",
              detail: `${String(row.id)} в ${space.physical_table}: записано ${String(row.embedding_space)}, owning space ${String(space.id)}`,
            });
          } else {
            // Только корректно принадлежащий owning table vector закрывает
            // симметричную completed-job проверку.
            vectorsByPair.add(owningPair);
          }
          if (!completedJob) {
            issues.push({
              check: "embedding_vector_without_completed_job",
              detail: `${String(row.id)} (document ${String(row.search_document)}, owning space ${String(space.id)})`,
            });
          } else if (row.input_sha256 !== completedJob.input_sha256) {
            issues.push({
              check: "embedding_vector_input_hash_mismatch",
              detail: `${String(row.id)}: vector ${row.input_sha256}, completed job ${completedJob.input_sha256}`,
            });
          }
          const documentHash = documents.get(String(row.search_document));
          if (documentHash === undefined) {
            issues.push({
              check: "embedding_vector_document_missing",
              detail: `${String(row.id)}: search_document ${String(row.search_document)} отсутствует`,
            });
          } else if (row.input_sha256 !== documentHash) {
            issues.push({
              check: "embedding_vector_input_hash_mismatch",
              detail: `${String(row.id)}: vector ${row.input_sha256}, search_document ${documentHash}`,
            });
          }
        }
        if (rows.length < pageSize) break;
        start += rows.length;
      }
    } catch (error) {
      // Повреждённая/отсутствующая dynamic table не должна скрыть проверки
      // остальных spaces. Completed jobs этого space ниже всё равно будут
      // отмечены как не имеющие vector.
      issues.push({
        check: "embedding_table_unavailable",
        detail: `${space.slug} (${space.physical_table}): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const [pair, job] of completedByPair) {
    if (!vectorsByPair.has(pair)) {
      issues.push({
        check: "completed_embedding_job_without_vector",
        detail: `${String(job.id)} (document ${String(job.search_document)}, space ${String(job.embedding_space)})`,
      });
    }
  }
  return issues;
}

function sameRecordId(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}

interface DialogueOwnershipRow {
  id: unknown;
  identity_key: string;
  current_revision?: unknown;
}

interface DialogueRevisionOwnershipRow {
  id: unknown;
  dialogue?: unknown;
  source_revision?: unknown;
  status: string;
}

interface SourceLocationOwnershipRow {
  id: unknown;
  relative_path: string;
  current_revision?: unknown;
  last_successful_revision?: unknown;
}

interface SourceRevisionOwnershipRow {
  id: unknown;
  source_location?: unknown;
  parse_status: string;
}

interface MessageOwnershipRow {
  id: unknown;
  dialogue?: unknown;
  dialogue_revision?: unknown;
}

interface ChunkOwnershipRow extends MessageOwnershipRow {
  message?: unknown;
}

interface SearchOwnershipRow extends MessageOwnershipRow {
  message?: unknown;
  source_chunks?: unknown[];
}

function indexRows<T extends { id: unknown }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

/** Full dangling/cross-owner audit of canonical, provenance and search records. */
export async function validateRelationalState(db: Surreal): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const [dialogueRows, revisionRows, locationRows, sourceRevisionRows, messageRows, chunkRows, searchRows] =
    await Promise.all([
      selectAll<DialogueOwnershipRow>(db, "SELECT id, identity_key, current_revision FROM dialogue"),
      selectAll<DialogueRevisionOwnershipRow>(
        db,
        "SELECT id, dialogue, source_revision, status FROM dialogue_revision",
      ),
      selectAll<SourceLocationOwnershipRow>(
        db,
        "SELECT id, relative_path, current_revision, last_successful_revision FROM source_location",
      ),
      selectAll<SourceRevisionOwnershipRow>(
        db,
        "SELECT id, source_location, parse_status FROM source_revision",
      ),
      selectAll<MessageOwnershipRow>(db, "SELECT id, dialogue, dialogue_revision FROM message"),
      selectAll<ChunkOwnershipRow>(
        db,
        "SELECT id, dialogue, dialogue_revision, message FROM chunk",
      ),
      selectAll<SearchOwnershipRow>(
        db,
        "SELECT id, dialogue, dialogue_revision, message, source_chunks FROM search_document",
      ),
    ]);
  const dialogues = indexRows(dialogueRows);
  const revisions = indexRows(revisionRows);
  const locations = indexRows(locationRows);
  const sourceRevisions = indexRows(sourceRevisionRows);
  const messages = indexRows(messageRows);
  const chunks = indexRows(chunkRows);

  for (const dialogue of dialogueRows) {
    if (dialogue.current_revision === undefined || dialogue.current_revision === null) {
      issues.push({ check: "dialogue_without_current", detail: dialogue.identity_key });
      continue;
    }
    const revision = revisions.get(String(dialogue.current_revision));
    if (!revision) {
      issues.push({
        check: "current_revision_missing",
        detail: `${String(dialogue.id)} → ${String(dialogue.current_revision)}`,
      });
    } else if (!sameRecordId(revision.dialogue, dialogue.id)) {
      issues.push({
        check: "current_revision_cross_dialogue",
        detail: `${String(dialogue.id)} → ${String(revision.id)} (owner ${String(revision.dialogue)})`,
      });
    } else if (revision.status !== "ready") {
      issues.push({
        check: "current_revision_not_ready",
        detail: `${String(dialogue.id)} (status: ${revision.status})`,
      });
    }
  }

  for (const revision of revisionRows) {
    if (revision.dialogue === undefined || !dialogues.has(String(revision.dialogue))) {
      issues.push({
        check: "dialogue_revision_dialogue_missing",
        detail: `${String(revision.id)} → ${String(revision.dialogue)}`,
      });
    }
    if (
      revision.source_revision !== undefined &&
      revision.source_revision !== null &&
      !sourceRevisions.has(String(revision.source_revision))
    ) {
      issues.push({
        check: "dialogue_revision_source_missing",
        detail: `${String(revision.id)} → ${String(revision.source_revision)}`,
      });
    }
  }

  for (const sourceRevision of sourceRevisionRows) {
    if (
      sourceRevision.source_location === undefined ||
      !locations.has(String(sourceRevision.source_location))
    ) {
      issues.push({
        check: "source_revision_location_missing",
        detail: `${String(sourceRevision.id)} → ${String(sourceRevision.source_location)}`,
      });
    }
  }

  for (const location of locationRows) {
    if (location.current_revision !== undefined && location.current_revision !== null) {
      const current = sourceRevisions.get(String(location.current_revision));
      if (!current) {
        issues.push({
          check: "source_location_current_missing",
          detail: `${String(location.id)} → ${String(location.current_revision)}`,
        });
      } else if (!sameRecordId(current.source_location, location.id)) {
        issues.push({
          check: "source_location_current_cross_owner",
          detail: `${String(location.id)} → ${String(current.id)} (owner ${String(current.source_location)})`,
        });
      }
    }
    if (location.last_successful_revision !== undefined && location.last_successful_revision !== null) {
      const successful = sourceRevisions.get(String(location.last_successful_revision));
      if (!successful) {
        issues.push({
          check: "last_successful_revision_missing",
          detail: `${String(location.id)} → ${String(location.last_successful_revision)}`,
        });
      } else if (!sameRecordId(successful.source_location, location.id)) {
        issues.push({
          check: "last_successful_revision_cross_owner",
          detail: `${String(location.id)} → ${String(successful.id)} (owner ${String(successful.source_location)})`,
        });
      } else if (successful.parse_status !== "parsed") {
        issues.push({
          check: "last_successful_not_parsed",
          detail: `${location.relative_path} (parse_status: ${successful.parse_status})`,
        });
      }
    }
  }

  for (const message of messageRows) {
    const dialogue = message.dialogue === undefined ? undefined : dialogues.get(String(message.dialogue));
    const revision = message.dialogue_revision === undefined
      ? undefined
      : revisions.get(String(message.dialogue_revision));
    if (!dialogue) {
      issues.push({ check: "message_dialogue_missing", detail: String(message.id) });
    }
    if (!revision) {
      issues.push({ check: "message_revision_missing", detail: String(message.id) });
    } else if (!sameRecordId(revision.dialogue, message.dialogue)) {
      issues.push({ check: "message_cross_dialogue", detail: String(message.id) });
    }
  }

  for (const chunk of chunkRows) {
    const message = chunk.message === undefined ? undefined : messages.get(String(chunk.message));
    const revision = chunk.dialogue_revision === undefined
      ? undefined
      : revisions.get(String(chunk.dialogue_revision));
    if (chunk.dialogue === undefined || !dialogues.has(String(chunk.dialogue))) {
      issues.push({ check: "chunk_dialogue_missing", detail: String(chunk.id) });
    }
    if (!revision) issues.push({ check: "chunk_revision_missing", detail: String(chunk.id) });
    if (!message) {
      issues.push({ check: "chunk_message_missing", detail: String(chunk.id) });
    } else if (
      !sameRecordId(message.dialogue, chunk.dialogue) ||
      !sameRecordId(message.dialogue_revision, chunk.dialogue_revision) ||
      !sameRecordId(revision?.dialogue, chunk.dialogue)
    ) {
      issues.push({ check: "chunk_cross_dialogue", detail: String(chunk.id) });
    }
  }

  for (const document of searchRows) {
    const revision = document.dialogue_revision === undefined
      ? undefined
      : revisions.get(String(document.dialogue_revision));
    const dialogue = document.dialogue === undefined
      ? undefined
      : dialogues.get(String(document.dialogue));
    let invalid = !dialogue || !revision || !sameRecordId(revision.dialogue, document.dialogue);
    if (document.message !== undefined && document.message !== null) {
      const message = messages.get(String(document.message));
      invalid ||= !message ||
        !sameRecordId(message.dialogue, document.dialogue) ||
        !sameRecordId(message.dialogue_revision, document.dialogue_revision);
    }
    for (const sourceChunk of document.source_chunks ?? []) {
      const chunk = chunks.get(String(sourceChunk));
      invalid ||= !chunk ||
        !sameRecordId(chunk.dialogue, document.dialogue) ||
        !sameRecordId(chunk.dialogue_revision, document.dialogue_revision);
      // `message` — anchor исходного search document, а source_chunks
      // покрывают весь extracted document и для assistant_final могут
      // намеренно принадлежать нескольким сообщениям одной revision.
    }
    if (invalid) {
      issues.push({ check: "search_document_cross_owner", detail: String(document.id) });
      continue;
    }
    if (!sameRecordId(dialogue!.current_revision, document.dialogue_revision)) {
      issues.push({
        check: "search_document_not_current",
        detail: `${String(document.id)} (dialogue ${String(document.dialogue)})`,
      });
    }
  }
  return issues;
}

/** Незакрытые migration ingest_error — авторитетный quarantine (§7.2/§15.9). */
export async function validateMigrationQuarantine(
  db: Surreal,
  options: {
    includeDedicatedTable?: boolean;
    archiveRoot?: string;
    lifecycle?: MigrationQuarantineLifecycle;
  } = {},
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  // Не запрашиваем dedicated table, если вызывающая диагностика уже
  // обнаружила неподдерживаемую схему.
  if (options.includeDedicatedTable ?? true) {
    const lifecycle = options.lifecycle ?? await inspectMigrationQuarantineLifecycle(db, {
      ...(options.archiveRoot ? { archiveRoot: options.archiveRoot } : {}),
    });
    issues.push(...lifecycle.issues);
  }
  const legacyIngestErrors = await selectAll<{
    id: unknown;
    source_record_key?: string;
    error_code: string;
  }>(
    db,
    `SELECT id, source_record_key, error_code FROM ingest_error
     WHERE stage = "migration" AND resolved_at IS NONE`,
  );
  for (const row of legacyIngestErrors) {
    issues.push({
      check: "unresolved_migration_quarantine",
      detail: `${String(row.id)}${row.source_record_key ? ` (${row.source_record_key})` : ""}: ${row.error_code}`,
    });
  }
  return issues;
}

/** Полная validate-проверка поверх уже открытого соединения (doctor/test seam). */
export async function runValidationWithDb(
  db: Surreal,
  cfg: Pick<AppConfig, "archiveRoot">,
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];

  // unknown schema version
  const schemaVersion = await checkSchemaVersion(db);
  const maxKnown = Math.max(0, ...(await listMigrations()).map((m) => m.version));
  if (schemaVersion > maxKnown) {
    issues.push({
      check: "unknown_schema_version",
      detail: `в БД версия ${schemaVersion}, код знает до ${maxKnown}`,
    });
  }

  // source_revision ↔ raw file (существование + hash)
  const revisions = await selectAll<{
    id: unknown;
    sha256: string;
    raw_archive_path?: string;
    snapshot_kind: string;
  }>(db, "SELECT id, sha256, raw_archive_path, snapshot_kind FROM source_revision");
  const referencedRaw = new Set<string>();
  for (const rev of revisions) {
    if (!rev.raw_archive_path) {
      if (rev.snapshot_kind !== "legacy_missing_raw") {
        issues.push({
          check: "source_revision_without_raw",
          detail: `${String(rev.id)} (snapshot_kind: ${rev.snapshot_kind})`,
        });
      }
      continue;
    }
    try {
      const absolute = await resolveArchiveRegularFile(cfg.archiveRoot, rev.raw_archive_path);
      referencedRaw.add(absolute);
      const hashes = await hashFile(absolute);
      if (hashes.sha256 !== rev.sha256) {
        issues.push({
          check: "hash_mismatch",
          detail: `${rev.raw_archive_path}: в БД ${rev.sha256.slice(0, 12)}…, на диске ${hashes.sha256.slice(0, 12)}…`,
        });
      }
    } catch (error) {
      issues.push({
        check: error instanceof UnsafeArchivePathError ? "unsafe_raw_file" : "missing_raw_file",
        detail: `${rev.raw_archive_path} (source_revision ${String(rev.id)})`,
      });
    }
  }

  // orphan raw files (сценарий §19.2 №12 — detect-граница doctor'а)
  for (const file of await listRawFiles(path.join(cfg.archiveRoot, "raw"))) {
    if (!referencedRaw.has(file)) {
      issues.push({
        check: "orphan_raw_file",
        detail: path.relative(cfg.archiveRoot, file),
      });
    }
  }

  issues.push(...(await validateRelationalState(db)));

  // duplicate identity keys (unique index не даёт, но проверка обязательна)
  for (const row of await selectAll<{ identity_key: string; n: number }>(
    db,
    "SELECT identity_key, count() AS n FROM dialogue GROUP BY identity_key",
  )) {
    if (row.n > 1) {
      issues.push({ check: "duplicate_identity_key", detail: `${row.identity_key} ×${row.n}` });
    }
  }

  // message sequence collisions
  for (const row of await selectAll<{ dialogue_revision: unknown; sequence: number; n: number }>(
    db,
    "SELECT dialogue_revision, sequence, count() AS n FROM message GROUP BY dialogue_revision, sequence",
  )) {
    if (row.n > 1) {
      issues.push({
        check: "message_sequence_collision",
        detail: `${String(row.dialogue_revision)} seq ${row.sequence} ×${row.n}`,
      });
    }
  }

  // chunk sequence collisions
  for (const row of await selectAll<{ message: unknown; sequence: number; n: number }>(
    db,
    "SELECT message, sequence, count() AS n FROM chunk GROUP BY message, sequence",
  )) {
    if (row.n > 1) {
      issues.push({
        check: "chunk_sequence_collision",
        detail: `${String(row.message)} seq ${row.sequence} ×${row.n}`,
      });
    }
  }

  issues.push(...(await validateEmbeddingState(db)));
  const migrationQuarantine = schemaVersion === 1
    ? await inspectMigrationQuarantineLifecycle(db, { archiveRoot: cfg.archiveRoot })
    : undefined;
  issues.push(
    ...(await validateMigrationQuarantine(db, {
      includeDedicatedTable: schemaVersion === 1,
      archiveRoot: cfg.archiveRoot,
      ...(migrationQuarantine ? { lifecycle: migrationQuarantine } : {}),
    })),
  );
  const migrationQuarantineSummary = migrationQuarantine
    ? (({ issues: _issues, ...summary }) => summary)(migrationQuarantine)
    : undefined;
  return {
    ok: issues.length === 0,
    issues,
    ...(migrationQuarantineSummary ? { migrationQuarantine: migrationQuarantineSummary } : {}),
  };
}

export async function runValidation(cfg: AppConfig): Promise<ValidationReport> {
  const db = await connectDb(cfg);
  try {
    return await runValidationWithDb(db, cfg);
  } finally {
    await db.close();
  }
}
