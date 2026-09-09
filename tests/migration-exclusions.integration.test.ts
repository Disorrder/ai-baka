import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RecordId, Surreal } from "surrealdb";
import {
  withIsolatedSurrealTarget,
  type IsolatedTargetResourceProfile,
} from "../src/backup/isolated-target.ts";
import { applyMigrations } from "../src/db/migrations.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import {
  applyOperatorExclusions,
  buildOperatorExclusionArtifact,
  deriveEligibleOperatorExclusions,
  inspectMigrationQuarantineLifecycle,
  writeOperatorExclusionArtifact,
  type OperatorExclusionAttestation,
} from "../src/migration/exclusions.ts";
import {
  canonicalMigrationJson,
  migrationApprovalKeyFingerprint,
} from "../src/migration/authorization.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

const isolatedTest = process.env.BAKA_RUN_ISOLATED_MIGRATION_EXCLUSIONS_INTEGRATION === "1"
  ? test
  : test.skip;

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const TEST_RESOURCES: IsolatedTargetResourceProfile = {
  memoryBytes: 2 * GIB,
  memorySwapBytes: 2 * GIB,
  cpus: 2,
  pidsLimit: 256,
  rocksDbBlockCacheBytes: 128 * MIB,
  rocksDbThreadCount: 2,
  rocksDbJobsCount: 2,
  rocksDbMaxConcurrentSubcompactions: 1,
  hnswCacheBytes: 64 * MIB,
  memoryThresholdBytes: 512 * MIB,
  httpMaxImportBodyBytes: GIB,
};

async function connectIsolated(url: string, username: string, password: string): Promise<Surreal> {
  const sqlUrl = new URL(url);
  sqlUrl.protocol = "http:";
  sqlUrl.pathname = "/sql";
  const response = await fetch(sqlUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      "Content-Type": "text/plain",
    },
    body: "DEFINE NAMESPACE IF NOT EXISTS baka_exclusions_test; USE NS baka_exclusions_test; DEFINE DATABASE IF NOT EXISTS archive;",
  });
  const provisioning = await response.json() as Array<{ status?: unknown; detail?: unknown }>;
  if (!response.ok || provisioning.some((row) => row.status !== "OK")) {
    throw new Error("isolated exclusion database provisioning failed");
  }
  const scoped = new Surreal();
  await scoped.connect(url);
  await scoped.signin({ username, password });
  await scoped.use({ namespace: "baka_exclusions_test", database: "archive" });
  const [scope] = await scoped.query<[Array<string>]>("RETURN [session::ns(), session::db()]");
  if (scope?.[0] !== "baka_exclusions_test" || scope?.[1] !== "archive") {
    throw new Error(`isolated exclusion scope mismatch: ${JSON.stringify(scope)}`);
  }
  return scoped;
}

