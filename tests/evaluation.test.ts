import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SearchHit } from "../src/search/fulltext.ts";
import {
  evaluationCandidateConfirmation,
  writeEvaluationCandidatePlan,
  type EvaluationCandidatePlan,
} from "../src/embeddings/backfill.ts";
import { eligibleCorpusFingerprint } from "../src/embeddings/token-count.ts";
import {
  ALLOWED_QUERY_TYPES,
  EVALUATION_CANDIDATE_LIMIT,
  calculateQueryMetrics,
  distinctDialogueHits,
  judgmentSetSha256,
  loadJudgmentSet,
  parseJudgmentSet,
  runRelevanceEvaluation,
  serializeEvaluationReport,
  writeEvaluationReport,
  type EvaluationReadinessEvidence,
  type EvaluationResourceMeasurements,
  type EvaluationScenario,
  type RelevanceJudgmentSet,
  type SearchCorpusFingerprint,
} from "../src/search/evaluation.ts";

function rawQuery(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    query: `private query ${id}`,
    expectedDialogues: [{ dialogueId: `dialogue:${id}`, relevance: 2 }],
    expectedSnippets: [{ text: `expected snippet ${id}`, dialogueId: `dialogue:${id}` }],
    mustNotMatchExamples: [{ snippet: `forbidden-${id}` }],
    queryLanguage: "ru",
    queryType: "semantic paraphrase",
    ...overrides,
  };
}

function smallSet(...queries: ReturnType<typeof rawQuery>[]): RelevanceJudgmentSet {
  return parseJudgmentSet(
    { formatVersion: 1, name: "private-stage11", queries },
    { minQueries: 1, maxQueries: 10 },
  );
}

function productionSet(): RelevanceJudgmentSet {
  return parseJudgmentSet({
    formatVersion: 1,
    name: "private-stage11",
    queries: Array.from({ length: 50 }, (_, index) => rawQuery(`q${index}`, {
      queryType: ALLOWED_QUERY_TYPES[index % ALLOWED_QUERY_TYPES.length],
      queryLanguage: (["ru", "en", "mixed"] as const)[index % 3],
    })),
  });
}

function hit(dialogueId: string, snippet = "", id = `doc:${dialogueId}`): SearchHit {
  return { id, score: 1, snippet, dialogueId, revisionId: `revision:${dialogueId}` };
}

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

function testCanonicalSha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalTest(value))).digest("hex");
}

