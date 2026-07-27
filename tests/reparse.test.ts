import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import {
  executeReparsePlan,
  planReparseTargets,
  reparseSourceRevisions,
  verifyKimiSessionMembership,
  type ReparseDependencies,
  type ReparsePlan,
  type ReparseTarget,
} from "../src/reparse.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
} from "../src/db/repositories/identity.ts";
import {
  createIngestError,
  createSyncRun,
  ensureSourceLocation,
  ensureSourceRevision,
  ensureSourceRoot,
  setLocationRevisions,
} from "../src/db/repositories/provenance.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import { HARNESSES } from "../src/sources/adapters/harnesses.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  isDbAvailable,
} from "./db-test-utils.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function rid(table: string, id: string): RecordId {
  return new RecordId(table, id);
}

function target(overrides: Partial<ReparseTarget> = {}): ReparseTarget {
  const id = overrides.id ?? rid("source_revision", "rev_1");
  return {
    id,
    sourceLocation: rid("source_location", "loc_1"),
    locationCurrentRevision: id,
    lastSuccessfulRevision: id,
    sourceRoot: rid("source_root", "root_1"),
    harnessInstallation: rid("harness_installation", "installation_1"),
    host: rid("host", "host_1"),
    harness: "codex",
    relativePath: "session.jsonl",
    rawArchivePath: "raw/session.jsonl",
    sha256: "a".repeat(64),
    parserName: "codex",
    parserVersion: "1",
    parseStatus: "parsed",
    ...overrides,
  };
}

function plan(...targets: ReparseTarget[]): ReparsePlan {
  return {
    units: targets.map((item) => ({
      key: `file\0${item.id.toString()}`,
      kind: "file",
      harness: item.harness,
      relativePath: item.relativePath,
      targets: [item],
      primary: item,
    })),
    selectedRevisionIds: targets.map((item) => item.id.toString()),
    expandedRevisionIds: [],
    skipped: [],
  };
}

async function createTargetRaw(archive: string, item: ReparseTarget, content = "fixture"): Promise<void> {
  const rawPath = path.join(archive, item.rawArchivePath);
  await mkdir(path.dirname(rawPath), { recursive: true });
  await writeFile(rawPath, content);
}

function parsedOutcome() {
  return {
    status: "parsed" as const,
    dialoguesDiscovered: 1,
    dialoguesWritten: 1,
    dialoguesFailed: 0,
    canonicalHash: "b".repeat(64),
    messagesWritten: 2,
    chunksWritten: 3,
    searchDocumentsWritten: 2,
    embeddingJobsCreated: 0,
    errors: 0,
  };
}

