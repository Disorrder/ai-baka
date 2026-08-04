export type PricingSourceKind =
  | "official"
  | "official_partner"
  | "fallback_proxy"
  | "unpriced";

export interface PriceTier {
  maxInputTokens?: number;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWritePerMillion: number;
  outputPerMillion: number;
  label?: string;
}

export interface ModelPricing {
  modelKey: string;
  pricedAs: string;
  sourceKind: PricingSourceKind;
  sourceUrl?: string;
  sourceLabel: string;
  tiers: PriceTier[];
  notes: string[];
}

export interface PriceableUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

export interface ModelCostEstimate {
  modelKey: string | null;
  sourceKind: PricingSourceKind;
  priced: boolean;
  inputCostUsd: number;
  cachedInputCostUsd: number;
  cacheWriteCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  tierLabel?: string;
}

const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const ALIBABA_PRICING = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";
const KIMI_K3_PRICING = "https://www.kimi.com/resources/kimi-k3-pricing";
const CODEX_RATE_CARD = "https://help.openai.com/en/articles/20001106-codex-rate-card";

function flat(
  inputPerMillion: number,
  cachedInputPerMillion: number,
  outputPerMillion: number,
  cacheWritePerMillion = inputPerMillion,
): PriceTier[] {
  return [{
    inputPerMillion,
    cachedInputPerMillion,
    cacheWritePerMillion,
    outputPerMillion,
  }];
}

function official(
  modelKey: string,
  sourceUrl: string,
  tiers: PriceTier[],
  notes: string[] = [],
): ModelPricing {
  return {
    modelKey,
    pricedAs: modelKey,
    sourceKind: "official",
    sourceUrl,
    sourceLabel: "официальный API-прайс",
    tiers,
    notes,
  };
}

