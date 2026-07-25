/**
 * Embedding provider abstraction (docs/plan.md §13, этап 7).
 *
 * Worker (src/embeddings/jobs.ts) и vector search (src/search/hybrid.ts)
 * зависят только от этого интерфейса: production — OpenAIEmbeddingProvider
 * (openai-provider.ts), тесты — MockEmbeddingProvider (mock-provider.ts).
 * Живой вызов OpenAI в тестах не нужен и невозможен (нет API key).
 *
 * Контракт:
 * - embed принимает уже сегментированные документы (< 8192 токенов,
 *   гарантирует segmenter, src/search/segmenter.ts) — провайдер не режет
 *   и не пропускает входы;
 * - порядок vectors соответствует порядку texts;
 * - размерность каждого вектора строго равна dimensions — нарушение
 *   отклоняется ошибкой (план §19.2 сценарий 23);
 * - временные сбои (429/5xx/network) — EmbeddingProviderError с
 *   retryable = true, постоянные (4xx, dimension mismatch) — retryable = false.
 */

export interface EmbedUsage {
  /** Фактические input tokens батча по ответу API. */
  promptTokens: number;
  totalTokens: number;
}

export interface EmbedResult {
  vectors: number[][];
  usage: EmbedUsage;
}

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<EmbedResult>;
}

export class EmbeddingProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.retryable = retryable;
  }
}
