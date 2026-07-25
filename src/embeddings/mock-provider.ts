/**
 * Детерминированный mock-провайдер для тестов (этап 7).
 *
 * Вектор строится из sha256 текста: одинаковый текст → одинаковый вектор
 * (dist 0), разные тексты → почти ортогональные векторы. Этого достаточно,
 * чтобы integration-тест vector search проверял «ближайший по mock-векторам»
 * без живого OpenAI.
 *
 * Опции для сценариев сбоев:
 * - dimensionOverride — вернуть векторы чужой размерности (проверка
 *   отклонения wrong dimension, план §19.2 сценарий 23);
 * - failures — очередь ошибок, бросаемых на первые N вызовов embed
 *   (retry/backoff, §13.6).
 */

import { createHash } from "node:crypto";
import type { EmbedResult, EmbeddingProvider } from "./provider.ts";

export interface MockProviderOptions {
  provider?: string;
  model?: string;
  dimensions: number;
  dimensionOverride?: number;
  failures?: Error[];
}

/** Детерминированный псевдослучайный вектор из текста, значения в (-1, 1). */
export function mockVector(text: string, dimensions: number): number[] {
  const vector: number[] = new Array<number>(dimensions);
  for (let i = 0; i < dimensions; i++) {
    const digest = createHash("sha256").update(`${i}#${text}`).digest();
    vector[i] = digest.readUInt32BE(0) / 2 ** 31 - 1;
  }
  return vector;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;

  private readonly dimensionOverride?: number;
  private readonly failures: Error[];
  /** Счётчик вызовов embed (для asserts в тестах). */
  calls = 0;

  constructor(options: MockProviderOptions) {
    this.provider = options.provider ?? "mock";
    this.model = options.model ?? "mock-embedding";
    this.dimensions = options.dimensions;
    this.dimensionOverride = options.dimensionOverride;
    this.failures = [...(options.failures ?? [])];
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    this.calls += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const dimensions = this.dimensionOverride ?? this.dimensions;
    return {
      vectors: texts.map((text) => mockVector(text, dimensions)),
      usage: {
        promptTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        totalTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
      },
    };
  }
}