const TEST_SET = productionSet();
const TEST_CONTENT = new Map<string, string>();
const TEST_DOCUMENTS = TEST_SET.queries.map((query, index) => {
  const documentId = `search_document:test-${index}`;
  const content = `authoritative expected snippet q${index}${index === 0 ? " forbidden-q0" : ""}`;
  TEST_CONTENT.set(documentId, content);
  return {
    documentId,
    dialogueId: query.expectedDialogues[0]!.dialogueId,
    revisionId: `revision:${query.expectedDialogues[0]!.dialogueId}`,
    contentSha256: createHash("sha256").update(content).digest("hex"),
    extractionVersion: "2",
    segmentationVersion: "2",
  };
});
const CORPUS: SearchCorpusFingerprint = eligibleCorpusFingerprint(
  TEST_DOCUMENTS.map((document) => ({
    id: document.documentId,
    contentSha256: document.contentSha256,
  })),
);
const CANDIDATE_BINDING = {
  formatVersion: 1 as const,
  fullEligibleCorpus: CORPUS,
  subset: {
    limit: TEST_DOCUMENTS.length,
    selectionSeedSha256: createHash("sha256").update("selection-seed").digest("hex"),
    fingerprint: CORPUS,
    documents: TEST_DOCUMENTS,
  },
  privacy: {
    excludeHarnesses: [],
    excludeWorkspaces: [],
    excludeDocumentTypes: [],
  },
  requiredDialogueIdsSha256: testCanonicalSha(
    [...new Set(TEST_SET.queries.flatMap((query) =>
      query.expectedDialogues.map((dialogue) => dialogue.dialogueId),
    ))].sort(),
  ),
  maxJobsPerSpace: 50,
  spaces: [
    { slug: "small-1536", model: "text-embedding-3-small", dimensions: 1536 },
    { slug: "large-1024", model: "text-embedding-3-large", dimensions: 1024 },
    { slug: "large-3072", model: "text-embedding-3-large", dimensions: 3072 },
  ].map((descriptor) => {
    const jobs = TEST_DOCUMENTS.map((document, index) => ({
      jobId: `embedding_job:${descriptor.slug}-${index}`,
      documentId: document.documentId,
      inputSha256: document.contentSha256,
      status: "pending",
      createdAt: "2026-07-26T10:00:00.000Z",
    }));
    return {
      space: { provider: "openai", ...descriptor },
      jobs,
      runnableJobs: jobs,
      vectors: [],
    };
  }),
  blockers: [],
};
const CANDIDATE_PLAN_SHA = testCanonicalSha(CANDIDATE_BINDING);
const CANDIDATE_PLAN: EvaluationCandidatePlan = {
  ...CANDIDATE_BINDING,
  planSha256: CANDIDATE_PLAN_SHA,
  confirmation: evaluationCandidateConfirmation(CORPUS.sha256, CANDIDATE_PLAN_SHA),
};
const ARTIFACT_DIR = await mkdtemp(path.join(os.tmpdir(), "baka-evaluation-artifacts-"));
const JUDGMENT_PATH = path.join(ARTIFACT_DIR, "judgments.json");
const CANDIDATE_PATH = path.join(ARTIFACT_DIR, "candidate.json");
await writeFile(JUDGMENT_PATH, `${JSON.stringify(TEST_SET, null, 2)}\n`, { mode: 0o600 });
await writeEvaluationCandidatePlan(CANDIDATE_PATH, CANDIDATE_PLAN);
afterAll(async () => rm(ARTIFACT_DIR, { recursive: true, force: true }));
const ARTIFACT_OPTIONS = {
  judgmentSetPath: JUDGMENT_PATH,
  candidatePlanPath: CANDIDATE_PATH,
};

function readiness(dimensions: number): EvaluationReadinessEvidence {
  return {
    source: "isolated test audit",
    documents: CORPUS.documents,
    jobs: CORPUS.documents,
    completedJobs: CORPUS.documents,
    vectors: CORPUS.documents,
    jobCoverageErrors: 0,
    vectorCoverageErrors: 0,
    inputHashErrors: 0,
    expectedDimensions: dimensions,
    wrongDimensionVectors: 0,
    hnswIndexName: "vector_hnsw",
    hnswUsesKnnScan: true,
    privacyNormalizedDocuments: CORPUS.documents,
    privacyExcludedDocuments: 0,
    permanentExcludedDocuments: 0,
    eligibleDocuments: CORPUS.documents,
    exclusions: [],
  };
}

const RESOURCES: EvaluationResourceMeasurements = {
  source: "isolated observer",
  vectorIndexBytes: 1234,
  peakRamBytes: 5678,
  indexBuildMs: 90,
};

function resultHits(query: string): SearchHit[] {
  const id = query.split(" ").at(-1)!;
  const index = Number(id.slice(1));
  const expected = TEST_DOCUMENTS[index]!;
  const noise = Array.from({ length: 9 }, (_, offset) =>
    TEST_DOCUMENTS[(index + offset + 1) % TEST_DOCUMENTS.length]!);
  return [
    hit(expected.dialogueId, "untrusted search snippet", expected.documentId),
    hit(expected.dialogueId, "different untrusted snippet", expected.documentId),
    ...noise.map((document) =>
      hit(document.dialogueId, "noise", document.documentId)),
  ];
}

function evidenceForHits(hits: readonly SearchHit[]) {
  const hitEvidence = hits.map((item) => {
    const document = TEST_DOCUMENTS.find(({ documentId }) => documentId === item.id)!;
    return {
      documentId: item.id,
      dialogueId: item.dialogueId,
      revisionId: item.revisionId,
      contentSha256: document.contentSha256,
    };
  });
  const contentEvidence = [...new Set(hits.map((item) => item.id))].map((documentId) => {
    const document = TEST_DOCUMENTS.find((item) => item.documentId === documentId)!;
    return {
      documentId,
      dialogueId: document.dialogueId,
      revisionId: document.revisionId,
      contentSha256: document.contentSha256,
      content: TEST_CONTENT.get(documentId)!,
    };
  }).sort((a, b) => a.documentId.localeCompare(b.documentId));
  return { hitEvidence, contentEvidence };
}

