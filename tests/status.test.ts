import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Surreal } from "surrealdb";
import { manifestPathForExport, type BackupManifest } from "../src/backup/backup.ts";
import { runOffDeviceBackup } from "../src/backup/off-device.ts";
import { hashRawManifest, type RawManifest } from "../src/backup/raw-verify.ts";
import { expectedSuccessfulRestoreCheckNames } from "../src/backup/restore-test.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import { isolatedRestoreTargetEvidence } from "./restore-target-fixture.ts";
import {
  COMPLETED_LIVE_SYNCS_SQL,
  INCOMPLETE_LIVE_SYNC_SCANS_SQL,
  LATEST_MIGRATION_RECONCILIATION_SQL,
  collectDatabaseStatus,
  collectStatusArtifacts,
  formatStatus,
  type StatusReport,
} from "../src/status.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "baka-status-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeDb(handler: (sql: string) => unknown[]): Surreal {
  return { query: async (sql: string) => [handler(sql)] } as unknown as Surreal;
}

async function writeLocalLogicalBackup(
  archiveRoot: string,
  base: string,
  createdAt: string,
  content: string,
  includeRawManifestSha256 = true,
  schemaVersion: 1 = 1,
): Promise<{
  database: string;
  schemaVersion: 1;
  rawManifestSha256?: string;
  exportPath: string;
  exportFile: string;
  exportBytes: number;
  exportSha256: string;
  manifestPath: string;
  manifestFile: string;
  manifestSha256: string;
}> {
  const surreal = path.join(archiveRoot, "backups", "surreal");
  const manifests = path.join(archiveRoot, "backups", "manifests");
  await mkdir(surreal, { recursive: true });
  await mkdir(manifests, { recursive: true });
  const exportFile = `${base}.surql.gz`;
  const exportPath = path.join(surreal, exportFile);
  await writeFile(exportPath, content);
  const exportHashes = await hashFile(exportPath);
  const manifestPath = path.join(manifests, `${base}.json`);
  await writeFile(manifestPath, JSON.stringify({
    createdAt,
    surrealdbVersion: "3.2.3",
    schemaVersion,
    bakaCommit: "test",
    namespace: "baka",
    database: "archive",
    recordCounts: {},
    ...(includeRawManifestSha256 ? { rawManifestSha256: "f".repeat(64) } : {}),
    exportFile,
    compression: "gzip",
    exportBytes: exportHashes.sizeBytes,
    exportSha256: exportHashes.sha256,
  }));
  return {
    database: "archive",
    schemaVersion,
    ...(includeRawManifestSha256 ? { rawManifestSha256: "f".repeat(64) } : {}),
    exportPath,
    exportFile,
    exportBytes: exportHashes.sizeBytes,
    exportSha256: exportHashes.sha256,
    manifestPath,
    manifestFile: path.basename(manifestPath),
    manifestSha256: (await hashFile(manifestPath)).sha256,
  };
}

type TestBackup = Awaited<ReturnType<typeof writeLocalLogicalBackup>>;

function strictRestoreReport(
  backup: TestBackup,
  archiveRoot: string,
  createdAt: string,
  options: {
    attemptHex?: string;
    exportPath?: string;
    manifestPath?: string;
  } = {},
): Record<string, unknown> {
  const attemptId = (options.attemptHex ?? "a").repeat(32);
  const checks = expectedSuccessfulRestoreCheckNames(0, 0, backup.schemaVersion).map((name) => ({
    name,
    ok: true,
    detail: "verified",
  }));
  return {
    formatVersion: 5,
    ok: true,
    attemptId,
    runId: `restore_test:${options.attemptHex ?? "a"}`,
    startedAt: createdAt,
    finishedAt: createdAt,
    createdAt,
    namespace: `baka_restore_test_${attemptId}`,
    database: backup.database,
    archiveRoot,
    rawArchiveRoot: archiveRoot,
    exportPath: options.exportPath ?? backup.exportPath,
    exportFile: backup.exportFile,
    exportBytes: backup.exportBytes,
    exportSha256: backup.exportSha256,
    manifestPath: options.manifestPath ?? backup.manifestPath,
    manifestFile: backup.manifestFile,
    manifestSha256: backup.manifestSha256,
    rawManifestSha256: backup.rawManifestSha256,
    schemaVersion: backup.schemaVersion,
    searchDocuments: 0,
    chunks: 0,
    checks,
    target: isolatedRestoreTargetEvidence(),
    cleanup: {
      databaseClosed: true,
      temporaryExportRemoved: true,
      namespaceRemoved: true,
    },
  };
}

