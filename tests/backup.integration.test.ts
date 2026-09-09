/**
 * Integration-тест backup/restore/raw:verify против живого SurrealDB
 * (namespace baka_test, временная database; скип без поднятого docker).
 *
 * Сценарий: минимальная provenance-цепочка + raw-файл → logical backup
 * (HTTP /export + manifest) → restore drill в baka_restore_test →
 * record counts / инварианты / search-probe совпали → namespace удалён →
 * raw manifest по БД сходится с файловой системой.
 */

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  manifestPathForExport,
  runLogicalBackup,
  type BackupManifest,
} from "../src/backup/backup.ts";
import {
  RESTORE_NAMESPACE,
  RestoreTestAttemptError,
  isRestoreNamespace,
  runRestoreTest,
} from "../src/backup/restore-test.ts";
import { buildRawManifest, hashRawManifest, verifyRawFiles } from "../src/backup/raw-verify.ts";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  isDbAvailable,
  TEST_NAMESPACE,
  SURREAL_PASS,
  SURREAL_URL,
  SURREAL_USER,
  type TestDb,
  withLiveServerOperationGuard,
} from "./db-test-utils.ts";
import { isolatedRestoreTargetEvidence } from "./restore-target-fixture.ts";

// Явный skip в отчёте, если SurrealDB не поднят (вместо молчаливого return).
const testDb = await dbTest();
// Этот drill включает export, import, десятки query и cleanup. Фоновая работа
// RocksDB под нагрузкой suite может пересечь общий 30s; конечный локальный
// предел всё ещё ловит настоящее зависание.
const RESTORE_DRILL_TEST_TIMEOUT_MS = 60_000;
const LATEST_SCHEMA_VERSION = 1;

let t: TestDb;
let archiveRoot: string;
let cfg: AppConfig;
let rawHashes: { sha256: string; sizeBytes: number };
let rawRel: string;

beforeAll(async () => {
  if (!(await isDbAvailable())) return;
  t = await createTestDb();
  archiveRoot = await mkdtemp(path.join(tmpdir(), "baka-backup-it-"));
  rawRel = "raw/codex/session__" + "a".repeat(64) + ".jsonl";
  const rawAbs = path.join(archiveRoot, rawRel);
  await mkdir(path.dirname(rawAbs), { recursive: true });
  await writeFile(rawAbs, '{"type":"user","text":"hello"}\n');
  rawHashes = await hashFile(rawAbs);

  await t.db.query(
    `
    LET $now = time::now();
    CREATE host:test SET host_uuid = "test-uuid", hostname = "test-host",
      platform = "macOS", arch = "arm64", first_seen_at = $now, last_seen_at = $now;
    CREATE harness:codex SET slug = "codex", display_name = "Codex", kind = "cli";
    CREATE harness_installation:test SET host = host:test, harness = harness:codex,
      installed = true, first_seen_at = $now, last_detected_at = $now;
    CREATE source_root:test SET harness_installation = harness_installation:test,
      path = "/tmp/src", source_kind = "file_tree", parser_name = "codex",
      snapshot_strategy = "copy", enabled = true, first_seen_at = $now, last_seen_at = $now;
    CREATE source_location:test SET source_root = source_root:test,
      relative_path = "session.jsonl", original_path = "/tmp/src/session.jsonl",
      basename = "session.jsonl", presence_status = "active", missing_complete_scans = 0,
      first_seen_at = $now, last_seen_at = $now;
    CREATE sync_run:test SET kind = "live_sync", status = "completed",
      started_at = $now, host = host:test, baka_commit = "test", schema_version = ${LATEST_SCHEMA_VERSION};
    CREATE source_revision:test SET source_location = source_location:test,
      sha256 = $sha, size_bytes = $size, mtime_ms = 0, head_hash = NONE,
      raw_archive_path = $rawPath, snapshot_kind = "regular_copy", captured_at = $now,
      parser_name = "codex", parser_version = "1", parse_status = "parsed",
      sync_run = sync_run:test;
    CREATE source_revision:legacy_missing SET source_location = source_location:test,
      sha256 = $missingSha, size_bytes = 0, mtime_ms = 0, head_hash = NONE,
      raw_archive_path = NONE, snapshot_kind = "legacy_missing_raw", captured_at = $now,
      parser_name = "legacy", parser_version = "1", parse_status = "unsupported",
      sync_run = sync_run:test;
    CREATE migration_meta:test SET status = "completed", started_at = $now,
      finished_at = $now, sync_run = sync_run:test;
    CREATE migration_quarantine:test SET migration = migration_meta:test,
      legacy_table = "threads", legacy_id = "anonymized-1", raw_payload = { anonymized: true },
      reason = "anonymized_fixture", parser_name = "legacy-migration-adapter",
      parser_version = "1", retryable = false, attempts = 1,
      lineage_key = "threads:anonymized-1", previous_attempt = NONE,
      first_failed_at = $now, last_failed_at = $now, resolved_at = NONE, resolution = NONE;
    CREATE migration_row_commit:test SET migration = migration_meta:test,
      legacy_table = "threads", legacy_id = "anonymized-1", category = "quarantined",
      target = migration_quarantine:test, committed_at = $now;
    `,
    {
      sha: rawHashes.sha256,
      missingSha: "b".repeat(64),
      size: rawHashes.sizeBytes,
      rawPath: rawRel,
    },
  );

  cfg = loadConfig({
    BAKA_ARCHIVE_ROOT: archiveRoot,
    SURREAL_URL,
    SURREAL_USER,
    SURREAL_PASS,
    SURREAL_NAMESPACE: TEST_NAMESPACE,
    SURREAL_DATABASE: t.name,
  });
});