function completeMatrix(
  onFilters?: (limit: number) => void,
): EvaluationScenario[] {
  const scenarios: EvaluationScenario[] = [
    {
      id: "bm25",
      mode: "text",
      evaluationScope: "candidate_subset",
      candidatePlanSha256: CANDIDATE_PLAN.planSha256,
      corpusFingerprint: async () => CORPUS,
      search: async (query, filters) => {
        onFilters?.(filters.limit);
        const hits = resultHits(query);
        return { hits, ...evidenceForHits(hits), providerLatencyMs: 0, retrievalLatencyMs: 0 };
      },
    },
  ];
  for (const candidate of [
    { slug: "small-1536", model: "text-embedding-3-small", dimensions: 1536 },
    { slug: "large-1024", model: "text-embedding-3-large", dimensions: 1024 },
    { slug: "large-3072", model: "text-embedding-3-large", dimensions: 3072 },
  ]) {
    const space = { provider: "openai", ...candidate };
    const evidence = readiness(candidate.dimensions);
    for (const mode of ["vector", "hybrid"] as const) {
      scenarios.push({
        id: `${mode}:${candidate.slug}`,
        mode,
        space,
        readiness: evidence,
        evaluationScope: "candidate_subset",
        candidatePlanSha256: CANDIDATE_PLAN.planSha256,
        resourceMeasurements: RESOURCES,
        corpusFingerprint: async () => CORPUS,
        search: async (query, filters) => {
          onFilters?.(filters.limit);
          const hits = resultHits(query);
          return {
            hits,
            ...evidenceForHits(hits),
            providerLatencyMs: 1,
            retrievalLatencyMs: 2,
          };
        },
      });
    }
  }
  return scenarios;
}

