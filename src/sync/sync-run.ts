/**
 * Structured sync — orchestrator live sync (docs/plan.md §10, этап 5).
 *
 * Порядок запуска (§10.1): preflight → lock → readiness → schema → sync_run →
 * host/os_account → discovery → source_root upsert → per-root scan →
 * reconcile против source_location в БД → snapshot → source_revision →
 * parse → canonical transactions → deletion state machine → rename
 * detection → counters/status.
 *
 * Crash-safe порядок §9.3 соблюдается: raw rename (snapshotSource) → parse →
 * DB transaction → search documents → embedding jobs (последние два — внутри
 * транзакции диалога; сами embeddings не вызываются, §3.4).
 *
 * Embedding jobs создаются только если существует active embedding_space
 * (§13.5); пока space не создан (этап 7), jobs не ставятся — это согласуется
 * с деградацией §14: search_document'ы готовы, backfill создаст jobs позже.
 */

import { copyFile, link, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { RecordId, Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb } from "../db/client.ts";
import { checkSchemaVersion, listMigrations, gitHead } from "../db/migrations.ts";
import { assertPreflight } from "../infra/preflight.ts";
import { acquireLock } from "../infra/lock.ts";
import { ensureSyncDatabase } from "../infra/sync-database.ts";
import {
  HARNESSES,
  type HarnessSlug,
} from "../sources/adapters/harnesses.ts";
import { HARNESS_FILE_MATCHERS, isSqlitePath } from "../sources/adapters/file-matchers.ts";
import { discoverSourceRoots, type DiscoveredSourceRoot } from "../sources/discovery/discovery.ts";
import { scanSourceRoot } from "../sources/scanning/scanner.ts";
import type { ScanResult } from "../sources/scanning/scanner.ts";
import { snapshotSource, SnapshotError } from "../sources/snapshot/raw-snapshot.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import {
  detectRenames,
  reconcileLocations,
  type LocationState,
  type ReconcileResult,
  type ScanFileInfo,
  type ScanSummary,
} from "./location-reconciler.ts";
import { HARNESS_TOOLS, kimiSessionDir } from "./harness-tools.ts";
import { localIdentity } from "./host-identity.ts";
import { ingestSourceRevision, type IngestContext, type IngestOutcome } from "./revision-ingestor.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
  ensureOsAccount,
} from "../db/repositories/identity.ts";
import {
  createIngestError,
  createSourceScan,
  createSyncRun,
  ensureSourceLocation,
  ensureSourceRevision,
  ensureSourceRoot,
  finishSourceScan,
  finishSyncRun,
  listActiveEmbeddingSpaces,
  listLocations,
  resolveStaleIngestErrors,
  resolveStaleSnapshotIngestErrors,
  setLocationRenamedFrom,
  setLocationRevisions,
  updateLocationPresence,
  updateSourceRevisionParse,
  type LocationRow,
} from "../db/repositories/provenance.ts";
import { selectOne } from "../db/repositories/helpers.ts";
import { listEmbeddingTables } from "../embeddings/spaces.ts";
import { headFileHash } from "./head-hash.ts";
import type { PresenceStatus } from "./deletion-detector.ts";
import type { SyncProgress } from "./progress.ts";
import { readSourceFingerprint, physicalFileState } from "../sources/snapshot/source-fingerprint.ts";
import { SourceObservations } from "./source-observations.ts";
import { EXTRACTOR_VERSION } from "../search/extractors/types.ts";
import { SEGMENTATION_VERSION } from "../search/segmenter.ts";

export interface SyncOptions {
  harness?: HarnessSlug;
  fullRescan?: boolean;
  deletionConfirmations?: number;
  /** По умолчанию true; --no-enqueue-embeddings выключает. */
  enqueueEmbeddings?: boolean;
  dryRun?: boolean;
  /** CLI enables local Compose startup; embedded callers manage their own database. */
  autoStartDatabase?: boolean;
  /** false — пропустить assertPreflight (integration-тесты на temp dirs). */
  preflight?: boolean;
  hostIdPath?: string;
  logger?: (event: Record<string, unknown>) => void;
  onProgress?: (progress: SyncProgress) => void;
  /** Deterministic test seam; production always uses snapshotSource. */
  snapshotSource?: typeof snapshotSource;
}

export interface SyncSummary {
  status: string;
  syncRunId?: string;
  counters: Record<string, number>;
  errors: string[];
}

type Logger = (event: Record<string, unknown>) => void;

function defaultLogger(event: Record<string, unknown>): void {
  console.error(JSON.stringify({ time: new Date().toISOString(), ...event }));
}

interface StageTimer {
  next(stage: string, status?: string): void;
  finish(status: string): void;
}

/** Sequential, non-overlapping stages; root totals are nested in sync.roots. */
function stageTimer(log: Logger, scope: Record<string, unknown>, initialStage: string): StageTimer {
  const started = performance.now();
  let stageStarted = started;
  let stage = initialStage;
  const emit = (status: string) => {
    const now = performance.now();
    log({ event: "sync_timing", ...scope, stage, status,
      durationMs: Number((now - stageStarted).toFixed(3)) });
    stageStarted = now;
  };
  return {
    next(nextStage: string, status = "completed") {
      emit(status);
      stage = nextStage;
    },
    finish(status: string) {
      emit(status);
      log({ event: "sync_timing", ...scope, stage: "total", status,
        durationMs: Number((performance.now() - started).toFixed(3)) });
    },
  };
}

interface PendingParse {
  locationId: RecordId;
  revisionId: RecordId;
  revisionCreated: boolean;
  revisionParseStatus?: string;
  relativePath: string;
  rawArchivePath: string;
  sha256: string;
  sourceFingerprint?: string;
}

interface RootOutcome {
  filesSeen: number;
  filesNew: number;
  filesChanged: number;
  filesMissing: number;
  filesDuplicateSkipped: number;
  errors: number;
  revisionsCreated: number;
  dialoguesWritten: number;
  messagesWritten: number;
  chunksWritten: number;
  searchDocuments: number;
  embeddingJobs: number;
}

