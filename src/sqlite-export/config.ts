import type { ContentCategory, ExportConfig, ExportPreset, FilterName } from "./types.ts";

export class ExportConfigError extends Error {}

export const FILTERS: FilterName[] = ["harness", "harnessInstallation", "vendor", "model", "serviceProvider", "reasoningEffort", "host", "platform", "arch", "workspace", "dialogue", "revision"];
export const CATEGORIES: ContentCategory[] = ["human_input", "assistant_final", "assistant_other", "thought", "tool_call", "tool_result", "instructions", "usage", "attachment", "object", "unknown"];
export const OPTIONAL_FIELDS = ["dialogues.title", "hosts.label", "messages.timestamp", "messages.model", "messages.service_provider", "messages.reasoning_effort", "messages.response_status", "messages.usage", "chunks.tool_name", "chunks.source_locator", "chunks.raw_kind", "messages.raw_role"];
const DEFAULT_FIELDS = ["messages.timestamp", "messages.model", "messages.service_provider", "messages.reasoning_effort", "messages.response_status", "chunks.tool_name"];
const PRESETS: Record<ExportPreset, ContentCategory[]> = {
  "qa-analysis": ["human_input", "assistant_final"],
  conversation: ["human_input", "assistant_final", "assistant_other"],
  tools: ["tool_call", "tool_result"],
  instructions: ["instructions"],
  "full-canonical": CATEGORIES,
};
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExportConfigError(`${name}: ожидается JSON object`);
  return value as Record<string, unknown>;
}
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new ExportConfigError(`${name}: допустимо ${choices.join("|")}`);
  return value as T;
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.length)) throw new ExportConfigError(`${name}: ожидается массив непустых строк`);
  return [...new Set(value as string[])];
}
function filterObject(value: unknown): ExportConfig["filters"] {
  const result: ExportConfig["filters"] = {};
  for (const [k, v] of Object.entries(object(value, "filters"))) {
    const key = choice(k, FILTERS, "filter name");
    result[key] = strings(v, key);
  }
  return result;
}
export function resolveExportConfig(config: unknown = {}, overrides: unknown = {}): ExportConfig {
  const c = object(config, "config"), o = object(overrides, "overrides");
  const allowed = ["preset", "categories", "instructions", "unknownPolicy", "matchScope", "revisions", "filters", "excludeFilters", "after", "before", "fields", "excludeFields", "batchSize", "maxRevisionBytes"];
  for (const layer of [c, o]) for (const key of Object.keys(layer)) if (!allowed.includes(key)) throw new ExportConfigError("Неизвестное поле конфигурации; используйте --discover");
  const preset = choice(o.preset ?? c.preset ?? "qa-analysis", Object.keys(PRESETS) as ExportPreset[], "preset");
  const v = { categories: PRESETS[preset], instructions: ["instructions", "full-canonical"].includes(preset) ? "separate" : "exclude", unknownPolicy: "metadata", matchScope: "turn", revisions: "current", fields: DEFAULT_FIELDS, batchSize: 128, maxRevisionBytes: 128 * 1024 * 1024, ...c, ...o };
  const categories = strings(v.categories, "categories").map(k => choice(k === "reasoning" ? "thought" : k, CATEGORIES, "category"));
  const instructions = choice(v.instructions, ["exclude", "separate"], "instructions");
  if (instructions === "exclude" && categories.includes("instructions")) throw new ExportConfigError("Категория instructions требует --instructions separate либо её исключения из categories");
  const fields = strings(v.fields, "fields").map(k => choice(k, OPTIONAL_FIELDS, "optional field"));
  const excluded = strings(o.excludeFields ?? c.excludeFields ?? [], "excludeFields");
  for (const field of excluded) if (!OPTIONAL_FIELDS.includes(field)) throw new ExportConfigError("Нельзя исключить обязательное или неизвестное поле; используйте --discover");
  const result: ExportConfig = { preset, categories, instructions, unknownPolicy: choice(v.unknownPolicy, ["metadata", "separate", "include"], "unknownPolicy"), matchScope: choice(v.matchScope, ["turn", "dialogue", "message"], "matchScope"), revisions: choice(v.revisions, ["current", "all"], "revisions"), filters: { ...filterObject(c.filters ?? {}), ...filterObject(o.filters ?? {}) }, excludeFilters: { ...filterObject(c.excludeFilters ?? {}), ...filterObject(o.excludeFilters ?? {}) }, fields: fields.filter(k => !excluded.includes(k)), batchSize: Number(v.batchSize), maxRevisionBytes: Number(v.maxRevisionBytes) };
  for (const key of ["batchSize", "maxRevisionBytes"] as const) if (typeof v[key] !== "number" || !Number.isSafeInteger(result[key]) || result[key] < 1) throw new ExportConfigError(`${key}: требуется положительное безопасное целое`);
  if (result.batchSize > 10000) throw new ExportConfigError("batchSize: максимум 10000");
  for (const key of ["after", "before"] as const) {
    const value = o[key] ?? c[key];
    if (value !== undefined) {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ExportConfigError(`${key}: требуется UTC ISO timestamp с Z`);
      if (new Date(value).toISOString().slice(0,19) !== value.slice(0,19)) throw new ExportConfigError(`${key}: несуществующая календарная дата`);
      result[key] = new Date(value).toISOString();
    }
  }
  if (result.after && result.before && result.after >= result.before) throw new ExportConfigError("after должен предшествовать before");
  return result;
}
export function exportDiscovery(): unknown {
  return { presets: PRESETS, categories: CATEGORIES, filters: FILTERS, optionalFields: OPTIONAL_FIELDS, mandatory: "IDs, relations, sequence, role/kind, classification, provenance", matchScope: ["turn", "dialogue", "message"], instructions: ["exclude", "separate"], unknownPolicy: ["metadata", "separate", "include"], revisions: ["current", "all"], arrayOverrides: "replace per field", exclusions: "OR within one filter, AND across filters; any exclusion vetoes", time: "message timestamp [after,before) UTC; missing excluded only with time filter; never expand outside interval" };
}
export function safeExportConfig(config: ExportConfig, alias: (kind: string, value: string) => string): unknown {
  const safeFilters = (f: ExportConfig["filters"]) => Object.fromEntries(Object.entries(f).map(([k, values]) => [k, values!.map(v => alias(`filter:${k}`, v))]));
  return { ...config, filters: safeFilters(config.filters), excludeFilters: safeFilters(config.excludeFilters), filterValues: "per-export opaque aliases; actual values intentionally not disclosed" };
}