describe("private relevance judgment set (§21)", () => {
  test("production parser and runner both enforce 50–100", async () => {
    const fortyNine = Array.from({ length: 49 }, (_, index) => rawQuery(`q${index}`));
    expect(() => parseJudgmentSet({ formatVersion: 1, name: "too-small", queries: fortyNine }))
      .toThrow("50–100");
    const bypassed = smallSet(rawQuery("only"));
    await expect(runRelevanceEvaluation(bypassed, completeMatrix(), {
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("50–100");
  });

  test("runner requires every query class plus RU/EN/mixed coverage", async () => {
    const missingTypes = parseJudgmentSet({
      formatVersion: 1,
      name: "missing-types",
      queries: Array.from({ length: 50 }, (_, index) => rawQuery(`m${index}`, {
        queryLanguage: (["ru", "en", "mixed"] as const)[index % 3],
      })),
    });
    await expect(runRelevanceEvaluation(missingTypes, completeMatrix(), {
      corpusFingerprint: async () => CORPUS,
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("отсутствует query type");

    const missingEnglish = parseJudgmentSet({
      formatVersion: 1,
      name: "missing-language",
      queries: Array.from({ length: 50 }, (_, index) => rawQuery(`l${index}`, {
        queryType: ALLOWED_QUERY_TYPES[index % ALLOWED_QUERY_TYPES.length],
        queryLanguage: index % 2 === 0 ? "ru" : "mixed",
      })),
    });
    await expect(runRelevanceEvaluation(missingEnglish, completeMatrix(), {
      corpusFingerprint: async () => CORPUS,
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("отсутствует language en");
  });

  test("allows only the ten §21 query classes and known languages", () => {
    for (const [index, queryType] of ALLOWED_QUERY_TYPES.entries()) {
      expect(smallSet(rawQuery(`q${index}`, { queryType })).queries[0]!.queryType).toBe(queryType);
    }
    expect(() => smallSet(rawQuery("bad", { queryType: "other" }))).toThrow("недопустимое");
    expect(() => smallSet(rawQuery("bad", { queryLanguage: "de" }))).toThrow("недопустимое");
  });

  test("requires expected snippet and must-not coverage for every query", () => {
    expect(() => smallSet(rawQuery("missing", { expectedSnippets: [] }))).toThrow(
      "expectedSnippets",
    );
    expect(() => smallSet(rawQuery("missing", { mustNotMatchExamples: [] }))).toThrow(
      "mustNotMatchExamples",
    );
  });

  test("normalizes shorthand, filters, duplicate ids and stable hash", () => {
    const set = smallSet(
      rawQuery("q1", {
        expectedDialogues: ["dialogue:a", { dialogueId: "dialogue:b", relevance: 3 }],
        expectedSnippets: ["needle"],
        mustNotMatchExamples: ["forbidden"],
        filters: { deletedOnly: true, user: "example", vendor: "openai" },
      }),
    );
    expect(set.queries[0]!.expectedDialogues).toEqual([
      { dialogueId: "dialogue:a", relevance: 1 },
      { dialogueId: "dialogue:b", relevance: 3 },
    ]);
    expect(set.queries[0]!.filters).toMatchObject({
      deletedOnly: true,
      user: "example",
      vendor: "openai",
    });
    expect(() =>
      smallSet(rawQuery("forensic", { filters: { allRevisions: true } })),
    ).toThrow('неизвестный filter "allRevisions"');
    expect(() => smallSet(rawQuery("same"), rawQuery("same"))).toThrow("дубликат");
    expect(judgmentSetSha256(set)).toBe(judgmentSetSha256(set));
    expect(judgmentSetSha256(set)).not.toBe(
      judgmentSetSha256(smallSet(rawQuery("q1", { query: "different" }))),
    );
  });

  test("invalid private JSON reports stable code and line without echo", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baka-evaluation-error-"));
    try {
      const file = path.join(dir, "private.json");
      await writeFile(file, "{\n  \"secret\": SUPER_PRIVATE\n}");
      let message = "";
      try {
        await loadJudgmentSet(file);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("judgment_set_invalid_json");
      expect(message).toContain("line=2");
      expect(message).not.toContain("SUPER_PRIVATE");
      expect(message).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("relevance metrics (§21)", () => {
  test("Recall@10 ranks ten distinct dialogues despite repeated segments", () => {
    const judgment = smallSet(rawQuery("q", {
      expectedDialogues: [{ dialogueId: "relevant", relevance: 3 }],
    })).queries[0]!;
    const ranked = [
      hit("noise-0"),
      hit("noise-0", "second segment", "doc:noise-0:1"),
      ...Array.from({ length: 8 }, (_, index) => hit(`noise-${index + 1}`)),
      hit("relevant"),
    ];
    expect(distinctDialogueHits(ranked)).toHaveLength(10);
    expect(calculateQueryMetrics(judgment, ranked)).toMatchObject({
      recallAt5: 0,
      recallAt10: 1,
      mrr: 0.1,
      distinctDialoguesRanked: 10,
      dialogueCandidateShortfall: 0,
    });
  });

  test("empty retrieval is explicitly failed and maximally irrelevant", () => {
    const metrics = calculateQueryMetrics(smallSet(rawQuery("q")).queries[0]!, []);
    expect(metrics).toMatchObject({
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      ndcgAt10: 0,
      irrelevantTop5Share: 1,
      retrievalFailed: true,
      dialogueCandidateShortfall: 10,
    });
  });
});

describe("reproducible evaluation report", () => {
  test("enforces matrix, fingerprints, readiness, wide candidates and split latency", async () => {
    const limits: number[] = [];
    let fingerprintReads = 0;
    const report = await runRelevanceEvaluation(productionSet(), completeMatrix((limit) => {
      limits.push(limit);
    }), {
      now: () => new Date("2026-07-26T12:00:00Z"),
      corpusFingerprint: async () => {
        fingerprintReads += 1;
        return CORPUS;
      },
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    });
    expect(fingerprintReads).toBe(14);
    expect(limits.every((limit) => limit === EVALUATION_CANDIDATE_LIMIT)).toBe(true);
    expect(report.corpus).toEqual(CORPUS);
    expect(report.scenarios).toHaveLength(7);
    expect(report.scenarios.every((scenario) => scenario.corpusChecks.before.sha256 === CORPUS.sha256))
      .toBe(true);
    const bm25 = report.scenarios[0]!;
    expect(bm25.queries[0]).toMatchObject({
      returnedDialogues: 10,
      matchedExpectedSnippets: 1,
      mustNotMatchViolations: 1,
      dialogueCandidateShortfall: 0,
    });
    const vector = report.scenarios.find((scenario) => scenario.mode === "vector")!;
    expect(vector.aggregate.latencyMs.mean).toBe(3);
    expect(vector.aggregate.providerLatencyMs.mean).toBe(1);
    expect(vector.aggregate.retrievalLatencyMs.mean).toBe(2);
    expect(vector.resourceMeasurements).toEqual(RESOURCES);
    expect(vector.readiness?.hnswUsesKnnScan).toBe(true);
    expect(vector.queries[0]!.query).toBeUndefined();
    const json = serializeEvaluationReport(report);
    expect(json).not.toContain("private query q0");
    expect(json).toContain('"hitEvidence"');
    expect(json).toBe(serializeEvaluationReport(report));
  });

  test("detects corpus drift before or after every scenario", async () => {
    let calls = 0;
    await expect(runRelevanceEvaluation(productionSet(), completeMatrix(), {
      corpusFingerprint: async () => ({
        ...CORPUS,
        sha256: ++calls === 2 ? "b".repeat(64) : CORPUS.sha256,
      }),
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("corpus drift after scenario bm25");
  });

  test("rejects incomplete matrix, resource metrics and readiness", async () => {
    const set = productionSet();
    await expect(runRelevanceEvaluation(set, completeMatrix().slice(0, -1), {
      corpusFingerprint: async () => CORPUS,
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("vector + hybrid");

    const noResources = completeMatrix();
    noResources[1] = { ...noResources[1]!, resourceMeasurements: undefined };
    await expect(runRelevanceEvaluation(set, noResources, {
      corpusFingerprint: async () => CORPUS,
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("resourceMeasurements");

    const notReady = completeMatrix();
    notReady[1] = {
      ...notReady[1]!,
      readiness: { ...notReady[1]!.readiness!, completedJobs: 11 },
    };
    await expect(runRelevanceEvaluation(set, notReady, {
      corpusFingerprint: async () => CORPUS,
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("jobs not ready");
  });

  test("allows only explicit stable-code/identity readiness exclusions", async () => {
    const scenarios = completeMatrix();
    const documented = {
      ...readiness(1536),
      completedJobs: CORPUS.documents - 1,
      vectors: CORPUS.documents - 1,
      permanentExcludedDocuments: 1,
      eligibleDocuments: CORPUS.documents - 1,
      exclusions: [{
        category: "permanent" as const,
        code: "provider_permanent_error",
        jobId: "embedding_job:test-exclusion",
        documentId: "search_document:test-exclusion",
        evidence: "review-ticket-17",
      }],
    };
    scenarios[1] = { ...scenarios[1]!, readiness: documented };
    scenarios[2] = { ...scenarios[2]!, readiness: documented };
    await expect(runRelevanceEvaluation(productionSet(), scenarios, {
      corpusFingerprint: async () => CORPUS,
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).resolves.toBeDefined();

    const invalid = { ...documented, exclusions: [{
      category: "permanent" as const,
      code: "PRIVATE provider response excerpt",
      jobId: "embedding_job:test-exclusion",
      documentId: "search_document:test-exclusion",
      evidence: "review-ticket-17",
    }] };
    scenarios[1] = { ...scenarios[1]!, readiness: invalid };
    scenarios[2] = { ...scenarios[2]!, readiness: invalid };
    await expect(runRelevanceEvaluation(productionSet(), scenarios, {
      corpusFingerprint: async () => CORPUS,
      candidatePlan: CANDIDATE_PLAN,
      ...ARTIFACT_OPTIONS,
    })).rejects.toThrow("недокументированное exclusion");
  });

  test("private report is mode 0600 and overwrite is explicit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baka-evaluation-"));
    try {
      const report = await runRelevanceEvaluation(productionSet(), completeMatrix(), {
        corpusFingerprint: async () => CORPUS,
        candidatePlan: CANDIDATE_PLAN,
        ...ARTIFACT_OPTIONS,
      });
      const file = path.join(dir, "report.json");
      await writeEvaluationReport(file, report);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, "utf8")).formatVersion).toBe(1);
      await expect(writeEvaluationReport(file, report)).rejects.toThrow();
      await expect(writeEvaluationReport(file, report, { overwrite: true })).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
