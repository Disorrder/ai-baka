/**
 * Unit-тесты embedding pipeline (этап 7): backoff, stale detection,
 * приватность-фильтры (§13.7), RRF/dedup (§14), slug-конвенция (§13.1),
 * mock provider, OpenAI provider на fake fetch (retry/backoff/dimension).
 */

import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  backoffMs,
  isJobStale,
  distributePromptTokens,
  defaultProviderFactory,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  type JobStaleFactors,
} from "../src/embeddings/jobs.ts";
import { privacyExclusion, EMPTY_PRIVACY_POLICY } from "../src/embeddings/privacy.ts";
import { defaultSlug, physicalTableName, SLUG_RE, type EmbeddingSpace } from "../src/embeddings/spaces.ts";
import { dedupByMessage, rrfFuse, RRF_K } from "../src/search/hybrid.ts";
import { MockEmbeddingProvider, mockVector } from "../src/embeddings/mock-provider.ts";
import { OpenAIEmbeddingProvider } from "../src/embeddings/openai-provider.ts";
import { EmbeddingProviderError } from "../src/embeddings/provider.ts";
import type { SearchHit } from "../src/search/fulltext.ts";

describe("backoff (§13.6)", () => {
  test("exponential с потолком", () => {
    expect(backoffMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffMs(3)).toBe(BACKOFF_BASE_MS * 4);
    expect(backoffMs(100)).toBe(BACKOFF_MAX_MS);
  });
});

describe("stale detection (§13.5)", () => {
  const recorded: JobStaleFactors = {
    contentSha256: "hash",
    extractionVersion: "1",
    segmentationVersion: "1",
    provider: "openai",
    model: "text-embedding-3-large",
    dimensions: 1024,
  };
  const current: JobStaleFactors = { ...recorded };

  test("все факторы совпадают — не stale", () => {
    expect(isJobStale(recorded, current)).toBe(false);
  });

  test("документ удалён (recorded undefined) — stale", () => {
    expect(isJobStale(undefined, current)).toBe(true);
  });

  test("изменение любого фактора §13.5 — stale", () => {
    expect(isJobStale(recorded, { ...current, contentSha256: "other" })).toBe(true);
    expect(isJobStale(recorded, { ...current, extractionVersion: "2" })).toBe(true);
    expect(isJobStale(recorded, { ...current, segmentationVersion: "2" })).toBe(true);
    expect(isJobStale(recorded, { ...current, provider: "voyage" })).toBe(true);
    expect(isJobStale(recorded, { ...current, model: "text-embedding-3-small" })).toBe(true);
    expect(isJobStale(recorded, { ...current, dimensions: 512 })).toBe(true);
  });
});

describe("распределение prompt_tokens (§13.6)", () => {
  test("сумма распределённого строго равна фактическому usage API, значения ≥ 0", () => {
    const cases: Array<[number, number[]]> = [
      [42, [10, 10, 10]],
      [1, [1, 1, 1]],
      // round-half-up суммарно превышает total — доля обрезается, остаток последнему.
      [2, [1, 1, 1, 1]],
      [100, [1]],
      [7, [3, 1, 1]],
      [0, [5, 5]],
      // Нулевые веса (пустые документы): весь usage уходит последнему.
      [10, [0, 0, 0]],
    ];
    for (const [total, weights] of cases) {
      const shares = distributePromptTokens(total, weights);
      expect(shares).toHaveLength(weights.length);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(total);
      expect(shares.every((share) => share >= 0)).toBe(true);
    }
  });

  test("остаток округления уходит последнему элементу", () => {
    expect(distributePromptTokens(42, [10, 10, 10])).toEqual([14, 14, 14]);
    expect(distributePromptTokens(10, [1, 1, 1])).toEqual([3, 3, 4]);
    expect(distributePromptTokens(2, [1, 1, 1, 1])).toEqual([1, 1, 0, 0]);
  });

  test("пустой батч — пустое распределение", () => {
    expect(distributePromptTokens(5, [])).toEqual([]);
  });
});