describe("reparse planning", () => {
  test("five exact Codex revisions form five addressable units in one selector", async () => {
    const targets = Array.from({ length: 5 }, (_, index) => {
      const id = rid("source_revision", `codex_large_${index + 1}`);
      return target({
        id,
        sourceLocation: rid("source_location", `codex_large_${index + 1}`),
        locationCurrentRevision: id,
        parseStatus: "parse_error",
      });
    });
    let selectedIds: string[] = [];
    const db = {
      query: async (_sql: string, vars?: Record<string, unknown>) => {
        selectedIds = ((vars?.ids ?? []) as RecordId[]).map(String);
        return [[...targets.map((item) => ({
          id: item.id,
          source_location: item.sourceLocation,
          location_current_revision: item.locationCurrentRevision,
          last_successful_revision: item.lastSuccessfulRevision,
          source_root: item.sourceRoot,
          harness_installation: item.harnessInstallation,
          host: item.host,
          harness_slug: item.harness,
          relative_path: item.relativePath,
          raw_archive_path: item.rawArchivePath,
          sha256: item.sha256,
          parser_name: item.parserName,
          parser_version: item.parserVersion,
          parse_status: item.parseStatus,
        }))]];
      },
    } as unknown as Surreal;

    const result = await planReparseTargets(db, {
      selection: { sourceRevisions: targets.map((item) => item.id) },
    });

    expect(selectedIds).toEqual(targets.map((item) => item.id.toString()));
    expect(result.selectedRevisionIds).toEqual(
      targets.map((item) => item.id.toString()).sort(),
    );
    expect(result.units).toHaveLength(5);
    expect(result.units.every((unit) => unit.harness === "codex" && unit.targets.length === 1))
      .toBe(true);
  });

  test("explicit historical revision is skipped instead of rewinding current dialogue", async () => {
    const historical = target({
      id: rid("source_revision", "old"),
      locationCurrentRevision: rid("source_revision", "new"),
    });
    const db = {
      query: async () => [[{
        id: historical.id,
        source_location: historical.sourceLocation,
        location_current_revision: historical.locationCurrentRevision,
        last_successful_revision: historical.lastSuccessfulRevision,
        source_root: historical.sourceRoot,
        harness_installation: historical.harnessInstallation,
        host: historical.host,
        harness_slug: historical.harness,
        relative_path: historical.relativePath,
        raw_archive_path: historical.rawArchivePath,
        sha256: historical.sha256,
        parser_name: historical.parserName,
        parser_version: historical.parserVersion,
        parse_status: historical.parseStatus,
      }]],
    } as unknown as Surreal;
    const result = await planReparseTargets(db, {
      selection: { sourceRevisions: [historical.id] },
    });
    expect(result.units).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "historical_revision" })]);
  });

  test("kimi member expands to a complete current session unit", async () => {
    const wire = target({
      id: rid("source_revision", "wire"),
      harness: "kimi-code",
      relativePath: "wd/session/agents/main/wire.jsonl",
      rawArchivePath: "raw/wire.jsonl",
    });
    const state = target({
      id: rid("source_revision", "state"),
      sourceLocation: rid("source_location", "loc_state"),
      locationCurrentRevision: rid("source_revision", "state"),
      harness: "kimi-code",
      relativePath: "wd/session/state.json",
      rawArchivePath: "raw/state.json",
    });
    const row = (item: ReparseTarget) => ({
      id: item.id,
      source_location: item.sourceLocation,
      location_current_revision: item.locationCurrentRevision,
      last_successful_revision: item.lastSuccessfulRevision,
      source_root: item.sourceRoot,
      harness_installation: item.harnessInstallation,
      host: item.host,
      harness_slug: item.harness,
      relative_path: item.relativePath,
      raw_archive_path: item.rawArchivePath,
      sha256: item.sha256,
      parser_name: item.parserName,
      parser_version: item.parserVersion,
      parse_status: item.parseStatus,
    });
    let calls = 0;
    const db = {
      query: async () => {
        calls += 1;
        if (calls === 1) return [[row(wire)]];
        if (calls === 2) return [[row(wire), row(state)]];
        return [[wire, state].map((item) => ({
          id: item.sourceLocation,
          source_root: item.sourceRoot,
          relative_path: item.relativePath,
          presence_status: "active",
          current_revision: item.id,
          revision_source_location: item.sourceLocation,
          revision_run_status: "completed",
        }))];
      },
    } as unknown as Surreal;
    const result = await planReparseTargets(db, {
      selection: { sourceRevisions: [wire.id] },
    });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.kind).toBe("kimi-session");
    expect(result.units[0]!.targets.map((item) => item.id.toString()).sort()).toEqual([
      state.id.toString(),
      wire.id.toString(),
    ].sort());
    expect(result.expandedRevisionIds).toEqual([state.id.toString()]);
  });

  test("kimi session without required current companion is rejected", async () => {
    const wire = target({
      id: rid("source_revision", "wire"),
      harness: "kimi-code",
      relativePath: "wd/session/agents/main/wire.jsonl",
      rawArchivePath: "raw/wire.jsonl",
    });
    const row = {
      id: wire.id,
      source_location: wire.sourceLocation,
      location_current_revision: wire.id,
      last_successful_revision: wire.lastSuccessfulRevision,
      source_root: wire.sourceRoot,
      harness_installation: wire.harnessInstallation,
      host: wire.host,
      harness_slug: wire.harness,
      relative_path: wire.relativePath,
      raw_archive_path: wire.rawArchivePath,
      sha256: wire.sha256,
      parser_name: wire.parserName,
      parser_version: wire.parserVersion,
      parse_status: wire.parseStatus,
    };
    let calls = 0;
    const db = {
      query: async () => {
        calls += 1;
        if (calls <= 2) return [[row]];
        return [[{
          id: wire.sourceLocation,
          source_root: wire.sourceRoot,
          relative_path: wire.relativePath,
          presence_status: "active",
          current_revision: wire.id,
          revision_source_location: wire.sourceLocation,
          revision_run_status: "completed",
        }]];
      },
    } as unknown as Surreal;
    const result = await planReparseTargets(db, { selection: { sourceRevisions: [wire.id] } });
    expect(result.units).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        id: wire.id.toString(),
        reason: "incomplete_session",
        detail: "kimi_required_member_missing",
      }),
    ]);
  });

  test("kimi membership rejects inactive and mixed current companions", async () => {
    const wire = target({
      id: rid("source_revision", "wire"),
      harness: "kimi-code",
      relativePath: "wd/session/agents/main/wire.jsonl",
    });
    const state = target({
      id: rid("source_revision", "state"),
      sourceLocation: rid("source_location", "loc_state"),
      locationCurrentRevision: rid("source_revision", "state"),
      harness: "kimi-code",
      relativePath: "wd/session/state.json",
    });
    const unit = {
      key: "kimi",
      kind: "kimi-session" as const,
      harness: "kimi-code" as const,
      relativePath: "wd/session",
      targets: [wire, state],
      primary: wire,
    };
    const membership = (stateOverrides: Record<string, unknown>) => [
      {
        id: wire.sourceLocation,
        source_root: wire.sourceRoot,
        relative_path: wire.relativePath,
        presence_status: "active",
        current_revision: wire.id,
        revision_source_location: wire.sourceLocation,
        revision_run_status: "completed",
      },
      {
        id: state.sourceLocation,
        source_root: state.sourceRoot,
        relative_path: state.relativePath,
        presence_status: "active",
        current_revision: state.id,
        revision_source_location: state.sourceLocation,
        revision_run_status: "completed",
        ...stateOverrides,
      },
    ];
    const inactiveDb = { query: async () => [[...membership({ presence_status: "missing" })]] } as unknown as Surreal;
    expect(await verifyKimiSessionMembership(inactiveDb, unit)).toEqual({
      ok: false,
      code: "kimi_member_inactive",
    });
    const mixedDb = {
      query: async () => [[...membership({ current_revision: rid("source_revision", "state_new") })]],
    } as unknown as Surreal;
    expect(await verifyKimiSessionMembership(mixedDb, unit)).toEqual({
      ok: false,
      code: "kimi_membership_changed",
    });
    const unfinishedDb = {
      query: async () => [[...membership({ revision_run_status: "running" })]],
    } as unknown as Surreal;
    expect(await verifyKimiSessionMembership(unfinishedDb, unit)).toEqual({
      ok: false,
      code: "kimi_snapshot_run_incomplete",
    });
  });
});

