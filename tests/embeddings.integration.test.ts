/**
 * Integration-тесты embedding pipeline (этап 7, docs/plan.md §13, §14) на
 * живом SurrealDB (namespace baka_test) с mock provider — живой OpenAI не
 * нужен: provider abstraction (src/embeddings/provider.ts).
 *
 * Покрытые обязательные сценарии §19.2:
 * - №22: stuck embedding job возвращается в pending после lease timeout;
 * - №23: vector неправильной dimension отклоняется;
 * - №24: ANN query использует HNSW (EXPLAIN FULL → operator "KnnScan").
 * Плюс: space:create/activate, backfill, идемпотентность run, retry/backoff,
 * vector/hybrid search, деградация (§14), приватность (§13.7), каскадное
 * удаление vectors при смене projection (§8.1), rebuild stale jobs (§13.5).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { ParsedDialogue, ParsedMessage } from "../src/domain/canonical-types.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
  ensureModel,
  ensureOsAccount,
  ensureVendor,
  ensureWorkspace,
} from "../src/db/repositories/identity.ts";
import {
  createSyncRun,
  ensureSourceLocation,
  ensureSourceRevision,
  ensureSourceRoot,
} from "../src/db/repositories/provenance.ts";
import { writeDialogueRevision, type DialogueTxInput } from "../src/db/repositories/corpus.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import { dialogueIdentityKey } from "../src/domain/identity.ts";
import { kimiCodeExtractors } from "../src/search/extractors/kimi-code.ts";
import type { SearchFilters } from "../src/search/fulltext.ts";
import {
  dedupByMessage,
  rrfFuse,
  searchHybrid,
  searchVector,
  VectorSearchUnavailable,
} from "../src/search/hybrid.ts";
import { EmbeddingProviderError } from "../src/embeddings/provider.ts";
import { MockEmbeddingProvider, mockVector } from "../src/embeddings/mock-provider.ts";
import { EMPTY_PRIVACY_POLICY } from "../src/embeddings/privacy.ts";
import {
  activateSpace,
  createSpace,
  getActiveSpace,
  physicalTableName,
  type EmbeddingSpace,
} from "../src/embeddings/spaces.ts";
import {
  embeddingsPlan,
  embeddingsStatus,
  rebuildStaleJobs,
  retryFailedJobs,
  runEmbeddingWorker,
  LEASE_TIMEOUT_MS,
  type WorkerSummary,
} from "../src/embeddings/jobs.ts";
import { createTestDb, dropTestDb, isDbAvailable, type TestDb } from "./db-test-utils.ts";

let dbReady = false;
beforeAll(async () => {
  dbReady = await isDbAvailable();
});

const SPACE_SLUG = "mock_test_16_v1";
const DIMS = 16;
const PROMPT_A = "любимый рецепт яблочного пирога с корицей";
const PROMPT_B = "настройка hnsw индексов в surrealdb";

function makeMessage(sequence: number, overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    sequence,
    role: "user",
    humanAuthored: true,
    visibleToUser: true,
    timestamp: new Date("2026-07-20T10:00:00Z"),
    usageEvents: [],
    chunks: [],
    metadata: {},
    ...overrides,
  };
}

function dialogue(externalId: string, prompt: string, answer: string): ParsedDialogue {
  return {
    externalId,
    title: `Диалог ${externalId}`,
    workspace: { path: "/tmp/project", name: "project" },
    startedAt: new Date("2026-07-20T10:00:00Z"),
    updatedAt: new Date("2026-07-20T10:05:00Z"),
    messages: [
      makeMessage(0, {
        metadata: { origin: { kind: "user" } },
        chunks: [{ sequence: 0, kind: "text", content: prompt, metadata: {} }],
      }),
      makeMessage(1, {
        role: "assistant",
        humanAuthored: false,
        timestamp: new Date("2026-07-20T10:01:00Z"),
        model: { rawModelName: "kimi-code/k3", vendor: "moonshot", canonicalName: "k3" },
        chunks: [{ sequence: 0, kind: "text", content: answer, metadata: {} }],
      }),
    ],
    metadata: {},
  };
}

interface Ctx {
  host: RecordId;
  osAccount: RecordId;
  installation: RecordId;
  sourceRevision: RecordId;
  modelIds: Map<string, RecordId>;
  workspace: RecordId;
}

async function makeCtx(t: TestDb): Promise<Ctx> {
  const host = await ensureHost(t.db, {
    hostUuid: "host-uuid-emb",
    hostname: "emb-host",
    platform: "darwin",
    arch: "arm64",
  });
  const osAccount = await ensureOsAccount(t.db, { host, osUsername: "example", homePath: "/Users/example" });
  const harness = await ensureHarness(t.db, {
    slug: "kimi-code",
    displayName: "Kimi Code",
    kind: "file_tree",
  });
  const installation = await ensureHarnessInstallation(t.db, { host, harness, installed: true });
  const syncRun = await createSyncRun(t.db, {
    kind: "live_sync",
    host,
    bakaCommit: "test",
    schemaVersion: 4,
  });
  const root = await ensureSourceRoot(t.db, {
    harnessInstallation: installation,
    path: "/tmp/sessions",
    sourceKind: "file_tree",
    parserName: "kimi-code",
    snapshotStrategy: "copy",
    enabled: true,
  });
  const location = await ensureSourceLocation(t.db, {
    sourceRoot: root,
    relativePath: "wd_x/session_e/agents/main/wire.jsonl",
    originalPath: "/tmp/sessions/wd_x/session_e/agents/main/wire.jsonl",
    basename: "wire.jsonl",
  });
  const sourceRevision = await ensureSourceRevision(t.db, {
    sourceLocation: location.id,
    sha256: "c".repeat(64),
    sizeBytes: 100,
    mtimeMs: 1000,
    rawArchivePath: "raw/kimi-code/wire__ccc.jsonl",
    snapshotKind: "regular_copy",
    parserName: "kimi-code",
    parserVersion: 1,
    syncRun,
  });
  const vendor = await ensureVendor(t.db, "moonshot");
  const model = await ensureModel(t.db, { vendor, canonicalName: "k3", rawName: "kimi-code/k3" });
  const workspace = await ensureWorkspace(t.db, { host, path: "/tmp/project", name: "project" });
  if (!workspace) throw new Error("ensureWorkspace вернул undefined");
  return {
    host,
    osAccount,
    installation,
    sourceRevision: sourceRevision.id,
    modelIds: new Map([["moonshot/k3", model]]),
    workspace,
  };
}

function txInput(
  ctx: Ctx,
  parsed: ParsedDialogue,
  identityKey: string,
  overrides: Partial<DialogueTxInput> = {},
): DialogueTxInput {
  return {
    identityKey,
    harnessInstallation: ctx.installation,
    osAccount: ctx.osAccount,
    workspace: ctx.workspace,
    sourceRevision: ctx.sourceRevision,
    sourceDialogueId: parsed.externalId ?? "fallback",
    parserName: "kimi-code",
    parserVersion: 1,
    parsed,
    extractors: kimiCodeExtractors,
    modelIds: ctx.modelIds,
    activeEmbeddingSpaces: [],
    enqueueEmbeddings: true,
    ...overrides,
  };
}

/** Записать оба диалога (A и B) в свежую БД. */
async function seed(t: TestDb, overrides: Partial<DialogueTxInput> = {}) {
  const ctx = await makeCtx(t);
  const keyA = dialogueIdentityKey(ctx.installation.toString(), "emb_a", "fb");
  const keyB = dialogueIdentityKey(ctx.installation.toString(), "emb_b", "fb");
  const a = await writeDialogueRevision(
    t.db,
    txInput(ctx, dialogue("emb_a", PROMPT_A, "Вот подробный рецепт пирога."), keyA, overrides),
  );
  const b = await writeDialogueRevision(
    t.db,
    txInput(ctx, dialogue("emb_b", PROMPT_B, "Индексы настраиваются так."), keyB, overrides),
  );
  return { ctx, a, b };
}

