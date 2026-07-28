import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import {
  runValidationWithDb,
  validateEmbeddingState,
  validateMigrationQuarantine,
  validateRelationalState,
} from "../src/validate.ts";

type QueryHandler = (sql: string, vars?: Record<string, unknown>) => unknown[];

function fakeDb(handler: QueryHandler): Surreal {
  return {
    query: async (sql: string, vars?: Record<string, unknown>) => [handler(sql, vars)],
  } as unknown as Surreal;
}

function space(id: RecordId, slug: string, table: string, dimensions = 3) {
  return {
    id,
    slug,
    provider: "mock",
    model: "mock",
    dimensions,
    distance: "COSINE",
    vector_type: "F32",
    segmentation_version: "2",
    active: true,
    physical_table: table,
    created_at: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("validate embedding invariants (§17.3, §23.11–13)", () => {
  test("dimension, job/vector boundary, input hash and owning space", async () => {
    const spaceId = new RecordId("embedding_space", "one");
    const otherSpace = new RecordId("embedding_space", "other");
    const docs = {
      a: new RecordId("search_document", "a"),
      b: new RecordId("search_document", "b"),
      c: new RecordId("search_document", "c"),
      d: new RecordId("search_document", "d"),
      x: new RecordId("search_document", "x"),
    };
    const db = fakeDb((sql) => {
      if (sql.includes("FROM embedding_job")) {
        return [
          { id: "job:a", search_document: docs.a, embedding_space: spaceId, input_sha256: "ha", status: "completed" },
          { id: "job:b", search_document: docs.b, embedding_space: spaceId, input_sha256: "hb", status: "completed" },
          { id: "job:c", search_document: docs.c, embedding_space: spaceId, input_sha256: "hc", status: "pending" },
          { id: "job:d", search_document: docs.d, embedding_space: spaceId, input_sha256: "hd", status: "completed" },
          { id: "job:missing", search_document: new RecordId("search_document", "missing"), embedding_space: otherSpace, input_sha256: "missing", status: "pending" },
        ];
      }
      if (sql.includes("content_sha256 FROM search_document")) {
        return Object.entries(docs).map(([key, id]) => ({ id, content_sha256: `h${key}` }));
      }
      if (sql.includes("FROM embedding_space")) {
        return [space(spaceId, "one", "search_embedding_one")];
      }
      if (sql.includes("FROM search_embedding_one")) {
        return [
          {
            id: "vec:a",
            search_document: docs.a,
            embedding_space: spaceId,
            input_sha256: "wrong",
            vector: [1, 2],
          },
          {
            id: "vec:c",
            search_document: docs.c,
            embedding_space: spaceId,
            input_sha256: "hc",
            vector: [1, 2, 3],
          },
          {
            id: "vec:x",
            search_document: docs.x,
            embedding_space: otherSpace,
            input_sha256: "hx",
            vector: [1, 2, 3],
          },
        ];
      }
      return [];
    });

    const issues = await validateEmbeddingState(db, { pageSize: 100 });
    const checks = issues.map((issue) => issue.check);
    expect(checks).toContain("embedding_dimension_mismatch");
    expect(checks.filter((check) => check === "completed_embedding_job_without_vector")).toHaveLength(2);
    expect(checks.filter((check) => check === "embedding_vector_without_completed_job")).toHaveLength(2);
    expect(checks.filter((check) => check === "embedding_vector_input_hash_mismatch")).toHaveLength(2);
    expect(checks).toContain("embedding_vector_space_mismatch");
    expect(checks).toContain("embedding_job_document_missing");
    expect(checks).toContain("embedding_job_space_missing");
  });

  test("одна physical table не может принадлежать двум spaces", async () => {
    const a = new RecordId("embedding_space", "a");
    const b = new RecordId("embedding_space", "b");
    const db = fakeDb((sql) => {
      if (sql.includes("FROM embedding_space")) {
        return [
          space(a, "a", "search_embedding_shared"),
          space(b, "b", "search_embedding_shared"),
        ];
      }
      return [];
    });
    const issues = await validateEmbeddingState(db);
    expect(issues.some((issue) => issue.check === "embedding_physical_table_shared")).toBe(true);
  });
});

describe("validate full ownership graph", () => {
  test("finds dangling pointers and cross-dialogue/source/search ownership", async () => {
    const d1 = new RecordId("dialogue", "d1");
    const d2 = new RecordId("dialogue", "d2");
    const r1 = new RecordId("dialogue_revision", "r1");
    const r2 = new RecordId("dialogue_revision", "r2");
    const missingRevision = new RecordId("dialogue_revision", "missing");
    const loc1 = new RecordId("source_location", "loc1");
    const loc2 = new RecordId("source_location", "loc2");
    const sr2 = new RecordId("source_revision", "sr2");
    const missingSource = new RecordId("source_revision", "missing");
    const message = new RecordId("message", "m1");
    const chunk = new RecordId("chunk", "c1");
    const db = fakeDb((sql) => {
      if (sql === "SELECT id, identity_key, current_revision FROM dialogue") {
        return [
          { id: d1, identity_key: "d1", current_revision: missingRevision },
          { id: d2, identity_key: "d2", current_revision: r1 },
        ];
      }
      if (sql.includes("source_revision, status FROM dialogue_revision")) {
        return [
          { id: r1, dialogue: d1, source_revision: missingSource, status: "ready" },
          { id: r2, dialogue: d2, status: "ready" },
        ];
      }
      if (sql.includes("last_successful_revision FROM source_location")) {
        return [
          { id: loc1, relative_path: "one", current_revision: sr2, last_successful_revision: missingSource },
          { id: loc2, relative_path: "two", last_successful_revision: sr2 },
        ];
      }
      if (sql === "SELECT id, source_location, parse_status FROM source_revision") {
        return [
          { id: sr2, source_location: loc2, parse_status: "partial" },
          { id: new RecordId("source_revision", "orphan"), source_location: new RecordId("source_location", "missing"), parse_status: "parsed" },
        ];
      }
      if (sql === "SELECT id, dialogue, dialogue_revision FROM message") {
        return [{ id: message, dialogue: d1, dialogue_revision: r2 }];
      }
      if (sql.includes("dialogue_revision, message FROM chunk")) {
        return [{ id: chunk, dialogue: d1, dialogue_revision: r1, message: new RecordId("message", "missing") }];
      }
      if (sql.includes("source_chunks FROM search_document")) {
        return [{
          id: new RecordId("search_document", "s1"),
          dialogue: d1,
          dialogue_revision: r1,
          message,
          source_chunks: [chunk],
        }];
      }
      return [];
    });
    const checks = new Set((await validateRelationalState(db)).map((issue) => issue.check));
    expect(checks).toEqual(new Set([
      "current_revision_missing",
      "current_revision_cross_dialogue",
      "dialogue_revision_source_missing",
      "source_revision_location_missing",
      "source_location_current_cross_owner",
      "last_successful_revision_missing",
      "last_successful_not_parsed",
      "message_cross_dialogue",
      "chunk_message_missing",
      "search_document_cross_owner",
    ]));
  });

  test("allows source_chunks from multiple messages of the same dialogue revision", async () => {
    const dialogue = new RecordId("dialogue", "d1");
    const revision = new RecordId("dialogue_revision", "r1");
    const firstMessage = new RecordId("message", "m1");
    const secondMessage = new RecordId("message", "m2");
    const firstChunk = new RecordId("chunk", "c1");
    const secondChunk = new RecordId("chunk", "c2");
    const db = fakeDb((sql) => {
      if (sql === "SELECT id, identity_key, current_revision FROM dialogue") {
        return [{ id: dialogue, identity_key: "d1", current_revision: revision }];
      }
      if (sql.includes("source_revision, status FROM dialogue_revision")) {
        return [{ id: revision, dialogue, status: "ready" }];
      }
      if (sql === "SELECT id, dialogue, dialogue_revision FROM message") {
        return [
          { id: firstMessage, dialogue, dialogue_revision: revision },
          { id: secondMessage, dialogue, dialogue_revision: revision },
        ];
      }
      if (sql.includes("dialogue_revision, message FROM chunk")) {
        return [
          { id: firstChunk, dialogue, dialogue_revision: revision, message: firstMessage },
          { id: secondChunk, dialogue, dialogue_revision: revision, message: secondMessage },
        ];
      }
      if (sql.includes("source_chunks FROM search_document")) {
        return [{
          id: new RecordId("search_document", "valid-multi-message"),
          dialogue,
          dialogue_revision: revision,
          message: firstMessage,
          source_chunks: [firstChunk, secondChunk],
        }];
      }
      return [];
    });

    expect(await validateRelationalState(db)).toEqual([]);
  });

  test("reports one search issue when multiple source chunks belong to another dialogue", async () => {
    const firstDialogue = new RecordId("dialogue", "d1");
    const secondDialogue = new RecordId("dialogue", "d2");
    const firstRevision = new RecordId("dialogue_revision", "r1");
    const secondRevision = new RecordId("dialogue_revision", "r2");
    const firstMessage = new RecordId("message", "m1");
    const secondMessage = new RecordId("message", "m2");
    const localChunk = new RecordId("chunk", "c1");
    const foreignChunks = [new RecordId("chunk", "c2"), new RecordId("chunk", "c3")];
    const document = new RecordId("search_document", "cross-dialogue");
    const db = fakeDb((sql) => {
      if (sql === "SELECT id, identity_key, current_revision FROM dialogue") {
        return [
          { id: firstDialogue, identity_key: "d1", current_revision: firstRevision },
          { id: secondDialogue, identity_key: "d2", current_revision: secondRevision },
        ];
      }
      if (sql.includes("source_revision, status FROM dialogue_revision")) {
        return [
          { id: firstRevision, dialogue: firstDialogue, status: "ready" },
          { id: secondRevision, dialogue: secondDialogue, status: "ready" },
        ];
      }
      if (sql === "SELECT id, dialogue, dialogue_revision FROM message") {
        return [
          { id: firstMessage, dialogue: firstDialogue, dialogue_revision: firstRevision },
          { id: secondMessage, dialogue: secondDialogue, dialogue_revision: secondRevision },
        ];
      }
      if (sql.includes("dialogue_revision, message FROM chunk")) {
        return [
          { id: localChunk, dialogue: firstDialogue, dialogue_revision: firstRevision, message: firstMessage },
          ...foreignChunks.map((id) => ({
            id,
            dialogue: secondDialogue,
            dialogue_revision: secondRevision,
            message: secondMessage,
          })),
        ];
      }
      if (sql.includes("source_chunks FROM search_document")) {
        return [{
          id: document,
          dialogue: firstDialogue,
          dialogue_revision: firstRevision,
          message: firstMessage,
          source_chunks: [localChunk, ...foreignChunks],
        }];
      }
      return [];
    });

    expect(await validateRelationalState(db)).toEqual([
      { check: "search_document_cross_owner", detail: String(document) },
    ]);
  });
});

describe("migration quarantine", () => {
  test("проверяет dedicated migration_quarantine и legacy ingest_error", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("FROM migration_quarantine")) {
        return [
          {
            id: "migration_quarantine:q1",
            legacy_table: "threads",
            legacy_id: "42",
            reason: "broken payload",
          },
        ];
      }
      if (sql.includes("FROM ingest_error")) {
        return [
          {
            id: "ingest_error:old",
            source_record_key: "threads:1",
            error_code: "legacy_quarantine",
          },
        ];
      }
      return [];
    });
    const issues = await validateMigrationQuarantine(db);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.check === "unresolved_migration_quarantine")).toBe(true);
    expect(issues[0]!.detail).toContain("threads:42");
  });

  test("verified documented exclusions are informational while malformed acceptance stays an issue", async () => {
    const db = fakeDb((sql) => sql.includes("FROM ingest_error") ? [] : []);
    const accepted = await validateMigrationQuarantine(db, {
      lifecycle: {
        state: "accepted_with_operator_exclusions",
        unresolved: 0,
        documentedOperatorExclusions: 4,
        documentedOperatorExclusionLineages: 4,
        retryResolved: 0,
        supersededOperatorExclusions: 0,
        invalidResolutions: 0,
        byCode: {
          active_original_without_exact_dialogue: 1,
          deleted_original_unrecoverable_no_messages: 0,
          canonical_child_of_excluded_active_thread: 2,
          source_less_record_of_excluded_active_thread: 1,
          existing_dialogue_ownership_superseded: 0,
          canonical_child_of_superseded_thread: 0,
        },
        issues: [],
      },
    });
    expect(accepted).toEqual([]);

    const forged = await validateMigrationQuarantine(db, {
      lifecycle: {
        state: "blocked",
        unresolved: 0,
        documentedOperatorExclusions: 0,
        documentedOperatorExclusionLineages: 0,
        retryResolved: 0,
        supersededOperatorExclusions: 0,
        invalidResolutions: 1,
        byCode: {
          active_original_without_exact_dialogue: 0,
          deleted_original_unrecoverable_no_messages: 0,
          canonical_child_of_excluded_active_thread: 0,
          source_less_record_of_excluded_active_thread: 0,
          existing_dialogue_ownership_superseded: 0,
          canonical_child_of_superseded_thread: 0,
        },
        issues: [{
          check: "invalid_migration_quarantine_resolution",
          detail: "migration_quarantine:q: signature mismatch",
        }],
      },
    });
    expect(forged).toEqual([expect.objectContaining({
      check: "invalid_migration_quarantine_resolution",
    })]);
  });
});