async function makeOffDeviceRestoreEvidence(base: string): Promise<{
  archiveRoot: string;
  bundleRoot: string;
  bundleArchiveRoot: string;
  exportFile: string;
  exportPath: string;
  exportSha256: string;
  exportBytes: number;
  manifestFile: string;
  manifestSha256: string;
  reportPath: string;
  backupId: string;
}> {
  const archiveRoot = path.join(base, "local-archive");
  const projectRoot = path.join(base, "project");
  const destination = path.join(base, "off-device");
  const manifests = path.join(archiveRoot, "backups", "manifests");
  const surreal = path.join(archiveRoot, "backups", "surreal");
  await mkdir(manifests, { recursive: true });
  await mkdir(surreal, { recursive: true });
  await mkdir(path.join(archiveRoot, "raw"), { recursive: true });
  await mkdir(path.join(projectRoot, "schema"), { recursive: true });
  await mkdir(path.join(projectRoot, "reports"), { recursive: true });
  await writeFile(path.join(archiveRoot, ".baka-archive.json"), JSON.stringify({
    archiveId: "22222222-3333-4444-8555-666666666666",
    formatVersion: 1,
    createdAt: "2026-07-26T10:00:00.000Z",
    expectedNamespace: "baka",
    expectedDatabase: "archive",
  }));

  const rawManifest: RawManifest = {
    createdAt: "2026-07-26T10:01:00.000Z",
    count: 0,
    entries: [],
  };
  const rawManifestPath = path.join(manifests, "raw-manifest-2026-07-26T100100Z.json");
  await writeFile(rawManifestPath, JSON.stringify(rawManifest));
  const exportFile = "2026-07-26T100000Z__schema-1__surreal-3.2.3.surql.gz";
  const localExportPath = path.join(surreal, exportFile);
  await writeFile(localExportPath, "standalone-export");
  const exportHashes = await hashFile(localExportPath);
  const logicalManifest: BackupManifest = {
    createdAt: "2026-07-26T10:00:00.000Z",
    surrealdbVersion: "3.2.3",
    schemaVersion: 1,
    bakaCommit: "test",
    namespace: "baka",
    database: "archive",
    recordCounts: {},
    rawManifestSha256: hashRawManifest(rawManifest),
    exportFile,
    compression: "gzip",
    exportBytes: exportHashes.sizeBytes,
    exportSha256: exportHashes.sha256,
  };
  const localManifestPath = manifestPathForExport(localExportPath);
  await writeFile(localManifestPath, JSON.stringify(logicalManifest));
  for (let version = 1; version <= 5; version += 1) {
    await writeFile(
      path.join(projectRoot, "schema", `${String(version).padStart(4, "0")}_schema.surql`),
      `-- schema ${version}\n`,
    );
  }
  const migrationReport = path.join(projectRoot, "reports", "migration-run.json");
  await writeFile(migrationReport, '{"ok":true}\n');

  const offDevice = await runOffDeviceBackup({
    archiveRoot,
    destination,
    projectRoot,
    rawManifestPath,
    migrationReportPaths: [migrationReport],
    requireDifferentFilesystem: false,
    operatorConfirmedPhysicalDevice: true,
    physicalDeviceCheckedAt: new Date("2026-07-26T11:59:00.000Z"),
    now: new Date("2026-07-26T12:00:00.000Z"),
  });
  const bundleRoot = offDevice.plan.bundlePath;
  const bundleArchiveRoot = path.join(bundleRoot, "archive");
  const exportPath = path.join(bundleArchiveRoot, "backups", "surreal", exportFile);
  const bundledManifestPath = path.join(
    bundleArchiveRoot,
    "backups",
    "manifests",
    path.basename(localManifestPath),
  );
  const manifestHashes = await hashFile(bundledManifestPath);
  const reportPath = path.join(manifests, "restore-test-off-device.json");
  const backup: TestBackup = {
    database: logicalManifest.database,
    schemaVersion: 1,
    rawManifestSha256: logicalManifest.rawManifestSha256,
    exportPath: localExportPath,
    exportFile,
    exportBytes: exportHashes.sizeBytes,
    exportSha256: exportHashes.sha256,
    manifestPath: localManifestPath,
    manifestFile: path.basename(localManifestPath),
    manifestSha256: manifestHashes.sha256,
  };
  await writeFile(reportPath, JSON.stringify(strictRestoreReport(
    backup,
    bundleArchiveRoot,
    "2026-07-26T12:30:00.000Z",
    {
      exportPath,
      manifestPath: bundledManifestPath,
    },
  )));
  return {
    archiveRoot,
    bundleRoot,
    bundleArchiveRoot,
    exportFile,
    exportPath,
    exportSha256: exportHashes.sha256,
    exportBytes: exportHashes.sizeBytes,
    manifestFile: path.basename(localManifestPath),
    manifestSha256: manifestHashes.sha256,
    reportPath,
    backupId: offDevice.plan.manifest.backupId,
  };
}

