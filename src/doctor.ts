/**
 * `baka doctor` (docs/plan.md §17.4).
 *
 * Без опций API только инспектирует. Даже выбранное исправление остаётся
 * dry-run, пока вызывающий код явно не передаст `dryRun: false`; публичный
 * runDoctor сам держит process lock на всём apply. Удаление/перезапись/rebuild
 * требуют ещё `allowDestructive: true`.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { RecordId, Surreal } from "surrealdb";
import type { AppConfig } from "./config.ts";
import {
  buildRawManifest,
  hashRawManifest,
  type RawManifest,
} from "./backup/raw-verify.ts";
import { connectDb } from "./db/client.ts";
import { checkSchemaVersion, gitHead } from "./db/migrations.ts";
import {
  createSyncRun,
  ensureSourceRevision,
  finishSyncRun,
  isDocumentedUnsupportedErrorCode,
} from "./db/repositories/provenance.ts";
import { selectAll } from "./db/repositories/helpers.ts";
import { LEASE_TIMEOUT_MS, releaseStaleLeases } from "./embeddings/jobs.ts";
import { acquireLock } from "./infra/lock.ts";
import {
  rebuildSearchProjection as rebuildProjection,
  type RebuildSummary,
} from "./search/rebuild.ts";
import { isSqlitePath } from "./sources/adapters/file-matchers.ts";
import type { HarnessSlug } from "./sources/adapters/harnesses.ts";
import { hashFile } from "./sources/snapshot/hashing.ts";
import { rawFileName } from "./sources/snapshot/naming.ts";
import { findStagingOrphans, sha256FromRawName } from "./sources/snapshot/orphans.ts";
import { HARNESS_TOOLS } from "./sync/harness-tools.ts";
import {
  listRawFiles,
  resolveArchiveRegularFile,
  runValidationWithDb,
  type ValidationReport,
} from "./validate.ts";

export type DoctorActionName =
  | "import-orphan-raw"
  | "remove-stale-staging"
  | "requeue-stuck-embeddings"
  | "rebuild-search-projection"
  | "recalculate-primary-models"
  | "repair-manifest";

export interface DoctorFinding {
  check: string;
  detail: string;
  repair?: DoctorActionName;
  repairable: boolean;
}

export interface DoctorActionResult {
  action: DoctorActionName;
  status: "planned" | "applied" | "skipped";
  affected: number;
  details: string[];
}

export interface DoctorRebuildOptions {
  host: RecordId;
  schemaVersion: number;
  enqueueEmbeddings: boolean;
  logger?: (event: Record<string, unknown>) => void;
}

export interface DoctorOptions {
  /** true по умолчанию; `false` должен передаваться явно. */
  dryRun?: boolean;
  /** @deprecated Never authorizes mutation; retained only for fail-closed compatibility. */
  exclusiveLockHeld?: boolean;
  /** Отдельный gate для rm/rebuild/overwrite. */
  allowDestructive?: boolean;
  /** Не считать staging текущего run устаревшим (обычно doctor работает под lock). */
  currentRunId?: string;
  now?: Date;
  manifestPath?: string;
  rebuildOptions?: DoctorRebuildOptions;

  importOrphanRaw?: boolean;
  removeStaleStaging?: boolean;
  requeueStuckEmbeddings?: boolean;
  rebuildSearchProjection?: boolean;
  recalculatePrimaryModels?: boolean;
  repairManifest?: boolean;
  /** Privacy-safe operational events; never receives paths or error text. */
  logger?: (event: Record<string, unknown>) => void;
}

export interface DoctorReport {
  ok: boolean;
  dryRun: boolean;
  validation: ValidationReport;
  findings: DoctorFinding[];
  actions: DoctorActionResult[];
  /** Состояния, где автоматическое исправление намеренно запрещено. */
  manual: string[];
}

export interface DoctorDependencies {
  validate?: typeof runValidationWithDb;
  rebuild?: typeof rebuildProjection;
  connect?: typeof connectDb;
}

export type UnresolvedIngestErrorClassification =
  | "documented_unsupported"
  | "actionable_current_failure"
  | "historical_revision_failure"
  | "attributed_snapshot_failure"
  | "unattributed_snapshot_failure"
  | "unattributed_failure";

export interface UnresolvedIngestErrorAssessment {
  id: RecordId;
  errorCode: string;
  classification: UnresolvedIngestErrorClassification;
  currentRevision: boolean;
  revisionParseStatus?: string;
}

