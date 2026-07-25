/**
 * Нормализация usage events (docs/plan.md §7.3 `message.usage`).
 *
 * Правила плана:
 * - cached input НЕ прибавляется повторно к input (это подмножество input);
 * - reasoning output НЕ прибавляется повторно к output (подмножество output);
 * - cumulative events НЕ суммируются как независимые turn'ы;
 * - total_tokens_reported сохраняется отдельно;
 * - исходные payloads не теряются (остаются в ParsedUsageEvent.raw);
 * - у результата есть normalization_version.
 *
 * Сведение событий одного сообщения:
 * - request-scope: независимые вызовы — суммируются (несколько запросов
 *   в одном сообщении);
 * - turn-scope: cumulative внутри turn'а — берётся ПОСЛЕДНЕЕ значение,
 *   а не сумма; используется только если нет request-scope;
 * - session_cumulative: никогда не сводится в суммы сообщения — берётся
 *   последнее значение как есть, scope сохраняется;
 * - unknown: как есть, scope "unknown".
 */

import type {
  NormalizedUsage,
  ParsedUsageEvent,
} from "../../domain/canonical-types.ts";
import type { UsageScope } from "../../domain/enums.ts";

export const USAGE_NORMALIZATION_VERSION = 1;

const SCOPE_PRIORITY: Record<UsageScope, number> = {
  request: 0,
  turn: 1,
  session_cumulative: 2,
  unknown: 3,
};

/** Выбрать scope сведения: лучший (наименьший) из присутствующих. */
function pickScope(events: readonly ParsedUsageEvent[]): UsageScope {
  let best: UsageScope = "unknown";
  for (const event of events) {
    if (SCOPE_PRIORITY[event.scope] < SCOPE_PRIORITY[best]) best = event.scope;
  }
  return best;
}

function sum(values: Array<number | undefined>): number | undefined {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value === "number") {
      total += value;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

/**
 * Свести usage events сообщения в нормализованный usage object.
 * Пустой вход → undefined (у сообщения нет usage).
 */
export function normalizeUsageEvents(
  events: readonly ParsedUsageEvent[],
): NormalizedUsage | undefined {
  if (events.length === 0) return undefined;

  const scope = pickScope(events);
  // Только события выбранного scope участвуют в сведении — cumulative
  // никогда не смешивается с per-request/per-turn (план §19.2 сценарий 18).
  const selected = events.filter((event) => event.scope === scope);

  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningOutputTokens: number | undefined;
  let totalTokensReported: number | undefined;

  if (scope === "request") {
    // Независимые вызовы API: суммируем.
    inputTokens = sum(selected.map((e) => e.inputTokens));
    cachedInputTokens = sum(selected.map((e) => e.cachedInputTokens));
    outputTokens = sum(selected.map((e) => e.outputTokens));
    reasoningOutputTokens = sum(selected.map((e) => e.reasoningOutputTokens));
    totalTokensReported = sum(selected.map((e) => e.totalTokensReported));
  } else {
    // turn / session_cumulative / unknown — значения и так накопительные:
    // берём последнее, суммирование было бы double-counting.
    const last = selected[selected.length - 1]!;
    inputTokens = last.inputTokens;
    cachedInputTokens = last.cachedInputTokens;
    outputTokens = last.outputTokens;
    reasoningOutputTokens = last.reasoningOutputTokens;
    totalTokensReported = last.totalTokensReported;
  }

  // Нормализованный total: input + output БЕЗ повторного учёта
  // cached (внутри input) и reasoning (внутри output) — сценарий 19.
  let totalTokensNormalized: number | undefined;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    totalTokensNormalized = (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  return {
    scope,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(totalTokensReported !== undefined ? { totalTokensReported } : {}),
    ...(totalTokensNormalized !== undefined ? { totalTokensNormalized } : {}),
    isEstimated: selected.some((e) => e.isEstimated === true),
    source: selected.map((e) => e.source).join(","),
    normalizationVersion: USAGE_NORMALIZATION_VERSION,
  };
}
