import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import {
  deriveEligibleOperatorExclusions,
  indexOperatorExclusionRows,
  parseOperatorExclusionArtifact,
  requireOperatorExclusionRow,
  verifyOperatorExclusionAttestation,
  type OperatorExclusionArtifact,
  type OperatorExclusionAttestation,
  type OperatorExclusionRow,
} from "../src/migration/exclusions.ts";
import {
  canonicalMigrationJson,
  migrationApprovalKeyFingerprint,
  migrationArtifactSha256,
} from "../src/migration/authorization.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })));
});

function artifactFixture(sourceMigrationId = "migration_meta:migration_one"): OperatorExclusionArtifact {
  const row: OperatorExclusionRow = {
    quarantineId: "migration_quarantine:mq_one",
    migrationId: sourceMigrationId,
    lineageKey: "threads:1",
    legacyTable: "threads",
    legacyId: "1",
    exclusionCode: "active_original_without_exact_dialogue",
    reasonSha256: "a".repeat(64),
    rawPayloadSha256: "b".repeat(64),
    parserName: "legacy-migration-adapter",
    parserVersion: "1",
    attempts: 1,
    lastFailedAt: "2026-07-27T10:00:00.000Z",
  };
  const body = {
    kind: "baka-legacy-operator-exclusions" as const,
    formatVersion: 1 as const,
    createdAt: "2026-07-27T10:05:00.000Z",
    sourceMigrationId,
    sourceReportSha256: "c".repeat(64),
    snapshotSha256: "d".repeat(64),
    rowSetSha256: migrationArtifactSha256([row]),
    counts: {
      active_original_without_exact_dialogue: 1,
      deleted_original_unrecoverable_no_messages: 0,
      canonical_child_of_excluded_active_thread: 0,
      source_less_record_of_excluded_active_thread: 0,
      existing_dialogue_ownership_superseded: 0,
      canonical_child_of_superseded_thread: 0,
    },
    rows: [row],
  };
  return { ...body, artifactSha256: migrationArtifactSha256(body) };
}

