import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluationCandidateConfirmation,
  writeEvaluationCandidatePlan,
  type EvaluationCandidatePlan,
} from "../src/embeddings/backfill.ts";
import {
  eligibleCorpusFingerprint,
  writeExactTokenCountReport,
  type ExactTokenCountReport,
} from "../src/embeddings/token-count.ts";
import {
  writeEvaluationReport,
  writeFullCorpusEvaluationReport,
  type EvaluationAggregate,
  type EvaluationScenarioReport,
  type FullCorpusHybridEvaluationReport,
  type RelevanceEvaluationReport,
  type SearchCorpusFingerprint,
} from "../src/search/evaluation.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

function exactReport(marker: string): ExactTokenCountReport {
  const document = {
    id: `search_document:${marker}`,
    contentSha256: sha256(`content-${marker}`),
    tokens: 1,
  };
  const corpus = eligibleCorpusFingerprint([document]);
  return {
    formatVersion: 1,
    method: "exact",
    generatedAt: "2026-07-26T00:00:00.000Z",
    tokenizer: { id: "test-tokenizer", model: "text-embedding-3-small" },
    corpus: {
      documents: corpus.documents,
      fingerprintSha256: corpus.sha256,
    },
    counts: {
      totalTokens: 1,
      maximumDocumentTokens: 1,
      overTarget: 0,
      overSegmentationMax: 0,
      atOrOverModelLimit: 0,
    },
    documents: [document],
  };
}

function candidatePlan(marker: string): EvaluationCandidatePlan {
  const document = {
    documentId: `search_document:${marker}`,
    dialogueId: `dialogue:${marker}`,
    revisionId: `dialogue_revision:${marker}`,
    contentSha256: sha256(`content-${marker}`),
    extractionVersion: "2",
    segmentationVersion: "2",
  };
  const corpus = eligibleCorpusFingerprint([{
    id: document.documentId,
    contentSha256: document.contentSha256,
  }]);
  const descriptors = [
    { slug: `small-1536-${marker}`, model: "text-embedding-3-small", dimensions: 1536 },
    { slug: `large-1024-${marker}`, model: "text-embedding-3-large", dimensions: 1024 },
    { slug: `large-3072-${marker}`, model: "text-embedding-3-large", dimensions: 3072 },
  ];
  const binding = {
    formatVersion: 1 as const,
    fullEligibleCorpus: corpus,
    subset: {
      limit: 1,
      selectionSeedSha256: sha256(`seed-${marker}`),
      fingerprint: corpus,
      documents: [document],
    },
    privacy: {
      excludeHarnesses: [],
      excludeWorkspaces: [],
      excludeDocumentTypes: [],
    },
    requiredDialogueIdsSha256: sha256(`dialogues-${marker}`),
    maxJobsPerSpace: 1,
    spaces: descriptors.map((descriptor) => {
      const job = {
        jobId: `embedding_job:${descriptor.slug}`,
        documentId: document.documentId,
        inputSha256: document.contentSha256,
        status: "pending",
        createdAt: "2026-07-26T00:00:00.000Z",
      };
      return {
        space: { provider: "openai", ...descriptor },
        jobs: [job],
        runnableJobs: [job],
        vectors: [],
      };
    }),
    blockers: [],
  };
  const planSha256 = canonicalSha256(binding);
  return {
    ...binding,
    planSha256,
    confirmation: evaluationCandidateConfirmation(corpus.sha256, planSha256),
  };
}

function aggregate(): EvaluationAggregate {
  const latency = { mean: 0, p50: 0, p95: 0, max: 0 };
  return {
    queries: 0,
    relevantFoundAt5: 0,
    relevantFoundAt10: 0,
    relevantTotal: 0,
    recallAt5: 0,
    recallAt10: 0,
    mrr: 0,
    ndcgAt10: 0,
    irrelevantTop5Share: 0,
    latencyMs: latency,
    providerLatencyMs: latency,
    retrievalLatencyMs: latency,
    expectedSnippetRecall: 0,
    mustNotMatchViolations: 0,
    retrievalFailures: 0,
    dialogueCandidateShortfallQueries: 0,
  };
}

const METRIC_DEFINITIONS = {
  rankingUnit: "dialogue" as const,
  relevance: "expectedDialogues (unlisted dialogues are irrelevant)" as const,
  irrelevantTop5Denominator: "returned distinct dialogues, up to 5; empty retrieval = 1" as const,
  latency: "uncached provider and retrieval measured separately; scenarios and queries run sequentially" as const,
};

function corpus(marker: string): SearchCorpusFingerprint {
  return { algorithm: "sha256", sha256: sha256(`corpus-${marker}`), documents: 1 };
}

function scenario(marker: string): EvaluationScenarioReport {
  const fingerprint = corpus(marker);
  return {
    id: marker,
    mode: "text",
    corpusChecks: { before: fingerprint, after: fingerprint },
    contentEvidence: [],
    aggregate: aggregate(),
    queries: [],
  };
}

