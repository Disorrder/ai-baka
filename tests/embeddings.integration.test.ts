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

import { afterAll, describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  searchVectorInSpace,
  VectorSearchUnavailable,
} from "../src/search/hybrid.ts";
import { EmbeddingProviderError } from "../src/embeddings/provider.ts";
import { MockEmbeddingProvider, mockVector } from "../src/embeddings/mock-provider.ts";
import { EMPTY_PRIVACY_POLICY } from "../src/embeddings/privacy.ts";
import {
  activateSpace,
  createSpace,
  getActiveSpace,
  loadRetireSpacePlan,
  physicalTableName,
  prepareRetireSpace,
  retireSpace,
  writeRetireSpacePlan,
  type EmbeddingSpace,
} from "../src/embeddings/spaces.ts";
import {
  embeddingsPlan,
  embeddingsStatus,
  cancelPendingJobs,
  rebuildStaleJobs,
  retryFailedJobs,
  runEmbeddingWorker,
  LEASE_TIMEOUT_MS,
  type ProviderFactory,
  type WorkerSummary,
} from "../src/embeddings/jobs.ts";
import * as embeddingJobsModule from "../src/embeddings/jobs.ts";
import {
  EXACT_TOKENIZER_ID,
  eligibleCorpusFingerprint,
  exactEmbeddingsPlan,
  type ExactTokenCountReport,
} from "../src/embeddings/token-count.ts";
import {
  auditHnswIndex,
  auditProductionEmbeddingSpace,
  auditVectorDimensions,
  applyPrivacyReconciliation,
  completeStage11,
  pinExpectedJudgmentArtifact,
  preparePrivacyReconciliation,
  prepareEvaluationCandidatePlan,
  loadEvaluationCandidatePlan,
  loadPrivacyReconciliationPlan,
  prepareProductionBackfill,
  runConfirmedEvaluationCandidateBackfill,
  validateEvaluationCandidatePlan,
  writeEvaluationCandidatePlan,
  runConfirmedProductionBackfill,
  validateFullCorpusRelevanceAcceptance,
  writePrivacyReconciliationPlan,
  type AcceptedRelevanceEvidence,
  type AcceptedFullCorpusRelevanceEvidence,
  type ExpectedJudgmentArtifactIdentity,
} from "../src/embeddings/backfill.ts";
import { SEGMENTATION_VERSION } from "../src/search/segmenter.ts";
import { EXTRACTOR_VERSION } from "../src/search/extractors/types.ts";
import {
  computeSearchCorpusFingerprint,
  collectEvaluationReadiness,
  createFullCorpusHybridScenario,
  fullCorpusEvaluationConfirmation,
  judgmentSetSha256,
  loadJudgmentSet,
  parseJudgmentSet,
  runFullCorpusHybridEvaluation,
  serializeFullCorpusEvaluationReport,
} from "../src/search/evaluation.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  type TestDb,
} from "./db-test-utils.ts";

// Доступность SurrealDB проверяется один раз на файл: без живой БД все
// integration-тесты — ЯВНЫЙ skip (test.skip), а не молчаливый pass.
const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

const SPACE_SLUG = "mock_test_16_v1";
const DIMS = 16;
const PROMPT_A = "любимый рецепт яблочного пирога с корицей";
const PROMPT_B = "настройка hnsw индексов в surrealdb";

interface TestEvaluationDocument {
  documentId: string;
  dialogueId: string;
  revisionId: string;
  contentSha256: string;
  content: string;
}

const testSha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function canonicalTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTest);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalTest(item)]));
  }
  return value;
}

const testCanonicalSha256 = (value: unknown) =>
  testSha256(JSON.stringify(canonicalTest(value)));

async function acceptedRelevance(
  space: EmbeddingSpace,
  exact: ExactTokenCountReport,
  directory: string,
  documents: readonly TestEvaluationDocument[],
  overrides: Partial<AcceptedRelevanceEvidence> = {},
): Promise<AcceptedRelevanceEvidence> {
  const queryTypes = [
    "exact phrase", "russian morphology", "english technical", "function name", "model",
    "path", "semantic paraphrase", "mixed ru/en", "code error", "deleted dialogue",
  ];
  const expectedDialogueIds = [...new Set(documents.map((document) => document.dialogueId))].sort();
  const expectedNeedle = documents[0]!.content;
  const judgmentSet = parseJudgmentSet({
    formatVersion: 1,
    name: "private",
    queries: Array.from({ length: 50 }, (_, index) => ({
      id: `q${index}`,
      query: `private query ${index}`,
      expectedDialogues: expectedDialogueIds.map((dialogueId) => ({
        dialogueId,
        relevance: 1,
      })),
      expectedSnippets: [{ text: expectedNeedle }],
      mustNotMatchExamples: index % 2 === 0
        ? [{ snippet: `forbidden-${index}` }]
        : [{ dialogueId: documents[0]!.dialogueId, snippet: `forbidden-${index}` }],
      queryType: queryTypes[index % queryTypes.length],
      queryLanguage: ["ru", "en", "mixed"][index % 3],
    })),
  });
  const judgmentSetPath = path.join(directory, "judgments.json");
  const judgmentSource = `${JSON.stringify(judgmentSet, null, 2)}\n`;
  await writeFile(judgmentSetPath, judgmentSource, { mode: 0o600 });
  const judgmentSha256 = judgmentSetSha256(judgmentSet);
  const idealDcgAt10 = expectedDialogueIds.map((_, rank) =>
    1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
  const queryHitEvidence = documents.map(({ content: _content, ...binding }) => binding);
  const contentEvidence = documents.map((document) => ({ ...document }));
  const rankedDialogueIds = [...new Set(documents.map((document) => document.dialogueId))];
  const returnedDialogues = rankedDialogueIds.length;
  const relevantFoundAt5 = Math.min(5, expectedDialogueIds.length);
  const relevantFoundAt10 = Math.min(10, expectedDialogueIds.length);
  const queries = Array.from({ length: 50 }, (_, index) => {
    const topDialogueIds = rankedDialogueIds.slice(0, 10);
    return {
    queryId: `q${index}`,
    querySha256: testSha256(`private query ${index}`),
    filtersSha256: testCanonicalSha256({}),
    queryType: queryTypes[index % queryTypes.length],
    queryLanguage: ["ru", "en", "mixed"][index % 3],
    recallAt5: relevantFoundAt5 / expectedDialogueIds.length,
    recallAt10: relevantFoundAt10 / expectedDialogueIds.length,
    mrr: 1,
    ndcgAt10: 1,
    irrelevantTop5Share: 0,
    relevantFoundAt5,
    relevantFoundAt10,
    relevantTotal: expectedDialogueIds.length,
    firstRelevantRank: 1,
    dcgAt10: idealDcgAt10,
    idealDcgAt10,
    returnedDialogues,
    topDialogueIds,
    hitEvidence: queryHitEvidence,
    matchedExpectedSnippets: 1,
    expectedSnippetsTotal: 1,
    mustNotMatchViolations: 0,
    mustNotExamplesTotal: 1,
    mustNotMatchOutcomes: [false],
    distinctDialoguesRanked: Math.min(10, returnedDialogues),
    dialogueCandidateShortfall: Math.max(0, 10 - returnedDialogues),
    latencyMs: 1,
    providerLatencyMs: 0.25,
    retrievalLatencyMs: 0.75,
    retrievalFailed: false,
  }; });
  const aggregate = {
    queries: 50,
    recallAt5: relevantFoundAt5 / expectedDialogueIds.length,
    recallAt10: relevantFoundAt10 / expectedDialogueIds.length,
    mrr: 1,
    ndcgAt10: 1,
    irrelevantTop5Share: 0,
    expectedSnippetRecall: 1,
    mustNotMatchViolations: 0,
    retrievalFailures: 0,
    relevantFoundAt5: 50 * relevantFoundAt5,
    relevantFoundAt10: 50 * relevantFoundAt10,
    relevantTotal: 50 * expectedDialogueIds.length,
    dialogueCandidateShortfallQueries: returnedDialogues < 10 ? 50 : 0,
    latencyMs: { mean: 1, p50: 1, p95: 1, max: 1 },
    providerLatencyMs: { mean: 0.25, p50: 0.25, p95: 0.25, max: 0.25 },
    retrievalLatencyMs: { mean: 0.75, p50: 0.75, p95: 0.75, max: 0.75 },
  };
  const candidates = [
    { slug: "small-1536", provider: "openai", model: "text-embedding-3-small", dimensions: 1536 },
    { slug: space.slug, provider: space.provider, model: space.model, dimensions: space.dimensions },
    { slug: "large-3072", provider: "openai", model: "text-embedding-3-large", dimensions: 3072 },
  ];
  const scenarios: Array<Record<string, unknown>> = [{
    id: "bm25", mode: "text", contentEvidence, aggregate, queries,
  }];
  for (const candidate of candidates) {
    for (const mode of ["vector", "hybrid"]) {
      scenarios.push({
        id: `${mode}:${candidate.slug}`,
        mode,
        space: candidate,
        resourceMeasurements: {
          source: "isolated fixture",
          vectorIndexBytes: 1,
          peakRamBytes: 1,
          indexBuildMs: 1,
        },
        readiness: {
          source: "isolated fixture",
          documents: exact.corpus.documents,
          jobs: exact.corpus.documents,
          completedJobs: exact.corpus.documents,
          vectors: exact.corpus.documents,
          jobCoverageErrors: 0,
          vectorCoverageErrors: 0,
          inputHashErrors: 0,
          expectedDimensions: candidate.dimensions,
          wrongDimensionVectors: 0,
          hnswIndexName: "vector_hnsw",
          hnswUsesKnnScan: true,
          privacyNormalizedDocuments: exact.corpus.documents,
          privacyExcludedDocuments: 0,
          permanentExcludedDocuments: 0,
          eligibleDocuments: exact.corpus.documents,
          exclusions: [],
        },
        contentEvidence,
        aggregate,
        queries,
      });
    }
  }
  const candidateDocuments = documents.map((document) => ({
    documentId: document.documentId,
    dialogueId: document.dialogueId,
    revisionId: document.revisionId,
    contentSha256: document.contentSha256,
    extractionVersion: "2",
    segmentationVersion: "2",
  }));
  const candidateBinding = {
    formatVersion: 1 as const,
    fullEligibleCorpus: {
      algorithm: "sha256" as const,
      sha256: exact.corpus.fingerprintSha256,
      documents: exact.corpus.documents,
    },
    subset: {
      limit: candidateDocuments.length,
      selectionSeedSha256: testSha256("isolated-candidate-selection-v1"),
      fingerprint: eligibleCorpusFingerprint(candidateDocuments.map((document) => ({
        id: document.documentId,
        contentSha256: document.contentSha256,
      }))),
      documents: candidateDocuments,
    },
    privacy: {
      excludeHarnesses: [],
      excludeWorkspaces: [],
      excludeDocumentTypes: [],
    },
    requiredDialogueIdsSha256: testCanonicalSha256(
      [...new Set(judgmentSet.queries.flatMap((query) =>
        query.expectedDialogues.map((dialogue) => dialogue.dialogueId),
      ))].sort(),
    ),
    maxJobsPerSpace: 200,
    spaces: candidates.map((candidate) => {
      const jobs = candidateDocuments.map((document, index) => ({
        jobId: `embedding_job:${candidate.slug}:${index}`,
        documentId: document.documentId,
        inputSha256: document.contentSha256,
        status: "pending",
        createdAt: "2026-07-26T10:00:00.000Z",
      }));
      return { space: candidate, jobs, runnableJobs: jobs, vectors: [] };
    }),
    blockers: [],
  };
  const candidatePlanSha256 = testCanonicalSha256(candidateBinding);
  const candidatePlan = {
    ...candidateBinding,
    planSha256: candidatePlanSha256,
    confirmation: `RUN EVALUATION CANDIDATES ${exact.corpus.fingerprintSha256} ${candidatePlanSha256}`,
  };
  const candidatePlanPath = path.join(directory, "candidate-plan.json");
  await writeEvaluationCandidatePlan(candidatePlanPath, candidatePlan);
  const candidatePlanSource = await readFile(candidatePlanPath, "utf8");
  const report = {
    formatVersion: 1,
    generatedAt: "2026-07-26T12:00:00.000Z",
    judgmentSet: {
      name: "private",
      artifactSha256: testSha256(judgmentSource),
      sha256: judgmentSha256,
      queries: 50,
    },
    corpus: {
      algorithm: "sha256",
      sha256: exact.corpus.fingerprintSha256,
      documents: exact.corpus.documents,
    },
    candidatePlan: {
      artifactSha256: testSha256(candidatePlanSource),
      planSha256: candidatePlanSha256,
      corpusSha256: exact.corpus.fingerprintSha256,
      subsetSha256: candidatePlan.subset.fingerprint.sha256,
      privacySha256: testCanonicalSha256({
        excludeHarnesses: [],
        excludeWorkspaces: [],
        excludeDocumentTypes: [],
      }),
    },
    scenarios,
  };
  const source = `${JSON.stringify(report)}\n`;
  const evaluationReportPath = path.join(directory, "evaluation.json");
  await writeFile(evaluationReportPath, source, { mode: 0o600 });
  return {
    formatVersion: 2,
    evaluationReportPath,
    evaluationReportSha256: testSha256(source),
    judgmentSetPath,
    judgmentSetArtifactSha256: testSha256(judgmentSource),
    judgmentSetSha256: judgmentSha256,
    corpusFingerprintSha256: exact.corpus.fingerprintSha256,
    candidatePlanPath,
    candidatePlanArtifactSha256: testSha256(candidatePlanSource),
    candidatePlanSha256,
    privacySha256: report.candidatePlan.privacySha256,
    scenarioId: `hybrid:${space.slug}`,
    space: {
      slug: space.slug,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
    },
    thresholds: {
      minimumRecallAt5: 0.8,
      minimumRecallAt10: 0.9,
      minimumMrr: 0.8,
      minimumNdcgAt10: 0.8,
      minimumExpectedSnippetRecall: 0.8,
      maximumIrrelevantTop5Share: 0.7,
      maximumMustNotMatchViolations: 0,
      maximumRetrievalFailures: 0,
    },
    humanAcceptance: {
      accepted: true,
      acceptedBy: "isolated-test-reviewer",
      acceptedAt: "2026-07-26T12:30:00.000Z",
      rationale: "isolated fixture acceptance",
    },
    ...overrides,
  };
}

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
  last_error?: string;
}

