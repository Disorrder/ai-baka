import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  countExactTokens,
  createCommandTokenCounter,
  serializeExactTokenCountReport,
  summarizeExactTokenCounts,
  validateExactTokenCountReport,
  writeExactTokenCountReport,
  type ExactTokenCounter,
} from "../src/embeddings/token-count.ts";
import {
  prepareEvaluationCandidatePlan,
  productionBackfillConfirmation,
} from "../src/embeddings/backfill.ts";
import { EMPTY_PRIVACY_POLICY } from "../src/embeddings/privacy.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function counter(): ExactTokenCounter {
  return {
    id: "fake-exact@1/test-encoding",
    model: "text-embedding-3-large",
    countBatch: async (texts) => texts.map((text) => [...text].length),
  };
}

const NOW = () => new Date("2026-07-26T12:00:00Z");
const VERSION_SCRIPT =
  "console.log(JSON.stringify({id:'ai-baka-exact-tokenizer',protocolVersion:1,scriptVersion:1,package:{name:'tiktoken',version:'0.13.0'},resolver:'encoding_for_model'}))";

describe("exact token-count workflow (Stage 11)", () => {
  test("counts in bounded batches, verifies hashes, and uses only configured price", async () => {
    const batches: number[] = [];
    const exact: ExactTokenCounter = {
      ...counter(),
      countBatch: async (texts) => {
        batches.push(texts.length);
        return texts.map((text) => [...text].length);
      },
    };
    const report = await countExactTokens(
      [
        { id: "search_document:b", content: "four", contentSha256: sha256("four") },
        { id: "search_document:a", content: "два", contentSha256: sha256("два") },
        { id: "search_document:c", content: "x" },
      ],
      exact,
      { batchSize: 2, pricePer1MTokens: 0.13, now: NOW },
    );
    expect(batches).toEqual([2, 1]);
    expect(report.method).toBe("exact");
    expect(report.documents.map((doc) => doc.id)).toEqual([
      "search_document:a",
      "search_document:b",
      "search_document:c",
    ]);
    expect(report.counts.totalTokens).toBe(8);
    expect(report.price).toEqual({
      configuredPricePer1MTokens: 0.13,
      exactPriceUsd: (8 / 1_000_000) * 0.13,
    });
    expect(serializeExactTokenCountReport(report)).not.toContain('"content"');
    expect(() => validateExactTokenCountReport(report)).not.toThrow();
  });

  test("without configured price does not guess cost", async () => {
    const report = await countExactTokens([{ id: "d", content: "hello" }], counter(), { now: NOW });
    expect(report.price).toBeUndefined();
  });

  test("corpus fingerprint is independent of input order", async () => {
    const docs = [
      { id: "b", content: "beta" },
      { id: "a", content: "alpha" },
    ];
    const a = await countExactTokens(docs, counter(), { now: NOW });
    const b = await countExactTokens([...docs].reverse(), counter(), { now: NOW });
    expect(a.corpus.fingerprintSha256).toBe(b.corpus.fingerprintSha256);
    expect(a.documents).toEqual(b.documents);
  });

  test("rejects stale hashes, duplicate ids and malformed tokenizer output", async () => {
    await expect(
      countExactTokens([{ id: "d", content: "actual", contentSha256: "0".repeat(64) }], counter()),
    ).rejects.toThrow("SHA-256");
    await expect(
      countExactTokens(
        [
          { id: "d", content: "one" },
          { id: "d", content: "two" },
        ],
        counter(),
      ),
    ).rejects.toThrow("дубликат");
    await expect(
      countExactTokens([{ id: "d", content: "one" }], {
        ...counter(),
        countBatch: async () => [],
      }),
    ).rejects.toThrow("counts");
    await expect(
      countExactTokens([{ id: "d", content: "one" }], {
        ...counter(),
        countBatch: async () => [1.5],
      }),
    ).rejects.toThrow("некорректный count");
  });

  test("tampering with per-document counts/fingerprint is detected", async () => {
    const report = await countExactTokens([{ id: "d", content: "hello" }], counter(), { now: NOW });
    const brokenTotal = structuredClone(report);
    brokenTotal.counts.totalTokens += 1;
    expect(() => validateExactTokenCountReport(brokenTotal)).toThrow("totalTokens");
    const brokenFingerprint = structuredClone(report);
    brokenFingerprint.corpus.fingerprintSha256 = "0".repeat(64);
    expect(() => validateExactTokenCountReport(brokenFingerprint)).toThrow("fingerprint");

    const brokenIdentity = structuredClone(report);
    brokenIdentity.documents[0]!.id = "";
    expect(() => validateExactTokenCountReport(brokenIdentity)).toThrow("document id");
    const brokenTokenizer = structuredClone(report);
    brokenTokenizer.tokenizer.model = "";
    expect(() => validateExactTokenCountReport(brokenTokenizer)).toThrow("tokenizer");
    const brokenDate = structuredClone(report);
    brokenDate.generatedAt = "not-a-date";
    expect(() => validateExactTokenCountReport(brokenDate)).toThrow("generatedAt");
    const brokenPrice = structuredClone(report);
    brokenPrice.price = { configuredPricePer1MTokens: -1, exactPriceUsd: -1 };
    expect(() => validateExactTokenCountReport(brokenPrice)).toThrow("price");
  });

  test("scale-safe aggregation handles an array beyond spread argument limits", () => {
    const counts = new Array<number>(1_000_000).fill(7);
    expect(summarizeExactTokenCounts(counts)).toEqual({
      totalTokens: 7_000_000,
      maximumDocumentTokens: 7,
      overTarget: 0,
      overSegmentationMax: 0,
      atOrOverModelLimit: 0,
    });
  });

  test("private exact report is 0600 and not overwritten implicitly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baka-token-count-"));
    try {
      const report = await countExactTokens([{ id: "d", content: "hello" }], counter(), { now: NOW });
      const file = path.join(dir, "exact.json");
      await writeExactTokenCountReport(file, report);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, "utf8")).method).toBe("exact");
      await expect(writeExactTokenCountReport(file, report)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local command tokenizer seam", () => {
  test("uses JSON stdin/stdout protocol without a shell", async () => {
    const tokenizer = createCommandTokenCounter({
      executable: process.execPath,
      args: [
        "-e",
        "const x=await Bun.stdin.json();console.log(JSON.stringify({counts:x.texts.map((s)=>s.length)}))",
      ],
      versionArgs: ["-e", VERSION_SCRIPT],
      id: "bun-test-counter",
      model: "test-model",
    });
    await expect(tokenizer.countBatch(["ab", "cde"])).resolves.toEqual([2, 3]);
  });

  test("rejects coerced and otherwise malformed JSON count values", async () => {
    for (const value of ['"2"', "null", "true", "1.5", "-1"]) {
      const tokenizer = createCommandTokenCounter({
        executable: process.execPath,
        args: ["-e", `console.log(JSON.stringify({counts:[${value}]}))`],
        versionArgs: ["-e", VERSION_SCRIPT],
        id: "bun-malformed-counter",
        model: "test-model",
      });
      await expect(tokenizer.countBatch(["private"])).rejects.toThrow("JSON numbers");
    }
    const extraField = createCommandTokenCounter({
      executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify({counts:[1],extra:true}))"],
      versionArgs: ["-e", VERSION_SCRIPT],
      id: "bun-extra-field-counter",
      model: "test-model",
    });
    await expect(extraField.countBatch(["private"])).rejects.toThrow("counts");
  });

  test("verifies exact script/package identity before tokenization and can require offline argv", async () => {
    const mismatched = createCommandTokenCounter({
      executable: process.execPath,
      args: ["-e", "throw new Error('count command must not run')"],
      versionArgs: [
        "-e",
        "console.log(JSON.stringify({id:'ai-baka-exact-tokenizer',protocolVersion:1,scriptVersion:1,package:{name:'tiktoken',version:'0.12.0'},resolver:'encoding_for_model'}))",
      ],
      id: "mismatched-counter",
      model: "test-model",
    });
    await expect(mismatched.countBatch(["PRIVATE"])).rejects.toThrow("version identity mismatch");
    expect(() => createCommandTokenCounter({
      executable: "uv",
      args: ["run", "--script", "tokenizer.py"],
      id: "offline-required",
      model: "test-model",
      requireOffline: true,
    })).toThrow("requires --offline");
  });
});

describe("production backfill confirmation", () => {
  test("uses full corpus and production-plan hashes", () => {
    const corpus = "a".repeat(64);
    const plan = "b".repeat(64);
    expect(productionBackfillConfirmation("openai_te3l_1024_v1", corpus, plan)).toBe(
      `RUN EMBEDDINGS openai_te3l_1024_v1 ${corpus} ${plan}`,
    );
  });

  test("candidate paid-work ceilings are enforced before any database access", async () => {
    const base = {
      privacy: EMPTY_PRIVACY_POLICY,
      spaceSlugs: ["a", "b", "c"],
      maxDocuments: 1,
      maxJobsPerSpace: 1,
      selectionSeedSha256: "c".repeat(64),
      requiredDialogueIds: ["dialogue:test"],
    };
    await expect(prepareEvaluationCandidatePlan({} as never, {
      ...base,
      maxDocuments: 1_001,
    })).rejects.toThrow("1..1000");
    await expect(prepareEvaluationCandidatePlan({} as never, {
      ...base,
      maxJobsPerSpace: 201,
    })).rejects.toThrow("1..200");
  });
});
