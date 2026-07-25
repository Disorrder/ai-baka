/**
 * Structured sync — orchestrator live sync (docs/plan.md §10, этап 5).
 *
 * Порядок запуска (§10.1): preflight → schema version → lock → sync_run →
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
import {
  HARNESSES,
  type HarnessSlug,
} from "../sources/adapters/harnesses.ts";
import { HARNESS_FILE_MATCHERS } from "../sources/adapters/file-matchers.ts";
import { discoverSourceRoots, type DiscoveredSourceRoot } from "../sources/discovery/discovery.ts";
import { scanSourceRoot } from "../sources/scanning/scanner.ts";
import { snapshotSource, SnapshotError } from "../sources/snapshot/raw-snapshot.ts";
import {
  detectRenames,
  reconcileLocations,
  type LocationState,
  type ScanFileInfo,
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

export interface SyncOptions {
  harness?: HarnessSlug;
  /** Точный путь root'а — ограничить sync одним root'ом. */
  sourceRoot?: string;
  fullRescan?: boolean;
  deletionConfirmations?: number;
  /** По умолчанию true; --no-enqueue-embeddings выключает. */
  enqueueEmbeddings?: boolean;
  dryRun?: boolean;
  /** false — пропустить assertPreflight (integration-тесты на temp dirs). */
  preflight?: boolean;
  hostIdPath?: string;
  logger?: (event: Record<string, unknown>) => void;
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

interface PendingParse {
  locationId: RecordId;
  revisionId: RecordId;
  revisionCreated: boolean;
  revisionParseStatus?: string;
  relativePath: string;
  rawArchivePath: string;
  sha256: string;
}

interface RootOutcome {
  filesSeen: number;
  filesNew: number;
  filesChanged: number;
  filesMissing: number;
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
    errors: 0,
    revisionsCreated: 0,
    dialoguesWritten: 0,
    messagesWritten: 0,
    chunksWritten: 0,
    searchDocuments: 0,
    embeddingJobs: 0,
  };
}

export async function runSync(cfg: AppConfig, options: SyncOptions = {}): Promise<SyncSummary> {
  const log = options.logger ?? defaultLogger;
  const deletionConfirmations = options.deletionConfirmations ?? cfg.deletionConfirmations;
  const enqueueEmbeddings = options.enqueueEmbeddings ?? true;
  const dryRun = options.dryRun ?? false;
  const counters: Record<string, number> = {
    roots: 0,
    filesSeen: 0,
    filesNew: 0,
    filesChanged: 0,
    filesMissing: 0,
    revisionsCreated: 0,
    dialoguesWritten: 0,
    messagesWritten: 0,
    chunksWritten: 0,
    searchDocuments: 0,
    embeddingJobs: 0,
    ingestErrors: 0,
  };
  const errors: string[] = [];

  if (options.preflight !== false) await assertPreflight(cfg);
  const release = await acquireLock(cfg.archiveRoot, dryRun ? "sync --dry-run" : "sync");
  let db: Surreal | undefined;
  let syncRunId: RecordId | undefined;
  let runStatus = "failed";
  let primaryError: unknown;
  try {
    // connectDb внутри try: при ошибке подключения lock обязан освободиться.
    db = await connectDb(cfg);
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
    const discovery = await discoverSourceRoots({ overrides: cfg.sourceOverrides });
    let roots = discovery.roots;
    if (options.harness) roots = roots.filter((r) => r.harness === options.harness);
    if (options.sourceRoot) roots = roots.filter((r) => r.path === options.sourceRoot);

    if (!dryRun) {
      syncRunId = await createSyncRun(db, {
        kind: "live_sync",
        host: hostId!,
        bakaCommit: gitHead(),
        schemaVersion,
        configurationFingerprint: JSON.stringify({
          harness: options.harness ?? null,
          sourceRoot: options.sourceRoot ?? null,
          fullRescan: options.fullRescan ?? false,
          deletionConfirmations,
          enqueueEmbeddings,
        }),
      });
    }
    log({ event: "sync_start", syncRun: syncRunId?.toString(), dryRun, roots: roots.length });

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

    for (const root of roots) {
      counters.roots += 1;
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
          fullRescan: options.fullRescan ?? false,
          dryRun,
          log,
        });
        counters.filesSeen += outcome.filesSeen;
        counters.filesNew += outcome.filesNew;
        counters.filesChanged += outcome.filesChanged;
        counters.filesMissing += outcome.filesMissing;
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
      }
    }

    runStatus = errors.length > 0 || counters.ingestErrors > 0 ? "completed_with_errors" : "completed";
  } catch (error) {
    runStatus = "failed";
    errors.push(error instanceof Error ? error.message : String(error));
    primaryError = error;
  } finally {
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
    if (db) await db.close().catch(() => {});
    await release();
  }

  if (primaryError) throw primaryError;
  return { status: runStatus, syncRunId: syncRunId?.toString(), counters, errors };
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
  fullRescan: boolean;
  dryRun: boolean;
  log: Logger;
}