async function makeSpace(t: TestDb, activate = false): Promise<EmbeddingSpace> {
  const result = await createSpace(t.db, {
    slug: SPACE_SLUG,
    provider: "mock",
    model: "mock-embedding",
    dimensions: DIMS,
    activate,
  });
  return result.space;
}

function mockFactory(provider: MockEmbeddingProvider) {
  return () => provider;
}

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { limit: 20, ...overrides };
}

interface JobRow {
  id: RecordId;
  status: string;
  attempts: number;
  next_attempt_at?: Date;
  input_sha256: string;
}

const allJobs = (t: TestDb) => selectAll<JobRow>(t.db, "SELECT * FROM embedding_job");
const vectorCount = async (t: TestDb): Promise<number> =>
  (await selectOne<{ n: number }>(t.db, `SELECT count() AS n FROM ${physicalTableName(SPACE_SLUG)} GROUP ALL`))?.n ?? 0;

describe("embedding spaces (integration)", () => {
  test("space:create создаёт таблицу + HNSW-индекс и backfill jobs; activate — один active", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      const docCount = (await selectAll(t.db, "SELECT id FROM search_document")).length;
      expect(docCount).toBeGreaterThan(0);

      const result = await createSpace(t.db, {
        slug: SPACE_SLUG,
        provider: "mock",
        model: "mock-embedding",
        dimensions: DIMS,
      });
      expect(result.space.physical_table).toBe(physicalTableName(SPACE_SLUG));
      expect(result.backfilledJobs).toBe(docCount);

      // Физическая таблица и HNSW-индекс существуют.
      const info = await t.db.query(`INFO FOR TABLE ${physicalTableName(SPACE_SLUG)}`);
      const definition = JSON.stringify(info);
      expect(definition).toContain("vector_hnsw");
      expect(definition).toContain("HNSW");
      expect(definition).toContain(`DIMENSION ${DIMS}`);

      // Повторный backfill не дублирует jobs.
      const again = await createSpace(t.db, {
        slug: "mock_test_16_v2",
        provider: "mock",
        model: "mock-embedding",
        dimensions: DIMS,
      });
      expect(again.backfilledJobs).toBe(docCount);
      const jobs = await allJobs(t);
      expect(jobs).toHaveLength(docCount * 2);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["pending"]));

      // Один active на момент; старый space не уничтожается.
      await activateSpace(t.db, SPACE_SLUG);
      expect((await getActiveSpace(t.db))?.slug).toBe(SPACE_SLUG);
      await activateSpace(t.db, "mock_test_16_v2");
      const active = await getActiveSpace(t.db);
      expect(active?.slug).toBe("mock_test_16_v2");
      const actives = await selectAll(t.db, "SELECT id FROM embedding_space WHERE active = true");
      expect(actives).toHaveLength(1);
    } finally {
      await dropTestDb(t);
    }
  });
});