describe("signed operator-exclusion artifacts", () => {
  test("accepts canonical bracketed migration_meta ids", () => {
    const id = String(new RecordId(
      "migration_meta",
      "migration_c8c188d1-547a-49b7-95f9-ff986c3d081a",
    ));
    expect(id).toBe("migration_meta:⟨migration_c8c188d1-547a-49b7-95f9-ff986c3d081a⟩");
    expect(parseOperatorExclusionArtifact(artifactFixture(id)).sourceMigrationId).toBe(id);
  });

  test("requires exact reviewed codes, row-set hash, and detached independently pinned Ed25519", () => {
    const artifact = parseOperatorExclusionArtifact(artifactFixture());
    const artifactFileSha256 = "e".repeat(64);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const keyFingerprint = migrationApprovalKeyFingerprint(publicKeyPem);
    const payload = {
      artifactFileSha256,
      artifactSha256: artifact.artifactSha256,
      rowSetSha256: artifact.rowSetSha256,
      sourceMigrationId: artifact.sourceMigrationId,
      snapshotSha256: artifact.snapshotSha256,
      issuedAt: "2026-07-27T10:10:00.000Z",
    };
    const attestation: OperatorExclusionAttestation = {
      kind: "baka-legacy-operator-exclusions-attestation",
      formatVersion: 1,
      keyFingerprint,
      payload,
      signature: sign(null, Buffer.from(canonicalMigrationJson(payload)), privateKey).toString("base64"),
    };

    expect(verifyOperatorExclusionAttestation({
      artifact,
      artifactFileSha256,
      attestation,
      trustAnchor: { ed25519PublicKeyPem: publicKeyPem, sha256Fingerprint: keyFingerprint },
    }).keyFingerprint).toBe(keyFingerprint);
    expect(() => verifyOperatorExclusionAttestation({
      artifact,
      artifactFileSha256: "f".repeat(64),
      attestation,
      trustAnchor: { ed25519PublicKeyPem: publicKeyPem, sha256Fingerprint: keyFingerprint },
    })).toThrow(/exact artifact/);

    const unknown = structuredClone(artifact) as unknown as Record<string, unknown>;
    (unknown.rows as Array<Record<string, unknown>>)[0]!.exclusionCode = "message_prefix_match";
    expect(() => parseOperatorExclusionArtifact(unknown)).toThrow(/reviewed operator exclusion code/);
  });

  test("preindexes large signed row sets once and keeps acceptance membership exact", () => {
    const source = artifactFixture().rows[0]!;
    const rows = Array.from({ length: 92_455 }, (_, index): OperatorExclusionRow => ({
      ...source,
      quarantineId: `migration_quarantine:mq_${index}`,
      legacyId: String(index),
      lineageKey: `threads:${index}`,
    }));
    let findReads = 0;
    const guardedRows = new Proxy(rows, {
      get(target, property, receiver) {
        if (property === "find") {
          findReads += 1;
          throw new Error("linear artifact row lookup is forbidden");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const firstAcceptance = indexOperatorExclusionRows(guardedRows);
    const secondRow: OperatorExclusionRow = {
      ...rows[0]!,
      exclusionCode: "deleted_original_unrecoverable_no_messages",
    };
    const rowsByAcceptance = new Map([
      ["migration_meta:acceptance_one", firstAcceptance],
      ["migration_meta:acceptance_two", indexOperatorExclusionRows([secondRow])],
    ]);

    let exactMatches = 0;
    for (const row of rows) {
      if (requireOperatorExclusionRow(
        rowsByAcceptance.get("migration_meta:acceptance_one"),
        row.quarantineId,
        row.exclusionCode,
      ) === row) exactMatches += 1;
    }
    expect(firstAcceptance).toBeInstanceOf(Map);
    expect(firstAcceptance.size).toBe(rows.length);
    expect(exactMatches).toBe(rows.length);
    expect(findReads).toBe(0);
    expect(requireOperatorExclusionRow(
      rowsByAcceptance.get("migration_meta:acceptance_two"),
      secondRow.quarantineId,
      secondRow.exclusionCode,
    )).toBe(secondRow);
    expect(() => requireOperatorExclusionRow(
      firstAcceptance,
      "migration_quarantine:missing",
      source.exclusionCode,
    )).toThrow(/absent from signed exclusion row set/);
    expect(() => requireOperatorExclusionRow(
      firstAcceptance,
      rows[0]!.quarantineId,
      secondRow.exclusionCode,
    )).toThrow(/absent from signed exclusion row set/);
    expect(() => indexOperatorExclusionRows([rows[0]!, rows[0]!]))
      .toThrow(/duplicate operator exclusion quarantine id/);
  });

  test("fresh eligibility requires exact source ownership and handles active/deleted classes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "baka-exclusions-"));
    temporaryDirectories.push(dir);
    const snapshotPath = path.join(dir, "snapshot.sqlite");
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
    sqlite.run("INSERT INTO source_files VALUES (1, 1, '/active/thread.jsonl', '/', 'active/thread.jsonl', 'active', 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL)");
    sqlite.run("INSERT INTO source_files VALUES (2, 1, '/deleted/thread.jsonl', '/', 'deleted/thread.jsonl', 'deleted_in_source', 1, 1, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', NULL, '2026-07-27T00:00:00.000Z')");
    sqlite.run("INSERT INTO source_files VALUES (3, 1, '/deleted/with-message.jsonl', '/', 'deleted/with-message.jsonl', 'deleted_in_source', 1, 1, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', NULL, '2026-07-27T00:00:00.000Z')");
    sqlite.run("INSERT INTO threads VALUES (1, 1, NULL, 'external-one', 'Title', NULL, NULL)");
    sqlite.run("INSERT INTO threads VALUES (2, 1, NULL, 'external-two', 'Deleted', NULL, NULL)");
    sqlite.run("INSERT INTO threads VALUES (3, 1, NULL, 'external-three', 'Deleted with message', NULL, NULL)");
    sqlite.run("INSERT INTO threads VALUES (4, 1, NULL, 'external-four', 'Multi-source', NULL, NULL)");
    sqlite.run("INSERT INTO thread_records VALUES (10, 1, 1, 0, 'event', NULL, '{}')");
    sqlite.run("INSERT INTO thread_records VALUES (11, 1, NULL, 1, 'event', NULL, '{}')");
    sqlite.run("INSERT INTO thread_records VALUES (12, 2, 2, 0, 'event', NULL, '{}')");
    sqlite.run("INSERT INTO thread_records VALUES (13, 3, 3, 0, 'event', NULL, '{}')");
    sqlite.run("INSERT INTO thread_records VALUES (14, 4, 1, 0, 'event', NULL, '{}')");
    sqlite.run("INSERT INTO thread_records VALUES (15, 4, 2, 1, 'event', NULL, '{}')");
    sqlite.run("INSERT INTO messages VALUES (20, 1, 10, NULL, 0, 'user', NULL)");
    sqlite.run("INSERT INTO message_chunks VALUES (30, 20, 10, 0, 'text', NULL, NULL, NULL, NULL)");
    sqlite.run("INSERT INTO messages VALUES (21, 3, 13, NULL, 0, 'user', NULL)");
    sqlite.run("INSERT INTO message_chunks VALUES (31, 21, 13, 0, 'text', NULL, NULL, NULL, NULL)");
    sqlite.close();

    const sourceOne = new RecordId("source_location", "source_one");
    const sourceTwo = new RecordId("source_location", "source_two");
    const sourceThree = new RecordId("source_location", "source_three");
    const revisionOne = new RecordId("source_revision", "revision_one");
    const revisionTwo = new RecordId("source_revision", "revision_two");
    const revisionThree = new RecordId("source_revision", "revision_three");
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM legacy_identity_map")) return [[
          { legacy_table: "source_files", legacy_id: "1", target: sourceOne },
          { legacy_table: "source_files", legacy_id: "2", target: sourceTwo },
          { legacy_table: "source_files", legacy_id: "3", target: sourceThree },
          { legacy_table: "thread_records", legacy_id: "10", target: revisionOne },
          { legacy_table: "thread_records", legacy_id: "12", target: revisionTwo },
          { legacy_table: "thread_records", legacy_id: "13", target: revisionThree },
          { legacy_table: "thread_records", legacy_id: "14", target: revisionOne },
          { legacy_table: "thread_records", legacy_id: "15", target: revisionTwo },
        ]];
        if (sql.includes("FROM source_revision")) return [[
          { id: revisionOne, source_location: sourceOne, sha256: "a".repeat(64) },
          { id: revisionTwo, source_location: sourceTwo, sha256: "b".repeat(64) },
          { id: revisionThree, source_location: sourceThree, sha256: "c".repeat(64) },
        ]];
        return [[]];
      },
    } as unknown as Surreal;
    const eligible = await deriveEligibleOperatorExclusions(db, snapshotPath);
    expect(eligible.codes.get("threads:1")).toBe("active_original_without_exact_dialogue");
    expect(eligible.codes.get("thread_records:11")).toBe("source_less_record_of_excluded_active_thread");
    expect(eligible.codes.get("messages:20")).toBe("canonical_child_of_excluded_active_thread");
    expect(eligible.codes.get("message_chunks:30")).toBe("canonical_child_of_excluded_active_thread");
    expect(eligible.codes.has("thread_records:10")).toBe(false);
    expect(eligible.codes.get("threads:2")).toBe("deleted_original_unrecoverable_no_messages");
    expect(eligible.codes.has("thread_records:12")).toBe(false);
    expect(eligible.codes.has("threads:3")).toBe(false);
    expect(eligible.codes.get("threads:4")).toBe("active_original_without_exact_dialogue");

    const missingRecordMapDb = {
      query: async (sql: string) => {
        if (sql.includes("FROM legacy_identity_map")) return [[
          { legacy_table: "source_files", legacy_id: "1", target: sourceOne },
          { legacy_table: "source_files", legacy_id: "2", target: sourceTwo },
        ]];
        if (sql.includes("FROM source_revision")) return [[
          { id: revisionOne, source_location: sourceOne, sha256: "a".repeat(64) },
          { id: revisionTwo, source_location: sourceTwo, sha256: "b".repeat(64) },
        ]];
        return [[]];
      },
    } as unknown as Surreal;
    const rejected = await deriveEligibleOperatorExclusions(missingRecordMapDb, snapshotPath);
    expect(rejected.codes.has("threads:1")).toBe(false);
    expect(rejected.codes.has("threads:2")).toBe(false);

    const conflictingRecordMapDb = {
      query: async (sql: string) => {
        if (sql.includes("FROM legacy_identity_map")) return [[
          { legacy_table: "source_files", legacy_id: "1", target: sourceOne },
          { legacy_table: "source_files", legacy_id: "2", target: sourceTwo },
          { legacy_table: "thread_records", legacy_id: "10", target: revisionTwo },
          { legacy_table: "thread_records", legacy_id: "12", target: revisionOne },
        ]];
        if (sql.includes("FROM source_revision")) return [[
          { id: revisionOne, source_location: sourceOne, sha256: "a".repeat(64) },
          { id: revisionTwo, source_location: sourceTwo, sha256: "b".repeat(64) },
        ]];
        return [[]];
      },
    } as unknown as Surreal;
    const conflicting = await deriveEligibleOperatorExclusions(conflictingRecordMapDb, snapshotPath);
    expect(conflicting.codes.has("threads:1")).toBe(false);
    expect(conflicting.codes.has("threads:2")).toBe(false);
  });
});