describe("status database (§17.2)", () => {
  test("берёт только последний успешный complete live sync и persisted migration reconciliation", async () => {
    const queries: string[] = [];
    const db = fakeDb((sql) => {
      queries.push(sql);
      if (sql.includes("FROM embedding_job GROUP BY status")) {
        return [
          { status: "pending", n: 3 },
          { status: "retryable_error", n: 2 },
          { status: "permanent_error", n: 1 },
        ];
      }
      if (sql === COMPLETED_LIVE_SYNCS_SQL) {
        return [
          {
            id: "sync_run:partial",
            status: "completed",
            started_at: new Date("2026-07-25T11:00:00Z"),
            finished_at: new Date("2026-07-25T11:02:00Z"),
          },
          {
            id: "sync_run:good",
            status: "completed",
            started_at: new Date("2026-07-25T10:00:00Z"),
            finished_at: new Date("2026-07-25T10:02:00Z"),
          },
        ];
      }
      if (sql === INCOMPLETE_LIVE_SYNC_SCANS_SQL) return ["sync_run:partial"];
      if (sql === LATEST_MIGRATION_RECONCILIATION_SQL) {
        return [{
          id: "migration_meta:run",
          status: "completed_with_errors",
          started_at: new Date("2026-07-25T11:00:00Z"),
          finished_at: new Date("2026-07-25T11:03:00Z"),
          counters: {
            status: "completed_with_errors",
            reconciliation: {
              legacyTotal: 20,
              matched: 10,
              inserted: 8,
              quarantined: 2,
              accounted: 20,
              lost: 0,
              ok: true,
            },
          },
        }];
      }
      if (sql.includes("SELECT count() AS n")) return [{ n: 1 }];
      return [];
    });

    const report = await collectDatabaseStatus(db);
    expect(COMPLETED_LIVE_SYNCS_SQL).toContain("status = 'completed'");
    expect(COMPLETED_LIVE_SYNCS_SQL).toContain("finished_at IS NOT NONE");
    expect(INCOMPLETE_LIVE_SYNC_SCANS_SQL).toContain("status != 'complete'");
    expect(queries).toContain(COMPLETED_LIVE_SYNCS_SQL);
    expect(report.lastSync).toEqual({
      id: "sync_run:good",
      status: "completed",
      startedAt: "2026-07-25T10:00:00.000Z",
      finishedAt: "2026-07-25T10:02:00.000Z",
    });
    expect(report.embeddingJobs).toEqual({
      pending: 3,
      retryable_error: 2,
      permanent_error: 1,
    });
    expect(report.migrationReconciliation).toMatchObject({
      id: "migration_meta:run",
      legacyTotal: 20,
      quarantined: 2,
      lost: 0,
      ok: true,
    });
  });

  test("не выдаёт running/неполную строку за complete sync", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("FROM embedding_job GROUP BY status")) return [];
      if (sql === COMPLETED_LIVE_SYNCS_SQL) {
        return [{
          id: "sync_run:running",
          status: "running",
          started_at: new Date("2026-07-25T10:00:00Z"),
          finished_at: undefined,
        }];
      }
      if (sql === INCOMPLETE_LIVE_SYNC_SCANS_SQL) return [];
      return [];
    });
    expect((await collectDatabaseStatus(db)).lastSync).toBeUndefined();
  });
});