const allJobs = (t: TestDb) => selectAll<JobRow>(t.db, "SELECT * FROM embedding_job");
const vectorCount = async (t: TestDb): Promise<number> =>
  (await selectOne<{ n: number }>(t.db, `SELECT count() AS n FROM ${physicalTableName(SPACE_SLUG)} GROUP ALL`))?.n ?? 0;

describe("embedding spaces (integration)", () => {
  testDb("space:create создаёт таблицу + HNSW-индекс и backfill jobs; activate — один active", async () => {
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

  testDb("(ре)активация догоняет backfill документов, появившихся в inactive (идемпотентно)", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, false);
      expect(await allJobs(t)).toHaveLength(4);

      // Новый диалог → новые search_documents; jobs для inactive space не ставятся.
      const ctx = await makeCtx(t);
      const keyC = dialogueIdentityKey(ctx.installation.toString(), "emb_c", "fb");
      await writeDialogueRevision(
        t.db,
        txInput(ctx, dialogue("emb_c", "третий диалог про логические бэкапы", "Ответ третьего диалога."), keyC),
      );
      expect(await allJobs(t)).toHaveLength(4);

      // Активация создаёт недостающие jobs только для новых документов.
      const activated = await activateSpace(t.db, SPACE_SLUG);
      expect(activated.active).toBe(true);
      expect(activated.enqueuedJobs).toBe(2);
      expect(activated.existingJobs).toBe(4);
      const jobs = await allJobs(t);
      expect(jobs).toHaveLength(6);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["pending"]));

      // Повторная активация — no-op (детерминированные id + UNIQUE).
      const again = await activateSpace(t.db, SPACE_SLUG);
      expect(again.enqueuedJobs).toBe(0);
      expect(again.existingJobs).toBe(6);
      expect(await allJobs(t)).toHaveLength(6);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("rejected candidate retirement preserves distinct active and accepted spaces", async () => {
    const t = await createTestDb();
    const planDirectory = await mkdtemp(path.join(os.tmpdir(), "baka-space-retire-"));
    try {
      await seed(t);
      const active = (await createSpace(t.db, {
        slug: "candidate_active",
        provider: "mock",
        model: "mock-embedding",
        dimensions: DIMS,
        activate: true,
      })).space;
      const accepted = (await createSpace(t.db, {
        slug: "candidate_accepted",
        provider: "mock",
        model: "mock-embedding",
        dimensions: DIMS,
      })).space;
      const rejected = (await createSpace(t.db, {
        slug: "candidate_rejected",
        provider: "mock",
        model: "mock-embedding",
        dimensions: DIMS,
      })).space;
      expect((await runEmbeddingWorker(t.db, { privacy: EMPTY_PRIVACY_POLICY })).completed).toBe(12);

      const plan = await prepareRetireSpace(t.db, rejected.slug, accepted.slug);
      expect(plan.blockers).toEqual([]);
      expect(plan.protectedSpaces.map((space) => [space.slug, space.roles])).toEqual([
        [accepted.slug, ["accepted"]],
        [active.slug, ["active"]],
      ]);
      const planPath = path.join(planDirectory, "retire.json");
      await writeRetireSpacePlan(planPath, plan);
      const approvedPlan = await loadRetireSpacePlan(planPath);
      const result = await retireSpace(t.db, approvedPlan, approvedPlan.confirmation);
      expect(result).toMatchObject({
        slug: rejected.slug,
        jobsDeleted: 4,
        vectorsDeleted: 4,
        canonicalCorpusUnchanged: true,
        protectedSpacesVerified: true,
      });
      expect((await getActiveSpace(t.db))?.slug).toBe(active.slug);
      const surviving = await selectAll<{ slug: string }>(
        t.db,
        "SELECT slug FROM embedding_space ORDER BY slug",
      );
      expect(surviving.map((space) => space.slug)).toEqual([accepted.slug, active.slug]);
      for (const protectedSpace of plan.protectedSpaces) {
        const jobCount = await selectAll(
          t.db,
          "SELECT id FROM embedding_job WHERE embedding_space = type::record('embedding_space', $slug)",
          { slug: protectedSpace.slug },
        );
        const vectorCount = await selectAll(t.db, `SELECT id FROM ${protectedSpace.physicalTable}`);
        expect(jobCount).toHaveLength(protectedSpace.jobs.count);
        expect(vectorCount).toHaveLength(protectedSpace.vectors.count);
      }
      const dbInfo = JSON.stringify(await t.db.query("INFO FOR DB"));
      expect(dbInfo).not.toContain(`DEFINE TABLE ${rejected.physical_table}`);

      const activePlan = await prepareRetireSpace(t.db, active.slug, accepted.slug);
      expect(activePlan.blockers).toContain("space is active");
      await expect(retireSpace(t.db, activePlan, activePlan.confirmation)).rejects.toThrow("blocked");
    } finally {
      await dropTestDb(t);
      await rm(planDirectory, { recursive: true, force: true });
    }
  });
});