describe("embedding worker (integration)", () => {
  test("run завершает jobs и пишет векторы; повторный run идемпотентен", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      const summary = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(summary.completed).toBe(4);
      expect(summary.permanentErrors).toBe(0);
      expect(await vectorCount(t)).toBe(4);
      const jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["completed"]));

      // Vector соответствует content hash и space (инвариант §23.11).
      const vectors = await selectAll<{ input_sha256: string; vector: number[]; prompt_tokens: number }>(
        t.db,
        `SELECT input_sha256, vector, prompt_tokens FROM ${physicalTableName(SPACE_SLUG)}`,
      );
      const docs = await selectAll<{ content_sha256: string }>(
        t.db,
        "SELECT content_sha256 FROM search_document",
      );
      expect(new Set(vectors.map((v) => v.input_sha256))).toEqual(
        new Set(docs.map((d) => d.content_sha256)),
      );
      expect(vectors.every((v) => v.vector.length === DIMS && v.prompt_tokens > 0)).toBe(true);

      // Повторный run: нечего брать — ничего не меняется.
      const again = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(again.completed).toBe(0);
      expect(await vectorCount(t)).toBe(4);
    } finally {
      await dropTestDb(t);
    }
  });

  test("wrong dimension отклоняется: permanent_error, vector не пишется (№23)", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({
        dimensions: DIMS,
        model: "mock-embedding",
        dimensionOverride: DIMS + 1,
      });
      const summary = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(summary.completed).toBe(0);
      expect(summary.permanentErrors).toBe(4);
      expect(await vectorCount(t)).toBe(0);
      const jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["permanent_error"]));
    } finally {
      await dropTestDb(t);
    }
  });

  test("stuck job возвращается в pending после lease timeout (№22)", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const [job] = await allJobs(t);
      const staleLock = new Date(Date.now() - LEASE_TIMEOUT_MS - 1000);
      await t.db.query(
        `UPDATE ONLY $id SET status = "processing", locked_by = "dead-worker", locked_at = $at`,
        { id: job!.id, at: staleLock },
      );
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      const summary = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(summary.releasedStale).toBe(1);
      expect(summary.completed).toBe(4);
      expect(await vectorCount(t)).toBe(4);
    } finally {
      await dropTestDb(t);
    }
  });

  test("retryable ошибка → retryable_error с backoff; retry → pending; успех", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({
        dimensions: DIMS,
        model: "mock-embedding",
        failures: [new EmbeddingProviderError("rate limit", true)],
      });
      const failed = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(failed.failed).toBe(4);
      expect(failed.completed).toBe(0);
      let jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["retryable_error"]));
      expect(jobs.every((j) => j.attempts === 1 && j.next_attempt_at !== undefined)).toBe(true);
      // next_attempt_at в будущем — без retry worker их не берёт.
      const skipped = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(skipped.completed).toBe(0);

      expect(await retryFailedJobs(t.db)).toBe(4);
      const ok = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(ok.completed).toBe(4);
      jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["completed"]));
    } finally {
      await dropTestDb(t);
    }
  });

  test("permanent ошибка provider → permanent_error без backoff", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({
        dimensions: DIMS,
        model: "mock-embedding",
        failures: [new EmbeddingProviderError("bad request", false)],
      });
      const summary = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(summary.permanentErrors).toBe(4);
      const jobs = await allJobs(t);
      expect(jobs.every((j) => j.status === "permanent_error" && j.next_attempt_at === undefined)).toBe(true);
    } finally {
      await dropTestDb(t);
    }
  });

  test("приватность (§13.7): исключённый harness → cancelled, provider не вызывается", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      const summary = await runEmbeddingWorker(t.db, mockFactory(provider), {
        privacy: { ...EMPTY_PRIVACY_POLICY, excludeHarnesses: ["kimi-code"] },
      });
      expect(summary.privacyExcluded).toBe(4);
      expect(provider.calls).toBe(0);
      expect(await vectorCount(t)).toBe(0);
      const jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["cancelled"]));
    } finally {
      await dropTestDb(t);
    }
  });
});

