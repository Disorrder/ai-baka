/**
 * `baka status` (docs/plan.md §17.2) — сводка состояния архива.
 *
 * Состояние корпуса читается из SurrealDB, а durable backup/restore
 * артефакты — из archiveRoot. Status ничего не создаёт и не изменяет.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "./config.ts";
import { connectDb } from "./db/client.ts";
import { selectAll, selectOne } from "./db/repositories/helpers.ts";
import {
  manifestPathForExport,
  parseBackupManifest,
  type BackupManifest,
} from "./backup/backup.ts";
import { resolveVerifiedOffDeviceLogicalArtifact } from "./backup/off-device.ts";
import { hashRawManifest, parseRawManifest } from "./backup/raw-verify.ts";
import {
  parsePersistedRestoreTestReport,
  type PersistedRestoreTestReport,
} from "./backup/restore-test.ts";
import { assertRegularNonSymlinkFile } from "./backup/safety.ts";
import { hashFile } from "./sources/snapshot/hashing.ts";

async function count(db: Surreal, table: string, where?: string): Promise<number> {
  const row = await selectOne<{ n: number }>(
    db,
    `SELECT count() AS n FROM ${table}${where ? ` WHERE ${where}` : ""} GROUP ALL`,
  );
  return row?.n ?? 0;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

export interface LastSyncStatus {
  id: string;
  status: "completed";
  startedAt: string;
  finishedAt: string;
}

export interface LastBackupStatus {
  createdAt: string;
  database: string;
  exportPath: string;
  exportFile: string;
  manifestPath: string;
  manifestFile: string;
  schemaVersion: number;
  exportBytes: number;
  exportSha256: string;
  manifestSha256: string;
  rawManifestSha256?: string;
}

export interface LastRestoreStatus {
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  runId: string;
  attemptId: string;
  namespace: string;
  database: string;
  archiveRoot: string;
  exportFile: string;
  reportFile: string;
  checks: number;
  exportSha256: string;
  manifestSha256: string;
  artifactSource: "local_archive" | "off_device_bundle";
  bundleBackupId?: string;
  schemaVersion: number;
  rawManifestSha256: string;
  integrity: "verified";
  externalTrust: "local_archive_boundary_required" | "external_provenance_required";
}

export interface LastRawManifestStatus {
  createdAt: string;
  manifestPath: string;
  manifestFile: string;
  canonicalSha256: string;
  fileSha256: string;
  entries: number;
}

export interface BackupRecoveryChainStatus {
  backup: LastBackupStatus;
  restore: LastRestoreStatus & {
    artifactSource: "off_device_bundle";
    bundleBackupId: string;
  };
  rawManifest: LastRawManifestStatus;
  offDevice: {
    backupId: string;
    bundlePath: string;
    bundleManifestSha256: string;
  };
  integrity: "verified";
  externalTrust: "external_provenance_required";
  cutover: "not_asserted";
}

export interface MigrationReconciliationStatus {
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  legacyTotal: number;
  matched: number;
  inserted: number;
  quarantined: number;
  accounted: number;
  lost: number;
  ok: boolean;
}

export interface StatusReport {
  hosts: number;
  osAccounts: number;
  harnessInstallations: number;
  sourceRoots: number;
  locations: { active: number; missing: number; deleted_in_source: number };
  sourceRevisions: number;
  parseErrors: number;
  unresolvedIngestErrors: number;
  dialogues: number;
  dialogueRevisions: number;
  dialoguesWithoutCurrent: number;
  messages: number;
  chunks: number;
  searchDocuments: number;
  embeddingSpaces: number;
  embeddingJobs: Record<string, number>;
  rawBytes: number;
  dbBytes: number;
  lastSync?: LastSyncStatus;
  lastBackup?: LastBackupStatus;
  lastSuccessfulRestore?: LastRestoreStatus;
  recoveryChain?: BackupRecoveryChainStatus;
  migrationReconciliation?: MigrationReconciliationStatus;
}

export type DatabaseStatus = Omit<
  StatusReport,
  "rawBytes" | "dbBytes" | "lastBackup" | "lastSuccessfulRestore" | "recoveryChain"
>;

interface DbSyncRow {
  id: unknown;
  status: string;
  started_at: unknown;
  finished_at: unknown;
}

interface DbMigrationRow {
  id: unknown;
  status: string;
  started_at: unknown;
  finished_at?: unknown;
  counters?: unknown;
}

/** Кандидаты: source_scan boundary применяется в TS, без Surreal subquery ambiguity. */
export const COMPLETED_LIVE_SYNCS_SQL =
  `SELECT id, status, started_at, finished_at FROM sync_run
   WHERE kind = 'live_sync' AND status = 'completed' AND finished_at IS NOT NONE
   ORDER BY started_at DESC`;