interface UnresolvedIngestErrorRow {
  id: RecordId;
  source_revision?: RecordId;
  source_record_key?: string;
  stage: string;
  error_code: string;
  revision_parse_status?: string;
  location_current_revision?: RecordId;
}

/**
 * Classifies unresolved rows without parsing private error text. In
 * particular, an old snapshot_exception without a durable record key is not
 * guessed from error_message and remains manual/unresolved.
 */
export async function inspectUnresolvedIngestErrors(
  db: Surreal,
): Promise<UnresolvedIngestErrorAssessment[]> {
  const rows = await selectAll<UnresolvedIngestErrorRow>(
    db,
    `SELECT id, source_revision, source_record_key, stage, error_code,
       source_revision.parse_status AS revision_parse_status,
       source_revision.source_location.current_revision AS location_current_revision
     FROM ingest_error WHERE resolved_at IS NONE ORDER BY id ASC`,
  );
  return rows.map((row) => {
    const currentRevision = row.source_revision !== undefined &&
      sameRecord(row.source_revision, row.location_current_revision);
    let classification: UnresolvedIngestErrorClassification = "unattributed_failure";
    // parse_status="parsed" alone is not proof: a later failed reparse keeps
    // the last-known-good status/pointers. Only the successful call site may
    // resolve its predecessors; doctor treats every leftover as active.
    if (
      row.source_revision !== undefined && row.stage === "parse" &&
      row.revision_parse_status === "unsupported" &&
      isDocumentedUnsupportedErrorCode(row.error_code)
    ) {
      classification = "documented_unsupported";
    } else if (row.stage === "snapshot" && !row.source_revision) {
      classification = row.source_record_key?.startsWith("source_location:") === true
        ? "attributed_snapshot_failure"
        : "unattributed_snapshot_failure";
    } else if (row.source_revision) {
      classification = currentRevision
        ? "actionable_current_failure"
        : "historical_revision_failure";
    }
    return {
      id: row.id,
      errorCode: row.error_code,
      classification,
      currentRevision,
      revisionParseStatus: row.revision_parse_status,
    };
  });
}

interface SourceLocationCandidate {
  id: RecordId;
  source_root: RecordId;
  original_path: string;
  basename: string;
  harness: string;
  parser_name: string;
  host: RecordId;
}

export interface OrphanRawProvenance {
  sourceLocation: RecordId;
  host: RecordId;
  parserName: string;
  parserVersion: number;
  originalPath: string;
  mtimeMs: number;
  headHash: string;
  sizeBytes: number;
}

export interface OrphanRawAssessment {
  path: string;
  sha256?: string;
  repairable: boolean;
  reason: string;
  provenance?: OrphanRawProvenance;
}

function isHarnessSlug(value: string): value is HarnessSlug {
  return Object.hasOwn(HARNESS_TOOLS, value);
}

function sameRecord(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null) {
    return a === b;
  }
  return String(a) === String(b);
}

/**
 * Detect/repair boundary сценария §19.2 №12.
 *
 * Raw импортируется автоматически только если он обычный (не SQLite), hash
 * имени совпадает с полным hash файла, имя однозначно выводится из basename
 * source_location, а текущий исходник всё ещё имеет тот же hash. Это не
 * угадывает provenance по одному basename и не записывает сомнительные raw.
 */