function emptyOutcome(): RootOutcome {
  return {
    filesSeen: 0,
    filesNew: 0,
    filesChanged: 0,
    filesMissing: 0,
    filesDuplicateSkipped: 0,
    errors: 0,
    revisionsCreated: 0,
    dialoguesWritten: 0,
    messagesWritten: 0,
    chunksWritten: 0,
    searchDocuments: 0,
    embeddingJobs: 0,
  };
}

function isOrcaCodexRuntimeRoot(root: DiscoveredSourceRoot): boolean {
  if (root.harness !== "codex") return false;
  const normalized = root.path.split(path.sep).join("/");
  return normalized.endsWith("/Library/Application Support/orca/codex-runtime-home/home/sessions");
}

function isJsonlSource(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(".jsonl");
}


interface CodexDuplicateIndex {
  hashes: Set<string>;
  physical: Map<string, string>;
  cacheHits: number;
}

async function duplicateHash(file: string, index: CodexDuplicateIndex): Promise<string> {
  const before = physicalFileState(await stat(file));
  const cached = index.physical.get(before);
  if (cached) {
    if (before !== physicalFileState(await stat(file))) throw new Error("source changed during duplicate cache lookup");
    index.cacheHits += 1;
    return cached;
  }
  const hash = (await hashFile(file)).sha256;
  if (before !== physicalFileState(await stat(file))) throw new Error("source changed during duplicate hashing");
  index.physical.set(before, hash);
  return hash;
}

