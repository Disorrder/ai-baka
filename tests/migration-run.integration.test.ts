import { afterAll, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { RecordId } from "surrealdb";
import {
  probeMigrationApprovalBaselineFromDb,
  runLegacyMigration,
  runLegacyMigrationWithSurreal,
} from "../src/migration/run.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import { deterministicId, sha256hex } from "../src/db/transactions.ts";
import {
  legacyIdentityPrefetchKey,
  SurrealLegacyMigrationBackend,
} from "../src/migration/store.ts";
import type {
  ApprovedLegacyHostMapping,
  LegacyIdentityPrefetch,
  MigrationIdentityCommit,
  MigrationRunHandle,
} from "../src/migration/store.ts";
import {
  buildLegacyHostMappingApproval,
  buildMigrationPreflightApproval,
  canonicalMigrationJson,
  migrationArtifactSha256,
  migrationApprovalKeyFingerprint,
  validateMigrationSafetyEvidence,
  writeMigrationPreflightApprovalArtifact,
  type MigrationPreflightApproval,
} from "../src/migration/authorization.ts";
import { expectedSuccessfulRestoreCheckNames } from "../src/backup/restore-test.ts";
import { buildPreflightReport } from "../src/migration/preflight.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
  ensureModel,
  ensureVendor,
  ensureWorkspace,
} from "../src/db/repositories/identity.ts";
import {
  ensureSourceLocation,
  ensureSourceRevision,
  ensureSourceRoot,
  setLocationRevisions,
  updateSourceRevisionParse,
} from "../src/db/repositories/provenance.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
} from "./db-test-utils.ts";
import { isolatedRestoreTargetEvidence } from "./restore-target-fixture.ts";
import { codexParser } from "../src/parsers/codex/index.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";

const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

interface ContentAddressedSnapshot {
  snapshotPath: string;
  snapshotSha256: string;
  snapshotSizeBytes: number;
}

function legacyMappingId(table: string, legacyId: string): RecordId {
  return new RecordId(
    "legacy_identity_map",
    deterministicId("lmap", `${table}:${legacyId}`),
  );
}

async function contentAddressSnapshot(dbPath: string): Promise<ContentAddressedSnapshot> {
  const hashes = await hashFile(dbPath);
  const snapshotPath = path.join(path.dirname(dbPath), `index__${hashes.sha256}.sqlite`);
  await rename(dbPath, snapshotPath);
  return {
    snapshotPath,
    snapshotSha256: hashes.sha256,
    snapshotSizeBytes: hashes.sizeBytes,
  };
}

function approvedHost(identity: {
  hostUuid: string;
  hostname: string;
  platform: string;
  arch: string;
  osUsername: string;
  homePath: string;
}) {
  return [{ mappingId: "test-host", host: identity, pathPrefixes: ["/Users/test"] }];
}

async function authorizedOptions(
  db: Parameters<typeof probeMigrationApprovalBaselineFromDb>[0],
  snapshot: ContentAddressedSnapshot,
  mappings: ApprovedLegacyHostMapping[],
  temp: string,
  options: {
    checkRawFiles?: boolean;
    approval?: MigrationPreflightApproval;
  } = {},
) {
  const live = await probeMigrationApprovalBaselineFromDb(db);
  const hostMapping = buildLegacyHostMappingApproval(
    snapshot.snapshotPath,
    snapshot.snapshotSha256,
    mappings,
  );
  const identity = mappings[0]?.host ?? {
    hostUuid: "authorization",
    hostname: "authorization",
    platform: "unknown",
    arch: "unknown",
    osUsername: "unknown",
    homePath: "/authorization",
  };
  const report = await buildPreflightReport({
    snapshotPath: snapshot.snapshotPath,
    snapshotSha256: snapshot.snapshotSha256,
    identity,
    live,
    checkRawFiles: options.checkRawFiles ?? false,
  });
  const approval = options.approval ?? buildMigrationPreflightApproval({
    report,
    snapshotSizeBytes: snapshot.snapshotSizeBytes,
    checkRawFiles: options.checkRawFiles ?? false,
    liveProbe: live,
    hostMappingArtifactSha256: hostMapping.artifactSha256,
    approvedBy: "integration-test",
    approvedAt: new Date(Date.now() - 3_000).toISOString(),
  });
  const approvedAtMs = Date.parse(approval.approvedAt);
  const suffix = crypto.randomUUID();
  const attemptId = suffix.replaceAll("-", "");
  const restoreNamespace = `baka_restore_test_${attemptId}`;
  const evidenceArchiveRoot = path.join(temp, "archive");
  const approvalPath = path.join(temp, `approval-${suffix}.json`);
  await writeMigrationPreflightApprovalArtifact(approvalPath, approval);
  const approvalFile = await hashFile(approvalPath);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const keyFingerprint = migrationApprovalKeyFingerprint(publicKeyPem);
  const issuedAt = new Date(approvedAtMs + 500).toISOString();
  const attestationPayload = {
    approvalFileSha256: approvalFile.sha256,
    approvalArtifactSha256: approval.artifactSha256,
    hostMappingArtifactSha256: hostMapping.artifactSha256,
    snapshotSha256: snapshot.snapshotSha256,
    snapshotSizeBytes: snapshot.snapshotSizeBytes,
    observedDeletedCount: approval.evidence.expectedDeletedCount,
    issuedAt,
  };
  const attestation = {
    kind: "baka-legacy-migration-attestation" as const,
    formatVersion: 1 as const,
    keyFingerprint,
    payload: attestationPayload,
    signature: sign(
      null,
      Buffer.from(canonicalMigrationJson(attestationPayload), "utf8"),
      privateKey,
    ).toString("base64"),
  };
  const backupDir = path.join(evidenceArchiveRoot, "backups", "surreal");
  const manifestDir = path.join(evidenceArchiveRoot, "backups", "manifests");
  await mkdir(backupDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  const exportFile = `backup-${suffix}.surql.gz`;
  const backupPath = path.join(backupDir, exportFile);
  await writeFile(backupPath, "synthetic logical export\n");
  const backup = await hashFile(backupPath);
  const manifestPath = path.join(manifestDir, `backup-${suffix}.json`);
  const backupCreatedAt = new Date(approvedAtMs + 1_000).toISOString();
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: backupCreatedAt,
    surrealdbVersion: "surrealdb-3.2.3",
    schemaVersion: 5,
    bakaCommit: "test",
    namespace: "baka",
    database: "archive",
    recordCounts: {},
    rawManifestSha256: "b".repeat(64),
    exportFile,
    compression: "gzip",
    exportBytes: backup.sizeBytes,
    exportSha256: backup.sha256,
  })}\n`);
  const manifest = await hashFile(manifestPath);
  const restorePath = path.join(manifestDir, `restore-${suffix}.json`);
  const restoreStartedAt = new Date(approvedAtMs + 2_000).toISOString();
  const restoreFinishedAt = new Date(approvedAtMs + 2_100).toISOString();
  const restoreCreatedAt = new Date(approvedAtMs + 2_200).toISOString();
  await writeFile(restorePath, `${JSON.stringify({
    formatVersion: 5,
    ok: true,
    attemptId,
    startedAt: restoreStartedAt,
    finishedAt: restoreFinishedAt,
    createdAt: restoreCreatedAt,
    runId: `integration-${suffix}`,
    namespace: restoreNamespace,
    database: "archive",
    archiveRoot: evidenceArchiveRoot,
    rawArchiveRoot: evidenceArchiveRoot,
    exportPath: backupPath,
    exportFile,
    exportBytes: backup.sizeBytes,
    exportSha256: backup.sha256,
    manifestPath,
    manifestFile: path.basename(manifestPath),
    manifestSha256: manifest.sha256,
    rawManifestSha256: "b".repeat(64),
    schemaVersion: 5,
    searchDocuments: 0,
    chunks: 0,
    checks: expectedSuccessfulRestoreCheckNames(0, 0).map((name) => ({
      name,
      ok: true,
      detail: `contract fixture: ${name}`,
    })),
    target: isolatedRestoreTargetEvidence(),
    cleanup: {
      databaseClosed: true,
      temporaryExportRemoved: true,
      namespaceRemoved: true,
    },
  })}\n`);
  const restore = await hashFile(restorePath);
  return {
    approvedHostMappings: mappings,
    reportPath: path.join(temp, `migration-report-${suffix}.json`),
    approvalTrustAnchor: {
      ed25519PublicKeyPem: publicKeyPem,
      sha256Fingerprint: keyFingerprint,
    },
    safetyContext: {
      schemaVersion: 5,
      sourceNamespace: "baka",
      sourceDatabase: "archive",
      restoreNamespace,
      archiveRoot: evidenceArchiveRoot,
    },
    authorization: {
      approval,
      approvalFile: {
        path: approvalPath,
        sha256: approvalFile.sha256,
        sizeBytes: approvalFile.sizeBytes,
        createdAt: approval.approvedAt,
      },
      attestation,
      currentLiveProbe: live,
      hostMapping,
      safety: {
        backup: {
          path: backupPath,
          sha256: backup.sha256,
          sizeBytes: backup.sizeBytes,
          createdAt: backupCreatedAt,
        },
        restore: {
          path: restorePath,
          sha256: restore.sha256,
          sizeBytes: restore.sizeBytes,
          createdAt: restoreCreatedAt,
          ok: true as const,
        },
      },
    },
  };
}

function createLegacySchema(db: Database): void {
  db.run(`CREATE TABLE agent_systems (
    id INTEGER PRIMARY KEY, slug TEXT NOT NULL, display_name TEXT, kind TEXT)`);
  db.run(`CREATE TABLE projects (
    id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, external_id TEXT NOT NULL,
    name TEXT, path TEXT)`);
  db.run(`CREATE TABLE source_files (
    id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, original_path TEXT NOT NULL,
    root_path TEXT, relative_path TEXT, status TEXT NOT NULL, size INTEGER,
    mtime_ms REAL, sha256 TEXT NOT NULL, head_hash TEXT, deleted_at TEXT)`);
  db.run(`CREATE TABLE raw_backups (
    id INTEGER PRIMARY KEY, source_file_id INTEGER NOT NULL, archive_path TEXT NOT NULL,
    sha256 TEXT, size INTEGER, status TEXT)`);
  db.run(`CREATE TABLE threads (
    id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, project_id INTEGER,
    external_id TEXT NOT NULL, title TEXT, started_at TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE thread_records (
    id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, source_file_id INTEGER,
    sequence INTEGER NOT NULL, record_type TEXT, timestamp TEXT, payload TEXT NOT NULL)`);
  db.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, source_record_id INTEGER,
    external_id TEXT, sequence INTEGER NOT NULL, role TEXT, timestamp TEXT)`);
  db.run(`CREATE TABLE message_chunks (
    id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, source_record_id INTEGER,
    sequence INTEGER NOT NULL, kind TEXT, content_path TEXT, metadata_path TEXT,
    content_sha256 TEXT, content_bytes INTEGER)`);
}

interface MinimalLegacySource {
  id: number;
  originalPath: string;
  sha256: string;
  status?: "active" | "deleted_in_source";
  threadExternalId?: string;
  payload?: string;
}

async function minimalSnapshot(
  dir: string,
  name: string,
  sources: MinimalLegacySource[],
): Promise<ContentAddressedSnapshot> {
  const dbPath = path.join(dir, `${name}.sqlite`);
  const db = new Database(dbPath, { create: true });
  createLegacySchema(db);
  db.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  for (const source of sources) {
    const sourceStatus = source.status ??
      (source.threadExternalId ? "deleted_in_source" : "active");
    db.run(
      `INSERT INTO source_files VALUES (
        ?, 1, ?, '/Users/test/.claude', 'same.jsonl', ?, 0, 1, ?, NULL, ?)`,
      [
        source.id,
        source.originalPath,
        sourceStatus,
        source.sha256,
        sourceStatus === "deleted_in_source" ? "2026-01-01T00:00:00Z" : null,
      ],
    );
    if (source.threadExternalId) {
      db.run(
        `INSERT INTO threads VALUES (?, 1, NULL, ?, NULL, NULL, NULL)`,
        [source.id, source.threadExternalId],
      );
      db.run(
        `INSERT INTO thread_records VALUES (?, ?, ?, 0, 'event', NULL, ?)`,
        [source.id, source.id, source.id, source.payload ?? JSON.stringify({ value: source.id })],
      );
    }
  }
  db.close();
  return contentAddressSnapshot(dbPath);
}