describe("status durable artifacts (§17.2)", () => {
  test("отклоняет partial/fixed-namespace report и принимает строгий unique report", async () => {
    await withTempDir(async (root) => {
      const manifests = path.join(root, "backups", "manifests");
      const surreal = path.join(root, "backups", "surreal");
      await mkdir(manifests, { recursive: true });
      await mkdir(surreal, { recursive: true });

      const oldExport = path.join(surreal, "old.surql.zst");
      await writeFile(oldExport, "old");
      const oldHashes = await hashFile(oldExport);
      const oldManifestPath = path.join(manifests, "old.json");
      await writeFile(oldManifestPath, JSON.stringify({
        createdAt: "2026-07-24T00:00:00Z",
        surrealdbVersion: "3.2.3",
        exportFile: "old.surql.zst",
        schemaVersion: 1,
        bakaCommit: "test",
        namespace: "baka",
        database: "archive",
        recordCounts: {},
        rawManifestSha256: "c".repeat(64),
        compression: "zstd",
        exportBytes: oldHashes.sizeBytes,
        exportSha256: oldHashes.sha256,
      }));
      const oldManifestHashes = await hashFile(oldManifestPath);
      const oldBackup: TestBackup = {
        database: "archive",
        schemaVersion: 1,
        rawManifestSha256: "c".repeat(64),
        exportPath: oldExport,
        exportFile: "old.surql.zst",
        exportBytes: oldHashes.sizeBytes,
        exportSha256: oldHashes.sha256,
        manifestPath: oldManifestPath,
        manifestFile: "old.json",
        manifestSha256: oldManifestHashes.sha256,
      };
      // Более новый manifest без export'а не является usable backup.
      await writeFile(path.join(manifests, "missing.json"), JSON.stringify({
        createdAt: "2026-07-26T00:00:00Z",
        surrealdbVersion: "3.2.3",
        exportFile: "missing.surql.zst",
        schemaVersion: 1,
        bakaCommit: "test",
        namespace: "baka",
        database: "archive",
        recordCounts: {},
        rawManifestSha256: "d".repeat(64),
        compression: "zstd",
        exportBytes: 10,
        exportSha256: "b".repeat(64),
      }));
      await writeFile(path.join(manifests, "restore-test-older.json"), JSON.stringify({
        createdAt: "2026-07-24T01:00:00Z",
        ok: true,
        exportFile: "old.surql.zst",
        exportBytes: oldHashes.sizeBytes,
        exportSha256: oldHashes.sha256,
        manifestFile: "old.json",
        manifestSha256: oldManifestHashes.sha256,
        namespace: "baka_restore_test",
        checks: [{ ok: true }],
      }));
      // Неуспешный более новый drill не сдвигает last successful.
      await writeFile(path.join(manifests, "restore-test-newer.json"), JSON.stringify({
        createdAt: "2026-07-26T01:00:00Z",
        ok: false,
        exportFile: "missing.surql.zst",
        checks: [{ ok: false }],
      }));
      await writeFile(path.join(manifests, "restore-test-broken.json"), "{");

      const rejected = await collectStatusArtifacts(root);
      expect(rejected.lastSuccessfulRestore).toBeUndefined();
      await writeFile(
        path.join(manifests, "restore-test-valid.json"),
        JSON.stringify(strictRestoreReport(
          oldBackup,
          path.resolve(root),
          "2026-07-24T01:00:00.000Z",
        )),
      );
      const artifacts = await collectStatusArtifacts(root);
      expect(artifacts.lastBackup).toMatchObject({
        createdAt: "2026-07-24T00:00:00.000Z",
        exportFile: "old.surql.zst",
        manifestFile: "old.json",
        exportBytes: 3,
      });
      expect(artifacts.lastSuccessfulRestore).toMatchObject({
        createdAt: "2026-07-24T01:00:00.000Z",
        exportFile: "old.surql.zst",
        reportFile: "restore-test-valid.json",
        artifactSource: "local_archive",
        integrity: "verified",
      });
      expect(artifacts.recoveryChain).toBeUndefined();
    });
  });

  test("same-size corrupted export and self-inconsistent restore report are ignored", async () => {
    await withTempDir(async (root) => {
      const manifests = path.join(root, "backups", "manifests");
      const surreal = path.join(root, "backups", "surreal");
      await mkdir(manifests, { recursive: true });
      await mkdir(surreal, { recursive: true });
      const exportPath = path.join(surreal, "bad.surql.gz");
      await writeFile(exportPath, "same");
      const manifestPath = path.join(manifests, "bad.json");
      await writeFile(manifestPath, JSON.stringify({
        createdAt: "2026-07-26T00:00:00Z",
        surrealdbVersion: "3.2.3",
        schemaVersion: 1,
        bakaCommit: "test",
        namespace: "baka",
        database: "archive",
        recordCounts: {},
        rawManifestSha256: "e".repeat(64),
        exportFile: "bad.surql.gz",
        compression: "gzip",
        exportBytes: 4,
        exportSha256: "a".repeat(64),
      }));
      const manifestHashes = await hashFile(manifestPath);
      await writeFile(path.join(manifests, "restore-test-bad.json"), JSON.stringify({
        createdAt: "2026-07-26T01:00:00Z",
        ok: true,
        namespace: "baka_restore_test",
        exportFile: "bad.surql.gz",
        exportBytes: 4,
        exportSha256: "a".repeat(64),
        manifestFile: "bad.json",
        manifestSha256: manifestHashes.sha256,
        checks: [{ ok: false }],
      }));
      expect(await collectStatusArtifacts(root)).toEqual({
        lastBackup: undefined,
        lastSuccessfulRestore: undefined,
        recoveryChain: undefined,
      });
    });
  });

  test("schema 1 logical backup без rawManifestSha256 не считается durable", async () => {
    await withTempDir(async (root) => {
      await writeLocalLogicalBackup(
        root,
        "schema5-without-raw",
        "2026-07-26T00:00:00.000Z",
        "valid-export",
        false,
      );
      expect((await collectStatusArtifacts(root)).lastBackup).toBeUndefined();
    });
  });

  test("manifest-first crash residue without export is never a completed backup", async () => {
    await withTempDir(async (root) => {
      const manifests = path.join(root, "backups", "manifests");
      await mkdir(manifests, { recursive: true });
      await writeFile(path.join(manifests, "crashed.json"), JSON.stringify({
        createdAt: "2026-07-26T00:00:00.000Z",
        surrealdbVersion: "3.2.3",
        schemaVersion: 1,
        bakaCommit: "test",
        namespace: "baka",
        database: "archive",
        recordCounts: {},
        rawManifestSha256: "a".repeat(64),
        exportFile: "crashed.surql.gz",
        compression: "gzip",
        exportBytes: 100,
        exportSha256: "b".repeat(64),
      }));
      expect(await collectStatusArtifacts(root)).toEqual({
        lastBackup: undefined,
        lastSuccessfulRestore: undefined,
        recoveryChain: undefined,
      });
    });
  });

  test("status выбирает restore для latest backup, игнорируя более поздний drill старого backup", async () => {
    await withTempDir(async (root) => {
      const oldBackup = await writeLocalLogicalBackup(
        root,
        "old-backup",
        "2026-07-24T00:00:00.000Z",
        "old-export",
      );
      const newBackup = await writeLocalLogicalBackup(
        root,
        "new-backup",
        "2026-07-26T00:00:00.000Z",
        "new-export",
      );
      await writeFile(
        path.join(root, "backups", "manifests", "restore-test-old-backup.json"),
        JSON.stringify(strictRestoreReport(
          oldBackup,
          path.resolve(root),
          "2026-07-26T01:00:00.000Z",
          { attemptHex: "b" },
        )),
      );

      const artifacts = await collectStatusArtifacts(root);
      expect(artifacts.lastBackup?.exportFile).toBe(newBackup.exportFile);
      expect(artifacts.lastSuccessfulRestore).toBeUndefined();

      await writeFile(
        path.join(root, "backups", "manifests", "restore-test-new-backup.json"),
        JSON.stringify(strictRestoreReport(
          newBackup,
          path.resolve(root),
          "2026-07-26T00:30:00.000Z",
          { attemptHex: "c" },
        )),
      );
      expect((await collectStatusArtifacts(root)).lastSuccessfulRestore).toMatchObject({
        exportFile: newBackup.exportFile,
        artifactSource: "local_archive",
        integrity: "verified",
      });
    });
  });

  test("строит одну exact local→restore→raw→off-device цепочку", async () => {
    await withTempDir(async (base) => {
      const evidence = await makeOffDeviceRestoreEvidence(base);
      const artifacts = await collectStatusArtifacts(evidence.archiveRoot);
      expect(artifacts.lastBackup).toMatchObject({
        exportFile: evidence.exportFile,
        exportSha256: evidence.exportSha256,
        manifestSha256: evidence.manifestSha256,
      });
      expect(artifacts.lastSuccessfulRestore).toMatchObject({
        exportFile: evidence.exportFile,
        exportSha256: evidence.exportSha256,
        manifestSha256: evidence.manifestSha256,
        artifactSource: "off_device_bundle",
        bundleBackupId: evidence.backupId,
        integrity: "verified",
        externalTrust: "external_provenance_required",
      });
      expect(artifacts.recoveryChain).toMatchObject({
        integrity: "verified",
        externalTrust: "external_provenance_required",
        cutover: "not_asserted",
        offDevice: { backupId: evidence.backupId },
      });
    });
  });

  test("off-device restore evidence отклоняет traversal, symlink root и tampered payload", async () => {
    await withTempDir(async (base) => {
      const evidence = await makeOffDeviceRestoreEvidence(base);
      const report = JSON.parse(await readFile(evidence.reportPath, "utf8")) as Record<string, unknown>;

      report.rawArchiveRoot = `${evidence.bundleArchiveRoot}/../archive`;
      report.archiveRoot = report.rawArchiveRoot;
      await writeFile(evidence.reportPath, JSON.stringify(report));
      expect((await collectStatusArtifacts(evidence.archiveRoot)).lastSuccessfulRestore)
        .toBeUndefined();

      const alias = path.join(base, "bundle-symlink");
      await symlink(evidence.bundleRoot, alias, "dir");
      report.rawArchiveRoot = path.join(alias, "archive");
      report.archiveRoot = report.rawArchiveRoot;
      report.exportPath = path.join(report.archiveRoot as string, "backups", "surreal", evidence.exportFile);
      report.manifestPath = path.join(
        report.archiveRoot as string,
        "backups",
        "manifests",
        evidence.manifestFile,
      );
      await writeFile(evidence.reportPath, JSON.stringify(report));
      expect((await collectStatusArtifacts(evidence.archiveRoot)).lastSuccessfulRestore)
        .toBeUndefined();

      report.rawArchiveRoot = evidence.bundleArchiveRoot;
      report.archiveRoot = evidence.bundleArchiveRoot;
      report.exportPath = evidence.exportPath;
      report.manifestPath = path.join(
        evidence.bundleArchiveRoot,
        "backups",
        "manifests",
        evidence.manifestFile,
      );
      await writeFile(evidence.reportPath, JSON.stringify(report));
      await writeFile(evidence.exportPath, "tampered-payload");
      expect((await collectStatusArtifacts(evidence.archiveRoot)).lastSuccessfulRestore)
        .toBeUndefined();
    });
  });

  test("пустой archive возвращает отсутствие артефактов, а не ошибку", async () => {
    await withTempDir(async (root) => {
      expect(await collectStatusArtifacts(root)).toEqual({
        lastBackup: undefined,
        lastSuccessfulRestore: undefined,
        recoveryChain: undefined,
      });
    });
  });
});