function createLegacySnapshot(snapshotPath: string): void {
  const sqlite = new Database(snapshotPath, { create: true });
  sqlite.run("CREATE TABLE agent_systems (id INTEGER PRIMARY KEY, slug TEXT NOT NULL, display_name TEXT, kind TEXT)");
  sqlite.run("CREATE TABLE projects (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, external_id TEXT NOT NULL, name TEXT, path TEXT)");
  sqlite.run("CREATE TABLE source_files (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, original_path TEXT NOT NULL, root_path TEXT, relative_path TEXT, status TEXT NOT NULL, size INTEGER, mtime_ms REAL, sha256 TEXT NOT NULL, head_hash TEXT, deleted_at TEXT)");
  sqlite.run("CREATE TABLE raw_backups (id INTEGER PRIMARY KEY, source_file_id INTEGER NOT NULL, archive_path TEXT NOT NULL, sha256 TEXT, size INTEGER, status TEXT)");
  sqlite.run("CREATE TABLE threads (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, project_id INTEGER, external_id TEXT NOT NULL, title TEXT, started_at TEXT, updated_at TEXT)");
  sqlite.run("CREATE TABLE thread_records (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, source_file_id INTEGER, sequence INTEGER NOT NULL, record_type TEXT, timestamp TEXT, payload TEXT NOT NULL)");
  sqlite.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, source_record_id INTEGER, external_id TEXT, sequence INTEGER NOT NULL, role TEXT, timestamp TEXT)");
  sqlite.run("CREATE TABLE message_chunks (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, source_record_id INTEGER, sequence INTEGER NOT NULL, kind TEXT, content_path TEXT, metadata_path TEXT, content_sha256 TEXT, content_bytes INTEGER)");
  sqlite.run("INSERT INTO agent_systems VALUES (1, 'codex', 'Codex', 'jsonl')");
  sqlite.run("INSERT INTO source_files VALUES (1, 1, '/active/thread.jsonl', '/', 'active/thread.jsonl', 'active', 1, 1, ?, NULL, NULL)", ["a".repeat(64)]);
  sqlite.run("INSERT INTO source_files VALUES (2, 1, '/deleted/thread.jsonl', '/', 'deleted/thread.jsonl', 'deleted_in_source', 1, 1, ?, NULL, ?)", ["b".repeat(64), "2026-07-27T00:00:00.000Z"]);
  sqlite.run("INSERT INTO threads VALUES (1, 1, NULL, 'external-one', 'Title', NULL, NULL)");
  sqlite.run("INSERT INTO threads VALUES (2, 1, NULL, 'external-two', 'Deleted', NULL, NULL)");
  sqlite.run("INSERT INTO thread_records VALUES (10, 1, 1, 0, 'event', NULL, '{}')");
  sqlite.run("INSERT INTO thread_records VALUES (11, 1, NULL, 1, 'event', NULL, '{}')");
  sqlite.run("INSERT INTO thread_records VALUES (12, 2, 2, 0, 'event', NULL, '{}')");
  sqlite.run("INSERT INTO messages VALUES (20, 1, 10, NULL, 0, 'user', NULL)");
  sqlite.run("INSERT INTO message_chunks VALUES (30, 20, 10, 0, 'text', NULL, NULL, NULL, NULL)");
  sqlite.close();
}

