import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { RecordId, type Surreal } from "surrealdb";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";
import {
  LEGACY_THREAD_SPEED_MAX_ELAPSED_MS,
  legacyThreadSpeedCheckpoint,
  retryLegacyMigration,
  runLegacyMigration,
  writeMigrationRunReport,
  type SnapshotRecoveryInput,
} from "../src/migration/run.ts";
import {
  LEGACY_IDENTITY_PREFETCH_BATCH_SIZE,
  legacyIdentityPrefetchKey,
  shouldApplyLegacyDeleted,
  shouldAttachRepairedRaw,
  resolveApprovedHostMapping,
  resolveExistingCanonicalOwnership,
  resolveLegacyCanonicalBindings,
  SurrealLegacyMigrationBackend,
} from "../src/migration/store.ts";
import type {
  AgentTarget,
  DialogueDedupInput,
  DialogueTarget,
  DialogueWriteInput,
  EnsureTarget,
  LegacyIdentityPrefetch,
  LegacyIdentityRequest,
  LegacyMigrationBackend,
  MigrationIdentityCommit,
  MigrationRunHandle,
  MigrationRunInput,
  ProjectTarget,
  QuarantineInput,
  RevisionTarget,
  SourceTarget,
} from "../src/migration/store.ts";
import type {
  LegacyAgentRow,
  LegacyProjectRow,
  LegacyRawBackupRow,
  LegacySourceFileRow,
  LegacyTable,
  LegacyThreadRecordRow,
  LegacyThreadBundle,
  LegacyThreadRow,
} from "../src/migration/legacy-reader.ts";
import type { MigrationRunReport } from "../src/migration/reconciliation.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import { sha256hex } from "../src/db/transactions.ts";
import {
  buildLegacyHostMappingApproval,
  buildMigrationPreflightApproval,
  canonicalMigrationJson,
  migrationApprovalKeyFingerprint,
  migrationArtifactSha256,
  readMigrationPreflightApprovalArtifact,
  writeMigrationPreflightApprovalArtifact,
  type MigrationPreflightApproval,
  type MigrationRunAuthorization,
} from "../src/migration/authorization.ts";
import { expectedSuccessfulRestoreCheckNames } from "../src/backup/restore-test.ts";
import { manifestPathForExport } from "../src/backup/backup.ts";
import { buildPreflightReport, type LiveCorpusProbe } from "../src/migration/preflight.ts";
import type { ApprovedLegacyHostMapping } from "../src/migration/store.ts";
import { isolatedRestoreTargetEvidence } from "./restore-target-fixture.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function dialogue(externalId: string, content: string): ParsedDialogue {
  return {
    externalId,
    messages: [
      {
        sequence: 0,
        role: "user",
        humanAuthored: true,
        visibleToUser: true,
        usageEvents: [],
        chunks: [{ sequence: 0, kind: "text", content, metadata: {} }],
        metadata: {},
      },
    ],
    metadata: {},
  };
}

function fixtureRecoveredDialogue(externalId: string): ParsedDialogue {
  const id = Number(externalId.slice(1));
  const assistant = id === 3;
  return {
    externalId,
    messages: [{
      sequence: 0,
      role: assistant ? "assistant" : "user",
      humanAuthored: !assistant,
      visibleToUser: true,
      usageEvents: [],
      chunks: [{
        sequence: 0,
        kind: "text",
        rawKind: assistant ? "output_text" : "input_text",
        content: `payload-${id}`,
        metadata: {},
      }],
      metadata: {},
    }],
    metadata: {},
  };
}

function bindingBundle(): LegacyThreadBundle {
  const prompt = "redacted prompt";
  const answer = "redacted answer";
  return {
    thread: { id: 1, agent_id: 1, external_id: "binding" },
    records: [
      { id: 10, thread_id: 1, source_file_id: 1, sequence: 0, payload: "{}" },
      { id: 11, thread_id: 1, source_file_id: 1, sequence: 1, payload: "{}" },
      { id: 12, thread_id: 1, source_file_id: 1, sequence: 2, payload: "{}" },
      { id: 13, thread_id: 1, source_file_id: 1, sequence: 3, payload: "{}" },
    ],
    messages: [
      { id: 20, thread_id: 1, source_record_id: 10, sequence: 0, role: "user" },
      { id: 21, thread_id: 1, source_record_id: 13, sequence: 1, role: "assistant" },
    ],
    chunks: [
      {
        id: 30,
        message_id: 20,
        source_record_id: 10,
        sequence: 0,
        kind: "input_text",
        content_sha256: sha256hex(prompt),
        content_bytes: Buffer.byteLength(prompt),
      },
      {
        id: 31,
        message_id: 21,
        source_record_id: 13,
        sequence: 0,
        kind: "output_text",
        content_sha256: sha256hex(answer),
        content_bytes: Buffer.byteLength(answer),
      },
    ],
  } as LegacyThreadBundle;
}

function shiftedCodexDialogue(): ParsedDialogue {
  return {
    externalId: "binding",
    messages: [
      {
        sequence: 0,
        role: "user",
        humanAuthored: true,
        visibleToUser: true,
        usageEvents: [],
        chunks: [{
          sequence: 2,
          kind: "text",
          rawKind: "input_text",
          content: "redacted prompt",
          sourceLocator: "/immutable/raw.jsonl#L1",
          metadata: {},
        }],
        metadata: {},
      },
      {
        sequence: 1,
        role: "assistant",
        humanAuthored: false,
        visibleToUser: false,
        usageEvents: [],
        chunks: [{
          sequence: 0,
          kind: "thought",
          rawKind: "reasoning",
          content: "redacted reasoning",
          sourceLocator: "/immutable/raw.jsonl#L2",
          metadata: {},
        }],
        metadata: {},
      },
      {
        sequence: 2,
        role: "tool",
        humanAuthored: false,
        visibleToUser: false,
        usageEvents: [],
        chunks: [{
          sequence: 0,
          kind: "tool_result",
          rawKind: "function_call_output",
          content: "redacted tool output",
          sourceLocator: "/immutable/raw.jsonl#L3",
          metadata: {},
        }],
        metadata: {},
      },
      {
        sequence: 3,
        role: "assistant",
        humanAuthored: false,
        visibleToUser: true,
        usageEvents: [],
        chunks: [{
          sequence: 4,
          kind: "text",
          rawKind: "output_text",
          content: "redacted answer",
          sourceLocator: "/immutable/raw.jsonl#L4",
          metadata: {},
        }],
        metadata: {},
      },
    ],
    metadata: {},
  };
}

