/**
 * Нормализация имён моделей (docs/plan.md §7.1 `model`).
 *
 * Базовая модель отделяется от reasoning effort и service provider:
 *   "gpt-5.6-sol-xhigh" → canonical "gpt-5.6-sol" + effort "xhigh"
 *   "kimi-code/k3"      → canonical "k3", vendor moonshot, provider "kimi-code"
 *
 * Изменение правил = изменение нормализации → повышать parser_version
 * у parser'ов, которые её используют.
 */

import type { VendorSlug } from "../../domain/enums.ts";

export interface NormalizedModelName {
  vendor: VendorSlug;
  canonicalName: string;
  reasoningEffort?: string;
  /** Префикс до "/" (openrouter-стиль или routing alias harness'а). */
  serviceProvider?: string;
}

/**
 * Известные суффиксы reasoning effort. Сравнение — по последнему
 * "-сегменту" имени, регистронезависимо.
 */
const EFFORT_SUFFIXES = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Префиксы "vendor/..." (openrouter-стиль и alias'ы harness'ов). */
const PROVIDER_PREFIX_VENDORS: Record<string, VendorSlug> = {
  openai: "openai",
  anthropic: "anthropic",
  alibaba: "alibaba",
  google: "google",
  meta: "meta",
  moonshot: "moonshot",
  kimi: "moonshot",
  "kimi-code": "moonshot",
};

/** Эвристики vendor'а по подстроке canonical name (lowercase). */
const VENDOR_NAME_RULES: ReadonlyArray<readonly [RegExp, VendorSlug]> = [
  [/^(gpt|chatgpt|o[134])(-|\d|$)|codex-mini/, "openai"],
  [/claude/, "anthropic"],
  [/qwen/, "alibaba"],
  [/gemini|gemma/, "google"],
  [/llama/, "meta"],
  [/moonshot|kimi|^k\d/, "moonshot"],
];

export function normalizeModelName(rawModelName: string): NormalizedModelName {
  const raw = rawModelName.trim();
  let rest = raw;
  let serviceProvider: string | undefined;
  let vendor: VendorSlug | undefined;

  const slash = rest.indexOf("/");
  if (slash > 0) {
    const prefix = rest.slice(0, slash).toLowerCase();
    serviceProvider = rest.slice(0, slash);
    vendor = PROVIDER_PREFIX_VENDORS[prefix];
    rest = rest.slice(slash + 1);
  }

  // Reasoning effort — последний "-сегмент", если он известен
  // ("gpt-5.6-sol-xhigh" → "gpt-5.6-sol" + "xhigh").
  let reasoningEffort: string | undefined;
  const lastDash = rest.lastIndexOf("-");
  if (lastDash > 0) {
    const suffix = rest.slice(lastDash + 1).toLowerCase();
    if (EFFORT_SUFFIXES.has(suffix)) {
      reasoningEffort = rest.slice(lastDash + 1);
      rest = rest.slice(0, lastDash);
    }
  }

  if (!vendor) {
    const lower = rest.toLowerCase();
    for (const [pattern, slug] of VENDOR_NAME_RULES) {
      if (pattern.test(lower)) {
        vendor = slug;
        break;
      }
    }
  }

  return {
    vendor: vendor ?? "unknown",
    canonicalName: rest,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(serviceProvider !== undefined ? { serviceProvider } : {}),
  };
}