const catalog: ModelPricing[] = [
  official("openai/gpt-5.6-sol", OPENAI_PRICING, flat(5, 0.5, 30, 6.25), [
    "Cache write оценён как 1.25x обычного input.",
    "Для запросов свыше 272K input применяется long-context multiplier 2x input/cache и 1.5x output.",
  ]),
  official("openai/gpt-5.5", OPENAI_PRICING, flat(5, 0.5, 30), [
    "Отдельного cache-write тарифа нет; такие canonical tokens оценены как обычный input.",
    "Для запросов свыше 272K input применяется long-context multiplier 2x input/cache и 1.5x output.",
  ]),
  official("openai/gpt-5.4", OPENAI_PRICING, flat(2.5, 0.25, 15), [
    "Отдельного cache-write тарифа нет; такие canonical tokens оценены как обычный input.",
    "Для запросов свыше 272K input применяется long-context multiplier 2x input/cache и 1.5x output.",
  ]),
  official("openai/gpt-5.4-mini", OPENAI_PRICING, flat(0.75, 0.075, 4.5, 0.9375)),
  official("openai/gpt-5.3-codex", OPENAI_PRICING, flat(1.75, 0.175, 14)),
  official("openai/gpt-5.2", OPENAI_PRICING, flat(1.75, 0.175, 14)),
  official("openai/gpt-5.2-codex", OPENAI_PRICING, flat(1.75, 0.175, 14)),
  official("openai/gpt-5.1-codex", OPENAI_PRICING, flat(1.25, 0.125, 10)),
  official("openai/gpt-5-codex", OPENAI_PRICING, flat(1.25, 0.125, 10)),
  official("openai/gpt-5.6-luna", OPENAI_PRICING, flat(0.2, 0.02, 1.2, 0.25), [
    "Cache write оценён как 1.25x обычного input.",
    "Для запросов свыше 272K input применяется long-context multiplier 2x input/cache и 1.5x output.",
  ]),
  official("openai/o3", OPENAI_PRICING, flat(2, 0.5, 8)),
  {
    modelKey: "openai/gpt-5.3-codex-spark",
    pricedAs: "openai/gpt-5.3-codex",
    sourceKind: "fallback_proxy",
    sourceUrl: CODEX_RATE_CARD,
    sourceLabel: "proxy: GPT-5.3-Codex",
    tiers: flat(1.75, 0.175, 14),
    notes: [
      "Spark находится в research preview без финальной публичной token-цены; использован тариф ближайшей GPT-5.3-Codex.",
    ],
  },

  official("anthropic/claude-fable-5", ANTHROPIC_PRICING, flat(10, 1, 50, 12.5), [
    "Cache write рассчитан по 5-minute TTL; canonical usage не сохраняет TTL.",
  ]),
  ...["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"].map(
    (model): ModelPricing => official(`anthropic/${model}`, ANTHROPIC_PRICING, flat(5, 0.5, 25, 6.25), [
      "Cache write рассчитан по 5-minute TTL; canonical usage не сохраняет TTL.",
    ]),
  ),
  official("anthropic/claude-sonnet-5", ANTHROPIC_PRICING, flat(2, 0.2, 10, 2.5), [
    "Промо-тариф действует до 2026-08-31; отчёт использует цену на дату генерации.",
    "Cache write рассчитан по 5-minute TTL; canonical usage не сохраняет TTL.",
  ]),
  ...[
    "claude-sonnet-4-6",
    "claude-4-sonnet-thinking",
    "claude-3.7-sonnet-thinking",
    "claude-4-sonnet",
  ].map(
    (model): ModelPricing => official(`anthropic/${model}`, ANTHROPIC_PRICING, flat(3, 0.3, 15, 3.75), [
      "Thinking tokens входят в output и не тарифицируются второй раз.",
      "Cache write рассчитан по 5-minute TTL; canonical usage не сохраняет TTL.",
    ]),
  ),
  official("anthropic/claude-haiku-4-5-20251001", ANTHROPIC_PRICING, flat(1, 0.1, 5, 1.25), [
    "Cache write рассчитан по 5-minute TTL; canonical usage не сохраняет TTL.",
  ]),

  official("moonshot/k3", KIMI_K3_PRICING, flat(3, 0.3, 15)),

  official("alibaba/qwen3-coder-next:cloud", ALIBABA_PRICING, [
    { maxInputTokens: 32_000, inputPerMillion: 0.3, cachedInputPerMillion: 0.03, cacheWritePerMillion: 0.375, outputPerMillion: 1.5, label: "0-32K" },
    { maxInputTokens: 128_000, inputPerMillion: 0.5, cachedInputPerMillion: 0.05, cacheWritePerMillion: 0.625, outputPerMillion: 2.5, label: "32K-128K" },
    { maxInputTokens: 256_000, inputPerMillion: 0.8, cachedInputPerMillion: 0.08, cacheWritePerMillion: 1, outputPerMillion: 4, label: "128K-256K" },
    { inputPerMillion: 0.8, cachedInputPerMillion: 0.08, cacheWritePerMillion: 1, outputPerMillion: 4, label: ">256K proxy" },
  ], [
    "Tier выбирается по inputTokens каждого usage-сообщения.",
    "Для cache hit применена официальная explicit-cache цена 10%; cache write — 125% input.",
  ]),
  {
    modelKey: "alibaba/qwen3.8-max-preview",
    pricedAs: "alibaba/qwen3.7-max",
    sourceKind: "fallback_proxy",
    sourceUrl: ALIBABA_PRICING,
    sourceLabel: "proxy: официальный Qwen3.7-Max",
    tiers: flat(1.65, 0.165, 4.951, 2.0625),
    notes: ["Для preview-модели нет отдельного PAYG-прайса; использован global list price ближайшего официального Qwen3.7-Max."],
  },
  {
    modelKey: "alibaba/qwen3.5:cloud",
    pricedAs: "alibaba/qwen3.5-397b-a17b",
    sourceKind: "fallback_proxy",
    sourceUrl: ALIBABA_PRICING,
    sourceLabel: "proxy: официальный Qwen3.5-397B-A17B",
    tiers: flat(0.6, 0.06, 3.6, 0.75),
    notes: ["Raw alias не указывает размер модели; выбран крупнейший официальный Qwen3.5 как консервативный proxy."],
  },
  {
    modelKey: "unknown/minimax-m2.5-free",
    pricedAs: "minimax/MiniMax-M2.5",
    sourceKind: "official_partner",
    sourceUrl: ALIBABA_PRICING,
    sourceLabel: "официальный partner API-прайс Alibaba",
    tiers: flat(0.304, 0.304, 1.213),
    notes: ["Free alias оценён по опубликованной PAYG-цене той же модели у официального API-партнёра."],
  },
];