describe("legacy canonical child binding", () => {
  test("Codex source line ownership survives shifted reasoning/tool messages and chunks", () => {
    const bindings = resolveLegacyCanonicalBindings(
      bindingBundle(),
      shiftedCodexDialogue(),
      "codex",
      "raw",
    );
    expect(bindings).toEqual({
      source: "raw",
      messages: [
        { legacyId: "20", canonicalSequence: 0 },
        { legacyId: "21", canonicalSequence: 3 },
      ],
      chunks: [
        {
          legacyId: "30",
          legacyMessageId: "20",
          canonicalMessageSequence: 0,
          canonicalChunkSequence: 2,
        },
        {
          legacyId: "31",
          legacyMessageId: "21",
          canonicalMessageSequence: 3,
          canonicalChunkSequence: 4,
        },
      ],
    });
    expect(resolveLegacyCanonicalBindings(
      bindingBundle(),
      shiftedCodexDialogue(),
      "codex",
      "raw",
    )).toEqual(bindings);
  });

  test("Codex binding rejects ambiguous role/line and semantic mismatch", () => {
    const ambiguous = shiftedCodexDialogue();
    ambiguous.messages.push({
      ...structuredClone(ambiguous.messages[0]!),
      sequence: 9,
    });
    expect(() => resolveLegacyCanonicalBindings(bindingBundle(), ambiguous, "codex", "payload"))
      .toThrow("no unique Codex role/line target");

    const mismatch = shiftedCodexDialogue();
    mismatch.messages[3]!.chunks[0]!.content = "different answer";
    expect(() => resolveLegacyCanonicalBindings(bindingBundle(), mismatch, "codex", "raw"))
      .toThrow("no unique semantic target");
  });

  test("non-Codex sequence binding requires full role/hash/bytes/raw-kind identity", () => {
    const parsed = shiftedCodexDialogue();
    parsed.messages = [parsed.messages[0]!, { ...parsed.messages[3]!, sequence: 1 }];
    parsed.messages[0]!.chunks[0]!.sequence = 0;
    parsed.messages[1]!.chunks[0]!.sequence = 0;
    const exact = resolveLegacyCanonicalBindings(bindingBundle(), parsed, "claude-code", "raw");
    expect(exact.messages.map((row) => row.canonicalSequence)).toEqual([0, 1]);

    parsed.messages[1]!.chunks[0]!.rawKind = "text";
    expect(() => resolveLegacyCanonicalBindings(bindingBundle(), parsed, "claude-code", "raw"))
      .toThrow("no unique semantic target");
  });

  test("normalized projection may bind a proven row with no legacy chunks", () => {
    const bundle = bindingBundle();
    bundle.chunks = bundle.chunks.filter((row) => row.message_id !== 21);
    const parsed = shiftedCodexDialogue();
    parsed.messages = [
      { ...parsed.messages[0]!, chunks: [{ ...parsed.messages[0]!.chunks[0]!, sequence: 0 }] },
      { ...parsed.messages[3]!, sequence: 1, chunks: [] },
    ];
    expect(resolveLegacyCanonicalBindings(bundle, parsed, "claude-code", "normalized").messages)
      .toEqual([
        { legacyId: "20", canonicalSequence: 0 },
        { legacyId: "21", canonicalSequence: 1 },
      ]);
    expect(() => resolveLegacyCanonicalBindings(bundle, parsed, "claude-code", "payload"))
      .toThrow("has no chunk identity evidence");
  });

  test("exact live ownership requires structural and stored chunk semantics", () => {
    const bundle = bindingBundle();
    bundle.chunks[0]!.metadata_path = "/malformed/arbitrary/metadata";
    const user = new RecordId("message", "live_user");
    const answer = new RecordId("message", "live_answer");
    const userChunk = new RecordId("chunk", "live_user_chunk");
    const answerChunk = new RecordId("chunk", "live_answer_chunk");
    const ownership = resolveExistingCanonicalOwnership(
      bundle,
      "codex",
      [
        { id: user, sequence: 17, role: "user" },
        { id: answer, sequence: 23, role: "assistant" },
      ],
      [
        {
          id: userChunk,
          message: user,
          sequence: 9,
          kind: "text",
          raw_kind: "input_text",
          source_locator: "/immutable/current.jsonl#L1",
          content_sha256: sha256hex("redacted prompt"),
          content_bytes: Buffer.byteLength("redacted prompt"),
        },
        {
          id: answerChunk,
          message: answer,
          sequence: 8,
          kind: "text",
          raw_kind: "output_text",
          source_locator: "/immutable/current.jsonl#L4",
          content_sha256: sha256hex("redacted answer"),
          content_bytes: Buffer.byteLength("redacted answer"),
        },
      ],
    );
    expect(ownership.messages).toEqual(new Map([
      ["20", user],
      ["21", answer],
    ]));
    expect(ownership.chunks).toEqual(new Map([
      ["30", userChunk],
      ["31", answerChunk],
    ]));
    bundle.chunks[0]!.content_sha256 = "not-a-safe-digest";
    expect(() => resolveExistingCanonicalOwnership(
      bundle,
      "codex",
      [
        { id: user, sequence: 17, role: "user" },
        { id: answer, sequence: 23, role: "assistant" },
      ],
      [
        {
          id: userChunk,
          message: user,
          sequence: 9,
          kind: "text",
          raw_kind: "input_text",
          source_locator: "/immutable/current.jsonl#L1",
          content_sha256: sha256hex("redacted prompt"),
          content_bytes: Buffer.byteLength("redacted prompt"),
        },
        {
          id: answerChunk,
          message: answer,
          sequence: 8,
          kind: "text",
          raw_kind: "output_text",
          source_locator: "/immutable/current.jsonl#L4",
          content_sha256: sha256hex("redacted answer"),
          content_bytes: Buffer.byteLength("redacted answer"),
        },
      ],
    )).toThrow("no unique existing sequence/line target");
  });

  test("Codex exact live ownership never falls back when the durable locator line mismatches", () => {
    const bundle = bindingBundle();
    const user = new RecordId("message", "wrong_line_user");
    const answer = new RecordId("message", "exact_line_answer");
    expect(() => resolveExistingCanonicalOwnership(
      bundle,
      "codex",
      [
        { id: user, sequence: 0, role: "user" },
        { id: answer, sequence: 1, role: "assistant" },
      ],
      [
        {
          id: new RecordId("chunk", "wrong_line_user_chunk"),
          message: user,
          sequence: 0,
          kind: "text",
          raw_kind: "input_text",
          source_locator: "/immutable/current.jsonl#L999",
          content_sha256: sha256hex("redacted prompt"),
          content_bytes: Buffer.byteLength("redacted prompt"),
        },
        {
          id: new RecordId("chunk", "exact_line_answer_chunk"),
          message: answer,
          sequence: 0,
          kind: "text",
          raw_kind: "output_text",
          source_locator: "/immutable/current.jsonl#L4",
          content_sha256: sha256hex("redacted answer"),
          content_bytes: Buffer.byteLength("redacted answer"),
        },
      ],
    )).toThrow("messages:20 has no unique existing role/sequence/line target");
  });

  test("Codex null source provenance cannot bind while non-Codex sequence ownership remains valid", () => {
    const bundle = bindingBundle();
    bundle.messages[0]!.source_record_id = null;
    bundle.messages[1]!.source_record_id = null;
    bundle.chunks[0]!.source_record_id = null;
    bundle.chunks[1]!.source_record_id = null;
    const user = new RecordId("message", "null_source_user");
    const answer = new RecordId("message", "null_source_answer");
    const userChunk = new RecordId("chunk", "null_source_user_chunk");
    const answerChunk = new RecordId("chunk", "null_source_answer_chunk");
    const canonicalMessages = [
      { id: user, sequence: 0, role: "user" as const },
      { id: answer, sequence: 1, role: "assistant" as const },
    ];
    const canonicalChunks = [
      {
        id: userChunk,
        message: user,
        sequence: 0,
        kind: "text",
        raw_kind: "input_text",
        source_locator: "/immutable/current.jsonl#L999",
        content_sha256: sha256hex("redacted prompt"),
        content_bytes: Buffer.byteLength("redacted prompt"),
      },
      {
        id: answerChunk,
        message: answer,
        sequence: 0,
        kind: "text",
        raw_kind: "output_text",
        source_locator: "/immutable/current.jsonl#L999",
        content_sha256: sha256hex("redacted answer"),
        content_bytes: Buffer.byteLength("redacted answer"),
      },
    ];
    expect(() => resolveExistingCanonicalOwnership(
      bundle,
      "codex",
      canonicalMessages,
      canonicalChunks,
    )).toThrow("messages:20 has no owned Codex source locator line");

    const nonCodex = resolveExistingCanonicalOwnership(
      bundle,
      "claude-code",
      canonicalMessages,
      canonicalChunks,
    );
    expect(nonCodex.messages).toEqual(new Map([["20", user], ["21", answer]]));
    expect(nonCodex.chunks).toEqual(new Map([["30", userChunk], ["31", answerChunk]]));
  });
});

function identityRequests(count: number): LegacyIdentityRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    table: "messages" as const,
    legacyId: String(index + 1),
  }));
}

function emptyIdentityPrefetch(requests: LegacyIdentityRequest[]): LegacyIdentityPrefetch {
  return {
    requestedKeys: new Set(
      requests.map((row) => legacyIdentityPrefetchKey(row.table, row.legacyId)),
    ),
    existing: new Map(),
    unresolvedQuarantines: new Map(),
  };
}

function identityCommits(count: number): MigrationIdentityCommit[] {
  return Array.from({ length: count }, (_, index) => ({
    table: "messages" as const,
    legacyId: String(index + 1),
    target: new RecordId("message", `canonical_${index + 1}`),
    category: "inserted" as const,
  }));
}

function migrationBackend(db: Surreal): SurrealLegacyMigrationBackend {
  return new SurrealLegacyMigrationBackend(db, "/archive", {
    hostUuid: "h",
    hostname: "host",
    platform: "test",
    arch: "test",
    osUsername: "u",
    homePath: "/Users/u",
  });
}

const identityRun: MigrationRunHandle = {
  syncRunId: new RecordId("sync_run", "identity_batch"),
  migrationId: new RecordId("migration_meta", "identity_batch"),
};