describe("defaultProviderFactory (§13.1)", () => {
  function space(provider: string): EmbeddingSpace {
    return {
      id: new RecordId("embedding_space", "test"),
      slug: "test",
      provider,
      model: "m",
      dimensions: 8,
      distance: "COSINE",
      vector_type: "F32",
      segmentation_version: "1",
      active: true,
      physical_table: "search_embedding_test",
      created_at: new Date(),
    };
  }

  test("openai без API key — понятная ошибка", () => {
    const factory = defaultProviderFactory({});
    expect(() => factory(space("openai"))).toThrow("OPENAI_API_KEY не задан");
  });

  test("неизвестный provider — понятная ошибка", () => {
    const factory = defaultProviderFactory({ openaiApiKey: "sk-test" });
    expect(() => factory(space("voyage"))).toThrow('неизвестный embedding provider "voyage"');
  });

  test("openai с key — provider с model/dimensions из space", () => {
    const factory = defaultProviderFactory({ openaiApiKey: "sk-test" });
    const provider = factory(space("openai"));
    expect(provider.provider).toBe("openai");
    expect(provider.model).toBe("m");
    expect(provider.dimensions).toBe(8);
  });
});

describe("privacy filters (§13.7)", () => {
  const subject = {
    harness: "codex",
    workspace: "secret",
    documentType: "user_prompt",
    contentBytes: 100,
  };
  test("пустая политика ничего не исключает", () => {
    expect(privacyExclusion(subject, EMPTY_PRIVACY_POLICY)).toBeUndefined();
  });
  test("исключения по harness/workspace/documentType/maxBytes", () => {
    expect(
      privacyExclusion(subject, { ...EMPTY_PRIVACY_POLICY, excludeHarnesses: ["codex"] }),
    ).toContain("codex");
    expect(
      privacyExclusion(subject, { ...EMPTY_PRIVACY_POLICY, excludeWorkspaces: ["secret"] }),
    ).toContain("secret");
    expect(
      privacyExclusion(subject, { ...EMPTY_PRIVACY_POLICY, excludeDocumentTypes: ["user_prompt"] }),
    ).toContain("user_prompt");
    expect(
      privacyExclusion(subject, { ...EMPTY_PRIVACY_POLICY, maxDocumentBytes: 50 }),
    ).toContain("100 bytes");
    // Не совпавшие правила не исключают.
    expect(
      privacyExclusion(subject, {
        excludeHarnesses: ["cursor"],
        excludeWorkspaces: ["other"],
        excludeDocumentTypes: ["assistant_final"],
        maxDocumentBytes: 1000,
      }),
    ).toBeUndefined();
  });
});

describe("slug-конвенция (§13.1)", () => {
  test("defaultSlug санитизирует и соответствует SLUG_RE", () => {
    const slug = defaultSlug("openai", "text-embedding-3-large", 1024);
    expect(slug).toBe("openai_text_embedding_3_large_1024_v1");
    expect(SLUG_RE.test(slug)).toBe(true);
    expect(physicalTableName(slug)).toBe(`search_embedding_${slug}`);
  });
});

function hit(id: string, score: number, messageId?: string): SearchHit {
  return { id, score, snippet: "", dialogueId: "dlg", revisionId: "rev", messageId };
}

describe("RRF (§14, k=60)", () => {
  test("score = Σ 1/(k+rank), документ из обоих списков выше одиночного", () => {
    const text = [hit("a", 10), hit("b", 5), hit("c", 1)];
    const vector = [hit("b", 0.9)];
    const fused = rrfFuse([text, vector]);
    expect(fused.map((h) => h.id)).toEqual(["b", "a", "c"]);
    // b: rank1 в text (1/62) + rank0 в vector (1/61) > a: 1/61 > c: 1/63.
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
    expect(fused[1]!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(fused[2]!.score).toBeCloseTo(1 / (RRF_K + 3), 10);
    // snippet/контекст берётся из первого списка (BM25, с подсветкой).
    expect(fused[0]!.snippet).toBe("");
  });
});

describe("dedup по message (§14)", () => {
  test("сегменты одного message схлопываются в лучший", () => {
    const hits = [
      hit("d1", 0.5, "m1"),
      hit("d2", 0.4, "m1"),
      hit("d3", 0.3, "m2"),
      hit("d4", 0.2), // без message — ключ сам id
    ];
    const out = dedupByMessage(hits);
    expect(out.map((h) => h.id)).toEqual(["d1", "d3", "d4"]);
  });
});

describe("mock provider", () => {
  test("детерминированные векторы заданной размерности", async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const a = await provider.embed(["hello", "world"]);
    expect(a.vectors).toHaveLength(2);
    expect(a.vectors[0]).toHaveLength(8);
    const b = await provider.embed(["hello"]);
    expect(b.vectors[0]).toEqual(a.vectors[0]);
    expect(mockVector("hello", 8)).toEqual(a.vectors[0]);
  });

  test("failures бросаются по очереди", async () => {
    const provider = new MockEmbeddingProvider({
      dimensions: 4,
      failures: [new Error("boom")],
    });
    await expect(provider.embed(["x"])).rejects.toThrow("boom");
    await expect(provider.embed(["x"])).resolves.toBeDefined();
    expect(provider.calls).toBe(2);
  });
});