testDb("migration run: synthetic SQLite → SurrealDB, повтор без дублей", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-integration-"));
  const archiveRoot = path.join(temp, "archive");
  const buildingSnapshotPath = path.join(temp, "legacy-snapshot.sqlite");
  const rawPath = path.join(import.meta.dir, "fixtures", "claude-code", "basic-dialogue.jsonl");
  const hashes = await hashFile(rawPath);
  const lines = (await readFile(rawPath, "utf8")).trimEnd().split("\n");
  const legacy = new Database(buildingSnapshotPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  legacy.run(`INSERT INTO projects VALUES (1, 1, 'p1', 'Project', '/Users/test/p1')`);
  legacy.run(
    `INSERT INTO source_files VALUES (
      1, 1, '/Users/test/.claude/projects/basic.jsonl', '/Users/test/.claude/projects',
      'basic.jsonl', 'deleted_in_source', ?, 1, ?, ?, '2026-01-01T00:00:00Z')`,
    [hashes.sizeBytes, hashes.sha256, hashes.headHash],
  );
  legacy.run(
    `INSERT INTO raw_backups VALUES (1, 1, ?, ?, ?, 'active')`,
    [rawPath, hashes.sha256, hashes.sizeBytes],
  );
  legacy.run(
    `INSERT INTO threads VALUES (
      1, 1, 1, 'aaaa1111-2222-4333-8444-555555555555',
      'Разбор renderReport', NULL, NULL)`,
  );
  for (const [index, payload] of lines.entries()) {
    legacy.run(
      `INSERT INTO thread_records VALUES (?, 1, 1, ?, 'event', NULL, ?)`,
      [index + 1, index, payload],
    );
  }
  legacy.close();
  const snapshot = await contentAddressSnapshot(buildingSnapshotPath);

  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "migration-test-host",
      hostname: "migration-test",
      platform: "darwin",
      arch: "arm64",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const staleHost = await ensureHost(t.db, identity);
    await t.db.query(
      `CREATE ONLY sync_run:stale_migration SET kind = "migration", status = "running",
         started_at = time::now(), host = $host, baka_commit = "stale", schema_version = 5;
       CREATE ONLY migration_meta:stale_migration SET status = "running",
         started_at = time::now(), sync_run = sync_run:stale_migration;`,
      { host: staleHost },
    );
    const common = {
      db: t.db,
      archiveRoot,
      identity,
      approvedHostMappings: approvedHost(identity),
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
    };
    const first = await runLegacyMigrationWithSurreal({
      ...common,
      ...(await authorizedOptions(t.db, snapshot, common.approvedHostMappings, temp)),
    });
    expect(first.status).toBe("completed");
    expect(first.assignmentCoverageOk).toBe(true);
    expect(first.recovery).toEqual({ raw: 1, payload: 0, normalized: 0 });
    expect(first.reconciliation).toMatchObject({
      legacyTotal: 14,
      inserted: 14,
      matched: 0,
      quarantined: 0,
      lost: 0,
      ok: true,
    });
    const [metaRows] = await t.db.query<[
      Array<{
        id: RecordId;
        status: string;
        approval_artifact_sha256: string;
        approval_file_sha256: string;
        approval_attestation_sha256: string;
        approval_key_fingerprint: string;
        host_mapping_artifact_sha256: string;
        host_mapping_assignments_json: string;
        backup_artifact_sha256: string;
        restore_artifact_sha256: string;
        report_path: string;
        report_sha256: string;
      }>,
    ]>("SELECT * FROM migration_meta ORDER BY started_at DESC LIMIT 1");
    const meta = metaRows?.[0];
    expect(meta?.status).toBe("completed");
    expect(meta?.approval_artifact_sha256).toBe(first.approvalArtifactSha256!);
    expect(meta?.approval_file_sha256).toBe(first.approvalFileSha256!);
    expect(meta?.approval_attestation_sha256).toBe(first.approvalAttestationSha256!);
    expect(meta?.approval_key_fingerprint).toBe(first.approvalKeyFingerprint!);
    expect(meta?.host_mapping_artifact_sha256).toBe(first.hostMappingArtifactSha256!);
    expect(meta?.backup_artifact_sha256).toBe(first.backupArtifactSha256!);
    expect(meta?.restore_artifact_sha256).toBe(first.restoreArtifactSha256!);
    expect(meta?.host_mapping_assignments_json.length).toBeGreaterThan(10);
    expect(meta?.report_path).toBe(first.reportPath!);
    expect(meta?.report_sha256).toBe((await hashFile(first.reportPath!)).sha256);
    const [committedRows] = await t.db.query<[number]>(
      `RETURN count((SELECT VALUE id FROM migration_row_commit
        WHERE migration = $migration AND category IN ["matched", "inserted"]));`,
      { migration: meta!.id },
    );
    expect(committedRows).toBe(first.reconciliation.accounted);
    const [stale] = await t.db.query<[
      Array<{ status: string; notes?: string }>,
    ]>("SELECT status, notes FROM migration_meta WHERE id = migration_meta:stale_migration");
    expect(stale?.[0]).toMatchObject({
      status: "failed",
      notes: "recovered_missing_or_invalid_report",
    });

    const counts = async () => {
      const [rows] = await t.db.query<[
        Array<{ table: string; count: number }>,
      ]>(`RETURN [
        { table: "dialogue", count: count((SELECT VALUE id FROM dialogue)) },
        { table: "dialogue_revision", count: count((SELECT VALUE id FROM dialogue_revision)) },
        { table: "message", count: count((SELECT VALUE id FROM message)) },
        { table: "chunk", count: count((SELECT VALUE id FROM chunk)) },
        { table: "legacy_identity_map", count: count((SELECT VALUE id FROM legacy_identity_map)) }
      ];`);
      return Object.fromEntries((rows ?? []).map((row) => [row.table, row.count]));
    };
    const before = await counts();
    expect(before).toMatchObject({
      dialogue: 1,
      dialogue_revision: 1,
      message: 2,
      legacy_identity_map: 14,
    });

    await t.db.query(
      `CREATE ONLY migration_quarantine:retry_generic SET migration = $migration,
         legacy_table = "agent_systems", legacy_id = "1", raw_payload = {},
         reason = "historical", parser_name = "legacy", parser_version = "1",
         retryable = true, attempts = 1, lineage_key = "agent_systems:1",
         first_failed_at = time::now(), last_failed_at = time::now();
       CREATE ONLY migration_quarantine:retry_project SET migration = $migration,
         legacy_table = "projects", legacy_id = "1", raw_payload = {},
         reason = "historical", parser_name = "legacy", parser_version = "1",
         retryable = true, attempts = 1, lineage_key = "projects:1",
         first_failed_at = time::now(), last_failed_at = time::now();
       CREATE ONLY migration_quarantine:retry_source SET migration = $migration,
         legacy_table = "source_files", legacy_id = "1", raw_payload = {},
         reason = "historical", parser_name = "legacy", parser_version = "1",
         retryable = true, attempts = 1, lineage_key = "source_files:1",
         first_failed_at = time::now(), last_failed_at = time::now();
       CREATE ONLY migration_quarantine:retry_raw SET migration = $migration,
         legacy_table = "raw_backups", legacy_id = "1", raw_payload = {},
         reason = "historical", parser_name = "legacy", parser_version = "1",
         retryable = true, attempts = 1, lineage_key = "raw_backups:1",
         first_failed_at = time::now(), last_failed_at = time::now();`,
      { migration: meta!.id },
    );

    const second = await runLegacyMigrationWithSurreal({
      ...common,
      ...(await authorizedOptions(t.db, snapshot, common.approvedHostMappings, temp)),
    });
    expect(second.status).toBe("completed");
    expect(second.reconciliation).toMatchObject({
      legacyTotal: 14,
      inserted: 0,
      matched: 14,
      quarantined: 0,
      lost: 0,
      ok: true,
    });
    const [secondMetaRows] = await t.db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM migration_meta WHERE report_path = $path",
      { path: second.reportPath },
    );
    const [ledgerHistory] = await t.db.query<[Array<{ inserted: number; matched: number; rows: number }>]>(
      `RETURN [
        {
          inserted: count((SELECT VALUE id FROM migration_row_commit
            WHERE migration = $first AND category = "inserted")),
          matched: count((SELECT VALUE id FROM migration_row_commit
            WHERE migration = $first AND category = "matched")),
          rows: count((SELECT VALUE id FROM migration_row_commit WHERE migration = $first))
        },
        {
          inserted: count((SELECT VALUE id FROM migration_row_commit
            WHERE migration = $second AND category = "inserted")),
          matched: count((SELECT VALUE id FROM migration_row_commit
            WHERE migration = $second AND category = "matched")),
          rows: count((SELECT VALUE id FROM migration_row_commit WHERE migration = $second))
        }
      ];`,
      { first: meta!.id, second: secondMetaRows?.[0]?.id },
    );
    expect(ledgerHistory).toEqual([
      { inserted: 14, matched: 0, rows: 14 },
      { inserted: 0, matched: 14, rows: 14 },
    ]);
    expect(await counts()).toEqual(before);
    const [revision] = await t.db.query<[
      Array<{ dialogues_discovered: number }>,
    ]>("SELECT dialogues_discovered FROM source_revision LIMIT 1");
    expect(revision?.[0]?.dialogues_discovered).toBe(1);
    const [resolvedRetries] = await t.db.query<[
      Array<{ legacy_table: string; resolved_at?: Date; resolution?: string }>,
    ]>(
      `SELECT legacy_table, resolved_at, resolution FROM [
         migration_quarantine:retry_generic,
         migration_quarantine:retry_project,
         migration_quarantine:retry_source,
         migration_quarantine:retry_raw
       ] ORDER BY legacy_table;`,
    );
    expect(resolvedRetries?.map((row) => row.legacy_table)).toEqual([
      "agent_systems",
      "projects",
      "raw_backups",
      "source_files",
    ]);
    expect(resolvedRetries?.map((row) => ({
      table: row.legacy_table,
      resolved: row.resolved_at !== undefined,
      retried: row.resolution?.startsWith("retry_mapped:") === true,
    }))).toEqual([
      { table: "agent_systems", resolved: true, retried: true },
      { table: "projects", resolved: true, retried: true },
      { table: "raw_backups", resolved: true, retried: true },
      { table: "source_files", resolved: true, retried: true },
    ]);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("bulk identity failure in batch two rolls back batch one mappings and ledgers", async () => {
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "bulk-rollback-host",
      hostname: "bulk-rollback-host",
      platform: "test",
      arch: "test",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const host = await ensureHost(t.db, identity);
    const run: MigrationRunHandle = {
      syncRunId: new RecordId("sync_run", "bulk_rollback"),
      migrationId: new RecordId("migration_meta", "bulk_rollback"),
    };
    await t.db.query(
      `CREATE ONLY $sync SET kind = "migration", status = "running",
       started_at = time::now(), host = $host, baka_commit = "test", schema_version = 5;
       CREATE ONLY $migration SET status = "running", started_at = time::now(),
       sync_run = $sync;`,
      { sync: run.syncRunId, migration: run.migrationId, host },
    );
    const commits: MigrationIdentityCommit[] = Array.from({ length: 501 }, (_, index) => ({
      table: "messages",
      legacyId: String(index + 1),
      target: run.migrationId,
      category: "inserted",
    }));
    const requests = commits.map((row) => ({ table: row.table, legacyId: row.legacyId }));
    const prefetch: LegacyIdentityPrefetch = {
      requestedKeys: new Set(requests.map((row) =>
        legacyIdentityPrefetchKey(row.table, row.legacyId)
      )),
      existing: new Map(),
      unresolvedQuarantines: new Map(),
    };
    const conflictingLedger = new RecordId(
      "migration_row_commit",
      deterministicId("mrc", "bulk_rollback:messages:501"),
    );
    await t.db.query(
      `CREATE ONLY $ledger SET migration = $migration, legacy_table = "messages",
       legacy_id = "501", category = "inserted", target = message:preexisting,
       committed_at = time::now();`,
      { ledger: conflictingLedger, migration: run.migrationId },
    );
    const backend = new SurrealLegacyMigrationBackend(t.db, "/archive", identity);
    await expect(backend.commitIdentityBatch(run, commits, undefined, prefetch)).rejects.toThrow();

    const mappingIds = commits.map((row) => legacyMappingId(row.table, row.legacyId));
    const [mappingCount] = await t.db.query<[number]>(
      "RETURN count((SELECT VALUE id FROM $ids));",
      { ids: mappingIds },
    );
    const [ledgerCount] = await t.db.query<[number]>(
      "RETURN count((SELECT VALUE id FROM migration_row_commit WHERE migration = $migration));",
      { migration: run.migrationId },
    );
    expect(mappingCount).toBe(0);
    expect(ledgerCount).toBe(1);
  } finally {
    await dropTestDb(t);
  }
}, 30_000);

testDb("stale prefetched mapping target fails closed inside the atomic transaction", async () => {
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "mapping-race-host",
      hostname: "mapping-race-host",
      platform: "test",
      arch: "test",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const host = await ensureHost(t.db, identity);
    const run: MigrationRunHandle = {
      syncRunId: new RecordId("sync_run", "mapping_race"),
      migrationId: new RecordId("migration_meta", "mapping_race"),
    };
    await t.db.query(
      `CREATE ONLY $sync SET kind = "migration", status = "running",
       started_at = time::now(), host = $host, baka_commit = "test", schema_version = 5;
       CREATE ONLY $migration SET status = "running", started_at = time::now(),
       sync_run = $sync;`,
      { sync: run.syncRunId, migration: run.migrationId, host },
    );
    const mapping = legacyMappingId("messages", "1");
    const expectedTarget = run.migrationId;
    await t.db.query(
      `CREATE ONLY $mapping SET legacy_table = "messages", legacy_id = "1",
       target = $target, created_at = time::now();`,
      { mapping, target: expectedTarget },
    );
    const backend = new SurrealLegacyMigrationBackend(t.db, "/archive", identity);
    const requests = [{ table: "messages" as const, legacyId: "1" }];
    const prefetched = await backend.prefetchIdentities(requests, run);
    const changedTarget = run.syncRunId;
    await t.db.query("UPDATE ONLY $mapping SET target = $target", {
      mapping,
      target: changedTarget,
    });
    const commits: MigrationIdentityCommit[] = [{
      table: "messages",
      legacyId: "1",
      target: expectedTarget,
      category: "matched",
    }];
    await expect(backend.commitIdentityBatch(run, commits, undefined, prefetched))
      .rejects.toThrow();
    const [ledgerCount] = await t.db.query<[number]>(
      "RETURN count((SELECT VALUE id FROM migration_row_commit WHERE migration = $migration));",
      { migration: run.migrationId },
    );
    const [mappingRow] = await t.db.query<[{ target: RecordId } | undefined]>(
      "SELECT target FROM ONLY $mapping",
      { mapping },
    );
    expect(ledgerCount).toBe(0);
    expect(String(mappingRow?.target)).toBe(String(changedTarget));
  } finally {
    await dropTestDb(t);
  }
}, 30_000);

testDb("dangling identity target fails before mapping and ledger writes", async () => {
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "dangling-target-host",
      hostname: "dangling-target-host",
      platform: "test",
      arch: "test",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const host = await ensureHost(t.db, identity);
    const run: MigrationRunHandle = {
      syncRunId: new RecordId("sync_run", "dangling_target"),
      migrationId: new RecordId("migration_meta", "dangling_target"),
    };
    await t.db.query(
      `CREATE ONLY $sync SET kind = "migration", status = "running",
       started_at = time::now(), host = $host, baka_commit = "test", schema_version = 5;
       CREATE ONLY $migration SET status = "running", started_at = time::now(),
       sync_run = $sync;`,
      { sync: run.syncRunId, migration: run.migrationId, host },
    );
    const backend = new SurrealLegacyMigrationBackend(t.db, "/archive", identity);
    const request = [{ table: "messages" as const, legacyId: "404" }];
    const prefetched = await backend.prefetchIdentities(request, run);
    await expect(backend.commitIdentityBatch(run, [{
      table: "messages",
      legacyId: "404",
      target: new RecordId("message", "missing"),
      category: "inserted",
    }], undefined, prefetched)).rejects.toThrow(
      "legacy identity target missing during atomic commit",
    );
    const [counts] = await t.db.query<[Array<{ mappings: number; ledgers: number }>]>(
      `RETURN [{
        mappings: count((SELECT VALUE id FROM legacy_identity_map)),
        ledgers: count((SELECT VALUE id FROM migration_row_commit WHERE migration = $migration))
      }];`,
      { migration: run.migrationId },
    );
    expect(counts?.[0]).toEqual({ mappings: 0, ledgers: 0 });
  } finally {
    await dropTestDb(t);
  }
}, 30_000);

testDb("published report recovers a crash before lifecycle finish", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-report-recovery-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "report-recovery", [{
    id: 1,
    originalPath: "/Users/test/.claude/report.jsonl",
    sha256: "4".repeat(64),
  }]);
  const identity = {
    hostUuid: "report-recovery-host",
    hostname: "report-recovery-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const t = await createTestDb();
  try {
    const firstAuth = await authorizedOptions(t.db, snapshot, mappings, temp);
    const failingBackend = new SurrealLegacyMigrationBackend(
      t.db,
      archiveRoot,
      identity,
      mappings,
      {
        beforeLifecycleFinishCommit: () => {
          throw new Error("simulated finish crash");
        },
      },
    );
    await expect(runLegacyMigration({
      ...snapshot,
      ...firstAuth,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: failingBackend,
    })).rejects.toThrow("simulated finish crash");
    const published = JSON.parse(await readFile(firstAuth.reportPath, "utf8")) as {
      migrationId: string;
      status: string;
    };
    expect(published.status).toBe("completed");
    const [before] = await t.db.query<[Array<{ status: string; report_sha256?: string }>]>(
      "SELECT status, report_sha256 FROM migration_meta WHERE report_path = $path",
      { path: firstAuth.reportPath },
    );
    expect(before?.[0]?.status).toBe("running");
    expect(before?.[0]?.report_sha256).toBeUndefined();

    const secondAuth = await authorizedOptions(t.db, snapshot, mappings, temp);
    await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity,
      ...snapshot,
      ...secondAuth,
      bakaCommit: "test",
      schemaVersion: 5,
    });
    const [after] = await t.db.query<[Array<{ status: string; report_sha256: string }>]>(
      "SELECT status, report_sha256 FROM migration_meta WHERE report_path = $path",
      { path: firstAuth.reportPath },
    );
    expect(after?.[0]?.status).toBe("completed");
    expect(after?.[0]?.report_sha256).toBe((await hashFile(firstAuth.reportPath)).sha256);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

