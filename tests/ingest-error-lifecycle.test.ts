import { afterAll, describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import {
  createIngestError,
  isDocumentedUnsupportedErrorCode,
  resolveStaleIngestErrors,
  resolveStaleSnapshotIngestErrors,
} from "../src/db/repositories/provenance.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { inspectUnresolvedIngestErrors } from "../src/doctor.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
} from "./db-test-utils.ts";

interface QueryCall {
  sql: string;
  vars?: Record<string, unknown>;
}

function rid(table: string, id: string): RecordId {
  return new RecordId(table, id);
}

describe("ingest error lifecycle", () => {
  test("repeated unsupported immutable raw preserves the original quarantine row", async () => {
    const calls: QueryCall[] = [];
    const original = rid("ingest_error", "unsupported_original");
    const db = {
      query: async (sql: string, vars?: Record<string, unknown>) => {
        calls.push({ sql, vars });
        if (sql.includes("SELECT id, first_failed_at FROM ingest_error")) {
          return [[{ id: original }]];
        }
        if (sql.includes("UPDATE ONLY $id SET last_failed_at")) return [[]];
        throw new Error("unexpected query");
      },
    } as unknown as Surreal;

    const result = await createIngestError(db, {
      syncRun: rid("sync_run", "retry"),
      sourceRevision: rid("source_revision", "immutable"),
      stage: "parse",
      errorCode: "unsupported_file",
      errorMessage: "fixture format is intentionally unsupported",
      parserVersion: 2,
    });

    expect(result.toString()).toBe(original.toString());
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.sql.includes("CREATE ONLY ingest_error"))).toBe(false);
    expect(calls[1]!.vars?.id).toEqual(original);
  });

  test("revision errors can be resolved only after a parsed outcome", async () => {
    const calls: QueryCall[] = [];
    const db = {
      query: async (sql: string, vars?: Record<string, unknown>) => {
        calls.push({ sql, vars });
        return [[]];
      },
    } as unknown as Surreal;
    const revision = rid("source_revision", "current");
    const run = rid("sync_run", "current");

    await expect(
      resolveStaleIngestErrors(db, [revision], run, "reparse:unsupported"),
    ).rejects.toThrow(/only by a successful parsed outcome/);
    expect(calls).toHaveLength(0);

    await resolveStaleIngestErrors(db, [revision], run, "reparse:parsed@2");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('source_revision.parse_status = "parsed"');
    expect(calls[0]!.vars?.resolution).toBe("reparse:parsed@2");
  });

  test("documented unsupported codes are an exact reviewed allow-list", () => {
    expect(isDocumentedUnsupportedErrorCode("unsupported_file")).toBe(true);
    expect(isDocumentedUnsupportedErrorCode("unsupported_path")).toBe(true);
    expect(isDocumentedUnsupportedErrorCode("unsupported_ai_service_entries")).toBe(true);
    expect(isDocumentedUnsupportedErrorCode("unsupported_transient_state")).toBe(false);
    expect(isDocumentedUnsupportedErrorCode("unsupported")).toBe(false);
  });

  test("snapshot resolution requires durable location provenance and revision ownership", async () => {
    const calls: QueryCall[] = [];
    const db = {
      query: async (sql: string, vars?: Record<string, unknown>) => {
        calls.push({ sql, vars });
        return [[]];
      },
    } as unknown as Surreal;
    const location = rid("source_location", "owned");
    const revision = rid("source_revision", "captured");
    const run = rid("sync_run", "success");

    await resolveStaleSnapshotIngestErrors(db, location, revision, run);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("source_record_key = $locationKey");
    expect(calls[0]!.sql).toContain("$revision.source_location = $location");
    expect(calls[0]!.vars).toEqual({
      run,
      location,
      locationKey: location.toString(),
      revision,
    });
  });
});

const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