/** Fake fetch с очередью ответов; запоминает запросы. */
function fakeFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): { fetchFn: typeof fetch; requests: Array<{ url: string; body: string }> } {
  const requests: Array<{ url: string; body: string }> = [];
  const queue = [...responses];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body ?? "") });
    const next = queue.shift();
    if (!next) throw new Error("fake fetch: ответы закончились");
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

function embeddingBody(dim: number, count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      index: i,
      embedding: Array.from({ length: dim }, () => 0.5),
    })),
    usage: { prompt_tokens: 42, total_tokens: 42 },
  };
}

describe("OpenAI provider (fake fetch)", () => {
  const noSleep = () => Promise.resolve();

  test("успех: dimensions в запросе, usage и векторы в ответе", async () => {
    const { fetchFn, requests } = fakeFetch([{ status: 200, body: embeddingBody(3, 2) }]);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-large",
      dimensions: 3,
      fetchFn,
      sleep: noSleep,
    });
    const result = await provider.embed(["a", "b"]);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual([0.5, 0.5, 0.5]);
    expect(result.usage.promptTokens).toBe(42);
    const sent = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(sent.model).toBe("text-embedding-3-large");
    expect(sent.dimensions).toBe(3);
    expect(sent.input).toEqual(["a", "b"]);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/embeddings");
  });

  test("429 → retry с backoff, затем успех", async () => {
    const { fetchFn, requests } = fakeFetch([
      { status: 429, body: { error: "rate limit" } },
      { status: 200, body: embeddingBody(2, 1) },
    ]);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "m",
      dimensions: 2,
      fetchFn,
      sleep: noSleep,
    });
    const result = await provider.embed(["a"]);
    expect(result.vectors).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  test("400 — permanent error без retry", async () => {
    const { fetchFn, requests } = fakeFetch([{ status: 400, body: { error: "bad" } }]);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "m",
      dimensions: 2,
      fetchFn,
      sleep: noSleep,
    });
    try {
      await provider.embed(["a"]);
      expect.unreachable("должна быть ошибка");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect((error as EmbeddingProviderError).retryable).toBe(false);
    }
    expect(requests).toHaveLength(1);
  });

  test("dimension mismatch — permanent error (сценарий №23)", async () => {
    const { fetchFn } = fakeFetch([{ status: 200, body: embeddingBody(5, 1) }]);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "m",
      dimensions: 3,
      fetchFn,
      sleep: noSleep,
    });
    try {
      await provider.embed(["a"]);
      expect.unreachable("должна быть ошибка");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect((error as EmbeddingProviderError).message).toContain("dimension mismatch");
      expect((error as EmbeddingProviderError).retryable).toBe(false);
    }
  });

  test("дубликаты data[].index при правильной длине — понятная permanent ошибка", async () => {
    const body = {
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 0, embedding: [0.3, 0.4] },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    };
    const { fetchFn } = fakeFetch([{ status: 200, body }]);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "m",
      dimensions: 2,
      fetchFn,
      sleep: noSleep,
    });
    try {
      await provider.embed(["a", "b"]);
      expect.unreachable("должна быть ошибка");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect((error as EmbeddingProviderError).message).toContain("data[].index 0");
      expect((error as EmbeddingProviderError).retryable).toBe(false);
    }
  });

  test("data[].index вне диапазона [0, batchSize) — permanent ошибка", async () => {
    const body = {
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 5, embedding: [0.3, 0.4] },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    };
    const { fetchFn } = fakeFetch([{ status: 200, body }]);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "m",
      dimensions: 2,
      fetchFn,
      sleep: noSleep,
    });
    try {
      await provider.embed(["a", "b"]);
      expect.unreachable("должна быть ошибка");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect((error as EmbeddingProviderError).message).toContain("data[].index 5");
      expect((error as EmbeddingProviderError).retryable).toBe(false);
    }
  });

  test("сетевая ошибка — retryable, исчерпание попыток бросает", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "m",
      dimensions: 2,
      fetchFn,
      sleep: noSleep,
      maxAttempts: 3,
    });
    try {
      await provider.embed(["a"]);
      expect.unreachable("должна быть ошибка");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect((error as EmbeddingProviderError).retryable).toBe(true);
    }
  });
});
