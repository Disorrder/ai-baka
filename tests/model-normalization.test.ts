import { describe, expect, test } from "bun:test";
import { normalizeModelName } from "../src/parsers/shared/model-normalization.ts";

describe("normalizeModelName", () => {
  test("пример из плана: gpt-5.6-sol-xhigh → gpt-5.6-sol + xhigh", () => {
    expect(normalizeModelName("gpt-5.6-sol-xhigh")).toEqual({
      vendor: "openai",
      canonicalName: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
  });

  test("базовая модель без effort", () => {
    expect(normalizeModelName("gpt-5.6-sol")).toEqual({
      vendor: "openai",
      canonicalName: "gpt-5.6-sol",
    });
  });

  test("effort-суффиксы low/medium/high", () => {
    expect(normalizeModelName("o4-mini-high")).toEqual({
      vendor: "openai",
      canonicalName: "o4-mini",
      reasoningEffort: "high",
    });
    expect(normalizeModelName("claude-sonnet-5-medium")).toEqual({
      vendor: "anthropic",
      canonicalName: "claude-sonnet-5",
      reasoningEffort: "medium",
    });
  });

  test("дефис внутри имени не считается effort", () => {
    const result = normalizeModelName("claude-opus-4-1");
    expect(result.vendor).toBe("anthropic");
    expect(result.canonicalName).toBe("claude-opus-4-1");
    expect(result.reasoningEffort).toBeUndefined();
  });

  test("routing prefix kimi-code → moonshot, canonical без префикса", () => {
    expect(normalizeModelName("kimi-code/k3")).toEqual({
      vendor: "moonshot",
      canonicalName: "k3",
      serviceProvider: "kimi-code",
    });
  });

  test("openrouter-стиль vendor/model", () => {
    expect(normalizeModelName("anthropic/claude-sonnet-5")).toEqual({
      vendor: "anthropic",
      canonicalName: "claude-sonnet-5",
      serviceProvider: "anthropic",
    });
  });

  test("vendor-эвристики", () => {
    expect(normalizeModelName("qwen3-coder-plus").vendor).toBe("alibaba");
    expect(normalizeModelName("gemini-3-pro").vendor).toBe("google");
    expect(normalizeModelName("llama-4-scout").vendor).toBe("meta");
    expect(normalizeModelName("moonshot-v1-8k").vendor).toBe("moonshot");
    expect(normalizeModelName("totally-custom-model").vendor).toBe("unknown");
  });
});