describe("status CLI formatter", () => {
  test("показывает реальные operational checkpoints отдельными строками", () => {
    const report: StatusReport = {
      hosts: 1,
      osAccounts: 1,
      harnessInstallations: 1,
      sourceRoots: 1,
      locations: { active: 1, missing: 0, deleted_in_source: 0 },
      sourceRevisions: 2,
      parseErrors: 0,
      unresolvedIngestErrors: 0,
      dialogues: 2,
      dialogueRevisions: 2,
      dialoguesWithoutCurrent: 0,
      messages: 3,
      chunks: 4,
      searchDocuments: 5,
      embeddingSpaces: 1,
      embeddingJobs: { retryable_error: 1, pending: 2 },
      rawBytes: 1024,
      dbBytes: 2048,
      lastSync: {
        id: "sync_run:one",
        status: "completed",
        startedAt: "2026-07-25T00:00:00.000Z",
        finishedAt: "2026-07-25T00:01:00.000Z",
      },
      lastBackup: {
        createdAt: "2026-07-25T01:00:00.000Z",
        database: "archive",
        exportPath: "/tmp/archive/backups/surreal/backup.surql.zst",
        exportFile: "backup.surql.zst",
        manifestPath: "/tmp/archive/backups/manifests/backup.json",
        manifestFile: "backup.json",
        schemaVersion: 1,
        exportBytes: 1024,
        exportSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
      },
      lastSuccessfulRestore: {
        createdAt: "2026-07-25T02:00:00.000Z",
        startedAt: "2026-07-25T01:55:00.000Z",
        finishedAt: "2026-07-25T02:00:00.000Z",
        runId: "restore_test:one",
        attemptId: "a".repeat(32),
        namespace: `baka_restore_test_${"a".repeat(32)}`,
        database: "archive",
        archiveRoot: "/tmp/archive",
        exportFile: "backup.surql.zst",
        reportFile: "restore-test.json",
        checks: 10,
        exportSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        artifactSource: "local_archive",
        schemaVersion: 1,
        rawManifestSha256: "c".repeat(64),
        integrity: "verified",
        externalTrust: "local_archive_boundary_required",
      },
      migrationReconciliation: {
        id: "migration_meta:one",
        status: "completed",
        startedAt: "2026-07-25T03:00:00.000Z",
        legacyTotal: 9,
        matched: 4,
        inserted: 5,
        quarantined: 0,
        accounted: 9,
        lost: 0,
        ok: true,
      },
      migrationQuarantine: {
        state: "accepted_with_operator_exclusions",
        unresolved: 0,
        documentedOperatorExclusions: 3,
        documentedOperatorExclusionLineages: 3,
        retryResolved: 1,
        supersededOperatorExclusions: 0,
        invalidResolutions: 0,
        byCode: {
          active_original_without_exact_dialogue: 1,
          deleted_original_unrecoverable_no_messages: 0,
          canonical_child_of_excluded_active_thread: 1,
          source_less_record_of_excluded_active_thread: 1,
          existing_dialogue_ownership_superseded: 0,
          canonical_child_of_superseded_thread: 0,
        },
      },
    };
    const formatted = formatStatus(report);
    expect(formatted).toContain("last complete sync: 2026-07-25T00:01:00.000Z");
    expect(formatted).toContain("last backup: 2026-07-25T01:00:00.000Z");
    expect(formatted).toContain("last successful restore test: 2026-07-25T02:00:00.000Z");
    expect(formatted).toContain("migration reconciliation: ok");
    expect(formatted).toContain("documented operator exclusions 3");
    expect(formatted).not.toContain("этап 12");
    expect(formatted).toContain("cutover not asserted");
    expect(formatted).toContain("embedding_jobs: pending 2, retryable_error 1");
  });
});