export const INCOMPLETE_LIVE_SYNC_SCANS_SQL =
  "SELECT VALUE sync_run FROM source_scan WHERE status != 'complete'";

/** Running migration без итоговых counters не скрывает последний reconciliation. */
export const LATEST_MIGRATION_RECONCILIATION_SQL =
  `SELECT id, status, started_at, finished_at, counters FROM migration_meta
   WHERE counters IS NOT NONE ORDER BY started_at DESC LIMIT 1`;

function isoDate(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Testable database seam; caller owns and closes the connection. */
export async function collectDatabaseStatus(db: Surreal): Promise<DatabaseStatus> {
  const jobs: Record<string, number> = {};
  for (const row of await selectAll<{ status: string; n: number }>(
    db,
    "SELECT status, count() AS n FROM embedding_job GROUP BY status",
  )) {
    jobs[row.status] = row.n;
  }

  const completedSyncRows = await selectAll<DbSyncRow>(db, COMPLETED_LIVE_SYNCS_SQL);
  const incompleteSyncIds = await selectAll<unknown>(db, INCOMPLETE_LIVE_SYNC_SCANS_SQL);
  const incomplete = new Set(incompleteSyncIds.map(String));
  // A run with partial/unavailable source_scan is not the "last complete
  // sync" even when sync_run itself reached completed without ingest errors.
  const lastSyncRow = completedSyncRows.find((row) => !incomplete.has(String(row.id)));
  const startedAt = isoDate(lastSyncRow?.started_at);
  const finishedAt = isoDate(lastSyncRow?.finished_at);
  const lastSync = lastSyncRow?.status === "completed" && startedAt && finishedAt
    ? {
        id: String(lastSyncRow.id),
        status: "completed" as const,
        startedAt,
        finishedAt,
      }
    : undefined;

  const migrationRow = await selectOne<DbMigrationRow>(
    db,
    LATEST_MIGRATION_RECONCILIATION_SQL,
  );
  const counters = objectValue(migrationRow?.counters);
  // Stage 10 stores the whole MigrationRunReport in migration_meta.counters.
  // Accept direct reconciliation too, which keeps status compatible with
  // early/manual imports and makes the reader forward-compatible.
  const reconciliation = objectValue(counters?.reconciliation) ?? counters;
  const migrationStartedAt = isoDate(migrationRow?.started_at);
  const legacyTotal = finiteNumber(reconciliation?.legacyTotal);
  const matched = finiteNumber(reconciliation?.matched);
  const inserted = finiteNumber(reconciliation?.inserted);
  const quarantined = finiteNumber(reconciliation?.quarantined);
  const accounted = finiteNumber(reconciliation?.accounted);
  const lost = finiteNumber(reconciliation?.lost);
  const migrationReconciliation = migrationRow && migrationStartedAt !== undefined &&
      legacyTotal !== undefined && matched !== undefined && inserted !== undefined &&
      quarantined !== undefined && accounted !== undefined && lost !== undefined &&
      typeof reconciliation?.ok === "boolean"
    ? {
        id: String(migrationRow.id),
        status: migrationRow.status,
        startedAt: migrationStartedAt,
        finishedAt: isoDate(migrationRow.finished_at),
        legacyTotal,
        matched,
        inserted,
        quarantined,
        accounted,
        lost,
        ok: reconciliation.ok,
      }
    : undefined;

  return {
    hosts: await count(db, "host"),
    osAccounts: await count(db, "os_account"),
    harnessInstallations: await count(db, "harness_installation"),
    sourceRoots: await count(db, "source_root"),
    locations: {
      active: await count(db, "source_location", "presence_status = 'active'"),
      missing: await count(db, "source_location", "presence_status = 'missing'"),
      deleted_in_source: await count(
        db,
        "source_location",
        "presence_status = 'deleted_in_source'",
      ),
    },
    sourceRevisions: await count(db, "source_revision"),
    parseErrors: await count(db, "source_revision", "parse_status = 'parse_error'"),
    unresolvedIngestErrors: await count(db, "ingest_error", "resolved_at IS NONE"),
    dialogues: await count(db, "dialogue"),
    dialogueRevisions: await count(db, "dialogue_revision"),
    dialoguesWithoutCurrent: await count(db, "dialogue", "current_revision IS NONE"),
    messages: await count(db, "message"),
    chunks: await count(db, "chunk"),
    searchDocuments: await count(db, "search_document"),
    embeddingSpaces: await count(db, "embedding_space"),
    embeddingJobs: jobs,
    lastSync,
    migrationReconciliation,
  };
}

async function jsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return objectValue(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    // Незавершённый/чужой JSON не должен ломать read-only status.
    return undefined;
  }
}

