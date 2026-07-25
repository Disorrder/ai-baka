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
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runLogicalBackup, type BackupManifest } from "../src/backup/backup.ts";
import { RESTORE_NAMESPACE, runRestoreTest } from "../src/backup/restore-test.ts";
import { buildRawManifest, hashRawManifest, verifyRawFiles } from "../src/backup/raw-verify.ts";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  isDbAvailable,
  TEST_NAMESPACE,
  SURREAL_PASS,
  SURREAL_URL,
  SURREAL_USER,
  type TestDb,
} from "./db-test-utils.ts";

// Явный skip в отчёте, если SurrealDB не поднят (вместо молчаливого return).
const testDb = await dbTest();

let t: TestDb;
let archiveRoot: string;
let cfg: AppConfig;
let rawHashes: { sha256: string; sizeBytes: number };

beforeAll(async () => {
  if (!(await isDbAvailable())) return;
  t = await createTestDb();
  archiveRoot = await mkdtemp(path.join(tmpdir(), "baka-backup-it-"));
  const rawRel = "raw/codex/session__" + "a".repeat(64) + ".jsonl";
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
      started_at = $now, host = host:test, baka_commit = "test", schema_version = 4;
    CREATE source_revision:test SET source_location = source_location:test,
      sha256 = $sha, size_bytes = $size, mtime_ms = 0, head_hash = NONE,
      raw_archive_path = $rawPath, snapshot_kind = "regular_copy", captured_at = $now,
      parser_name = "codex", parser_version = "1", parse_status = "parsed",
      sync_run = sync_run:test;
    `,
    { sha: rawHashes.sha256, size: rawHashes.sizeBytes, rawPath: rawRel },
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
  if (t) await dropTestDb(t);
  if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
});

describe("backup → restore:test → raw:verify", () => {
  testDb("logical backup: export + manifest", async () => {
    const result = await runLogicalBackup(cfg);
    const manifest: BackupManifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.namespace).toBe(TEST_NAMESPACE);
    expect(manifest.database).toBe(t.name);
    expect(manifest.recordCounts.source_revision).toBe(1);
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
    const backup = await runLogicalBackup(cfg);
    const report = await runRestoreTest(cfg, { exportPath: backup.exportPath });
    for (const check of report.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }
    expect(report.ok).toBe(true);
    // namespace drill'а удалён после себя
    const probe = await createTestDb(false);
    try {
      const [info] = await probe.db.query<[unknown]>("INFO FOR ROOT");
      expect(JSON.stringify(info)).not.toContain(RESTORE_NAMESPACE);
    } finally {
      await dropTestDb(probe);
    }
  });

  testDb("restore drill отклоняет битый export ДО импорта", async () => {
    const backup = await runLogicalBackup(cfg);
    // «Портим» export, не трогая manifest
    await writeFile(backup.exportPath, "corrupted");
    await expect(runRestoreTest(cfg, { exportPath: backup.exportPath })).rejects.toThrow(
      /exportSha256 не совпадает/,
    );
  });

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