describe("vector/hybrid search (integration)", () => {
  async function seededSpace(t: TestDb) {
    await seed(t);
    const space = await makeSpace(t, true);
    const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
    await runEmbeddingWorker(t.db, mockFactory(provider), { privacy: EMPTY_PRIVACY_POLICY });
    return { space, provider };
  }

  test("vector search находит ближайший документ по mock-векторам", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      const { provider } = await seededSpace(t);
      // Query = точный текст user prompt A → dist 0, первый результат — A.
      const hits = await searchVector(t.db, provider, PROMPT_A, filters());
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.dialogueTitle).toBe("Диалог emb_a");
      expect(hits[0]!.score).toBeCloseTo(1, 5);
      expect(hits[0]!.documentType).toBe("user_prompt");
      // Фильтры §14 применяются.
      expect(await searchVector(t.db, provider, PROMPT_A, filters({ harness: "codex" }))).toHaveLength(0);
      expect(
        (await searchVector(t.db, provider, PROMPT_A, filters({ documentType: "assistant_final" })))
          .every((h) => h.documentType === "assistant_final"),
      ).toBe(true);
    } finally {
      await dropTestDb(t);
    }
  });

  test("EXPLAIN FULL подтверждает HNSW (KnnScan, №24)", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seededSpace(t);
      const res = await t.db.query(
        `SELECT search_document FROM ${physicalTableName(SPACE_SLUG)}
         WHERE vector <|5, 200|> $q EXPLAIN FULL`,
        { q: mockVector("запрос", DIMS) },
      );
      const plan = JSON.stringify(res);
      expect(plan).toContain("KnnScan");
      expect(plan).toContain("vector_hnsw");
    } finally {
      await dropTestDb(t);
    }
  });

  test("hybrid выдаёт объединённый результат BM25 + vector", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      const { provider } = await seededSpace(t);
      const hits = await searchHybrid(t.db, provider, "яблочного пирога", filters());
      const titles = hits.map((h) => h.dialogueTitle);
      // A — через BM25 и vector, B — только через vector (BM25 его не находит).
      expect(titles).toContain("Диалог emb_a");
      expect(titles).toContain("Диалог emb_b");
      expect(titles[0]).toBe("Диалог emb_a");
    } finally {
      await dropTestDb(t);
    }
  });

  test("rrfFuse + dedupByMessage на реальных списках", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      const { provider } = await seededSpace(t);
      const vector = await searchVector(t.db, provider, PROMPT_A, filters({ limit: 50 }));
      const fused = dedupByMessage(rrfFuse([vector, vector]));
      expect(fused.length).toBe(vector.length);
      expect(fused[0]!.dialogueTitle).toBe("Диалог emb_a");
    } finally {
      await dropTestDb(t);
    }
  });

  test("деградация (§14): нет active space → VectorSearchUnavailable", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      await expect(searchVector(t.db, provider, PROMPT_A, filters())).rejects.toBeInstanceOf(
        VectorSearchUnavailable,
      );
      // Space есть, но не active — тоже недоступен.
      await makeSpace(t, false);
      await expect(searchVector(t.db, provider, PROMPT_A, filters())).rejects.toBeInstanceOf(
        VectorSearchUnavailable,
      );
    } finally {
      await dropTestDb(t);
    }
  });
});