function newest<T extends { createdAt: string }>(values: T[]): T | undefined {
  return values.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

interface VerifiedBackupArtifact {
  manifest: BackupManifest;
  exportPath: string;
  manifestPath: string;
  manifestFile: string;
  manifestSha256: string;
}

async function verifiedBackupArtifact(
  manifestPathInput: string,
  exportPathInput: string,
): Promise<VerifiedBackupArtifact | undefined> {
  try {
    const manifestPath = await assertRegularNonSymlinkFile(
      manifestPathInput,
      "status logical manifest",
    );
    const manifest = parseBackupManifest(
      JSON.parse(await readFile(manifestPath, "utf8")),
      manifestPath,
    );
    if (manifest.schemaVersion >= 5 && !manifest.rawManifestSha256) return undefined;
    const exportPath = await assertRegularNonSymlinkFile(
      exportPathInput,
      "status logical export",
    );
    if (manifest.exportFile !== path.basename(exportPath) ||
        path.resolve(manifestPathForExport(exportPath)) !== path.resolve(manifestPath)) return undefined;
    const exportHashes = await hashFile(exportPath);
    if (
      exportHashes.sizeBytes !== manifest.exportBytes ||
      exportHashes.sha256 !== manifest.exportSha256
    ) return undefined;
    const manifestHashes = await hashFile(manifestPath);
    return {
      manifest,
      exportPath,
      manifestPath,
      manifestFile: path.basename(manifestPath),
      manifestSha256: manifestHashes.sha256,
    };
  } catch {
    return undefined;
  }
}

/** Последний существующий logical export с полностью записанным manifest'ом. */
export async function findLastLogicalBackup(archiveRoot: string): Promise<LastBackupStatus | undefined> {
  const resolvedArchiveRoot = path.resolve(archiveRoot);
  const manifestsDir = path.join(resolvedArchiveRoot, "backups", "manifests");
  const candidates: LastBackupStatus[] = [];
  for (const manifestPath of await jsonFiles(manifestsDir)) {
    // Derive both supported export names from the manifest basename. Do not
    // read the JSON before verifiedBackupArtifact rejects a symlink leaf.
    const base = path.basename(manifestPath, ".json");
    let verified: VerifiedBackupArtifact | undefined;
    for (const suffix of [".surql.zst", ".surql.gz"]) {
      verified = await verifiedBackupArtifact(
        manifestPath,
        path.join(resolvedArchiveRoot, "backups", "surreal", `${base}${suffix}`),
      );
      if (verified) break;
    }
    if (!verified) continue;
    const { manifest } = verified;
    candidates.push({
      createdAt: new Date(manifest.createdAt).toISOString(),
      database: manifest.database,
      exportPath: verified.exportPath,
      exportFile: manifest.exportFile,
      manifestPath: verified.manifestPath,
      manifestFile: verified.manifestFile,
      schemaVersion: manifest.schemaVersion,
      exportBytes: manifest.exportBytes,
      exportSha256: manifest.exportSha256,
      manifestSha256: verified.manifestSha256,
      ...(manifest.rawManifestSha256
        ? { rawManifestSha256: manifest.rawManifestSha256 }
        : {}),
    });
  }
  return newest(candidates);
}

interface RestoreCandidate {
  report: PersistedRestoreTestReport;
  status: LastRestoreStatus;
  offDevice?: Awaited<ReturnType<typeof resolveVerifiedOffDeviceLogicalArtifact>>;
}

function restoreMatchesBackup(
  report: PersistedRestoreTestReport,
  backup: LastBackupStatus,
): boolean {
  return report.database === backup.database &&
    report.exportFile === backup.exportFile &&
    report.exportBytes === backup.exportBytes &&
    report.exportSha256 === backup.exportSha256 &&
    report.manifestFile === backup.manifestFile &&
    report.manifestSha256 === backup.manifestSha256 &&
    report.rawManifestSha256 === backup.rawManifestSha256 &&
    report.schemaVersion === backup.schemaVersion &&
    Date.parse(report.finishedAt) >= Date.parse(backup.createdAt);
}

async function matchingRestoreCandidate(
  archiveRoot: string,
  latestLocalBackup: LastBackupStatus,
): Promise<RestoreCandidate | undefined> {
  const directories = [
    path.join(archiveRoot, "backups", "manifests"),
    path.join(archiveRoot, "backups", "reports"),
  ];
  const files = (await Promise.all(directories.map(jsonFiles))).flat();
  const candidates: RestoreCandidate[] = [];
  for (const reportPath of files) {
    if (!/^restore-(?:test|report)(?:[-_].*)?\.json$/i.test(path.basename(reportPath))) continue;
    try {
      await assertRegularNonSymlinkFile(reportPath, "status restore report");
    } catch {
      continue;
    }
    let report: PersistedRestoreTestReport;
    try {
      report = parsePersistedRestoreTestReport(await readJson(reportPath));
    } catch {
      continue;
    }
    if (!restoreMatchesBackup(report, latestLocalBackup)) continue;

    let verified: VerifiedBackupArtifact | undefined;
    let artifactSource: LastRestoreStatus["artifactSource"];
    let offDevice: RestoreCandidate["offDevice"];
    const localArchiveRoot = path.resolve(archiveRoot);
    if (report.archiveRoot === localArchiveRoot) {
      verified = await verifiedBackupArtifact(
        latestLocalBackup.manifestPath,
        latestLocalBackup.exportPath,
      );
      if (
        report.exportPath !== latestLocalBackup.exportPath ||
        report.manifestPath !== latestLocalBackup.manifestPath
      ) continue;
      artifactSource = "local_archive";
    } else if (path.basename(report.archiveRoot) === "archive") {
      try {
        offDevice = await resolveVerifiedOffDeviceLogicalArtifact(
          path.dirname(report.archiveRoot),
          report.exportFile,
          report.manifestFile,
        );
        if (
          offDevice.archiveRoot !== report.archiveRoot ||
          offDevice.exportPath !== report.exportPath ||
          offDevice.manifestPath !== report.manifestPath ||
          offDevice.rawManifestSha256 !== report.rawManifestSha256
        ) continue;
        verified = await verifiedBackupArtifact(offDevice.manifestPath, offDevice.exportPath);
        artifactSource = "off_device_bundle";
      } catch {
        continue;
      }
    } else {
      continue;
    }
    if (!verified || verified.manifest.exportFile !== report.exportFile ||
        verified.manifest.exportBytes !== report.exportBytes ||
        verified.manifest.exportSha256 !== report.exportSha256 ||
        verified.manifest.rawManifestSha256 !== report.rawManifestSha256 ||
        verified.manifest.schemaVersion !== report.schemaVersion ||
        (verified.manifest.recordCounts.search_document ?? 0) !== report.searchDocuments ||
        verified.manifest.database !== report.database ||
        verified.manifestSha256 !== report.manifestSha256) continue;
    const status: LastRestoreStatus = {
      createdAt: report.createdAt,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      runId: report.runId,
      attemptId: report.attemptId,
      namespace: report.namespace,
      database: report.database,
      archiveRoot: report.archiveRoot,
      exportFile: report.exportFile,
      reportFile: path.basename(reportPath),
      checks: report.checks.length,
      exportSha256: report.exportSha256,
      manifestSha256: report.manifestSha256,
      artifactSource,
      ...(offDevice ? { bundleBackupId: offDevice.backupId } : {}),
      schemaVersion: report.schemaVersion,
      rawManifestSha256: report.rawManifestSha256,
      integrity: "verified",
      externalTrust: artifactSource === "off_device_bundle"
        ? "external_provenance_required"
        : "local_archive_boundary_required",
    };
    candidates.push({ report, status, ...(offDevice ? { offDevice } : {}) });
  }
  return candidates.sort(
    (a, b) => Date.parse(b.report.createdAt) - Date.parse(a.report.createdAt),
  )[0];
}

/** Only strict evidence bound to the exact latest local backup can be returned. */
export async function findLastSuccessfulRestore(
  archiveRoot: string,
  latestLocalBackup?: LastBackupStatus,
): Promise<LastRestoreStatus | undefined> {
  if (!latestLocalBackup) return undefined;
  return (await matchingRestoreCandidate(archiveRoot, latestLocalBackup))?.status;
}

export async function findMatchingRawManifest(
  archiveRoot: string,
  canonicalSha256: string,
  exactFile?: { name: string; sha256: string },
): Promise<LastRawManifestStatus | undefined> {
  const manifestsDir = path.join(path.resolve(archiveRoot), "backups", "manifests");
  const candidates: LastRawManifestStatus[] = [];
  for (const manifestPath of await jsonFiles(manifestsDir)) {
    if (!/^raw-manifest-.*\.json$/u.test(path.basename(manifestPath))) continue;
    if (exactFile && path.basename(manifestPath) !== exactFile.name) continue;
    try {
      await assertRegularNonSymlinkFile(manifestPath, "status raw manifest");
      const manifest = parseRawManifest(JSON.parse(await readFile(manifestPath, "utf8")), manifestPath);
      if (hashRawManifest(manifest) !== canonicalSha256) continue;
      const fileHashes = await hashFile(manifestPath);
      if (exactFile && fileHashes.sha256 !== exactFile.sha256) continue;
      candidates.push({
        createdAt: new Date(manifest.createdAt).toISOString(),
        manifestPath,
        manifestFile: path.basename(manifestPath),
        canonicalSha256,
        fileSha256: fileHashes.sha256,
        entries: manifest.count,
      });
    } catch {
      continue;
    }
  }
  return newest(candidates);
}

/** Testable filesystem seam: every returned suffix belongs to one latest chain. */
export async function collectStatusArtifacts(
  archiveRoot: string,
): Promise<Pick<StatusReport, "lastBackup" | "lastSuccessfulRestore" | "recoveryChain">> {
  const lastBackup = await findLastLogicalBackup(archiveRoot);
  if (!lastBackup) {
    return { lastBackup: undefined, lastSuccessfulRestore: undefined, recoveryChain: undefined };
  }
  const candidate = await matchingRestoreCandidate(archiveRoot, lastBackup);
  const lastSuccessfulRestore = candidate?.status;
  const exactRaw = candidate?.offDevice
    ? {
        name: candidate.offDevice.rawManifestFile,
        sha256: candidate.offDevice.rawManifestFileSha256,
      }
    : undefined;
  const rawManifest = lastBackup.rawManifestSha256
    ? await findMatchingRawManifest(archiveRoot, lastBackup.rawManifestSha256, exactRaw)
    : undefined;
  const recoveryChain = candidate?.offDevice && rawManifest &&
      candidate.offDevice.rawManifestSha256 === rawManifest.canonicalSha256
    ? {
        backup: lastBackup,
        restore: candidate.status as LastRestoreStatus & {
          artifactSource: "off_device_bundle";
          bundleBackupId: string;
        },
        rawManifest,
        offDevice: {
          backupId: candidate.offDevice.backupId,
          bundlePath: candidate.offDevice.bundlePath,
          bundleManifestSha256: candidate.offDevice.bundleManifestSha256,
        },
        integrity: "verified" as const,
        externalTrust: "external_provenance_required" as const,
        cutover: "not_asserted" as const,
      }
    : undefined;
  return { lastBackup, lastSuccessfulRestore, recoveryChain };
}

export async function collectStatus(cfg: AppConfig): Promise<StatusReport> {
  const db = await connectDb(cfg);
  try {
    const [database, rawBytes, dbBytes, artifacts] = await Promise.all([
      collectDatabaseStatus(db),
      dirSize(path.join(cfg.archiveRoot, "raw")),
      dirSize(cfg.dbRoot),
      collectStatusArtifacts(cfg.archiveRoot),
    ]);
    return { ...database, rawBytes, dbBytes, ...artifacts };
  } finally {
    await db.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MiB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(2)} KiB`;
  return `${bytes} B`;
}

export function formatStatus(report: StatusReport): string {
  const migration = report.migrationReconciliation;
  const lines = [
    `hosts: ${report.hosts}, os_accounts: ${report.osAccounts}, harness_installations: ${report.harnessInstallations}`,
    `source_roots: ${report.sourceRoots}`,
    `locations: active ${report.locations.active}, missing ${report.locations.missing}, deleted_in_source ${report.locations.deleted_in_source}`,
    `source_revisions: ${report.sourceRevisions} (parse_error: ${report.parseErrors}, unresolved ingest_error: ${report.unresolvedIngestErrors})`,
    `dialogues: ${report.dialogues} (без current_revision: ${report.dialoguesWithoutCurrent}), dialogue_revisions: ${report.dialogueRevisions}`,
    `messages: ${report.messages}, chunks: ${report.chunks}`,
    `search_documents: ${report.searchDocuments}`,
    `embedding_spaces: ${report.embeddingSpaces}`,
    `embedding_jobs: ${Object.entries(report.embeddingJobs).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`,
    `raw size: ${formatBytes(report.rawBytes)}, RocksDB size: ${formatBytes(report.dbBytes)}`,
    report.lastSync
      ? `last complete sync: ${report.lastSync.finishedAt} (${report.lastSync.id})`
      : "last complete sync: —",
    report.lastBackup
      ? `last backup: ${report.lastBackup.createdAt} (${report.lastBackup.exportFile}, ${formatBytes(report.lastBackup.exportBytes)}, raw manifest ${report.lastBackup.rawManifestSha256?.slice(0, 12) ?? "not recorded"})`
      : "last backup: —",
    report.lastSuccessfulRestore
      ? `last successful restore test: ${report.lastSuccessfulRestore.createdAt} (${report.lastSuccessfulRestore.exportFile}, checks ${report.lastSuccessfulRestore.checks}, evidence ${report.lastSuccessfulRestore.artifactSource}, integrity ${report.lastSuccessfulRestore.integrity}, external trust ${report.lastSuccessfulRestore.externalTrust})`
      : "last successful restore test: —",
    report.recoveryChain
      ? `recovery chain: integrity ${report.recoveryChain.integrity}, external trust ${report.recoveryChain.externalTrust}, cutover ${report.recoveryChain.cutover} (${report.recoveryChain.offDevice.backupId})`
      : "recovery chain: — (cutover not asserted)",
    migration
      ? `migration reconciliation: ${migration.ok ? "ok" : "FAIL"}, status ${migration.status}, total ${migration.legacyTotal}, matched ${migration.matched}, inserted ${migration.inserted}, quarantined ${migration.quarantined}, lost ${migration.lost} (${migration.id})`
      : "migration reconciliation: —",
  ];
  return lines.join("\n");
}