describe("embedding worker (integration)", () => {
  testDb("run завершает jobs и пишет векторы; повторный run идемпотентен", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      const summary = await runEmbeddingWorker(t.db, {
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

      // Сумма распределённых prompt_tokens строго равна фактическому usage API (§13.6).
      const tokenSum = await selectOne<{ total: number }>(
        t.db,
        `SELECT math::sum(prompt_tokens) AS total FROM ${physicalTableName(SPACE_SLUG)} GROUP ALL`,
      );
      expect(tokenSum?.total).toBe(summary.promptTokens);

      // Повторный run: нечего брать — ничего не меняется.
      const again = await runEmbeddingWorker(t.db, {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(again.completed).toBe(0);
      expect(await vectorCount(t)).toBe(4);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("wrong dimension отклоняется: permanent_error, vector не пишется (№23)", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({
        dimensions: DIMS,
        model: "mock-embedding",
        dimensionOverride: DIMS + 1,
      });
      const summary = await runEmbeddingWorker(t.db, {
        dimensionOverride: DIMS + 1,
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(summary.completed).toBe(0);
      expect(summary.permanentErrors).toBe(4);
      expect(await vectorCount(t)).toBe(0);
      const jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["permanent_error"]));
      expect(new Set(jobs.map((j) => j.last_error))).toEqual(
        new Set([`vector_dimension_mismatch expected=${DIMS} actual=${DIMS + 1}`]),
      );
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("stuck job возвращается в pending после lease timeout (№22)", async () => {
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
      const summary = await runEmbeddingWorker(t.db, {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(summary.releasedStale).toBe(1);
      expect(summary.completed).toBe(4);
      expect(await vectorCount(t)).toBe(4);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("retryable ошибка → retryable_error с backoff; retry → pending; успех", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const privateProviderError = "PRIVATE DOCUMENT EXCERPT synthetic rate limit";
      const provider = new MockEmbeddingProvider({
        dimensions: DIMS,
        model: "mock-embedding",
        failures: [new EmbeddingProviderError(privateProviderError, true)],
      });
      const events: Record<string, unknown>[] = [];
      const failed = await runEmbeddingWorker(t.db, {
        failures: ["retryable"],
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(failed.failed).toBe(4);
      expect(failed.completed).toBe(0);
      let jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["retryable_error"]));
      expect(jobs.every((j) => j.attempts === 1 && j.next_attempt_at !== undefined)).toBe(true);
      expect(new Set(jobs.map((j) => j.last_error))).toEqual(
        new Set(["provider_retryable_error"]),
      );
      // next_attempt_at в будущем — без retry worker их не берёт.
      const skipped = await runEmbeddingWorker(t.db, {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(skipped.completed).toBe(0);

      expect(await retryFailedJobs(t.db)).toBe(4);
      const ok = await runEmbeddingWorker(t.db, {
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(ok.completed).toBe(4);
      jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["completed"]));
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("permanent ошибка provider → permanent_error без backoff", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({
        dimensions: DIMS,
        model: "mock-embedding",
        failures: [new EmbeddingProviderError("bad request", false)],
      });
      const summary = await runEmbeddingWorker(t.db, {
        failures: ["permanent"],
        privacy: EMPTY_PRIVACY_POLICY,
      });
      expect(summary.permanentErrors).toBe(4);
      const jobs = await allJobs(t);
      expect(jobs.every((j) => j.status === "permanent_error" && j.next_attempt_at === undefined)).toBe(true);
      expect(new Set(jobs.map((j) => j.last_error))).toEqual(
        new Set(["provider_permanent_error"]),
      );
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("приватность (§13.7): исключённый harness → cancelled, provider не вызывается", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      const events: Record<string, unknown>[] = [];
      const summary = await runEmbeddingWorker(t.db, {
        privacy: { ...EMPTY_PRIVACY_POLICY, excludeHarnesses: ["kimi-code"] },
      });
      expect(summary.privacyExcluded).toBe(4);
      expect(summary.batches).toBe(0);
      expect(await vectorCount(t)).toBe(0);
      const jobs = await allJobs(t);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["cancelled"]));
      expect(new Set(jobs.map((j) => j.last_error))).toEqual(
        new Set(["privacy_excluded_harness"]),
      );
      expect(JSON.stringify(events)).not.toContain("kimi-code");
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("privacy reconciliation is provider-free, deletes stale vectors, and only reopens privacy cancellations", async () => {
    const t = await createTestDb();
    const planDirectory = await mkdtemp(path.join(os.tmpdir(), "baka-privacy-reconcile-"));
    try {
      await seed(t);
      const space = await makeSpace(t, true);
      expect((await runEmbeddingWorker(t.db, { privacy: EMPTY_PRIVACY_POLICY })).completed).toBe(4);
      expect(await vectorCount(t)).toBe(4);

      const tightened = {
        ...EMPTY_PRIVACY_POLICY,
        excludeDocumentTypes: ["assistant_final"],
      };
      const plan = await preparePrivacyReconciliation(t.db, space.slug, tightened);
      expect(plan.blockers).toEqual([]);
      expect(plan.actions).toHaveLength(2);
      expect(new Set(plan.actions.map((action) => action.kind))).toEqual(
        new Set(["cancel_privacy_excluded"]),
      );
      expect(new Set(plan.actions.map((action) => action.exclusionReason))).toEqual(
        new Set(["privacy_excluded_document_type"]),
      );
      expect(plan.actions.every((action) => action.vectors.length === 1)).toBe(true);

      const planPath = path.join(planDirectory, "privacy.json");
      await writePrivacyReconciliationPlan(planPath, plan);
      const approvedPlan = await loadPrivacyReconciliationPlan(planPath);
      const applied = await applyPrivacyReconciliation(
        t.db,
        approvedPlan,
        approvedPlan.confirmation,
      );
      expect(applied).toMatchObject({
        cancelled: 2,
        requeued: 0,
        vectorsDeleted: 2,
        verified: true,
      });
      const cancelled = await selectAll<{ last_error?: string }>(
        t.db,
        `SELECT last_error FROM embedding_job WHERE embedding_space = $space AND status = "cancelled"`,
        { space: space.id },
      );
      expect(cancelled).toHaveLength(2);
      expect(cancelled.every((job) => /^privacy_excluded_[a-z_]+$/.test(job.last_error ?? ""))).toBe(true);
      expect((await auditProductionEmbeddingSpace(t.db, space.slug, tightened)).ok).toBe(true);

      const [eligibleJob] = await selectAll<{
        id: RecordId;
        search_document: RecordId;
        input_sha256: string;
      }>(
        t.db,
        `SELECT id, search_document, input_sha256 FROM embedding_job
         WHERE embedding_space = $space AND status = "completed" LIMIT 1`,
        { space: space.id },
      );
      await t.db.query(`UPDATE ONLY $job SET input_sha256 = $hash`, {
        job: eligibleJob!.id,
        hash: "0".repeat(64),
      });
      expect(
        (await auditProductionEmbeddingSpace(t.db, space.slug, tightened)).blockers.some(
          (blocker) => blocker.includes("stale job input hash"),
        ),
      ).toBe(true);
      await t.db.query(`UPDATE ONLY $job SET input_sha256 = $hash`, {
        job: eligibleJob!.id,
        hash: eligibleJob!.input_sha256,
      });

      const [eligibleVector] = await selectAll<{ id: RecordId; input_sha256: string }>(
        t.db,
        `SELECT id, input_sha256 FROM ${space.physical_table}
         WHERE search_document = $document LIMIT 1`,
        { document: eligibleJob!.search_document },
      );
      await t.db.query(`UPDATE ONLY $vector SET input_sha256 = $hash`, {
        vector: eligibleVector!.id,
        hash: "0".repeat(64),
      });
      expect(
        (await auditProductionEmbeddingSpace(t.db, space.slug, tightened)).blockers.some(
          (blocker) => blocker.includes("stale vector input hash"),
        ),
      ).toBe(true);
      await t.db.query(`UPDATE ONLY $vector SET input_sha256 = $hash`, {
        vector: eligibleVector!.id,
        hash: eligibleVector!.input_sha256,
      });

      const missingDocument = new RecordId("search_document", "missing_audit_document");
      const orphanJob = new RecordId("embedding_job", "orphan_audit_job");
      const orphanVector = new RecordId(space.physical_table, "orphan_audit_vector");
      await t.db.query(
        `CREATE ONLY $job SET search_document = $document, embedding_space = $space,
           input_sha256 = $hash, status = "cancelled", attempts = 0,
           last_error = "privacy_excluded_policy", created_at = $now, completed_at = $now;
         CREATE ONLY $vector SET search_document = $document, embedding_space = $space,
           input_sha256 = $hash, vector = $embedding, prompt_tokens = 1, created_at = $now;`,
        {
          job: orphanJob,
          vector: orphanVector,
          document: missingDocument,
          space: space.id,
          hash: "a".repeat(64),
          embedding: mockVector("orphan audit", DIMS),
          now: new Date(),
        },
      );
      const orphanAudit = await auditProductionEmbeddingSpace(t.db, space.slug, tightened);
      expect(orphanAudit.blockers.some((blocker) => blocker.includes("orphan job"))).toBe(true);
      expect(orphanAudit.blockers.some((blocker) => blocker.includes("orphan vector"))).toBe(true);
      await t.db.query("DELETE ONLY $job; DELETE ONLY $vector;", {
        job: orphanJob,
        vector: orphanVector,
      });
      expect((await preparePrivacyReconciliation(t.db, space.slug, tightened)).actions).toEqual([]);

      const loosened = await preparePrivacyReconciliation(t.db, space.slug, EMPTY_PRIVACY_POLICY);
      expect(loosened.actions).toHaveLength(2);
      expect(loosened.actions.every((action) => action.kind === "requeue_privacy_allowed")).toBe(true);
      expect((await applyPrivacyReconciliation(t.db, loosened, loosened.confirmation)).requeued).toBe(2);

      const [pending] = await selectAll<{ id: RecordId }>(
        t.db,
        `SELECT id FROM embedding_job WHERE embedding_space = $space AND status = "pending" LIMIT 1`,
        { space: space.id },
      );
      await t.db.query(
        `UPDATE ONLY $job SET status = "cancelled", last_error = "operator_cancelled"`,
        { job: pending!.id },
      );
      const nonPrivacyTerminal = await preparePrivacyReconciliation(
        t.db,
        space.slug,
        EMPTY_PRIVACY_POLICY,
      );
      expect(nonPrivacyTerminal.blockers.some((blocker) => blocker.includes("operator reason"))).toBe(true);
      await expect(
        applyPrivacyReconciliation(t.db, nonPrivacyTerminal, nonPrivacyTerminal.confirmation),
      ).rejects.toThrow("blocked");
    } finally {
      await dropTestDb(t);
      await rm(planDirectory, { recursive: true, force: true });
    }
  });

  testDb("generic worker rejects provider factories before lease", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      let externalCalls = 0;
      const spoof = () => ({
        provider: "mock",
        model: "mock-embedding",
        dimensions: DIMS,
        embed: async () => {
          externalCalls += 1;
          return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
        },
      });
      await expect(
        (runEmbeddingWorker as unknown as (...args: unknown[]) => Promise<WorkerSummary>)(
          t.db,
          spoof,
          { privacy: EMPTY_PRIVACY_POLICY },
        ),
      ).rejects.toThrow("offline_mock_worker_options_invalid");
      expect(externalCalls).toBe(0);
      // Jobs не переведены в processing и не залочены — повторный run с
      // рабочей фабрикой сможет их взять без ожидания lease timeout.
      const jobs = await allJobs(t);
      expect(jobs).toHaveLength(4);
      expect(new Set(jobs.map((j) => j.status))).toEqual(new Set(["pending"]));
      const locked = await selectAll(t.db, "SELECT id FROM embedding_job WHERE locked_by IS NOT NONE");
      expect(locked).toHaveLength(0);
    } finally {
      await dropTestDb(t);
    }
  });
});

describe("Stage 11 bounded candidate bootstrap", () => {
  testDb("all three spaces use only the reproducible subset; generic paid API is blocked", async () => {
    const t = await createTestDb();
    const planDirectory = await mkdtemp(path.join(os.tmpdir(), "baka-candidate-plan-"));
    try {
      await seed(t);
      const candidateSpaces = await Promise.all([
        createSpace(t.db, {
          slug: "candidate_small_1536",
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 1536,
        }),
        createSpace(t.db, {
          slug: "candidate_large_1024",
          provider: "openai",
          model: "text-embedding-3-large",
          dimensions: 1024,
        }),
        createSpace(t.db, {
          slug: "candidate_large_3072",
          provider: "openai",
          model: "text-embedding-3-large",
          dimensions: 3072,
        }),
      ]);
      const [required] = await selectAll<{ dialogue_id: RecordId }>(
        t.db,
        "SELECT id, dialogue.id AS dialogue_id FROM search_document ORDER BY id LIMIT 1",
      );
      const candidateOptions = {
        privacy: EMPTY_PRIVACY_POLICY,
        spaceSlugs: candidateSpaces.map((item) => item.space.slug),
        maxDocuments: 2,
        maxJobsPerSpace: 2,
        selectionSeedSha256: testSha256("bounded-candidate-selection-v1"),
        requiredDialogueIds: [String(required!.dialogue_id)],
      };
      await expect(prepareEvaluationCandidatePlan(t.db, {
        ...candidateOptions,
        maxDocuments: 1_001,
      })).rejects.toThrow("1..1000");
      await expect(prepareEvaluationCandidatePlan(t.db, {
        ...candidateOptions,
        maxJobsPerSpace: 201,
      })).rejects.toThrow("1..200");
      const plan = await prepareEvaluationCandidatePlan(t.db, candidateOptions);
      expect(plan.blockers).toEqual([]);
      expect(plan.subset.documents).toHaveLength(2);
      expect(plan.fullEligibleCorpus.documents).toBe(4);
      expect(plan.spaces).toHaveLength(3);
      expect(plan.spaces.every((item) => item.jobs.length === 2)).toBe(true);
      const planPath = path.join(planDirectory, "candidate.json");
      await writeEvaluationCandidatePlan(planPath, plan);
      expect((await loadEvaluationCandidatePlan(planPath)).planSha256).toBe(plan.planSha256);
      expect(() => validateEvaluationCandidatePlan({
        ...plan,
        maxJobsPerSpace: plan.maxJobsPerSpace + 1,
      })).toThrow("SHA-256 mismatch");

      const genericProvider = new MockEmbeddingProvider({
        provider: "openai",
        model: candidateSpaces[0]!.space.model,
        dimensions: candidateSpaces[0]!.space.dimensions,
      });
      await expect((runEmbeddingWorker as unknown as (...args: unknown[]) => Promise<WorkerSummary>)(
        t.db,
        () => genericProvider,
        {
          spaceSlug: candidateSpaces[0]!.space.slug,
          privacy: EMPTY_PRIVACY_POLICY,
        },
      )).rejects.toThrow("offline_mock_worker_options_invalid");
      expect(genericProvider.calls).toBe(0);

      const providers = new Map<string, MockEmbeddingProvider>();
      const providerFactory: ProviderFactory = (space) => {
        const provider = new MockEmbeddingProvider({
          provider: space.provider,
          model: space.model,
          dimensions: space.dimensions,
        });
        providers.set(space.slug, provider);
        return provider;
      };
      await expect(runConfirmedEvaluationCandidateBackfill(t.db, providerFactory, {
        ...candidateOptions,
        confirmation: plan.confirmation,
        allowExternalProviderCalls: false,
      })).rejects.toThrow("explicit external-call approval");
      const result = await runConfirmedEvaluationCandidateBackfill(t.db, providerFactory, {
        ...candidateOptions,
        confirmation: plan.confirmation,
        allowExternalProviderCalls: true,
      });
      expect(Object.values(result.summaries).map((summary) => summary.completed)).toEqual([2, 2, 2]);
      expect([...providers.values()].every((provider) => provider.calls === 1)).toBe(true);
      for (const candidate of candidateSpaces) {
        const rows = await selectAll<{ status: string }>(
          t.db,
          "SELECT status FROM embedding_job WHERE embedding_space = $space",
          { space: candidate.space.id },
        );
        expect(rows.filter((row) => row.status === "completed")).toHaveLength(2);
        expect(rows.filter((row) => row.status === "pending")).toHaveLength(2);
      }
    } finally {
      await dropTestDb(t);
      await rm(planDirectory, { recursive: true, force: true });
    }
  });
});

describe("Stage 11 evaluation readiness collector", () => {
  testDb("privacy exclusions reconcile without false vector coverage errors", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      const space = await makeSpace(t);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: space.model });
      const privacy = {
        ...EMPTY_PRIVACY_POLICY,
        excludeDocumentTypes: ["assistant_final"],
      };
      const summary = await runEmbeddingWorker(t.db, {
        privacy,
      });
      expect(summary.completed).toBe(2);
      expect(summary.privacyExcluded).toBe(2);
      const cancelled = await selectAll<{ id: RecordId; search_document: RecordId }>(
        t.db,
        `SELECT id, search_document FROM embedding_job
         WHERE embedding_space = $space AND status = "cancelled" ORDER BY id`,
        { space: space.id },
      );
      const readiness = await collectEvaluationReadiness(t.db, space, {
        privacy,
        documentedExclusions: cancelled.map((job) => ({
          category: "privacy",
          code: "privacy_excluded_document_type",
          jobId: String(job.id),
          documentId: String(job.search_document),
          evidence: "privacy-policy-stage11-test",
        })),
      });
      expect(readiness).toMatchObject({
        documents: 4,
        jobs: 4,
        completedJobs: 2,
        vectors: 2,
        privacyNormalizedDocuments: 2,
        privacyExcludedDocuments: 2,
        permanentExcludedDocuments: 0,
        eligibleDocuments: 2,
        jobCoverageErrors: 0,
        vectorCoverageErrors: 0,
        inputHashErrors: 0,
      });
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("swapped privacy-excluded and eligible identities are rejected", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      const space = await makeSpace(t);
      const privacy = {
        ...EMPTY_PRIVACY_POLICY,
        excludeDocumentTypes: ["assistant_final"],
      };
      await runEmbeddingWorker(t.db, { privacy });
      const rows = await selectAll<{
        id: RecordId;
        content_sha256: string;
        document_type: string;
      }>(
        t.db,
        "SELECT id, content_sha256, document_type FROM search_document ORDER BY id",
      );
      const jobs = await selectAll<{ id: RecordId; search_document: RecordId }>(
        t.db,
        "SELECT id, search_document FROM embedding_job WHERE embedding_space = $space",
        { space: space.id },
      );
      const jobByDocument = new Map(jobs.map((job) => [String(job.search_document), job.id]));
      const excluded = rows.find((row) => row.document_type === "assistant_final")!;
      const eligible = rows.find((row) => row.document_type !== "assistant_final")!;
      await t.db.query(
        `UPDATE ONLY $excludedJob SET status = "completed", last_error = NONE;
         UPDATE ONLY $eligibleJob SET status = "cancelled",
           last_error = "privacy_excluded_document_type";
         UPDATE ${space.physical_table} SET search_document = $excludedDoc,
           input_sha256 = $excludedHash WHERE search_document = $eligibleDoc;`,
        {
          excludedJob: jobByDocument.get(String(excluded.id)),
          eligibleJob: jobByDocument.get(String(eligible.id)),
          excludedDoc: excluded.id,
          excludedHash: excluded.content_sha256,
          eligibleDoc: eligible.id,
        },
      );
      const stillExcluded = rows.filter((row) =>
        row.document_type === "assistant_final" && String(row.id) !== String(excluded.id));
      const documented = [
        ...stillExcluded.map((row) => ({
          category: "privacy" as const,
          code: "privacy_excluded_document_type",
          jobId: String(jobByDocument.get(String(row.id))),
          documentId: String(row.id),
          evidence: "privacy-policy-stage11-test",
        })),
        {
          category: "privacy" as const,
          code: "privacy_excluded_document_type",
          jobId: String(jobByDocument.get(String(eligible.id))),
          documentId: String(eligible.id),
          evidence: "swapped-identity-forgery",
        },
      ];
      await expect(collectEvaluationReadiness(t.db, space, {
        privacy,
        documentedExclusions: documented,
      })).rejects.toThrow("exclusion identities");
    } finally {
      await dropTestDb(t);
    }
  });
});

describe("Stage 11 paid worker boundary", () => {
  testDb("direct import plus arbitrary ids/no-op callback cannot reach a paid provider", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      const space = (await createSpace(t.db, {
        slug: "paid_gate_16",
        provider: "openai",
        model: "test-paid-model",
        dimensions: DIMS,
      })).space;
      const jobs = await selectAll<{ id: RecordId }>(
        t.db,
        "SELECT id FROM embedding_job ORDER BY id",
      );
      let delegatedEmbedCalls = 0;
      const attackerProvider = {
        provider: "mock",
        model: space.model,
        dimensions: space.dimensions,
        async embed(texts: string[]) {
          delegatedEmbedCalls += 1;
          return {
            vectors: texts.map((text) => mockVector(text, space.dimensions)),
            usage: { promptTokens: texts.length, totalTokens: texts.length },
          };
        },
      };
      expect(
        (embeddingJobsModule as Record<string, unknown>).runEmbeddingWorkerWithExternalGate,
      ).toBeUndefined();
      expect((embeddingJobsModule as Record<string, unknown>).cancelJob).toBeUndefined();
      const adversarialCall = runEmbeddingWorker as unknown as (
        ...args: unknown[]
      ) => Promise<WorkerSummary>;
      await expect(adversarialCall(
        t.db,
        () => attackerProvider,
        {
          spaceSlug: space.slug,
          limit: jobs.length,
          batchSize: jobs.length,
          workerId: "adversarial-worker",
          privacy: EMPTY_PRIVACY_POLICY,
          jobIds: jobs.map((job) => job.id),
        },
        { jobIds: jobs.map((job) => job.id), beforeProviderCall: async () => {} },
      )).rejects.toThrow("offline_mock_worker_options_invalid");
      await expect(adversarialCall(t.db, {
        privacy: EMPTY_PRIVACY_POLICY,
        spaceSlug: space.slug,
        jobIds: jobs.map((job) => job.id),
        provider: attackerProvider,
        beforeProviderCall: async () => {},
      })).rejects.toThrow("offline_mock_worker_options_invalid");
      expect(delegatedEmbedCalls).toBe(0);
      expect(new Set((await allJobs(t)).map((job) => job.status))).toEqual(new Set(["pending"]));
      expect(await cancelPendingJobs(t.db, space.slug)).toBe(jobs.length);
      expect(new Set((await allJobs(t)).map((job) => job.last_error))).toEqual(
        new Set(["operator_cancelled"]),
      );
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
    await runEmbeddingWorker(t.db, { privacy: EMPTY_PRIVACY_POLICY });
    return { space, provider };
  }

  testDb("vector search находит ближайший документ по mock-векторам", async () => {
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

  testDb("EXPLAIN FULL подтверждает HNSW (KnnScan, №24)", async () => {
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

  testDb("hybrid выдаёт объединённый результат BM25 + vector", async () => {
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

  testDb("rrfFuse + dedupByMessage на реальных списках", async () => {
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

  testDb("деградация (§14): нет active space → VectorSearchUnavailable", async () => {
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
  testDb("смена current revision удаляет vectors старых docs (§8.1)", async () => {
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
      await runEmbeddingWorker(t.db, { privacy: EMPTY_PRIVACY_POLICY });
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

  testDb("embeddings rebuild: stale jobs → pending, их vectors удалены (§13.5)", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      const space = await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      await runEmbeddingWorker(t.db, { privacy: EMPTY_PRIVACY_POLICY });
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

  testDb("rebuild: устаревшие extraction/segmentation versions → pending (§13.5)", async () => {
    const t = await createTestDb();
    try {
      await seed(t);
      await makeSpace(t, true);
      const provider = new MockEmbeddingProvider({ dimensions: DIMS, model: "mock-embedding" });
      await runEmbeddingWorker(t.db, { privacy: EMPTY_PRIVACY_POLICY });
      expect(await vectorCount(t)).toBe(4);

      // Документы извлечены/сегментированы старыми версиями кода; content hash
      // не менялся — по одному hash такой stale не поймать.
      const docs = await selectAll<{ id: RecordId }>(
        t.db,
        "SELECT id FROM search_document ORDER BY id LIMIT 2",
      );
      expect(docs).toHaveLength(2);
      await t.db.query(`UPDATE ONLY $id SET segmentation_version = "0"`, { id: docs[0]!.id });
      await t.db.query(`UPDATE ONLY $id SET extraction_version = "0"`, { id: docs[1]!.id });

      const summary = await rebuildStaleJobs(t.db, SPACE_SLUG);
      expect(summary.resetToPending).toBe(2);
      expect(summary.vectorsDeleted).toBe(2);
      expect(await vectorCount(t)).toBe(2);
      const jobs = await allJobs(t);
      expect(jobs.filter((j) => j.status === "pending")).toHaveLength(2);
      expect(jobs.filter((j) => j.status === "completed")).toHaveLength(2);

      // Projection пересобрана актуальным кодом (versions документов совпали
      // с EXTRACTOR_VERSION/SEGMENTATION_VERSION) — повторный rebuild чист.
      await t.db.query(`UPDATE ONLY $id SET segmentation_version = $v`, {
        id: docs[0]!.id,
        v: SEGMENTATION_VERSION,
      });
      await t.db.query(`UPDATE ONLY $id SET extraction_version = $v`, {
        id: docs[1]!.id,
        v: String(EXTRACTOR_VERSION),
      });
      const again = await rebuildStaleJobs(t.db, SPACE_SLUG);
      expect(again.resetToPending).toBe(0);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("embeddings plan/status: счётчики и storage-оценка", async () => {
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

  testDb("Stage 11: exact plan + explicit confirmed backfill + dimension/HNSW audit", async () => {
    const t = await createTestDb();
    const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "baka-stage11-evidence-"));
    try {
      await seed(t);
      const space = (await createSpace(t.db, {
        slug: "large_1024",
        provider: "openai",
        model: "text-embedding-3-large",
        dimensions: 1024,
      })).space;
      const exact = await exactEmbeddingsPlan(
        t.db,
        {
          // TEST DOUBLE: character count проверяет wiring/gates, но не является
          // и не изображает production exact tokenizer embedding-модели.
          id: EXACT_TOKENIZER_ID,
          model: space.model,
          countBatch: async (texts) => texts.map((text) => text.length),
        },
        { pricePer1MTokens: 0.5, now: () => new Date("2026-07-26T12:00:00Z") },
      );
      const evaluationDocuments = (await selectAll<{
        id: RecordId;
        dialogue_id: RecordId;
        revision_id: RecordId;
        content_sha256: string;
        content: string;
      }>(
        t.db,
        `SELECT id, dialogue.id AS dialogue_id, dialogue_revision.id AS revision_id,
           content_sha256, content FROM search_document ORDER BY id`,
      )).map((row) => ({
        documentId: String(row.id),
        dialogueId: String(row.dialogue_id),
        revisionId: String(row.revision_id),
        contentSha256: row.content_sha256,
        content: row.content,
      }));
      const relevance = await acceptedRelevance(
        space,
        exact,
        evidenceDirectory,
        evaluationDocuments,
      );
      expect((await computeSearchCorpusFingerprint(t.db)).sha256).toBe(
        exact.corpus.fingerprintSha256,
      );
      const gate = {
        privacy: EMPTY_PRIVACY_POLICY,
        pricePer1MTokens: 0.5,
        maxJobs: 4,
        acceptedRelevance: relevance,
      };

      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          pricePer1MTokens: undefined,
        } as never),
      ).rejects.toThrow("finite pricePer1MTokens");
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          privacy: EMPTY_PRIVACY_POLICY,
          pricePer1MTokens: 0.5,
          maxJobs: 4,
        } as never),
      ).rejects.toThrow("accepted relevance evidence");
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          acceptedRelevance: {
            ...relevance,
            corpusFingerprintSha256: "0".repeat(64),
          },
        }),
      ).rejects.toThrow("corpus");
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          acceptedRelevance: {
            ...relevance,
            candidatePlanSha256: testSha256("different-candidate-plan"),
          },
        }),
      ).rejects.toThrow("candidate plan artifact or judgment coverage mismatch");
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          acceptedRelevance: {
            ...relevance,
            space: { ...relevance.space, dimensions: relevance.space.dimensions + 1 },
          },
        }),
      ).rejects.toThrow("space.dimensions");
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          acceptedRelevance: { ...relevance, scenarioId: `vector:${space.slug}` },
        }),
      ).rejects.toThrow("selected hybrid");
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          acceptedRelevance: {
            ...relevance,
            humanAcceptance: { ...relevance.humanAcceptance, acceptedBy: "" },
          },
        }),
      ).rejects.toThrow("human acceptance");
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          acceptedRelevance: {
            ...relevance,
            thresholds: { ...relevance.thresholds, minimumRecallAt5: 1.1 },
          },
        }),
      ).rejects.toThrow("expected finite ratio");
      const originalEvaluation = await readFile(relevance.evaluationReportPath, "utf8");
      const tamperedAggregate = JSON.parse(originalEvaluation) as Record<string, any>;
      tamperedAggregate.scenarios[0].aggregate.recallAt5 = 0.5;
      const tamperedAggregateSource = `${JSON.stringify(tamperedAggregate)}\n`;
      await writeFile(relevance.evaluationReportPath, tamperedAggregateSource);
      await expect(prepareProductionBackfill(t.db, space.slug, exact, {
        ...gate,
        acceptedRelevance: {
          ...relevance,
          evaluationReportSha256: testSha256(tamperedAggregateSource),
        },
      })).rejects.toThrow("aggregate mismatch");

      const tamperedQuery = JSON.parse(originalEvaluation) as Record<string, any>;
      tamperedQuery.scenarios[0].queries[0].relevantFoundAt5 = 4;
      const tamperedQuerySource = `${JSON.stringify(tamperedQuery)}\n`;
      await writeFile(relevance.evaluationReportPath, tamperedQuerySource);
      await expect(prepareProductionBackfill(t.db, space.slug, exact, {
        ...gate,
        acceptedRelevance: {
          ...relevance,
          evaluationReportSha256: testSha256(tamperedQuerySource),
        },
      })).rejects.toThrow("recall identity mismatch");

      const originalJudgment = await readFile(relevance.judgmentSetPath, "utf8");
      const assertJudgmentTamperRejected = async (
        mutate: (artifact: Record<string, any>) => void,
        message: string,
      ) => {
        const artifact = JSON.parse(originalJudgment) as Record<string, any>;
        mutate(artifact);
        const judgmentSource = `${JSON.stringify(artifact)}\n`;
        const canonicalJudgment = parseJudgmentSet(artifact);
        const canonicalSha = judgmentSetSha256(canonicalJudgment);
        const report = JSON.parse(originalEvaluation) as Record<string, any>;
        report.judgmentSet.artifactSha256 = testSha256(judgmentSource);
        report.judgmentSet.sha256 = canonicalSha;
        const reportSource = `${JSON.stringify(report)}\n`;
        await writeFile(relevance.judgmentSetPath, judgmentSource);
        await writeFile(relevance.evaluationReportPath, reportSource);
        await expect(prepareProductionBackfill(t.db, space.slug, exact, {
          ...gate,
          acceptedRelevance: {
            ...relevance,
            judgmentSetArtifactSha256: testSha256(judgmentSource),
            judgmentSetSha256: canonicalSha,
            evaluationReportSha256: testSha256(reportSource),
          },
        })).rejects.toThrow(message);
        await writeFile(relevance.judgmentSetPath, originalJudgment);
        await writeFile(relevance.evaluationReportPath, originalEvaluation);
      };
      await assertJudgmentTamperRejected(
        (artifact) => { artifact.queries[0].query = "tampered private query"; },
        "judgment binding mismatch",
      );
      await assertJudgmentTamperRejected(
        (artifact) => { artifact.queries[0].filters = { workspace: "tampered" }; },
        "judgment binding mismatch",
      );
      await assertJudgmentTamperRejected(
        (artifact) => { artifact.queries[0].expectedDialogues[0].relevance = 5; },
        "judgment metric mismatch",
      );
      await assertJudgmentTamperRejected(
        (artifact) => {
          artifact.queries[0].mustNotMatchExamples = [{
            dialogueId: artifact.queries[0].expectedDialogues[0].dialogueId,
          }];
        },
        "must-not outcome mismatch",
      );
      await assertJudgmentTamperRejected(
        (artifact) => {
          artifact.queries[0].mustNotMatchExamples = [{ snippet: evaluationDocuments[0]!.content }];
        },
        "must-not outcome mismatch",
      );
      await assertJudgmentTamperRejected(
        (artifact) => {
          artifact.queries[0].mustNotMatchExamples = [{
            dialogueId: evaluationDocuments[0]!.dialogueId,
            snippet: evaluationDocuments[0]!.content,
          }];
        },
        "must-not outcome mismatch",
      );

      const tamperedTopIds = JSON.parse(originalEvaluation) as Record<string, any>;
      tamperedTopIds.scenarios[0].queries[0].topDialogueIds[0] = "dialogue:tampered-top";
      const tamperedTopIdsSource = `${JSON.stringify(tamperedTopIds)}\n`;
      await writeFile(relevance.evaluationReportPath, tamperedTopIdsSource);
      await expect(prepareProductionBackfill(t.db, space.slug, exact, {
        ...gate,
        acceptedRelevance: {
          ...relevance,
          evaluationReportSha256: testSha256(tamperedTopIdsSource),
        },
      })).rejects.toThrow("hit ranking evidence mismatch");
      await writeFile(relevance.evaluationReportPath, originalEvaluation);

      const originalCandidatePlan = await readFile(relevance.candidatePlanPath, "utf8");
      const blockedPlan = JSON.parse(originalCandidatePlan) as Record<string, any>;
      blockedPlan.blockers = ["tampered_blocker"];
      const {
        planSha256: _blockedPlanSha,
        confirmation: _blockedConfirmation,
        ...blockedBinding
      } = blockedPlan;
      blockedPlan.planSha256 = testCanonicalSha256(blockedBinding);
      blockedPlan.confirmation =
        `RUN EVALUATION CANDIDATES ${blockedPlan.fullEligibleCorpus.sha256} ${blockedPlan.planSha256}`;
      // Attacker removes the blocker and regenerates every outer artifact
      // hash, but cannot retain the blocker-bound inner plan hash.
      const tamperedPlan = { ...blockedPlan, blockers: [] };
      const tamperedPlanSource = `${JSON.stringify(tamperedPlan)}\n`;
      await writeFile(relevance.candidatePlanPath, tamperedPlanSource);
      const tamperedPlanArtifactSha256 = testSha256(tamperedPlanSource);
      const tamperedPlanReport = JSON.parse(originalEvaluation) as Record<string, any>;
      tamperedPlanReport.candidatePlan.artifactSha256 = tamperedPlanArtifactSha256;
      const tamperedPlanReportSource = `${JSON.stringify(tamperedPlanReport)}\n`;
      await writeFile(relevance.evaluationReportPath, tamperedPlanReportSource);
      await expect(prepareProductionBackfill(t.db, space.slug, exact, {
        ...gate,
        acceptedRelevance: {
          ...relevance,
          candidatePlanArtifactSha256: tamperedPlanArtifactSha256,
          evaluationReportSha256: testSha256(tamperedPlanReportSource),
        },
      })).rejects.toThrow("evaluation candidate plan SHA-256 mismatch");
      await writeFile(relevance.candidatePlanPath, originalCandidatePlan);

      const coveragePlan = JSON.parse(originalCandidatePlan) as Record<string, any>;
      const omittedDialogueId = coveragePlan.subset.documents[0].dialogueId;
      for (const document of coveragePlan.subset.documents) {
        if (document.dialogueId === omittedDialogueId) {
          document.dialogueId = "dialogue:coverage-tampered";
        }
      }
      const {
        planSha256: _coveragePlanSha,
        confirmation: _coverageConfirmation,
        ...coverageBinding
      } = coveragePlan;
      coveragePlan.planSha256 = testCanonicalSha256(coverageBinding);
      coveragePlan.confirmation =
        `RUN EVALUATION CANDIDATES ${coveragePlan.fullEligibleCorpus.sha256} ${coveragePlan.planSha256}`;
      const coveragePlanSource = `${JSON.stringify(coveragePlan)}\n`;
      await writeFile(relevance.candidatePlanPath, coveragePlanSource);
      const coverageReport = JSON.parse(originalEvaluation) as Record<string, any>;
      coverageReport.candidatePlan.artifactSha256 = testSha256(coveragePlanSource);
      coverageReport.candidatePlan.planSha256 = coveragePlan.planSha256;
      const coverageReportSource = `${JSON.stringify(coverageReport)}\n`;
      await writeFile(relevance.evaluationReportPath, coverageReportSource);
      await expect(prepareProductionBackfill(t.db, space.slug, exact, {
        ...gate,
        acceptedRelevance: {
          ...relevance,
          candidatePlanArtifactSha256: testSha256(coveragePlanSource),
          candidatePlanSha256: coveragePlan.planSha256,
          evaluationReportSha256: testSha256(coverageReportSource),
        },
      })).rejects.toThrow("omits required judgment dialogue");
      await writeFile(relevance.candidatePlanPath, originalCandidatePlan);
      await writeFile(relevance.evaluationReportPath, originalEvaluation);

      await writeFile(relevance.evaluationReportPath, `${originalEvaluation} `);
      await expect(
        prepareProductionBackfill(t.db, space.slug, exact, gate),
      ).rejects.toThrow("report SHA-256 mismatch");
      await writeFile(relevance.evaluationReportPath, originalEvaluation);
      const plan = await prepareProductionBackfill(t.db, space.slug, exact, {
        ...gate,
      });
      expect(plan.blockers).toEqual([]);
      expect(plan.jobs).toEqual({ pending: 4 });
      expect("completionAccepted" in plan).toBe(false);
      expect(plan.confirmation).toBe(
        `RUN EMBEDDINGS ${space.slug} ${exact.corpus.fingerprintSha256} ${plan.planSha256}`,
      );
      expect(plan.runnableJobs).toHaveLength(4);
      expect(plan.relevanceEvidence.acceptanceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(
        (
          await prepareProductionBackfill(t.db, space.slug, exact, {
            ...gate,
            maxJobs: 2,
          })
        ).confirmation,
      ).not.toBe(plan.confirmation);
      expect(
        (
          await prepareProductionBackfill(t.db, space.slug, exact, {
            ...gate,
            pricePer1MTokens: 0.75,
          })
        ).confirmation,
      ).not.toBe(plan.confirmation);

      const provider = new MockEmbeddingProvider({
        provider: space.provider,
        model: space.model,
        dimensions: space.dimensions,
      });
      await expect(
        runConfirmedProductionBackfill(t.db, mockFactory(provider), space.slug, {
          ...gate,
          exactReport: exact,
          confirmation: plan.confirmation,
          allowExternalProviderCalls: false,
        }),
      ).rejects.toThrow("allowExternalProviderCalls=true");

      // Any plan drift invalidates the full plan hash before provider calls.
      const [driftJob] = await allJobs(t);
      await t.db.query(`UPDATE ONLY $id SET status = "retryable_error"`, { id: driftJob!.id });
      const driftProvider = new MockEmbeddingProvider({
        provider: space.provider,
        model: space.model,
        dimensions: space.dimensions,
      });
      await expect(
        runConfirmedProductionBackfill(t.db, mockFactory(driftProvider), space.slug, {
          ...gate,
          exactReport: exact,
          confirmation: plan.confirmation,
          allowExternalProviderCalls: true,
        }),
      ).rejects.toThrow("confirmation mismatch");
      expect(driftProvider.calls).toBe(0);
      await t.db.query(`UPDATE ONLY $id SET status = "pending"`, { id: driftJob!.id });

      const wrongProvider = new MockEmbeddingProvider({ dimensions: space.dimensions });
      await expect(
        runConfirmedProductionBackfill(
          t.db,
          () => ({
            provider: "wrong-provider",
            model: wrongProvider.model,
            dimensions: wrongProvider.dimensions,
            embed: (texts) => wrongProvider.embed(texts),
          }),
          space.slug,
          {
            ...gate,
            exactReport: exact,
            confirmation: plan.confirmation,
            allowExternalProviderCalls: true,
          },
        ),
      ).rejects.toThrow("provider config");
      expect(wrongProvider.calls).toBe(0);

      const run = await runConfirmedProductionBackfill(t.db, mockFactory(provider), space.slug, {
        ...gate,
        exactReport: exact,
        confirmation: plan.confirmation,
        allowExternalProviderCalls: true,
        batchSize: 1,
      });
      expect(run.summary.completed).toBe(4);
      expect(provider.calls).toBe(4);

      const completed = await prepareProductionBackfill(t.db, space.slug, exact, {
        ...gate,
      });
      expect("completionAccepted" in completed).toBe(false);
      expect(completed.runnableJobs).toEqual([]);
      expect(completed.jobs).toEqual({ completed: 4 });
      expect((await auditVectorDimensions(t.db, space.slug)).wrongDimensions).toEqual([]);
      expect((await auditHnswIndex(t.db, space.slug)).usesKnnScan).toBe(true);
      const terminalAudit = await auditProductionEmbeddingSpace(
        t.db,
        space.slug,
        EMPTY_PRIVACY_POLICY,
      );
      expect(terminalAudit).toMatchObject({
        ok: true,
        documents: 4,
        eligibleDocuments: 4,
        privacyExcludedDocuments: 0,
        jobs: 4,
        vectors: 4,
        wrongDimensionVectors: [],
        hnswUsesKnnScan: true,
        hnswIndexName: "vector_hnsw",
        blockers: [],
      });

      let zeroWorkProviderConstructions = 0;
      const zeroWorkFactory: ProviderFactory = () => {
        zeroWorkProviderConstructions += 1;
        throw new Error("zero-work backfill must not construct a provider");
      };
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const zeroWork = await runConfirmedProductionBackfill(
          t.db,
          zeroWorkFactory,
          space.slug,
          {
            ...gate,
            exactReport: exact,
            confirmation: completed.confirmation,
            allowExternalProviderCalls: true,
          },
        );
        expect(zeroWork.summary).toEqual({
          completed: 0,
          failed: 0,
          permanentErrors: 0,
          privacyExcluded: 0,
          releasedStale: 0,
          promptTokens: 0,
          batches: 0,
        });
      }
      expect(zeroWorkProviderConstructions).toBe(0);

      // Candidate-matrix evidence authorizes the full backfill above, but a
      // distinct post-backfill full-corpus hybrid report gates Stage 11.
      const finalProvider = new MockEmbeddingProvider({
        provider: space.provider,
        model: space.model,
        dimensions: space.dimensions,
      });
      const finalScenario = await createFullCorpusHybridScenario(t.db, {
        spaceSlug: space.slug,
        providerFactory: mockFactory(finalProvider),
        allowEmbeddingQueries: true,
        confirmation: fullCorpusEvaluationConfirmation(
          space.slug,
          exact.corpus.fingerprintSha256,
        ),
        privacy: EMPTY_PRIVACY_POLICY,
        resourceMeasurements: {
          source: "isolated full-corpus fixture",
          vectorIndexBytes: 1,
          peakRamBytes: 1,
          indexBuildMs: 1,
        },
      });
      const finalReport = await runFullCorpusHybridEvaluation(
        await loadJudgmentSet(relevance.judgmentSetPath),
        finalScenario,
        {
          judgmentSetPath: relevance.judgmentSetPath,
          privacy: EMPTY_PRIVACY_POLICY,
          expectedCorpus: {
            algorithm: "sha256",
            sha256: exact.corpus.fingerprintSha256,
            documents: exact.corpus.documents,
          },
          now: () => new Date("2026-07-26T13:00:00.000Z"),
        },
      );
      expect(finalReport.evaluationKind).toBe("final_full_corpus_hybrid");
      expect(finalReport.corpus.documents).toBe(exact.corpus.documents);
      expect(finalReport.scenario.readiness?.eligibleDocuments).toBe(exact.corpus.documents);
      expect(finalProvider.calls).toBe(50);
      const finalReportPath = path.join(evidenceDirectory, "final-full-corpus.json");
      const finalSource = serializeFullCorpusEvaluationReport(finalReport);
      await writeFile(finalReportPath, finalSource, { mode: 0o600 });
      const expectedJudgmentArtifact = await pinExpectedJudgmentArtifact(
        relevance.judgmentSetPath,
        relevance.judgmentSetArtifactSha256,
        Buffer.byteLength(originalJudgment),
      );
      await expect(pinExpectedJudgmentArtifact(
        relevance.judgmentSetPath,
        "0".repeat(64),
        Buffer.byteLength(originalJudgment),
      )).rejects.toThrow("identity mismatch");
      await expect(pinExpectedJudgmentArtifact(
        relevance.judgmentSetPath,
        relevance.judgmentSetArtifactSha256,
        Buffer.byteLength(originalJudgment) + 1,
      )).rejects.toThrow("pinned size mismatch");
      const finalEvidence: AcceptedFullCorpusRelevanceEvidence = {
        formatVersion: 1,
        evaluationReportPath: finalReportPath,
        evaluationReportSha256: testSha256(finalSource),
        judgmentSetPath: relevance.judgmentSetPath,
        judgmentSetArtifactSha256: relevance.judgmentSetArtifactSha256,
        judgmentSetSha256: relevance.judgmentSetSha256,
        corpusFingerprintSha256: exact.corpus.fingerprintSha256,
        privacySha256: relevance.privacySha256,
        scenarioId: `full-corpus-hybrid:${space.slug}`,
        space: relevance.space,
        thresholds: {
          minimumRecallAt5: 0,
          minimumRecallAt10: 0,
          minimumMrr: 0,
          minimumNdcgAt10: 0,
          minimumExpectedSnippetRecall: 0,
          maximumIrrelevantTop5Share: 1,
          maximumMustNotMatchViolations: 50,
          maximumRetrievalFailures: 50,
        },
        humanAcceptance: {
          accepted: true,
          acceptedBy: "isolated-final-reviewer",
          acceptedAt: "2026-07-26T13:30:00.000Z",
          rationale: "isolated full-corpus acceptance",
        },
      };
      await expect(validateFullCorpusRelevanceAcceptance(finalEvidence, {
        privacy: EMPTY_PRIVACY_POLICY,
        expectedCorpus: finalReport.corpus,
        expectedSpace: space,
        db: t.db,
        expectedJudgmentArtifact,
      })).resolves.toMatchObject({ acceptanceSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      await expect(completeStage11(finalEvidence, {
        privacy: EMPTY_PRIVACY_POLICY,
        expectedCorpus: finalReport.corpus,
        expectedSpace: space,
        db: t.db,
        expectedJudgmentArtifact,
        now: () => new Date("2026-07-26T14:00:00.000Z"),
      })).resolves.toMatchObject({
        completionKind: "stage11_full_corpus_relevance",
        finalReportSha256: finalEvidence.evaluationReportSha256,
        expectedJudgmentArtifact,
        completionSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      const finalAcceptanceOptions = {
        privacy: EMPTY_PRIVACY_POLICY,
        expectedCorpus: finalReport.corpus,
        expectedSpace: space,
        db: t.db,
        expectedJudgmentArtifact,
      };
      await expect(completeStage11(finalEvidence, {
        ...finalAcceptanceOptions,
        expectedJudgmentArtifact: undefined as never,
      })).rejects.toThrow("identity required");

      const assertSemanticJudgmentForgeryRejected = async () => {
        const artifact = JSON.parse(originalJudgment) as Record<string, any>;
        const authoritativeContent = evaluationDocuments[0]!.content;
        const alternateExpectedSubstring = authoritativeContent.slice(
          0,
          Math.max(1, Math.min(16, authoritativeContent.length)),
        );
        artifact.queries[0].expectedSnippets = [{ text: alternateExpectedSubstring }];
        artifact.queries[1].mustNotMatchExamples = [{
          dialogueId: evaluationDocuments[0]!.dialogueId,
          snippet: "different-absent-negative-after-human-review",
        }];
        const judgmentSource = `${JSON.stringify(artifact)}\n`;
        const judgmentCanonicalSha = judgmentSetSha256(parseJudgmentSet(artifact));
        const report = JSON.parse(finalSource) as Record<string, any>;
        report.judgmentSet.artifactSha256 = testSha256(judgmentSource);
        report.judgmentSet.sha256 = judgmentCanonicalSha;
        const reportSource = `${JSON.stringify(report)}\n`;
        await writeFile(relevance.judgmentSetPath, judgmentSource);
        await writeFile(finalReportPath, reportSource);
        const selfGeneratedIdentity = await pinExpectedJudgmentArtifact(
          relevance.judgmentSetPath,
          testSha256(judgmentSource),
          Buffer.byteLength(judgmentSource),
        );
        const forgedEvidence = {
          ...finalEvidence,
          judgmentSetArtifactSha256: testSha256(judgmentSource),
          judgmentSetSha256: judgmentCanonicalSha,
          evaluationReportSha256: testSha256(reportSource),
        };
        await expect(validateFullCorpusRelevanceAcceptance(
          forgedEvidence,
          finalAcceptanceOptions,
        )).rejects.toThrow("judgment artifact");
        await expect(completeStage11(forgedEvidence, {
          ...finalAcceptanceOptions,
          now: () => new Date("2026-07-26T14:00:00.000Z"),
        })).rejects.toThrow("judgment artifact");
        await expect(validateFullCorpusRelevanceAcceptance({
          ...forgedEvidence,
          // An attacker may embed a new identity, but evidence is not a trust root.
          expectedJudgmentArtifact: selfGeneratedIdentity,
        } as AcceptedFullCorpusRelevanceEvidence & {
          expectedJudgmentArtifact: ExpectedJudgmentArtifactIdentity;
        }, finalAcceptanceOptions)).rejects.toThrow("supplied only in options");
        await expect(validateFullCorpusRelevanceAcceptance(forgedEvidence, {
          ...finalAcceptanceOptions,
          expectedJudgmentArtifact: undefined as never,
        })).rejects.toThrow("identity required");
        await writeFile(relevance.judgmentSetPath, originalJudgment);
        await writeFile(finalReportPath, finalSource);
      };
      await assertSemanticJudgmentForgeryRejected();

      await expect(validateFullCorpusRelevanceAcceptance(finalEvidence, {
        ...finalAcceptanceOptions,
        expectedJudgmentArtifact: {
          ...expectedJudgmentArtifact,
          sha256: "0".repeat(64),
        },
      })).rejects.toThrow("identity mismatch");
      await expect(validateFullCorpusRelevanceAcceptance(finalEvidence, {
        ...finalAcceptanceOptions,
        expectedJudgmentArtifact: {
          ...expectedJudgmentArtifact,
          sizeBytes: expectedJudgmentArtifact.sizeBytes + 1,
        },
      })).rejects.toThrow("pinned size mismatch");

      const sameSizeJudgmentMutation = originalJudgment.replace(
        '"name": "private"',
        '"name": "PRIVATE"',
      );
      expect(Buffer.byteLength(sameSizeJudgmentMutation)).toBe(
        Buffer.byteLength(originalJudgment),
      );
      await writeFile(relevance.judgmentSetPath, sameSizeJudgmentMutation);
      await expect(validateFullCorpusRelevanceAcceptance(
        finalEvidence,
        finalAcceptanceOptions,
      )).rejects.toThrow("identity mismatch");
      await writeFile(relevance.judgmentSetPath, originalJudgment);

      const otherJudgmentPath = path.join(evidenceDirectory, "other-judgments.json");
      await writeFile(otherJudgmentPath, originalJudgment, { mode: 0o600 });
      const otherJudgmentIdentity = await pinExpectedJudgmentArtifact(
        otherJudgmentPath,
        relevance.judgmentSetArtifactSha256,
        Buffer.byteLength(originalJudgment),
      );
      await expect(validateFullCorpusRelevanceAcceptance(finalEvidence, {
        ...finalAcceptanceOptions,
        expectedJudgmentArtifact: otherJudgmentIdentity,
      })).rejects.toThrow("path mismatch");
      await expect(validateFullCorpusRelevanceAcceptance({
        ...finalEvidence,
        judgmentSetPath: otherJudgmentPath,
      }, finalAcceptanceOptions)).rejects.toThrow("path mismatch");

      const symlinkJudgmentPath = path.join(evidenceDirectory, "judgments-symlink.json");
      await symlink(relevance.judgmentSetPath, symlinkJudgmentPath);
      const symlinkStats = await lstat(symlinkJudgmentPath, { bigint: true });
      const symlinkIdentity: ExpectedJudgmentArtifactIdentity = {
        ...expectedJudgmentArtifact,
        resolvedPath: path.resolve(symlinkJudgmentPath),
        realPath: await realpath(symlinkJudgmentPath),
        sizeBytes: Number(symlinkStats.size),
        device: String(symlinkStats.dev),
        inode: String(symlinkStats.ino),
      };
      await expect(validateFullCorpusRelevanceAcceptance({
        ...finalEvidence,
        judgmentSetPath: symlinkJudgmentPath,
      }, {
        ...finalAcceptanceOptions,
        expectedJudgmentArtifact: symlinkIdentity,
      })).rejects.toThrow("stable_open_error");
      await rm(symlinkJudgmentPath);

      const replacementBackupPath = path.join(evidenceDirectory, "judgments-original.json");
      const replacementNewPath = path.join(evidenceDirectory, "judgments-replacement.json");
      await rename(relevance.judgmentSetPath, replacementBackupPath);
      await writeFile(relevance.judgmentSetPath, originalJudgment, { mode: 0o600 });
      await expect(validateFullCorpusRelevanceAcceptance(
        finalEvidence,
        finalAcceptanceOptions,
      )).rejects.toThrow("external identity mismatch");
      await rename(relevance.judgmentSetPath, replacementNewPath);
      await rename(replacementBackupPath, relevance.judgmentSetPath);
      await rm(replacementNewPath);

      const raceBackupPath = path.join(evidenceDirectory, "judgments-race-original.json");
      const raceNewPath = path.join(evidenceDirectory, "judgments-race-new.json");
      const racedValidation = validateFullCorpusRelevanceAcceptance(finalEvidence, {
        ...finalAcceptanceOptions,
        testOnlyJudgmentReadDelayMs: 250,
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await rename(relevance.judgmentSetPath, raceBackupPath);
      await writeFile(relevance.judgmentSetPath, originalJudgment, { mode: 0o600 });
      await expect(racedValidation).rejects.toThrow("judgment artifact");
      await rename(relevance.judgmentSetPath, raceNewPath);
      await rename(raceBackupPath, relevance.judgmentSetPath);
      await rm(raceNewPath);

      const assertRegeneratedNegativeForgeryRejected = async (
        queryIndex: number,
        withDialogue: boolean,
      ) => {
        const judgmentArtifact = JSON.parse(
          await readFile(relevance.judgmentSetPath, "utf8"),
        ) as Record<string, any>;
        const attackSnippet = `attacker-regenerated-negative-${queryIndex}`;
        const queryJudgment = judgmentArtifact.queries[queryIndex];
        queryJudgment.mustNotMatchExamples = [{
          ...(withDialogue ? { dialogueId: queryJudgment.expectedDialogues[0].dialogueId } : {}),
          snippet: attackSnippet,
        }];
        const judgmentSource = `${JSON.stringify(judgmentArtifact)}\n`;
        const judgmentCanonicalSha = judgmentSetSha256(parseJudgmentSet(judgmentArtifact));
        const report = JSON.parse(finalSource) as Record<string, any>;
        report.judgmentSet.artifactSha256 = testSha256(judgmentSource);
        report.judgmentSet.sha256 = judgmentCanonicalSha;
        const hit = report.scenario.queries[queryIndex].hitEvidence[0];
        const content = report.scenario.contentEvidence.find(
          (item: Record<string, unknown>) => item.documentId === hit.documentId,
        );
        content.content = attackSnippet;
        content.contentSha256 = testSha256(attackSnippet);
        for (const query of report.scenario.queries) {
          for (const item of query.hitEvidence) {
            if (item.documentId === hit.documentId) item.contentSha256 = content.contentSha256;
          }
        }
        const corpusDocument = report.corpusDocuments.find(
          (item: Record<string, unknown>) => item.documentId === hit.documentId,
        );
        corpusDocument.contentSha256 = content.contentSha256;
        const forgedFingerprint = eligibleCorpusFingerprint(
          report.corpusDocuments.map((item: Record<string, string>) => ({
            id: item.documentId,
            contentSha256: item.contentSha256,
          })),
        );
        report.corpus = forgedFingerprint;
        report.scenario.corpusChecks = {
          before: forgedFingerprint,
          after: forgedFingerprint,
        };
        const reportSource = `${JSON.stringify(report)}\n`;
        await writeFile(relevance.judgmentSetPath, judgmentSource);
        await writeFile(finalReportPath, reportSource);
        const forgedEvidence = {
          ...finalEvidence,
          judgmentSetArtifactSha256: testSha256(judgmentSource),
          judgmentSetSha256: judgmentCanonicalSha,
          evaluationReportSha256: testSha256(reportSource),
          corpusFingerprintSha256: forgedFingerprint.sha256,
        };
        await expect(validateFullCorpusRelevanceAcceptance(
          forgedEvidence,
          finalAcceptanceOptions,
        )).rejects.toThrow("judgment artifact");
        await expect(completeStage11(forgedEvidence, {
          ...finalAcceptanceOptions,
          now: () => new Date("2026-07-26T14:00:00.000Z"),
        })).rejects.toThrow("judgment artifact");
        await writeFile(relevance.judgmentSetPath, originalJudgment);
        await writeFile(finalReportPath, finalSource);
      };
      await assertRegeneratedNegativeForgeryRejected(0, false);
      await assertRegeneratedNegativeForgeryRejected(1, true);

      const assertFinalReportMutationRejected = async (
        mutate: (report: Record<string, any>) => void,
        message: string,
      ) => {
        const report = JSON.parse(finalSource) as Record<string, any>;
        mutate(report);
        const source = `${JSON.stringify(report)}\n`;
        await writeFile(finalReportPath, source);
        await expect(validateFullCorpusRelevanceAcceptance({
          ...finalEvidence,
          evaluationReportSha256: testSha256(source),
        }, finalAcceptanceOptions)).rejects.toThrow(message);
        await writeFile(finalReportPath, finalSource);
      };
      await assertFinalReportMutationRejected((report) => {
        report.scenario.contentEvidence[0].content += " altered bytes";
      }, "authoritative content bytes mismatch");
      await assertFinalReportMutationRejected((report) => {
        report.scenario.contentEvidence[0].contentSha256 = "a".repeat(64);
        for (const query of report.scenario.queries) {
          for (const hit of query.hitEvidence) {
            if (hit.documentId === report.scenario.contentEvidence[0].documentId) {
              hit.contentSha256 = "a".repeat(64);
            }
          }
        }
      }, "authoritative content bytes mismatch");
      await assertFinalReportMutationRejected((report) => {
        report.scenario.contentEvidence.shift();
      }, "hit content evidence missing");
      await assertFinalReportMutationRejected((report) => {
        report.scenario.contentEvidence.push({
          documentId: "search_document:unrelated-proof",
          dialogueId: "dialogue:unrelated-proof",
          revisionId: "dialogue_revision:unrelated-proof",
          contentSha256: testSha256("unrelated proof"),
          content: "unrelated proof",
        });
      }, "differs from authoritative corpus");
      await assertFinalReportMutationRejected((report) => {
        const first = report.corpusDocuments[0];
        const second = report.corpusDocuments[1];
        [first.contentSha256, second.contentSha256] = [second.contentSha256, first.contentSha256];
      }, "fresh DB snapshot");

      const tamperedFinal = JSON.parse(finalSource) as Record<string, any>;
      tamperedFinal.scenario.aggregate.recallAt5 =
        tamperedFinal.scenario.aggregate.recallAt5 === 1 ? 0 : 1;
      const tamperedFinalSource = `${JSON.stringify(tamperedFinal)}\n`;
      await writeFile(finalReportPath, tamperedFinalSource);
      await expect(validateFullCorpusRelevanceAcceptance({
        ...finalEvidence,
        evaluationReportSha256: testSha256(tamperedFinalSource),
      }, {
        privacy: EMPTY_PRIVACY_POLICY,
        expectedCorpus: finalReport.corpus,
        expectedSpace: space,
        db: t.db,
        expectedJudgmentArtifact,
      })).rejects.toThrow("aggregate mismatch");
      await writeFile(finalReportPath, finalSource);
      await expect(validateFullCorpusRelevanceAcceptance(
        relevance as unknown as AcceptedFullCorpusRelevanceEvidence,
        {
          privacy: EMPTY_PRIVACY_POLICY,
          expectedCorpus: finalReport.corpus,
          expectedSpace: space,
          db: t.db,
          expectedJudgmentArtifact,
        },
      )).rejects.toThrow("final full-corpus relevance evidence required");
      await expect(completeStage11(
        relevance as unknown as AcceptedFullCorpusRelevanceEvidence,
        {
          privacy: EMPTY_PRIVACY_POLICY,
          expectedCorpus: finalReport.corpus,
          expectedSpace: space,
          db: t.db,
          expectedJudgmentArtifact,
        },
      )).rejects.toThrow("final full-corpus relevance evidence required");

      const [document] = await selectAll<{
        id: RecordId;
        content_sha256: string;
        extraction_version: string;
        segmentation_version: string;
      }>(
        t.db,
        "SELECT id, content_sha256, extraction_version, segmentation_version FROM search_document ORDER BY id LIMIT 1",
      );
      const [completedJob] = await selectAll<{
        id: RecordId;
        search_document: RecordId;
        input_sha256: string;
      }>(
        t.db,
        "SELECT id, search_document, input_sha256 FROM embedding_job WHERE search_document = $doc",
        { doc: document!.id },
      );
      const [completedVector] = await selectAll<{ id: RecordId; input_sha256: string }>(
        t.db,
        `SELECT id, input_sha256 FROM ${space.physical_table} WHERE search_document = $doc`,
        { doc: document!.id },
      );
      await t.db.query("UPDATE ONLY $id SET input_sha256 = $hash", {
        id: completedJob!.id,
        hash: "0".repeat(64),
      });
      const staleJob = await prepareProductionBackfill(t.db, space.slug, exact, gate);
      expect(staleJob.blockers.some((item) => item.includes("job input hash"))).toBe(true);
      await t.db.query("UPDATE ONLY $id SET input_sha256 = $hash", {
        id: completedJob!.id,
        hash: document!.content_sha256,
      });

      await t.db.query("UPDATE ONLY $id SET extraction_version = 'stale'", { id: document!.id });
      expect(
        (await prepareProductionBackfill(t.db, space.slug, exact, gate)).blockers.some((item) =>
          item.includes("extraction_version"),
        ),
      ).toBe(true);
      await t.db.query("UPDATE ONLY $id SET extraction_version = $version", {
        id: document!.id,
        version: String(EXTRACTOR_VERSION),
      });
      await t.db.query("UPDATE ONLY $id SET segmentation_version = 'stale'", { id: document!.id });
      expect(
        (await prepareProductionBackfill(t.db, space.slug, exact, gate)).blockers.some((item) =>
          item.includes("segmentation_version"),
        ),
      ).toBe(true);
      await t.db.query("UPDATE ONLY $id SET segmentation_version = $version", {
        id: document!.id,
        version: SEGMENTATION_VERSION,
      });

      await t.db.query("UPDATE ONLY $id SET input_sha256 = $hash", {
        id: completedVector!.id,
        hash: "0".repeat(64),
      });
      expect(
        (await prepareProductionBackfill(t.db, space.slug, exact, gate)).blockers.some((item) =>
          item.includes("stale vector"),
        ),
      ).toBe(true);
      await t.db.query("UPDATE ONLY $id SET input_sha256 = $hash", {
        id: completedVector!.id,
        hash: document!.content_sha256,
      });

      await t.db.query(
        `CREATE type::record("${space.physical_table}", "orphan_test") SET
         search_document = type::record("search_document", "missing"),
         embedding_space = $space, input_sha256 = $hash, vector = $vector,
         prompt_tokens = 1, created_at = time::now()`,
        {
          space: space.id,
          hash: "0".repeat(64),
          vector: Array.from({ length: space.dimensions }, () => 0),
        },
      );
      const orphanVector = await prepareProductionBackfill(t.db, space.slug, exact, gate);
      expect(orphanVector.blockers.some((item) => item.includes("extra/orphan vector"))).toBe(true);
      await t.db.query(`DELETE type::record("${space.physical_table}", "orphan_test")`);

      // Candidate-space search is independent from active metadata.
      const hits = await searchVectorInSpace(t.db, provider, space, PROMPT_A, filters());
      expect(hits[0]!.dialogueTitle).toBe("Диалог emb_a");
      expect(await getActiveSpace(t.db)).toBeUndefined();

      // A documented permanent provider error removes exactly that document
      // from vector coverage without removing it from the privacy-normalized
      // full distractor corpus used by the final hybrid evaluation.
      await t.db.query(
        `UPDATE ONLY $id SET status = "permanent_error",
           last_error = "provider_permanent_error", completed_at = NONE,
           locked_by = NONE, locked_at = NONE`,
        { id: completedJob!.id },
      );
      await t.db.query("DELETE ONLY $id", { id: completedVector!.id });
      const permanentExclusions = [{
        category: "permanent" as const,
        code: "provider_permanent_error",
        jobId: String(completedJob!.id),
        documentId: String(completedJob!.search_document),
        evidence: "stage11-permanent-error-test",
      }];
      const permanentReadiness = await collectEvaluationReadiness(t.db, space, {
        privacy: EMPTY_PRIVACY_POLICY,
        documentedExclusions: permanentExclusions,
      });
      expect(permanentReadiness).toMatchObject({
        documents: exact.corpus.documents,
        completedJobs: exact.corpus.documents - 1,
        vectors: exact.corpus.documents - 1,
        privacyNormalizedDocuments: exact.corpus.documents,
        privacyExcludedDocuments: 0,
        permanentExcludedDocuments: 1,
        eligibleDocuments: exact.corpus.documents - 1,
        vectorCoverageErrors: 0,
      });
      const permanentProvider = new MockEmbeddingProvider({
        provider: space.provider,
        model: space.model,
        dimensions: space.dimensions,
      });
      const permanentScenario = await createFullCorpusHybridScenario(t.db, {
        spaceSlug: space.slug,
        providerFactory: mockFactory(permanentProvider),
        allowEmbeddingQueries: true,
        confirmation: fullCorpusEvaluationConfirmation(
          space.slug,
          exact.corpus.fingerprintSha256,
        ),
        privacy: EMPTY_PRIVACY_POLICY,
        documentedExclusions: permanentExclusions,
        resourceMeasurements: {
          source: "isolated permanent-error full-corpus fixture",
          vectorIndexBytes: 1,
          peakRamBytes: 1,
          indexBuildMs: 1,
        },
      });
      const permanentFinalReport = await runFullCorpusHybridEvaluation(
        await loadJudgmentSet(relevance.judgmentSetPath),
        permanentScenario,
        {
          judgmentSetPath: relevance.judgmentSetPath,
          privacy: EMPTY_PRIVACY_POLICY,
          expectedCorpus: finalReport.corpus,
          now: () => new Date("2026-07-26T15:00:00.000Z"),
        },
      );
      expect(permanentFinalReport.scenario.readiness).toMatchObject({
        privacyNormalizedDocuments: exact.corpus.documents,
        permanentExcludedDocuments: 1,
        eligibleDocuments: exact.corpus.documents - 1,
      });
      const permanentFinalPath = path.join(
        evidenceDirectory,
        "final-full-corpus-permanent.json",
      );
      const permanentFinalSource = serializeFullCorpusEvaluationReport(permanentFinalReport);
      await writeFile(permanentFinalPath, permanentFinalSource, { mode: 0o600 });
      const permanentEvidence: AcceptedFullCorpusRelevanceEvidence = {
        ...finalEvidence,
        evaluationReportPath: permanentFinalPath,
        evaluationReportSha256: testSha256(permanentFinalSource),
      };
      await expect(validateFullCorpusRelevanceAcceptance(permanentEvidence, {
        privacy: EMPTY_PRIVACY_POLICY,
        expectedCorpus: finalReport.corpus,
        expectedSpace: space,
        db: t.db,
        expectedJudgmentArtifact,
      })).resolves.toMatchObject({
        acceptanceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

    } finally {
      await dropTestDb(t);
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
  });
});
