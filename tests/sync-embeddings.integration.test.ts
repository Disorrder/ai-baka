/**
 * Direct regression for docs/plan.md §19.2 scenario 21: embedding API
 * failures happen after structured sync and must not affect canonical data.
 * Uses a unique live-test database and a deterministic failing mock provider.
 */

import { afterAll, describe, expect } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecordId } from "surrealdb";
import type { AppConfig } from "../src/config.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import {
  runEmbeddingWorker,
  type OfflineMockWorkerOptions,
  type WorkerSummary,
} from "../src/embeddings/jobs.ts";
import { EMPTY_PRIVACY_POLICY } from "../src/embeddings/privacy.ts";
import { createSpace } from "../src/embeddings/spaces.ts";
import { runSync } from "../src/sync/sync-run.ts";
import {
  SURREAL_PASS,
  SURREAL_URL,
  SURREAL_USER,
  TEST_NAMESPACE,
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  type TestDb,
} from "./db-test-utils.ts";

const FIXTURE = path.resolve(
  import.meta.dir,
  "fixtures/kimi-code/basic/session_11111111-aaaa-4bbb-8ccc-111111111111",
);
const SESSION_ID = "session_11111111-aaaa-4bbb-8ccc-111111111111";
const SPACE_SLUG = "sync_failure_mock_8_v1";
const DIMENSIONS = 8;

// Explicit skip when the live test service is absent.
const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

interface SyncEnv {
  t: TestDb;
  cfg: AppConfig;
  archiveRoot: string;
  cleanup: () => Promise<void>;
}

async function makeSyncEnv(): Promise<SyncEnv> {
  const t = await createTestDb();
  const base = await mkdtemp(path.join(tmpdir(), "baka-sync-emb-test-"));
  const archiveRoot = path.join(base, "archive");
  const sourceRoot = path.join(base, "sessions");
  await mkdir(archiveRoot, { recursive: true });
  await cp(FIXTURE, path.join(sourceRoot, "wd_test", SESSION_ID), { recursive: true });

  return {
    t,
    archiveRoot,
    cfg: {
      archiveRoot,
      dbRoot: path.join(base, "db"),
      surrealUrl: SURREAL_URL,
      surrealUser: SURREAL_USER,
      surrealPass: SURREAL_PASS,
      surrealNamespace: TEST_NAMESPACE,
      surrealDatabase: t.name,
      minFreeBytes: 0,
      deletionConfirmations: 2,
      sourceOverrides: { "kimi-code": [sourceRoot] },
      embeddings: {
        excludeHarnesses: [],
        excludeWorkspaces: [],
        excludeDocumentTypes: [],
      },
    },
    cleanup: async () => {
      await dropTestDb(t);
      await rm(base, { recursive: true, force: true });
    },
  };
}

function syncOptions(env: SyncEnv) {
  return {
    harness: "kimi-code" as const,
    preflight: false,
    hostIdPath: path.join(env.archiveRoot, "host-id"),
    logger: () => {},
  };
}

async function tableCount(t: TestDb, table: string): Promise<number> {
  const row = await selectOne<{ n: number }>(t.db, `SELECT count() AS n FROM ${table} GROUP ALL`);
  return row?.n ?? 0;
}

interface DialogueRow {
  id: RecordId;
  current_revision: RecordId;
}

interface JobRow {
  id: RecordId;
  search_document: RecordId;
  embedding_space: RecordId;
  status: string;
  attempts: number;
  next_attempt_at?: Date;
  last_error?: string;
}

interface SyncRunRow {
  id: RecordId;
  status: string;
  started_at?: Date;
  finished_at?: Date;
}

async function canonicalState(t: TestDb) {
  const dialogue = await selectOne<DialogueRow>(
    t.db,
    "SELECT id, current_revision FROM dialogue WHERE external_id = $id",
    { id: SESSION_ID },
  );
  const documents = await selectAll<{ id: RecordId; dialogue_revision: RecordId }>(
    t.db,
    "SELECT id, dialogue_revision FROM search_document ORDER BY id",
  );
  return {
    currentRevision: String(dialogue?.current_revision),
    dialogueRevisions: await tableCount(t, "dialogue_revision"),
    messages: await tableCount(t, "message"),
    chunks: await tableCount(t, "chunk"),
    documents: documents.map((doc) => ({
      id: String(doc.id),
      dialogueRevision: String(doc.dialogue_revision),
    })),
  };
}