describe("инвалидация projection и rebuild (integration)", () => {
  test("смена current revision удаляет vectors старых docs (§8.1)", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t);
      const key = dialogueIdentityKey(ctx.installation.toString(), "emb_a", "fb");
      const space = await makeSpace(t, true);
      const v1 = dialogue("emb_a", PROMPT_A, "Ответ первой версии.");
      await writeDialogueRevision(
        t.db,
        txInput(ctx, v1, key, {
          activeEmbeddingSpaces: [space.id],
          embeddingTables: [space.physical_table],
        }),
      );
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      await runEmbeddingWorker(t.db, mockFactory(provider), { privacy: EMPTY_PRIVACY_POLICY });
      expect(await vectorCount(t)).toBe(2);

      // Новое содержимое → новая revision → старая projection (+ vectors) удалена.
      const v2 = dialogue("emb_a", PROMPT_A, "Совершенно другой ответ второй версии.");
      v2.updatedAt = new Date("2026-07-20T11:00:00Z");
      const result = await writeDialogueRevision(
        t.db,
        txInput(ctx, v2, key, {
          activeEmbeddingSpaces: [space.id],
          embeddingTables: [space.physical_table],
        }),
      );
      expect(result.created).toBe(true);
      expect(await vectorCount(t)).toBe(0);
      const jobs = await allJobs(t);
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["pending"]));
    } finally {
      await dropTestDb(t);
    }
  });

  test("embeddings rebuild: stale jobs → pending, их vectors удалены (§13.5)", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      const space = await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      await runEmbeddingWorker(t.db, mockFactory(provider), { privacy: EMPTY_PRIVACY_POLICY });
      expect(await vectorCount(t)).toBe(4);

      // Имитация смены extraction/segmentation: hash одного doc изменился.
      const [doc] = await selectAll<{ id: RecordId }>(t.db, "SELECT id FROM search_document LIMIT 1");
      await t.db.query(`UPDATE ONLY $id SET content_sha256 = "newhash"`, { id: doc!.id });
      const summary = await rebuildStaleJobs(t.db, SPACE_SLUG);
      expect(summary.resetToPending).toBe(1);
      expect(summary.vectorsDeleted).toBe(1);
      expect(await vectorCount(t)).toBe(3);
      const jobs = await allJobs(t);
      expect(jobs.filter((j) => j.status === "pending")).toHaveLength(1);
      expect(jobs.filter((j) => j.status === "completed")).toHaveLength(3);
      expect(jobs.find((j) => j.status === "pending")!.input_sha256).toBe("newhash");

      // Повторный rebuild — нечего делать.
      const again = await rebuildStaleJobs(t.db, SPACE_SLUG);
      expect(again.resetToPending).toBe(0);
    } finally {
      await dropTestDb(t);
    }
  });

  test("embeddings plan/status: счётчики и storage-оценка", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const plan = await embeddingsPlan(t.db, {
        ...EMPTY_PRIVACY_POLICY,
        pricePer1MTokens: 0.13,
      });
      expect(plan.documents).toBe(4);
      expect(plan.segments).toBe(4);
      expect(plan.estimatedTokens).toBeGreaterThan(0);
      expect(plan.pendingJobs).toBe(4);
      expect(plan.spaces).toHaveLength(1);
      expect(plan.spaces[0]!.estimatedVectorBytes).toBe(4 * DIMS * 4);
      expect(plan.estimatedPriceUsd).toBeCloseTo((plan.estimatedTokens / 1_000_000) * 0.13, 10);

      const statuses = await embeddingsStatus(t.db);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]!.slug).toBe(SPACE_SLUG);
      expect(statuses[0]!.jobs).toEqual({ pending: 4 });
      expect(statuses[0]!.vectors).toBe(0);
    } finally {
      await dropTestDb(t);
    }
  });
});