async function processSourceRoot(
  db: Surreal,
  cfg: AppConfig,
  args: ProcessRootArgs,
): Promise<RootOutcome> {
  const { root, log } = args;
  const slug = root.harness;
  const tools = HARNESS_TOOLS[slug];
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

  // §10.2: обход root'а с явным статусом полноты.
  const scanStarted = new Date();
  const scan = await scanSourceRoot(root.path, HARNESS_FILE_MATCHERS[slug]);
  outcome.filesSeen = scan.files.length;
  outcome.errors += scan.errors.length;
  log({
    event: "root_scan",
    root: root.path,
    status: scan.status,
    files: scan.files.length,
    scanErrors: scan.errors.length,
  });

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
    const prevRows = rootId ? await listLocations(db, rootId) : [];
    const prevByPath = new Map(prevRows.map((r) => [r.relative_path, r]));
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

    // Root может быть одиночным файлом (~/.kimi-code/session_index.jsonl):
    // тогда relativePath = basename, а исходный путь — сам root.
    const rootIsFile = (await stat(root.path).catch(() => undefined))?.isFile() ?? false;

    // §10.3: при совпадении size/mtime с прежней revision сверяем head_hash —
    // изменение файла с сохранёнными size/mtime не должно теряться. Первые
    // 64 КБ читаются ТОЛЬКО для таких файлов; mtime_ms в схеме — int,
    // fingerprint нормализуем к семантике хранения.
    const scanFiles: ScanFileInfo[] = scan.files.map((f) => ({
      ...f,
      mtimeMs: Math.round(f.mtimeMs),
    }));
    for (const f of scanFiles) {
      const prev = prevByPath.get(f.relativePath);
      if (!prev?.head_hash) continue;
      if (prev.size_bytes !== f.sizeBytes || prev.mtime_ms !== f.mtimeMs) continue;
      const fullPath = rootIsFile ? root.path : path.join(root.path, f.relativePath);
      // null (не прочитался) → sentinel, гарантированно не совпадающий с
      // sha256-hex в БД: файл считается changed, полный snapshot зафиксирует
      // настоящую ошибку чтения.
      f.headHash = (await headFileHash(fullPath)) ?? `unreadable:${f.relativePath}`;
    }

    const reconcile = reconcileLocations(
      previous,
      { status: scan.status, files: scanFiles },
      { deletionConfirmations: args.deletionConfirmations },
    );
    const scanByPath = new Map(scan.files.map((f) => [f.relativePath, f]));
    const seenPaths = new Set(scan.files.map((f) => f.relativePath));

    if (args.dryRun) {
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
    const runId = syncRunId.toString().replaceAll(":", "_");
    const pending: PendingParse[] = [];
    const newLocationIds = new Map<string, RecordId>();
    /** Файлы с неудавшимся snapshot — для crash-safe границы parse-view (§9.3). */
    const failedSnapshotPaths = new Set<string>();
    /** Неудавшийся snapshot НОВОГО файла: rename detection пропускаем (§10.7). */
    let newSnapshotFailed = false;
    const actions = reconcile.actions.map((a) =>
      args.fullRescan && a.kind === "unchanged" ? { kind: "changed" as const, relativePath: a.relativePath } : a,
    );
    for (const action of actions) {
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
        snapshot = await snapshotSource(originalPath, {
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
          stage: "snapshot",
          errorCode: error instanceof SnapshotError ? "snapshot_failed" : "snapshot_exception",
          // Путь в сообщении: иначе голое "unable to open database file"
          // из bun:sqlite не привязано к источнику (live acceptance, этап 8).
          errorMessage:
            `${action.relativePath}: ` +
            (error instanceof Error ? error.message : String(error)),
        });
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
      log({
        event: "snapshot",
        path: action.relativePath,
        sha256: snapshot.sha256.slice(0, 12),
        reused: snapshot.reused,
        revisionCreated: revision.created,
      });
      pending.push({
        locationId: location.id,
        revisionId: revision.id,
        revisionCreated: revision.created,
        revisionParseStatus: revision.parseStatus,
        relativePath: action.relativePath,
        rawArchivePath: snapshot.rawArchivePath,
        sha256: snapshot.sha256,
      });
    }

    // --- Phase C: parse + canonical write (§9.3 шаги 4–7, §10.4) ---
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

    /** Итоги re-parse по revision для bulk-разрешения старых ingest_errors. */
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
    };

    /**
     * Re-parse (обычно после фикса parser'а) заменяет прежний результат:
     * старые unresolved ingest_errors этих revision — исторические
     * дубликаты, закрываем их батчами (§7.2 resolved_at/resolution).
     */
    const resolveStaleErrors = async () => {
      const byStatus = new Map<string, RecordId[]>();
      for (const { revisionId, status } of parseResults.values()) {
        const list = byStatus.get(status) ?? [];
        list.push(revisionId);
        byStatus.set(status, list);
      }
      for (const [status, ids] of byStatus) {
        await resolveStaleIngestErrors(db, ids, syncRunId, `reparse:${status}`);
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
      }
    } else {
      // kimi-session: parse unit = каталог сессии, собранный из raw-файлов.
      const bySession = new Map<string, PendingParse[]>();
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
          continue;
        }
        const group = bySession.get(session) ?? [];
        group.push(p);
        bySession.set(session, group);
      }
      let viewCounter = 0;
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
        }
      }
    }

    // Разрешение старых ingest_errors по всем re-parse'нутым revision (батчи).
    await resolveStaleErrors();

    // --- Phase D: presence (§10.6) + rename detection (§10.7) ---
    const scanComplete = scan.status === "complete";
    const transitions = new Map(
      reconcile.actions
        .filter((a) => a.kind === "missing" || a.kind === "deleted")
        .map((a) => [a.relativePath, a.kind] as const),
    );
    for (const loc of reconcile.locations) {
      const row = prevByPath.get(loc.relativePath);
      if (!row) continue; // новые location'ы уже записаны в phase B
      if (seenPaths.has(loc.relativePath)) {
        await updateLocationPresence(db, row.id, {
          presenceStatus: loc.presence.status,
          missingCompleteScans: loc.presence.missingCompleteScans,
          seen: true,
        });
        continue;
      }
      if (!scanComplete) continue; // неполный scan не двигает отсутствие (§10.6)
      outcome.filesMissing += 1;
      const transition = transitions.get(loc.relativePath);
      await updateLocationPresence(db, row.id, {
        presenceStatus: loc.presence.status,
        missingCompleteScans: loc.presence.missingCompleteScans,
        seen: false,
        missingSinceAt: transition === "missing" ? new Date() : undefined,
        deletedAt: transition === "deleted" ? new Date() : undefined,
      });
      if (transition) log({ event: `location_${transition}`, path: loc.relativePath });
    }

    // Rename detection (§10.7): sha новых файлов известны после phase B.
    // Неудавшийся snapshot нового файла создавал бы ложную однозначность
    // (невидимый второй кандидат) — detection пропускаем до следующего sync.
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