export async function inspectOrphanRawFiles(
  db: Surreal,
  archiveRoot: string,
): Promise<OrphanRawAssessment[]> {
  const referenced = new Set<string>();
  for (const row of await selectAll<{ raw_archive_path?: string }>(
    db,
    "SELECT raw_archive_path FROM source_revision WHERE raw_archive_path IS NOT NONE",
  )) {
    if (!row.raw_archive_path) continue;
    const resolved = await resolveArchiveRegularFile(archiveRoot, row.raw_archive_path).catch(
      () => undefined,
    );
    if (resolved) referenced.add(resolved);
  }
  const archiveReal = await realpath(path.resolve(archiveRoot));
  const orphanPaths = (await listRawFiles(path.join(archiveRoot, "raw"))).filter(
    (file) => !referenced.has(file),
  );
  const locations = await selectAll<SourceLocationCandidate>(
    db,
    `SELECT id, source_root, original_path, basename,
       source_root.harness_installation.harness.slug AS harness,
       source_root.parser_name AS parser_name,
       source_root.harness_installation.host AS host
     FROM source_location`,
  );
  const sourceHashCache = new Map<
    string,
    { hashes: Awaited<ReturnType<typeof hashFile>>; mtimeMs: number } | Error
  >();

  const assessments: OrphanRawAssessment[] = [];
  for (const absolute of orphanPaths) {
    const relative = path.relative(archiveReal, absolute);
    const parts = relative.split(path.sep);
    if (parts.length !== 3 || parts[0] !== "raw") {
      assessments.push({
        path: relative,
        repairable: false,
        reason: "raw path не соответствует плоскому raw/<harness>/<file>",
      });
      continue;
    }
    const harness = parts[1]!;
    const basename = parts[2]!;
    if (!isHarnessSlug(harness)) {
      assessments.push({
        path: relative,
        repairable: false,
        reason: `неизвестный harness ${JSON.stringify(harness)}`,
      });
      continue;
    }
    const namedSha = sha256FromRawName(basename);
    if (!namedSha) {
      assessments.push({
        path: relative,
        repairable: false,
        reason: "имя не содержит полный SHA-256",
      });
      continue;
    }
    let rawHashes: Awaited<ReturnType<typeof hashFile>>;
    try {
      const safeRaw = await resolveArchiveRegularFile(archiveRoot, relative);
      rawHashes = await hashFile(safeRaw);
    } catch (error) {
      assessments.push({
        path: relative,
        sha256: namedSha,
        repairable: false,
        reason: `raw не читается: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (rawHashes.sha256 !== namedSha) {
      assessments.push({
        path: relative,
        sha256: namedSha,
        repairable: false,
        reason: `hash имени ${namedSha.slice(0, 12)}… не совпадает с файлом ${rawHashes.sha256.slice(0, 12)}…`,
      });
      continue;
    }

    const namedCandidates = locations.filter(
      (location) =>
        location.harness === harness && rawFileName(location.basename, namedSha) === basename,
    );
    const matching: Array<{ location: SourceLocationCandidate; mtimeMs: number }> = [];
    for (const location of namedCandidates) {
      // VACUUM INTO меняет физическое SQLite-представление: равенство raw и
      // live-файла там ничего не доказывает, auto-import запрещён.
      if (isSqlitePath(location.original_path)) continue;
      let sourceFingerprint = sourceHashCache.get(location.original_path);
      if (!sourceFingerprint) {
        try {
          const sourceInfo = await lstat(location.original_path);
          if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
            throw new Error("source не является обычным не-symlink файлом");
          }
          const realSource = await realpath(location.original_path);
          const before = await stat(realSource);
          const hashes = await hashFile(realSource);
          const after = await stat(realSource);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            throw new Error("source изменился во время проверки provenance");
          }
          sourceFingerprint = { hashes, mtimeMs: after.mtimeMs };
        } catch (error) {
          sourceFingerprint = error instanceof Error ? error : new Error(String(error));
        }
        sourceHashCache.set(location.original_path, sourceFingerprint);
      }
      if (
        sourceFingerprint instanceof Error ||
        sourceFingerprint.hashes.sha256 !== namedSha
      ) {
        continue;
      }
      matching.push({
        location,
        mtimeMs: sourceFingerprint.mtimeMs,
      });
    }
    if (matching.length !== 1) {
      const sqliteOnly =
        namedCandidates.length > 0 && namedCandidates.every((c) => isSqlitePath(c.original_path));
      assessments.push({
        path: relative,
        sha256: namedSha,
        repairable: false,
        reason: sqliteOnly
          ? "SQLite provenance нельзя восстановить сравнением файлов; требуется повторный sync/manual reconciliation"
          : matching.length > 1
            ? `provenance неоднозначен: ${matching.length} неизменившихся source_location`
            : "нет единственного неизменившегося source_location с тем же hash",
      });
      continue;
    }
    const { location, mtimeMs } = matching[0]!;
    const tools = HARNESS_TOOLS[harness];
    if (location.parser_name !== tools.parser.parserName) {
      assessments.push({
        path: relative,
        sha256: namedSha,
        repairable: false,
        reason: `parser provenance расходится: source_root=${location.parser_name}, code=${tools.parser.parserName}`,
      });
      continue;
    }
    const existing = await selectAll<{ id: unknown; raw_archive_path?: string }>(
      db,
      `SELECT id, raw_archive_path FROM source_revision
       WHERE source_location = $location AND sha256 = $sha`,
      { location: location.id, sha: namedSha },
    );
    if (existing.length > 0) {
      assessments.push({
        path: relative,
        sha256: namedSha,
        repairable: false,
        reason: `source_revision уже существует с другим raw path (${existing.map((r) => r.raw_archive_path ?? "NONE").join(", ")})`,
      });
      continue;
    }
    assessments.push({
      path: relative,
      sha256: namedSha,
      repairable: true,
      reason: "provenance однозначно подтверждён hash'ем неизменившегося source",
      provenance: {
        sourceLocation: location.id,
        host: location.host,
        parserName: location.parser_name,
        parserVersion: tools.parser.parserVersion,
        originalPath: location.original_path,
        mtimeMs,
        headHash: rawHashes.headHash,
        sizeBytes: rawHashes.sizeBytes,
      },
    });
  }
  return assessments;
}

interface StuckJobRow {
  id: unknown;
  locked_at?: Date;
  locked_by?: string;
}

export async function inspectStuckEmbeddingJobs(
  db: Surreal,
  now = new Date(),
): Promise<StuckJobRow[]> {
  const cutoff = new Date(now.getTime() - LEASE_TIMEOUT_MS);
  return selectAll<StuckJobRow>(
    db,
    `SELECT id, locked_at, locked_by FROM embedding_job
     WHERE status = "processing" AND (locked_at IS NONE OR locked_at < $cutoff)`,
    { cutoff },
  );
}

interface DialogueModelRow {
  id: RecordId;
  current_revision?: RecordId;
  primary_model?: RecordId;
}

export interface PrimaryModelRepair {
  dialogue: RecordId;
  current?: RecordId;
  expected?: RecordId;
}

/** Та же семантика, что primaryModelKey: frequency, tie → последняя sequence. */
export function choosePrimaryModel(
  messages: Array<{ model: RecordId; sequence: number }>,
): RecordId | undefined {
  const counts = new Map<string, { model: RecordId; count: number; last: number }>();
  for (const row of messages) {
    const key = String(row.model);
    const value = counts.get(key) ?? { model: row.model, count: 0, last: -1 };
    value.count += 1;
    value.last = Math.max(value.last, row.sequence);
    counts.set(key, value);
  }
  let best: { model: RecordId; count: number; last: number } | undefined;
  for (const value of counts.values()) {
    if (!best || value.count > best.count || (value.count === best.count && value.last > best.last)) {
      best = value;
    }
  }
  return best?.model;
}

export async function inspectPrimaryModels(db: Surreal): Promise<PrimaryModelRepair[]> {
  const dialogues = await selectAll<DialogueModelRow>(
    db,
    "SELECT id, current_revision, primary_model FROM dialogue",
  );
  const messages = await selectAll<{
    dialogue: RecordId;
    model: RecordId;
    sequence: number;
  }>(
    db,
    `SELECT dialogue, model, sequence FROM message
     WHERE role = "assistant" AND model IS NOT NONE
       AND dialogue_revision = dialogue.current_revision`,
  );
  const byDialogue = new Map<string, Array<{ model: RecordId; sequence: number }>>();
  for (const row of messages) {
    const key = String(row.dialogue);
    byDialogue.set(key, [...(byDialogue.get(key) ?? []), row]);
  }
  const repairs: PrimaryModelRepair[] = [];
  for (const dialogue of dialogues) {
    const expected = choosePrimaryModel(byDialogue.get(String(dialogue.id)) ?? []);
    if (!sameRecord(dialogue.primary_model, expected)) {
      repairs.push({
        dialogue: dialogue.id,
        current: dialogue.primary_model,
        expected,
      });
    }
  }
  return repairs;
}

function requestedActions(options: DoctorOptions): DoctorActionName[] {
  const requested: DoctorActionName[] = [];
  if (options.importOrphanRaw) requested.push("import-orphan-raw");
  if (options.removeStaleStaging) requested.push("remove-stale-staging");
  if (options.requeueStuckEmbeddings) requested.push("requeue-stuck-embeddings");
  if (options.rebuildSearchProjection) requested.push("rebuild-search-projection");
  if (options.recalculatePrimaryModels) requested.push("recalculate-primary-models");
  if (options.repairManifest) requested.push("repair-manifest");
  return requested;
}

const DESTRUCTIVE_ACTIONS = new Set<DoctorActionName>([
  "remove-stale-staging",
  "rebuild-search-projection",
  "repair-manifest",
]);

/** Public already-open DB API is inspection-only; booleans cannot mint a lock. */
export function assertDoctorSafety(options: DoctorOptions): void {
  const requested = requestedActions(options);
  const dryRun = options.dryRun ?? true;
  if (dryRun || requested.length === 0) return;
  throw new Error("runDoctorWithDb is read-only; mutation is available only through runDoctor");
}

function assertDoctorApplyOptions(options: DoctorOptions): void {
  const requested = requestedActions(options);
  const destructive = requested.filter((action) => DESTRUCTIVE_ACTIONS.has(action));
  if (destructive.length > 0 && options.allowDestructive !== true) {
    throw new Error(
      `destructive doctor actions требуют allowDestructive=true: ${destructive.join(", ")}`,
    );
  }
  if (options.rebuildSearchProjection && !options.rebuildOptions) {
    throw new Error("rebuild-search-projection требует rebuildOptions с host/schemaVersion");
  }
}

async function importOrphans(
  db: Surreal,
  archiveRoot: string,
  assessments: OrphanRawAssessment[],
  schemaVersion: number,
): Promise<DoctorActionResult> {
  const repairable = assessments.filter(
    (item): item is OrphanRawAssessment & { sha256: string; provenance: OrphanRawProvenance } =>
      item.repairable && item.sha256 !== undefined && item.provenance !== undefined,
  );
  const runs = new Map<string, { id: RecordId; imported: number; failed: number }>();
  const details: string[] = [];
  let imported = 0;
  try {
    for (const item of repairable) {
      const hostKey = String(item.provenance.host);
      let run = runs.get(hostKey);
      if (!run) {
        run = {
          id: await createSyncRun(db, {
            kind: "validation",
            host: item.provenance.host,
            bakaCommit: gitHead(),
            schemaVersion,
            configurationFingerprint: "doctor:import-orphan-raw",
          }),
          imported: 0,
          failed: 0,
        };
        runs.set(hostKey, run);
      }
      try {
        const safeRaw = await resolveArchiveRegularFile(archiveRoot, item.path);
        const currentHashes = await hashFile(safeRaw);
        if (currentHashes.sha256 !== item.sha256) {
          throw new Error("orphan raw изменился после inspection");
        }
        const result = await ensureSourceRevision(db, {
          sourceLocation: item.provenance.sourceLocation,
          sha256: item.sha256,
          sizeBytes: item.provenance.sizeBytes,
          mtimeMs: item.provenance.mtimeMs,
          headHash: item.provenance.headHash,
          rawArchivePath: item.path,
          snapshotKind: "regular_copy",
          parserName: item.provenance.parserName,
          parserVersion: item.provenance.parserVersion,
          syncRun: run.id,
        });
        if (!result.created) {
          run.failed += 1;
          details.push(`${item.path}: revision уже появилась, оставлено без изменений`);
          continue;
        }
        run.imported += 1;
        imported += 1;
        details.push(`${item.path}: зарегистрирован как pending source_revision`);
      } catch (error) {
        run.failed += 1;
        details.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    for (const run of runs.values()) {
      await finishSyncRun(db, run.id, {
        status: run.failed > 0 ? "completed_with_errors" : "completed",
        counters: { importedOrphanRaw: run.imported, failed: run.failed },
      }).catch(() => {});
    }
  }
  return {
    action: "import-orphan-raw",
    status: "applied",
    affected: imported,
    details,
  };
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function ensureSafeDirectoryWithin(
  archiveRoot: string,
  directory: string,
  createMissing: boolean,
): Promise<string> {
  const lexicalRoot = path.resolve(archiveRoot);
  const lexicalDirectory = path.resolve(directory);
  const relative = path.relative(lexicalRoot, lexicalDirectory);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (relative !== "") throw new Error("directory выходит за archiveRoot");
  }
  const rootInfo = await lstat(lexicalRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("archiveRoot должен быть обычным не-symlink каталогом");
  }
  const realRoot = await realpath(lexicalRoot);
  let current = lexicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing && !createMissing) return lexicalDirectory;
    if (!existing) await mkdir(current);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("parent manifest path содержит symlink/не-каталог");
    }
    const resolved = await realpath(current);
    if (!containedBy(realRoot, resolved)) throw new Error("parent manifest realpath выходит за archiveRoot");
  }
  return lexicalDirectory;
}

async function safeManifestPath(
  archiveRoot: string,
  manifestPath: string,
  createParents = false,
): Promise<string> {
  const lexicalRoot = path.resolve(archiveRoot);
  const target = path.resolve(manifestPath);
  if (!containedBy(lexicalRoot, target) || target === lexicalRoot) {
    throw new Error("manifest path должен быть файлом внутри archiveRoot");
  }
  await ensureSafeDirectoryWithin(archiveRoot, path.dirname(target), createParents);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("manifest target должен быть обычным не-symlink файлом");
  }
  return target;
}

async function safeRemovalPath(archiveRoot: string, candidate: string): Promise<string> {
  const lexicalRoot = path.resolve(archiveRoot);
  const lexicalCandidate = path.resolve(candidate);
  if (!containedBy(lexicalRoot, lexicalCandidate) || lexicalCandidate === lexicalRoot) {
    throw new Error("doctor removal target выходит за archiveRoot");
  }
  const info = await lstat(lexicalCandidate);
  if (info.isSymbolicLink()) throw new Error("doctor не удаляет symlink staging targets");
  const [realRoot, realCandidate] = await Promise.all([
    realpath(lexicalRoot),
    realpath(lexicalCandidate),
  ]);
  if (!containedBy(realRoot, realCandidate) || realCandidate === realRoot) {
    throw new Error("doctor removal realpath выходит за archiveRoot");
  }
  return lexicalCandidate;
}

async function writeManifestAtomic(
  archiveRoot: string,
  manifestPath: string,
  manifest: RawManifest,
): Promise<void> {
  const target = await safeManifestPath(archiveRoot, manifestPath, true);
  const directory = path.dirname(target);
  const tmp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.part`,
  );
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // Recheck parents and target immediately before publication.
    await safeManifestPath(archiveRoot, target, true);
    await rename(tmp, target);
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

interface ManifestInspection {
  manifest: RawManifest;
  path: string;
  matches: boolean;
  detail: string;
}

async function inspectManifest(
  db: Surreal,
  archiveRoot: string,
  requestedPath?: string,
): Promise<ManifestInspection> {
  const manifest = await buildRawManifest(db);
  const manifestPath =
    requestedPath ?? path.join(archiveRoot, "backups", "manifests", "raw-manifest-current.json");
  const safePath = await safeManifestPath(archiveRoot, manifestPath);
  const expectedHash = hashRawManifest(manifest);
  try {
    const existing = JSON.parse(await readFile(safePath, "utf8")) as RawManifest;
    if (!Array.isArray(existing.entries)) throw new Error("entries не массив");
    const actualHash = hashRawManifest(existing);
    const matches = actualHash === expectedHash && existing.count === manifest.count;
    return {
      manifest,
      path: safePath,
      matches,
      detail: matches
        ? `raw manifest актуален (${manifest.count} entries)`
        : `raw manifest устарел: expected ${expectedHash.slice(0, 12)}…, actual ${actualHash.slice(0, 12)}…`,
    };
  } catch (error) {
    return {
      manifest,
      path: safePath,
      matches: false,
      detail: `raw manifest отсутствует/повреждён: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function planned(action: DoctorActionName, affected: number, details: string[]): DoctorActionResult {
  return { action, status: affected > 0 ? "planned" : "skipped", affected, details };
}

const DOCTOR_MUTATION_AUTHORITY = Symbol("doctor mutation authority");

async function runDoctorCore(
  db: Surreal,
  cfg: Pick<AppConfig, "archiveRoot">,
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
  authority?: typeof DOCTOR_MUTATION_AUTHORITY,
): Promise<DoctorReport> {
  const applying = options.dryRun === false && requestedActions(options).length > 0;
  if (applying && authority !== DOCTOR_MUTATION_AUTHORITY) {
    throw new Error("doctor mutation authority is unavailable outside runDoctor");
  }
  if (applying) assertDoctorApplyOptions(options);
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? new Date();
  const log = options.logger ?? (() => {});
  log({ event: "doctor_inspection_started", dryRun, actions: requestedActions(options).length });
  const validate = dependencies.validate ?? runValidationWithDb;
  const validation = await validate(db, cfg);
  const migrationQuarantine = validation.migrationQuarantine;
  if (migrationQuarantine) {
    // Verified signed exclusions are information, not repair candidates. A
    // retry/new durable mapping is reflected as superseded and any new
    // unresolved attempt remains a validation failure.
    log({
      event: "doctor_migration_quarantine_inspected",
      state: migrationQuarantine.state,
      documentedOperatorExclusions: migrationQuarantine.documentedOperatorExclusions,
      supersededOperatorExclusions: migrationQuarantine.supersededOperatorExclusions,
      unresolved: migrationQuarantine.unresolved,
      invalidResolutions: migrationQuarantine.invalidResolutions,
    });
  }
  // Validation остаётся отдельной полной секцией отчёта; findings здесь —
  // только doctor-specific diagnosis/repair plan, без дублей orphan raw.
  const findings: DoctorFinding[] = [];
  const actions: DoctorActionResult[] = [];
  const manual: string[] = [];

  const unresolvedIngestErrors = await inspectUnresolvedIngestErrors(db);
  for (const item of unresolvedIngestErrors) {
    const scope = item.currentRevision ? "current revision" : "historical/non-revision";
    findings.push({
      check: `unresolved_ingest_error:${item.classification}`,
      detail: `${String(item.id)} (${item.errorCode}, ${scope})`,
      repairable: false,
    });
    manual.push(
      item.classification === "documented_unsupported"
        ? `${String(item.id)}: documented unsupported raw is intentionally retained`
        : item.classification === "unattributed_snapshot_failure"
          ? `${String(item.id)}: snapshot failure has no durable source provenance; automatic resolution refused`
          : item.classification === "historical_revision_failure"
            ? `${String(item.id)}: historical revision failure requires explicit reconciliation proof`
            : `${String(item.id)}: requires successful reparse/resync proof`,
    );
  }

  const orphanRaw = await inspectOrphanRawFiles(db, cfg.archiveRoot);
  for (const item of orphanRaw) {
    findings.push({
      check: "orphan_raw_file",
      detail: `${item.path}: ${item.reason}`,
      repair: item.repairable ? "import-orphan-raw" : undefined,
      repairable: item.repairable,
    });
    if (!item.repairable) manual.push(`${item.path}: ${item.reason}`);
  }

  const staging = await findStagingOrphans(
    cfg.archiveRoot,
    options.currentRunId ?? "__doctor_no_active_run__",
  );
  for (const item of staging) {
    findings.push({
      check: "stale_staging",
      detail: path.relative(cfg.archiveRoot, item),
      repair: "remove-stale-staging",
      repairable: true,
    });
  }

  const stuckJobs = await inspectStuckEmbeddingJobs(db, now);
  for (const job of stuckJobs) {
    findings.push({
      check: "stuck_embedding_job",
      detail: `${String(job.id)} (locked_by: ${job.locked_by ?? "NONE"}, locked_at: ${job.locked_at ? new Date(job.locked_at).toISOString() : "NONE"})`,
      repair: "requeue-stuck-embeddings",
      repairable: true,
    });
  }

  const primaryModels = await inspectPrimaryModels(db);
  for (const repair of primaryModels) {
    findings.push({
      check: "primary_model_mismatch",
      detail: `${String(repair.dialogue)}: ${repair.current ? String(repair.current) : "NONE"} → ${repair.expected ? String(repair.expected) : "NONE"}`,
      repair: "recalculate-primary-models",
      repairable: true,
    });
  }

  let manifestInspection: ManifestInspection | undefined;
  if (options.repairManifest) {
    manifestInspection = await inspectManifest(db, cfg.archiveRoot, options.manifestPath);
    if (!manifestInspection.matches) {
      findings.push({
        check: "raw_manifest_mismatch",
        detail: `${path.relative(cfg.archiveRoot, manifestInspection.path)}: ${manifestInspection.detail}`,
        repair: "repair-manifest",
        repairable: true,
      });
    }
  }

  if (options.importOrphanRaw) {
    const repairable = orphanRaw.filter((item) => item.repairable);
    if (dryRun) {
      actions.push(planned("import-orphan-raw", repairable.length, repairable.map((i) => i.path)));
    } else {
      actions.push(
        await importOrphans(db, cfg.archiveRoot, orphanRaw, await checkSchemaVersion(db)),
      );
    }
  }

  if (options.removeStaleStaging) {
    if (dryRun) {
      actions.push(
        planned("remove-stale-staging", staging.length, staging.map((item) => path.relative(cfg.archiveRoot, item))),
      );
    } else {
      for (const item of staging) {
        await rm(await safeRemovalPath(cfg.archiveRoot, item), { recursive: true, force: true });
      }
      actions.push({
        action: "remove-stale-staging",
        status: "applied",
        affected: staging.length,
        details: staging.map((item) => path.relative(cfg.archiveRoot, item)),
      });
    }
  }

  if (options.requeueStuckEmbeddings) {
    if (dryRun) {
      actions.push(
        planned("requeue-stuck-embeddings", stuckJobs.length, stuckJobs.map((job) => String(job.id))),
      );
    } else {
      // Основной dated lease path переиспользует worker API; повреждённые
      // processing rows без locked_at дочищаются отдельным guarded UPDATE.
      const released = await releaseStaleLeases(db, now);
      const missingLock = await selectAll<{ id: unknown }>(
        db,
        `UPDATE embedding_job SET status = "pending", locked_by = NONE, locked_at = NONE
         WHERE status = "processing" AND locked_at IS NONE RETURN id`,
      );
      actions.push({
        action: "requeue-stuck-embeddings",
        status: "applied",
        affected: released + missingLock.length,
        details: [`expired leases: ${released}`, `missing locked_at: ${missingLock.length}`],
      });
    }
  }

  if (options.rebuildSearchProjection) {
    if (dryRun) {
      actions.push(
        planned("rebuild-search-projection", 1, ["полная производная search projection"]),
      );
    } else {
      const rebuild = dependencies.rebuild ?? rebuildProjection;
      const summary: RebuildSummary = await rebuild(db, options.rebuildOptions!);
      actions.push({
        action: "rebuild-search-projection",
        status: "applied",
        affected: summary.searchDocuments,
        details: [
          `revisions: ${summary.revisions}`,
          `search_documents: ${summary.searchDocuments}`,
          `embedding_jobs: ${summary.embeddingJobs}`,
          `skipped: ${summary.skipped}`,
        ],
      });
    }
  }

  if (options.recalculatePrimaryModels) {
    if (dryRun) {
      actions.push(
        planned(
          "recalculate-primary-models",
          primaryModels.length,
          primaryModels.map((item) => String(item.dialogue)),
        ),
      );
    } else {
      for (const repair of primaryModels) {
        if (repair.expected) {
          await db.query("UPDATE ONLY $id SET primary_model = $model", {
            id: repair.dialogue,
            model: repair.expected,
          });
        } else {
          await db.query("UPDATE ONLY $id SET primary_model = NONE", { id: repair.dialogue });
        }
      }
      actions.push({
        action: "recalculate-primary-models",
        status: "applied",
        affected: primaryModels.length,
        details: primaryModels.map((item) => String(item.dialogue)),
      });
    }
  }

  if (options.repairManifest) {
    const inspection = manifestInspection!;
    if (inspection.matches) {
      actions.push({
        action: "repair-manifest",
        status: "skipped",
        affected: 0,
        details: [inspection.detail],
      });
    } else if (dryRun) {
      actions.push(
        planned("repair-manifest", 1, [path.relative(cfg.archiveRoot, inspection.path)]),
      );
    } else {
      await writeManifestAtomic(cfg.archiveRoot, inspection.path, inspection.manifest);
      actions.push({
        action: "repair-manifest",
        status: "applied",
        affected: 1,
        details: [path.relative(cfg.archiveRoot, inspection.path)],
      });
    }
  }

  const report: DoctorReport = {
    ok: validation.ok && findings.length === 0,
    dryRun,
    validation,
    findings,
    actions,
    manual,
  };
  for (const action of actions) {
    log({
      event: "doctor_action_finished",
      action: action.action,
      status: action.status,
      affected: action.affected,
    });
  }
  log({
    event: "doctor_inspection_finished",
    ok: report.ok,
    findings: findings.length,
    actions: actions.length,
    manual: manual.length,
  });
  return report;
}

/** Already-open DB seam is deliberately inspection-only, even with forged flags. */
export async function runDoctorWithDb(
  db: Surreal,
  cfg: Pick<AppConfig, "archiveRoot">,
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  assertDoctorSafety(options);
  return runDoctorCore(
    db,
    cfg,
    { ...options, dryRun: true, exclusiveLockHeld: undefined },
    dependencies,
  );
}

export async function runDoctor(
  cfg: AppConfig,
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const requested = requestedActions(options);
  const apply = options.dryRun === false && requested.length > 0;
  if (apply) assertDoctorApplyOptions(options);
  // Only this entry point owns the real process lock lifecycle. Dependency or
  // caller booleans cannot replace it.
  const release = apply
    ? await acquireLock(cfg.archiveRoot, "doctor --apply")
    : async () => {};
  const connect = dependencies.connect ?? connectDb;
  let db: Surreal | undefined;
  try {
    db = await connect(cfg);
    return await runDoctorCore(
      db,
      cfg,
      { ...options, exclusiveLockHeld: undefined },
      dependencies,
      apply ? DOCTOR_MUTATION_AUTHORITY : undefined,
    );
  } catch (error) {
    options.logger?.({ event: "doctor_failed", errorCode: "doctor_operation_failed" });
    throw error;
  } finally {
    if (db) await db.close().catch(() => {});
    await release();
  }
}
