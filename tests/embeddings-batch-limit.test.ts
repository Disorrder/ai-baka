import { describe, expect, test } from "bun:test";
import {
  BATCH_SIZE,
  EMBEDDING_INPUT_TOKEN_LIMIT,
  EMBEDDING_REQUEST_TOKEN_LIMIT,
  embeddingInputTokenUpperBound,
  packEmbeddingRequestBatches,
  type EmbeddingBatchTokenEvidence,
} from "../src/embeddings/jobs.ts";

interface Input extends EmbeddingBatchTokenEvidence {
  id: number;
}

const pack = (inputs: readonly Input[], maxInputs = BATCH_SIZE): Input[][] =>
  packEmbeddingRequestBatches(inputs, (input) => input, maxInputs);

describe("OpenAI embeddings request token cap", () => {
  test("allows exactly 300k exact tokens and starts a new request for the next input", () => {
    const inputs = Array.from({ length: 41 }, (_, id): Input => ({
      id,
      content: "x",
      tokenCount: 7_500,
      exact: true,
    }));

    const batches = pack(inputs);
    expect(batches.map((batch) => batch.length)).toEqual([40, 1]);
    expect(
      batches.map((batch) =>
        batch.reduce((sum, input) => sum + embeddingInputTokenUpperBound(input), 0)
      ),
    ).toEqual([EMBEDDING_REQUEST_TOKEN_LIMIT, 7_500]);
  });

  test("retains the independent 64-document ceiling for small inputs", () => {
    const inputs = Array.from({ length: 65 }, (_, id): Input => ({
      id,
      content: "x",
      tokenCount: 1,
      exact: true,
    }));

    expect(pack(inputs).map((batch) => batch.length)).toEqual([64, 1]);
  });

  test("stored heuristic cannot understate the UTF-8 byte-level BPE upper bound", () => {
    const inputs = Array.from({ length: 64 }, (_, id): Input => ({
      id,
      content: "x".repeat(5_000),
      tokenCount: 1,
    }));

    const batches = pack(inputs);
    expect(batches.map((batch) => batch.length)).toEqual([60, 4]);
    for (const batch of batches) {
      const upperBound = batch.reduce(
        (sum, input) => sum + embeddingInputTokenUpperBound(input),
        0,
      );
      expect(upperBound).toBeLessThanOrEqual(EMBEDDING_REQUEST_TOKEN_LIMIT);
    }
  });

  test("missing or corrupt stored evidence falls back to the full per-input limit", () => {
    const missing = Array.from({ length: 37 }, (_, id): Input => ({
      id,
      content: "x",
    }));
    expect(pack(missing).map((batch) => batch.length)).toEqual([36, 1]);
    expect(embeddingInputTokenUpperBound({ content: "x", tokenCount: -1 })).toBe(
      EMBEDDING_INPUT_TOKEN_LIMIT,
    );
    expect(embeddingInputTokenUpperBound({ content: "x", tokenCount: 1.5 })).toBe(
      EMBEDDING_INPUT_TOKEN_LIMIT,
    );
  });

  test("validated exact evidence fails closed when it violates the input contract", () => {
    expect(() => embeddingInputTokenUpperBound({
      content: "x",
      tokenCount: EMBEDDING_INPUT_TOKEN_LIMIT + 1,
      exact: true,
    })).toThrow("exact_token_evidence_invalid");
    expect(() => pack([], 0)).toThrow("maxInputs");
    expect(() => pack([], BATCH_SIZE + 1)).toThrow("maxInputs");
  });

  test("packing is stable and preserves retry/idempotency order", () => {
    const inputs = Array.from({ length: 80 }, (_, id): Input => ({
      id,
      content: `document-${id}`,
      tokenCount: id % 3 === 0 ? 8_000 : 100,
      exact: true,
    }));
    const flattened = pack(inputs, 17).flat();
    expect(flattened.map((input) => input.id)).toEqual(inputs.map((input) => input.id));
    expect(flattened).toHaveLength(inputs.length);
  });
});
