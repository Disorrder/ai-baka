import { describe, expect, test } from "bun:test";
import type { ParsedUsageEvent } from "../src/domain/canonical-types.ts";
import {
  USAGE_NORMALIZATION_VERSION,
  normalizeUsageEvents,
} from "../src/parsers/shared/usage-normalization.ts";

describe("normalizeUsageEvents", () => {
  test("пустой вход → undefined", () => {
    expect(normalizeUsageEvents([])).toBeUndefined();
  });

  test("сценарий 19: cached/reasoning не double-counted", () => {
    const events: ParsedUsageEvent[] = [
      {
        scope: "request",
        inputTokens: 5200,
        cachedInputTokens: 3100,
        cacheWriteInputTokens: 200,
        outputTokens: 140,
        reasoningOutputTokens: 60,
        totalTokensReported: 5340,
        source: "test",
      },
    ];
    const usage = normalizeUsageEvents(events)!;
    // 5200 + 140, БЕЗ повторного cache read/write и reasoning.
    expect(usage.totalTokensNormalized).toBe(5340);
    expect(usage.cachedInputTokens).toBe(3100);
    expect(usage.cacheWriteInputTokens).toBe(200);
    expect(usage.reasoningOutputTokens).toBe(60);
    expect(usage.totalTokensReported).toBe(5340);
    expect(usage.normalizationVersion).toBe(USAGE_NORMALIZATION_VERSION);
  });

  test("сценарий 18: cumulative не суммируется с request", () => {
    const events: ParsedUsageEvent[] = [
      { scope: "request", inputTokens: 100, outputTokens: 10, source: "a" },
      {
        scope: "session_cumulative",
        inputTokens: 5000,
        outputTokens: 500,
        source: "b",
      },
    ];
    const usage = normalizeUsageEvents(events)!;
    // Выбран request scope; cumulative не добавляется.
    expect(usage.scope).toBe("request");
    expect(usage.inputTokens).toBe(100);
    expect(usage.totalTokensNormalized).toBe(110);
  });

  test("несколько request events суммируются (независимые вызовы)", () => {
    const events: ParsedUsageEvent[] = [
      { scope: "request", inputTokens: 100, outputTokens: 10, source: "a" },
      { scope: "request", inputTokens: 200, outputTokens: 20, source: "b" },
    ];
    const usage = normalizeUsageEvents(events)!;
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(30);
    expect(usage.totalTokensNormalized).toBe(330);
  });

  test("turn scope: берётся последнее значение, не сумма", () => {
    const events: ParsedUsageEvent[] = [
      { scope: "turn", inputTokens: 1000, outputTokens: 100, source: "a" },
      { scope: "turn", inputTokens: 2500, outputTokens: 260, source: "b" },
    ];
    const usage = normalizeUsageEvents(events)!;
    expect(usage.scope).toBe("turn");
    expect(usage.inputTokens).toBe(2500);
    expect(usage.totalTokensNormalized).toBe(2760);
  });

  test("только cumulative: scope сохраняется, значения последнего события", () => {
    const events: ParsedUsageEvent[] = [
      { scope: "session_cumulative", inputTokens: 1000, outputTokens: 100, source: "a" },
      { scope: "session_cumulative", inputTokens: 9000, outputTokens: 900, source: "b" },
    ];
    const usage = normalizeUsageEvents(events)!;
    expect(usage.scope).toBe("session_cumulative");
    expect(usage.inputTokens).toBe(9000);
  });

  test("isEstimated пропагируется", () => {
    const usage = normalizeUsageEvents([
      { scope: "unknown", inputTokens: 5, isEstimated: true, source: "a" },
    ])!;
    expect(usage.scope).toBe("unknown");
    expect(usage.isEstimated).toBe(true);
  });
});