describe("optional raw_archive_path (migration 0005)", () => {
  test("legacy_missing_raw + NONE намеренен, другой snapshot_kind — проблема", async () => {
    const archiveRoot = await mkdtemp(path.join(tmpdir(), "baka-validate-"));
    try {
      const db = fakeDb((sql) => {
        if (sql.includes("FROM schema_migration")) {
          return [{ version: 5 }];
        }
        if (sql.includes("SELECT id, sha256, raw_archive_path, snapshot_kind FROM source_revision")) {
          return [
            {
              id: "source_revision:intentional",
              sha256: "a".repeat(64),
              snapshot_kind: "legacy_missing_raw",
            },
            {
              id: "source_revision:broken",
              sha256: "b".repeat(64),
              snapshot_kind: "regular_copy",
            },
          ];
        }
        return [];
      });
      const report = await runValidationWithDb(db, { archiveRoot });
      expect(report.issues.some((issue) => issue.detail.includes("source_revision:intentional"))).toBe(false);
      expect(
        report.issues.some(
          (issue) =>
            issue.check === "source_revision_without_raw" &&
            issue.detail.includes("source_revision:broken"),
        ),
      ).toBe(true);
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });
});

describe("raw path containment", () => {
  test("symlink parent cannot redirect validation outside archiveRoot", async () => {
    const archiveRoot = await mkdtemp(path.join(tmpdir(), "baka-validate-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "baka-validate-outside-"));
    try {
      await writeFile(path.join(outside, "secret.jsonl"), "private");
      await symlink(outside, path.join(archiveRoot, "raw"));
      const db = fakeDb((sql) => {
        if (sql.includes("FROM schema_migration")) return [{ version: 5 }];
        if (sql.includes("SELECT id, sha256, raw_archive_path, snapshot_kind FROM source_revision")) {
          return [{
            id: "source_revision:escaped",
            sha256: "a".repeat(64),
            raw_archive_path: "raw/secret.jsonl",
            snapshot_kind: "regular_copy",
          }];
        }
        return [];
      });
      const report = await runValidationWithDb(db, { archiveRoot });
      expect(report.issues).toContainEqual(
        expect.objectContaining({ check: "unsafe_raw_file" }),
      );
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