describe("ingest error lifecycle integration", () => {
  testDb("preserves unsupported identity and resolves only provenance-proven failures", async () => {
    const t = await createTestDb();
    try {
      await t.db.query(`
        LET $now = time::now();
        CREATE host:lifecycle SET host_uuid = "fixture-host", hostname = "fixture",
          platform = "test", arch = "test", first_seen_at = $now, last_seen_at = $now;
        CREATE harness:codex SET slug = "codex", display_name = "Codex", kind = "cli";
        CREATE harness_installation:lifecycle SET host = host:lifecycle, harness = harness:codex,
          installed = true, first_seen_at = $now, last_detected_at = $now;
        CREATE source_root:lifecycle SET harness_installation = harness_installation:lifecycle,
          path = "/fixture", source_kind = "file_tree", parser_name = "codex",
          snapshot_strategy = "copy", enabled = true, first_seen_at = $now, last_seen_at = $now;
        CREATE source_location:lifecycle SET source_root = source_root:lifecycle,
          relative_path = "fixture.jsonl", original_path = "/fixture/fixture.jsonl",
          basename = "fixture.jsonl", presence_status = "active", missing_complete_scans = 0,
          first_seen_at = $now, last_seen_at = $now;
        CREATE sync_run:old SET kind = "fixture", status = "completed_with_errors",
          started_at = $now, host = host:lifecycle, baka_commit = "fixture", schema_version = 5;
        CREATE sync_run:retry SET kind = "fixture", status = "running",
          started_at = $now, host = host:lifecycle, baka_commit = "fixture", schema_version = 5;
        CREATE source_revision:lifecycle SET source_location = source_location:lifecycle,
          sha256 = $sha, size_bytes = 1, mtime_ms = 1, raw_archive_path = "raw/codex/fixture",
          snapshot_kind = "regular_copy", captured_at = $now, parser_name = "codex",
          parser_version = "2", parse_status = "unsupported", sync_run = sync_run:old;
        UPDATE source_location:lifecycle SET current_revision = source_revision:lifecycle;
      `, { sha: "a".repeat(64) });

      const unsupported = {
        syncRun: rid("sync_run", "old"),
        sourceRevision: rid("source_revision", "lifecycle"),
        stage: "parse",
        errorCode: "unsupported_file",
        errorMessage: "fixture format is intentionally unsupported",
        parserVersion: 2,
      } as const;
      const original = await createIngestError(t.db, unsupported);
      const repeated = await createIngestError(t.db, {
        ...unsupported,
        syncRun: rid("sync_run", "retry"),
      });
      expect(repeated.toString()).toBe(original.toString());
      const changedReason = await createIngestError(t.db, {
        ...unsupported,
        errorMessage: "a distinct unsupported reason must remain distinct",
      });
      expect(changedReason.toString()).not.toBe(original.toString());

      const unattributed = await createIngestError(t.db, {
        syncRun: rid("sync_run", "old"),
        stage: "snapshot",
        errorCode: "snapshot_exception",
        errorMessage: "historical failure without record provenance",
      });
      const attributed = await createIngestError(t.db, {
        syncRun: rid("sync_run", "old"),
        sourceRecordKey: "source_location:lifecycle",
        stage: "snapshot",
        errorCode: "snapshot_exception",
        errorMessage: "attributed fixture failure",
      });

      await resolveStaleSnapshotIngestErrors(
        t.db,
        rid("source_location", "lifecycle"),
        rid("source_revision", "lifecycle"),
        rid("sync_run", "retry"),
      );
      let rows = await selectAll<{ id: RecordId; resolved_at?: Date }>(
        t.db,
        "SELECT id, resolved_at FROM ingest_error ORDER BY id",
      );
      expect(rows.find((row) => row.id.toString() === attributed.toString())?.resolved_at)
        .toBeDefined();
      expect(rows.find((row) => row.id.toString() === unattributed.toString())?.resolved_at)
        .toBeUndefined();
      expect((await inspectUnresolvedIngestErrors(t.db)).map((item) => item.classification).sort())
        .toEqual([
          "documented_unsupported",
          "documented_unsupported",
          "unattributed_snapshot_failure",
        ]);

      await t.db.query('UPDATE source_revision:lifecycle SET parse_status = "parsed"');
      await resolveStaleIngestErrors(
        t.db,
        [rid("source_revision", "lifecycle")],
        rid("sync_run", "retry"),
        "reparse:parsed@2",
      );
      rows = await selectAll<{ id: RecordId; resolved_at?: Date }>(
        t.db,
        "SELECT id, resolved_at FROM ingest_error ORDER BY id",
      );
      expect(rows.find((row) => row.id.toString() === original.toString())?.resolved_at)
        .toBeDefined();
      expect(rows.find((row) => row.id.toString() === unattributed.toString())?.resolved_at)
        .toBeUndefined();
      expect((await inspectUnresolvedIngestErrors(t.db)).map((item) => item.classification))
        .toEqual(["unattributed_snapshot_failure"]);
    } finally {
      await dropTestDb(t);
    }
  });
});