async function buildCodexNativeDuplicateSha256Index(
  roots: DiscoveredSourceRoot[],
  log: Logger,
  progress?: (progress: SyncProgress) => void,
): Promise<CodexDuplicateIndex | undefined> {
  const hasOrcaCodexRuntime = roots.some((root) => root.enabled && isOrcaCodexRuntimeRoot(root));
  if (!hasOrcaCodexRuntime) return undefined;

  const nativeRoots = roots.filter(
    (root) => root.enabled && root.harness === "codex" && !isOrcaCodexRuntimeRoot(root),
  );
  if (nativeRoots.length === 0) return undefined;

  const hashes = new Set<string>();
  const index: CodexDuplicateIndex = { hashes, physical: new Map(), cacheHits: 0 };
  let filesIndexed = 0;
  let errors = 0;
  for (const root of nativeRoots) {
    const rootIsFile = (await stat(root.path).catch(() => undefined))?.isFile() ?? false;
    const report = (detail: string, completed: number, total?: number) =>
      progress?.({ stage: 3, detail, completed, total, unit: "файлов", root: root.harness });
    const scan = await scanSourceRoot(root.path, HARNESS_FILE_MATCHERS.codex,
      (found) => report("Поиск файлов · найдено", found));
    let checked = 0;
    report("Поиск повторяющихся файлов", 0, scan.files.length);
    errors += scan.errors.length;
    for (const file of scan.files) {
      if (!isJsonlSource(file.relativePath)) {
        report("Поиск повторяющихся файлов", ++checked, scan.files.length);
        continue;
      }
      try {
        const sourcePath = rootIsFile ? root.path : path.join(root.path, file.relativePath);
        hashes.add(await duplicateHash(sourcePath, index));
        filesIndexed += 1;
      } catch (error) {
        errors += 1;
        log({
          event: "source_duplicate_index_error",
          root: root.path,
          path: file.relativePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      report("Поиск повторяющихся файлов", ++checked, scan.files.length);
    }
  }
  log({
    event: "source_duplicate_index",
    harness: "codex",
    roots: nativeRoots.length,
    filesIndexed,
    uniqueSha256: hashes.size,
    errors,
  });
  return index;
}

async function filterOrcaCodexDuplicateFiles(
  root: DiscoveredSourceRoot,
  scan: ScanResult,
  nativeDuplicateSha256Index: CodexDuplicateIndex | undefined,
  log: Logger,
  progress?: (completed: number, total: number) => void,
): Promise<ScanResult> {
  if (!isOrcaCodexRuntimeRoot(root) || !nativeDuplicateSha256Index?.hashes.size) return scan;

  const files: ScanResult["files"] = [];
  let skipped = 0;
  let errors = 0;
  let checked = 0;
  const rootIsFile = (await stat(root.path).catch(() => undefined))?.isFile() ?? false;
  progress?.(0, scan.files.length);
  for (const file of scan.files) {
    if (!isJsonlSource(file.relativePath)) {
      files.push(file);
      progress?.(++checked, scan.files.length);
      continue;
    }
    try {
      const sourcePath = rootIsFile ? root.path : path.join(root.path, file.relativePath);
      const sha256 = await duplicateHash(sourcePath, nativeDuplicateSha256Index);
      if (nativeDuplicateSha256Index.hashes.has(sha256)) {
        skipped += 1;
        progress?.(++checked, scan.files.length);
        continue;
      }
      files.push(file);
    } catch (error) {
      errors += 1;
      files.push(file);
      log({
        event: "source_duplicate_filter_error",
        root: root.path,
        path: file.relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    progress?.(++checked, scan.files.length);
  }
  if (skipped > 0 || errors > 0) {
    log({
      event: "source_duplicate_filter",
      root: root.path,
      rawFiles: scan.files.length,
      files: files.length,
      duplicateFilesSkipped: skipped,
      errors,
      physicalCacheHits: nativeDuplicateSha256Index.cacheHits,
    });
  }
  return { ...scan, files };
}

export async function runSync(cfg: AppConfig, options: SyncOptions = {}): Promise<SyncSummary> {
  const log = options.logger ?? defaultLogger;
  const progress = options.onProgress;
  const deletionConfirmations = options.deletionConfirmations ?? cfg.deletionConfirmations;
  const enqueueEmbeddings = options.enqueueEmbeddings ?? true;
  const dryRun = options.dryRun ?? false;
  const counters: Record<string, number> = {
    roots: 0,
    filesSeen: 0,
    filesNew: 0,
    filesChanged: 0,
    filesMissing: 0,
    filesDuplicateSkipped: 0,
    revisionsCreated: 0,
    dialoguesWritten: 0,
    messagesWritten: 0,
    chunksWritten: 0,
    searchDocuments: 0,
    embeddingJobs: 0,
    ingestErrors: 0,
  };
  const errors: string[] = [];
  const timing = stageTimer(log, { scope: "sync", dryRun }, "preflight");

  progress?.({ stage: 1, detail: "Проверка архива" });
  try {
    if (options.preflight !== false) await assertPreflight(cfg);
  } catch (error) {
    timing.finish("failed");
    throw error;
  }
  timing.next("lock");
  progress?.({ stage: 1, detail: "Подготовка синхронизации" });
  const release = await acquireLock(cfg.archiveRoot, dryRun ? "sync --dry-run" : "sync")
    .catch((error) => { timing.finish("failed"); throw error; });
  let db: Surreal | undefined;
  let syncRunId: RecordId | undefined;
  let runStatus = "failed";
  let primaryError: unknown;
  try {
    timing.next("database_start");
    // connectDb внутри try: при ошибке подключения lock обязан освободиться.
    if (options.autoStartDatabase) {
      await ensureSyncDatabase(cfg, (detail) => progress?.({ stage: 1, detail }));
    }
    progress?.({ stage: 1, detail: "Подключение к БД" });
    timing.next("database_connect");
    db = await connectDb(cfg, { failFast: true });
    progress?.({ stage: 1, detail: "Проверка совместимости архива" });
    timing.next("schema_check");
    // §10.1 п.3: schema version.
    const schemaVersion = await checkSchemaVersion(db);
    const knownMigrations = await listMigrations();
    const maxKnown = Math.max(0, ...knownMigrations.map((m) => m.version));
    if (schemaVersion === 0) throw new Error("схема не инициализирована: сначала baka db migrate");
    if (schemaVersion > maxKnown) {
      throw new Error(
        `неизвестная версия схемы ${schemaVersion} (код знает до ${maxKnown}) — обновите baka`,
      );
    }

    timing.next("source_cache_load");
    const observations = await SourceObservations.load(cfg);
    progress?.({ stage: 1, detail: "Подготовка синхронизации" });
    timing.next("identity");
    // §10.1 п.6: host + os_account. dry-run — read-only режим: ничего не
    // создаёт и не обновляет (ни host/os_account, ни harness/source_root).
    let hostId: RecordId | undefined;
    let osAccountId: RecordId | undefined;
    if (!dryRun) {
      const identity = await localIdentity({ hostIdPath: options.hostIdPath });
      hostId = await ensureHost(db, {
        hostUuid: identity.hostUuid,
        hostname: identity.hostname,
        platform: identity.platform,
        arch: identity.arch,
      });
      osAccountId = await ensureOsAccount(db, {
        host: hostId,
        osUsername: identity.osUsername,
        homePath: identity.homePath,
      });
    }

    // §10.1 п.7: discovery (+ фильтры CLI).
    progress?.({ stage: 2, detail: "Поиск источников" });
    timing.next("discovery");
    const discovery = await discoverSourceRoots({ overrides: cfg.sourceOverrides });
    let roots = discovery.roots;
    if (options.harness) roots = roots.filter((r) => r.harness === options.harness);

    progress?.({ stage: 2, detail: "Подготовка синхронизации", rootsCompleted: 0, rootsTotal: roots.length });
    timing.next("sync_run_create");
    if (!dryRun) {
      syncRunId = await createSyncRun(db, {
        kind: "live_sync",
        host: hostId!,
        bakaCommit: gitHead(),
        schemaVersion,
        configurationFingerprint: JSON.stringify({
          harness: options.harness ?? null,
          fullRescan: options.fullRescan ?? false,
          deletionConfirmations,
          enqueueEmbeddings,
        }),
      });
    }
    log({ event: "sync_start", syncRun: syncRunId?.toString(), dryRun, roots: roots.length });

    timing.next("embedding_metadata");
    const activeSpaces = enqueueEmbeddings
      ? (await listActiveEmbeddingSpaces(db)).map((s) => s.id)
      : [];
    // Физические vector-таблицы всех spaces — для каскадного удаления
    // vectors при смене current revision (§8.1).
    const embeddingTables = await listEmbeddingTables(db);
    if (enqueueEmbeddings && activeSpaces.length === 0) {
      log({
        event: "embedding_jobs_skipped",
        reason: "нет active embedding_space — jobs не создаются (space и backfill — этап 7)",
      });
    }
    progress?.({ stage: 3, detail: "Поиск повторяющихся файлов" });
    timing.next("duplicate_index");
    const codexNativeDuplicateSha256Index = await buildCodexNativeDuplicateSha256Index(roots, log, progress);
    timing.next("roots");

    for (const root of roots) {
      counters.roots += 1;
      const rootProgress = (detail: string, completed?: number, total?: number, unit = "файлов") =>
        progress?.({ stage: 4, detail, completed, total, unit, root: root.harness,
          rootsCompleted: counters.roots - 1, rootsTotal: roots.length });
      rootProgress("Подготовка источника");
      const rootTiming = stageTimer(log,
        { scope: "root", root: root.path, harness: root.harness, dryRun }, "identity");
      let rootStatus = "failed";
      try {
        const outcome = await processSourceRoot(db, cfg, {
          root,
          hostId,
          osAccountId,
          syncRunId,
          deletionConfirmations,
          enqueueEmbeddings,
          activeSpaces,
          embeddingTables,
          codexNativeDuplicateSha256Index,
          fullRescan: options.fullRescan ?? false,
          dryRun,
          log,
          timing: rootTiming,
          observations,
          progress: rootProgress,
          snapshot: options.snapshotSource ?? snapshotSource,
        });
        rootStatus = outcome.errors > 0 ? "completed_with_errors" : "completed";
        counters.filesSeen += outcome.filesSeen;
        counters.filesNew += outcome.filesNew;
        counters.filesChanged += outcome.filesChanged;
        counters.filesMissing += outcome.filesMissing;
        counters.filesDuplicateSkipped += outcome.filesDuplicateSkipped;
        counters.ingestErrors += outcome.errors;
        counters.revisionsCreated += outcome.revisionsCreated;
        counters.dialoguesWritten += outcome.dialoguesWritten;
        counters.messagesWritten += outcome.messagesWritten;
        counters.chunksWritten += outcome.chunksWritten;
        counters.searchDocuments += outcome.searchDocuments;
        counters.embeddingJobs += outcome.embeddingJobs;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${root.path}: ${message}`);
        counters.ingestErrors += 1;
        log({ event: "root_failed", root: root.path, error: message });
        if (syncRunId) {
          await createIngestError(db, {
            syncRun: syncRunId,
            stage: "snapshot",
            errorCode: "root_failed",
            errorMessage: message,
          });
        }
      } finally {
        rootTiming.finish(rootStatus);
      }
      progress?.({ stage: 4, detail: "Источник обработан", root: root.harness,
        rootsCompleted: counters.roots, rootsTotal: roots.length });
    }
    timing.next("source_cache_save");
    if (!dryRun) await observations.save().catch((error) =>
      log({ event: "source_cache_write_error", error: String(error) }));

    runStatus = errors.length > 0 || counters.ingestErrors > 0 ? "completed_with_errors" : "completed";
  } catch (error) {
    runStatus = "failed";
    errors.push(error instanceof Error ? error.message : String(error));
    primaryError = error;
  } finally {
    timing.next("finalize", primaryError ? "failed" : "completed");
    progress?.({ stage: 5, detail: "Завершение синхронизации" });
    if (syncRunId && db) {
      try {
        await finishSyncRun(db, syncRunId, {
          status: runStatus,
          counters,
          errorSummary: errors.length > 0 ? errors.join("; ").slice(0, 2000) : undefined,
        });
      } catch (finishError) {
        // Ошибка финализации не подавляется безусловно: она не маскирует
        // исходную ошибку (primaryError бросается ниже) и не выдаётся за
        // успех — статус понижается, ошибка попадает в errors.
        const message = finishError instanceof Error ? finishError.message : String(finishError);
        errors.push(`finishSyncRun: ${message}`);
        log({ event: "sync_run_finish_error", error: message });
        if (runStatus === "completed") runStatus = "completed_with_errors";
      }
    }
    log({ event: "sync_finish", status: runStatus, counters });
    timing.next("database_close");
    if (db) await db.close().catch(() => {});
    timing.next("lock_release");
    try {
      await release();
    } finally {
      timing.finish(runStatus);
    }
  }

  if (primaryError) throw primaryError;
  return { status: runStatus, syncRunId: syncRunId?.toString(), counters, errors };
}

export interface ReconcileScannedFilesOptions {
  fullRescan: boolean;
  deletionConfirmations: number;
  resolvePath: (relativePath: string) => string;
  /** Seam для regression-тестов; production читает первые 64 КБ файла. */
  readHeadHash?: (filePath: string) => Promise<string | null>;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Нормализует fingerprint'ы scan и сверяет их с сохранёнными locations.
 *
 * Обычный sync защищён head_hash от изменения содержимого при тех же
 * size/mtime. --full-rescan намеренно доверяет size_bytes + mtime_ms и не
 * читает head_hash для совпавших файлов: большой архив не перехэшируется и
 * не snapshot'ится целиком; new/changed по метаданным остаются changed. Это
 * компромисс относительно docs/plan.md §10.3: изменение с полностью теми же
 * size/mtime будет пропущено (для append-only JSONL считаем маловероятным).
 */
export async function reconcileScannedFiles(
  previous: LocationState[],
  scan: ScanSummary,
  options: ReconcileScannedFilesOptions,
): Promise<ReconcileResult> {
  const previousByPath = new Map(
    previous.map((location) => [location.relativePath, location]),
  );
  const scanFiles: ScanFileInfo[] = scan.files.map((file) => ({
    ...file,
    // mtime_ms в SurrealDB хранится как int.
    mtimeMs: Math.round(file.mtimeMs),
  }));

  let checked = 0;
  options.onProgress?.(0, scanFiles.length);
  if (!options.fullRescan) {
    const readHeadHash = options.readHeadHash ?? headFileHash;
    for (const file of scanFiles) {
      const previousLocation = previousByPath.get(file.relativePath);
      if (!previousLocation?.headHash) {
        options.onProgress?.(++checked, scanFiles.length);
        continue;
      }
      if (
        previousLocation.sizeBytes !== file.sizeBytes ||
        previousLocation.mtimeMs !== file.mtimeMs
      ) {
        options.onProgress?.(++checked, scanFiles.length);
        continue;
      }
      // null (не прочитался) → sentinel, гарантированно не совпадающий с
      // sha256-hex в БД: файл считается changed, полный snapshot зафиксирует
      // настоящую ошибку чтения.
      file.headHash =
        (await readHeadHash(options.resolvePath(file.relativePath))) ??
        `unreadable:${file.relativePath}`;
      options.onProgress?.(++checked, scanFiles.length);
    }
  }
  options.onProgress?.(scanFiles.length, scanFiles.length);

  return reconcileLocations(
    previous,
    { status: scan.status, files: scanFiles },
    { deletionConfirmations: options.deletionConfirmations },
  );
}

interface ProcessRootArgs {
  root: DiscoveredSourceRoot;
  /** undefined в dry-run (read-only режим, identity-записи не создаются). */
  hostId?: RecordId;
  osAccountId?: RecordId;
  syncRunId?: RecordId;
  deletionConfirmations: number;
  enqueueEmbeddings: boolean;
  activeSpaces: RecordId[];
  embeddingTables: string[];
  codexNativeDuplicateSha256Index?: CodexDuplicateIndex;
  fullRescan: boolean;
  dryRun: boolean;
  log: Logger;
  timing: StageTimer;
  snapshot: typeof snapshotSource;
  progress: (detail: string, completed?: number, total?: number, unit?: string) => void;
  observations: SourceObservations;
}

async function processSourceRoot(
  db: Surreal,
  cfg: AppConfig,
  args: ProcessRootArgs,
): Promise<RootOutcome> {
  const { root, log, progress } = args;
  const slug = root.harness;
  const tools = HARNESS_TOOLS[slug];
  const pipeline = JSON.stringify([tools.parser.parserName, tools.parser.parserVersion,
    EXTRACTOR_VERSION, SEGMENTATION_VERSION]);
  const outcome = emptyOutcome();

  // §10.1 п.7: harness + installation + source_root upsert.
  // dry-run — read-only: ничего не создаём; reconcile идёт против
  // существующего source_root, если он уже есть в БД (иначе всё новое).
  let rootId: RecordId | undefined;
  let installationId: RecordId | undefined;
  if (args.dryRun) {
    const existing = await selectOne<{ id: RecordId }>(
      db,
      "SELECT id FROM source_root WHERE path = $path LIMIT 1",
      { path: root.path },
    );
    rootId = existing?.id;
  } else {
    const harnessId = await ensureHarness(db, {
      slug,
      displayName: HARNESSES[slug].displayName,
      kind: root.sourceKind,
    });
    installationId = await ensureHarnessInstallation(db, {
      host: args.hostId!,
      harness: harnessId,
      installed: root.enabled,
    });
    rootId = await ensureSourceRoot(db, {
      harnessInstallation: installationId,
      path: root.path,
      sourceKind: root.sourceKind,
      parserName: tools.parser.parserName,
      snapshotStrategy: root.snapshotStrategy,
      enabled: root.enabled,
    });
  }
  args.timing.next("scan");

  // §10.2: обход root'а с явным статусом полноты.
  const scanStarted = new Date();
  const rawScan = await scanSourceRoot(root.path, HARNESS_FILE_MATCHERS[slug],
    (found) => progress("Поиск файлов · найдено", found));
  args.timing.next("duplicate_filter");
  const scan = await filterOrcaCodexDuplicateFiles(
    root,
    rawScan,
    args.codexNativeDuplicateSha256Index,
    log,
    (completed, total) => progress("Поиск повторяющихся файлов", completed, total),
  );
  outcome.filesSeen = scan.files.length;
  outcome.filesDuplicateSkipped = rawScan.files.length - scan.files.length;
  outcome.errors += scan.errors.length;
  log({
    event: "root_scan",
    root: root.path,
    status: scan.status,
    files: scan.files.length,
    rawFiles: rawScan.files.length,
    duplicateFilesSkipped: outcome.filesDuplicateSkipped,
    scanErrors: scan.errors.length,
  });

  args.timing.next("scan_create");
  let scanId: RecordId | undefined;
  if (args.syncRunId && rootId) {
    scanId = await createSourceScan(db, {
      syncRun: args.syncRunId,
      sourceRoot: rootId,
      status: scan.status,
      filesSeen: scan.files.length,
      startedAt: scanStarted,
    });
  }

  // Всё после создания source_scan — в try: при сбое scan не должен
  // зависнуть незавершённым (finished_at = NONE).
  try {
    progress("Загрузка списка сохранённых файлов");
    args.timing.next("load_locations");
    const prevRows = rootId ? await listLocations(db, rootId) : [];
    const prevByPath = new Map(prevRows.map((row) => [row.relative_path, row]));
    const previous: LocationState[] = prevRows.map((r) => ({
      relativePath: r.relative_path,
      presence: {
        status: r.presence_status as PresenceStatus,
        missingCompleteScans: r.missing_complete_scans,
      },
      currentSha256: r.sha256 ?? undefined,
      sizeBytes: r.size_bytes ?? undefined,
      mtimeMs: r.mtime_ms ?? undefined,
      headHash: r.head_hash ?? undefined,
    }));

    args.timing.next("reconcile");
    // Root может быть одиночным файлом (~/.kimi-code/session_index.jsonl):
    // тогда relativePath = basename, а исходный путь — сам root.
    const rootIsFile = (await stat(root.path).catch(() => undefined))?.isFile() ?? false;

    const reconcile = await reconcileScannedFiles(
      previous,
      scan,
      {
        fullRescan: args.fullRescan,
        deletionConfirmations: args.deletionConfirmations,
        onProgress: (completed, total) => progress("Проверка файлов", completed, total),
        resolvePath: (relativePath) =>
          rootIsFile ? root.path : path.join(root.path, relativePath),
      },
    );
    // Observed source state is distinct from immutable raw identity (especially VACUUM).
    // Cache is revision/pipeline/status-bound; missing SQLite observations fail closed.
    args.timing.next("source_fingerprints");
    let observationHits = 0;
    for (const action of reconcile.actions) {
      if (action.kind !== "changed" && action.kind !== "unchanged") continue;
      const row = prevByPath.get(action.relativePath)!;
      const filePath = rootIsFile ? root.path : path.join(root.path, action.relativePath);
      const cached = args.observations.get(row.id.toString(), row.current_revision?.toString(), pipeline, row.parse_status);
      if (cached) {
        const fingerprint = await readSourceFingerprint(filePath);
        action.kind = fingerprint && fingerprint === cached.fingerprint ? "unchanged" : "changed";
        if (action.kind === "unchanged") observationHits += 1;
      } else if (isSqlitePath(filePath) || args.observations.has(row.id.toString()) ||
          ["pending", "partial", "parse_error"].includes(row.parse_status ?? "")) {
        action.kind = "changed";
      }
    }
    log({ event: "source_observations", root: root.path, hits: observationHits });
    const scanByPath = new Map(scan.files.map((f) => [f.relativePath, f]));
    const seenPaths = new Set(scan.files.map((f) => f.relativePath));

    if (args.dryRun) {
      args.timing.next("dry_run_actions");
      for (const action of reconcile.actions) {
        if (action.kind === "new") outcome.filesNew += 1;
        if (action.kind === "changed") outcome.filesChanged += 1;
        if (action.kind === "missing" || action.kind === "deleted") outcome.filesMissing += 1;
        log({ event: "dry_run_action", root: root.path, ...action });
      }
      return outcome;
    }
    const syncRunId = args.syncRunId!; // dry-run вернулся выше
    const sourceRootId = rootId!;
    const installation = installationId!;
    const hostId = args.hostId!;

    // --- Phase B: snapshot new/changed (§9.1–9.2, §9.3 шаги 1–3) ---
    args.timing.next("snapshot");
    const runId = syncRunId.toString().replaceAll(":", "_");
    const pending: PendingParse[] = [];
    const newLocationIds = new Map<string, RecordId>();
    /** Файлы с неудавшимся snapshot — для crash-safe границы parse-view (§9.3). */
    const failedSnapshotPaths = new Set<string>();
    /** Неудавшийся snapshot НОВОГО файла: rename detection пропускаем (§10.7). */
    let newSnapshotFailed = false;
    const snapshotTotal = reconcile.actions.reduce(
      (count, action) => count + Number(action.kind === "new" || action.kind === "changed"), 0);
    let snapshotsDone = 0;
    progress("Сохранение новых и изменённых файлов", 0, snapshotTotal);
    for (const action of reconcile.actions) {
      if (action.kind !== "new" && action.kind !== "changed") continue;
      const originalPath = rootIsFile ? root.path : path.join(root.path, action.relativePath);
      const location = await ensureSourceLocation(db, {
        sourceRoot: sourceRootId,
        relativePath: action.relativePath,
        originalPath,
        basename: path.basename(action.relativePath),
      });
      if (action.kind === "new") {
        outcome.filesNew += 1;
        newLocationIds.set(action.relativePath, location.id);
      } else {
        outcome.filesChanged += 1;
      }

      let snapshot;
      try {
        snapshot = await args.snapshot(originalPath, {
          archiveRoot: cfg.archiveRoot,
          harness: slug,
          runId,
        });
      } catch (error) {
        outcome.errors += 1;
        failedSnapshotPaths.add(action.relativePath);
        if (action.kind === "new") newSnapshotFailed = true;
        log({ event: "snapshot_error", path: action.relativePath, error: String(error) });
        await createIngestError(db, {
          syncRun: syncRunId,
          // Durable machine provenance. Historical rows without this key
          // remain fail-closed because message text is not an identity.
          sourceRecordKey: location.id.toString(),
          stage: "snapshot",
          errorCode: error instanceof SnapshotError ? "snapshot_failed" : "snapshot_exception",
          // Путь в сообщении: иначе голое "unable to open database file"
          // из bun:sqlite не привязано к источнику (live acceptance, этап 8).
          errorMessage:
            `${action.relativePath}: ` +
            (error instanceof Error ? error.message : String(error)),
        });
        progress("Сохранение новых и изменённых файлов", ++snapshotsDone, snapshotTotal);
        continue;
      }

      const revision = await ensureSourceRevision(db, {
        sourceLocation: location.id,
        sha256: snapshot.sha256,
        sizeBytes: snapshot.sizeBytes,
        mtimeMs: snapshot.mtimeMs,
        headHash: snapshot.headHash,
        rawArchivePath: snapshot.relativeRawPath,
        snapshotKind: snapshot.snapshotKind,
        parserName: tools.parser.parserName,
        parserVersion: tools.parser.parserVersion,
        syncRun: syncRunId,
      });
      if (revision.created) outcome.revisionsCreated += 1;
      await resolveStaleSnapshotIngestErrors(
        db,
        location.id,
        revision.id,
        syncRunId,
      );
      log({
        event: "snapshot",
        path: action.relativePath,
        sha256: snapshot.sha256.slice(0, 12),
        reused: snapshot.reused,
        revisionCreated: revision.created,
        sourceStable: Boolean(snapshot.sourceFingerprint),
      });
      const previousRow = prevByPath.get(action.relativePath);
      const completed = previousRow && args.observations.get(location.id.toString(),
        previousRow.current_revision?.toString(), pipeline, previousRow.parse_status);
      if (tools.parseUnit === "file" && completed?.revision === revision.id.toString()) {
        if (snapshot.sourceFingerprint) {
          args.observations.set(location.id.toString(), { ...completed, fingerprint: snapshot.sourceFingerprint });
        } else {
          args.observations.delete(location.id.toString());
        }
        log({ event: "parse_skipped", reason: "current_revision_already_processed", path: action.relativePath });
        progress("Сохранение новых и изменённых файлов", ++snapshotsDone, snapshotTotal);
        continue;
      }
      pending.push({
        locationId: location.id,
        revisionId: revision.id,
        revisionCreated: revision.created,
        revisionParseStatus: revision.parseStatus,
        relativePath: action.relativePath,
        rawArchivePath: snapshot.rawArchivePath,
        sha256: snapshot.sha256,
        sourceFingerprint: snapshot.sourceFingerprint,
      });
      progress("Сохранение новых и изменённых файлов", ++snapshotsDone, snapshotTotal);
    }

    // --- Phase C: parse + canonical write (§9.3 шаги 4–7, §10.4) ---
    args.timing.next("parse_and_write");
    // Парсим все new/changed, даже если revision с таким SHA уже существует
    // (файл «откатился» к старому содержимому): writer идемпотентен — найдёт
    // существующую dialogue_revision и переключит current на неё (§10.5).
    // На обычном пути (fingerprint совпал) файлы сюда не попадают, поэтому
    // повторный sync не парсит ничего (§19.2 №1).
    const ingestCtx: IngestContext = {
      db,
      syncRun: syncRunId,
      host: hostId,
      harnessInstallation: installation,
      installationKey: installation.toString(),
      osAccount: args.osAccountId,
      parser: tools.parser,
      extractors: tools.extractors,
      activeEmbeddingSpaces: args.activeSpaces,
      enqueueEmbeddings: args.enqueueEmbeddings,
      embeddingTables: args.embeddingTables,
    };

    /** Итоги re-parse по revision для fail-closed разрешения после parsed. */
    const parseResults = new Map<string, { revisionId: RecordId; status: string }>();

    const applyOutcomeToRevision = async (
      p: PendingParse,
      result: IngestOutcome,
      dialoguesDiscovered: number,
    ) => {
      await updateSourceRevisionParse(db, p.revisionId, {
        parseStatus: result.status,
        dialoguesDiscovered,
        canonicalHash: result.canonicalHash,
      });
      parseResults.set(p.revisionId.toString(), {
        revisionId: p.revisionId,
        status: result.status,
      });
      // §23.3: успех — только "parsed"; partial НЕ считается успешным parse.
      const parsedOk = result.status === "parsed";
      await setLocationRevisions(db, p.locationId, {
        currentRevision: p.revisionId,
        lastSuccessfulRevision: parsedOk ? p.revisionId : undefined,
      });
      if (p.sourceFingerprint && (result.status === "parsed" || result.status === "unsupported")) {
        args.observations.set(p.locationId.toString(), {
          revision: p.revisionId.toString(), pipeline, fingerprint: p.sourceFingerprint, status: result.status,
        });
      } else {
        args.observations.delete(p.locationId.toString());
      }
    };

    /**
     * Re-parse (обычно после фикса parser'а) заменяет прежний результат
     * только при status=parsed. Unsupported/partial/parse_error остаются
     * актуальным quarantine и не могут быть скрыты новым неуспехом.
     */
    const resolveStaleErrors = async () => {
      const parsed = [...parseResults.values()]
        .filter((result) => result.status === "parsed")
        .map((result) => result.revisionId);
      if (parsed.length > 0) {
        await resolveStaleIngestErrors(db, parsed, syncRunId, "reparse:parsed");
      }
    };

    /** Счётчики начисляются один раз за parse (а не за каждый файл сессии). */
    const accumulateOutcome = (result: IngestOutcome) => {
      outcome.errors += result.errors;
      outcome.dialoguesWritten += result.dialoguesWritten;
      outcome.messagesWritten += result.messagesWritten;
      outcome.chunksWritten += result.chunksWritten;
      outcome.searchDocuments += result.searchDocumentsWritten;
      outcome.embeddingJobs += result.embeddingJobsCreated;
    };

    if (tools.parseUnit === "file") {
      let parsed = 0;
      progress("Обработка диалогов", 0, pending.length);
      for (const p of pending) {
        const result = await ingestSourceRevision(ingestCtx, {
          sourceRevision: p.revisionId,
          parsePath: p.rawArchivePath,
          relativePath: p.relativePath,
          harnessSlug: slug,
        });
        await applyOutcomeToRevision(p, result, result.dialoguesDiscovered);
        accumulateOutcome(result);
        log({
          event: "revision_parsed",
          path: p.relativePath,
          status: result.status,
          dialogues: result.dialoguesWritten,
          failed: result.dialoguesFailed,
          errors: result.errors,
        });
        progress("Обработка диалогов", ++parsed, pending.length);
      }
    } else {
      // kimi-session: parse unit = каталог сессии, собранный из raw-файлов.
      const bySession = new Map<string, PendingParse[]>();
      progress("Подготовка диалогов");
      for (const p of pending) {
        const session = kimiSessionDir(p.relativePath);
        if (!session) {
          // session_index.jsonl и прочие не-диалоговые файлы: raw архивируется,
          // но не парсится (docs/sources.md — индекс, а не диалог).
          await updateSourceRevisionParse(db, p.revisionId, {
            parseStatus: "unsupported",
            dialoguesDiscovered: 0,
          });
          await setLocationRevisions(db, p.locationId, { currentRevision: p.revisionId });
          if (p.sourceFingerprint) args.observations.set(p.locationId.toString(), {
            revision: p.revisionId.toString(), pipeline, fingerprint: p.sourceFingerprint, status: "unsupported",
          });
          continue;
        }
        const group = bySession.get(session) ?? [];
        group.push(p);
        bySession.set(session, group);
      }
      let viewCounter = 0;
      let sessionsDone = 0;
      progress("Обработка диалогов", 0, bySession.size, "сессий");
      for (const [sessionDir, group] of bySession) {
        const viewDir = path.join(
          cfg.archiveRoot,
          "staging",
          runId,
          "views",
          `${viewCounter++}`,
          path.basename(sessionDir), // parser выводит sessionId из имени каталога
        );
        try {
          const viewReady = await buildSessionView(
            cfg.archiveRoot,
            viewDir,
            sessionDir,
            group,
            prevByPath,
            scanByPath,
            failedSnapshotPaths,
          );
          if (viewReady !== true) {
            // Сессия НЕ пересобирается и НЕ переключается на этом sync
            // (§9.3, §23.4): revision'ы группы остаются "pending",
            // current_revision location'ов не двигается — честный retry
            // на следующем sync.
            log({ event: "session_view_skipped", session: sessionDir, reason: viewReady });
            continue;
          }
          // dialogue_revision.source_revision — revision основного wire-файла.
          const primary =
            group.find((p) => p.relativePath.endsWith("/agents/main/wire.jsonl")) ?? group[0]!;
          const result = await ingestSourceRevision(ingestCtx, {
            sourceRevision: primary.revisionId,
            parsePath: viewDir,
            relativePath: sessionDir,
            harnessSlug: slug,
          });
          for (const p of group) {
            await applyOutcomeToRevision(p, result, p === primary ? result.dialoguesDiscovered : 0);
          }
          accumulateOutcome(result);
          log({
            event: "session_parsed",
            session: sessionDir,
            status: result.status,
            dialogues: result.dialoguesWritten,
            errors: result.errors,
          });
        } finally {
          await rm(viewDir, { recursive: true, force: true }).catch(() => {});
          progress("Обработка диалогов", ++sessionsDone, bySession.size, "сессий");
        }
      }
    }

    // Разрешение старых ingest_errors по всем re-parse'нутым revision (батчи).
    progress("Обновление списка ошибок");
    args.timing.next("resolve_errors");
    await resolveStaleErrors();

    // --- Phase D: presence (§10.6) + rename detection (§10.7) ---
    args.timing.next("presence");
    const scanComplete = scan.status === "complete";
    const transitions = new Map(
      reconcile.actions
        .filter((a) => a.kind === "missing" || a.kind === "deleted")
        .map((a) => [a.relativePath, a.kind] as const),
    );
    let locationsDone = 0;
    const presenceGroups = new Map<string, {
      ids: RecordId[]; presenceStatus: string; missingCompleteScans: number;
      seen: boolean; missingSinceAt?: Date; deletedAt?: Date;
    }>();
    const presenceTime = new Date();
    progress("Проверка удалённых файлов", 0, prevRows.length);
    for (const loc of reconcile.locations) {
      const row = prevByPath.get(loc.relativePath);
      if (!row) continue; // новые location'ы уже записаны в phase B
      const seen = seenPaths.has(loc.relativePath);
      if (!seen && !scanComplete) continue;
      const transition = transitions.get(loc.relativePath);
      if (!seen) outcome.filesMissing += 1;
      const key = JSON.stringify([seen, loc.presence.status, loc.presence.missingCompleteScans, transition]);
      let group = presenceGroups.get(key);
      if (!group) {
        group = {
          ids: [], presenceStatus: loc.presence.status, missingCompleteScans: loc.presence.missingCompleteScans,
          seen, missingSinceAt: transition === "missing" ? presenceTime : undefined,
          deletedAt: transition === "deleted" ? presenceTime : undefined,
        };
        presenceGroups.set(key, group);
      }
      group.ids.push(row.id);
      if (transition) log({ event: `location_${transition}`, path: loc.relativePath });
    }
    for (const group of presenceGroups.values()) {
      for (let offset = 0; offset < group.ids.length; offset += 250) {
        const ids = group.ids.slice(offset, offset + 250);
        await updateLocationPresence(db, ids, group);
        locationsDone += ids.length;
        progress("Проверка удалённых файлов", locationsDone, prevRows.length);
      }
    }
    progress("Проверка удалённых файлов", locationsDone, prevRows.length);

    // Rename detection (§10.7): sha новых файлов известны после phase B.
    // Неудавшийся snapshot нового файла создавал бы ложную однозначность
    // (невидимый второй кандидат) — detection пропускаем до следующего sync.
    progress("Поиск переименованных файлов");
    args.timing.next("renames");
    if (scanComplete && !newSnapshotFailed) {
      const missingStates = reconcile.locations.filter(
        (l) => !seenPaths.has(l.relativePath) && l.presence.status !== "active",
      );
      const newFiles = pending
        .filter((p) => newLocationIds.has(p.relativePath))
        .map((p) => {
          const file = scanByPath.get(p.relativePath)!;
          return {
            relativePath: p.relativePath,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
            sha256: p.sha256,
          };
        });
      const activeStates = reconcile.locations.filter((l) => l.presence.status === "active");
      for (const match of detectRenames(missingStates, newFiles, activeStates)) {
        const fromRow = prevByPath.get(match.from);
        const toId = newLocationIds.get(match.to);
        if (fromRow && toId) {
          await setLocationRenamedFrom(db, toId, fromRow.id);
          log({ event: "rename_detected", from: match.from, to: match.to });
        }
      }
    } else if (scanComplete && newSnapshotFailed) {
      log({ event: "rename_detection_skipped", reason: "snapshot нового файла не удался" });
    }

    progress("Сохранение итогов источника");
    args.timing.next("scan_finish");
    if (scanId) {
      await finishSourceScan(db, scanId, {
        filesNew: outcome.filesNew,
        filesChanged: outcome.filesChanged,
        filesMissing: outcome.filesMissing,
        errors: outcome.errors,
      });
    }
    return outcome;
  } catch (error) {
    // Scan не должен зависнуть незавершённым (finished_at = NONE) при сбое
    // фаз B–D: фиксируем счётчики и пробрасываем ошибку дальше.
    args.timing.next("scan_error_finalize", "failed");
    if (scanId) {
      await finishSourceScan(db, scanId, {
        filesNew: outcome.filesNew,
        filesChanged: outcome.filesChanged,
        filesMissing: outcome.filesMissing,
        errors: outcome.errors + 1,
      }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Parse-view каталога сессии kimi-code из immutable raw-файлов (hardlink'и):
 * изменившиеся файлы — из свежих snapshot'ов, неизменившиеся — из текущих
 * revisions в БД. Parser читает только immutable raw (§9.3).
 *
 * Crash-safe граница (§9.3, §23.4): view собирается только из ПОЛНОГО
 * набора файлов сессии. Snapshot failure ЛЮБОГО файла сессии или файл без
 * прежнего raw (ещё ни разу не snapshot'нутый) → возвращаем причину
 * (string), а не смешанный view: parse устаревшего набора мог бы
 * переключить dialogue.current_revision на неконсистентное содержимое.
 * Возврат true — view готов.
 */
async function buildSessionView(
  archiveRoot: string,
  viewDir: string,
  sessionDir: string,
  group: PendingParse[],
  prevByPath: Map<string, LocationRow>,
  scanByPath: Map<string, { relativePath: string }>,
  failedSnapshotPaths: Set<string>,
): Promise<true | string> {
  const groupByPath = new Map(group.map((p) => [p.relativePath, p]));
  const files: Array<{ relInSession: string; rawPath: string }> = [];
  for (const relPath of scanByPath.keys()) {
    if (!relPath.startsWith(`${sessionDir}/`)) continue;
    const relInSession = relPath.slice(sessionDir.length + 1);
    if (failedSnapshotPaths.has(relPath)) return `snapshot_failed: ${relPath}`;
    const changed = groupByPath.get(relPath);
    if (changed) {
      files.push({ relInSession, rawPath: changed.rawArchivePath });
      continue;
    }
    const prev = prevByPath.get(relPath);
    // В БД raw_archive_path хранится относительно archiveRoot.
    if (prev?.raw_archive_path) {
      files.push({ relInSession, rawPath: path.join(archiveRoot, prev.raw_archive_path) });
      continue;
    }
    return `no_raw: ${relPath}`;
  }
  if (files.length === 0) return "empty_session";
  await mkdir(viewDir, { recursive: true });
  for (const file of files) {
    const target = path.join(viewDir, file.relInSession);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await link(file.rawPath, target);
    } catch {
      await copyFile(file.rawPath, target);
    }
  }
  return true;
}