async function assertLifecycleTamperModes(
  modes: ReadonlyArray<"truncate" | "same-size" | "replace-inode" | "symlink">,
): Promise<void> {
  for (const mode of modes) {
    const temp = await mkdtemp(path.join(tmpdir(), `baka-migration-report-${mode}-`));
    const archiveRoot = path.join(temp, "archive");
    const snapshot = await minimalSnapshot(temp, mode, [{
      id: 1,
      originalPath: `/Users/test/.claude/${mode}.jsonl`,
      sha256: mode === "truncate" ? "1".repeat(64)
        : mode === "same-size" ? "2".repeat(64)
        : mode === "replace-inode" ? "3".repeat(64)
        : "4".repeat(64),
    }]);
    const identity = {
      hostUuid: `report-${mode}-host`,
      hostname: `report-${mode}-host`,
      platform: "darwin",
      arch: "arm64",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const mappings = approvedHost(identity);
    const t = await createTestDb();
    try {
      const auth = await authorizedOptions(t.db, snapshot, mappings, temp);
      const backend = new SurrealLegacyMigrationBackend(
        t.db,
        archiveRoot,
        identity,
        mappings,
        {
          beforeLifecycleFinishCommit: async (_run, publication) => {
            const finalPath = publication!.path;
            const bytes = await readFile(finalPath);
            if (mode === "truncate") {
              await writeFile(finalPath, "{}\n");
            } else if (mode === "same-size") {
              const text = bytes.toString("utf8");
              const changed = text.replace('"status": "completed"', '"status": "xompleted"');
              expect(Buffer.byteLength(changed)).toBe(bytes.byteLength);
              await writeFile(finalPath, changed);
            } else if (mode === "replace-inode") {
              const replacement = `${finalPath}.replacement`;
              await writeFile(replacement, bytes);
              await rename(replacement, finalPath);
            } else {
              const original = `${finalPath}.original`;
              await rename(finalPath, original);
              await symlink(original, finalPath);
            }
          },
        },
      );
      await expect(runLegacyMigration({
        ...snapshot,
        ...auth,
        bakaCommit: "test",
        schemaVersion: 5,
        backend,
      })).rejects.toThrow();
      const [meta] = await t.db.query<[Array<{
        status: string;
        report_sha256?: string;
        sync_run: RecordId;
      }>]>(
        "SELECT status, report_sha256, sync_run FROM migration_meta WHERE report_path = $path",
        { path: auth.reportPath },
      );
      const [sync] = await t.db.query<[Array<{ status: string }>]>(
        "SELECT status FROM sync_run WHERE id = $sync",
        { sync: meta?.[0]?.sync_run },
      );
      expect(meta?.[0]?.status).toBe("failed");
      expect(meta?.[0]?.status).not.toBe("completed");
      expect(meta?.[0]?.report_sha256).toBeUndefined();
      expect(sync?.[0]?.status).toBe("failed");
    } finally {
      await dropTestDb(t);
      await rm(temp, { recursive: true, force: true });
    }
  }
}

testDb("finish lifecycle rejects truncation and same-size tamper immediately", async () => {
  await assertLifecycleTamperModes(["truncate", "same-size"]);
}, 30_000);

testDb("finish lifecycle rejects inode replacement and symlink immediately", async () => {
  await assertLifecycleTamperModes(["replace-inode", "symlink"]);
}, 30_000);

testDb("post-commit authentication downgrades tamper and valid lost-ack recovers deterministically", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-report-postcommit-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "postcommit", [{
    id: 1,
    originalPath: "/Users/test/.claude/postcommit.jsonl",
    sha256: "5".repeat(64),
  }]);
  const identity = {
    hostUuid: "report-postcommit-host",
    hostname: "report-postcommit-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const t = await createTestDb();
  try {
    const tamperAuth = await authorizedOptions(t.db, snapshot, mappings, temp);
    await expect(runLegacyMigration({
      ...snapshot,
      ...tamperAuth,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings, {
        afterLifecycleCommitBeforeFinalAuthentication: async (_run, publication) => {
          const bytes = await readFile(publication!.path, "utf8");
          await writeFile(publication!.path, bytes.replace("completed", "xompleted"));
        },
      }),
    })).rejects.toThrow();
    const [tampered] = await t.db.query<[Array<{ status: string }>]>(
      "SELECT status FROM migration_meta WHERE report_path = $path",
      { path: tamperAuth.reportPath },
    );
    expect(tampered?.[0]?.status).toBe("failed");

    const lostAckAuth = await authorizedOptions(t.db, snapshot, mappings, temp);
    await expect(runLegacyMigration({
      ...snapshot,
      ...lostAckAuth,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings, {
        afterLifecycleCommitBeforeFinalAuthentication: () => {
          throw new Error("simulated lost acknowledgement");
        },
      }),
    })).rejects.toThrow("simulated lost acknowledgement");
    const recovery = new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings);
    await recovery.reconcileMigrationLifecycle();
    const [recovered] = await t.db.query<[Array<{ status: string; report_sha256: string }>]>(
      "SELECT status, report_sha256 FROM migration_meta WHERE report_path = $path",
      { path: lostAckAuth.reportPath },
    );
    expect(recovered?.[0]?.status).toBe("completed");
    expect(recovered?.[0]?.report_sha256).toBe((await hashFile(lostAckAuth.reportPath)).sha256);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("legacy split-write APIs fail closed and stale startup removes only proven uncommitted state", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-hard-crash-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "hard-crash", [{
    id: 1,
    originalPath: "/Users/test/.claude/hard-crash.jsonl",
    sha256: "6".repeat(64),
    threadExternalId: "hard-crash-thread",
    payload: JSON.stringify({ crash: true }),
  }]);
  const identity = {
    hostUuid: "hard-crash-host",
    hostname: "hard-crash-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const t = await createTestDb();
  try {
    const authorized = await authorizedOptions(t.db, snapshot, mappings, temp);
    const safety = await validateMigrationSafetyEvidence(
      authorized.authorization.safety,
      authorized.safetyContext,
    );
    const backend = new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings);
    backend.configureHostMappingApproval(authorized.authorization.hostMapping);
    backend.configureAuthenticatedPreflightScope({
      snapshotSha256: snapshot.snapshotSha256,
      missingRawBackups: new Map(),
    });
    const run = await backend.startRun({
      legacyDbPath: snapshot.snapshotPath,
      legacyDbSha256: snapshot.snapshotSha256,
      bakaCommit: "test",
      schemaVersion: 5,
      approvalArtifactSha256: authorized.authorization.approval.artifactSha256,
      approvalFileSha256: authorized.authorization.approvalFile!.sha256,
      approvalAttestationSha256: migrationArtifactSha256(authorized.authorization.attestation),
      approvalKeyFingerprint: authorized.authorization.attestation!.keyFingerprint,
      hostMappingArtifactSha256: authorized.authorization.hostMapping.artifactSha256,
      hostMappingAssignmentsJson: JSON.stringify(authorized.authorization.hostMapping.assignments),
      backupArtifactPath: authorized.authorization.safety.backup.path,
      backupArtifactSha256: authorized.authorization.safety.backup.sha256,
      restoreArtifactPath: authorized.authorization.safety.restore.path,
      restoreArtifactSha256: authorized.authorization.safety.restore.sha256,
      backupManifestPath: safety.manifestPath,
      backupManifestSha256: safety.manifestSha256,
      rawManifestSha256: safety.rawManifestSha256,
      restoreNamespace: safety.restoreNamespace,
      reportPath: authorized.reportPath,
    });
    const agentRow = {
      id: 1,
      slug: "claude-code",
      display_name: "Claude Code",
      kind: "file_tree",
    };
    const agent = (await backend.ensureAgent(agentRow)).value;
    const sourceRow = {
      id: 1,
      agent_id: 1,
      original_path: "/Users/test/.claude/hard-crash.jsonl",
      root_path: "/Users/test/.claude",
      relative_path: "hard-crash.jsonl",
      status: "active",
      size: 0,
      mtime_ms: 1,
      sha256: "6".repeat(64),
    };
    await expect(backend.ensureSourceFile(sourceRow, agent)).rejects.toThrow("commitSourceRows");
    await expect(backend.ensureProject({
      id: 1,
      agent_id: 1,
      external_id: "unsafe-project",
      path: "/Users/test/unsafe-project",
    }, agent)).rejects.toThrow("commitProjectRow");
    await t.db.query(
      `CREATE ONLY workspace:stale_uncommitted SET name = "stale",
       first_seen_at = time::now(), last_seen_at = time::now(), created_by_run = $migration;`,
      { migration: run.migrationId },
    );
    const effectCounts = async () => {
      const [rows] = await t.db.query<[Array<{ name: string; count: number }>]>(`RETURN [
        { name: "source_root", count: count((SELECT VALUE id FROM source_root)) },
        { name: "source_location", count: count((SELECT VALUE id FROM source_location)) },
        { name: "source_revision", count: count((SELECT VALUE id FROM source_revision)) },
        { name: "dialogue", count: count((SELECT VALUE id FROM dialogue)) },
        { name: "dialogue_revision", count: count((SELECT VALUE id FROM dialogue_revision)) },
        { name: "message", count: count((SELECT VALUE id FROM message)) },
        { name: "chunk", count: count((SELECT VALUE id FROM chunk)) },
        { name: "search_document", count: count((SELECT VALUE id FROM search_document)) },
        { name: "model", count: count((SELECT VALUE id FROM model)) },
        { name: "vendor", count: count((SELECT VALUE id FROM vendor)) },
        { name: "workspace", count: count((SELECT VALUE id FROM workspace)) },
        { name: "workspace_location", count: count((SELECT VALUE id FROM workspace_location)) }
      ];`);
      return Object.fromEntries(rows?.map((row) => [row.name, row.count]) ?? []);
    };
    expect(Object.values(await effectCounts()).filter((count) => count > 0)).toHaveLength(1);
    await new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings)
      .reconcileMigrationLifecycle();
    expect(Object.values(await effectCounts()).every((count) => count === 0)).toBe(true);
    const [stale] = await t.db.query<[Array<{ status: string; notes: string }>]>(
      "SELECT status, notes FROM migration_meta WHERE id = $id",
      { id: run.migrationId },
    );
    expect(stale?.[0]?.status).toBe("failed");
    expect(stale?.[0]?.notes).toContain("invalid_report");
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("stale-run cleanup preserves shared live state, pointers and preexisting mappings exactly", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-shared-live-"));
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "shared-live-host",
      hostname: "shared-live-host",
      platform: "darwin",
      arch: "arm64",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const host = await ensureHost(t.db, identity);
    const harness = await ensureHarness(t.db, {
      slug: "claude-code",
      displayName: "Claude Code",
      kind: "file_tree",
    });
    const installation = await ensureHarnessInstallation(t.db, {
      host,
      harness,
      installed: true,
      detectedVersion: "live",
    });
    await t.db.query(
      `CREATE ONLY sync_run:shared_live SET kind = "sync", status = "completed",
       started_at = time::now(), finished_at = time::now(), host = $host,
       baka_commit = "live", schema_version = 5;`,
      { host },
    );
    const root = await ensureSourceRoot(t.db, {
      harnessInstallation: installation,
      path: "/Users/test/.claude/shared-live",
      sourceKind: "live",
      parserName: "claude-code",
      snapshotStrategy: "file",
      enabled: true,
    });
    const location = await ensureSourceLocation(t.db, {
      sourceRoot: root,
      relativePath: "live.jsonl",
      originalPath: "/Users/test/.claude/shared-live/live.jsonl",
      basename: "live.jsonl",
    });
    const revision = await ensureSourceRevision(t.db, {
      sourceLocation: location.id,
      sha256: "d".repeat(64),
      sizeBytes: 4,
      mtimeMs: 1,
      rawArchivePath: "raw/claude-code/shared-live.jsonl",
      snapshotKind: "raw",
      parserName: "claude-code",
      parserVersion: 2,
      syncRun: new RecordId("sync_run", "shared_live"),
    });
    await updateSourceRevisionParse(t.db, revision.id, {
      parseStatus: "parsed",
      dialoguesDiscovered: 1,
    });
    await setLocationRevisions(t.db, location.id, {
      currentRevision: revision.id,
      lastSuccessfulRevision: revision.id,
    });
    const vendor = await ensureVendor(t.db, "openai");
    const model = await ensureModel(t.db, {
      vendor,
      canonicalName: "shared-live-model",
      rawName: "shared-live-model",
    });
    const workspace = await ensureWorkspace(t.db, {
      host,
      path: "/Users/test/shared-live-workspace",
      name: "Shared live",
    });
    await t.db.query(
      `CREATE ONLY legacy_identity_map:shared_live_mapping SET legacy_table = "projects",
       legacy_id = "preexisting", target = $workspace, created_at = time::now();
       CREATE ONLY sync_run:shared_stale SET kind = "migration", status = "running",
       started_at = time::now(), host = $host, baka_commit = "stale", schema_version = 5;
       CREATE ONLY migration_meta:shared_stale SET status = "running", started_at = time::now(),
       sync_run = sync_run:shared_stale;
       CREATE ONLY workspace:shared_uncommitted SET name = "uncommitted",
       first_seen_at = time::now(), last_seen_at = time::now(),
       created_by_run = migration_meta:shared_stale;`,
      { host, workspace },
    );

    await new SurrealLegacyMigrationBackend(
      t.db,
      path.join(temp, "archive"),
      identity,
      approvedHost(identity),
    ).reconcileMigrationLifecycle();

    const [sentinel] = await t.db.query<[
      Array<{
        current_revision: RecordId;
        last_successful_revision: RecordId;
        presence_status: string;
      }>,
    ]>("SELECT current_revision, last_successful_revision, presence_status FROM source_location WHERE id = $location", {
      location: location.id,
    });
    expect(String(sentinel?.[0]?.current_revision)).toBe(String(revision.id));
    expect(String(sentinel?.[0]?.last_successful_revision)).toBe(String(revision.id));
    expect(sentinel?.[0]?.presence_status).toBe("active");
    const [preserved] = await t.db.query<[Array<{ exists: boolean }>]>(`RETURN [
      { exists: record::exists($root) }, { exists: record::exists($revision) },
      { exists: record::exists($vendor) }, { exists: record::exists($model) },
      { exists: record::exists($workspace) },
      { exists: record::exists(legacy_identity_map:shared_live_mapping) },
      { exists: record::exists(workspace:shared_uncommitted) }
    ];`, { root, revision: revision.id, vendor, model, workspace });
    expect(preserved?.map((row) => row.exists)).toEqual([
      true, true, true, true, true, true, false,
    ]);

    const partialReport = path.join(temp, "partial-final-report.json");
    await writeFile(partialReport, '{"status":"completed"}\n');
    await t.db.query(
      `CREATE ONLY sync_run:partial_report SET kind = "migration", status = "running",
       started_at = time::now(), host = $host, baka_commit = "stale", schema_version = 5;
       CREATE ONLY migration_meta:partial_report SET status = "running", started_at = time::now(),
       sync_run = sync_run:partial_report, legacy_db_sha256 = $sha, report_path = $report;`,
      { host, sha: "e".repeat(64), report: partialReport },
    );
    await new SurrealLegacyMigrationBackend(
      t.db,
      path.join(temp, "archive"),
      identity,
      approvedHost(identity),
    ).reconcileMigrationLifecycle();
    const [partialMeta] = await t.db.query<[Array<{ status: string; notes: string }>]>(
      "SELECT status, notes FROM migration_meta WHERE id = migration_meta:partial_report",
    );
    expect(partialMeta?.[0]?.status).toBe("failed");
    expect(partialMeta?.[0]?.notes).toContain("invalid_report");
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("legacy_missing_raw requires signed exact ENOENT and retries without duplicates", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-missing-backup-"));
  const archiveRoot = path.join(temp, "archive");
  const sha = "a".repeat(64);
  const dbPath = path.join(temp, "missing-backup.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  legacy.run(
    `INSERT INTO source_files VALUES (
      1, 1, '/Users/test/.claude/projects/missing.jsonl', '/Users/test/.claude/projects',
      'missing.jsonl', 'deleted_in_source', 123, 1, ?, NULL, '2026-01-01T00:00:00Z')`,
    [sha],
  );
  legacy.run(
    `INSERT INTO raw_backups VALUES (1, 1, ?, ?, 123, 'active')`,
    [path.join(temp, "does-not-exist.jsonl"), sha],
  );
  const normalizedContent = "recovered only after exact source ownership";
  const normalizedPayload = JSON.stringify({
    payload: { content: [{ text: normalizedContent }] },
  });
  legacy.run(
    `INSERT INTO threads VALUES (1, 1, NULL, 'missing-raw-thread', 'Missing raw', NULL, NULL)`,
  );
  legacy.run(
    `INSERT INTO thread_records VALUES (10, 1, 1, 0, 'event', NULL, ?)`,
    [normalizedPayload],
  );
  legacy.run(`INSERT INTO messages VALUES (20, 1, 10, NULL, 0, 'user', NULL)`);
  legacy.run(
    `INSERT INTO message_chunks VALUES (30, 20, 10, 0, 'text', ?, NULL, ?, ?)`,
    [
      "/payload/content/0/text",
      sha256hex(normalizedContent),
      Buffer.byteLength(normalizedContent),
    ],
  );
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "migration-missing-backup-host",
      hostname: "migration-missing-backup",
      platform: "darwin",
      arch: "arm64",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const base = {
      db: t.db,
      archiveRoot,
      identity,
      approvedHostMappings: approvedHost(identity),
      bakaCommit: "test",
      schemaVersion: 5,
    };
    const first = await runLegacyMigrationWithSurreal({
      ...base,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, base.approvedHostMappings, temp)),
    });
    expect(first.status).toBe("completed_with_errors");
    expect(first.assignmentCoverageOk).toBe(true);
    expect(first.reconciliation.tables.raw_backups).toMatchObject({
      inserted: 0,
      quarantined: 1,
      lost: 0,
    });
    const [revision] = await t.db.query<[
      Array<{ id: RecordId; snapshot_kind: string; raw_archive_path?: string }>,
    ]>("SELECT id, snapshot_kind, raw_archive_path FROM source_revision WHERE sha256 = $sha", { sha });
    expect(revision).toHaveLength(0);
    const [rawMapping] = await t.db.query<[Array<{ target: RecordId }>]>(
      `SELECT target FROM legacy_identity_map
       WHERE legacy_table = "raw_backups" AND legacy_id = "1"`,
    );
    expect(rawMapping).toHaveLength(0);
    const [unprovenRecordMapping] = await t.db.query<[Array<{ target: RecordId }>]>(
      `SELECT target FROM legacy_identity_map
       WHERE legacy_table = "thread_records" AND legacy_id = "10"`,
    );
    expect(unprovenRecordMapping).toHaveLength(0);
    expect(first.reconciliation.tables.thread_records).toMatchObject({
      matched: 0,
      inserted: 0,
      quarantined: 1,
      lost: 0,
    });

    const retry = await runLegacyMigrationWithSurreal({
      ...base,
      ...snapshot,
      ...(await authorizedOptions(
        t.db,
        snapshot,
        base.approvedHostMappings,
        temp,
        { checkRawFiles: true },
      )),
    });
    expect(retry.status).toBe("completed");
    expect(retry.reconciliation.tables.raw_backups).toMatchObject({
      matched: 0,
      inserted: 1,
      quarantined: 0,
      lost: 0,
    });
    expect(retry.reconciliation.tables.thread_records).toMatchObject({
      inserted: 1,
      quarantined: 0,
      lost: 0,
    });
    const [admittedRevision] = await t.db.query<[
      Array<{ snapshot_kind: string; raw_archive_path?: string }>,
    ]>("SELECT snapshot_kind, raw_archive_path FROM source_revision WHERE sha256 = $sha", { sha });
    expect(admittedRevision).toEqual([{ snapshot_kind: "legacy_missing_raw" }]);
    const [resolved] = await t.db.query<[
      Array<{ resolved_at?: Date; resolution?: string }>,
    ]>(`SELECT resolved_at, resolution FROM migration_quarantine
       WHERE lineage_key = "raw_backups:1"`);
    expect(resolved).toHaveLength(1);
    expect(resolved?.[0]?.resolved_at).toBeDefined();
    expect(resolved?.[0]?.resolution).toStartWith("retry_mapped:");

    const idempotent = await runLegacyMigrationWithSurreal({
      ...base,
      ...snapshot,
      ...(await authorizedOptions(
        t.db,
        snapshot,
        base.approvedHostMappings,
        temp,
        { checkRawFiles: true },
      )),
    });
    expect(idempotent.status).toBe("completed");
    expect(idempotent.reconciliation.tables.raw_backups).toMatchObject({
      matched: 1,
      inserted: 0,
      quarantined: 0,
      lost: 0,
    });
    const [counts] = await t.db.query<[Array<{ revisions: number; mappings: number }>]>(
      `RETURN [{
        revisions: count((SELECT VALUE id FROM source_revision WHERE sha256 = $sha)),
        mappings: count((SELECT VALUE id FROM legacy_identity_map
          WHERE legacy_table = "raw_backups" AND legacy_id = "1"))
      }];`,
      { sha },
    );
    expect(counts?.[0]).toEqual({ revisions: 1, mappings: 1 });
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("legacy_missing_raw: поздний repaired backup заполняет NONE при том же SHA", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-repair-integration-"));
  const archiveRoot = path.join(temp, "archive");
  const rawPath = path.join(import.meta.dir, "fixtures", "claude-code", "basic-dialogue.jsonl");
  const hashes = await hashFile(rawPath);
  const makeSnapshot = async (name: string, withRaw: boolean): Promise<ContentAddressedSnapshot> => {
    const dbPath = path.join(temp, name);
    const legacy = new Database(dbPath, { create: true });
    createLegacySchema(legacy);
    legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
    legacy.run(
      `INSERT INTO source_files VALUES (
        1, 1, '/Users/test/.claude/projects/orphan.jsonl', '/Users/test/.claude/projects',
        'orphan.jsonl', 'deleted_in_source', ?, 1, ?, ?, '2026-01-01T00:00:00Z')`,
      [hashes.sizeBytes, hashes.sha256, hashes.headHash],
    );
    if (withRaw) {
      legacy.run(
        `INSERT INTO raw_backups VALUES (1, 1, ?, ?, ?, 'active')`,
        [rawPath, hashes.sha256, hashes.sizeBytes],
      );
    }
    legacy.close();
    return contentAddressSnapshot(dbPath);
  };
  const missingSnapshot = await makeSnapshot("missing.sqlite", false);
  const repairedSnapshot = await makeSnapshot("repaired.sqlite", true);
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "migration-repair-host",
      hostname: "migration-repair",
      platform: "darwin",
      arch: "arm64",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const base = {
      db: t.db,
      archiveRoot,
      identity,
      approvedHostMappings: approvedHost(identity),
      bakaCommit: "test",
      schemaVersion: 5,
    };
    await runLegacyMigrationWithSurreal({
      ...base,
      ...missingSnapshot,
      ...(await authorizedOptions(t.db, missingSnapshot, base.approvedHostMappings, temp)),
    });
    const [missing] = await t.db.query<[
      Array<{ raw_archive_path?: string; snapshot_kind: string }>,
    ]>("SELECT raw_archive_path, snapshot_kind FROM source_revision WHERE sha256 = $sha", {
      sha: hashes.sha256,
    });
    expect(missing?.[0]?.raw_archive_path).toBeUndefined();
    expect(missing?.[0]?.snapshot_kind).toBe("legacy_missing_raw");

    await runLegacyMigrationWithSurreal({
      ...base,
      ...repairedSnapshot,
      ...(await authorizedOptions(t.db, repairedSnapshot, base.approvedHostMappings, temp)),
    });
    const [repaired] = await t.db.query<[
      Array<{ raw_archive_path?: string; snapshot_kind: string; count: number }>,
    ]>(
      `SELECT raw_archive_path, snapshot_kind,
       count((SELECT VALUE id FROM source_revision WHERE sha256 = $sha)) AS count
       FROM source_revision WHERE sha256 = $sha`,
      { sha: hashes.sha256 },
    );
    expect(repaired?.[0]?.raw_archive_path).toMatch(/^raw\/claude-code\//);
    expect(repaired?.[0]?.snapshot_kind).toBe("legacy_raw");
    expect(repaired?.[0]?.count).toBe(1);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("Codex exact live ownership rejects wrong lines and null source provenance", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-codex-line-ownership-"));
  const archiveRoot = path.join(temp, "archive");
  const rawPath = path.join(import.meta.dir, "fixtures", "codex", "basic-dialogue.jsonl");
  const raw = await readFile(rawPath, "utf8");
  const parsed = (await collectDialogues(await codexParser.parse(rawPath)))[0]!;
  if (!parsed.externalId) throw new Error("Codex fixture dialogue has no external id");
  const externalId = parsed.externalId;
  const legacyMessage = parsed.messages.find((message) =>
    message.role === "user" && message.humanAuthored === true &&
    message.chunks.some((chunk) => chunk.kind === "text")
  )!;
  const legacyChunk = legacyMessage.chunks.find((chunk) => chunk.kind === "text")!;
  const sourceLine = Number(legacyChunk.sourceLocator?.match(/#L(\d+)$/u)?.[1]);
  expect(Number.isSafeInteger(sourceLine)).toBe(true);

  const makeSnapshot = async (
    name: string,
    baseId: number,
    withNormalizedOwnership: boolean,
    nullSourceProvenance = false,
  ): Promise<ContentAddressedSnapshot> => {
    const rawHash = await hashFile(rawPath);
    const dbPath = path.join(temp, `${name}.sqlite`);
    const legacy = new Database(dbPath, { create: true });
    createLegacySchema(legacy);
    legacy.run(`INSERT INTO agent_systems VALUES (1, 'codex', 'Codex', 'jsonl')`);
    legacy.run(
      `INSERT INTO source_files VALUES (
        ?, 1, ?, '/Users/test/.codex/sessions', ?, 'deleted_in_source', ?, 1, ?, ?,
        '2026-01-01T00:00:00Z')`,
      [
        baseId,
        `/Users/test/.codex/sessions/${name}.jsonl`,
        `${name}.jsonl`,
        rawHash.sizeBytes,
        rawHash.sha256,
        rawHash.headHash,
      ],
    );
    legacy.run(
      `INSERT INTO raw_backups VALUES (?, ?, ?, ?, ?, 'active')`,
      [baseId, baseId, rawPath, rawHash.sha256, rawHash.sizeBytes],
    );
    legacy.run(
      `INSERT INTO threads VALUES (?, 1, NULL, ?, 'Codex line ownership', NULL, NULL)`,
      [baseId, externalId],
    );
    for (const [index, payload] of raw.trimEnd().split("\n").entries()) {
      legacy.run(
        `INSERT INTO thread_records VALUES (?, ?, ?, ?, 'event', NULL, ?)`,
        [baseId * 100 + index, baseId, baseId, index, payload],
      );
    }
    if (withNormalizedOwnership) {
      const messageId = baseId * 1_000 + 1;
      const chunkId = baseId * 1_000 + 2;
      const sourceRecordId = nullSourceProvenance
        ? null
        : baseId * 100 + sourceLine - 1;
      legacy.run(
        `INSERT INTO messages VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
        [messageId, baseId, sourceRecordId, legacyMessage.sequence, legacyMessage.role],
      );
      legacy.run(
        `INSERT INTO message_chunks VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
          chunkId,
          messageId,
          sourceRecordId,
          legacyChunk.sequence,
          legacyChunk.rawKind ?? legacyChunk.kind,
          sha256hex(legacyChunk.content ?? ""),
          Buffer.byteLength(legacyChunk.content ?? ""),
        ],
      );
    }
    legacy.close();
    return contentAddressSnapshot(dbPath);
  };

  const liveSnapshot = await makeSnapshot("live-codex", 10, false);
  const ownershipSnapshot = await makeSnapshot("legacy-codex", 20, true);
  const nullOwnershipSnapshot = await makeSnapshot("null-codex", 30, true, true);
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "migration-codex-line-host",
      hostname: "migration-codex-line-host",
      platform: "darwin",
      arch: "arm64",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const base = {
      db: t.db,
      archiveRoot,
      identity,
      approvedHostMappings: approvedHost(identity),
      bakaCommit: "test",
      schemaVersion: 5,
    };
    const live = await runLegacyMigrationWithSurreal({
      ...base,
      ...liveSnapshot,
      ...(await authorizedOptions(t.db, liveSnapshot, base.approvedHostMappings, temp)),
    });
    expect(live.status).toBe("completed");
    const [canonicalMessage] = await t.db.query<[Array<{ id: RecordId }>]>(
      "SELECT id FROM message WHERE sequence = $sequence LIMIT 1",
      { sequence: legacyMessage.sequence },
    );
    expect(canonicalMessage).toHaveLength(1);
    await t.db.query(
      "UPDATE chunk SET source_locator = $locator WHERE message = $message",
      {
        locator: (legacyChunk.sourceLocator ?? "/immutable/codex.jsonl#L1")
          .replace(/#L\d+$/u, "#L999"),
        message: canonicalMessage?.[0]?.id,
      },
    );

    const rejected = await runLegacyMigrationWithSurreal({
      ...base,
      ...ownershipSnapshot,
      ...(await authorizedOptions(t.db, ownershipSnapshot, base.approvedHostMappings, temp)),
    });
    expect(rejected.status).toBe("completed_with_errors");
    expect(rejected.reconciliation.tables.threads).toMatchObject({ quarantined: 1, lost: 0 });
    expect(rejected.reconciliation.tables.messages).toMatchObject({ quarantined: 1, lost: 0 });
    expect(rejected.reconciliation.tables.message_chunks).toMatchObject({ quarantined: 1, lost: 0 });
    const [wrongLineMappings] = await t.db.query<[number]>(
      `RETURN count((SELECT VALUE id FROM legacy_identity_map WHERE
        (legacy_table = "threads" AND legacy_id = "20") OR
        (legacy_table = "messages" AND legacy_id = "20001") OR
        (legacy_table = "message_chunks" AND legacy_id = "20002")));`,
    );
    expect(wrongLineMappings).toBe(0);
    const [revisionCount] = await t.db.query<[number]>(
      "RETURN count((SELECT VALUE id FROM dialogue_revision));",
    );
    expect(revisionCount).toBe(1);

    await t.db.query(
      "UPDATE chunk SET source_locator = $locator WHERE message = $message",
      { locator: legacyChunk.sourceLocator, message: canonicalMessage?.[0]?.id },
    );
    const retry = await runLegacyMigrationWithSurreal({
      ...base,
      ...ownershipSnapshot,
      ...(await authorizedOptions(t.db, ownershipSnapshot, base.approvedHostMappings, temp)),
    });
    expect(retry.status).toBe("completed");
    expect(retry.reconciliation.tables.threads).toMatchObject({ matched: 1, quarantined: 0 });
    expect(retry.reconciliation.tables.messages).toMatchObject({ matched: 1, quarantined: 0 });
    expect(retry.reconciliation.tables.message_chunks).toMatchObject({ matched: 1, quarantined: 0 });

    await t.db.query(
      "UPDATE chunk SET source_locator = $locator WHERE message = $message",
      {
        locator: (legacyChunk.sourceLocator ?? "/immutable/codex.jsonl#L1")
          .replace(/#L\d+$/u, "#L999"),
        message: canonicalMessage?.[0]?.id,
      },
    );
    const nullRejected = await runLegacyMigrationWithSurreal({
      ...base,
      ...nullOwnershipSnapshot,
      ...(await authorizedOptions(t.db, nullOwnershipSnapshot, base.approvedHostMappings, temp)),
    });
    expect(nullRejected.status).toBe("completed_with_errors");
    expect(nullRejected.reconciliation.tables.messages).toMatchObject({ quarantined: 1, lost: 0 });
    expect(nullRejected.reconciliation.tables.message_chunks).toMatchObject({ quarantined: 1, lost: 0 });
    const [nullProvenanceMappings] = await t.db.query<[number]>(
      `RETURN count((SELECT VALUE id FROM legacy_identity_map WHERE
        (legacy_table = "threads" AND legacy_id = "30") OR
        (legacy_table = "messages" AND legacy_id = "30001") OR
        (legacy_table = "message_chunks" AND legacy_id = "30002")));`,
    );
    expect(nullProvenanceMappings).toBe(0);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("exact live identity owns historical legacy rows without canonical writes and retries idempotently", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-history-integration-"));
  const archiveRoot = path.join(temp, "archive");
  const rawA = path.join(import.meta.dir, "fixtures", "claude-code", "basic-dialogue.jsonl");
  const rawB = path.join(temp, "historical.jsonl");
  await writeFile(
    rawB,
    (await readFile(rawA, "utf8")).replace(
      "рендерит HTML-отчёт",
      "строит исторический HTML-документ",
    ),
  );

  const makeSnapshot = async (
    name: string,
    baseId: number,
    rawPath: string,
  ): Promise<ContentAddressedSnapshot> => {
    const hashes = await hashFile(rawPath);
    const dbPath = path.join(temp, name);
    const legacy = new Database(dbPath, { create: true });
    createLegacySchema(legacy);
    legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
    legacy.run(
      `INSERT INTO source_files VALUES (
        ?, 1, ?, '/Users/test/.claude/projects', ?, 'deleted_in_source', ?, 1, ?, ?,
        '2026-01-01T00:00:00Z')`,
      [
        baseId,
        `/Users/test/.claude/projects/${name}.jsonl`,
        `${name}.jsonl`,
        hashes.sizeBytes,
        hashes.sha256,
        hashes.headHash,
      ],
    );
    legacy.run(
      `INSERT INTO raw_backups VALUES (?, ?, ?, ?, ?, 'active')`,
      [baseId, baseId, rawPath, hashes.sha256, hashes.sizeBytes],
    );
    legacy.run(
      `INSERT INTO threads VALUES (
        ?, 1, NULL, 'aaaa1111-2222-4333-8444-555555555555',
        'Разбор renderReport', NULL, NULL)`,
      [baseId],
    );
    const lines = (await readFile(rawPath, "utf8")).trimEnd().split("\n");
    for (const [index, payload] of lines.entries()) {
      legacy.run(
        `INSERT INTO thread_records VALUES (?, ?, ?, ?, 'event', NULL, ?)`,
        [baseId * 100 + index, baseId, baseId, index, payload],
      );
    }
    legacy.close();
    return contentAddressSnapshot(dbPath);
  };
  const liveSnapshot = await makeSnapshot("live", 10, rawA);
  const legacySnapshot = await makeSnapshot("legacy", 20, rawB);
  const t = await createTestDb();
  try {
    const identity = {
      hostUuid: "migration-history-host",
      hostname: "migration-history",
      platform: "darwin",
      arch: "arm64",
      osUsername: "test",
      homePath: "/Users/test",
    };
    const base = {
      db: t.db,
      archiveRoot,
      identity,
      approvedHostMappings: approvedHost(identity),
      bakaCommit: "test",
      schemaVersion: 5,
    };
    await runLegacyMigrationWithSurreal({
      ...base,
      ...liveSnapshot,
      ...(await authorizedOptions(t.db, liveSnapshot, base.approvedHostMappings, temp)),
    });
    const [before] = await t.db.query<[
      Array<{ current_revision: RecordId }>,
    ]>("SELECT current_revision FROM dialogue LIMIT 1");
    const current = String(before?.[0]?.current_revision);
    const [priorMigration] = await t.db.query<[Array<{ id: RecordId }>]>(
      "SELECT id, started_at FROM migration_meta ORDER BY started_at DESC LIMIT 1",
    );
    await t.db.query(
      `CREATE ONLY migration_quarantine:historical_thread SET migration = $migration,
         legacy_table = "threads", legacy_id = "20", raw_payload = {},
         reason = "historical ownership retry", parser_name = "legacy", parser_version = "1",
         retryable = true, attempts = 1, lineage_key = "threads:20",
         first_failed_at = time::now(), last_failed_at = time::now();
       CREATE ONLY migration_quarantine:historical_record SET migration = $migration,
         legacy_table = "thread_records", legacy_id = "2000", raw_payload = {},
         reason = "historical ownership retry", parser_name = "legacy", parser_version = "1",
         retryable = true, attempts = 1, lineage_key = "thread_records:2000",
         first_failed_at = time::now(), last_failed_at = time::now();`,
      { migration: priorMigration?.[0]?.id },
    );

    const ownershipAuthorization = await authorizedOptions(
      t.db,
      legacySnapshot,
      base.approvedHostMappings,
      temp,
    );
    const firstOwnership = await runLegacyMigrationWithSurreal({
      ...base,
      ...legacySnapshot,
      ...ownershipAuthorization,
    });
    expect(firstOwnership.status).toBe("completed");
    expect(firstOwnership.assignmentCoverageOk).toBe(true);
    expect(firstOwnership.reconciliation.tables.threads).toMatchObject({
      matched: 1,
      inserted: 0,
      quarantined: 0,
      lost: 0,
    });
    expect(firstOwnership.reconciliation.tables.thread_records).toMatchObject({
      matched: (await readFile(rawB, "utf8")).trimEnd().split("\n").length,
      inserted: 0,
      quarantined: 0,
      lost: 0,
    });
    const [resolvedLineage] = await t.db.query<[
      Array<{ resolved_at?: Date; resolution?: string }>,
    ]>(`SELECT resolved_at, resolution FROM migration_quarantine WHERE id IN [
      migration_quarantine:historical_thread,
      migration_quarantine:historical_record
    ]`);
    expect(resolvedLineage).toHaveLength(2);
    expect(resolvedLineage?.every((row) =>
      row.resolved_at !== undefined && row.resolution?.startsWith("retry_mapped:") === true
    )).toBe(true);
    const [after] = await t.db.query<[
      Array<{ current_revision: RecordId }>,
    ]>("SELECT current_revision FROM dialogue LIMIT 1");
    expect(String(after?.[0]?.current_revision)).toBe(current);
    const [revisionCount] = await t.db.query<[number]>(
      "RETURN count((SELECT VALUE id FROM dialogue_revision));",
    );
    expect(revisionCount).toBe(1);
    const [nonCurrentSearch] = await t.db.query<[number]>(
      `RETURN count((SELECT VALUE id FROM search_document
       WHERE dialogue_revision != $current));`,
      { current: before?.[0]?.current_revision },
    );
    expect(nonCurrentSearch).toBe(0);

    const retryAuthorization = await authorizedOptions(
      t.db,
      legacySnapshot,
      base.approvedHostMappings,
      temp,
      { approval: ownershipAuthorization.authorization.approval },
    );
    const secondOwnership = await runLegacyMigrationWithSurreal({
      ...base,
      ...legacySnapshot,
      ...retryAuthorization,
    });
    expect(secondOwnership.status).toBe("completed");
    expect(secondOwnership.reconciliation).toMatchObject({
      inserted: 0,
      quarantined: 0,
      lost: 0,
      ok: true,
    });
    const [countsAfterRetry] = await t.db.query<[
      Array<{ revisions: number; dialogues: number; mappings: number }>,
    ]>(`RETURN [{
      revisions: count((SELECT VALUE id FROM dialogue_revision)),
      dialogues: count((SELECT VALUE id FROM dialogue)),
      mappings: count((SELECT VALUE id FROM legacy_identity_map
        WHERE legacy_table IN ["threads", "thread_records"]))
    }];`);
    expect(countsAfterRetry?.[0]).toEqual({
      revisions: 1,
      dialogues: 1,
      mappings: 2 * (1 + (await readFile(rawB, "utf8")).trimEnd().split("\n").length),
    });

    const [liveDialogue] = await t.db.query<[
      Array<{ harness_installation: RecordId }>,
    ]>("SELECT harness_installation FROM dialogue LIMIT 1");
    await t.db.query(
      `CREATE ONLY dialogue:external_non_migration_drift SET
       identity_key = "external:drift", harness_installation = $installation,
       external_id = "external-non-migration-drift",
       first_seen_at = time::now(), last_seen_at = time::now()`,
      { installation: liveDialogue?.[0]?.harness_installation },
    );
    await expect(runLegacyMigrationWithSurreal({
      ...base,
      ...legacySnapshot,
      ...retryAuthorization,
      reportPath: path.join(temp, `migration-report-drift-${crypto.randomUUID()}.json`),
    })).rejects.toThrow("live-probe evidence stale");
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("payload replay uses dedicated provenance and cannot repair same-SHA legacy_missing_raw", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-replay-provenance-"));
  const archiveRoot = path.join(temp, "archive");
  const payload = JSON.stringify({ event: "synthetic", value: "same sha" });
  const replayContent = `${payload}\n`;
  const snapshot = await minimalSnapshot(temp, "replay", [{
    id: 1,
    originalPath: "/Users/test/.claude/same.jsonl",
    sha256: sha256hex(replayContent),
    status: "deleted_in_source",
    threadExternalId: "replay-thread",
    payload,
  }]);
  const identity = {
    hostUuid: "replay-host",
    hostname: "replay-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const t = await createTestDb();
  try {
    const report = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, approvedHost(identity), temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: async (input) => input.source === "payload"
        ? {
            externalId: input.threadExternalId,
            messages: [{
              sequence: 0,
              role: "user",
              humanAuthored: true,
              visibleToUser: true,
              chunks: [{ sequence: 0, kind: "text", content: "payload", metadata: {} }],
              usageEvents: [],
              metadata: {},
            }],
            metadata: {},
          }
        : undefined,
    });
    expect(report.recovery).toEqual({ raw: 0, payload: 1, normalized: 0 });
    const [locations] = await t.db.query<[
      Array<{ id: RecordId; original_path: string; current_revision: RecordId; presence_status: string }>,
    ]>("SELECT id, original_path, current_revision, presence_status FROM source_location");
    const original = locations?.find((row) => row.original_path === "/Users/test/.claude/same.jsonl");
    const replay = locations?.find((row) => row.original_path.startsWith("legacy-replay://"));
    expect(original?.presence_status).toBe("deleted_in_source");
    expect(replay).toBeDefined();
    expect(String(original?.id)).not.toBe(String(replay?.id));
    const [revisions] = await t.db.query<[
      Array<{ id: RecordId; source_location: RecordId; raw_archive_path?: string; snapshot_kind: string }>,
    ]>("SELECT id, source_location, raw_archive_path, snapshot_kind FROM source_revision WHERE sha256 = $sha", {
      sha: sha256hex(replayContent),
    });
    expect(revisions).toHaveLength(2);
    const originalRevision = revisions?.find((row) => String(row.source_location) === String(original?.id));
    const replayRevision = revisions?.find((row) => String(row.source_location) === String(replay?.id));
    expect(originalRevision).toMatchObject({ snapshot_kind: "legacy_missing_raw" });
    expect(originalRevision?.raw_archive_path).toBeUndefined();
    expect(String(original?.current_revision)).toBe(String(originalRevision?.id));
    expect(replayRevision?.snapshot_kind).toBe("legacy_migration_replay");
    expect(replayRevision?.raw_archive_path).toMatch(/^raw\/claude-code\//);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("multi-source thread records bind to their own exact source revision", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-multi-source-"));
  const archiveRoot = path.join(temp, "archive");
  const dbPath = path.join(temp, "multi-source.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  for (const id of [1, 2]) {
    legacy.run(
      `INSERT INTO source_files VALUES (
        ?, 1, ?, '/Users/test/.claude', ?, 'deleted_in_source', 10, ?, ?, NULL,
        '2026-01-01T00:00:00Z')`,
      [id, `/Users/test/.claude/multi-${id}.jsonl`, `multi-${id}.jsonl`, id, String(id).repeat(64)],
    );
  }
  legacy.run(`INSERT INTO threads VALUES (1, 1, NULL, 'multi-source-thread', 'Multi', NULL, NULL)`);
  legacy.run(`INSERT INTO thread_records VALUES (10, 1, 1, 0, 'event', NULL, ?)`, [
    JSON.stringify({ source: 1 }),
  ]);
  legacy.run(`INSERT INTO thread_records VALUES (11, 1, 2, 1, 'event', NULL, ?)`, [
    JSON.stringify({ source: 2 }),
  ]);
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const identity = {
    hostUuid: "multi-source-host",
    hostname: "multi-source-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = [{
    mappingId: "multi-source-host",
    host: identity,
    sourceFileIds: [1, 2],
  }];
  const t = await createTestDb();
  try {
    const report = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: async (input) => input.source === "payload"
        ? {
            externalId: input.threadExternalId,
            messages: [{
              sequence: 0,
              role: "user",
              humanAuthored: true,
              visibleToUser: true,
              chunks: [{ sequence: 0, kind: "text", content: "multi", metadata: {} }],
              usageEvents: [],
              metadata: {},
            }],
            metadata: {},
          }
        : undefined,
    });
    expect(report.status).toBe("completed");
    expect(report.assignmentCoverageOk).toBe(true);
    const [rows] = await t.db.query<[Array<{
      legacy_id: string;
      target: RecordId;
      location: RecordId;
    }>]>(`SELECT legacy_id, target, target.source_location AS location
       FROM legacy_identity_map WHERE legacy_table = "thread_records" ORDER BY legacy_id`);
    const [sources] = await t.db.query<[Array<{ legacy_id: string; target: RecordId }>]>(
      `SELECT legacy_id, target FROM legacy_identity_map
       WHERE legacy_table = "source_files" ORDER BY legacy_id`,
    );
    expect(rows).toHaveLength(2);
    expect(sources).toHaveLength(2);
    expect(String(rows?.[0]?.location)).toBe(String(sources?.[0]?.target));
    expect(String(rows?.[1]?.location)).toBe(String(sources?.[1]?.target));
    expect(String(rows?.[0]?.target)).not.toBe(String(rows?.[1]?.target));
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("active denial and deleted no-message failure preserve exact source-owned records", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-source-owned-exclusions-"));
  const archiveRoot = path.join(temp, "archive");
  const dbPath = path.join(temp, "source-owned.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  legacy.run(
    `INSERT INTO source_files VALUES
     (1, 1, '/Users/test/.claude/active.jsonl', '/Users/test/.claude', 'active.jsonl',
      'active', 10, 1, ?, NULL, NULL),
     (2, 1, '/Users/test/.claude/deleted.jsonl', '/Users/test/.claude', 'deleted.jsonl',
      'deleted_in_source', 10, 2, ?, NULL, '2026-01-01T00:00:00Z')`,
    ["a".repeat(64), "b".repeat(64)],
  );
  legacy.run(
    `INSERT INTO threads VALUES
     (1, 1, NULL, 'active-non-dialogue', 'Active artifact', NULL, NULL),
     (2, 1, NULL, 'deleted-no-message', 'Deleted empty', NULL, NULL)`,
  );
  legacy.run(
    `INSERT INTO thread_records VALUES
     (10, 1, 1, 0, 'event', NULL, ?),
     (20, 2, 2, 0, 'event', NULL, ?)`,
    [JSON.stringify({ text: "active artifact" }), "not-json"],
  );
  legacy.run(`INSERT INTO messages VALUES (100, 1, 10, NULL, 0, 'user', NULL)`);
  legacy.run(
    `INSERT INTO message_chunks VALUES (1000, 100, 10, 0, 'input_text', '/text', NULL, ?, ?)`,
    [sha256hex("active artifact"), Buffer.byteLength("active artifact")],
  );
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const identity = {
    hostUuid: "source-owned-host",
    hostname: "source-owned-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = [{ mappingId: "source-owned", host: identity, sourceFileIds: [1, 2] }];
  const t = await createTestDb();
  try {
    const authorized = await authorizedOptions(t.db, snapshot, mappings, temp);
    const common = {
      db: t.db,
      archiveRoot,
      identity,
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: async () => undefined,
    };
    const first = await runLegacyMigrationWithSurreal({ ...common, ...authorized });
    expect(first.status).toBe("completed_with_errors");
    expect(first.assignmentCoverageOk).toBe(true);
    expect(first.reconciliation.tables.threads).toMatchObject({ quarantined: 2, lost: 0 });
    expect(first.reconciliation.tables.thread_records).toMatchObject({
      inserted: 2,
      quarantined: 0,
      lost: 0,
    });
    expect(first.reconciliation.tables.messages).toMatchObject({ quarantined: 1, lost: 0 });
    expect(first.reconciliation.tables.message_chunks).toMatchObject({ quarantined: 1, lost: 0 });
    const [firstCounts] = await t.db.query<[Array<{ dialogues: number; recordMaps: number }>]>(
      `RETURN [{
        dialogues: count((SELECT VALUE id FROM dialogue)),
        recordMaps: count((SELECT VALUE id FROM legacy_identity_map
          WHERE legacy_table = "thread_records"))
      }];`,
    );
    expect(firstCounts?.[0]).toEqual({ dialogues: 0, recordMaps: 2 });

    const retryAuthorization = await authorizedOptions(
      t.db,
      snapshot,
      mappings,
      temp,
      { approval: authorized.authorization.approval },
    );
    const retry = await runLegacyMigrationWithSurreal({ ...common, ...retryAuthorization });
    expect(retry.status).toBe("completed_with_errors");
    expect(retry.assignmentCoverageOk).toBe(true);
    expect(retry.reconciliation.tables.thread_records).toMatchObject({
      matched: 2,
      inserted: 0,
      quarantined: 0,
      lost: 0,
    });
    const [retryCounts] = await t.db.query<[Array<{ dialogues: number; recordMaps: number }>]>(
      `RETURN [{
        dialogues: count((SELECT VALUE id FROM dialogue)),
        recordMaps: count((SELECT VALUE id FROM legacy_identity_map
          WHERE legacy_table = "thread_records"))
      }];`,
    );
    expect(retryCounts?.[0]).toEqual(firstCounts?.[0]);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("source provenance pointer, presence, mapping and classification have no split query boundary", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-source-fault-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "fault", [{
    id: 1,
    originalPath: "/Users/test/.claude/fault.jsonl",
    sha256: "a".repeat(64),
    status: "deleted_in_source",
  }]);
  const identity = {
    hostUuid: "fault-host",
    hostname: "fault-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const t = await createTestDb();
  try {
    const firstBackend = new SurrealLegacyMigrationBackend(
      t.db,
      archiveRoot,
      identity,
      mappings,
    );
    const first = await runLegacyMigration({
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      backend: firstBackend,
    });
    expect(first.reconciliation).toMatchObject({ quarantined: 0, lost: 0, ok: true });
    const [afterCreateRetry] = await t.db.query<[
      Array<{ current_revision?: RecordId; presence_status: string }>,
    ]>("SELECT current_revision, presence_status FROM source_location WHERE original_path = $path", {
      path: "/Users/test/.claude/fault.jsonl",
    });
    expect(afterCreateRetry?.[0]?.current_revision).toBeDefined();
    expect(afterCreateRetry?.[0]?.presence_status).toBe("deleted_in_source");

    await t.db.query(
      `UPDATE source_location SET presence_status = "active", missing_complete_scans = 0,
       missing_since_at = NONE, deleted_at = NONE WHERE original_path = $path`,
      { path: "/Users/test/.claude/fault.jsonl" },
    );
    const repaired = await runLegacyMigration({
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings),
    });
    expect(repaired.reconciliation).toMatchObject({ quarantined: 0, lost: 0, ok: true });
    const [afterFinalizeRetry] = await t.db.query<[
      Array<{ current_revision?: RecordId; presence_status: string }>,
    ]>("SELECT current_revision, presence_status FROM source_location WHERE original_path = $path", {
      path: "/Users/test/.claude/fault.jsonl",
    });
    expect(afterFinalizeRetry?.[0]?.current_revision).toBeDefined();
    expect(afterFinalizeRetry?.[0]?.presence_status).toBe("deleted_in_source");
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("source plus raw_backups identity race rolls back the whole atomic bundle", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-source-bundle-race-"));
  const archiveRoot = path.join(temp, "archive");
  const rawPath = path.join(import.meta.dir, "fixtures", "claude-code", "basic-dialogue.jsonl");
  const hashes = await hashFile(rawPath);
  const dbPath = path.join(temp, "source-bundle.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  legacy.run(
    `INSERT INTO source_files VALUES (
      1, 1, '/Users/test/.claude/race.jsonl', '/Users/test/.claude', 'race.jsonl',
      'deleted_in_source', ?, 1, ?, ?, '2026-01-01T00:00:00Z')`,
    [hashes.sizeBytes, hashes.sha256, hashes.headHash],
  );
  legacy.run(
    `INSERT INTO raw_backups VALUES (1, 1, ?, ?, ?, 'active')`,
    [rawPath, hashes.sha256, hashes.sizeBytes],
  );
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const identity = {
    hostUuid: "source-bundle-race-host",
    hostname: "source-bundle-race-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const t = await createTestDb();
  try {
    let injected = false;
    const report = await runLegacyMigration({
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings, {
        beforeAtomicRowQuery: async (kind) => {
          if (kind !== "source" || injected) return;
          injected = true;
          await t.db.query(
            `CREATE ONLY $mapping SET legacy_table = "raw_backups", legacy_id = "1",
             target = source_revision:attacker, created_at = time::now()`,
            { mapping: legacyMappingId("raw_backups", "1") },
          );
        },
      }),
    });
    expect(injected).toBe(true);
    expect(report.status).toBe("completed_with_errors");
    expect(report.reconciliation).toMatchObject({ lost: 0, ok: true });
    expect(report.reconciliation.tables.source_files).toMatchObject({
      quarantined: 1,
      accounted: 1,
      lost: 0,
    });
    expect(report.reconciliation.tables.raw_backups).toMatchObject({
      quarantined: 1,
      accounted: 1,
      lost: 0,
    });
    const [counts] = await t.db.query<[Array<{ roots: number; locations: number; revisions: number; ledgers: number }>]>(
      `RETURN [{
        roots: count((SELECT VALUE id FROM source_root WHERE created_by_run IS NOT NONE)),
        locations: count((SELECT VALUE id FROM source_location WHERE created_by_run IS NOT NONE)),
        revisions: count((SELECT VALUE id FROM source_revision WHERE created_by_run IS NOT NONE)),
        ledgers: count((SELECT VALUE id FROM migration_row_commit
          WHERE legacy_table IN ["source_files", "raw_backups"]
            AND category IN ["matched", "inserted"]))
      }];`,
    );
    expect(counts?.[0]).toEqual({ roots: 0, locations: 0, revisions: 0, ledgers: 0 });
    const [attackerMapping] = await t.db.query<[{ target: RecordId } | undefined]>(
      "SELECT target FROM ONLY $mapping",
      { mapping: legacyMappingId("raw_backups", "1") },
    );
    expect(String(attackerMapping?.target)).toBe("source_revision:attacker");
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("preexisting raw_backups identity conflict rejects the whole source bundle", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-source-bundle-prefetch-conflict-"));
  const archiveRoot = path.join(temp, "archive");
  const rawPath = path.join(import.meta.dir, "fixtures", "claude-code", "basic-dialogue.jsonl");
  const hashes = await hashFile(rawPath);
  const dbPath = path.join(temp, "source-bundle.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  legacy.run(
    `INSERT INTO source_files VALUES (
      1, 1, '/Users/test/.claude/conflict.jsonl', '/Users/test/.claude', 'conflict.jsonl',
      'deleted_in_source', ?, 1, ?, ?, '2026-01-01T00:00:00Z')`,
    [hashes.sizeBytes, hashes.sha256, hashes.headHash],
  );
  legacy.run(
    `INSERT INTO raw_backups VALUES (1, 1, ?, ?, ?, 'active')`,
    [rawPath, hashes.sha256, hashes.sizeBytes],
  );
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const identity = {
    hostUuid: "source-bundle-prefetch-conflict-host",
    hostname: "source-bundle-prefetch-conflict-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const t = await createTestDb();
  try {
    await t.db.query(
      `CREATE ONLY $mapping SET legacy_table = "raw_backups", legacy_id = "1",
       target = source_revision:attacker, created_at = time::now()`,
      { mapping: legacyMappingId("raw_backups", "1") },
    );
    const report = await runLegacyMigration({
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings),
    });

    expect(report.status).toBe("completed_with_errors");
    expect(report.reconciliation.tables.source_files).toMatchObject({
      quarantined: 1,
      accounted: 1,
      lost: 0,
    });
    expect(report.reconciliation.tables.raw_backups).toMatchObject({
      quarantined: 1,
      accounted: 1,
      lost: 0,
    });
    const [counts] = await t.db.query<[Array<{
      roots: number;
      locations: number;
      revisions: number;
      ledgers: number;
    }>]>(`RETURN [{
      roots: count((SELECT VALUE id FROM source_root WHERE created_by_run IS NOT NONE)),
      locations: count((SELECT VALUE id FROM source_location WHERE created_by_run IS NOT NONE)),
      revisions: count((SELECT VALUE id FROM source_revision WHERE created_by_run IS NOT NONE)),
      ledgers: count((SELECT VALUE id FROM migration_row_commit
        WHERE legacy_table IN ["source_files", "raw_backups"]
          AND category IN ["matched", "inserted"]))
    }];`);
    expect(counts?.[0]).toEqual({ roots: 0, locations: 0, revisions: 0, ledgers: 0 });
    const [attackerMapping] = await t.db.query<[{ target: RecordId } | undefined]>(
      "SELECT target FROM ONLY $mapping",
      { mapping: legacyMappingId("raw_backups", "1") },
    );
    expect(String(attackerMapping?.target)).toBe("source_revision:attacker");
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("hard crash after each atomic project/source/dialogue COMMIT leaves only durably attributed effects", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-atomic-kill-"));
  const archiveRoot = path.join(temp, "archive");
  const dbPath = path.join(temp, "kill.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  legacy.run(`INSERT INTO projects VALUES (1, 1, 'kill-project', 'Kill', '/Users/test/kill-project')`);
  legacy.run(`INSERT INTO source_files VALUES (
    1, 1, '/Users/test/.claude/kill.jsonl', '/Users/test/.claude', 'kill.jsonl',
    'deleted_in_source', 0, 1, ?, NULL, '2026-01-01T00:00:00Z')`, ["a".repeat(64)]);
  legacy.run(`INSERT INTO threads VALUES (1, 1, 1, 'kill-thread', 'Kill', NULL, NULL)`);
  legacy.run(`INSERT INTO thread_records VALUES (1, 1, 1, 0, 'event', NULL, ?)` , [
    JSON.stringify({ kill: true }),
  ]);
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const identity = {
    hostUuid: "atomic-kill-host",
    hostname: "atomic-kill-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const recoverSnapshot = async (input: { threadExternalId: string; source: "raw" | "payload" }) =>
    input.source === "payload" ? {
      externalId: input.threadExternalId,
      workspace: { path: "/Users/test/kill-project", name: "Kill" },
      messages: [{
        sequence: 0,
        role: "user" as const,
        humanAuthored: true,
        visibleToUser: true,
        chunks: [{ sequence: 0, kind: "text" as const, content: "atomic", metadata: {} }],
        usageEvents: [],
        metadata: {},
      }],
      metadata: {},
    } : undefined;
  const t = await createTestDb();
  try {
    for (const boundary of ["project", "source", "dialogue"] as const) {
      let fired = false;
      await expect(runLegacyMigration({
        ...snapshot,
        ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
        bakaCommit: "test",
        schemaVersion: 5,
        recoverSnapshot,
        backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings, {
          afterAtomicRowQuery: (kind) => {
            if (!fired && kind === boundary) {
              fired = true;
              throw new Error(`simulated hard crash after ${boundary}`);
            }
          },
        }),
      })).rejects.toThrow();
      expect(fired).toBe(true);
      const [latest] = await t.db.query<[Array<{ id: RecordId }>]>(
        "SELECT id, started_at FROM migration_meta ORDER BY started_at DESC LIMIT 1",
      );
      const [ownership] = await t.db.query<[Array<{ committed: number; created: number }>]>(
        `RETURN [{
          committed: count((SELECT VALUE id FROM migration_row_commit
            WHERE migration = $migration AND category IN ["matched", "inserted"])),
          created: count((SELECT VALUE id FROM source_root WHERE created_by_run = $migration)) +
            count((SELECT VALUE id FROM source_location WHERE created_by_run = $migration)) +
            count((SELECT VALUE id FROM source_revision WHERE created_by_run = $migration)) +
            count((SELECT VALUE id FROM workspace WHERE created_by_run = $migration)) +
            count((SELECT VALUE id FROM dialogue WHERE created_by_run = $migration)) +
            count((SELECT VALUE id FROM dialogue_revision WHERE created_by_run = $migration)) +
            count((SELECT VALUE id FROM search_document WHERE created_by_run = $migration)
          )
        }];`,
        { migration: latest?.[0]?.id },
      );
      expect(ownership?.[0]?.committed).toBeGreaterThan(0);
      expect(ownership?.[0]?.created).toBeGreaterThan(0);
    }
    const completed = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot,
    });
    expect(completed.status).toBe("completed");
    const [counts] = await t.db.query<[Array<{ dialogues: number; revisions: number; docs: number }>]>(
      `RETURN [{
        dialogues: count((SELECT VALUE id FROM dialogue)),
        revisions: count((SELECT VALUE id FROM dialogue_revision)),
        docs: count((SELECT VALUE id FROM search_document))
      }];`,
    );
    expect(counts?.[0]).toEqual({ dialogues: 1, revisions: 1, docs: 1 });
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("explicit host mapping keeps same user/path/external id distinct and reports attribution", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-host-map-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "hosts", [
    {
      id: 1,
      originalPath: "/Users/other-example/.claude/same.jsonl",
      sha256: "1".repeat(64),
      threadExternalId: "same-external-id",
      payload: JSON.stringify({ host: "a" }),
    },
    {
      id: 2,
      originalPath: "/Users/other-example/.claude/same.jsonl",
      sha256: "2".repeat(64),
      threadExternalId: "same-external-id",
      payload: JSON.stringify({ host: "b" }),
    },
  ]);
  const runnerIdentity = {
    hostUuid: "runner",
    hostname: "runner",
    platform: "darwin",
    arch: "arm64",
    osUsername: "other-example",
    homePath: "/Users/other-example",
  };
  const hostCommon = { ...runnerIdentity, hostname: "same-name" };
  const mappings = [
    { mappingId: "machine-a", host: { ...hostCommon, hostUuid: "machine-a" }, sourceFileIds: [1] },
    { mappingId: "machine-b", host: { ...hostCommon, hostUuid: "machine-b" }, sourceFileIds: [2] },
  ];
  const t = await createTestDb();
  try {
    const report = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity: runnerIdentity,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: async (input) => input.source === "payload"
        ? {
            externalId: input.threadExternalId,
            messages: [{
              sequence: 0,
              role: "user",
              humanAuthored: true,
              visibleToUser: true,
              chunks: [{ sequence: 0, kind: "text", content: input.path, metadata: {} }],
              usageEvents: [],
              metadata: {},
            }],
            metadata: {},
          }
        : undefined,
    });
    expect(report.hostAttribution.uncertainty).toEqual([]);
    expect(report.hostAttribution.approvedMappings).toEqual([
      { mappingId: "machine-a", hostUuid: "machine-a", attributedRows: 2 },
      { mappingId: "machine-b", hostUuid: "machine-b", attributedRows: 2 },
    ]);
    const [dialogueCount] = await t.db.query<[number]>("RETURN count((SELECT VALUE id FROM dialogue));");
    expect(dialogueCount).toBe(2);
    const [legacyRoots] = await t.db.query<[
      Array<{ path: string }>,
    ]>("SELECT path FROM source_root WHERE source_kind = 'legacy'");
    expect(legacyRoots?.some((row) => row.path.includes("machine-a"))).toBe(true);
    expect(legacyRoots?.some((row) => row.path.includes("machine-b"))).toBe(true);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("runtime consumes exact source_relation/project_relation assignments", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-relational-map-"));
  const dbPath = path.join(temp, "relational.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  legacy.run(`INSERT INTO projects VALUES (1, 1, 'project', 'Project', NULL)`);
  legacy.run(
    `INSERT INTO source_files VALUES
     (1, 1, '/legacy/host-a/thread.jsonl', '/legacy/host-a', 'thread.jsonl',
      'deleted_in_source', 10, 1, ?, NULL, '2026-01-01T00:00:00Z')`,
    ["7".repeat(64)],
  );
  legacy.run(`INSERT INTO threads VALUES (1, 1, 1, 'source-thread', NULL, NULL, NULL)`);
  legacy.run(`INSERT INTO threads VALUES (2, 1, 1, 'project-thread', NULL, NULL, NULL)`);
  legacy.run(
    `INSERT INTO thread_records VALUES (1, 1, 1, 0, 'event', NULL, ?),
     (2, 2, NULL, 0, 'event', NULL, ?)`,
    [JSON.stringify({ id: 1 }), JSON.stringify({ id: 2 })],
  );
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const identity = {
    hostUuid: "relational-host",
    hostname: "relational-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "legacy",
    homePath: "/legacy/host-a",
  };
  const mappings: ApprovedLegacyHostMapping[] = [{
    mappingId: "host-a",
    host: identity,
    sourceFileIds: [1],
  }];
  const t = await createTestDb();
  try {
    const authorized = await authorizedOptions(t.db, snapshot, mappings, temp);
    expect(authorized.authorization.hostMapping.assignments).toEqual([
      { table: "projects", legacyId: "1", mappingId: "host-a", basis: "source_relation" },
      { table: "source_files", legacyId: "1", mappingId: "host-a", basis: "explicit" },
      { table: "threads", legacyId: "1", mappingId: "host-a", basis: "source_relation" },
      { table: "threads", legacyId: "2", mappingId: "host-a", basis: "project_relation" },
    ]);
    const report = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot: path.join(temp, "archive"),
      identity,
      ...snapshot,
      ...authorized,
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: async (input) => input.source === "payload"
        ? {
            externalId: input.threadExternalId,
            messages: [{
              sequence: 0,
              role: "user",
              humanAuthored: true,
              visibleToUser: true,
              chunks: [{ sequence: 0, kind: "text", content: input.threadExternalId, metadata: {} }],
              usageEvents: [],
              metadata: {},
            }],
            metadata: {},
          }
        : undefined,
    });
    expect(report.hostAttribution.uncertainty).toEqual([]);
    expect(report.status).toBe("completed_with_errors");
    expect(report.reconciliation).toMatchObject({ lost: 0, ok: true });
    expect(report.reconciliation.tables.threads).toMatchObject({
      inserted: 1,
      quarantined: 1,
      accounted: 2,
      lost: 0,
    });
    expect(report.reconciliation.tables.thread_records).toMatchObject({
      inserted: 1,
      quarantined: 1,
      accounted: 2,
      lost: 0,
    });
    expect(report.hostAttribution.actualAssignments).toEqual(
      authorized.authorization.hostMapping.assignments,
    );
    expect(report.assignmentCoverageOk).toBe(true);
    expect(report.hostAttribution.approvedMappings).toEqual([
      { mappingId: "host-a", hostUuid: "relational-host", attributedRows: 4 },
    ]);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("host attribution reports committed actual rows, never planned assignment counts", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-actual-attribution-"));
  const dbPath = path.join(temp, "actual-attribution.sqlite");
  const legacy = new Database(dbPath, { create: true });
  createLegacySchema(legacy);
  legacy.run(`INSERT INTO agent_systems VALUES (1, 'unknown-harness', 'Unknown', 'file_tree')`);
  legacy.run(`INSERT INTO projects VALUES (1, 1, 'planned-project', 'Planned', '/Users/test/planned')`);
  legacy.close();
  const snapshot = await contentAddressSnapshot(dbPath);
  const identity = {
    hostUuid: "actual-host",
    hostname: "actual-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings: ApprovedLegacyHostMapping[] = [{
    mappingId: "actual-host",
    host: identity,
    pathPrefixes: ["/Users/test"],
  }];
  const t = await createTestDb();
  try {
    const authorized = await authorizedOptions(t.db, snapshot, mappings, temp);
    expect(authorized.authorization.hostMapping.assignments).toEqual([{
      table: "projects",
      legacyId: "1",
      mappingId: "actual-host",
      basis: "path",
    }]);
    const report = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot: path.join(temp, "archive"),
      identity,
      ...snapshot,
      ...authorized,
      bakaCommit: "test",
      schemaVersion: 5,
    });
    expect(report.status).toBe("completed_with_errors");
    expect(report.hostAttribution.actualAssignments).toEqual([]);
    expect(report.hostAttribution.approvedMappings).toEqual([{
      mappingId: "actual-host",
      hostUuid: "actual-host",
      attributedRows: 0,
    }]);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("missing approved host mapping fails closed during relational prevalidation", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-host-uncertain-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "uncertain", [{
    id: 1,
    originalPath: "/Users/test/.claude/unknown.jsonl",
    sha256: "9".repeat(64),
  }]);
  const identity = {
    hostUuid: "uncertain-runner",
    hostname: "runner",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const t = await createTestDb();
  try {
    await expect(authorizedOptions(t.db, snapshot, [], temp)).rejects.toThrow(
      "host mapping missing: source_files:1",
    );
    const [locations] = await t.db.query<[number]>(
      "RETURN count((SELECT VALUE id FROM source_location));",
    );
    expect(locations).toBe(0);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("legacy root cannot collide with or disable an existing live source_root", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-live-root-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "root", [{
    id: 1,
    originalPath: "/Users/test/.claude/root.jsonl",
    sha256: "b".repeat(64),
    status: "deleted_in_source",
  }]);
  const identity = {
    hostUuid: "root-host",
    hostname: "root-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const t = await createTestDb();
  try {
    const host = await ensureHost(t.db, identity);
    const harness = await ensureHarness(t.db, {
      slug: "claude-code",
      displayName: "Claude Code",
      kind: "file_tree",
    });
    const installation = await ensureHarnessInstallation(t.db, {
      host,
      harness,
      installed: true,
      detectedVersion: "live",
    });
    const liveRoot = await ensureSourceRoot(t.db, {
      harnessInstallation: installation,
      path: "/Users/test/.claude",
      sourceKind: "live-tree",
      parserName: "live-parser",
      snapshotStrategy: "copy",
      enabled: true,
    });
    const liveLocation = await ensureSourceLocation(t.db, {
      sourceRoot: liveRoot,
      relativePath: "root.jsonl",
      originalPath: "/Users/test/.claude/root.jsonl",
      basename: "root.jsonl",
    });
    await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, approvedHost(identity), temp)),
      bakaCommit: "test",
      schemaVersion: 5,
    });
    const [live] = await t.db.query<[
      Array<{ path: string; source_kind: string; parser_name: string; snapshot_strategy: string; enabled: boolean }>,
    ]>("SELECT path, source_kind, parser_name, snapshot_strategy, enabled FROM source_root WHERE id = $id", { id: liveRoot });
    expect(live?.[0]).toEqual({
      path: "/Users/test/.claude",
      source_kind: "live-tree",
      parser_name: "live-parser",
      snapshot_strategy: "copy",
      enabled: true,
    });
    const [liveLocationAfter] = await t.db.query<[
      Array<{ presence_status: string; current_revision?: RecordId }>,
    ]>(
      "SELECT presence_status, current_revision FROM source_location WHERE id = $id",
      { id: liveLocation.id },
    );
    expect(liveLocationAfter?.[0]).toEqual({ presence_status: "active" });
    const [legacyLocation] = await t.db.query<[
      Array<{ presence_status: string }>,
    ]>(
      `SELECT presence_status FROM source_location
       WHERE original_path = "/Users/test/.claude/root.jsonl" AND source_root != $liveRoot`,
      { liveRoot },
    );
    expect(legacyLocation?.[0]?.presence_status).toBe("deleted_in_source");
    const [legacyCount] = await t.db.query<[number]>(
      "RETURN count((SELECT VALUE id FROM source_root WHERE source_kind = 'legacy'));",
    );
    expect(legacyCount).toBe(1);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("source SHA + source dialogue id dedups before derived installation identity", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-sha-dedup-"));
  const archiveRoot = path.join(temp, "archive");
  const payload = JSON.stringify({ same: "payload" });
  const snapshot = await minimalSnapshot(temp, "sha", [
    {
      id: 1,
      originalPath: "/Users/test/.claude/a.jsonl",
      sha256: "3".repeat(64),
      threadExternalId: "same-dialogue",
      payload,
    },
    {
      id: 2,
      originalPath: "/Users/test/.claude/b.jsonl",
      sha256: "4".repeat(64),
      threadExternalId: "same-dialogue",
      payload,
    },
  ]);
  const runner = {
    hostUuid: "dedup-runner",
    hostname: "runner",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = [
    { mappingId: "dedup-a", host: { ...runner, hostUuid: "dedup-a" }, sourceFileIds: [1] },
    { mappingId: "dedup-b", host: { ...runner, hostUuid: "dedup-b" }, sourceFileIds: [2] },
  ];
  const t = await createTestDb();
  try {
    const report = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity: runner,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: async (input) => input.source === "payload"
        ? {
            externalId: input.threadExternalId,
            messages: [{
              sequence: 0,
              role: "user",
              humanAuthored: true,
              visibleToUser: true,
              chunks: [{ sequence: 0, kind: "text", content: "same", metadata: {} }],
              usageEvents: [],
              metadata: {},
            }],
            metadata: {},
          }
        : undefined,
    });
    expect(report.reconciliation).toMatchObject({ quarantined: 0, lost: 0, ok: true });
    const [dialogues] = await t.db.query<[number]>("RETURN count((SELECT VALUE id FROM dialogue));");
    expect(dialogues).toBe(1);
    const [threadMaps] = await t.db.query<[
      Array<{ legacy_id: string; target: RecordId }>,
    ]>("SELECT legacy_id, target FROM legacy_identity_map WHERE legacy_table = 'threads' ORDER BY legacy_id");
    expect(threadMaps).toHaveLength(2);
    expect(String(threadMaps?.[0]?.target)).toBe(String(threadMaps?.[1]?.target));
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("all reliable dialogue keys must agree before any corpus/model/search write", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-three-key-dedup-"));
  const archiveRoot = path.join(temp, "archive");
  const externalId = "three-key-dialogue";
  const payloadA = JSON.stringify({ source: "a" });
  const seedSnapshot = await minimalSnapshot(temp, "three-key-seed", [
    {
      id: 11,
      originalPath: "/Users/test/.claude/a.jsonl",
      sha256: "a".repeat(64),
      threadExternalId: externalId,
      payload: payloadA,
    },
    {
      id: 22,
      originalPath: "/Users/test/.claude/b.jsonl",
      sha256: "b".repeat(64),
      threadExternalId: externalId,
      payload: JSON.stringify({ source: "b" }),
    },
    {
      id: 33,
      originalPath: "/Users/test/.claude/c.jsonl",
      sha256: "c".repeat(64),
      threadExternalId: externalId,
      payload: JSON.stringify({ source: "c" }),
    },
  ]);
  const runner = {
    hostUuid: "three-key-runner",
    hostname: "runner",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = [
    { mappingId: "key-a", host: { ...runner, hostUuid: "key-a" }, sourceFileIds: [11] },
    { mappingId: "key-b", host: { ...runner, hostUuid: "key-b" }, sourceFileIds: [22] },
    { mappingId: "key-c", host: { ...runner, hostUuid: "key-c" }, sourceFileIds: [33] },
  ];
  const seedRecovery = async (input: { threadExternalId: string; source: "raw" | "payload" }) =>
    input.source === "payload"
      ? {
          externalId: input.threadExternalId,
          messages: [{
            sequence: 0,
            role: "assistant" as const,
            humanAuthored: false,
            visibleToUser: true,
            model: {
              rawModelName: "seed-model",
              vendor: "openai" as const,
              canonicalName: "seed-model",
            },
            chunks: [{ sequence: 0, kind: "text" as const, content: "stable canonical", metadata: {} }],
            usageEvents: [],
            metadata: {},
          }],
          metadata: {},
        }
      : undefined;
  const t = await createTestDb();
  try {
    const seed = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity: runner,
      ...seedSnapshot,
      ...(await authorizedOptions(t.db, seedSnapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: seedRecovery,
    });
    expect(seed.status).toBe("completed");
    const [seedMaps] = await t.db.query<[
      Array<{ legacy_id: string; target: RecordId }>,
    ]>(
      `SELECT legacy_id, target FROM legacy_identity_map
       WHERE legacy_table = "threads" AND legacy_id IN ["11", "22", "33"]`,
    );
    const targets = new Map(seedMaps?.map((row) => [row.legacy_id, row.target]) ?? []);
    const dialogueA = targets.get("11")!;
    const dialogueB = targets.get("22")!;
    const dialogueC = targets.get("33")!;
    expect(new Set([String(dialogueA), String(dialogueB), String(dialogueC)]).size).toBe(3);
    await t.db.query(
      `CREATE ONLY $mapping SET legacy_table = "threads",
       legacy_id = "1", target = $target, created_at = time::now()`,
      { mapping: legacyMappingId("threads", "1"), target: dialogueC },
    );
    await t.db.query(
      `CREATE ONLY $mapping SET legacy_table = "threads",
       legacy_id = "2", target = $target, created_at = time::now()`,
      { mapping: legacyMappingId("threads", "2"), target: dialogueA },
    );

    const corpusState = async () => {
      const [counts] = await t.db.query<[
        Array<{ table: string; count: number }>,
      ]>(`RETURN [
        { table: "dialogue", count: count((SELECT VALUE id FROM dialogue)) },
        { table: "dialogue_revision", count: count((SELECT VALUE id FROM dialogue_revision)) },
        { table: "message", count: count((SELECT VALUE id FROM message)) },
        { table: "chunk", count: count((SELECT VALUE id FROM chunk)) },
        { table: "vendor", count: count((SELECT VALUE id FROM vendor)) },
        { table: "model", count: count((SELECT VALUE id FROM model)) },
        { table: "search_document", count: count((SELECT VALUE id FROM search_document)) },
        { table: "legacy_replay_revision", count: count((SELECT VALUE id FROM source_revision
          WHERE snapshot_kind = "legacy_migration_replay")) }
      ];`);
      const [pointers] = await t.db.query<[
        Array<{ id: RecordId; current_revision: RecordId }>,
      ]>("SELECT id, current_revision FROM dialogue ORDER BY id");
      return {
        counts: Object.fromEntries(counts?.map((row) => [row.table, row.count]) ?? []),
        pointers: pointers?.map((row) => [String(row.id), String(row.current_revision)]) ?? [],
      };
    };
    const beforeConflict = await corpusState();
    const conflictSnapshot = await minimalSnapshot(temp, "three-key-conflict", [{
      id: 1,
      originalPath: "/Users/test/.claude/conflict.jsonl",
      sha256: "d".repeat(64),
      threadExternalId: externalId,
      payload: payloadA,
    }]);
    const conflictRecovery = async (input: { threadExternalId: string; source: "raw" | "payload" }) =>
      input.source === "payload"
        ? {
            externalId: input.threadExternalId,
            messages: [{
              sequence: 0,
              role: "assistant" as const,
              humanAuthored: false,
              visibleToUser: true,
              model: {
                rawModelName: "must-not-be-created",
                vendor: "anthropic" as const,
                canonicalName: "must-not-be-created",
              },
              chunks: [{ sequence: 0, kind: "text" as const, content: "must not write", metadata: {} }],
              usageEvents: [],
              metadata: {},
            }],
            metadata: {},
          }
        : undefined;
    const conflictCommon = {
      db: t.db,
      archiveRoot,
      identity: runner,
      approvedHostMappings: [
        { ...mappings[0]!, sourceFileIds: [] },
        { ...mappings[1]!, sourceFileIds: [1] },
        { ...mappings[2]!, sourceFileIds: [] },
      ],
      ...conflictSnapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: conflictRecovery,
    };
    const firstConflict = await runLegacyMigrationWithSurreal({
      ...conflictCommon,
      ...(await authorizedOptions(t.db, conflictSnapshot, conflictCommon.approvedHostMappings, temp)),
    });
    expect(firstConflict.status).toBe("completed_with_errors");
    expect(firstConflict.reconciliation.tables.threads).toMatchObject({ quarantined: 1, lost: 0 });
    expect(await corpusState()).toEqual(beforeConflict);
    const secondConflict = await runLegacyMigrationWithSurreal({
      ...conflictCommon,
      ...(await authorizedOptions(t.db, conflictSnapshot, conflictCommon.approvedHostMappings, temp)),
    });
    expect(secondConflict.status).toBe("completed_with_errors");
    expect(secondConflict.reconciliation.tables.threads).toMatchObject({ quarantined: 1, lost: 0 });
    expect(await corpusState()).toEqual(beforeConflict);
    const [conflictMap] = await t.db.query<[
      Array<{ target: RecordId }>,
    ]>(`SELECT target FROM legacy_identity_map WHERE legacy_table = "threads" AND legacy_id = "1"`);
    expect(String(conflictMap?.[0]?.target)).toBe(String(dialogueC));
    const [quarantines] = await t.db.query<[
      Array<{
        attempts: number;
        reason: string;
        parser_name: string;
        parser_version: string;
        resolved_at?: Date;
      }>,
    ]>(
      `SELECT attempts, reason, parser_name, parser_version, resolved_at
       FROM migration_quarantine WHERE legacy_table = "threads" AND legacy_id = "1"
       ORDER BY attempts`,
    );
    expect(quarantines?.map((row) => row.attempts)).toEqual([1, 2]);
    expect(quarantines?.every((row) =>
      row.reason.includes("legacy dialogue dedup key conflict") &&
      row.reason.includes(`legacy_identity_map=${String(dialogueC)}`) &&
      row.reason.includes(`source_revision_sha+source_dialogue_id=${String(dialogueA)}`) &&
      row.reason.includes(`harness_installation+external_id=${String(dialogueB)}`) &&
      row.parser_name === "legacy-migration-adapter" &&
      row.parser_version === "1" &&
      row.resolved_at === undefined
    )).toBe(true);

    const agreeSnapshot = await minimalSnapshot(temp, "three-key-agree", [{
      id: 2,
      originalPath: "/Users/test/.claude/agree.jsonl",
      sha256: "e".repeat(64),
      threadExternalId: externalId,
      payload: payloadA,
    }]);
    const agreeCommon = {
      db: t.db,
      archiveRoot,
      identity: runner,
      approvedHostMappings: [
        { ...mappings[0]!, sourceFileIds: [2] },
        { ...mappings[1]!, sourceFileIds: [] },
        { ...mappings[2]!, sourceFileIds: [] },
      ],
      ...agreeSnapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: seedRecovery,
    };
    const agree = await runLegacyMigrationWithSurreal({
      ...agreeCommon,
      ...(await authorizedOptions(t.db, agreeSnapshot, agreeCommon.approvedHostMappings, temp)),
    });
    expect(agree.status).toBe("completed");
    expect(agree.reconciliation.tables.threads).toMatchObject({ matched: 1, quarantined: 0, lost: 0 });
    const afterAgree = await corpusState();
    expect(afterAgree.pointers).toEqual(beforeConflict.pointers);
    expect({ ...afterAgree.counts, legacy_replay_revision: undefined }).toEqual({
      ...beforeConflict.counts,
      legacy_replay_revision: undefined,
    });
    expect(afterAgree.counts.legacy_replay_revision).toBe(
      beforeConflict.counts.legacy_replay_revision,
    );
    const agreeRerun = await runLegacyMigrationWithSurreal({
      ...agreeCommon,
      ...(await authorizedOptions(t.db, agreeSnapshot, agreeCommon.approvedHostMappings, temp)),
    });
    expect(agreeRerun.status).toBe("completed");
    expect(agreeRerun.reconciliation).toMatchObject({ inserted: 0, quarantined: 0, lost: 0, ok: true });
    expect(await corpusState()).toEqual(afterAgree);
    const [agreeMap] = await t.db.query<[
      Array<{ target: RecordId }>,
    ]>(`SELECT target FROM legacy_identity_map WHERE legacy_table = "threads" AND legacy_id = "2"`);
    expect(String(agreeMap?.[0]?.target)).toBe(String(dialogueA));
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("durable thread mapping conflict is quarantined before canonical/model side effects", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-map-conflict-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "conflict", [{
    id: 1,
    originalPath: "/Users/test/.claude/conflict.jsonl",
    sha256: "8".repeat(64),
    threadExternalId: "mapped-dialogue",
    payload: JSON.stringify({ conflict: true }),
  }]);
  const identity = {
    hostUuid: "conflict-host",
    hostname: "conflict-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const t = await createTestDb();
  try {
    await t.db.query(
      `CREATE ONLY $mapping SET legacy_table = "threads",
       legacy_id = "1", target = $target, created_at = time::now()`,
      {
        mapping: legacyMappingId("threads", "1"),
        target: new RecordId("dialogue", "missing-authoritative"),
      },
    );
    const report = await runLegacyMigrationWithSurreal({
      db: t.db,
      archiveRoot,
      identity,
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, approvedHost(identity), temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot: async (input) => input.source === "payload"
        ? {
            externalId: input.threadExternalId,
            messages: [{
              sequence: 0,
              role: "assistant",
              humanAuthored: false,
              visibleToUser: true,
              model: {
                rawModelName: "model-that-must-not-be-created",
                vendor: "openai",
                canonicalName: "test-model",
              },
              chunks: [{ sequence: 0, kind: "text", content: "no side effect", metadata: {} }],
              usageEvents: [],
              metadata: {},
            }],
            metadata: {},
          }
        : undefined,
    });
    expect(report.status).toBe("completed_with_errors");
    const [counts] = await t.db.query<[
      Array<{ table: string; count: number }>,
    ]>(`RETURN [
      { table: "dialogue", count: count((SELECT VALUE id FROM dialogue)) },
      { table: "model", count: count((SELECT VALUE id FROM model)) }
    ];`);
    expect(Object.fromEntries(counts?.map((row) => [row.table, row.count]) ?? [])).toEqual({
      dialogue: 0,
      model: 0,
    });
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

testDb("thread commit has no post-corpus mark boundary and retry preserves ledger/quarantine history", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "baka-migration-quarantine-lineage-"));
  const archiveRoot = path.join(temp, "archive");
  const snapshot = await minimalSnapshot(temp, "lineage", [{
    id: 1,
    originalPath: "/Users/test/.claude/lineage.jsonl",
    sha256: "5".repeat(64),
    threadExternalId: "lineage-dialogue",
    payload: JSON.stringify({ lineage: true }),
  }]);
  const identity = {
    hostUuid: "lineage-host",
    hostname: "lineage-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const mappings = approvedHost(identity);
  const recoverSnapshot = async (input: { threadExternalId: string; source: "raw" | "payload" }) =>
    input.source === "payload"
      ? {
          externalId: input.threadExternalId,
          workspace: { path: "/Users/test/lineage-project", name: "Lineage" },
          messages: [{
            sequence: 0,
            role: "user" as const,
            humanAuthored: true,
            visibleToUser: true,
            model: {
              rawModelName: "lineage-model",
              vendor: "openai" as const,
              canonicalName: "lineage-model",
            },
            chunks: [{ sequence: 0, kind: "text" as const, content: "lineage", metadata: {} }],
            usageEvents: [],
            metadata: {},
          }],
          metadata: {},
        }
      : undefined;
  const t = await createTestDb();
  try {
    let bindFault = true;
    const first = await runLegacyMigration({
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings, {
        beforeIdentityBind: (table) => {
          if (table === "threads" && bindFault) {
            bindFault = false;
            throw new Error("thread bind fault");
          }
        },
      }),
    });
    expect(first.status).toBe("completed_with_errors");
    const replayCount = async () => {
      const [count] = await t.db.query<[number]>(
        `RETURN count((SELECT VALUE id FROM source_revision
          WHERE snapshot_kind = "legacy_migration_replay"));`,
      );
      return count;
    };
    const provisionalCounts = async () => {
      const [counts] = await t.db.query<[
        Array<{ name: string; count: number }>,
      ]>(`RETURN [
        { name: "dialogue", count: count((SELECT VALUE id FROM dialogue)) },
        { name: "dialogue_revision", count: count((SELECT VALUE id FROM dialogue_revision)) },
        { name: "message", count: count((SELECT VALUE id FROM message)) },
        { name: "chunk", count: count((SELECT VALUE id FROM chunk)) },
        { name: "search_document", count: count((SELECT VALUE id FROM search_document)) },
        { name: "model", count: count((SELECT VALUE id FROM model)) },
        { name: "vendor", count: count((SELECT VALUE id FROM vendor)) },
        { name: "workspace", count: count((SELECT VALUE id FROM workspace)) },
        { name: "workspace_location", count: count((SELECT VALUE id FROM workspace_location)) }
      ];`);
      return Object.fromEntries(counts?.map((row) => [row.name, row.count]) ?? []);
    };
    expect(await replayCount()).toBe(0);
    expect(Object.values(await provisionalCounts()).every((count) => count === 0)).toBe(true);

    let markFault = true;
    const second = await runLegacyMigration({
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings, {
        beforeMarkRevisionParsed: () => {
          if (markFault) {
            markFault = false;
            throw new Error("thread mark fault");
          }
        },
      }),
    });
    expect(second.status).toBe("completed");
    expect(markFault).toBe(true);
    expect(await replayCount()).toBe(1);
    expect(Object.values(await provisionalCounts()).every((count) => count === 1)).toBe(true);
    const [beforeSuccess] = await t.db.query<[
      Array<{ attempts: number; parser_name: string; parser_version: string; resolved_at?: Date; previous_attempt?: RecordId }>,
    ]>(
      `SELECT attempts, parser_name, parser_version, resolved_at, previous_attempt
       FROM migration_quarantine WHERE legacy_table = "threads" AND legacy_id = "1"
       ORDER BY attempts`,
    );
    expect(beforeSuccess?.map((row) => row.attempts)).toEqual([1]);
    expect(beforeSuccess?.every((row) => row.parser_name.length > 0 && row.parser_version.length > 0)).toBe(true);
    expect(beforeSuccess?.every((row) => row.resolved_at !== undefined)).toBe(true);

    const third = await runLegacyMigration({
      ...snapshot,
      ...(await authorizedOptions(t.db, snapshot, mappings, temp)),
      bakaCommit: "test",
      schemaVersion: 5,
      recoverSnapshot,
      backend: new SurrealLegacyMigrationBackend(t.db, archiveRoot, identity, mappings),
    });
    expect(third.reconciliation).toMatchObject({ quarantined: 0, lost: 0, ok: true });
    expect(await replayCount()).toBe(1);
    const [afterSuccess] = await t.db.query<[
      Array<{ resolved_at?: Date }>,
    ]>(
      `SELECT resolved_at FROM migration_quarantine
       WHERE legacy_table = "threads" AND legacy_id = "1"`,
    );
    expect(afterSuccess).toHaveLength(1);
    expect(afterSuccess?.every((row) => row.resolved_at !== undefined)).toBe(true);
    const [dialogues] = await t.db.query<[number]>("RETURN count((SELECT VALUE id FROM dialogue));");
    expect(dialogues).toBe(1);
  } finally {
    await dropTestDb(t);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);