afterAll(async () => {
  try {
    if (t) await dropTestDb(t);
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  } finally {
    await finishLiveTestFile();
  }
});

describe("backup → restore:test → raw:verify", () => {
  testDb("logical backup: export + manifest", async () => {
    const result = await withLiveServerOperationGuard(
      "http-export",
      () => runLogicalBackup(cfg),
    );
    const manifest: BackupManifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(manifest.namespace).toBe(TEST_NAMESPACE);
    expect(manifest.database).toBe(t.name);
    expect(manifest.recordCounts.source_revision).toBe(2);
    expect(manifest.recordCounts.migration_row_commit).toBe(1);
    expect(manifest.recordCounts.migration_quarantine).toBe(1);
    expect(manifest.recordCounts.dialogue).toBe(0);
    expect(manifest.exportSha256).toMatch(/^[0-9a-f]{64}$/);
    // exportSha256 должен совпадать с фактическим файлом
    const hashes = await hashFile(result.exportPath);
    expect(hashes.sha256).toBe(manifest.exportSha256);
    expect(hashes.sizeBytes).toBe(manifest.exportBytes);
    // rawManifestSha256 (§16.1) посчитан по живой БД в момент backup
    expect(manifest.rawManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    const rawManifest = await buildRawManifest(t.db);
    expect(manifest.rawManifestSha256).toBe(hashRawManifest(rawManifest));
  });

  testDb("restore drill: counts, инварианты, search-probe, cleanup", async () => {
    const backup = await withLiveServerOperationGuard(
      "http-export",
      () => runLogicalBackup(cfg),
    );
    const report = await withLiveServerOperationGuard(
      "http-import",
      () => runRestoreTest(cfg, {
        exportPath: backup.exportPath,
        targetEvidence: isolatedRestoreTargetEvidence(),
      }),
    );
    for (const check of report.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }
    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(report.checks.map((check) => check.name)).toContain(
      "invariant: migration_row_commit migration/target",
    );
    expect(report.checks.map((check) => check.name)).toContain(
      "invariant: migration_quarantine migration/previous_attempt",
    );
    // namespace drill'а удалён после себя
    const probe = await createTestDb(false);
    try {
      const [info] = await probe.db.query<[unknown]>("INFO FOR ROOT");
      expect(JSON.stringify(info)).not.toContain(RESTORE_NAMESPACE);
    } finally {
      await dropTestDb(probe);
    }
  }, RESTORE_DRILL_TEST_TIMEOUT_MS);

  testDb("два concurrent restore drill используют независимые namespace", async () => {
    const backup = await withLiveServerOperationGuard(
      "http-export",
      () => runLogicalBackup(cfg),
    );
    const [first, second] = await withLiveServerOperationGuard(
      "http-import",
      () => Promise.all([
        runRestoreTest(cfg, {
          exportPath: backup.exportPath,
          targetEvidence: isolatedRestoreTargetEvidence(),
        }),
        runRestoreTest(cfg, {
          exportPath: backup.exportPath,
          targetEvidence: isolatedRestoreTargetEvidence(),
        }),
      ]),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.namespace).not.toBe(second.namespace);
    expect(isRestoreNamespace(first.namespace)).toBe(true);
    expect(isRestoreNamespace(second.namespace)).toBe(true);
  }, RESTORE_DRILL_TEST_TIMEOUT_MS);

  testDb("restore drill читает raw из standalone off-device bundle root", async () => {
    const backup = await withLiveServerOperationGuard(
      "http-export",
      () => runLogicalBackup(cfg),
    );
    const bundleRoot = await mkdtemp(path.join(tmpdir(), "baka-offline-restore-it-"));
    try {
      const bundleArchive = path.join(bundleRoot, "archive");
      const bundledExport = path.join(
        bundleArchive,
        "backups",
        "surreal",
        path.basename(backup.exportPath),
      );
      await mkdir(path.dirname(bundledExport), { recursive: true });
      await mkdir(path.dirname(manifestPathForExport(bundledExport)), { recursive: true });
      await copyFile(backup.exportPath, bundledExport);
      await copyFile(backup.manifestPath, manifestPathForExport(bundledExport));
      const bundledRaw = path.join(bundleArchive, rawRel);
      await mkdir(path.dirname(bundledRaw), { recursive: true });
      await copyFile(path.join(archiveRoot, rawRel), bundledRaw);

      // cfg.archiveRoot намеренно указывает на отсутствующий исходный архив:
      // raw references обязаны разрешиться только через bundleArchive.
      const report = await withLiveServerOperationGuard(
        "http-import",
        () => runRestoreTest(
          {
            ...cfg,
            archiveRoot: path.join(bundleRoot, "original-archive-is-offline"),
            // Deliberately nonexistent source namespace: a live-source query
            // would fail, while standalone restore uses only RESTORE_NAMESPACE.
            surrealNamespace: "source_namespace_must_not_be_queried",
          },
          {
            exportPath: bundledExport,
            rawArchiveRoot: bundleArchive,
            targetEvidence: isolatedRestoreTargetEvidence(),
          },
        ),
      );
      expect(report.rawArchiveRoot).toBe(path.resolve(bundleArchive));
      const rawCheck = report.checks.find((check) => check.name === "raw references");
      expect(rawCheck?.ok, rawCheck?.detail).toBe(true);
      expect(report.ok).toBe(true);
    } finally {
      await rm(bundleRoot, { recursive: true, force: true });
    }
  }, RESTORE_DRILL_TEST_TIMEOUT_MS);

  testDb("restore drill отклоняет битый export ДО импорта", async () => {
    const backup = await withLiveServerOperationGuard(
      "http-export",
      () => runLogicalBackup(cfg),
    );
    // «Портим» export, не трогая manifest
    await writeFile(backup.exportPath, "corrupted");
    const error = await withLiveServerOperationGuard("http-import", async () => {
      try {
        await runRestoreTest(cfg, {
          exportPath: backup.exportPath,
          targetEvidence: isolatedRestoreTargetEvidence(),
        });
      } catch (error) {
        if (error instanceof RestoreTestAttemptError) return error;
        throw error;
      }
      throw new Error("restore unexpectedly accepted corrupt export");
    });
    expect(error).toBeInstanceOf(RestoreTestAttemptError);
    expect((error as RestoreTestAttemptError).report.failure).toEqual({
      stage: "export_integrity",
      code: "export_sha256_mismatch",
    });
  }, RESTORE_DRILL_TEST_TIMEOUT_MS);

  testDb("raw manifest по БД сходится с файловой системой", async () => {
    const manifest = await buildRawManifest(t.db);
    expect(manifest.count).toBe(1);
    expect(manifest.entries[0]!.harness).toBe("codex");
    expect(manifest.entries[0]!.sha256).toBe(rawHashes.sha256);
    const report = await verifyRawFiles(archiveRoot, manifest);
    expect(report.orphans).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
  });
});