describe("legacy identity batching", () => {
  test.each([499, 500, 501, 35_770])(
    "prefetch and row ledger batching stay bounded at %i rows",
    async (count) => {
      const prefetchQueries: Array<{ sql: string; vars: Record<string, unknown> }> = [];
      const prefetchDb = {
        query: async (sql: string, vars: Record<string, unknown>) => {
          prefetchQueries.push({ sql, vars });
          return [[], []];
        },
      } as unknown as Surreal;
      const backend = migrationBackend(prefetchDb);
      const requests = identityRequests(count);
      const prefetched = await backend.prefetchIdentities(requests, identityRun);
      const expectedBatches = Math.ceil(count / LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
      expect(prefetchQueries).toHaveLength(expectedBatches);
      expect(prefetchQueries.every(({ sql, vars }) =>
        sql.includes("FROM $mappingIds") &&
        !sql.includes("legacy_id IN") &&
        (vars.mappingIds as RecordId[]).length <= LEGACY_IDENTITY_PREFETCH_BATCH_SIZE
      )).toBe(true);
      expect(prefetched.existing.size).toBe(0);

      let mutationSql = "";
      let mutationVars: Record<string, unknown> = {};
      const mutationDb = {
        query: async (sql: string, vars: Record<string, unknown>) => {
          mutationSql = sql;
          mutationVars = vars;
          return [true];
        },
      } as unknown as Surreal;
      await migrationBackend(mutationDb).commitIdentityBatch(
        identityRun,
        identityCommits(count),
        undefined,
        prefetched,
      );
      expect(mutationSql.match(/INSERT INTO legacy_identity_map/g)?.length ?? 0)
        .toBe(expectedBatches);
      expect(mutationSql.match(/INSERT INTO migration_row_commit/g)?.length ?? 0)
        .toBe(expectedBatches);
      expect(mutationSql.match(/record::exists\(\$target\)/g)?.length ?? 0)
        .toBe(expectedBatches);
      expect(mutationSql.match(/mapping appeared during atomic commit/g)?.length ?? 0)
        .toBe(expectedBatches);
      expect(mutationSql).not.toContain("UPDATE migration_quarantine");
      expect(mutationSql).not.toContain("UPSERT ONLY");
      for (let batch = 0; batch < expectedBatches; batch++) {
        expect((mutationVars[`mappingRows${batch}`] as unknown[]).length)
          .toBeLessThanOrEqual(LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
        expect((mutationVars[`ledgerRows${batch}`] as unknown[]).length)
          .toBeLessThanOrEqual(LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
        expect((mutationVars[`targetChecks${batch}`] as unknown[]).length)
          .toBeLessThanOrEqual(LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
      }
    },
    30_000,
  );

  test("prefetch validates malformed, duplicate and unrequested mapping rows", async () => {
    const request = identityRequests(2);
    const duplicateBackend = migrationBackend({ query: async () => [[], []] } as unknown as Surreal);
    await expect(duplicateBackend.prefetchIdentities([request[0]!, request[0]!], identityRun))
      .rejects.toThrow("request is duplicate");

    const malformedBackend = migrationBackend({
      query: async (_sql: string, vars: Record<string, unknown>) => [[{
        id: (vars.mappingIds as RecordId[])[0],
        legacy_table: "messages",
        legacy_id: "1",
        target: "not-a-record",
      }], []],
    } as unknown as Surreal);
    await expect(malformedBackend.prefetchIdentities([request[0]!], identityRun))
      .rejects.toThrow("invalid fields");

    const duplicateRowsBackend = migrationBackend({
      query: async (_sql: string, vars: Record<string, unknown>) => {
        const row = {
          id: (vars.mappingIds as RecordId[])[0],
          legacy_table: "messages",
          legacy_id: "1",
          target: new RecordId("message", "one"),
        };
        return [[row, row], []];
      },
    } as unknown as Surreal);
    await expect(duplicateRowsBackend.prefetchIdentities(request, identityRun))
      .rejects.toThrow("duplicate ownership");

    const unrequestedBackend = migrationBackend({
      query: async (_sql: string, vars: Record<string, unknown>) => [[{
        id: (vars.mappingIds as RecordId[])[0],
        legacy_table: "messages",
        legacy_id: "other",
        target: new RecordId("message", "one"),
      }], []],
    } as unknown as Surreal);
    await expect(unrequestedBackend.prefetchIdentities([request[0]!], identityRun))
      .rejects.toThrow("unrequested or mismatched");
  });

  test("missing mappings bulk-insert, existing mappings stay immutable, conflict fails before mutation", async () => {
    const requests = identityRequests(2);
    const mappingOne = new RecordId("legacy_identity_map", "one");
    const existingTarget = new RecordId("message", "canonical_1");
    const prefetch: LegacyIdentityPrefetch = {
      requestedKeys: new Set(requests.map((row) =>
        legacyIdentityPrefetchKey(row.table, row.legacyId)
      )),
      existing: new Map([[
        legacyIdentityPrefetchKey("messages", "1"),
        { mapping: mappingOne, target: existingTarget },
      ]]),
      unresolvedQuarantines: new Map(),
    };
    let sql = "";
    let vars: Record<string, unknown> = {};
    const db = {
      query: async (query: string, queryVars: Record<string, unknown>) => {
        sql = query;
        vars = queryVars;
        return [true];
      },
    } as unknown as Surreal;
    const commits = identityCommits(2);
    commits[0]!.category = "matched";
    await migrationBackend(db).commitIdentityBatch(identityRun, commits, undefined, prefetch);
    expect((vars.mappingRows0 as unknown[])).toHaveLength(1);
    expect(sql).toContain("INSERT INTO legacy_identity_map");
    expect(sql).toContain("legacy identity mapping changed during atomic commit");
    expect((vars.existingChecks0 as unknown[])).toHaveLength(1);

    let mutationCalls = 0;
    const conflicting = structuredClone(prefetch) as LegacyIdentityPrefetch;
    (conflicting.existing as Map<string, { mapping: RecordId; target: RecordId }>).set(
      legacyIdentityPrefetchKey("messages", "1"),
      { mapping: mappingOne, target: new RecordId("message", "different") },
    );
    const conflictDb = {
      query: async () => {
        mutationCalls += 1;
        return [true];
      },
    } as unknown as Surreal;
    await expect(migrationBackend(conflictDb).commitIdentityBatch(
      identityRun,
      commits,
      undefined,
      conflicting,
    )).rejects.toThrow("legacy identity conflict messages:1");
    expect(mutationCalls).toBe(0);
  });

  test("only prefetched unresolved quarantine IDs produce resolution updates", async () => {
    const requests = identityRequests(2);
    const prefetch = emptyIdentityPrefetch(requests);
    const key = legacyIdentityPrefetchKey("messages", "2");
    (prefetch.unresolvedQuarantines as Map<string, RecordId[]>).set(key, [
      new RecordId("migration_quarantine", "prior"),
    ]);
    let sql = "";
    const db = {
      query: async (query: string) => {
        sql = query;
        return [true];
      },
    } as unknown as Surreal;
    await migrationBackend(db).commitIdentityBatch(
      identityRun,
      identityCommits(2),
      undefined,
      prefetch,
    );
    expect(sql.match(/FOR \$item IN \$quarantineUpdates/g)?.length).toBe(1);
    expect(sql).not.toContain("WHERE legacy_table");
  });

  test("35,770 exact quarantine resolutions stay O(batches) and bounded to 500", async () => {
    const count = 35_770;
    const requests = identityRequests(count);
    const prefetched = emptyIdentityPrefetch(requests);
    for (const request of requests) {
      (prefetched.unresolvedQuarantines as Map<string, RecordId[]>).set(
        legacyIdentityPrefetchKey(request.table, request.legacyId),
        [new RecordId("migration_quarantine", `prior_${request.legacyId}`)],
      );
    }
    let sql = "";
    let vars: Record<string, unknown> = {};
    const db = {
      query: async (query: string, queryVars: Record<string, unknown>) => {
        sql = query;
        vars = queryVars;
        return [true];
      },
    } as unknown as Surreal;
    await migrationBackend(db).commitIdentityBatch(
      identityRun,
      identityCommits(count),
      undefined,
      prefetched,
    );
    const expectedBatches = Math.ceil(count / LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
    expect(sql.match(/FOR \$item IN \$quarantineUpdates/g)?.length ?? 0)
      .toBe(expectedBatches);
    expect(sql).not.toContain("WHERE legacy_table");
    const quarantineVars = Object.entries(vars)
      .filter(([key]) => key.startsWith("quarantineUpdates"));
    expect(quarantineVars).toHaveLength(expectedBatches);
    expect(quarantineVars.every(([, value]) =>
      Array.isArray(value) && value.length <= LEGACY_IDENTITY_PREFETCH_BATCH_SIZE
    )).toBe(true);
  }, 30_000);

  test("a failed bulk mutation is surfaced as one atomic query failure", async () => {
    const requests = identityRequests(501);
    let calls = 0;
    let observedSql = "";
    const db = {
      query: async (sql: string) => {
        calls += 1;
        observedSql = sql;
        throw new Error("injected bulk failure");
      },
    } as unknown as Surreal;
    await expect(migrationBackend(db).commitIdentityBatch(
      identityRun,
      identityCommits(501),
      undefined,
      emptyIdentityPrefetch(requests),
    )).rejects.toThrow("injected bulk failure");
    expect(calls).toBe(1);
    expect(observedSql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(observedSql).toContain("COMMIT;");
    expect(observedSql.match(/INSERT INTO migration_row_commit/g)?.length).toBe(2);
  });
});

interface MigrationFixture {
  snapshotPath: string;
  snapshotSha256: string;
  snapshotSizeBytes: number;
  authorization: MigrationRunAuthorization;
  approvedHostMappings: ApprovedLegacyHostMapping[];
  approvalTrustAnchor: {
    ed25519PublicKeyPem: string;
    sha256Fingerprint: string;
  };
  safetyContext: {
    schemaVersion: number;
    sourceNamespace: string;
    sourceDatabase: string;
    restoreNamespace: string;
    archiveRoot: string;
  };
}

async function migrationFixture(options: {
  emptyMessages?: boolean;
  threadCount?: number;
  nullLinkThreadId?: number;
  liveThreadIds?: number[];
  malformedNormalized?: "pointer" | "sha" | "bytes";
  brokenProvenance?: "record_source" | "message_source" | "chunk_source";
} = {}): Promise<MigrationFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "baka-migration-run-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "snapshot.sqlite");
  const db = new Database(dbPath, { create: true });
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
  db.run(`INSERT INTO agent_systems VALUES (1, 'claude-code', 'Claude Code', 'file_tree')`);
  db.run(`INSERT INTO projects VALUES (1, 1, 'p1', 'Project', '/Users/test/p1')`);

  const threadCount = options.threadCount ?? (options.emptyMessages ? 1 : 3);
  for (let id = 1; id <= threadCount; id++) {
    const deleted = id === 1 ? "deleted_in_source" : "active";
    db.run(
      `INSERT INTO source_files VALUES (?, 1, ?, '/Users/test/.claude', ?, ?, 10, 1, ?, 'head', ?)`,
      [
        id,
        `/Users/test/.claude/t${id}.jsonl`,
        `t${id}.jsonl`,
        deleted,
        `sha-${id}`,
        id === 1 ? "2026-01-01T00:00:00Z" : null,
      ],
    );
    if (!options.emptyMessages && id <= 2) {
      db.run(`INSERT INTO raw_backups VALUES (?, ?, ?, ?, 10, 'active')`, [
        id,
        id,
        `/readonly/raw-${id}.jsonl`,
        `sha-${id}`,
      ]);
    }
    db.run(`INSERT INTO threads VALUES (?, 1, 1, ?, ?, NULL, NULL)`, [id, `t${id}`, `Thread ${id}`]);
    const payload = JSON.stringify({
      message: {
        model: "claude-test",
        usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 2 },
      },
      payload: { content: [{ text: `payload-${id}` }] },
    });
    db.run(`INSERT INTO thread_records VALUES (?, ?, ?, 0, 'event', NULL, ?)`, [
      id,
      id,
      options.nullLinkThreadId === id ? null : id,
      payload,
    ]);
    if (!options.emptyMessages) {
      db.run(`INSERT INTO messages VALUES (?, ?, ?, NULL, 0, ?, NULL)`, [
        id,
        id,
        id,
        id === 3 ? "assistant" : "user",
      ]);
      const content = `payload-${id}`;
      const contentPath = options.malformedNormalized === "pointer" && id === 3
        ? "/payload/missing"
        : "/payload/content/0/text";
      const contentSha = options.malformedNormalized === "sha" && id === 3
        ? "0".repeat(64)
        : sha256hex(content);
      const contentBytes = options.malformedNormalized === "bytes" && id === 3
        ? Buffer.byteLength(content, "utf8") + 1
        : Buffer.byteLength(content, "utf8");
      db.run(
        `INSERT INTO message_chunks VALUES (?, ?, ?, 0, ?, ?, '/payload/content/0', ?, ?)`,
        [
          id,
          id,
          id,
          id === 3 ? "output_text" : "input_text",
          contentPath,
          contentSha,
          contentBytes,
        ],
      );
    }
  }
  if (options.brokenProvenance === "record_source") {
    db.run("UPDATE thread_records SET source_file_id = 999 WHERE id = 1");
  } else if (options.brokenProvenance === "message_source") {
    db.run("UPDATE messages SET source_record_id = 999 WHERE id = 1");
  } else if (options.brokenProvenance === "chunk_source") {
    db.run("UPDATE message_chunks SET source_record_id = 999 WHERE id = 1");
  }
  db.close();
  const hashes = await hashFile(dbPath);
  const snapshotPath = path.join(dir, `index__${hashes.sha256}.sqlite`);
  await rename(dbPath, snapshotPath);
  const identity = {
    hostUuid: "test-host",
    hostname: "test-host",
    platform: "darwin",
    arch: "arm64",
    osUsername: "test",
    homePath: "/Users/test",
  };
  const approvedHostMappings: ApprovedLegacyHostMapping[] = [{
    mappingId: "test-host",
    host: identity,
    pathPrefixes: ["/Users/test"],
    threadIds: Array.from({ length: threadCount }, (_, index) => index + 1),
  }];
  const hostMapping = buildLegacyHostMappingApproval(snapshotPath, hashes.sha256, approvedHostMappings);
  const live: LiveCorpusProbe = {
    available: true,
    note: "synthetic live corpus",
    revisionSha256: new Set(),
    dialogueKeys: new Set(
      (options.liveThreadIds ?? (options.emptyMessages ? [] : [2, 3]))
        .map((id) => `claude-code:t${id}`),
    ),
  };
  const report = await buildPreflightReport({
    snapshotPath,
    snapshotSha256: hashes.sha256,
    identity,
    live,
    checkRawFiles: false,
  });
  const approvedAt = new Date(Date.now() - 3_000).toISOString();
  const approval = buildMigrationPreflightApproval({
    report,
    snapshotSizeBytes: hashes.sizeBytes,
    checkRawFiles: false,
    liveProbe: live,
    hostMappingArtifactSha256: hostMapping.artifactSha256,
    approvedBy: "migration-test",
    approvedAt,
  });
  const approvalPath = path.join(dir, "operator-approval.json");
  await writeMigrationPreflightApprovalArtifact(approvalPath, approval);
  const approvalFileHash = await hashFile(approvalPath);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const keyFingerprint = migrationApprovalKeyFingerprint(publicKeyPem);
  const issuedAt = new Date(Date.parse(approvedAt) + 500).toISOString();
  const attestationPayload = {
    approvalFileSha256: approvalFileHash.sha256,
    approvalArtifactSha256: approval.artifactSha256,
    hostMappingArtifactSha256: hostMapping.artifactSha256,
    snapshotSha256: hashes.sha256,
    snapshotSizeBytes: hashes.sizeBytes,
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
  const backupCreatedAt = new Date(Date.parse(issuedAt) + 500).toISOString();
  const restoreStartedAt = new Date(Date.parse(backupCreatedAt) + 500).toISOString();
  const restoreFinishedAt = new Date(Date.parse(restoreStartedAt) + 100).toISOString();
  const restoreCreatedAt = new Date(Date.parse(restoreFinishedAt) + 100).toISOString();
  const backupDir = path.join(dir, "backups", "surreal");
  const manifestDir = path.join(dir, "backups", "manifests");
  await mkdir(backupDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  const exportFile = "migration-safety.surql.gz";
  const backupPath = path.join(backupDir, exportFile);
  await writeFile(backupPath, "synthetic logical export\n");
  const backup = await hashFile(backupPath);
  const manifestPath = path.join(manifestDir, "migration-safety.json");
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
  const restorePath = path.join(manifestDir, "restore-evidence.json");
  const attemptId = "a".repeat(32);
  const restoreNamespace = `baka_restore_test_${attemptId}`;
  await writeFile(restorePath, `${JSON.stringify({
    formatVersion: 5,
    ok: true,
    attemptId,
    startedAt: restoreStartedAt,
    finishedAt: restoreFinishedAt,
    createdAt: restoreCreatedAt,
    runId: "migration-test-run",
    namespace: restoreNamespace,
    database: "archive",
    archiveRoot: dir,
    rawArchiveRoot: dir,
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
  const authorization: MigrationRunAuthorization = {
    approval,
    approvalFile: {
      path: approvalPath,
      sha256: approvalFileHash.sha256,
      sizeBytes: approvalFileHash.sizeBytes,
      createdAt: approvedAt,
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
        ok: true,
      },
    },
  };
  return {
    snapshotPath,
    snapshotSha256: hashes.sha256,
    snapshotSizeBytes: hashes.sizeBytes,
    authorization,
    approvedHostMappings,
    approvalTrustAnchor: {
      ed25519PublicKeyPem: publicKeyPem,
      sha256Fingerprint: keyFingerprint,
    },
    safetyContext: {
      schemaVersion: 5,
      sourceNamespace: "baka",
      sourceDatabase: "archive",
      restoreNamespace,
      archiveRoot: dir,
    },
  };
}

async function rewriteAuthenticatedSafetyEnvironment(
  fixture: MigrationFixture,
  input: { namespace?: string; database?: string; reportDatabase?: string },
): Promise<void> {
  const manifestPath = manifestPathForExport(fixture.authorization.safety.backup.path);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  if (input.namespace !== undefined) manifest.namespace = input.namespace;
  if (input.database !== undefined) manifest.database = input.database;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const manifestHash = await hashFile(manifestPath);
  const restorePath = fixture.authorization.safety.restore.path;
  const restore = JSON.parse(await readFile(restorePath, "utf8")) as Record<string, unknown>;
  restore.manifestSha256 = manifestHash.sha256;
  if (input.reportDatabase !== undefined) restore.database = input.reportDatabase;
  await writeFile(restorePath, `${JSON.stringify(restore)}\n`);
  const restoreHash = await hashFile(restorePath);
  fixture.authorization.safety.restore.sha256 = restoreHash.sha256;
  fixture.authorization.safety.restore.sizeBytes = restoreHash.sizeBytes;
}

interface QuarantineState {
  run: number;
  table: LegacyTable;
  id: string;
  resolved: boolean;
  retryable: boolean;
  parserVersion?: number;
  parserName?: string;
  attempts: number;
  reason: string;
}

class MemoryBackend implements LegacyMigrationBackend {
  private runNo = 0;
  readonly mappings = new Map<string, RecordId>();
  readonly targets = new Set<string>();
  readonly quarantines: QuarantineState[] = [];
  readonly reports: MigrationRunReport[] = [];
  readonly written = new Map<string, ParsedDialogue>();
  readonly presences = new Map<number, string>([[1, "active"]]);
  readonly replayThreads: number[] = [];
  startCalls = 0;
  failThreadBind = 0;
  failMark = 0;
  failSource = 0;

  async startRun(_input: MigrationRunInput): Promise<MigrationRunHandle> {
    this.startCalls += 1;
    const id = ++this.runNo;
    return {
      syncRunId: new RecordId("sync_run", `run_${id}`),
      migrationId: new RecordId("migration_meta", `migration_${id}`),
    };
  }

  async finishRun(
    _run: MigrationRunHandle,
    _status: "completed" | "completed_with_errors" | "failed",
    report: MigrationRunReport,
  ): Promise<void> {
    this.reports.push(report);
  }

  async lookupIdentity(table: LegacyTable, legacyId: string): Promise<RecordId | undefined> {
    return this.mappings.get(`${table}:${legacyId}`);
  }

  async lookupIdentities(table: LegacyTable, legacyIds: string[]): Promise<Map<string, RecordId>> {
    return new Map(
      legacyIds.flatMap((legacyId) => {
        const target = this.mappings.get(`${table}:${legacyId}`);
        return target ? [[legacyId, target] as const] : [];
      }),
    );
  }

  async bindIdentity(table: LegacyTable, legacyId: string, target: RecordId): Promise<void> {
    if (table === "threads" && this.failThreadBind > 0) {
      this.failThreadBind -= 1;
      throw new Error("fault: thread bind");
    }
    const key = `${table}:${legacyId}`;
    const existing = this.mappings.get(key);
    if (existing && String(existing) !== String(target)) throw new Error("mapping conflict");
    this.mappings.set(key, target);
  }

  async completeIdentity(table: LegacyTable, legacyId: string, target: RecordId): Promise<void> {
    const mapped = this.mappings.get(`${table}:${legacyId}`);
    if (!mapped || String(mapped) !== String(target)) throw new Error("mapping incomplete");
    for (const quarantine of this.quarantines) {
      if (quarantine.table === table && quarantine.id === legacyId) quarantine.resolved = true;
    }
  }

  async bindIdentities(
    table: LegacyTable,
    rows: Array<{ legacyId: string; target: RecordId }>,
  ): Promise<void> {
    for (const row of rows) await this.bindIdentity(table, row.legacyId, row.target);
  }

  hostAttributionReport() {
    return { approvedMappings: [], actualAssignments: [], uncertainty: [] };
  }

  async quarantine(run: MigrationRunHandle, input: QuarantineInput): Promise<void> {
    this.quarantines.push({
      run: Number(String(run.migrationId.id).split("_").at(-1)),
      table: input.table,
      id: String(input.row.id),
      resolved: false,
      retryable: input.retryable,
      parserVersion: input.parserVersion,
      parserName: input.parserName,
      attempts: (this.quarantines.filter(
        (row) => row.table === input.table && row.id === String(input.row.id),
      ).at(-1)?.attempts ?? 0) + 1,
      reason: input.reason,
    });
  }

  private result<T>(table: string, id: number | string, value: T): EnsureTarget<T> {
    const target = new RecordId(table, String(id));
    const key = String(target);
    const created = !this.targets.has(key);
    this.targets.add(key);
    return { target, created, value };
  }

  async ensureAgent(row: LegacyAgentRow): Promise<EnsureTarget<AgentTarget>> {
    const harnessId = new RecordId("harness", row.slug);
    return this.result("harness", row.slug, { harnessId, slug: "claude-code" });
  }

  async ensureProject(row: LegacyProjectRow, _agent: AgentTarget): Promise<EnsureTarget<ProjectTarget>> {
    const workspaceId = new RecordId("workspace", `legacy_${row.id}`);
    return this.result("workspace", `legacy_${row.id}`, { workspaceId });
  }

  async ensureSourceFile(row: LegacySourceFileRow, agent: AgentTarget): Promise<EnsureTarget<SourceTarget>> {
    if (this.failSource > 0) {
      this.failSource -= 1;
      throw new Error("fault: source import");
    }
    const locationId = new RecordId("source_location", `legacy_${row.id}`);
    // presence row = уже существующая live location, даже если migration
    // backend ещё не создавал target в этом тестовом процессе.
    const created = !this.presences.has(row.id) && !this.targets.has(String(locationId));
    const value: SourceTarget = {
      row,
      locationId,
      sourceRootId: new RecordId("source_root", "legacy"),
      hostId: new RecordId("host", "current"),
      osAccountId: new RecordId("os_account", "current"),
      installationId: new RecordId("harness_installation", "claude-current"),
      agentSlug: agent.slug,
      created,
      previousPresence: this.presences.get(row.id),
      hostMappingId: "test-host",
      legacyOnlyLocation: true,
    };
    this.targets.add(String(locationId));
    return { target: locationId, created, value };
  }

  async importRawBackup(
    _run: MigrationRunHandle,
    row: LegacyRawBackupRow,
    source: SourceTarget,
  ): Promise<EnsureTarget<RevisionTarget>> {
    const revisionId = new RecordId("source_revision", `raw_${row.id}`);
    const result = this.result("source_revision", `raw_${row.id}`, {
      revisionId,
      sha256: source.row.sha256,
      rawPath: `raw:${row.source_file_id}`,
      created: !this.targets.has(String(revisionId)),
    });
    result.value.created = result.created;
    return result;
  }

  async ensureMissingRawRevision(
    _run: MigrationRunHandle,
    source: SourceTarget,
  ): Promise<RevisionTarget> {
    const id = new RecordId("source_revision", `missing_${source.row.id}`);
    const created = !this.targets.has(String(id));
    this.targets.add(String(id));
    return { revisionId: id, sha256: source.row.sha256, created };
  }

  async finalizeSourceFile(source: SourceTarget, revision: RevisionTarget): Promise<void> {
    source.selectedRevision = revision;
    this.presences.set(
      source.row.id,
      source.row.status === "deleted_in_source" ? "deleted_in_source" : "active",
    );
  }

  async createReplayRevision(
    _run: MigrationRunHandle,
    thread: LegacyThreadRow,
    _records: LegacyThreadRecordRow[],
    _agent: AgentTarget,
    _preferredSource: SourceTarget | undefined,
    content: string,
  ): Promise<RevisionTarget> {
    this.replayThreads.push(thread.id);
    const revisionId = new RecordId("source_revision", `payload_${thread.id}`);
    const created = !this.targets.has(String(revisionId));
    this.targets.add(String(revisionId));
    return { revisionId, sha256: sha256hex(content), rawPath: `payload:${thread.id}`, created };
  }

  async threadIdentityContext(
    _agent: AgentTarget,
    preferredSource: SourceTarget | undefined,
  ): Promise<{ installationId: RecordId; hostId: RecordId; osAccountId?: RecordId }> {
    return {
      installationId: preferredSource?.installationId ?? new RecordId("harness_installation", "claude-current"),
      hostId: preferredSource?.hostId ?? new RecordId("host", "current"),
      osAccountId: preferredSource?.osAccountId,
    };
  }

  async writeDialogue(input: DialogueWriteInput): Promise<DialogueTarget> {
    this.written.set(input.thread.external_id, input.parsed);
    const dialogueId = new RecordId("dialogue", input.thread.external_id);
    const revisionId = new RecordId(
      "dialogue_revision",
      `${input.thread.external_id}_${input.parserName}_${input.sourceRevision.revisionId.id}`,
    );
    const matchingLive = input.canonicalImportPolicy === "match_existing";
    const createdDialogue = !matchingLive && !this.targets.has(String(dialogueId));
    const createdRevision = !matchingLive && !this.targets.has(String(revisionId));
    this.targets.add(String(dialogueId));
    this.targets.add(String(revisionId));
    return { dialogueId, revisionId, createdDialogue, createdRevision };
  }

  async preflightDialogueDedup(input: DialogueDedupInput): Promise<RecordId | undefined> {
    return input.authoritativeDialogueId;
  }

  async rollbackDialogueAttempt(
    thread: LegacyThreadRow,
    dialogue: DialogueTarget | undefined,
    sourceRevision: RevisionTarget,
    removeThreadMapping: boolean,
  ): Promise<void> {
    if (dialogue?.createdRevision) {
      this.targets.delete(String(dialogue.revisionId));
      this.written.delete(thread.external_id);
    }
    if (dialogue?.createdDialogue) this.targets.delete(String(dialogue.dialogueId));
    if (removeThreadMapping) this.mappings.delete(`threads:${thread.id}`);
    if (sourceRevision.created && sourceRevision.rawPath?.startsWith("payload:")) {
      this.targets.delete(String(sourceRevision.revisionId));
      const index = this.replayThreads.indexOf(thread.id);
      if (index >= 0) this.replayThreads.splice(index, 1);
    }
  }

  async markRevisionParsed(_revision: RevisionTarget): Promise<void> {
    if (this.failMark > 0) {
      this.failMark -= 1;
      throw new Error("fault: thread mark");
    }
  }
}

function resignApproval(approval: MigrationPreflightApproval): void {
  approval.evidenceSha256 = migrationArtifactSha256(approval.evidence);
  const { artifactSha256: _ignored, ...body } = approval;
  approval.artifactSha256 = migrationArtifactSha256(body);
}

describe("Stage 10 migration runner", () => {
  test("first 100 threads emit a bounded checkpoint and abort before thread 101 when slow", async () => {
    const snapshot = await migrationFixture({ threadCount: 101 });
    const backend = new MemoryBackend();
    const checkpoints: ReturnType<typeof legacyThreadSpeedCheckpoint>[] = [];
    let clockReads = 0;

    await expect(runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: async (input) => fixtureRecoveredDialogue(input.threadExternalId),
      monotonicNow: () => clockReads++ === 0
        ? 0
        : LEGACY_THREAD_SPEED_MAX_ELAPSED_MS + 1,
      onThreadSpeedCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    })).rejects.toThrow("legacy thread speed gate exceeded");

    expect(checkpoints).toEqual([{
      processedThreads: 100,
      elapsedMs: LEGACY_THREAD_SPEED_MAX_ELAPSED_MS + 1,
      maxElapsedMs: LEGACY_THREAD_SPEED_MAX_ELAPSED_MS,
      withinLimit: false,
    }]);
    expect(backend.reports.at(-1)?.status).toBe("failed");
    expect(backend.mappings.has("threads:101")).toBe(false);
  });

  test("first-100 speed threshold accepts exactly ten minutes", () => {
    expect(legacyThreadSpeedCheckpoint(LEGACY_THREAD_SPEED_MAX_ELAPSED_MS))
      .toMatchObject({ processedThreads: 100, withinLimit: true });
    expect(legacyThreadSpeedCheckpoint(LEGACY_THREAD_SPEED_MAX_ELAPSED_MS + 0.001))
      .toMatchObject({ processedThreads: 100, withinLimit: false });
    expect(() => legacyThreadSpeedCheckpoint(Number.NaN)).toThrow("elapsed time is invalid");
  });

  test("a corpus of exactly 100 terminal threads still emits the checkpoint", async () => {
    const snapshot = await migrationFixture({ threadCount: 100 });
    const checkpoints: ReturnType<typeof legacyThreadSpeedCheckpoint>[] = [];
    let clockReads = 0;
    const report = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: new MemoryBackend(),
      recoverSnapshot: async (input) => fixtureRecoveredDialogue(input.threadExternalId),
      monotonicNow: () => clockReads++ === 0 ? 0 : 1_000,
      onThreadSpeedCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    expect(report.reconciliation.lost).toBe(0);
    expect(checkpoints).toEqual([{
      processedThreads: 100,
      elapsedMs: 1_000,
      maxElapsedMs: LEGACY_THREAD_SPEED_MAX_ELAPSED_MS,
      withinLimit: true,
    }]);
  });

  test("recovery priority raw → payload → normalized, durable report и идемпотентный rerun", async () => {
    const snapshot = await migrationFixture();
    const backend = new MemoryBackend();
    const calls: string[] = [];
    const recover = async (input: SnapshotRecoveryInput): Promise<ParsedDialogue | undefined> => {
      const id = input.threadExternalId;
      calls.push(`${id}:${input.source}`);
      if (id === "t1" && input.source === "raw") return fixtureRecoveredDialogue(id);
      if (id === "t2" && input.source === "payload") return fixtureRecoveredDialogue(id);
      return undefined;
    };
    const reportPath = path.join(path.dirname(snapshot.snapshotPath), "migration-report.json");
    const first = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: recover,
      reportPath,
    });
    expect(calls).toEqual(["t1:raw", "t2:raw", "t2:payload", "t3:payload"]);
    expect(first.recovery).toEqual({ raw: 1, payload: 1, normalized: 1 });
    const normalized = backend.written.get("t3")!.messages[0]!;
    expect(normalized.model).toMatchObject({
      rawModelName: "claude-test",
      vendor: "anthropic",
      canonicalName: "claude-test",
    });
    expect(normalized.usageEvents[0]).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 2,
    });
    expect(first.reconciliation).toMatchObject({
      legacyTotal: 19,
      inserted: 12,
      matched: 7,
      quarantined: 0,
      lost: 0,
      ok: true,
    });
    const persisted = JSON.parse(await readFile(reportPath, "utf8")) as MigrationRunReport;
    expect(persisted.reconciliation).toEqual(first.reconciliation);
    expect(persisted.status).toBe("completed");
    // Memory backend моделирует отдельную legacy-only location.
    expect(backend.presences.get(1)).toBe("deleted_in_source");

    calls.length = 0;
    const second = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: recover,
      reportPath: path.join(path.dirname(snapshot.snapshotPath), "migration-report-2.json"),
    });
    expect(second.reconciliation).toMatchObject({
      legacyTotal: 19,
      inserted: 0,
      matched: 19,
      quarantined: 0,
      lost: 0,
      ok: true,
    });
    expect(backend.mappings.size).toBe(19);
  });

  test("quarantine retry: новый run импортирует row и закрывает прежнюю retryable запись", async () => {
    const snapshot = await migrationFixture({ emptyMessages: true });
    const backend = new MemoryBackend();
    const first = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: async () => undefined,
    });
    expect(first.status).toBe("completed_with_errors");
    expect(first.reconciliation).toMatchObject({
      legacyTotal: 5,
      quarantined: 1,
      lost: 0,
      ok: true,
    });
    expect(backend.quarantines.every((row) => row.retryable && !row.resolved)).toBe(true);

    const second = await retryLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: async (input) =>
        input.source === "payload" ? dialogue(input.threadExternalId, "recovered") : undefined,
    });
    expect(second.status).toBe("completed");
    expect(second.reconciliation).toMatchObject({ quarantined: 0, lost: 0, ok: true });
    expect(backend.quarantines.every((row) => row.resolved)).toBe(true);
    expect(backend.quarantines.every((row) => row.parserName && row.parserVersion)).toBe(true);
  });

  test("canonical admission imports only deleted live-missing threads and accounts active misses", async () => {
    const snapshot = await migrationFixture({ liveThreadIds: [] });
    const backend = new MemoryBackend();
    const report = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: async (input) => fixtureRecoveredDialogue(input.threadExternalId),
    });
    expect([...backend.written.keys()]).toEqual(["t1"]);
    expect(report.reconciliation.tables.threads).toMatchObject({
      inserted: 1,
      matched: 0,
      quarantined: 2,
      accounted: 3,
      lost: 0,
    });
    expect(report.reconciliation.tables.thread_records).toMatchObject({
      inserted: 3,
      quarantined: 0,
      accounted: 3,
      lost: 0,
    });
    expect(report.reconciliation.lost).toBe(0);
    expect(backend.quarantines.filter((row) =>
      row.table === "threads" && row.reason.includes("canonical import denied")
    ).map((row) => row.id)).toEqual(["2", "3"]);
    expect(backend.quarantines.filter((row) =>
      row.reason.includes("canonical import denied")
    ).every((row) => row.parserName === "claude-code" && row.parserVersion === 2)).toBe(true);
  });

  test("null source_file_id запрещает raw recovery для всего thread", async () => {
    const snapshot = await migrationFixture({
      nullLinkThreadId: 1,
      liveThreadIds: [1, 2, 3],
    });
    const backend = new MemoryBackend();
    const calls: string[] = [];
    const report = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: async (input) => {
        calls.push(`${input.threadExternalId}:${input.source}`);
        return fixtureRecoveredDialogue(input.threadExternalId);
      },
    });
    expect(calls).not.toContain("t1:raw");
    expect(calls).toContain("t1:payload");
    expect(report.recovery.payload).toBeGreaterThanOrEqual(1);
  });

  test("non-null thread_record without exact source target never binds to replay revision", async () => {
    const snapshot = await migrationFixture({ emptyMessages: true });
    const backend = new MemoryBackend();
    backend.failSource = 1;
    const report = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot: async (input) =>
        input.source === "payload" ? dialogue(input.threadExternalId, "recovered") : undefined,
    });
    expect(report.status).toBe("completed_with_errors");
    expect(report.reconciliation.tables.thread_records).toMatchObject({
      matched: 0,
      inserted: 0,
      quarantined: 1,
      lost: 0,
    });
    expect(backend.mappings.has("thread_records:1")).toBe(false);
    expect(backend.quarantines.some((row) =>
      row.table === "thread_records" &&
      row.reason.includes("no exact source_revision ownership evidence")
    )).toBe(true);
    expect(backend.replayThreads).toEqual([]);
  });

  test.each(["pointer", "sha", "bytes"] as const)(
    "normalized fallback quarantines malformed %s instead of empty content",
    async (malformedNormalized) => {
      const snapshot = await migrationFixture({ malformedNormalized });
      const backend = new MemoryBackend();
      const report = await runLegacyMigration({
        ...snapshot,
        bakaCommit: "test",
        schemaVersion: 5,
        backend,
        recoverSnapshot: async () => undefined,
      });
      expect(report.status).toBe("completed_with_errors");
      expect(backend.written.has("t3")).toBe(false);
      expect(backend.replayThreads).not.toContain(3);
      expect(
        backend.quarantines.some(
          (row) => row.table === "threads" && row.id === "3" && row.reason.includes("content"),
        ),
      ).toBe(true);
    },
  );

  test("thread bind/mark faults keep quarantine unresolved until whole-row retry succeeds", async () => {
    const snapshot = await migrationFixture({ emptyMessages: true });
    const backend = new MemoryBackend();
    backend.failThreadBind = 1;
    backend.failMark = 1;
    const recoverSnapshot = async (input: SnapshotRecoveryInput) =>
      dialogue(input.threadExternalId, input.source);

    const first = await runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot,
    });
    expect(first.status).toBe("completed_with_errors");
    const firstThreadQuarantine = backend.quarantines.find(
      (row) => row.table === "threads" && row.id === "1",
    );
    expect(firstThreadQuarantine?.resolved).toBe(false);
    expect(backend.written.has("t1")).toBe(false);
    expect(backend.replayThreads).not.toContain(1);

    const second = await retryLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot,
    });
    expect(second.status).toBe("completed_with_errors");
    const threadAttempts = backend.quarantines.filter(
      (row) => row.table === "threads" && row.id === "1",
    );
    expect(threadAttempts.map((row) => row.attempts)).toEqual([1, 2]);
    expect(threadAttempts.every((row) => !row.resolved)).toBe(true);
    expect(backend.written.has("t1")).toBe(false);
    expect(backend.replayThreads).not.toContain(1);

    const third = await retryLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
      recoverSnapshot,
    });
    expect(third.status).toBe("completed");
    expect(threadAttempts.every((row) => row.resolved)).toBe(true);
    expect(backend.targets.size).toBeGreaterThan(0);
  });

  test("approved host mapping keeps same username/path on two hosts distinct and fails closed", () => {
    const common = {
      hostname: "same",
      platform: "darwin",
      arch: "arm64",
      osUsername: "other-example",
      homePath: "/Users/other-example",
    };
    const mappings = [
      { mappingId: "host-a", host: { ...common, hostUuid: "host-a" }, sourceFileIds: [1], pathPrefixes: ["/Users/other-example"] },
      { mappingId: "host-b", host: { ...common, hostUuid: "host-b" }, sourceFileIds: [2], pathPrefixes: ["/Users/other-example"] },
    ];
    expect(resolveApprovedHostMapping(mappings, "source_files", 1, "/Users/other-example/same.jsonl").mappingId).toBe("host-a");
    expect(resolveApprovedHostMapping(mappings, "source_files", 2, "/Users/other-example/same.jsonl").mappingId).toBe("host-b");
    expect(() => resolveApprovedHostMapping(mappings, "source_files", 3, "/Users/other-example/same.jsonl"))
      .toThrow("host mapping ambiguous");
    expect(() => resolveApprovedHostMapping([], "threads", 9)).toThrow("host mapping missing");
  });

  test("runner independently rejects caller hash mismatch and tampered content-addressed snapshot", async () => {
    const clean = await migrationFixture();
    const backend = new MemoryBackend();
    await expect(runLegacyMigration({
      ...clean,
      snapshotSha256: "0".repeat(64),
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
    })).rejects.toThrow("SHA mismatch");
    expect(backend.reports).toHaveLength(0);

    await appendFile(clean.snapshotPath, "tamper");
    await expect(runLegacyMigration({
      ...clean,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
    })).rejects.toThrow("content-addressed");
    expect(backend.reports).toHaveLength(0);
  });

  test("approval totals/problems/live, safety hashes and report no-clobber fail before backend start", async () => {
    const totals = await migrationFixture();
    const approvalPath = path.join(path.dirname(totals.snapshotPath), "operator-approval-copy.json");
    await writeMigrationPreflightApprovalArtifact(approvalPath, totals.authorization.approval);
    expect((await readMigrationPreflightApprovalArtifact(approvalPath)).artifactSha256)
      .toBe(totals.authorization.approval.artifactSha256);
    await expect(writeMigrationPreflightApprovalArtifact(
      approvalPath,
      totals.authorization.approval,
    )).rejects.toThrow("не будет перезаписан");
    const totalsBackend = new MemoryBackend();
    const staleTotals = structuredClone(totals.authorization);
    staleTotals.approval.evidence.tableTotals.threads += 1;
    resignApproval(staleTotals.approval);
    staleTotals.externalApprovalDigest = staleTotals.approval.artifactSha256;
    await expect(runLegacyMigration({
      ...totals,
      authorization: staleTotals,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: totalsBackend,
    })).rejects.toThrow("differs from exact signed approval file");
    expect(totalsBackend.startCalls).toBe(0);

    const problems = await migrationFixture();
    const problemsBackend = new MemoryBackend();
    const truncated = structuredClone(problems.authorization);
    truncated.approval.evidence.problems.pop();
    resignApproval(truncated.approval);
    truncated.externalApprovalDigest = truncated.approval.artifactSha256;
    await expect(runLegacyMigration({
      ...problems,
      authorization: truncated,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: problemsBackend,
    })).rejects.toThrow("differs from exact signed approval file");
    expect(problemsBackend.startCalls).toBe(0);

    const live = await migrationFixture();
    const liveBackend = new MemoryBackend();
    live.authorization.currentLiveProbe.dialogueKeys.add("claude-code:stale");
    await expect(runLegacyMigration({
      ...live,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: liveBackend,
    })).rejects.toThrow("live-probe evidence stale");
    expect(liveBackend.startCalls).toBe(0);

    const safety = await migrationFixture();
    const safetyBackend = new MemoryBackend();
    await appendFile(safety.authorization.safety.backup.path, "tamper");
    await expect(runLegacyMigration({
      ...safety,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: safetyBackend,
    })).rejects.toThrow("backup export artifact hash/size mismatch");
    expect(safetyBackend.startCalls).toBe(0);

    const noClobber = await migrationFixture();
    const noClobberBackend = new MemoryBackend();
    const reportPath = path.join(path.dirname(noClobber.snapshotPath), "already-there.json");
    await writeFile(reportPath, "do not overwrite\n");
    await expect(runLegacyMigration({
      ...noClobber,
      reportPath,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: noClobberBackend,
    })).rejects.toThrow("no-clobber");
    expect(await readFile(reportPath, "utf8")).toBe("do not overwrite\n");
    expect(noClobberBackend.startCalls).toBe(0);
  });

  test("approvedBy/self-hash не заменяет detached Ed25519 attestation/trust anchor", async () => {
    const snapshot = await migrationFixture();
    const backend = new MemoryBackend();
    delete snapshot.authorization.attestation;
    await expect(runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
    })).rejects.toThrow("detached signed");
    expect(backend.startCalls).toBe(0);

    const forged = await migrationFixture();
    const forgedBackend = new MemoryBackend();
    forged.authorization.attestation!.payload.observedDeletedCount += 1;
    await expect(runLegacyMigration({
      ...forged,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: forgedBackend,
    })).rejects.toThrow("not bound to exact approved evidence");
    expect(forgedBackend.startCalls).toBe(0);

    const wrongTrust = await migrationFixture();
    const wrongTrustBackend = new MemoryBackend();
    const wrongKey = generateKeyPairSync("ed25519").publicKey
      .export({ format: "pem", type: "spki" }).toString();
    wrongTrust.approvalTrustAnchor = {
      ed25519PublicKeyPem: wrongKey,
      sha256Fingerprint: migrationApprovalKeyFingerprint(wrongKey),
    };
    await expect(runLegacyMigration({
      ...wrongTrust,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: wrongTrustBackend,
    })).rejects.toThrow("signer does not match trusted key fingerprint");
    expect(wrongTrustBackend.startCalls).toBe(0);
  });

  test("semantic safety rejects forged ok:true and mismatched backup bindings", async () => {
    const forged = await migrationFixture();
    const forgedBackend = new MemoryBackend();
    await writeFile(forged.authorization.safety.restore.path, `${JSON.stringify({ ok: true })}\n`);
    const forgedHash = await hashFile(forged.authorization.safety.restore.path);
    forged.authorization.safety.restore.sha256 = forgedHash.sha256;
    forged.authorization.safety.restore.sizeBytes = forgedHash.sizeBytes;
    await expect(runLegacyMigration({
      ...forged,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: forgedBackend,
    })).rejects.toThrow("exact fields mismatch");
    expect(forgedBackend.startCalls).toBe(0);

    const mismatched = await migrationFixture();
    const mismatchedBackend = new MemoryBackend();
    const restore = JSON.parse(
      await readFile(mismatched.authorization.safety.restore.path, "utf8"),
    ) as Record<string, unknown>;
    restore.exportSha256 = "0".repeat(64);
    await writeFile(
      mismatched.authorization.safety.restore.path,
      `${JSON.stringify(restore)}\n`,
    );
    const mismatchHash = await hashFile(mismatched.authorization.safety.restore.path);
    mismatched.authorization.safety.restore.sha256 = mismatchHash.sha256;
    mismatched.authorization.safety.restore.sizeBytes = mismatchHash.sizeBytes;
    await expect(runLegacyMigration({
      ...mismatched,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: mismatchedBackend,
    })).rejects.toThrow("exact authenticated backup");
    expect(mismatchedBackend.startCalls).toBe(0);

    const incompleteCleanup = await migrationFixture();
    const cleanupBackend = new MemoryBackend();
    const cleanupReport = JSON.parse(
      await readFile(incompleteCleanup.authorization.safety.restore.path, "utf8"),
    ) as { cleanup: { namespaceRemoved: boolean } };
    cleanupReport.cleanup.namespaceRemoved = false;
    await writeFile(
      incompleteCleanup.authorization.safety.restore.path,
      `${JSON.stringify(cleanupReport)}\n`,
    );
    const cleanupHash = await hashFile(incompleteCleanup.authorization.safety.restore.path);
    incompleteCleanup.authorization.safety.restore.sha256 = cleanupHash.sha256;
    incompleteCleanup.authorization.safety.restore.sizeBytes = cleanupHash.sizeBytes;
    await expect(runLegacyMigration({
      ...incompleteCleanup,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: cleanupBackend,
    })).rejects.toThrow("cleanup is incomplete");
    expect(cleanupBackend.startCalls).toBe(0);

    const wrongRuntime = await migrationFixture();
    const runtimeBackend = new MemoryBackend();
    wrongRuntime.safetyContext = {
      ...wrongRuntime.safetyContext!,
      restoreNamespace: `baka_restore_test_${"0".repeat(32)}`,
    };
    await expect(runLegacyMigration({
      ...wrongRuntime,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: runtimeBackend,
    })).rejects.toThrow("runtime binding mismatch");
    expect(runtimeBackend.startCalls).toBe(0);
  });

  test("safety source namespace/database come only from independent runtime context", async () => {
    const valid = await migrationFixture();
    const validBackend = new MemoryBackend();
    await expect(runLegacyMigration({
      ...valid,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: validBackend,
    })).resolves.toMatchObject({ status: "completed" });
    expect(validBackend.startCalls).toBe(1);

    for (const attack of [
      { namespace: "other_ns" },
      { database: "other_db", reportDatabase: "other_db" },
    ]) {
      const forged = await migrationFixture();
      const backend = new MemoryBackend();
      await rewriteAuthenticatedSafetyEnvironment(forged, attack);
      await expect(runLegacyMigration({
        ...forged,
        bakaCommit: "test",
        schemaVersion: 5,
        backend,
      })).rejects.toThrow("source namespace/database runtime binding mismatch");
      expect(backend.startCalls).toBe(0);
    }

    const wrongReportDatabase = await migrationFixture();
    const wrongReportBackend = new MemoryBackend();
    await rewriteAuthenticatedSafetyEnvironment(wrongReportDatabase, {
      reportDatabase: "other_db",
    });
    await expect(runLegacyMigration({
      ...wrongReportDatabase,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: wrongReportBackend,
    })).rejects.toThrow("runtime binding mismatch");
    expect(wrongReportBackend.startCalls).toBe(0);

    const swappedManifest = await migrationFixture();
    const swappedBackend = new MemoryBackend();
    const restorePath = swappedManifest.authorization.safety.restore.path;
    const restore = JSON.parse(await readFile(restorePath, "utf8")) as Record<string, unknown>;
    restore.manifestPath = path.join(path.dirname(restorePath), "other.json");
    restore.manifestFile = "other.json";
    restore.manifestSha256 = "f".repeat(64);
    await writeFile(restorePath, `${JSON.stringify(restore)}\n`);
    const swappedHash = await hashFile(restorePath);
    swappedManifest.authorization.safety.restore.sha256 = swappedHash.sha256;
    swappedManifest.authorization.safety.restore.sizeBytes = swappedHash.sizeBytes;
    await expect(runLegacyMigration({
      ...swappedManifest,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: swappedBackend,
    })).rejects.toThrow(/path binding|authenticated backup/);
    expect(swappedBackend.startCalls).toBe(0);

    for (const wrongContext of [
      { sourceNamespace: "wrong_cfg_ns" },
      { sourceDatabase: "wrong_cfg_db" },
    ]) {
      const wrongCfg = await migrationFixture();
      const backend = new MemoryBackend();
      wrongCfg.safetyContext = { ...wrongCfg.safetyContext, ...wrongContext };
      await expect(runLegacyMigration({
        ...wrongCfg,
        bakaCommit: "test",
        schemaVersion: 5,
        backend,
      })).rejects.toThrow("source namespace/database runtime binding mismatch");
      expect(backend.startCalls).toBe(0);
    }
  });

  test("detached signature rejects a re-signed assignment/approval map", async () => {
    const snapshot = await migrationFixture();
    const backend = new MemoryBackend();
    const assignment = snapshot.authorization.hostMapping.assignments[0]!;
    assignment.basis = assignment.basis === "explicit" ? "path" : "explicit";
    const { artifactSha256: _oldMappingSha, ...mappingBody } = snapshot.authorization.hostMapping;
    snapshot.authorization.hostMapping.artifactSha256 = migrationArtifactSha256(mappingBody);
    snapshot.authorization.approval.evidence.hostMappingArtifactSha256 =
      snapshot.authorization.hostMapping.artifactSha256;
    resignApproval(snapshot.authorization.approval);
    snapshot.authorization.externalApprovalDigest = snapshot.authorization.approval.artifactSha256;
    await expect(runLegacyMigration({
      ...snapshot,
      bakaCommit: "test",
      schemaVersion: 5,
      backend,
    })).rejects.toThrow("signed approval file");
    expect(backend.startCalls).toBe(0);
  });

  test("report publication is atomic no-clobber under concurrent publishers", async () => {
    const snapshot = await migrationFixture();
    const basePath = path.join(path.dirname(snapshot.snapshotPath), "base-report.json");
    const base = await runLegacyMigration({
      ...snapshot,
      reportPath: basePath,
      bakaCommit: "test",
      schemaVersion: 5,
      backend: new MemoryBackend(),
      recoverSnapshot: async (input) => dialogue(input.threadExternalId, "atomic"),
    });
    const finalPath = path.join(path.dirname(snapshot.snapshotPath), "concurrent-report.json");
    const reports = [
      { ...base, reportPath: finalPath, error: "publisher-a" },
      { ...base, reportPath: finalPath, error: "publisher-b" },
    ];
    const results = await Promise.allSettled(
      reports.map((report) => writeMigrationRunReport(finalPath, report)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const published = JSON.parse(await readFile(finalPath, "utf8")) as MigrationRunReport;
    expect(["publisher-a", "publisher-b"]).toContain(published.error!);
    expect((await readdir(path.dirname(finalPath))).some((name) => name.endsWith(".part"))).toBe(false);
  });

  test.each(["record_source", "message_source", "chunk_source"] as const)(
    "broken provenance %s quarantines exact rows before replay/corpus",
    async (brokenProvenance) => {
      const snapshot = await migrationFixture({ brokenProvenance });
      const backend = new MemoryBackend();
      const report = await runLegacyMigration({
        ...snapshot,
        bakaCommit: "test",
        schemaVersion: 5,
        backend,
        recoverSnapshot: async (input) => dialogue(input.threadExternalId, "must not replay broken row"),
      });
      expect(report.reconciliation.lost).toBe(0);
      expect(report.reconciliation.tables.threads.quarantined).toBe(1);
      expect(backend.replayThreads).not.toContain(1);
      const table = brokenProvenance === "record_source"
        ? "thread_records"
        : brokenProvenance === "message_source"
          ? "messages"
          : "message_chunks";
      expect(backend.quarantines.some((row) =>
        row.table === table && row.id === "1" && row.reason.includes("999"))).toBe(true);
    },
  );

  test("deleted guard и schema 0005 фиксируют live-risk + legacy_missing_raw NONE", async () => {
    expect(shouldApplyLegacyDeleted(true, undefined)).toBe(true);
    expect(shouldApplyLegacyDeleted(false, "deleted_in_source")).toBe(true);
    expect(shouldApplyLegacyDeleted(false, "active")).toBe(false);
    expect(shouldApplyLegacyDeleted(false, "missing")).toBe(false);
    expect(shouldAttachRepairedRaw(undefined, "raw/claude/f.jsonl")).toBe(true);
    expect(shouldAttachRepairedRaw("raw/old.jsonl", "raw/new.jsonl")).toBe(false);
    expect(shouldAttachRepairedRaw(undefined, undefined)).toBe(false);
    const schema = await readFile(
      path.join(import.meta.dir, "..", "schema", "0005_legacy_migration_run.surql"),
      "utf8",
    );
    expect(schema).toContain("raw_archive_path ON TABLE source_revision TYPE option<string>");
    expect(schema).toContain("DEFINE TABLE IF NOT EXISTS migration_quarantine SCHEMAFULL");
    expect(schema).toContain("retryable ON TABLE migration_quarantine TYPE bool");
    expect(schema).toContain("DEFINE TABLE IF NOT EXISTS migration_row_commit SCHEMAFULL");
    expect(schema).toContain("created_by_run ON TABLE dialogue_revision");
    expect(schema).not.toContain("last_migration ON TABLE legacy_identity_map");
    expect(schema).toContain("migration_restore_namespace_unique");
  });

  test("Surreal split dialogue/mark APIs fail closed outside atomic commitDialogueRow", async () => {
    const fakeDb = {
      query: async () => [[]],
    } as unknown as Surreal;
    const backend = new SurrealLegacyMigrationBackend(fakeDb, "/archive", {
      hostUuid: "h",
      hostname: "host",
      platform: "test",
      arch: "test",
      osUsername: "u",
      homePath: "/Users/u",
    });
    const revision = {
      revisionId: new RecordId("source_revision", "same"),
      sha256: "a".repeat(64),
      created: false,
    };
    await expect(backend.markRevisionParsed(revision)).rejects.toThrow("commitDialogueRow");
    await expect(backend.writeDialogue({} as DialogueWriteInput)).rejects.toThrow("commitDialogueRow");
  });

  test("concrete retry resolver обновляет historical quarantine, не удаляет его", async () => {
    const sql: string[] = [];
    let bound = false;
    const fakeDb = {
      query: async (query: string, vars?: Record<string, unknown>) => {
        sql.push(query);
        if (query.includes("FROM $mappingIds")) {
          return [bound ? [{
            id: (vars?.mappingIds as RecordId[])[0],
            legacy_table: "threads",
            legacy_id: "7",
            target: new RecordId("dialogue", "d7"),
          }] : [], query.includes("migration_quarantine") && bound ? [{
            id: new RecordId("migration_quarantine", "prior"),
            legacy_table: "threads",
            legacy_id: "7",
          }] : []];
        }
        if (query.includes("FROM ONLY $id")) {
          return [bound ? [{
            id: vars?.id,
            legacy_table: "threads",
            legacy_id: "7",
            target: new RecordId("dialogue", "d7"),
          }] : []];
        }
        if (query.includes("CREATE ONLY $id0")) {
          bound = true;
          return [[], [], true];
        }
        if (query.includes("UPDATE $ids")) return [true];
        if (query.includes("SELECT legacy_id FROM migration_quarantine")) {
          return [[{ legacy_id: "7" }]];
        }
        return [[]];
      },
    } as unknown as Surreal;
    const backend = new SurrealLegacyMigrationBackend(fakeDb, "/archive", {
      hostUuid: "h",
      hostname: "host",
      platform: "test",
      arch: "test",
      osUsername: "u",
      homePath: "/Users/u",
    });
    (backend as unknown as { currentRun: MigrationRunHandle }).currentRun = {
      syncRunId: new RecordId("sync_run", "new"),
      migrationId: new RecordId("migration_meta", "new"),
    };
    await backend.bindIdentity("threads", "7", new RecordId("dialogue", "d7"));
    await backend.completeIdentity("threads", "7", new RecordId("dialogue", "d7"));
    const resolution = sql.find((query) => query.includes("UPDATE $ids"));
    expect(resolution).toContain("resolved_at = $now");
    expect(resolution).not.toContain("WHERE legacy_table");
    expect(sql.some((query) => query.includes("DELETE migration_quarantine"))).toBe(false);
  });
});
