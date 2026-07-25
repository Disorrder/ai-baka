/**
 * Unit-тесты embedding pipeline (этап 7): backoff, stale detection,
 * приватность-фильтры (§13.7), RRF/dedup (§14), slug-конвенция (§13.1),
 * mock provider, OpenAI provider на fake fetch (retry/backoff/dimension).
 */

import { describe, expect, test } from "bun:test";
import { backoffMs, isJobStale, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../src/embeddings/jobs.ts";
import { privacyExclusion, EMPTY_PRIVACY_POLICY } from "../src/embeddings/privacy.ts";
import { defaultSlug, physicalTableName, SLUG_RE } from "../src/embeddings/spaces.ts";
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
  test("hash изменился — stale; совпадает — нет; документ удалён — stale", () => {
    expect(isJobStale("aaa", "bbb")).toBe(true);
    expect(isJobStale("aaa", "aaa")).toBe(false);
    expect(isJobStale("aaa", undefined)).toBe(true);
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