export const MODEL_PRICING_CATALOG: ReadonlyMap<string, ModelPricing> = new Map(
  catalog.map((entry) => [entry.modelKey, entry]),
);

function positive(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

function selectTier(pricing: ModelPricing, inputTokens: number): PriceTier {
  return pricing.tiers.find(
    (tier) => tier.maxInputTokens === undefined || inputTokens <= tier.maxInputTokens,
  ) ?? pricing.tiers.at(-1)!;
}

function hasOpenAiLongContextMultiplier(modelKey: string, inputTokens: number): boolean {
  return inputTokens > 272_000 && [
    "openai/gpt-5.6-sol",
    "openai/gpt-5.5",
    "openai/gpt-5.4",
    "openai/gpt-5.6-luna",
  ].includes(modelKey);
}

export function pricingForModel(modelKey: string): ModelPricing | undefined {
  return MODEL_PRICING_CATALOG.get(modelKey);
}

export function estimateModelTokenCost(
  modelKey: string | null,
  usage: PriceableUsage | undefined,
): ModelCostEstimate {
  const inputTokens = positive(usage?.inputTokens);
  const cachedInputTokens = positive(usage?.cachedInputTokens);
  const cacheWriteInputTokens = positive(usage?.cacheWriteInputTokens);
  const outputTokens = positive(usage?.outputTokens);
  const billableTokens = inputTokens + outputTokens;
  const pricing = modelKey ? MODEL_PRICING_CATALOG.get(modelKey) : undefined;
  if (!pricing || billableTokens === 0) {
    return {
      modelKey,
      sourceKind: pricing?.sourceKind ?? "unpriced",
      priced: Boolean(pricing) && billableTokens === 0,
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      cacheWriteCostUsd: 0,
      outputCostUsd: 0,
      totalCostUsd: 0,
      pricedTokens: 0,
      unpricedTokens: pricing ? 0 : billableTokens,
    };
  }

  const tier = selectTier(pricing, inputTokens);
  const validBreakdown = cachedInputTokens + cacheWriteInputTokens <= inputTokens;
  const pricedCached = validBreakdown ? cachedInputTokens : 0;
  const pricedCacheWrite = validBreakdown ? cacheWriteInputTokens : 0;
  const uncachedInputTokens = validBreakdown
    ? inputTokens - pricedCached - pricedCacheWrite
    : inputTokens;
  const longContext = hasOpenAiLongContextMultiplier(modelKey!, inputTokens);
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const inputCostUsd = uncachedInputTokens * tier.inputPerMillion * inputMultiplier / 1_000_000;
  const cachedInputCostUsd = pricedCached * tier.cachedInputPerMillion * inputMultiplier / 1_000_000;
  const cacheWriteCostUsd = pricedCacheWrite * tier.cacheWritePerMillion * inputMultiplier / 1_000_000;
  const outputCostUsd = outputTokens * tier.outputPerMillion * outputMultiplier / 1_000_000;
  return {
    modelKey,
    sourceKind: pricing.sourceKind,
    priced: true,
    inputCostUsd,
    cachedInputCostUsd,
    cacheWriteCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + cachedInputCostUsd + cacheWriteCostUsd + outputCostUsd,
    pricedTokens: billableTokens,
    unpricedTokens: 0,
    tierLabel: longContext ? `${tier.label ?? "standard"} + >272K` : tier.label,
  };
}

export function serializablePricing(modelKey: string): Record<string, unknown> {
  const pricing = MODEL_PRICING_CATALOG.get(modelKey);
  if (!pricing) {
    return {
      sourceKind: "unpriced",
      sourceLabel: "нет однозначного публичного тарифа",
      pricedAs: null,
      sourceUrl: null,
      tiers: [],
      notes: ["Стоимость не включена в итоговую оценку."],
    };
  }
  return {
    sourceKind: pricing.sourceKind,
    sourceLabel: pricing.sourceLabel,
    pricedAs: pricing.pricedAs,
    sourceUrl: pricing.sourceUrl ?? null,
    tiers: pricing.tiers,
    notes: pricing.notes,
  };
}
