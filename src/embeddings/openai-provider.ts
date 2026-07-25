/**
 * OpenAI embeddings provider (docs/plan.md §13.2, этап 7).
 *
 * POST /v1/embeddings с явным параметром dimensions (text-embedding-3-*
 * поддерживает уменьшение размерности). Retry с exponential backoff на
 * 429/5xx и сетевые ошибки (Retry-After учитывается); прочие 4xx и
 * dimension mismatch — permanent (план §19.2 сценарий 23).
 *
 * API key приходит только из окружения (OPENAI_API_KEY), не логируется;
 * в OpenAI уходит только content документа (§13.7).
 *
 * fetch инжектируется — unit-тесты ходят в fake без сети.
 */

import {
  EmbeddingProviderError,
  type EmbedResult,
  type EmbeddingProvider,
} from "./provider.ts";

type FetchFn = typeof fetch;

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  /** По умолчанию https://api.openai.com (без trailing slash). */
  baseUrl?: string;
  fetchFn?: FetchFn;
  /** Максимум попыток одного вызова (по умолчанию 5). */
  maxAttempts?: number;
  /** База backoff в мс (по умолчанию 1000); задержка = base * 2^(attempt-1). */
  baseDelayMs?: number;
  /** Для тестов: замена setTimeout-ожидания между попытками. */
  sleep?: (ms: number) => Promise<void>;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai";
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAIEmbeddingProvider: пустой apiKey");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
    const body = JSON.stringify({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });
    let lastError: EmbeddingProviderError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}/v1/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body,
        });
      } catch (error) {
        lastError = new EmbeddingProviderError(
          `openai embeddings: сетевая ошибка (${error instanceof Error ? error.message : error})`,
          true,
        );
        await this.wait(attempt, undefined);
        continue;
      }
      if (response.ok) {
        const payload = (await response.json()) as OpenAIEmbeddingResponse;
        return this.parsePayload(payload, texts.length);
      }
      const retryable = response.status === 429 || response.status >= 500;
      const detail = (await response.text()).slice(0, 300);
      lastError = new EmbeddingProviderError(
        `openai embeddings: HTTP ${response.status}: ${detail}`,
        retryable,
      );
      if (!retryable) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      await this.wait(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    throw lastError ?? new EmbeddingProviderError("openai embeddings: неизвестный сбой", true);
  }

  private async wait(attempt: number, overrideMs: number | undefined): Promise<void> {
    if (attempt >= this.maxAttempts) return;
    await this.sleep(overrideMs ?? this.baseDelayMs * 2 ** (attempt - 1));
  }

  /** Проверка размерности каждого вектора — отклонение = permanent error (№23). */
  private parsePayload(payload: OpenAIEmbeddingResponse, expected: number): EmbedResult {
    const data = payload.data ?? [];
    if (data.length !== expected) {
      throw new EmbeddingProviderError(
        `openai embeddings: получено ${data.length} векторов на ${expected} входов`,
        false,
      );
    }
    const vectors: number[][] = new Array<number[]>(expected);
    for (const item of data) {
      if (item.embedding.length !== this.dimensions) {
        throw new EmbeddingProviderError(
          `openai embeddings: dimension mismatch — ожидалось ${this.dimensions}, получено ${item.embedding.length}`,
          false,
        );
      }
      vectors[item.index] = item.embedding;
    }
    return {
      vectors,
      usage: {
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
    };
  }
}