describe("structured sync + embedding worker isolation (integration)", () => {
  testDb("provider failure does not change successful sync/canonical state; later sync is independent (№21)", async () => {
    const env = await makeSyncEnv();
    try {
      const created = await createSpace(env.t.db, {
        slug: SPACE_SLUG,
        provider: "mock",
        model: "mock-embedding",
        dimensions: DIMENSIONS,
        activate: true,
      });
      expect(created.backfilledJobs).toBe(0);

      // Structured data and pending jobs commit together; no provider is
      // involved in the sync critical path.
      const first = await runSync(env.cfg, syncOptions(env));
      expect(first.status).toBe("completed");
      expect(first.syncRunId).toBeDefined();
      expect(first.counters.dialoguesWritten).toBe(1);

      const dialogue = await selectOne<DialogueRow>(
        env.t.db,
        "SELECT id, current_revision FROM dialogue WHERE external_id = $id",
        { id: SESSION_ID },
      );
      expect(dialogue).toBeDefined();

      const beforeFailure = await canonicalState(env.t);
      expect(beforeFailure.currentRevision).not.toBe("undefined");
      expect(beforeFailure.dialogueRevisions).toBe(1);
      expect(beforeFailure.messages).toBeGreaterThan(0);
      expect(beforeFailure.chunks).toBeGreaterThan(0);
      expect(beforeFailure.documents.length).toBeGreaterThan(0);
      expect(
        beforeFailure.documents.every(
          (document) => document.dialogueRevision === beforeFailure.currentRevision,
        ),
      ).toBe(true);

      let jobs = await selectAll<JobRow>(env.t.db, "SELECT * FROM embedding_job ORDER BY id");
      expect(jobs).toHaveLength(beforeFailure.documents.length);
      expect(first.counters.embeddingJobs).toBe(jobs.length);
      expect(
        jobs.every(
          (job) =>
            job.status === "pending" &&
            job.attempts === 0 &&
            String(job.embedding_space) === String(created.space.id) &&
            beforeFailure.documents.some((document) => document.id === String(job.search_document)),
        ),
      ).toBe(true);

      const firstRun = (
        await selectAll<SyncRunRow>(env.t.db, "SELECT id, status, finished_at FROM sync_run")
      ).find((run) => String(run.id) === first.syncRunId);
      expect(firstRun?.status).toBe("completed");
      expect(firstRun?.finished_at).toBeDefined();

      // A deterministic retryable failure from the library-owned, data-only
      // offline mock changes only embedding jobs. No provider/logger callback
      // crosses the public generic-worker boundary.
      const failureOptions = {
        spaceSlug: SPACE_SLUG,
        privacy: EMPTY_PRIVACY_POLICY,
        workerId: "sync-failure-regression-worker",
        failures: ["retryable"],
      } satisfies OfflineMockWorkerOptions;
      const failed: WorkerSummary = await runEmbeddingWorker(env.t.db, failureOptions);
      expect(failed.completed).toBe(0);
      expect(failed.failed).toBe(jobs.length);
      expect(failed.permanentErrors).toBe(0);

      jobs = await selectAll<JobRow>(env.t.db, "SELECT * FROM embedding_job ORDER BY id");
      expect(
        jobs.every(
          (job) =>
            job.status === "retryable_error" &&
            job.attempts === 1 &&
            job.next_attempt_at !== undefined &&
            job.last_error === "provider_retryable_error",
        ),
      ).toBe(true);
      expect(await canonicalState(env.t)).toEqual(beforeFailure);

      const firstRunAfterFailure = await selectOne<SyncRunRow>(
        env.t.db,
        "SELECT id, status, finished_at FROM ONLY $id",
        { id: firstRun!.id },
      );
      expect(firstRunAfterFailure?.status).toBe("completed");
      expect(firstRunAfterFailure?.finished_at).toEqual(firstRun!.finished_at);

      // A later identical sync is still a successful no-op and neither
      // duplicates jobs nor resets their independent retry state.
      const second = await runSync(env.cfg, syncOptions(env));
      expect(second.status).toBe("completed");
      expect(second.counters.filesNew).toBe(0);
      expect(second.counters.filesChanged).toBe(0);
      expect(second.counters.revisionsCreated).toBe(0);
      expect(second.counters.dialoguesWritten).toBe(0);
      expect(second.counters.embeddingJobs).toBe(0);
      expect(await canonicalState(env.t)).toEqual(beforeFailure);

      const jobsAfterSecondSync = await selectAll<JobRow>(
        env.t.db,
        "SELECT * FROM embedding_job ORDER BY id",
      );
      expect(jobsAfterSecondSync.map((job) => String(job.id))).toEqual(
        jobs.map((job) => String(job.id)),
      );
      expect(jobsAfterSecondSync.every((job) => job.status === "retryable_error")).toBe(true);
      expect(
        jobsAfterSecondSync.every((job) => job.last_error === "provider_retryable_error"),
      ).toBe(true);

      const runs = await selectAll<SyncRunRow>(
        env.t.db,
        "SELECT id, status, started_at, finished_at FROM sync_run ORDER BY started_at",
      );
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.status === "completed" && run.finished_at !== undefined)).toBe(
        true,
      );
    } finally {
      await env.cleanup();
    }
  });
});