describe("reparse execution", () => {
  test("dry-run performs no parsing or filesystem/DB mutation", async () => {
    const exploding = async () => { throw new Error("must not be called"); };
    const summary = await executeReparsePlan({
      db: {} as Surreal,
      archiveRoot: "/definitely/not/used",
      plan: plan(target()),
      dryRun: true,
      dependencies: {
        ingest: exploding as ReparseDependencies["ingest"],
        updateParse: exploding as ReparseDependencies["updateParse"],
      },
    });
    expect(summary.status).toBe("dry_run");
    expect(summary.counters.unitsProcessed).toBe(0);
    expect(summary.counters.unitsPlanned).toBe(1);
  });

  test("success updates parser state/pointers and resolves only stale errors", async () => {
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-test-"));
    temporaryDirectories.push(archive);
    const current = target();
    await createTargetRaw(archive, current);
    const calls: string[] = [];
    const dependencies: Partial<ReparseDependencies> = {
      verifyFile: async () => ({ sha256: current.sha256, headHash: "h", sizeBytes: 1 }),
      ingest: async () => parsedOutcome(),
      updateParse: async (_db, id, outcome) => { calls.push(`parse:${id}:${outcome.parseStatus}`); },
      updateParserIdentity: async (_db, id, name, version) => {
        calls.push(`parser:${id}:${name}@${version}`);
      },
      setLocation: async (_db, location, revisions) => {
        calls.push(`location:${location}:${revisions.lastSuccessfulRevision}`);
      },
      resolveErrors: async (_db, ids, _run, resolution) => {
        calls.push(`resolve:${ids.join(",")}:${resolution}`);
      },
    };
    const summary = await executeReparsePlan({
      db: {} as Surreal,
      archiveRoot: archive,
      plan: plan(current),
      syncRun: rid("sync_run", "run_2"),
      dependencies,
    });
    expect(summary.status).toBe("completed");
    expect(summary.counters.unitsSucceeded).toBe(1);
    expect(summary.counters.messagesWritten).toBe(2);
    expect(calls).toEqual([
      `parse:${current.id}:parsed`,
      `parser:${current.id}:codex@2`,
      `location:${current.sourceLocation}:${current.id}`,
      `resolve:${current.id}:reparse:parsed@2`,
    ]);
  });

  test("failed attempt preserves a previously successful revision and pointers", async () => {
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-test-"));
    temporaryDirectories.push(archive);
    const current = target({ parseStatus: "parsed" });
    await createTargetRaw(archive, current);
    let mutations = 0;
    const mutate = async () => { mutations += 1; };
    const summary = await executeReparsePlan({
      db: {} as Surreal,
      archiveRoot: archive,
      plan: plan(current),
      syncRun: rid("sync_run", "run_2"),
      dependencies: {
        verifyFile: async () => ({ sha256: current.sha256, headHash: "h", sizeBytes: 1 }),
        ingest: async () => ({ ...parsedOutcome(), status: "parse_error", errors: 1 }),
        updateParse: mutate as ReparseDependencies["updateParse"],
        updateParserIdentity: mutate as ReparseDependencies["updateParserIdentity"],
        setLocation: mutate as ReparseDependencies["setLocation"],
        resolveErrors: mutate as ReparseDependencies["resolveErrors"],
      },
    });
    expect(summary.status).toBe("completed_with_errors");
    expect(summary.counters.unitsFailed).toBe(1);
    expect(mutations).toBe(0);
  });

  test("unsupported immutable raw remains unresolved and keeps its location pointers", async () => {
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-test-"));
    temporaryDirectories.push(archive);
    const current = target({ parseStatus: "unsupported" });
    await createTargetRaw(archive, current);
    const calls: string[] = [];
    const summary = await executeReparsePlan({
      db: {} as Surreal,
      archiveRoot: archive,
      plan: plan(current),
      syncRun: rid("sync_run", "run_unsupported"),
      dependencies: {
        verifyFile: async () => ({ sha256: current.sha256, headHash: "h", sizeBytes: 1 }),
        ingest: async () => ({
          ...parsedOutcome(),
          status: "unsupported",
          dialoguesDiscovered: 0,
          dialoguesWritten: 0,
          messagesWritten: 0,
          chunksWritten: 0,
          searchDocumentsWritten: 0,
          errors: 1,
        }),
        updateParse: async (_db, id, outcome) => {
          calls.push(`parse:${id}:${outcome.parseStatus}`);
        },
        updateParserIdentity: async () => { calls.push("parser"); },
        setLocation: async () => { calls.push("location"); },
        resolveErrors: async () => { calls.push("resolve"); },
      },
    });

    expect(summary.status).toBe("completed_with_errors");
    expect(calls).toEqual([`parse:${current.id}:unsupported`]);
  });

  test("raw hash mismatch blocks parser and keeps pointers unchanged", async () => {
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-test-"));
    temporaryDirectories.push(archive);
    const current = target();
    await createTargetRaw(archive, current);
    let parserCalls = 0;
    const summary = await executeReparsePlan({
      db: {} as Surreal,
      archiveRoot: archive,
      plan: plan(current),
      syncRun: rid("sync_run", "run_2"),
      dependencies: {
        verifyFile: async () => ({ sha256: "bad", headHash: "h", sizeBytes: 1 }),
        ingest: (async () => { parserCalls += 1; return parsedOutcome(); }) as ReparseDependencies["ingest"],
      },
    });
    expect(summary.status).toBe("completed_with_errors");
    expect(summary.errors[0]).toContain("immutable_raw_hash_mismatch");
    expect(parserCalls).toBe(0);
  });

  test("symlink-parent raw escape is rejected before parser and logs no path/error text", async () => {
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-outside-"));
    temporaryDirectories.push(archive, outside);
    await writeFile(path.join(outside, "session.jsonl"), "PRIVATE RAW CONTENT");
    await symlink(outside, path.join(archive, "raw"));
    const current = target({ rawArchivePath: "raw/session.jsonl" });
    const events: Record<string, unknown>[] = [];
    let parserCalls = 0;
    const summary = await executeReparsePlan({
      db: {} as Surreal,
      archiveRoot: archive,
      plan: plan(current),
      syncRun: rid("sync_run", "run_2"),
      logger: (event) => events.push(event),
      dependencies: {
        ingest: (async () => { parserCalls += 1; return parsedOutcome(); }) as ReparseDependencies["ingest"],
      },
    });
    expect(summary.status).toBe("completed_with_errors");
    expect(summary.errors[0]).toContain("raw_realpath_escape");
    expect(parserCalls).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({ event: "reparse_unit_failed", errorCode: "raw_realpath_escape" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
    expect(JSON.stringify(events)).not.toContain(outside);
  });

  test("arbitrary parser error text never crosses logger seam", async () => {
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-log-"));
    temporaryDirectories.push(archive);
    const current = target();
    await createTargetRaw(archive, current);
    const events: Record<string, unknown>[] = [];
    await executeReparsePlan({
      db: {} as Surreal,
      archiveRoot: archive,
      plan: plan(current),
      syncRun: rid("sync_run", "run_2"),
      logger: (event) => events.push(event),
      dependencies: {
        verifyFile: async () => ({ sha256: current.sha256, headHash: "h", sizeBytes: 1 }),
        ingest: async () => { throw new Error("PRIVATE PARSER CONTENT"); },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({ event: "reparse_unit_failed", errorCode: "reparse_unit_failed" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE PARSER CONTENT");
  });
});

beforeAll(async () => {
  await isDbAvailable();
});
const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

describe("reparse integration", () => {
  testDb("immutable Codex raw is reparsed through the canonical writer", async () => {
    const t = await createTestDb();
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-integration-"));
    temporaryDirectories.push(archive);
    try {
      const host = await ensureHost(t.db, {
        hostUuid: "reparse-host",
        hostname: "test-host",
        platform: "test",
        arch: "test",
      });
      const harness = await ensureHarness(t.db, {
        slug: "codex",
        displayName: HARNESSES.codex.displayName,
        kind: HARNESSES.codex.sourceKind,
      });
      const installation = await ensureHarnessInstallation(t.db, {
        host,
        harness,
        installed: true,
      });
      const root = await ensureSourceRoot(t.db, {
        harnessInstallation: installation,
        path: "/fixture/codex",
        sourceKind: HARNESSES.codex.sourceKind,
        parserName: "codex",
        snapshotStrategy: "copy",
        enabled: true,
      });
      const location = await ensureSourceLocation(t.db, {
        sourceRoot: root,
        relativePath: "basic-dialogue.jsonl",
        originalPath: "/fixture/codex/basic-dialogue.jsonl",
        basename: "basic-dialogue.jsonl",
      });
      const rawRelative = "raw/codex/basic-dialogue.jsonl";
      const rawAbsolute = path.join(archive, rawRelative);
      await mkdir(path.dirname(rawAbsolute), { recursive: true });
      await copyFile(path.join(import.meta.dir, "fixtures/codex/basic-dialogue.jsonl"), rawAbsolute);
      const hashes = await hashFile(rawAbsolute);
      const oldRun = await createSyncRun(t.db, {
        kind: "fixture",
        host,
        bakaCommit: "test",
        schemaVersion: 5,
      });
      const revision = await ensureSourceRevision(t.db, {
        sourceLocation: location.id,
        sha256: hashes.sha256,
        sizeBytes: hashes.sizeBytes,
        mtimeMs: 1,
        rawArchivePath: rawRelative,
        snapshotKind: "regular_copy",
        parserName: "codex",
        parserVersion: 1,
        syncRun: oldRun,
      });
      await setLocationRevisions(t.db, location.id, { currentRevision: revision.id });
      await createIngestError(t.db, {
        syncRun: oldRun,
        sourceRevision: revision.id,
        stage: "parse",
        errorCode: "old_parser_error",
        errorMessage: "fixed by parser v2",
        parserVersion: 1,
      });
      const reparseRun = await createSyncRun(t.db, {
        kind: "reparse",
        host,
        bakaCommit: "test",
        schemaVersion: 5,
      });

      const summary = await reparseSourceRevisions(t.db, archive, {
        selection: { sourceRevisions: [revision.id] },
        enqueueEmbeddings: false,
      }, { syncRun: reparseRun, activeEmbeddingSpaces: [], embeddingTables: [] });
      expect(summary.status).toBe("completed");
      expect(summary.counters.dialoguesWritten).toBeGreaterThan(0);
      const stored = await selectOne<{
        parse_status: string;
        parser_version: string;
        last_successful: RecordId;
      }>(t.db,
        `SELECT parse_status, parser_version,
           source_location.last_successful_revision AS last_successful
         FROM ONLY $revision`,
        { revision: revision.id },
      );
      expect(stored?.parse_status).toBe("parsed");
      expect(stored?.parser_version).toBe("2");
      expect(stored?.last_successful.toString()).toBe(revision.id.toString());
      const errors = await selectAll<{ resolved_at?: Date; resolution?: string }>(
        t.db,
        "SELECT resolved_at, resolution FROM ingest_error WHERE source_revision = $revision",
        { revision: revision.id },
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.resolved_at).toBeDefined();
      expect(errors[0]!.resolution).toBe("reparse:parsed@2");
    } finally {
      await dropTestDb(t);
    }
  });
});