function evaluationReport(marker: string): RelevanceEvaluationReport {
  return {
    formatVersion: 1,
    generatedAt: "2026-07-26T00:00:00.000Z",
    judgmentSet: {
      name: marker,
      artifactSha256: sha256(`artifact-${marker}`),
      sha256: sha256(`judgments-${marker}`),
      queries: 1,
    },
    corpus: corpus(marker),
    candidatePlan: {
      artifactSha256: sha256(`candidate-artifact-${marker}`),
      planSha256: sha256(`candidate-plan-${marker}`),
      corpusSha256: sha256(`candidate-corpus-${marker}`),
      subsetSha256: sha256(`candidate-subset-${marker}`),
      privacySha256: sha256(`candidate-privacy-${marker}`),
    },
    metricDefinitions: METRIC_DEFINITIONS,
    scenarios: [scenario(marker)],
  };
}

function fullCorpusReport(marker: string): FullCorpusHybridEvaluationReport {
  return {
    formatVersion: 1,
    evaluationKind: "final_full_corpus_hybrid",
    generatedAt: "2026-07-26T00:00:00.000Z",
    judgmentSet: {
      name: marker,
      artifactSha256: sha256(`artifact-${marker}`),
      sha256: sha256(`judgments-${marker}`),
      queries: 1,
    },
    corpus: corpus(marker),
    corpusDocuments: [],
    privacySha256: sha256(`privacy-${marker}`),
    selectedSpace: {
      slug: `space-${marker}`,
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    },
    metricDefinitions: METRIC_DEFINITIONS,
    scenario: scenario(marker),
  };
}

interface WriterCase {
  name: string;
  write: (
    filePath: string,
    marker: string,
    options?: { overwrite?: boolean },
  ) => Promise<void>;
}

const WRITERS: WriterCase[] = [
  {
    name: "exact token report",
    write: (filePath, marker, options) =>
      writeExactTokenCountReport(filePath, exactReport(marker), options),
  },
  {
    name: "evaluation candidate plan",
    write: (filePath, marker, options) =>
      writeEvaluationCandidatePlan(filePath, candidatePlan(marker), options),
  },
  {
    name: "full-corpus evaluation report",
    write: (filePath, marker, options) =>
      writeFullCorpusEvaluationReport(filePath, fullCorpusReport(marker), options),
  },
  {
    name: "candidate evaluation report",
    write: (filePath, marker, options) =>
      writeEvaluationReport(filePath, evaluationReport(marker), options),
  },
];

async function expectNoTemporaryFiles(directory: string): Promise<void> {
  expect((await readdir(directory)).filter((name) => name.endsWith(".part"))).toEqual([]);
}

for (const writer of WRITERS) {
  describe(`private artifact writer: ${writer.name}`, () => {
    test("publishes mode 0600 and defaults to no-clobber", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "baka-private-writer-"));
      try {
        const target = path.join(directory, "artifact.json");
        await writer.write(target, "first");
        const first = await readFile(target, "utf8");
        expect(first).toContain("first");
        expect((await stat(target)).mode & 0o777).toBe(0o600);

        await expect(writer.write(target, "second")).rejects.toThrow(/не будет перезаписан/);
        expect(await readFile(target, "utf8")).toBe(first);
        await expectNoTemporaryFiles(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("explicit overwrite atomically replaces the inode instead of truncating it", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "baka-private-writer-"));
      try {
        const target = path.join(directory, "artifact.json");
        await writer.write(target, "first");
        const first = await readFile(target, "utf8");
        const firstStat = await stat(target, { bigint: true });
        const oldHandle = await open(target, "r");
        try {
          await writer.write(target, "second", { overwrite: true });
          const second = await readFile(target, "utf8");
          expect(second).toContain("second");
          expect(second).not.toBe(first);
          expect(await oldHandle.readFile({ encoding: "utf8" })).toBe(first);
          expect((await stat(target, { bigint: true })).ino).not.toBe(firstStat.ino);
          expect((await stat(target)).mode & 0o777).toBe(0o600);
        } finally {
          await oldHandle.close();
        }
        await expectNoTemporaryFiles(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("explicit overwrite rejects a symlink without touching its target", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "baka-private-writer-"));
      try {
        const outside = path.join(directory, "outside.txt");
        const target = path.join(directory, "artifact.json");
        await writeFile(outside, "do-not-touch", { mode: 0o600 });
        await symlink(outside, target);

        await expect(writer.write(target, "second", { overwrite: true }))
          .rejects.toThrow(/non-regular private artifact/);
        expect(await readFile(outside, "utf8")).toBe("do-not-touch");
        expect((await lstat(target)).isSymbolicLink()).toBe(true);
        await expectNoTemporaryFiles(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
}
