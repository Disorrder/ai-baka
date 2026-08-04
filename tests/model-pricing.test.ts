import { describe, expect, test } from "bun:test";
import {
  estimateModelTokenCost,
  pricingForModel,
} from "../scripts/model-pricing.ts";

describe("estimateModelTokenCost", () => {
  test("prices uncached input, cache read, cache write, and output separately", () => {
    const estimate = estimateModelTokenCost("openai/gpt-5.6-sol", {
      inputTokens: 200_000,
      cachedInputTokens: 80_000,
      cacheWriteInputTokens: 20_000,
      outputTokens: 100_000,
    });

    expect(estimate.inputCostUsd).toBeCloseTo(0.5);
    expect(estimate.cachedInputCostUsd).toBeCloseTo(0.04);
    expect(estimate.cacheWriteCostUsd).toBeCloseTo(0.125);
    expect(estimate.outputCostUsd).toBeCloseTo(3);
    expect(estimate.totalCostUsd).toBeCloseTo(3.665);
  });

  test("applies OpenAI long-context multipliers per usage message", () => {
    const estimate = estimateModelTokenCost("openai/gpt-5.4", {
      inputTokens: 300_000,
      outputTokens: 10_000,
    });

    expect(estimate.inputCostUsd).toBeCloseTo(1.5);
    expect(estimate.outputCostUsd).toBeCloseTo(0.225);
    expect(estimate.tierLabel).toContain(">272K");
  });

  test("selects Qwen Coder tier from the message input size", () => {
    const low = estimateModelTokenCost("alibaba/qwen3-coder-next:cloud", {
      inputTokens: 20_000,
      outputTokens: 1_000,
    });
    const high = estimateModelTokenCost("alibaba/qwen3-coder-next:cloud", {
      inputTokens: 150_000,
      outputTokens: 1_000,
    });

    expect(low.tierLabel).toBe("0-32K");
    expect(high.tierLabel).toBe("128K-256K");
    expect(high.totalCostUsd).toBeGreaterThan(low.totalCostUsd);
  });

  test("keeps fallback models explicitly marked", () => {
    expect(pricingForModel("openai/gpt-5.3-codex-spark")?.sourceKind).toBe("fallback_proxy");
    expect(pricingForModel("unknown/minimax-m2.5-free")?.sourceKind).toBe("official_partner");
  });

  test("does not infer a price from vendor or harness", () => {
    const estimate = estimateModelTokenCost("openai/default", {
      inputTokens: 1_000,
      outputTokens: 100,
    });

    expect(estimate.priced).toBe(false);
    expect(estimate.totalCostUsd).toBe(0);
    expect(estimate.unpricedTokens).toBe(1_100);
  });
});