isolatedTest(
  "signed exclusions apply and resume idempotently on exact pinned SurrealDB 3.2.3",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-exclusions-isolated-"));
    const archive = path.join(root, "archive");
    const externalPrivate = path.join(root, "private-source-report");
    await Promise.all([mkdir(archive), mkdir(externalPrivate)]);
    const credentials = { username: "root", password: "isolated-exclusions-test-password" };
    let callbackFailure: unknown;
    try {
      const result = await withIsolatedSurrealTarget(
        { credentials, resources: TEST_RESOURCES, readinessTimeoutMs: 60_000 },
        async (target) => {
          let db: Surreal | undefined;
          let stage = "connect";
          let lastSql = "";
          try {
            db = await connectIsolated(target.surrealUrl, credentials.username, credentials.password);
            stage = "migrate";
            await applyMigrations(db, {
              bakaCommit: "operator-exclusions-isolated-test",
              surrealdbVersion: "3.2.3",
            });
            stage = "seed";
            const snapshotPath = path.join(archive, "migration-input", "snapshot.sqlite");
            await mkdir(path.dirname(snapshotPath), { recursive: true });
            createLegacySnapshot(snapshotPath);
            const snapshot = await hashFile(snapshotPath);
            const sourceMigration = new RecordId(
              "migration_meta",
              "migration_c8c188d1-547a-49b7-95f9-ff986c3d081a",
            );
            expect(String(sourceMigration)).toBe(
              "migration_meta:⟨migration_c8c188d1-547a-49b7-95f9-ff986c3d081a⟩",
            );
            const { publicKey: sourcePublicKey } = generateKeyPairSync("ed25519");
            const sourcePublicKeyPem = sourcePublicKey.export({ type: "spki", format: "pem" }).toString();
            const sourceKeyFingerprint = migrationApprovalKeyFingerprint(sourcePublicKeyPem);
            const { publicKey, privateKey } = generateKeyPairSync("ed25519");
            const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
            const keyFingerprint = migrationApprovalKeyFingerprint(publicKeyPem);
            expect(keyFingerprint).not.toBe(sourceKeyFingerprint);
            const reportPath = path.join(externalPrivate, "source-report.json");
            const reconciliation = {
              legacyTotal: 10,
              matched: 5,
              inserted: 0,
              quarantined: 5,
              accounted: 10,
              lost: 0,
              ok: true,
              tables: {
                agent_systems: { total: 1, matched: 1, inserted: 0, quarantined: 0, accounted: 1, lost: 0 },
                projects: { total: 0, matched: 0, inserted: 0, quarantined: 0, accounted: 0, lost: 0 },
                source_files: { total: 2, matched: 2, inserted: 0, quarantined: 0, accounted: 2, lost: 0 },
                raw_backups: { total: 0, matched: 0, inserted: 0, quarantined: 0, accounted: 0, lost: 0 },
                threads: { total: 2, matched: 0, inserted: 0, quarantined: 2, accounted: 2, lost: 0 },
                thread_records: { total: 3, matched: 2, inserted: 0, quarantined: 1, accounted: 3, lost: 0 },
                messages: { total: 1, matched: 0, inserted: 0, quarantined: 1, accounted: 1, lost: 0 },
                message_chunks: { total: 1, matched: 0, inserted: 0, quarantined: 1, accounted: 1, lost: 0 },
              },
            };
            const sourceReport = {
              formatVersion: 1,
              createdAt: "2026-07-27T09:00:00.000Z",
              status: "completed_with_errors",
              snapshotPath,
              snapshotSha256: snapshot.sha256,
              migrationId: String(sourceMigration),
              reportPath,
              reconciliation,
              recovery: { raw: 0, payload: 0, normalized: 0 },
              hostAttribution: { approvedMappings: [], uncertainty: [], actualAssignments: [] },
              assignmentCoverageOk: true,
            };
            await writeFile(reportPath, `${JSON.stringify(sourceReport, null, 2)}\n`);
            const sourceReportFile = await hashFile(reportPath);
            await db.query(
              `CREATE ONLY $id SET status = "completed_with_errors", started_at = $started,
               finished_at = $finished, legacy_db_path = $snapshotPath,
               legacy_db_sha256 = $snapshotSha, approval_key_fingerprint = $sourceKeyFingerprint,
               approval_artifact_sha256 = $approvalSha, approval_file_sha256 = $approvalFileSha,
               approval_attestation_sha256 = $approvalAttestationSha,
               host_mapping_artifact_sha256 = $hostMappingSha,
               report_path = $reportPath, report_sha256 = $reportSha,
               report_size_bytes = $reportSize, counters = $counters`,
              {
                id: sourceMigration,
                started: new Date("2026-07-27T09:00:00.000Z"),
                finished: new Date("2026-07-27T09:05:00.000Z"),
                snapshotPath,
                snapshotSha: snapshot.sha256,
                sourceKeyFingerprint,
                approvalSha: "1".repeat(64),
                approvalFileSha: "2".repeat(64),
                approvalAttestationSha: "3".repeat(64),
                hostMappingSha: "4".repeat(64),
                reportPath,
                reportSha: sourceReportFile.sha256,
                reportSize: sourceReportFile.sizeBytes,
                counters: { reconciliation },
              },
            );
            const previousMigration = new RecordId("migration_meta", "migration_previous_attempt");
            const previousReportPath = path.join(externalPrivate, "source-report-previous.json");
            const previousReport = {
              ...sourceReport,
              createdAt: "2026-07-27T08:00:00.000Z",
              migrationId: String(previousMigration),
              reportPath: previousReportPath,
            };
            await writeFile(previousReportPath, `${JSON.stringify(previousReport, null, 2)}\n`);
            const previousReportFile = await hashFile(previousReportPath);
            await db.query(
              `CREATE ONLY $id SET status = "completed_with_errors", started_at = $started,
               finished_at = $finished, legacy_db_path = $snapshotPath,
               legacy_db_sha256 = $snapshotSha, approval_key_fingerprint = $sourceKeyFingerprint,
               approval_artifact_sha256 = $approvalSha, approval_file_sha256 = $approvalFileSha,
               approval_attestation_sha256 = $approvalAttestationSha,
               host_mapping_artifact_sha256 = $hostMappingSha,
               report_path = $reportPath, report_sha256 = $reportSha,
               report_size_bytes = $reportSize, counters = $counters`,
              {
                id: previousMigration,
                started: new Date("2026-07-27T08:00:00.000Z"),
                finished: new Date("2026-07-27T08:05:00.000Z"),
                snapshotPath,
                snapshotSha: snapshot.sha256,
                sourceKeyFingerprint,
                approvalSha: "5".repeat(64),
                approvalFileSha: "6".repeat(64),
                approvalAttestationSha: "7".repeat(64),
                hostMappingSha: "8".repeat(64),
                reportPath: previousReportPath,
                reportSha: previousReportFile.sha256,
                reportSize: previousReportFile.sizeBytes,
                counters: { reconciliation },
              },
            );
            const sourceOne = new RecordId("source_location", "legacy_source_one");
            const sourceTwo = new RecordId("source_location", "legacy_source_two");
            const revisionOne = new RecordId("source_revision", "legacy_revision_one");
            const revisionTwo = new RecordId("source_revision", "legacy_revision_two");
            await db.query(
              `LET $now = time::now();
               CREATE ONLY host:exclusion_fixture SET host_uuid = "exclusion-fixture",
                 hostname = "fixture", platform = "test", arch = "test",
                 first_seen_at = $now, last_seen_at = $now;
               CREATE ONLY harness:exclusion_codex SET slug = "codex", display_name = "Codex",
                 kind = "cli";
               CREATE ONLY harness_installation:exclusion_fixture SET host = host:exclusion_fixture,
                 harness = harness:exclusion_codex, installed = true,
                 first_seen_at = $now, last_detected_at = $now;
               CREATE ONLY source_root:exclusion_fixture SET
                 harness_installation = harness_installation:exclusion_fixture,
                 path = "/fixture", source_kind = "file_tree", parser_name = "codex",
                 snapshot_strategy = "copy", enabled = true,
                 first_seen_at = $now, last_seen_at = $now;
               CREATE ONLY sync_run:exclusion_fixture SET kind = "migration", status = "completed",
                 started_at = $now, host = host:exclusion_fixture, baka_commit = "fixture",
                 schema_version = 1;
               CREATE ONLY $sourceOne SET source_root = source_root:exclusion_fixture,
                 relative_path = "active/thread.jsonl",
                 original_path = "/active/thread.jsonl", basename = "thread.jsonl",
                 presence_status = "active", missing_complete_scans = 0,
                 first_seen_at = $now, last_seen_at = $now;
               CREATE ONLY $sourceTwo SET source_root = source_root:exclusion_fixture,
                 relative_path = "deleted/thread.jsonl",
                 original_path = "/deleted/thread.jsonl", basename = "thread.jsonl",
                 presence_status = "deleted_in_source", missing_complete_scans = 0,
                 first_seen_at = $now, last_seen_at = $now, deleted_at = $now;
               CREATE ONLY $revisionOne SET source_location = $sourceOne, sha256 = $shaOne,
                 size_bytes = 1, mtime_ms = 1, raw_archive_path = NONE,
                 snapshot_kind = "legacy_missing_raw", captured_at = $now,
                 parser_name = "legacy", parser_version = "1", parse_status = "unsupported",
                 sync_run = sync_run:exclusion_fixture;
               CREATE ONLY $revisionTwo SET source_location = $sourceTwo, sha256 = $shaTwo,
                 size_bytes = 1, mtime_ms = 1, raw_archive_path = NONE,
                 snapshot_kind = "legacy_missing_raw", captured_at = $now,
                 parser_name = "legacy", parser_version = "1", parse_status = "unsupported",
                 sync_run = sync_run:exclusion_fixture;
               CREATE ONLY legacy_identity_map:source_one SET legacy_table = "source_files",
                 legacy_id = "1", target = $sourceOne, created_at = time::now();
               CREATE ONLY legacy_identity_map:source_two SET legacy_table = "source_files",
                 legacy_id = "2", target = $sourceTwo, created_at = time::now();
               CREATE ONLY legacy_identity_map:record_ten SET legacy_table = "thread_records",
                 legacy_id = "10", target = $revisionOne, created_at = time::now();`,
              {
                sourceOne,
                sourceTwo,
                revisionOne,
                revisionTwo,
                shaOne: "a".repeat(64),
                shaTwo: "b".repeat(64),
              },
            );
            const missingSourceMapEligibility = await deriveEligibleOperatorExclusions(db, snapshotPath);
            expect(missingSourceMapEligibility.codes.has("threads:2")).toBe(false);
            await db.query(
              `CREATE ONLY legacy_identity_map:record_twelve SET legacy_table = "thread_records",
                 legacy_id = "12", target = $revisionTwo, created_at = time::now()`,
              { revisionTwo },
            );
            const eligible = await deriveEligibleOperatorExclusions(db, snapshotPath);
            expect(eligible.codes.get("threads:2"))
              .toBe("deleted_original_unrecoverable_no_messages");
            const previousQuarantine = new RecordId("migration_quarantine", "q_previous");
            await db.query(
              `CREATE ONLY $id SET migration = $migration, legacy_table = "threads",
               legacy_id = "1", raw_payload = $payload, reason = "previous-fixture",
               parser_name = "legacy-migration-adapter", parser_version = "1",
               retryable = false, attempts = 1, lineage_key = "threads:1",
               first_failed_at = $failedAt, last_failed_at = $failedAt`,
              {
                id: previousQuarantine,
                migration: previousMigration,
                payload: eligible.payloads.get("threads:1"),
                failedAt: new Date("2026-07-27T08:04:00.000Z"),
              },
            );
            const lineages = [
              "threads:1",
              "thread_records:11",
              "messages:20",
              "message_chunks:30",
              "threads:2",
            ];
            for (const [index, lineage] of lineages.entries()) {
              const [legacyTable, legacyId] = lineage.split(":") as [string, string];
              await db.query(
                `CREATE ONLY $id SET migration = $migration, legacy_table = $table,
                 legacy_id = $legacyId, raw_payload = $payload, reason = $reason,
                 parser_name = "legacy-migration-adapter", parser_version = "1",
                 retryable = false, attempts = 1, lineage_key = $lineage,
                 first_failed_at = $failedAt, last_failed_at = $failedAt`,
                {
                  id: new RecordId("migration_quarantine", `q_${index}`),
                  migration: sourceMigration,
                  table: legacyTable,
                  legacyId,
                  payload: eligible.payloads.get(lineage),
                  reason: `fixture-${index}`,
                  lineage,
                  failedAt: new Date("2026-07-27T09:04:00.000Z"),
                },
              );
            }
            await db.query(
              "UPDATE ONLY migration_quarantine:q_0 SET previous_attempt = $previous",
              { previous: previousQuarantine },
            );
            const tracedDb = {
              query: async (sql: string, vars?: Record<string, unknown>) => {
                lastSql = sql.replace(/\s+/gu, " ").trim().slice(0, 240);
                return db!.query(sql, vars);
              },
            } as unknown as Surreal;

            stage = "build";
            const lifecycleNow = Date.now();
            const artifact = await buildOperatorExclusionArtifact({
              db: tracedDb,
              archiveRoot: archive,
              snapshotPath,
              sourceMigrationId: String(sourceMigration),
              createdAt: new Date(lifecycleNow - 4 * 60_000).toISOString(),
            });
            expect(artifact.rows).toHaveLength(6);
            expect(new Set(artifact.rows.map((row) => row.migrationId))).toEqual(
              new Set([String(previousMigration), String(sourceMigration)]),
            );
            expect(artifact.rows.some((row) => row.lineageKey === "thread_records:10")).toBe(false);
            const artifactPath = path.join(archive, "migration-exclusions", "operator-exclusions.json");
            await mkdir(path.dirname(artifactPath), { recursive: true });
            await writeOperatorExclusionArtifact(archive, artifactPath, artifact);
            const artifactFile = await hashFile(artifactPath);
            const payload = {
              artifactFileSha256: artifactFile.sha256,
              artifactSha256: artifact.artifactSha256,
              rowSetSha256: artifact.rowSetSha256,
              sourceMigrationId: artifact.sourceMigrationId,
              snapshotSha256: artifact.snapshotSha256,
              issuedAt: new Date(lifecycleNow - 3 * 60_000).toISOString(),
            };
            const attestation: OperatorExclusionAttestation = {
              kind: "baka-legacy-operator-exclusions-attestation",
              formatVersion: 1,
              keyFingerprint,
              payload,
              signature: sign(null, Buffer.from(canonicalMigrationJson(payload)), privateKey).toString("base64"),
            };
            const attestationPath = path.join(archive, "migration-exclusions", "operator-exclusions.attestation.json");
            await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
            const acceptanceReportPath = path.join(archive, "migration-exclusions", "operator-exclusions.report.json");
            const applyInput = {
              db: tracedDb,
              archiveRoot: archive,
              snapshotPath,
              artifactPath,
              attestationPath,
              reportPath: acceptanceReportPath,
              trustAnchor: { ed25519PublicKeyPem: publicKeyPem, sha256Fingerprint: keyFingerprint },
            };
            stage = "apply-first";
            const first = await applyOperatorExclusions(applyInput);
            stage = "apply-second";
            const second = await applyOperatorExclusions(applyInput);
            expect(second).toEqual(first);
            const exactAcceptanceReportBytes = await readFile(acceptanceReportPath);
            await writeFile(
              acceptanceReportPath,
              Buffer.concat([exactAcceptanceReportBytes, Buffer.from(" ")]),
            );
            await expect(applyOperatorExclusions(applyInput)).rejects.toThrow(/different bytes/);
            await writeFile(acceptanceReportPath, exactAcceptanceReportBytes);
            stage = "inspect";
            const lifecycle = await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive });
            expect(lifecycle).toMatchObject({
              state: "accepted_with_operator_exclusions",
              unresolved: 0,
              documentedOperatorExclusions: 6,
              documentedOperatorExclusionLineages: 5,
              invalidResolutions: 0,
            });
            const signedQuarantineIds = artifact.rows.map((row) =>
              new RecordId("migration_quarantine", row.quarantineId.slice("migration_quarantine:".length)));
            const persistedSignedRows = await selectAll<Record<string, unknown> & { id: RecordId }>(
              db,
              "SELECT * FROM $ids ORDER BY id",
              { ids: signedQuarantineIds },
            );
            expect(persistedSignedRows).toHaveLength(artifact.rows.length);
            await db.query("DELETE $ids", { ids: signedQuarantineIds });
            const missingSignedRows = await inspectMigrationQuarantineLifecycle(tracedDb, {
              archiveRoot: archive,
            });
            expect(missingSignedRows).toMatchObject({
              state: "blocked",
              invalidResolutions: 1,
            });
            expect(missingSignedRows.issues.some((issue) =>
              issue.detail.includes("missing signed quarantine rows"))).toBe(true);
            for (const persisted of persistedSignedRows) {
              const { id, ...content } = persisted;
              await db.query("CREATE ONLY $id CONTENT $content", { id, content });
            }
            expect(await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive }))
              .toMatchObject({
                state: "accepted_with_operator_exclusions",
                documentedOperatorExclusions: 6,
                invalidResolutions: 0,
              });
            const substituted = persistedSignedRows[0]!;
            await db.query("UPDATE ONLY $id SET reason = $reason", {
              id: substituted.id,
              reason: "substituted-after-acceptance",
            });
            const substitutedLifecycle = await inspectMigrationQuarantineLifecycle(tracedDb, {
              archiveRoot: archive,
            });
            expect(substitutedLifecycle).toMatchObject({ state: "blocked", invalidResolutions: 6 });
            expect(substitutedLifecycle.issues.some((issue) =>
              issue.detail.includes("quarantine row changed"))).toBe(true);
            await db.query("UPDATE ONLY $id SET reason = $reason", {
              id: substituted.id,
              reason: substituted.reason,
            });
            expect(first.acceptanceId).toStartWith("migration_meta:⟨operator-exclusions-");
            const acceptanceMeta = await selectOne<{ approval_key_fingerprint: string }>(
              db,
              `SELECT approval_key_fingerprint FROM migration_meta
               WHERE status = "accepted_with_operator_exclusions"`,
            );
            expect(acceptanceMeta?.approval_key_fingerprint).toBe(keyFingerprint);
            expect(acceptanceMeta?.approval_key_fingerprint).not.toBe(sourceKeyFingerprint);
            const exactSourceReportBytes = await readFile(reportPath);
            await writeFile(reportPath, Buffer.concat([exactSourceReportBytes, Buffer.from(" ")]));
            expect(await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive }))
              .toMatchObject({ state: "blocked", invalidResolutions: 6 });
            await writeFile(reportPath, exactSourceReportBytes);
            const exactPreviousReportBytes = await readFile(previousReportPath);
            await writeFile(
              previousReportPath,
              Buffer.concat([exactPreviousReportBytes, Buffer.from(" ")]),
            );
            expect(await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive }))
              .toMatchObject({ state: "blocked", invalidResolutions: 6 });
            await writeFile(previousReportPath, exactPreviousReportBytes);
            const exactArtifactBytes = await readFile(artifactPath);
            await writeFile(
              artifactPath,
              exactArtifactBytes.toString("utf8").replace(
                artifact.sourceReportSha256,
                "0".repeat(64),
              ),
            );
            expect(await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive }))
              .toMatchObject({ state: "blocked", invalidResolutions: 6 });
            await writeFile(artifactPath, exactArtifactBytes);
            const exactSnapshotBytes = await readFile(snapshotPath);
            await writeFile(snapshotPath, Buffer.concat([exactSnapshotBytes, Buffer.from([0])]));
            expect(await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive }))
              .toMatchObject({ state: "blocked", invalidResolutions: 6 });
            await writeFile(snapshotPath, exactSnapshotBytes);
            await rm(snapshotPath);
            expect(await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive }))
              .toMatchObject({
                state: "accepted_with_operator_exclusions",
                documentedOperatorExclusions: 6,
                invalidResolutions: 0,
              });
            expect((await selectOne<{ n: number }>(
              db,
              "SELECT count() AS n FROM dialogue GROUP ALL",
            ))?.n ?? 0).toBe(0);
            expect((await selectOne<{ n: number }>(
              db,
              `SELECT count() AS n FROM legacy_identity_map
               WHERE legacy_table = "threads" GROUP ALL`,
            ))?.n ?? 0).toBe(0);
            expect(await selectAll(db, "SELECT * FROM migration_quarantine WHERE resolved_at IS NONE"))
              .toEqual([]);

            stage = "retry-invalidation";
            await db.query(
              `CREATE ONLY migration_meta:retry SET status = "completed_with_errors",
               started_at = time::now(), legacy_db_sha256 = $snapshotSha;
               CREATE ONLY migration_quarantine:new_attempt SET migration = migration_meta:retry,
               legacy_table = "threads", legacy_id = "1", raw_payload = {}, reason = "retry",
               parser_name = "legacy-migration-adapter", parser_version = "1", retryable = false,
               attempts = 2, lineage_key = "threads:1", first_failed_at = time::now(),
               last_failed_at = time::now()` ,
              { snapshotSha: snapshot.sha256 },
            );
            expect(await inspectMigrationQuarantineLifecycle(tracedDb, { archiveRoot: archive }))
              .toMatchObject({ state: "blocked", unresolved: 1 });
            return { hostPort: target.hostPort };
          } catch (error) {
            callbackFailure = new Error(
              `operator exclusions integration failed at ${stage}; last SQL: ${lastSql}`,
              {
              cause: error,
              },
            );
            throw callbackFailure;
          } finally {
            await db?.close().catch(() => {});
          }
        },
      ).catch((error) => {
        throw callbackFailure ?? error;
      });

      expect(result.value.hostPort).not.toBe(8901);
      expect(result.evidence.version).toBe("3.2.4");
      expect(result.evidence.runtimeVersion).toStartWith("3.2.4");
      expect(result.evidence.cleanup).toEqual(expect.objectContaining({
        containerRemoved: true,
        volumeRemoved: true,
        timedOut: false,
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
