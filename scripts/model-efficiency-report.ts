import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { HARNESS_ORDER } from "../src/sources/adapters/harnesses.ts";
import {
  analyzeCodexLineage,
  mapCodexReplayToMessages,
  type UsageVector,
} from "./analyze-codex-lineage.ts";
import {
  estimateModelTokenCost,
  serializablePricing,
  type ModelCostEstimate,
} from "./model-pricing.ts";

const PAGE_SIZE = 50_000;
const IDLE_GAP_MS = 3 * 60 * 1000;
const REPORT_DATE = new Date().toISOString().slice(0, 10);
const REPORT_TIME_ZONE = "Europe/Berlin";
const DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function inclusiveCalendarDayCount(
  firstDay: string | null,
  lastDay: string | null,
): number | null {
  if (!firstDay || !lastDay) return null;
  const firstMs = Date.parse(`${firstDay}T00:00:00Z`);
  const lastMs = Date.parse(`${lastDay}T00:00:00Z`);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs < firstMs) return null;
  return Math.floor((lastMs - firstMs) / 86_400_000) + 1;
}

interface CliOptions {
  outputDir: string;
}

interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokensNormalized?: number;
  totalTokensReported?: number;
  isEstimated?: boolean;
  normalizationVersion?: number;
}

interface DialogueRow {
  id: unknown;
  workspace?: unknown;
  project_name?: string;
  project_repository_identity?: string;
  external_id?: string;
  current_revision: unknown;
  source_revision?: unknown;
  parser_version?: string | number;
  revision_created_at?: string | Date;
  harness?: string;
  message_count?: number;
  chunk_count?: number;
  primary_model?: string;
  primary_vendor?: string;
  started_at?: string | Date;
  updated_at?: string | Date;
}

interface MessageRow {
  id: unknown;
  dialogue: unknown;
  dialogue_revision: unknown;
  sequence?: number;
  role?: string;
  human_authored?: boolean;
  visible_to_user?: boolean;
  model?: unknown;
  model_name?: string;
  vendor_slug?: string;
  raw_model_name?: string;
  service_provider?: string;
  timestamp?: string | Date;
  content_chars?: number;
  usage?: Usage;
  durationMs?: number;
  durationSource?: string;
  ttftMs?: number;
  reportedDurationMs?: number;
  responseWaitMs?: number;
  responseStatus?: string;
  responseCompletedAt?: string | Date;
  responseTurnId?: string;
  cost?: number | { total?: number };
  resultCostUsd?: number;
}

interface ToolCallRow {
  id: unknown;
  dialogue_revision: unknown;
  tool_name?: string;
  content?: string;
}

interface InvocationAccumulator {
  name: string;
  calls: number;
  dialogues: Set<string>;
  harnesses: Map<string, number>;
}

interface UsageAccumulator {
  messages: number;
  responses: number;
  usageMessages: number;
  estimatedUsageMessages: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  tokenBreakdownInputTokens: number;
  classifiedCachedInputTokens: number;
  classifiedCacheWriteInputTokens: number;
  tokenBreakdownMessages: number;
  invalidTokenBreakdownMessages: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalTokensReported: number;
  contentChars: number;
  assistantChars: number;
  userChars: number;
  toolChars: number;
  durationMs: number[];
  ttftMs: number[];
  reportedDurationMs: number[];
  responseWaitByTurn: Map<string, number>;
  reportedCostUsd: number;
  reportedCostMessages: number;
  estimatedCostUsd: number;
  estimatedInputCostUsd: number;
  estimatedCachedInputCostUsd: number;
  estimatedCacheWriteCostUsd: number;
  estimatedOutputCostUsd: number;
  pricedUsageMessages: number;
  unpricedUsageMessages: number;
  pricedTokens: number;
  unpricedTokens: number;
}

interface DialogueAccumulator extends UsageAccumulator {
  id: string;
  projectKey: string;
  project: string;
  externalId?: string;
  revision: string;
  sourceRevision: string;
  parserVersion: number;
  revisionCreatedAt: number | null;
  harness: string;
  primaryModel: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  messageCountDeclared: number;
  chunkCountDeclared: number;
  timestamps: number[];
  durationMsSum: number;
  exactTurnDurationMsSum: number;
  reportedDurationMsSum: number;
  responseWaitMsSum: number;
  interpolatedResponseWaitMs: number;
  hasVisibleAssistantAnswer: boolean;
  byModel: Map<string, UsageAccumulator>;
}

interface GroupAccumulator extends UsageAccumulator {
  key: string;
  label: string;
  harness?: string;
  model?: string;
  vendor?: string;
  dialogues: Set<string>;
  dominantSessions: number;
  activeMs: number;
  responseWaitActiveMs: number;
  interpolatedWaitActiveMs: number;
  interpolatedWaitSessions: number;
  agentWorkMeasuredMs: number;
  agentWorkEstimatedMs: number;
  elapsedMs: number;
}

interface RoleAccumulator {
  role: string;
  messages: number;
  contentChars: number;
  tokens: number;
}

interface DayAccumulator {
  date: string;
  messages: number;
  inferredTimestampMessages: number;
  usageMessages: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contentChars: number;
  activeMs: number;
  durationMs: number;
  reportedDurationMs: number;
  responseWaitMs: number;
  interpolatedResponseWaitMs: number;
  responseWaitByTurn: Map<string, number>;
  sessions: Set<string>;
  harnessMessages: Map<string, number>;
}

interface MonthlyAgentAccumulator {
  measuredMs: number;
  estimatedMs: number;
}

type MonthlyBreakdownDimension = "project" | "harness" | "vendor";

interface MonthlyBreakdownAccumulator {
  month: string;
  dimension: MonthlyBreakdownDimension;
  group: string;
  label: string;
  messages: number;
  contentChars: number;
  totalTokens: number;
  outputTokens: number;
  agentWorkMeasuredMs: number;
  agentWorkEstimatedMs: number;
}

interface TimingDiagnostics {
  gapActiveMs: number;
  durationBackedMs: number;
  responseWaitMs: number;
  timestampSpanMs: number;
  uniqueTimestamps: number;
  uniqueTimestampRatio: number | null;
  timingQuality: string;
  timingWarning: string | null;
  waitSource: string;
  waitEstimated: boolean;
  waitEstimateLowerMs: number;
  waitEstimateUpperMs: number;
  waitEstimateDonors: number;
}

interface ResponseWaitEstimate {
  ms: number;
  lowerMs: number;
  upperMs: number;
  source: "interpolated_same_model" | "interpolated_same_vendor" | "interpolated_global";
  donorCount: number;
}

interface InvocationScanResult {
  rowsScanned: number;
  toolCalls: number;
  uniqueTools: number;
  skillCalls: number;
  explicitSkillCalls: number;
  inferredSkillLoads: number;
  namedSkillCalls: number;
  unparsedSkillCalls: number;
  uniqueSkills: number;
  toolStats: Array<Record<string, unknown>>;
  skillStats: Array<Record<string, unknown>>;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output-dir requires a path");
      values.set(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return {
    outputDir: path.resolve(values.get("--output-dir") ?? path.join("reports", `model-efficiency-${REPORT_DATE}`)),
  };
}

function emptyUsage(): UsageAccumulator {
  return {
    messages: 0,
    responses: 0,
    usageMessages: 0,
    estimatedUsageMessages: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    tokenBreakdownInputTokens: 0,
    classifiedCachedInputTokens: 0,
    classifiedCacheWriteInputTokens: 0,
    tokenBreakdownMessages: 0,
    invalidTokenBreakdownMessages: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    totalTokensReported: 0,
    contentChars: 0,
    assistantChars: 0,
    userChars: 0,
    toolChars: 0,
    durationMs: [],
    ttftMs: [],
    reportedDurationMs: [],
    responseWaitByTurn: new Map(),
    reportedCostUsd: 0,
    reportedCostMessages: 0,
    estimatedCostUsd: 0,
    estimatedInputCostUsd: 0,
    estimatedCachedInputCostUsd: 0,
    estimatedCacheWriteCostUsd: 0,
    estimatedOutputCostUsd: 0,
    pricedUsageMessages: 0,
    unpricedUsageMessages: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
  };
}

function groupAccumulator(key: string, label: string, extras: Partial<GroupAccumulator> = {}): GroupAccumulator {
  return {
    ...emptyUsage(),
    key,
    label,
    dialogues: new Set(),
    dominantSessions: 0,
    activeMs: 0,
    responseWaitActiveMs: 0,
    interpolatedWaitActiveMs: 0,
    interpolatedWaitSessions: 0,
    agentWorkMeasuredMs: 0,
    agentWorkEstimatedMs: 0,
    elapsedMs: 0,
    ...extras,
  };
}

export function canonicalReportProject(
  row: Pick<DialogueRow, "workspace" | "project_name" | "project_repository_identity">,
): { key: string; label: string } {
  const name = row.project_name?.trim();
  const repositoryIdentity = row.project_repository_identity?.trim();
  const label = name || repositoryIdentity || "без проекта";
  if (repositoryIdentity) {
    return { key: `repository:${repositoryIdentity}`, label };
  }
  if (name) {
    return { key: `name:${name}`, label };
  }
  return { key: "unassigned", label };
}

function dialogueAccumulator(row: DialogueRow): DialogueAccumulator {
  const harness = row.harness ?? "unknown";
  const project = canonicalReportProject(row);
  const primaryModel =
    row.primary_vendor && row.primary_model ? `${row.primary_vendor}/${row.primary_model}` : null;
  return {
    ...emptyUsage(),
    id: recordString(row.id),
    projectKey: project.key,
    project: project.label,
    externalId: row.external_id,
    revision: recordString(row.current_revision),
    sourceRevision: recordString(row.source_revision),
    parserVersion: safeInteger(row.parser_version),
    revisionCreatedAt: toMs(row.revision_created_at),
    harness,
    primaryModel,
    startedAt: toMs(row.started_at),
    updatedAt: toMs(row.updated_at),
    messageCountDeclared: safeInteger(row.message_count),
    chunkCountDeclared: safeInteger(row.chunk_count),
    timestamps: [],
    durationMsSum: 0,
    exactTurnDurationMsSum: 0,
    reportedDurationMsSum: 0,
    responseWaitMsSum: 0,
    interpolatedResponseWaitMs: 0,
    hasVisibleAssistantAnswer: false,
    byModel: new Map(),
  };
}

function recordString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function toMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value !== null && value !== undefined) {
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function dayKey(ms: number): string {
  const parts = DAY_FORMATTER.formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function positiveNumber(value: unknown): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

function withoutReplay(row: MessageRow, replay?: UsageVector): MessageRow {
  if (!replay || !row.usage) return row;
  const usage = row.usage;
  const subtract = (value: number | undefined, amount: number): number | undefined => {
    if (value === undefined) return undefined;
    const result = value - amount;
    if (result < 0) throw new Error(`replay deduction exceeds canonical usage for ${recordString(row.id)}`);
    return result;
  };
  const adjusted: Usage = {
      ...usage,
      inputTokens: subtract(usage.inputTokens, replay.inputTokens),
      cachedInputTokens: subtract(usage.cachedInputTokens, replay.cachedInputTokens),
      outputTokens: subtract(usage.outputTokens, replay.outputTokens),
      reasoningOutputTokens: subtract(usage.reasoningOutputTokens, replay.reasoningOutputTokens),
      totalTokensNormalized: subtract(usage.totalTokensNormalized, replay.totalTokens),
      totalTokensReported: subtract(usage.totalTokensReported, replay.totalTokensReported),
  };
  const hasUsage =
    positiveNumber(adjusted.inputTokens) > 0 ||
    positiveNumber(adjusted.outputTokens) > 0 ||
    positiveNumber(adjusted.totalTokensReported) > 0;
  return {
    ...row,
    usage: hasUsage ? adjusted : undefined,
  };
}

function responseTurnKey(row: MessageRow): string {
  const turnId = row.responseTurnId?.trim();
  if (turnId) return `${recordString(row.dialogue_revision)}:${turnId}`;
  return recordString(row.id);
}

function recordResponseWait(target: Map<string, number>, row: MessageRow): void {
  if (row.human_authored !== true) return;
  const waitMs = positiveNumber(row.responseWaitMs);
  if (waitMs <= 0) return;
  const key = responseTurnKey(row);
  target.set(key, Math.max(target.get(key) ?? 0, waitMs));
}

function sumResponseWaits(values: Map<string, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}

function effectiveActiveMs(gapActiveMs: number, apiDurationMs: number, responseWaitMs: number): number {
  return responseWaitMs > 0 ? responseWaitMs : Math.max(gapActiveMs, apiDurationMs);
}

function addEstimatedCost(target: UsageAccumulator, estimate: ModelCostEstimate): void {
  target.estimatedCostUsd += estimate.totalCostUsd;
  target.estimatedInputCostUsd += estimate.inputCostUsd;
  target.estimatedCachedInputCostUsd += estimate.cachedInputCostUsd;
  target.estimatedCacheWriteCostUsd += estimate.cacheWriteCostUsd;
  target.estimatedOutputCostUsd += estimate.outputCostUsd;
  target.pricedTokens += estimate.pricedTokens;
  target.unpricedTokens += estimate.unpricedTokens;
  if (estimate.priced && estimate.pricedTokens > 0) target.pricedUsageMessages += 1;
  else if (estimate.unpricedTokens > 0) target.unpricedUsageMessages += 1;
}

function addUsage(
  target: UsageAccumulator,
  row: MessageRow,
  costEstimate: ModelCostEstimate = estimateModelTokenCost(modelKey(row), row.usage),
): void {
  const role = row.role ?? "unknown";
  const chars = safeInteger(row.content_chars);
  const usage = row.usage;
  const totalTokens = positiveNumber(usage?.totalTokensNormalized);

  target.messages += 1;
  if (row.model !== null && row.model !== undefined) target.responses += 1;
  target.contentChars += chars;
  if (role === "assistant") target.assistantChars += chars;
  else if (role === "user") target.userChars += chars;
  else if (role === "tool") target.toolChars += chars;

  if (usage) {
    target.usageMessages += 1;
    if (usage.isEstimated) target.estimatedUsageMessages += 1;
    const inputTokens = positiveNumber(usage.inputTokens);
    const cachedInputTokens = positiveNumber(usage.cachedInputTokens);
    const cacheWriteInputTokens = positiveNumber(usage.cacheWriteInputTokens);
    target.inputTokens += inputTokens;
    target.cachedInputTokens += cachedInputTokens;
    target.cacheWriteInputTokens += cacheWriteInputTokens;
    if (cachedInputTokens + cacheWriteInputTokens <= inputTokens) {
      target.uncachedInputTokens += inputTokens - cachedInputTokens - cacheWriteInputTokens;
      target.tokenBreakdownInputTokens += inputTokens;
      target.classifiedCachedInputTokens += cachedInputTokens;
      target.classifiedCacheWriteInputTokens += cacheWriteInputTokens;
      target.tokenBreakdownMessages += 1;
    } else {
      target.invalidTokenBreakdownMessages += 1;
    }
    target.outputTokens += positiveNumber(usage.outputTokens);
    target.reasoningOutputTokens += positiveNumber(usage.reasoningOutputTokens);
    target.totalTokens += totalTokens;
    target.totalTokensReported += positiveNumber(usage.totalTokensReported);
    addEstimatedCost(target, costEstimate);
  }

  const duration = positiveNumber(row.durationMs);
  const ttft = positiveNumber(row.ttftMs);
  const reportedDuration = positiveNumber(row.reportedDurationMs);
  if (duration > 0) target.durationMs.push(duration);
  if (ttft > 0) target.ttftMs.push(ttft);
  if (reportedDuration > 0) target.reportedDurationMs.push(reportedDuration);
  recordResponseWait(target.responseWaitByTurn, row);
  const reportedCost =
    typeof row.cost === "number"
      ? row.cost
      : positiveNumber(row.cost?.total) || positiveNumber(row.resultCostUsd);
  if (reportedCost > 0) {
    target.reportedCostUsd += reportedCost;
    target.reportedCostMessages += 1;
  }
}

function isVisibleAssistantAnswer(row: MessageRow): boolean {
  if (row.role !== "assistant" || row.visible_to_user !== true) return false;
  return safeInteger(row.content_chars) > 0 || positiveNumber(row.usage?.outputTokens) > 0;
}

function mergeUsage(target: UsageAccumulator, source: UsageAccumulator): void {
  target.messages += source.messages;
  target.responses += source.responses;
  target.usageMessages += source.usageMessages;
  target.estimatedUsageMessages += source.estimatedUsageMessages;
  target.inputTokens += source.inputTokens;
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
  target.tokenBreakdownInputTokens += source.tokenBreakdownInputTokens;
  target.classifiedCachedInputTokens += source.classifiedCachedInputTokens;
  target.classifiedCacheWriteInputTokens += source.classifiedCacheWriteInputTokens;
  target.tokenBreakdownMessages += source.tokenBreakdownMessages;
  target.invalidTokenBreakdownMessages += source.invalidTokenBreakdownMessages;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.totalTokensReported += source.totalTokensReported;
  target.contentChars += source.contentChars;
  target.assistantChars += source.assistantChars;
  target.userChars += source.userChars;
  target.toolChars += source.toolChars;
  target.durationMs.push(...source.durationMs);
  target.ttftMs.push(...source.ttftMs);
  target.reportedDurationMs.push(...source.reportedDurationMs);
  target.reportedCostUsd += source.reportedCostUsd;
  target.reportedCostMessages += source.reportedCostMessages;
  target.estimatedCostUsd += source.estimatedCostUsd;
  target.estimatedInputCostUsd += source.estimatedInputCostUsd;
  target.estimatedCachedInputCostUsd += source.estimatedCachedInputCostUsd;
  target.estimatedCacheWriteCostUsd += source.estimatedCacheWriteCostUsd;
  target.estimatedOutputCostUsd += source.estimatedOutputCostUsd;
  target.pricedUsageMessages += source.pricedUsageMessages;
  target.unpricedUsageMessages += source.unpricedUsageMessages;
  target.pricedTokens += source.pricedTokens;
  target.unpricedTokens += source.unpricedTokens;
  for (const [turn, waitMs] of source.responseWaitByTurn) {
    target.responseWaitByTurn.set(turn, Math.max(target.responseWaitByTurn.get(turn) ?? 0, waitMs));
  }
}

function modelKey(row: MessageRow): string | null {
  if (!row.vendor_slug || !row.model_name) return null;
  return `${row.vendor_slug}/${row.model_name}`;
}

function vendorFromModelKey(key: string): string {
  return key.includes("/") ? key.split("/", 1)[0]! : "unknown";
}

function displayModel(key: string | null | undefined): string {
  if (!key) return "no model metadata";
  const slash = key.indexOf("/");
  return slash >= 0 ? key.slice(slash + 1) : key;
}

function displayVendor(key: string | null | undefined): string {
  if (!key) return "unknown";
  return key.includes("/") ? key.split("/", 1)[0]! : "unknown";
}

function boundedCacheShare(inputTokens: number, cachedInputTokens: number): number | null {
  if (inputTokens <= 0 || cachedInputTokens < 0) return null;
  const ratio = cachedInputTokens / inputTokens;
  return ratio <= 1 ? ratio : null;
}

function harnessRank(harness: string | undefined): number {
  const index = HARNESS_ORDER.indexOf(harness as never);
  return index >= 0 ? index : 999;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  return values[index]!;
}

function activeMsFromTimestamps(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const sorted = [...new Set(timestamps)].sort((a, b) => a - b);
  let activeMs = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const delta = sorted[index]! - sorted[index - 1]!;
    if (delta > 0 && delta <= IDLE_GAP_MS) activeMs += delta;
  }
  return activeMs;
}

function dayAccumulator(date: string): DayAccumulator {
  return {
    date,
    messages: 0,
    inferredTimestampMessages: 0,
    usageMessages: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contentChars: 0,
    activeMs: 0,
    durationMs: 0,
    reportedDurationMs: 0,
    responseWaitMs: 0,
    interpolatedResponseWaitMs: 0,
    responseWaitByTurn: new Map(),
    sessions: new Set(),
    harnessMessages: new Map(),
  };
}

function ensureDay(dayStats: Map<string, DayAccumulator>, date: string): DayAccumulator {
  const existing = dayStats.get(date);
  if (existing) return existing;
  const created = dayAccumulator(date);
  dayStats.set(date, created);
  return created;
}

function addDailyMessage(
  dayStats: Map<string, DayAccumulator>,
  dialogue: DialogueAccumulator,
  row: MessageRow,
  timestampMs: number,
  timestampInferred = false,
): void {
  const day = ensureDay(dayStats, dayKey(timestampMs));
  day.messages += 1;
  if (timestampInferred) day.inferredTimestampMessages += 1;
  day.contentChars += safeInteger(row.content_chars);
  day.sessions.add(dialogue.id);
  day.harnessMessages.set(
    dialogue.harness,
    (day.harnessMessages.get(dialogue.harness) ?? 0) + 1,
  );
  if (row.usage) {
    day.usageMessages += 1;
    const inputTokens = positiveNumber(row.usage.inputTokens);
    const cachedInputTokens = positiveNumber(row.usage.cachedInputTokens);
    const cacheWriteInputTokens = positiveNumber(row.usage.cacheWriteInputTokens);
    day.inputTokens += inputTokens;
    day.cachedInputTokens += cachedInputTokens;
    day.cacheWriteInputTokens += cacheWriteInputTokens;
    if (cachedInputTokens + cacheWriteInputTokens <= inputTokens) {
      day.uncachedInputTokens += inputTokens - cachedInputTokens - cacheWriteInputTokens;
    }
    day.outputTokens += positiveNumber(row.usage.outputTokens);
    day.totalTokens += positiveNumber(row.usage.totalTokensNormalized);
  }
  day.durationMs += positiveNumber(row.durationMs);
  day.reportedDurationMs += positiveNumber(row.reportedDurationMs);
  recordResponseWait(day.responseWaitByTurn, row);
}

function monthlyBreakdownGroup(
  dialogue: DialogueAccumulator,
  row: MessageRow | null,
  dimension: MonthlyBreakdownDimension,
  dominantModel: string | null = null,
): { group: string; label: string } {
  if (dimension === "project") {
    return { group: dialogue.projectKey, label: dialogue.project };
  }
  if (dimension === "harness") {
    return { group: dialogue.harness, label: dialogue.harness };
  }
  const vendor = row?.vendor_slug || displayVendor(dominantModel);
  return { group: vendor || "unknown", label: vendor || "unknown" };
}

function ensureMonthlyBreakdown(
  breakdowns: Map<string, MonthlyBreakdownAccumulator>,
  month: string,
  dimension: MonthlyBreakdownDimension,
  group: string,
  label: string,
): MonthlyBreakdownAccumulator {
  const key = `${month}\u0000${dimension}\u0000${group}`;
  const existing = breakdowns.get(key);
  if (existing) return existing;
  const created: MonthlyBreakdownAccumulator = {
    month,
    dimension,
    group,
    label,
    messages: 0,
    contentChars: 0,
    totalTokens: 0,
    outputTokens: 0,
    agentWorkMeasuredMs: 0,
    agentWorkEstimatedMs: 0,
  };
  breakdowns.set(key, created);
  return created;
}

function addMonthlyBreakdownMessage(
  breakdowns: Map<string, MonthlyBreakdownAccumulator>,
  dialogue: DialogueAccumulator,
  row: MessageRow,
  timestampMs: number,
): void {
  const month = dayKey(timestampMs).slice(0, 7);
  for (const dimension of ["project", "harness", "vendor"] as const) {
    const { group, label } = monthlyBreakdownGroup(dialogue, row, dimension);
    const target = ensureMonthlyBreakdown(breakdowns, month, dimension, group, label);
    target.messages += 1;
    target.contentChars += safeInteger(row.content_chars);
    target.totalTokens += positiveNumber(row.usage?.totalTokensNormalized);
    target.outputTokens += positiveNumber(row.usage?.outputTokens);
  }
}

function addDailyActiveTime(
  dayStats: Map<string, DayAccumulator>,
  dialogue: DialogueAccumulator,
  estimate?: ResponseWaitEstimate,
): void {
  if (dialogue.timestamps.length === 0) {
    const anchor = dialogue.startedAt ?? dialogue.updatedAt;
    if (anchor !== null) {
      if (dialogue.responseWaitMsSum > 0) return;
      if (dialogue.exactTurnDurationMsSum > 0) {
        ensureDay(dayStats, dayKey(anchor)).activeMs += dialogue.exactTurnDurationMsSum;
      } else if (estimate) {
        ensureDay(dayStats, dayKey(anchor)).interpolatedResponseWaitMs += estimate.ms;
      }
    }
    return;
  }
  // Exact end-to-end turn timing is already assigned by addDailyMessage.
  // Gap/API timing is only a fallback for dialogues without task events.
  if (dialogue.responseWaitMsSum > 0) return;
  const sorted = [...new Set(dialogue.timestamps)].sort((a, b) => a - b);
  if (dialogue.exactTurnDurationMsSum > 0) {
    const counts = new Map<string, number>();
    for (const timestamp of dialogue.timestamps) {
      const date = dayKey(timestamp);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    for (const [date, count] of counts) {
      ensureDay(dayStats, date).activeMs += dialogue.exactTurnDurationMsSum * (count / total);
    }
    return;
  }
  if (estimate) {
    const counts = new Map<string, number>();
    for (const timestamp of dialogue.timestamps) {
      const date = dayKey(timestamp);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    for (const [date, count] of counts) {
      ensureDay(dayStats, date).interpolatedResponseWaitMs += estimate.ms * (count / total);
    }
    return;
  }
  let gapActiveMs = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const delta = sorted[index]! - sorted[index - 1]!;
    if (delta > 0 && delta <= IDLE_GAP_MS) {
      // Геп до 3 минут целиком относим к дню события справа; ошибка на
      // переходе полуночи максимум 3 минуты и не влияет на active-day count.
      ensureDay(dayStats, dayKey(sorted[index]!)).activeMs += delta;
      gapActiveMs += delta;
    }
  }
  const backedMs = Math.max(dialogue.durationMsSum, dialogue.reportedDurationMsSum);
  if (backedMs > gapActiveMs) {
    ensureDay(dayStats, dayKey(sorted[0]!)).activeMs += backedMs - gapActiveMs;
  }
}

function finalizeDayStats(dayStats: Map<string, DayAccumulator>): Array<Record<string, unknown>> {
  const sortedDays = [...dayStats.values()].sort((a, b) => a.date.localeCompare(b.date));
  const assignedTurns = new Set<string>();
  for (const day of sortedDays) {
    day.responseWaitMs = 0;
    for (const [turn, waitMs] of day.responseWaitByTurn) {
      if (assignedTurns.has(turn)) continue;
      assignedTurns.add(turn);
      day.responseWaitMs += waitMs;
    }
  }
  return sortedDays
    .map((day) => {
      const topHarness = [...day.harnessMessages.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      return roundObject({
        date: day.date,
        messages: day.messages,
        inferredTimestampMessages: day.inferredTimestampMessages,
        usageMessages: day.usageMessages,
        sessions: day.sessions.size,
        inputTokens: day.inputTokens,
        uncachedInputTokens: day.uncachedInputTokens,
        cachedInputTokens: day.cachedInputTokens,
        cacheWriteInputTokens: day.cacheWriteInputTokens,
        outputTokens: day.outputTokens,
        totalTokens: day.totalTokens,
        contentChars: day.contentChars,
        activeHours:
          (day.activeMs + day.responseWaitMs + day.interpolatedResponseWaitMs) / 3_600_000,
        activeMinutes:
          (day.activeMs + day.responseWaitMs + day.interpolatedResponseWaitMs) / 60_000,
        gapActiveHours: day.activeMs / 3_600_000,
        responseWaitHours: day.responseWaitMs / 3_600_000,
        interpolatedResponseWaitHours: day.interpolatedResponseWaitMs / 3_600_000,
        totalResponseWaitHours:
          (day.responseWaitMs + day.interpolatedResponseWaitMs) / 3_600_000,
        durationHours: day.durationMs / 3_600_000,
        reportedDurationHours: day.reportedDurationMs / 3_600_000,
        topHarness: topHarness?.[0] ?? null,
        topHarnessMessages: topHarness?.[1] ?? 0,
        harnessMessages: Object.fromEntries(
          [...day.harnessMessages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
        ),
      });
    });
}

function addMonthlyAgentWork(
  monthly: Map<string, MonthlyAgentAccumulator>,
  breakdowns: Map<string, MonthlyBreakdownAccumulator>,
  dialogue: DialogueAccumulator,
  model: string | null,
  measuredMs: number,
  estimatedMs: number,
): void {
  const timestamps = dialogue.timestamps.length > 0
    ? dialogue.timestamps
    : [dialogue.startedAt ?? dialogue.updatedAt].filter((value): value is number => value !== null);
  if (timestamps.length === 0) return;
  const counts = new Map<string, number>();
  for (const timestamp of timestamps) {
    const month = dayKey(timestamp).slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  for (const [month, count] of counts) {
    const target = monthly.get(month) ?? { measuredMs: 0, estimatedMs: 0 };
    const share = count / total;
    target.measuredMs += measuredMs * share;
    target.estimatedMs += estimatedMs * share;
    monthly.set(month, target);
    for (const dimension of ["project", "harness", "vendor"] as const) {
      const { group, label } = monthlyBreakdownGroup(dialogue, null, dimension, model);
      const breakdown = ensureMonthlyBreakdown(breakdowns, month, dimension, group, label);
      breakdown.agentWorkMeasuredMs += measuredMs * share;
      breakdown.agentWorkEstimatedMs += estimatedMs * share;
    }
  }
}

function finalizeMonthlyBreakdowns(
  breakdowns: Map<string, MonthlyBreakdownAccumulator>,
): Array<Record<string, unknown>> {
  return [...breakdowns.values()]
    .sort((a, b) =>
      a.month.localeCompare(b.month) ||
      a.dimension.localeCompare(b.dimension) ||
      a.label.localeCompare(b.label) ||
      a.group.localeCompare(b.group),
    )
    .map((row) => roundObject({
      month: row.month,
      dimension: row.dimension,
      group: row.group,
      label: row.label,
      messages: row.messages,
      contentChars: row.contentChars,
      totalTokens: row.totalTokens,
      outputTokens: row.outputTokens,
      agentWorkMeasuredHours: row.agentWorkMeasuredMs / 3_600_000,
      agentWorkEstimatedHours: row.agentWorkEstimatedMs / 3_600_000,
      agentWorkHours:
        (row.agentWorkMeasuredMs + row.agentWorkEstimatedMs) / 3_600_000,
    }));
}

function finalizeMonthlyStats(
  dailyStats: Array<Record<string, unknown>>,
  agentWork: Map<string, MonthlyAgentAccumulator>,
  breakdowns: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const monthly = new Map<string, Record<string, number | string>>();
  const fields = [
    "messages",
    "contentChars",
    "totalTokens",
    "inputTokens",
    "uncachedInputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "activeHours",
    "responseWaitHours",
    "interpolatedResponseWaitHours",
  ];
  for (const day of dailyStats) {
    const month = String(day.date ?? "").slice(0, 7);
    if (!month) continue;
    const row = monthly.get(month) ?? { month };
    for (const field of fields) {
      row[field] = Number(row[field] ?? 0) + Number(day[field] ?? 0);
    }
    monthly.set(month, row);
  }
  for (const [month, work] of agentWork) {
    const row = monthly.get(month) ?? { month };
    row.agentWorkMeasuredHours = work.measuredMs / 3_600_000;
    row.agentWorkEstimatedHours = work.estimatedMs / 3_600_000;
    row.agentWorkHours = (work.measuredMs + work.estimatedMs) / 3_600_000;
    monthly.set(month, row);
  }
  const projectsByMonth = new Map<string, Set<string>>();
  for (const item of breakdowns) {
    if (item.dimension !== "project" || Number(item.messages ?? 0) <= 0) continue;
    const month = String(item.month ?? "");
    const group = String(item.group ?? "");
    if (!month || !group || group === "unassigned") continue;
    const projects = projectsByMonth.get(month) ?? new Set<string>();
    projects.add(group);
    projectsByMonth.set(month, projects);
  }
  for (const [month, projects] of projectsByMonth) {
    const row = monthly.get(month) ?? { month };
    row.projects = projects.size;
    monthly.set(month, row);
  }
  return [...monthly.values()]
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((row) => roundObject(row));
}

function elapsedMs(row: DialogueAccumulator): number {
  if (row.startedAt === null || row.updatedAt === null) return 0;
  return Math.max(0, row.updatedAt - row.startedAt);
}

function timingDiagnostics(
  dialogue: DialogueAccumulator,
  gapActiveMs: number,
  durationBackedMs: number,
  responseWaitMs: number,
  exactTurnDurationMs: number,
  estimate?: ResponseWaitEstimate,
): TimingDiagnostics {
  const timestamps = dialogue.timestamps.filter((value) => Number.isFinite(value));
  const uniqueTimestamps = new Set(timestamps).size;
  const timestampSpanMs =
    timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const uniqueTimestampRatio =
    timestamps.length > 0 ? uniqueTimestamps / timestamps.length : null;
  let timingQuality = "gap_heuristic";
  let timingWarning: string | null = null;
  let waitSource = "gap_heuristic";

  if (responseWaitMs > 0) {
    timingQuality = gapActiveMs > 0 ? "mixed_response_wait_and_gap" : "response_wait_backed";
    waitSource = "exact_response_wait";
  } else if (exactTurnDurationMs > 0) {
    timingQuality = "exact_turn_duration";
    waitSource = "exact_turn_duration";
  } else if (estimate) {
    timingQuality = estimate.source;
    waitSource = estimate.source;
  } else if (durationBackedMs > 0) {
    timingQuality = gapActiveMs > 0 ? "mixed_duration_and_gap" : "duration_backed";
    waitSource = "api_or_reported_duration";
  }
  if (timestamps.length === 0 && durationBackedMs === 0 && !estimate) {
    timingQuality = "missing_timing";
    timingWarning = "no message timestamps or duration metadata";
  } else if (
    dialogue.messages >= 500 &&
    durationBackedMs === 0 &&
    timestampSpanMs <= 15 * 60 * 1000 &&
    uniqueTimestampRatio !== null &&
    uniqueTimestampRatio < 0.25
  ) {
    timingQuality = "timestamp_replay_suspect";
    timingWarning = "many messages share a short timestamp span; likely replay/snapshot timestamps";
  } else if (
    dialogue.messages >= 1000 &&
    durationBackedMs === 0 &&
    gapActiveMs <= 15 * 60 * 1000
  ) {
    timingQuality = "low_active_many_messages";
    timingWarning = "many messages but active time <= 15 minutes and no exact duration";
  }

  return {
    gapActiveMs,
    durationBackedMs,
    responseWaitMs,
    timestampSpanMs,
    uniqueTimestamps,
    uniqueTimestampRatio,
    timingQuality,
    timingWarning,
    waitSource,
    waitEstimated: estimate !== undefined,
    waitEstimateLowerMs: estimate?.lowerMs ?? 0,
    waitEstimateUpperMs: estimate?.upperMs ?? 0,
    waitEstimateDonors: estimate?.donorCount ?? 0,
  };
}

function dominantModel(dialogue: DialogueAccumulator): string | null {
  let best = dialogue.primaryModel;
  let bestTokens = 0;
  let bestMessages = 0;
  for (const [key, value] of dialogue.byModel.entries()) {
    if (
      value.totalTokens > bestTokens ||
      (value.totalTokens === bestTokens && value.responses > bestMessages)
    ) {
      best = key;
      bestTokens = value.totalTokens;
      bestMessages = value.responses;
    }
  }
  return best;
}

function responseWaitFeatures(dialogue: DialogueAccumulator): [number, number] {
  const calls = Math.max(1, dialogue.usageMessages);
  return [Math.log1p(calls), Math.log1p(dialogue.outputTokens / calls)];
}

function measuredWaitMs(dialogue: DialogueAccumulator): number {
  return dialogue.responseWaitMsSum > 0
    ? dialogue.responseWaitMsSum
    : dialogue.exactTurnDurationMsSum;
}

function responseWaitDistance(a: DialogueAccumulator, b: DialogueAccumulator): number {
  const [aCalls, aOutputPerCall] = responseWaitFeatures(a);
  const [bCalls, bOutputPerCall] = responseWaitFeatures(b);
  return Math.hypot(
    (aCalls - bCalls) * 0.35,
    (aOutputPerCall - bOutputPerCall) * 0.65,
  );
}

function interpolateResponseWaits(
  dialogues: Iterable<DialogueAccumulator>,
): Map<string, ResponseWaitEstimate> {
  const rows = [...dialogues];
  const donors = rows.filter((row) => measuredWaitMs(row) > 0);
  const estimates = new Map<string, ResponseWaitEstimate>();
  for (const target of rows) {
    if (measuredWaitMs(target) > 0 || donors.length === 0) continue;
    const model = dominantModel(target);
    const vendor = displayVendor(model);
    const sameModel = model ? donors.filter((row) => dominantModel(row) === model) : [];
    const sameVendor = vendor !== "unknown"
      ? donors.filter((row) => displayVendor(dominantModel(row)) === vendor)
      : [];
    let candidates: DialogueAccumulator[];
    let source: ResponseWaitEstimate["source"];
    if (sameModel.length >= 8) {
      candidates = sameModel;
      source = "interpolated_same_model";
    } else if (sameVendor.length >= 30) {
      candidates = sameVendor;
      source = "interpolated_same_vendor";
    } else {
      candidates = donors;
      source = "interpolated_global";
    }
    const neighbors = candidates
      .map((donor) => ({ donor, distance: responseWaitDistance(target, donor) }))
      .sort((a, b) => a.distance - b.distance || a.donor.id.localeCompare(b.donor.id))
      .slice(0, Math.min(15, candidates.length));
    if (neighbors.length === 0) continue;
    let weightSum = 0;
    let weightedLogWaitPerCall = 0;
    for (const neighbor of neighbors) {
      const weight = 1 / Math.pow(0.15 + neighbor.distance, 2);
      weightSum += weight;
      weightedLogWaitPerCall += weight * Math.log(
        Math.max(1, measuredWaitMs(neighbor.donor)) /
          Math.max(1, neighbor.donor.usageMessages),
      );
    }
    const targetCalls = Math.max(1, target.usageMessages);
    const neighborWaitsPerCall = neighbors.map(
      (neighbor) => measuredWaitMs(neighbor.donor) /
        Math.max(1, neighbor.donor.usageMessages),
    );
    const apiFloor = Math.max(target.durationMsSum, target.reportedDurationMsSum);
    const interpolated = Math.exp(weightedLogWaitPerCall / weightSum) * targetCalls;
    const lower = (percentile([...neighborWaitsPerCall], 20) ?? interpolated / targetCalls) *
      targetCalls;
    const upper = (percentile([...neighborWaitsPerCall], 80) ?? interpolated / targetCalls) *
      targetCalls;
    const ms = Math.max(apiFloor, interpolated);
    estimates.set(target.revision, {
      ms,
      lowerMs: Math.min(ms, Math.max(apiFloor, lower)),
      upperMs: Math.max(ms, Math.max(apiFloor, upper)),
      source,
      donorCount: neighbors.length,
    });
  }
  return estimates;
}

function finalizeGroup(group: GroupAccumulator): Record<string, unknown> {
  const durationP50 = percentile(group.durationMs, 50);
  const durationP90 = percentile(group.durationMs, 90);
  const ttftP50 = percentile(group.ttftMs, 50);
  const ttftP90 = percentile(group.ttftMs, 90);
  const reportedDurationP50 = percentile(group.reportedDurationMs, 50);
  const reportedDurationP90 = percentile(group.reportedDurationMs, 90);
  const responseWaits = [...group.responseWaitByTurn.values()];
  const responseWaitP50 = percentile(responseWaits, 50);
  const responseWaitP90 = percentile(responseWaits, 90);
  const durationHours = group.durationMs.reduce((sum, value) => sum + value, 0) / 3_600_000;
  const responseWaitHours = group.responseWaitActiveMs / 3_600_000;
  const interpolatedResponseWaitHours = group.interpolatedWaitActiveMs / 3_600_000;
  const activeHours = group.activeMs / 3_600_000;
  const agentWorkMeasuredHours = group.agentWorkMeasuredMs / 3_600_000;
  const agentWorkEstimatedHours = group.agentWorkEstimatedMs / 3_600_000;
  const agentWorkHours = agentWorkMeasuredHours + agentWorkEstimatedHours;
  const elapsedHours = group.elapsedMs / 3_600_000;
  const rawCacheInputRatio =
    group.inputTokens > 0 ? group.cachedInputTokens / group.inputTokens : null;
  return roundObject({
    key: group.key,
    label: group.label,
    harness: group.harness,
    model: group.model,
    vendor: group.vendor,
    dialogues: group.dialogues.size,
    dominantSessions: group.dominantSessions,
    messages: group.messages,
    responses: group.responses,
    usageMessages: group.usageMessages,
    estimatedUsageMessages: group.estimatedUsageMessages,
    totalTokens: group.totalTokens,
    inputTokens: group.inputTokens,
    uncachedInputTokens: group.uncachedInputTokens,
    cachedInputTokens: group.cachedInputTokens,
    cacheWriteInputTokens: group.cacheWriteInputTokens,
    classifiedCachedInputTokens: group.classifiedCachedInputTokens,
    classifiedCacheWriteInputTokens: group.classifiedCacheWriteInputTokens,
    tokenBreakdownInputTokens: group.tokenBreakdownInputTokens,
    tokenBreakdownCoverage: group.inputTokens > 0 ? group.tokenBreakdownInputTokens / group.inputTokens : null,
    tokenBreakdownMessages: group.tokenBreakdownMessages,
    invalidTokenBreakdownMessages: group.invalidTokenBreakdownMessages,
    outputTokens: group.outputTokens,
    reasoningOutputTokens: group.reasoningOutputTokens,
    contentChars: group.contentChars,
    assistantChars: group.assistantChars,
    userChars: group.userChars,
    toolChars: group.toolChars,
    activeHours,
    agentWorkMeasuredHours,
    agentWorkEstimatedHours,
    agentWorkHours,
    agentWorkToUserWaitRatio: responseWaitHours > 0 ? agentWorkHours / responseWaitHours : null,
    responseWaitHours,
    interpolatedResponseWaitHours,
    totalResponseWaitHours: responseWaitHours + interpolatedResponseWaitHours,
    interpolatedWaitSessions: group.interpolatedWaitSessions,
    responseWaitShareOfActive:
      activeHours > 0 ? (responseWaitHours + interpolatedResponseWaitHours) / activeHours : null,
    elapsedHours,
    activeShareOfElapsed: elapsedHours > 0 ? activeHours / elapsedHours : null,
    avgTokensPerUsageMessage: group.usageMessages > 0 ? group.totalTokens / group.usageMessages : null,
    avgOutputTokensPerUsageMessage: group.usageMessages > 0 ? group.outputTokens / group.usageMessages : null,
    outputShare: group.totalTokens > 0 ? group.outputTokens / group.totalTokens : null,
    reasoningShareOfOutput: group.outputTokens > 0 ? group.reasoningOutputTokens / group.outputTokens : null,
    cacheShareOfInput: boundedCacheShare(group.inputTokens, group.cachedInputTokens),
    rawCacheInputRatio,
    tokensPerActiveHour: activeHours > 0 ? group.totalTokens / activeHours : null,
    outputTokensPerActiveHour: activeHours > 0 ? group.outputTokens / activeHours : null,
    charsPerActiveHour: activeHours > 0 ? group.contentChars / activeHours : null,
    charsPer1kTokens: group.totalTokens > 0 ? (group.contentChars / group.totalTokens) * 1000 : null,
    durationCount: group.durationMs.length,
    durationHours,
    durationCoverage: group.responses > 0 ? group.durationMs.length / group.responses : null,
    durationP50Ms: durationP50,
    durationP90Ms: durationP90,
    ttftCount: group.ttftMs.length,
    ttftP50Ms: ttftP50,
    ttftP90Ms: ttftP90,
    reportedDurationCount: group.reportedDurationMs.length,
    reportedDurationHours: group.reportedDurationMs.reduce((sum, value) => sum + value, 0) / 3_600_000,
    reportedCostUsd: group.reportedCostUsd,
    reportedCostMessages: group.reportedCostMessages,
    reportedCostCoverage: group.responses > 0 ? group.reportedCostMessages / group.responses : null,
    estimatedCostUsd: group.estimatedCostUsd,
    estimatedInputCostUsd: group.estimatedInputCostUsd,
    estimatedCachedInputCostUsd: group.estimatedCachedInputCostUsd,
    estimatedCacheWriteCostUsd: group.estimatedCacheWriteCostUsd,
    estimatedOutputCostUsd: group.estimatedOutputCostUsd,
    pricedUsageMessages: group.pricedUsageMessages,
    unpricedUsageMessages: group.unpricedUsageMessages,
    pricedTokens: group.pricedTokens,
    unpricedTokens: group.unpricedTokens,
    estimatedCostCoverage: group.pricedTokens + group.unpricedTokens > 0
      ? group.pricedTokens / (group.pricedTokens + group.unpricedTokens)
      : null,
    effectiveCostPerMillionTokens: group.pricedTokens > 0
      ? group.estimatedCostUsd * 1_000_000 / group.pricedTokens
      : null,
    reportedDurationP50Ms: reportedDurationP50,
    reportedDurationP90Ms: reportedDurationP90,
    responseWaitTurnCount: responseWaits.length,
    responseWaitP50Ms: responseWaitP50,
    responseWaitP90Ms: responseWaitP90,
  });
}

function finalizeModelGroup(group: GroupAccumulator): Record<string, unknown> {
  const finalized = finalizeGroup(group);
  const pricing = serializablePricing(group.key);
  return {
    ...finalized,
    pricing,
    pricingSourceKind: pricing.sourceKind,
    pricingSourceLabel: pricing.sourceLabel,
    pricedAs: pricing.pricedAs,
  };
}

function roundObject<T extends Record<string, unknown>>(value: T): T {
  const rounded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") {
      rounded[key] = Number.isFinite(item) ? Math.round(item * 1_000_000) / 1_000_000 : null;
    } else {
      rounded[key] = item;
    }
  }
  return rounded as T;
}

function sessionPoint(
  dialogue: DialogueAccumulator,
  activeMs: number,
  agentWorkMeasuredMs: number,
  agentWorkEstimatedMs: number,
  elapsed: number,
  model: string | null,
  timing: TimingDiagnostics,
) {
  const activeHours = activeMs / 3_600_000;
  return roundObject({
    id: dialogue.id.replace(/^dialogue:/, "session:").slice(0, 22),
    dialogueId: dialogue.id,
    externalId: dialogue.externalId,
    projectKey: dialogue.projectKey,
    project: dialogue.project,
    harness: dialogue.harness,
    modelKey: model,
    model: displayModel(model),
    vendor: displayVendor(model),
    messages: dialogue.messages,
    usageMessages: dialogue.usageMessages,
    responseWaitTurnCount: dialogue.responseWaitByTurn.size,
    declaredMessages: dialogue.messageCountDeclared,
    chunks: dialogue.chunkCountDeclared,
    totalTokens: dialogue.totalTokens,
    inputTokens: dialogue.inputTokens,
    uncachedInputTokens: dialogue.uncachedInputTokens,
    cachedInputTokens: dialogue.cachedInputTokens,
    cacheWriteInputTokens: dialogue.cacheWriteInputTokens,
    outputTokens: dialogue.outputTokens,
    reasoningOutputTokens: dialogue.reasoningOutputTokens,
    contentChars: dialogue.contentChars,
    apiEquivalentCostUsd: dialogue.estimatedCostUsd,
    estimatedCostUsd: dialogue.estimatedCostUsd,
    estimatedCostCoverage: dialogue.pricedTokens + dialogue.unpricedTokens > 0
      ? dialogue.pricedTokens / (dialogue.pricedTokens + dialogue.unpricedTokens)
      : null,
    reportedCostUsd: dialogue.reportedCostUsd,
    costedUsageMessages: dialogue.pricedUsageMessages,
    date: dialogue.timestamps.length > 0
      ? dayKey(Math.min(...dialogue.timestamps))
      : dialogue.startedAt !== null || dialogue.updatedAt !== null
        ? dayKey(dialogue.startedAt ?? dialogue.updatedAt!)
        : null,
    activeSeconds: activeMs / 1000,
    activeMinutes: activeMs / 60_000,
    activeHours,
    agentWorkMeasuredHours: agentWorkMeasuredMs / 3_600_000,
    agentWorkEstimatedHours: agentWorkEstimatedMs / 3_600_000,
    agentWorkHours: (agentWorkMeasuredMs + agentWorkEstimatedMs) / 3_600_000,
    gapActiveHours: timing.gapActiveMs / 3_600_000,
    durationBackedHours: timing.durationBackedMs / 3_600_000,
    apiDurationHours: dialogue.durationMsSum / 3_600_000,
    reportedDurationHours: dialogue.reportedDurationMsSum / 3_600_000,
    responseWaitHours: timing.responseWaitMs / 3_600_000,
    exactTurnDurationHours: dialogue.exactTurnDurationMsSum / 3_600_000,
    measuredActiveHours:
      Math.max(timing.responseWaitMs, dialogue.exactTurnDurationMsSum) / 3_600_000,
    interpolatedResponseWaitHours:
      (timing.waitEstimated ? dialogue.interpolatedResponseWaitMs : 0) / 3_600_000,
    waitSource: timing.waitSource,
    waitEstimated: timing.waitEstimated,
    waitEstimateLowerHours: timing.waitEstimateLowerMs / 3_600_000,
    waitEstimateUpperHours: timing.waitEstimateUpperMs / 3_600_000,
    waitEstimateDonors: timing.waitEstimateDonors,
    timestampSpanHours: timing.timestampSpanMs / 3_600_000,
    uniqueTimestamps: timing.uniqueTimestamps,
    uniqueTimestampRatio: timing.uniqueTimestampRatio,
    timingQuality: timing.timingQuality,
    timingWarning: timing.timingWarning,
    elapsedHours: elapsed / 3_600_000,
    activeShareOfElapsed: elapsed > 0 ? activeMs / elapsed : null,
    avgTokensPerUsageMessage: dialogue.usageMessages > 0 ? dialogue.totalTokens / dialogue.usageMessages : null,
    outputTokensPerActiveHour: activeHours > 0 ? dialogue.outputTokens / activeHours : null,
    tokensPerActiveHour: activeHours > 0 ? dialogue.totalTokens / activeHours : null,
    cacheShareOfInput: dialogue.inputTokens > 0 ? dialogue.cachedInputTokens / dialogue.inputTokens : null,
    outputShare: dialogue.totalTokens > 0 ? dialogue.outputTokens / dialogue.totalTokens : null,
  });
}

async function loadDialogues(db: Surreal): Promise<Map<string, DialogueAccumulator>> {
  const rows = await selectAll<DialogueRow>(
    db,
    `SELECT id, workspace, workspace.name AS project_name,
       workspace.repository_identity AS project_repository_identity,
       external_id, current_revision,
       current_revision.source_revision AS source_revision,
       current_revision.parser_version AS parser_version,
       current_revision.created_at AS revision_created_at,
       harness_installation.harness.slug AS harness,
       current_revision.message_count AS message_count,
       current_revision.chunk_count AS chunk_count,
       primary_model.canonical_name AS primary_model,
       primary_model.vendor.slug AS primary_vendor,
       started_at,
       updated_at
     FROM dialogue
     WHERE current_revision != NONE
     ORDER BY id`,
  );
  const dialogues = new Map<string, DialogueAccumulator>();
  for (const row of rows) {
    const dialogue = dialogueAccumulator(row);
    if (dialogue.revision) dialogues.set(dialogue.revision, dialogue);
  }
  return dialogues;
}

async function excludeDialoguesWithoutAssistantAnswer(
  db: Surreal,
  dialoguesByRevision: Map<string, DialogueAccumulator>,
): Promise<{
  sourceCurrentDialogues: number;
  eligibleCurrentDialogues: number;
  excludedNoAssistantAnswer: number;
  eligibilityRowsScanned: number;
  sourceActiveHours: number;
  eligibleActiveHoursBeforeFilter: number;
  excludedNoAssistantAnswerActiveHours: number;
}> {
  const selectFields = `SELECT id, dialogue_revision, role, human_authored, visible_to_user, timestamp, content_chars, \`usage\` AS usage,
       metadata.durationMs AS durationMs,
       metadata.durationSource AS durationSource,
       metadata.reportedDurationMs AS reportedDurationMs,
       metadata.cost AS cost,
       metadata.turnResult.totalCostUsd AS resultCostUsd,
       response_wait_ms AS responseWaitMs,
       response_status AS responseStatus,
       response_completed_at AS responseCompletedAt,
       response_turn_id AS responseTurnId
     FROM message
     `;
  let rowsScanned = 0;
  let after: unknown | null = null;
  for (;;) {
    const query =
      after === null
        ? `${selectFields} ORDER BY id LIMIT $limit`
        : `${selectFields} WHERE id > $after ORDER BY id LIMIT $limit`;
    const rows = await selectAll<MessageRow>(
      db,
      query,
      after === null ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, after },
    );
    if (rows.length === 0) break;
    after = rows.at(-1)!.id;
    rowsScanned += rows.length;
    for (const row of rows) {
      const dialogue = dialoguesByRevision.get(recordString(row.dialogue_revision));
      if (!dialogue) continue;
      if (!dialogue.hasVisibleAssistantAnswer && isVisibleAssistantAnswer(row)) {
        dialogue.hasVisibleAssistantAnswer = true;
      }
      const ts = toMs(row.timestamp);
      if (ts !== null) dialogue.timestamps.push(ts);
      dialogue.durationMsSum += positiveNumber(row.durationMs);
      if (row.durationSource?.startsWith("codex.task_")) {
        dialogue.exactTurnDurationMsSum += positiveNumber(row.durationMs);
      }
      dialogue.reportedDurationMsSum += positiveNumber(row.reportedDurationMs);
      recordResponseWait(dialogue.responseWaitByTurn, row);
    }
    if (rowsScanned % 250_000 < PAGE_SIZE) {
      console.log(`checked ${rowsScanned.toLocaleString("en-US")} message rows for empty dialogues`);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  const sourceCurrentDialogues = dialoguesByRevision.size;
  let excludedNoAssistantAnswer = 0;
  let sourceActiveMs = 0;
  let eligibleActiveMs = 0;
  let excludedActiveMs = 0;
  for (const [revision, dialogue] of dialoguesByRevision.entries()) {
    const activeMs = effectiveActiveMs(
      activeMsFromTimestamps(dialogue.timestamps),
      Math.max(dialogue.durationMsSum, dialogue.reportedDurationMsSum),
      sumResponseWaits(dialogue.responseWaitByTurn),
    );
    sourceActiveMs += activeMs;
    if (dialogue.hasVisibleAssistantAnswer) eligibleActiveMs += activeMs;
    else excludedActiveMs += activeMs;
    dialogue.timestamps = [];
    dialogue.durationMsSum = 0;
    dialogue.exactTurnDurationMsSum = 0;
    dialogue.reportedDurationMsSum = 0;
    dialogue.responseWaitMsSum = 0;
    dialogue.responseWaitByTurn.clear();
    if (dialogue.hasVisibleAssistantAnswer) continue;
    dialoguesByRevision.delete(revision);
    excludedNoAssistantAnswer += 1;
  }
  return {
    sourceCurrentDialogues,
    eligibleCurrentDialogues: dialoguesByRevision.size,
    excludedNoAssistantAnswer,
    eligibilityRowsScanned: rowsScanned,
    sourceActiveHours: sourceActiveMs / 3_600_000,
    eligibleActiveHoursBeforeFilter: eligibleActiveMs / 3_600_000,
    excludedNoAssistantAnswerActiveHours: excludedActiveMs / 3_600_000,
  };
}

async function scanMessages(
  db: Surreal,
  dialoguesByRevision: Map<string, DialogueAccumulator>,
  replayByMessage: ReadonlyMap<string, UsageVector>,
): Promise<{
  rowsScanned: number;
  currentMessages: number;
  roleStats: Map<string, RoleAccumulator>;
  dayStats: Map<string, DayAccumulator>;
  modelStats: Map<string, GroupAccumulator>;
  harnessStats: Map<string, GroupAccumulator>;
  modelHarnessStats: Map<string, GroupAccumulator>;
  monthlyBreakdowns: Map<string, MonthlyBreakdownAccumulator>;
}> {
  const roleStats = new Map<string, RoleAccumulator>();
  const dayStats = new Map<string, DayAccumulator>();
  const modelStats = new Map<string, GroupAccumulator>();
  const harnessStats = new Map<string, GroupAccumulator>();
  const modelHarnessStats = new Map<string, GroupAccumulator>();
  const monthlyBreakdowns = new Map<string, MonthlyBreakdownAccumulator>();
  const selectFields = `SELECT id, dialogue, dialogue_revision, sequence, role,
       human_authored, visible_to_user,
       model,
       model.canonical_name AS model_name,
       model.vendor.slug AS vendor_slug,
       raw_model_name,
       service_provider,
       timestamp,
       content_chars,
       \`usage\` AS usage,
       metadata.durationMs AS durationMs,
       metadata.durationSource AS durationSource,
       metadata.ttftMs AS ttftMs,
       metadata.reportedDurationMs AS reportedDurationMs,
       metadata.cost AS cost,
       metadata.turnResult.totalCostUsd AS resultCostUsd,
       response_wait_ms AS responseWaitMs,
       response_status AS responseStatus,
       response_completed_at AS responseCompletedAt,
       response_turn_id AS responseTurnId
     FROM message
     `;

  let rowsScanned = 0;
  let currentMessages = 0;
  let after: unknown | null = null;
  for (;;) {
    const query =
      after === null
        ? `${selectFields} ORDER BY id LIMIT $limit`
        : `${selectFields} WHERE id > $after ORDER BY id LIMIT $limit`;
    const rows = await selectAll<MessageRow>(
      db,
      query,
      after === null ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, after },
    );
    if (rows.length === 0) break;
    after = rows.at(-1)!.id;
    rowsScanned += rows.length;
    for (const row of rows) {
      const revision = recordString(row.dialogue_revision);
      const dialogue = dialoguesByRevision.get(revision);
      if (!dialogue) continue;
      const effectiveRow = withoutReplay(row, replayByMessage.get(recordString(row.id)));
      const mKey = modelKey(effectiveRow);
      const costEstimate = estimateModelTokenCost(mKey, effectiveRow.usage);

      currentMessages += 1;
      addUsage(dialogue, effectiveRow, costEstimate);
      const ts = toMs(effectiveRow.timestamp);
      if (ts !== null) dialogue.timestamps.push(ts);
      const dailyTs = ts ?? dialogue.startedAt ?? dialogue.updatedAt;
      if (dailyTs !== null) {
        addDailyMessage(dayStats, dialogue, effectiveRow, dailyTs, ts === null);
        addMonthlyBreakdownMessage(monthlyBreakdowns, dialogue, effectiveRow, dailyTs);
      }
      const duration = positiveNumber(effectiveRow.durationMs);
      const reportedDuration = positiveNumber(effectiveRow.reportedDurationMs);
      if (duration > 0) dialogue.durationMsSum += duration;
      if (effectiveRow.durationSource?.startsWith("codex.task_")) {
        dialogue.exactTurnDurationMsSum += duration;
      }
      if (reportedDuration > 0) dialogue.reportedDurationMsSum += reportedDuration;
      recordResponseWait(dialogue.responseWaitByTurn, effectiveRow);

      const role = effectiveRow.role ?? "unknown";
      const roleItem = roleStats.get(role) ?? { role, messages: 0, contentChars: 0, tokens: 0 };
      roleItem.messages += 1;
      roleItem.contentChars += safeInteger(effectiveRow.content_chars);
      roleItem.tokens += positiveNumber(effectiveRow.usage?.totalTokensNormalized);
      roleStats.set(role, roleItem);

      const harness = dialogue.harness;
      const harnessGroup =
        harnessStats.get(harness) ?? groupAccumulator(harness, harness, { harness });
      addUsage(harnessGroup, effectiveRow, costEstimate);
      harnessGroup.dialogues.add(dialogue.id);
      harnessStats.set(harness, harnessGroup);

      if (!mKey) continue;

      const dialogueModel = dialogue.byModel.get(mKey) ?? emptyUsage();
      addUsage(dialogueModel, effectiveRow, costEstimate);
      dialogue.byModel.set(mKey, dialogueModel);

      const modelGroup =
        modelStats.get(mKey) ??
        groupAccumulator(mKey, displayModel(mKey), {
          model: displayModel(mKey),
          vendor: vendorFromModelKey(mKey),
        });
      addUsage(modelGroup, effectiveRow, costEstimate);
      modelGroup.dialogues.add(dialogue.id);
      modelStats.set(mKey, modelGroup);

      const mhKey = `${mKey}@@${harness}`;
      const modelHarnessGroup =
        modelHarnessStats.get(mhKey) ??
        groupAccumulator(mhKey, `${displayModel(mKey)} / ${harness}`, {
          model: displayModel(mKey),
          vendor: vendorFromModelKey(mKey),
          harness,
        });
      addUsage(modelHarnessGroup, effectiveRow, costEstimate);
      modelHarnessGroup.dialogues.add(dialogue.id);
      modelHarnessStats.set(mhKey, modelHarnessGroup);
    }
    if (rowsScanned % 100_000 < PAGE_SIZE) {
      console.log(`scanned ${rowsScanned.toLocaleString("en-US")} message rows, current ${currentMessages.toLocaleString("en-US")}`);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  for (const dialogue of dialoguesByRevision.values()) {
    dialogue.responseWaitMsSum = sumResponseWaits(dialogue.responseWaitByTurn);
  }
  return {
    rowsScanned,
    currentMessages,
    roleStats,
    dayStats,
    modelStats,
    harnessStats,
    modelHarnessStats,
    monthlyBreakdowns,
  };
}

function normalizedInvocationName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function skillNameFromContent(content: unknown): string | null {
  if (typeof content !== "string" || content.trim() === "") return null;
  let value: unknown = content;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const candidate = object.skill ?? object.name ?? object.skill_name ?? object.skillName;
  if (typeof candidate !== "string") return null;
  return normalizedSkillName(candidate);
}

function normalizedSkillName(value: string): string | null {
  const normalized = value.trim().replace(/^\$/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]*$/.test(normalized) ? normalized : null;
}

function skillNamesFromFileReferences(content: unknown): string[] {
  if (typeof content !== "string" || !/SKILL\.md/i.test(content)) return [];
  const names = new Set<string>();
  const pattern = /(?:^|[\\/])([^\\/\s"'`]+)[\\/]SKILL\.md\b/gi;
  for (const match of content.matchAll(pattern)) {
    const name = match[1] ? normalizedSkillName(match[1]) : null;
    if (name && name !== "skills") names.add(name);
  }
  return [...names];
}

function addInvocation(
  target: Map<string, InvocationAccumulator>,
  name: string,
  dialogue: DialogueAccumulator,
): void {
  const item = target.get(name) ?? {
    name,
    calls: 0,
    dialogues: new Set<string>(),
    harnesses: new Map<string, number>(),
  };
  item.calls += 1;
  item.dialogues.add(dialogue.id);
  item.harnesses.set(dialogue.harness, (item.harnesses.get(dialogue.harness) ?? 0) + 1);
  target.set(name, item);
}

function finalizeInvocations(
  invocations: Map<string, InvocationAccumulator>,
): Array<Record<string, unknown>> {
  return [...invocations.values()]
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .map((item, index) => {
      const harnesses = [...item.harnesses.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return {
        rank: index + 1,
        name: item.name,
        calls: item.calls,
        sessions: item.dialogues.size,
        topHarness: harnesses[0]?.[0] ?? null,
        harnesses: Object.fromEntries(harnesses),
      };
    });
}

async function scanInvocations(
  db: Surreal,
  dialoguesByRevision: Map<string, DialogueAccumulator>,
): Promise<InvocationScanResult> {
  const tools = new Map<string, InvocationAccumulator>();
  const skills = new Map<string, InvocationAccumulator>();
  let rowsScanned = 0;
  let toolCalls = 0;
  let skillCalls = 0;
  let explicitSkillCalls = 0;
  let inferredSkillLoads = 0;
  let namedSkillCalls = 0;
  let after: unknown | null = null;
  for (;;) {
    const query = after === null
      ? `SELECT id, dialogue_revision, tool_name, content
         FROM chunk WHERE kind = "tool_call" ORDER BY id LIMIT $limit`
      : `SELECT id, dialogue_revision, tool_name, content
         FROM chunk WHERE kind = "tool_call" AND id > $after ORDER BY id LIMIT $limit`;
    const rows = await selectAll<ToolCallRow>(
      db,
      query,
      after === null ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, after },
    );
    if (rows.length === 0) break;
    after = rows.at(-1)!.id;
    rowsScanned += rows.length;
    for (const row of rows) {
      const dialogue = dialoguesByRevision.get(recordString(row.dialogue_revision));
      if (!dialogue) continue;
      const toolName = normalizedInvocationName(row.tool_name);
      if (!toolName) continue;
      toolCalls += 1;
      addInvocation(tools, toolName, dialogue);
      const isSkillTool =
        toolName === "skill" || toolName.endsWith(".skill") || toolName.endsWith("__skill");
      if (isSkillTool) {
        skillCalls += 1;
        explicitSkillCalls += 1;
        const skillName = skillNameFromContent(row.content);
        if (!skillName) continue;
        namedSkillCalls += 1;
        addInvocation(skills, skillName, dialogue);
        continue;
      }
      for (const skillName of skillNamesFromFileReferences(row.content)) {
        skillCalls += 1;
        inferredSkillLoads += 1;
        namedSkillCalls += 1;
        addInvocation(skills, skillName, dialogue);
      }
    }
    console.log(
      `scanned ${rowsScanned.toLocaleString("en-US")} tool-call chunks, ` +
      `current ${toolCalls.toLocaleString("en-US")}`,
    );
    if (rows.length < PAGE_SIZE) break;
  }
  const toolStats = finalizeInvocations(tools);
  const skillStats = finalizeInvocations(skills);
  return {
    rowsScanned,
    toolCalls,
    uniqueTools: toolStats.length,
    skillCalls,
    explicitSkillCalls,
    inferredSkillLoads,
    namedSkillCalls,
    unparsedSkillCalls: explicitSkillCalls - (namedSkillCalls - inferredSkillLoads),
    uniqueSkills: skillStats.length,
    toolStats,
    skillStats,
  };
}

function addSessionTime(
  dialogue: DialogueAccumulator,
  model: string | null,
  activeMs: number,
  responseWaitMs: number,
  interpolatedWaitMs: number,
  agentWorkMeasuredMs: number,
  agentWorkEstimatedMs: number,
  elapsed: number,
  harnessStats: Map<string, GroupAccumulator>,
  modelStats: Map<string, GroupAccumulator>,
  modelHarnessStats: Map<string, GroupAccumulator>,
): void {
  const harnessGroup = harnessStats.get(dialogue.harness);
  if (harnessGroup) {
    harnessGroup.activeMs += activeMs;
    harnessGroup.responseWaitActiveMs += responseWaitMs;
    harnessGroup.interpolatedWaitActiveMs += interpolatedWaitMs;
    harnessGroup.agentWorkMeasuredMs += agentWorkMeasuredMs;
    harnessGroup.agentWorkEstimatedMs += agentWorkEstimatedMs;
    if (interpolatedWaitMs > 0) harnessGroup.interpolatedWaitSessions += 1;
    harnessGroup.elapsedMs += elapsed;
    harnessGroup.dominantSessions += 1;
  }
  if (!model) return;
  const modelGroup = modelStats.get(model);
  if (modelGroup) {
    modelGroup.activeMs += activeMs;
    modelGroup.responseWaitActiveMs += responseWaitMs;
    modelGroup.interpolatedWaitActiveMs += interpolatedWaitMs;
    modelGroup.agentWorkMeasuredMs += agentWorkMeasuredMs;
    modelGroup.agentWorkEstimatedMs += agentWorkEstimatedMs;
    if (interpolatedWaitMs > 0) modelGroup.interpolatedWaitSessions += 1;
    modelGroup.elapsedMs += elapsed;
    modelGroup.dominantSessions += 1;
  }
  const mhGroup = modelHarnessStats.get(`${model}@@${dialogue.harness}`);
  if (mhGroup) {
    mhGroup.activeMs += activeMs;
    mhGroup.responseWaitActiveMs += responseWaitMs;
    mhGroup.interpolatedWaitActiveMs += interpolatedWaitMs;
    mhGroup.agentWorkMeasuredMs += agentWorkMeasuredMs;
    mhGroup.agentWorkEstimatedMs += agentWorkEstimatedMs;
    if (interpolatedWaitMs > 0) mhGroup.interpolatedWaitSessions += 1;
    mhGroup.elapsedMs += elapsed;
    mhGroup.dominantSessions += 1;
  }
}

function buildContrasts(modelHarnessRows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byModel = new Map<string, Array<Record<string, unknown>>>();
  for (const row of modelHarnessRows) {
    const model = String(row.model ?? "");
    if (!model || Number(row.totalTokens ?? 0) <= 0) continue;
    const current = byModel.get(model) ?? [];
    current.push(row);
    byModel.set(model, current);
  }

  const contrasts: Array<Record<string, unknown>> = [];
  for (const [model, rows] of byModel.entries()) {
    const useful = rows
      .filter((row) => Number(row.usageMessages ?? 0) >= 3 && Number(row.totalTokens ?? 0) > 0)
      .sort((a, b) => Number(b.totalTokens ?? 0) - Number(a.totalTokens ?? 0));
    if (useful.length < 2) continue;
    const avgValues = useful
      .map((row) => Number(row.avgTokensPerUsageMessage ?? 0))
      .filter((value) => value > 0);
    const throughputValues = useful
      .map((row) => Number(row.outputTokensPerActiveHour ?? 0))
      .filter((value) => value > 0);
    const cacheValues = useful
      .map((row) => Number(row.cacheShareOfInput ?? -1))
      .filter((value) => value >= 0);
    const durationValues = useful
      .map((row) => Number(row.durationP50Ms ?? 0))
      .filter((value) => value > 0);
    const tokensTotal = useful.reduce((sum, row) => sum + Number(row.totalTokens ?? 0), 0);
    const sortedByThroughput = useful
      .filter((row) => Number(row.outputTokensPerActiveHour ?? 0) > 0)
      .sort((a, b) => Number(b.outputTokensPerActiveHour ?? 0) - Number(a.outputTokensPerActiveHour ?? 0));

    contrasts.push(
      roundObject({
        model,
        harnesses: useful.map((row) => row.harness).join(", "),
        harnessCount: useful.length,
        totalTokens: tokensTotal,
        avgTokensMin: avgValues.length ? Math.min(...avgValues) : null,
        avgTokensMax: avgValues.length ? Math.max(...avgValues) : null,
        avgTokensRatio:
          avgValues.length && Math.min(...avgValues) > 0 ? Math.max(...avgValues) / Math.min(...avgValues) : null,
        outputThroughputMin: throughputValues.length ? Math.min(...throughputValues) : null,
        outputThroughputMax: throughputValues.length ? Math.max(...throughputValues) : null,
        cacheShareMin: cacheValues.length ? Math.min(...cacheValues) : null,
        cacheShareMax: cacheValues.length ? Math.max(...cacheValues) : null,
        durationP50MinMs: durationValues.length ? Math.min(...durationValues) : null,
        durationP50MaxMs: durationValues.length ? Math.max(...durationValues) : null,
        fastestHarness: sortedByThroughput[0]?.harness ?? null,
        slowestHarness: sortedByThroughput.at(-1)?.harness ?? null,
      }),
    );
  }
  return contrasts.sort((a, b) => Number(b.totalTokens ?? 0) - Number(a.totalTokens ?? 0));
}

function sumRows(rows: Array<Record<string, unknown>>, field: string): number {
  return rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0);
}

function topBy<T extends Record<string, unknown>>(rows: T[], field: string): T | null {
  return rows
    .filter((row) => Number(row[field] ?? 0) > 0)
    .sort((a, b) => Number(b[field] ?? 0) - Number(a[field] ?? 0))[0] ?? null;
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function reportHtml(data: unknown, echartsSource: string): string {
  const json = safeScriptJson(data);
  const safeEchartsSource = echartsSource.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'" />
<meta name="referrer" content="no-referrer" />
<title>Эффективность моделей и harness'ов</title>
<style>
:root {
  color-scheme: dark;
  --bg: #111311;
  --surface: #191b19;
  --surface-2: #20231f;
  --ink: #f0eee8;
  --muted: #b5b2a9;
  --subtle: #807c72;
  --border: rgba(255,255,255,.11);
  --grid: rgba(255,255,255,.08);
  --accent: #76b7ff;
  --good: #58c483;
  --warn: #d9a441;
  --bad: #e56a67;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); }
body { font-size: 14px; line-height: 1.45; }
main { width: min(1320px, calc(100% - 40px)); margin: 0 auto; padding: 28px 0 56px; }
h1, h2, h3, p { margin: 0; }
h1 { font-size: clamp(24px, 3vw, 38px); line-height: 1.08; letter-spacing: 0; }
h2 { font-size: 18px; line-height: 1.2; }
h3 { font-size: 14px; line-height: 1.2; color: var(--muted); font-weight: 600; }
.topbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: start; margin-bottom: 20px; }
.subtitle { max-width: 980px; margin-top: 8px; color: var(--muted); font-size: 15px; }
.stamp { color: var(--subtle); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
.metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
.metric { min-height: 112px; display: flex; flex-direction: column; justify-content: space-between; }
.metric .value-line { display: flex; align-items: baseline; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.metric .value { font-size: 26px; line-height: 1.05; font-weight: 700; font-variant-numeric: tabular-nums; }
.metric .value-suffix { color: var(--muted); font-size: 12px; line-height: 1.2; font-weight: 500; white-space: nowrap; }
.metric .note { margin-top: 6px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.scatter-panel { margin-bottom: 18px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.panel-head p { color: var(--muted); margin-top: 4px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
.control-group { display: inline-flex; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
button, select { font: inherit; color: var(--ink); background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; min-height: 34px; padding: 6px 10px; }
button { cursor: pointer; }
.control-group button { border: 0; border-radius: 0; color: var(--muted); min-width: 78px; }
.control-group button.active { background: rgba(255,255,255,.12); color: var(--ink); font-weight: 700; }
select { min-width: 150px; }
#scatter { width: 100%; height: 680px; min-height: 520px; background: #171917; border-radius: 8px; }
#monthly-chart { width: 100%; height: 430px; min-height: 340px; background: #171917; border-radius: 8px; }
.encoding-legends { display: grid; gap: 7px; margin: 2px 0 10px; }
.encoding-legend-row { display: grid; grid-template-columns: 118px minmax(0, 1fr); gap: 10px; align-items: center; min-width: 0; }
.encoding-legend-title { color: var(--muted); font-size: 12px; font-weight: 700; }
.encoding-legend-strip { display: flex; gap: 5px; overflow-x: auto; padding: 3px 1px 6px; min-width: 0; }
.encoding-legend-item { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 6px; min-height: 27px; padding: 3px 7px; border: 1px solid var(--border); border-radius: 5px; background: #1b1e1b; color: var(--muted); font-size: 11px; cursor: pointer; }
.encoding-legend-item.off { opacity: .35; text-decoration: line-through; }
.encoding-legend-item.unavailable { cursor: default; border-style: dashed; }
.color-marker { width: 11px; height: 11px; border-radius: 2px; border: 1px solid rgba(255,255,255,.3); flex: 0 0 auto; }
.shape-marker { width: 12px; height: 12px; display: inline-block; flex: 0 0 auto; background: #c9cbc5; }
.shape-0 { border-radius: 50%; }
.shape-1 { border-radius: 1px; }
.shape-2 { clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.shape-3 { transform: rotate(45deg) scale(.78); }
.shape-4 { border-radius: 4px; }
.shape-5 { clip-path: polygon(50% 0, 92% 24%, 78% 76%, 50% 100%, 22% 76%, 8% 24%); }
.shape-6 { clip-path: polygon(0 35%, 64% 35%, 64% 0, 100% 50%, 64% 100%, 64% 65%, 0 65%); }
.outline-marker { width: 14px; height: 12px; border: 2px solid #c9cbc5; border-radius: 3px; background: transparent; flex: 0 0 auto; }
.outline-marker.estimated { border-color: #f0bf4c; border-style: dashed; }
.axis text { fill: var(--muted); font-size: 12px; }
.axis line, .axis path { stroke: var(--grid); }
.grid line { stroke: var(--grid); }
.axis-label { fill: var(--muted); font-size: 13px; font-weight: 700; }
.point { opacity: .82; stroke: rgba(17,19,17,.7); stroke-width: 1.2; }
.point.estimated { stroke: #f0bf4c; stroke-width: 2; stroke-dasharray: 3 2; }
.point:hover { opacity: 1; stroke: #fff; stroke-width: 2; }
.legend { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 12px; color: var(--muted); }
.legend-item { display: inline-flex; align-items: center; gap: 7px; }
.swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.estimated-swatch { background: transparent; border: 2px dashed #f0bf4c; }
.two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-bottom: 18px; }
.three-col { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-bottom: 18px; }
.bar-chart { height: 300px; margin-top: 14px; }
.bar-row { display: grid; grid-template-columns: minmax(110px, 170px) minmax(0, 1fr) 92px; gap: 10px; align-items: center; margin: 8px 0; }
.bar-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 18px; background: rgba(255,255,255,.06); border-radius: 5px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 5px; min-width: 2px; }
.bar-value { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink); }
.ranking-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 16px; }
.ranking-block h3 { margin-bottom: 10px; }
.ranking-group-title { margin: 13px 0 6px; color: var(--subtle); font-size: 11px; font-weight: 800; text-transform: uppercase; }
.ranking-row { display: grid; grid-template-columns: 34px minmax(110px, 190px) minmax(80px, 1fr) 78px; gap: 9px; align-items: center; min-height: 28px; }
.ranking-rank { color: var(--subtle); text-align: right; font-variant-numeric: tabular-nums; }
.ranking-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ranking-value { text-align: right; color: var(--ink); font-variant-numeric: tabular-nums; }
.ranking-value small { display: block; color: var(--subtle); font-size: 10px; }
.ranking-middle { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin: 10px 0; padding: 2px 0; }
.ranking-middle summary { color: var(--muted); cursor: pointer; padding: 8px 0; user-select: none; }
.ranking-middle[open] summary { margin-bottom: 5px; }
.token-mix-row { display: grid; grid-template-columns: minmax(140px, 220px) minmax(0, 1fr) 84px; gap: 10px; align-items: center; margin: 10px 0; }
.token-stack { display: flex; height: 20px; overflow: hidden; border-radius: 5px; background: rgba(255,255,255,.06); }
.token-segment { min-width: 0; height: 100%; }
.token-uncached { background: #76b7ff; }
.token-cached { background: #58c483; }
.token-write { background: #d9a441; }
.token-output { background: #e56a67; }
.leaderboard, .heatmap, .table-wrap { overflow: auto; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 9px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
th { color: var(--muted); font-size: 12px; font-weight: 700; background: var(--surface); position: sticky; top: 0; }
td.num, th.num { text-align: right; }
.hint { color: var(--muted); font-size: 12px; margin-top: 10px; }
.pill { display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); background: var(--surface-2); }
.tables-section { display: none; }
.tables-section.open { display: block; }
.heat-cell { border-radius: 4px; padding: 5px 7px; display: block; text-align: right; color: var(--ink); }
.daily-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.calendar-layout { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 8px; margin-top: 14px; }
.weekday-labels { display: grid; grid-template-rows: repeat(7, 13px); gap: 4px; color: var(--subtle); font-size: 10px; line-height: 13px; }
.calendar-scroll { overflow-x: auto; padding-bottom: 6px; }
.calendar-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 13px); grid-auto-columns: 13px; gap: 4px; width: max-content; min-height: 115px; }
.day-cell { width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(255,255,255,.06); background: #222620; }
.day-cell.outside { opacity: .32; }
.day-cell.level-1 { background: #163622; }
.day-cell.level-2 { background: #1f6840; }
.day-cell.level-3 { background: #2d9858; }
.day-cell.level-4 { background: #57c778; }
.day-cell:hover { outline: 1px solid rgba(255,255,255,.75); outline-offset: 1px; }
.calendar-legend { display: flex; align-items: center; justify-content: flex-end; gap: 6px; color: var(--muted); font-size: 12px; margin-top: 8px; }
.legend-square { width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(255,255,255,.06); display: inline-block; }
.section-gap { margin-bottom: 18px; }
.callout { border-left: 3px solid var(--accent); color: var(--muted); }
@media (max-width: 1050px) {
  .metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .three-col { grid-template-columns: 1fr; }
}
@media (max-width: 780px) {
  main { width: min(100% - 24px, 1320px); padding-top: 18px; }
  .topbar, .two-col, .ranking-grid { grid-template-columns: 1fr; }
  .stamp { text-align: left; white-space: normal; }
  .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .panel-head { flex-direction: column; }
  .controls { justify-content: flex-start; }
  .encoding-legend-row { grid-template-columns: 1fr; gap: 2px; }
}
@media (max-width: 520px) {
  .metric-grid { grid-template-columns: 1fr; }
  .bar-row { grid-template-columns: 1fr; gap: 4px; }
  .bar-value { text-align: left; }
}
</style>
</head>
<body>
<main>
  <header class="topbar">
    <div>
      <h1>Эффективность моделей и harness'ов</h1>
      <p class="subtitle">Сравнение текущих ревизий диалогов: активное время сессии, токены, cached input, output yield, latency coverage и поведение одной модели в разных harness'ах. Тексты сообщений не выгружены в отчёт.</p>
    </div>
    <div class="stamp" id="stamp"></div>
  </header>

  <section class="panel section-gap">
    <h2>Аудит Codex subagent lineage</h2>
    <div class="daily-summary" id="lineage-summary"></div>
    <p class="hint">Replay измерен как точный общий префикс последовательностей <code>last_token_usage</code> child и parent raw streams. Из adjusted total вычтены только доказанно унаследованные события; собственный suffix каждого subagent остаётся в статистике.</p>
  </section>

  <section class="metric-grid" id="metrics"></section>

  <section class="panel section-gap">
    <div class="panel-head">
      <div>
        <h2>Использование по дням</h2>
        <p>Плитки как contribution calendar: один квадрат — один календарный день (${REPORT_TIME_ZONE}).</p>
      </div>
      <div class="controls">
        <select id="daily-metric" aria-label="Метрика дневной плитки">
          <option value="activeHours">active time</option>
          <option value="totalResponseWaitHours">response wait: total</option>
          <option value="responseWaitHours">response wait: exact</option>
          <option value="interpolatedResponseWaitHours">response wait: estimated</option>
          <option value="totalTokens">tokens</option>
          <option value="uncachedInputTokens">uncached input</option>
          <option value="cachedInputTokens">cache read</option>
          <option value="cacheWriteInputTokens">cache write</option>
          <option value="outputTokens">output</option>
          <option value="messages">messages</option>
          <option value="sessions">sessions</option>
          <option value="contentChars">chars</option>
        </select>
      </div>
    </div>
    <div class="daily-summary" id="daily-summary"></div>
    <div class="calendar-layout">
      <div class="weekday-labels" aria-hidden="true"><span>Пн</span><span></span><span>Ср</span><span></span><span>Пт</span><span></span><span>Вс</span></div>
      <div class="calendar-scroll"><div class="calendar-grid" id="daily-calendar"></div></div>
    </div>
    <div class="calendar-legend" id="calendar-legend"></div>
  </section>

  <section class="panel scatter-panel">
    <div class="panel-head">
      <div>
        <h2>Сессии: сравнение метрик</h2>
        <p>Одна точка — текущий диалог. Цвет и форма кодируют независимые измерения; пунктирная обводка означает интерполированное время.</p>
      </div>
      <div class="controls">
        <select id="x-metric" aria-label="Метрика оси X">
          <option value="activeSeconds">X: session time</option>
          <option value="agentWorkHours">X: agent-time</option>
          <option value="totalTokens">X: tokens</option>
          <option value="outputTokens">X: output</option>
          <option value="contentChars">X: chars</option>
          <option value="messages">X: messages</option>
        </select>
        <select id="y-metric" aria-label="Метрика оси Y">
          <option value="totalTokens">Y: tokens</option>
          <option value="project">Y: project</option>
          <option value="activeSeconds">Y: session time</option>
          <option value="agentWorkHours">Y: agent-time</option>
          <option value="outputTokens">Y: output</option>
          <option value="contentChars">Y: chars</option>
          <option value="messages">Y: messages</option>
        </select>
        <div class="control-group" aria-label="Шкала X">
          <button id="x-log" type="button">X лог</button>
          <button id="x-linear" type="button">X лин</button>
        </div>
        <div class="control-group" aria-label="Шкала Y">
          <button id="y-log" type="button">Y лог</button>
          <button id="y-linear" type="button">Y лин</button>
        </div>
        <select id="color-mode" aria-label="Измерение цвета">
          <option value="vendor">цвет: vendor</option>
          <option value="harness">цвет: harness</option>
          <option value="model">цвет: model</option>
          <option value="project">цвет: project</option>
        </select>
        <select id="shape-mode" aria-label="Измерение формы">
          <option value="harness">форма: harness</option>
          <option value="vendor">форма: vendor</option>
          <option value="model">форма: model</option>
          <option value="project">форма: project</option>
        </select>
        <select id="harness-filter" aria-label="Фильтр harness"></select>
        <select id="model-filter" aria-label="Фильтр модели"></select>
        <select id="project-filter" aria-label="Фильтр проекта"></select>
      </div>
    </div>
    <div class="encoding-legends">
      <div class="encoding-legend-row">
        <span class="encoding-legend-title" id="color-legend-title"></span>
        <div class="encoding-legend-strip" id="scatter-color-legend"></div>
      </div>
      <div class="encoding-legend-row">
        <span class="encoding-legend-title" id="shape-legend-title"></span>
        <div class="encoding-legend-strip" id="scatter-shape-legend"></div>
      </div>
      <div class="encoding-legend-row" id="model-drilldown-row" hidden>
        <span class="encoding-legend-title" id="model-drilldown-title"></span>
        <div class="encoding-legend-strip" id="scatter-model-legend"></div>
      </div>
    </div>
    <div id="scatter" role="img" aria-label="Сессии по активному времени и токенам"></div>
  </section>

  <section class="panel section-gap">
    <div class="panel-head">
      <div>
        <h2>Использование по месяцам</h2>
        <p>Message-level объёмы и additive agent-time с распределением многомесячных сессий по timestamp сообщений.</p>
      </div>
      <div class="controls">
        <select id="monthly-metric" aria-label="Метрика по месяцам">
          <option value="totalTokens">tokens</option>
          <option value="contentChars">chars</option>
          <option value="messages">messages</option>
          <option value="projects">projects</option>
          <option value="agentWorkHours">agent-time</option>
          <option value="agentWorkMeasuredHours">agent-time: lower bound</option>
          <option value="agentWorkEstimatedHours">agent-time: estimated</option>
        </select>
        <select id="monthly-stack" aria-label="Группировка столбцов по месяцам">
          <option value="none">без группировки</option>
          <option value="project">stack: project</option>
          <option value="harness">stack: harness</option>
          <option value="vendor">stack: vendor</option>
        </select>
      </div>
    </div>
    <div id="monthly-chart" role="img" aria-label="Использование по месяцам"></div>
  </section>

  <section class="panel section-gap">
    <div class="panel-head">
      <div>
        <h2>Использование инструментов и скиллов</h2>
        <p>Фактические canonical tool calls в текущих непустых диалогах; skill usage включает явные вызовы Skill и помеченные как inferred чтения файлов SKILL.md.</p>
      </div>
    </div>
    <div class="daily-summary" id="invocation-summary"></div>
    <div class="ranking-grid">
      <div class="ranking-block">
        <h3>Инструменты</h3>
        <div id="tool-ranking"></div>
      </div>
      <div class="ranking-block">
        <h3>Скиллы</h3>
        <div id="skill-ranking"></div>
      </div>
    </div>
  </section>

  <section class="two-col">
    <article class="panel">
      <h2>Суммарные токены по harness</h2>
      <div class="bar-chart" id="harness-token-bars"></div>
    </article>
    <article class="panel">
      <h2>Суммарное активное время по harness</h2>
      <div class="bar-chart" id="harness-time-bars"></div>
    </article>
  </section>

  <section class="panel section-gap">
    <div class="panel-head">
      <div>
        <h2>Стоимость по моделям</h2>
        <p>API-эквивалент на дату отчёта. Цена выбирается по canonical model key для каждого usage-сообщения, независимо от harness и vendor-группировки.</p>
      </div>
    </div>
    <div class="daily-summary" id="pricing-summary"></div>
    <div class="table-wrap" id="pricing-table"></div>
    <p class="hint">Official — прямой публичный тариф модели; partner — тариф той же модели у официального API-партнёра; proxy — явно указанная ближайшая модель. Subscription/OAuth скидки и фактические счета сюда не входят.</p>
  </section>

  <section class="panel section-gap">
    <div class="panel-head">
      <div>
        <h2>Структура token usage по моделям</h2>
        <p>Обычный input, cache read/hit, cache creation/write и output. Reasoning уже входит в output.</p>
      </div>
    </div>
    <div class="legend">
      <span class="legend-item"><i class="swatch token-uncached"></i>обычный input</span>
      <span class="legend-item"><i class="swatch token-cached"></i>cache read</span>
      <span class="legend-item"><i class="swatch token-write"></i>cache write</span>
      <span class="legend-item"><i class="swatch token-output"></i>output</span>
    </div>
    <div id="token-mix"></div>
    <p class="hint">Показываются модели с корректным message-level разбиением. Coverage отражает долю input, которую можно классифицировать без догадок.</p>
  </section>

  <section class="three-col">
    <article class="panel">
      <h2>Контекстная тяжесть моделей</h2>
      <p class="hint">Средние total tokens на usage-message. Это proxy бюджета контекста, не качество.</p>
      <div class="leaderboard" id="model-token-table"></div>
    </article>
    <article class="panel">
      <h2>Output yield</h2>
      <p class="hint">Доля output tokens от total tokens. Чем выше, тем меньше доля входного контекста в usage.</p>
      <div class="leaderboard" id="model-yield-table"></div>
    </article>
    <article class="panel">
      <h2>Latency coverage</h2>
      <p class="hint">P50/P90 считаются только там, где parser сохранил durationMs.</p>
      <div class="leaderboard" id="model-latency-table"></div>
    </article>
  </section>

  <section class="panel section-gap">
    <div class="panel-head">
      <div>
        <h2>Одна модель внутри разных harness'ов</h2>
        <p>Модели, встречающиеся в двух и более harness'ах: разброс avg tokens/answer, cache share, throughput и latency.</p>
      </div>
    </div>
    <div class="leaderboard" id="contrast-table"></div>
  </section>

  <section class="panel section-gap">
    <div class="panel-head">
      <div>
        <h2>Timing audit</h2>
        <p>Разбор сессий с коротким timestamp span. Для найденных случаев причина подтверждена: Codex при spawn записал унаследованную историю parent в child rollout с timestamp времени запуска.</p>
      </div>
    </div>
    <div class="daily-summary" id="timing-summary"></div>
    <div class="leaderboard" id="timing-audit-table"></div>
  </section>

  <section class="panel section-gap">
    <h2>Model × harness heatmap</h2>
    <p class="hint">Ячейки показывают средние total tokens на usage-message для топ-моделей; цвет насыщается по максимуму таблицы.</p>
    <div class="heatmap" id="heatmap"></div>
  </section>

  <section class="panel callout section-gap">
    <h2>Методика</h2>
    <p class="hint">Диалоги берутся только из <code>dialogue.current_revision</code>; пустые сессии без видимого assistant-ответа исключаются. Токены — полный usage harness: <code>inputTokens + outputTokens</code>. Измеренное время — подтвержденное ожидание пользователя либо сумма <code>task_complete.duration_ms</code> по agent turn'ам, включая отмены и отдельную работу субагентов. Это сумма времени сессий/агентов, а не календарное время: параллельный субагент намеренно добавляется поверх пересекающегося parent wait. Для отсутствующих таймингов estimated wait интерполируется по 15 ближайшим измеренным сессиям: время на usage-вызов масштабируется на число вызовов целевой сессии; donor scope и диапазон сохраняются в каждой точке. API/reported duration — нижняя граница оценки.</p>
  </section>

  <section class="panel section-gap">
    <h2>Как тарифицируются корзины</h2>
    <p class="hint">Input разбивается на uncached, cache read и cache write; output включает reasoning и не удваивается. Anthropic cache write рассчитан по 5-minute TTL, потому что canonical usage пока не хранит TTL. OpenAI long-context multiplier и tiered Qwen Coder price применяются на уровне отдельного usage-сообщения.</p>
    <p class="hint"><a href="https://developers.openai.com/api/docs/pricing">OpenAI pricing</a> · <a href="https://platform.claude.com/docs/en/about-claude/pricing">Anthropic pricing</a> · <a href="https://www.alibabacloud.com/help/en/model-studio/model-pricing">Alibaba Model Studio pricing</a> · <a href="https://www.kimi.com/resources/kimi-k3-pricing">Kimi K3 pricing</a></p>
  </section>

  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Таблицы</h2>
        <p>Подробные агрегаты по harness, моделям, model × harness и ролям.</p>
      </div>
      <button id="toggle-tables" type="button">Показать таблицы</button>
    </div>
    <div class="tables-section" id="tables-section">
      <h3>Harness</h3>
      <div class="table-wrap" id="harness-table"></div>
      <h3>Models</h3>
      <div class="table-wrap" id="model-table"></div>
      <h3>Model × harness</h3>
      <div class="table-wrap" id="model-harness-table"></div>
      <h3>Roles</h3>
      <div class="table-wrap" id="role-table"></div>
      <h3>Daily</h3>
      <div class="table-wrap" id="daily-table"></div>
    </div>
  </section>
</main>
<script>${safeEchartsSource}</script>
<script>
const DATA = ${json};

const projectKeysByLabel = new Map();
for (const point of DATA.sessionPoints) {
  const label = point.project || "без проекта";
  const keys = projectKeysByLabel.get(label) || new Set();
  keys.add(point.projectKey || "unassigned");
  projectKeysByLabel.set(label, keys);
}
function projectKeyDisambiguator(projectKey) {
  const key = String(projectKey || "unassigned");
  if (key.startsWith("name:")) return "без remote";
  if (!key.startsWith("repository:")) return key.replace(/^[^:]+:/, "").slice(0, 8);
  const remote = key.slice("repository:".length).replace(/\\.git$/, "").replace(/:/g, "/");
  const parts = remote.split("/").filter(Boolean);
  return parts.at(-2) || parts.at(-1) || "repository";
}
function projectDimensionLabel(row) {
  const label = row.project || "без проекта";
  const keys = projectKeysByLabel.get(label);
  if (!keys || keys.size <= 1) return label;
  return label + " · " + projectKeyDisambiguator(row.projectKey);
}

const harnessColors = {
  codex: "#3f7dd7",
  "qwen-code": "#24946d",
  opencode: "#d95f5f",
  "claude-code": "#c98916",
  "claude-desktop": "#a06bdd",
  "kimi-code": "#2aa9bd",
  cursor: "#a0a647",
  omp: "#e47b3c",
  "legacy-normalized": "#7b8494",
  unknown: "#8a8a8a"
};
const vendorColors = {
  openai: "#3f7dd7",
  anthropic: "#c98916",
  alibaba: "#24946d",
  moonshot: "#2aa9bd",
  google: "#d95f5f",
  unknown: "#8a8a8a"
};
const vendorModelOrder = {
  openai: [
    "o3", "gpt-5-codex", "gpt-5.1-codex", "gpt-5.2", "gpt-5.2-codex",
    "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini",
    "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol"
  ],
  anthropic: [
    "claude-3.7-sonnet-thinking", "claude-4-sonnet", "claude-4-sonnet-thinking",
    "claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-sonnet-4-6",
    "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5",
    "claude-fable-5"
  ],
  alibaba: ["qwen3.5:cloud", "qwen3-coder-next:cloud", "qwen3.8-max-preview"],
  moonshot: ["k3"],
  unknown: ["default", "minimax-m2.5-free", "<synthetic>"]
};
const vendorModelHue = { openai: 212, anthropic: 38, alibaba: 157, moonshot: 188, google: 4, unknown: 0 };
let state = {
  xScale: "log",
  yScale: "log",
  xMetric: "activeSeconds",
  yMetric: "totalTokens",
  colorMode: "vendor",
  shapeMode: "harness",
  harness: "all",
  model: "all",
  project: "all",
  dailyMetric: "activeHours",
  monthlyMetric: "totalTokens",
  monthlyStack: "none"
};
let scatterChart = null;
let scatterResizeObserver = null;
let monthlyChart = null;
let monthlyResizeObserver = null;
const encodingSelection = {
  color: { harness: {}, vendor: {}, model: {}, project: {} },
  shape: { harness: {}, vendor: {}, model: {}, project: {} },
  modelDrilldown: {},
  timing: { measured: true, estimated: true }
};
const scatterSymbols = ["circle", "rect", "triangle", "diamond", "roundRect", "pin", "arrow"];

function fmtNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(n >= 10e9 ? 0 : 1) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(n >= 10e6 ? 0 : 1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(n >= 10e3 ? 0 : 1) + "K";
  return Math.round(n).toLocaleString("ru-RU");
}
function fmtInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n).toLocaleString("ru-RU") : "n/a";
}
function fmtPct(value) {
  const n = Number(value);
  const digits = n < 1 && n > .999 ? 3 : n >= .1 ? 1 : 2;
  return Number.isFinite(n) ? (n * 100).toFixed(digits) + "%" : "n/a";
}
function fmtHours(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 24) return (n / 24).toFixed(1) + " д";
  if (n >= 1) return n.toFixed(1) + " ч";
  return (n * 60).toFixed(1) + " мин";
}
function fmtDurationSeconds(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 3600) return (n / 3600).toFixed(n >= 36000 ? 0 : 1) + " ч";
  if (n >= 60) return (n / 60).toFixed(n >= 600 ? 0 : 1) + " мин";
  return n.toFixed(n >= 10 ? 0 : 1) + " сек";
}
function fmtMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 1 : 2) + " с";
  return Math.round(n) + " мс";
}
function fmtTokensPerHour(value) {
  const n = Number(value);
  return Number.isFinite(n) ? fmtNumber(n) + "/ч" : "n/a";
}
function fmtUsd(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "n/a";
}
function fmtDaily(metric, value) {
  if (
    metric === "activeHours" ||
    metric === "responseWaitHours" ||
    metric === "interpolatedResponseWaitHours" ||
    metric === "totalResponseWaitHours"
  ) return fmtHours(value);
  if (metric === "sessions" || metric === "messages") return fmtInt(value);
  return fmtNumber(value);
}
function byDesc(field) {
  return (a, b) => Number(b[field] || 0) - Number(a[field] || 0);
}
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
const metricDefinitions = {
  activeSeconds: { label: "Время сессии", format: fmtDurationSeconds },
  agentWorkHours: { label: "Agent-time", format: fmtHours },
  totalTokens: { label: "Токены", format: fmtNumber },
  outputTokens: { label: "Output tokens", format: fmtNumber },
  contentChars: { label: "Символы", format: fmtNumber },
  messages: { label: "Сообщения", format: fmtInt },
  projects: { label: "Проекты", format: fmtInt },
  project: { label: "Проект", format: (value) => String(value || "без проекта") },
  agentWorkMeasuredHours: { label: "Agent-time lower bound", format: fmtHours },
  agentWorkEstimatedHours: { label: "Agent-time estimated", format: fmtHours }
};
function dimensionValue(row, dimension) {
  if (dimension === "vendor") return row.vendor || "unknown";
  if (dimension === "model") return row.model || row.modelKey || "unknown";
  if (dimension === "project") return projectDimensionLabel(row);
  return row.harness || "unknown";
}
function stableIndex(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}
function categoryColor(category, dimension) {
  if (dimension === "vendor") return vendorColors[category] || vendorColors.unknown;
  if (dimension === "harness") return harnessColors[category] || harnessColors.unknown;
  const index = stableIndex(category);
  return "hsl(" + (index % 360) + " " + (58 + ((index >>> 8) % 16)) + "% " +
    (52 + ((index >>> 16) % 13)) + "%)";
}
function orderedVendorModels(vendor) {
  const present = Array.from(new Set(DATA.sessionPoints
    .filter((point) => dimensionValue(point, "vendor") === vendor)
    .map((point) => dimensionValue(point, "model"))));
  const preferred = vendorModelOrder[vendor] || [];
  const rank = new Map(preferred.map((model, index) => [model, index]));
  return present.sort((a, b) => {
    const aRank = rank.has(a) ? rank.get(a) : preferred.length + 1;
    const bRank = rank.has(b) ? rank.get(b) : preferred.length + 1;
    return aRank - bRank || String(a).localeCompare(String(b));
  });
}
function vendorModelColor(vendor, model) {
  const models = orderedVendorModels(vendor);
  const index = Math.max(0, models.indexOf(model));
  const progress = models.length > 1 ? index / (models.length - 1) : 1;
  const hue = vendorModelHue[vendor] ?? stableIndex(vendor) % 360;
  const saturation = vendor === "unknown" ? 0 : 28 + progress * 58;
  const lightness = 70 - progress * 20;
  return "hsl(" + hue + " " + saturation.toFixed(1) + "% " + lightness.toFixed(1) + "%)";
}
function metricValue(point, metric) {
  if (metric === "project") return point.project || "без проекта";
  return Number(point[metric] || 0);
}
function metricFormat(metric, value) {
  return (metricDefinitions[metric] || metricDefinitions.totalTokens).format(value);
}
function metricLabel(metric) {
  return (metricDefinitions[metric] || metricDefinitions.totalTokens).label;
}

function initControls() {
  document.getElementById("stamp").textContent =
    "generated " + new Date(DATA.generatedAt).toLocaleString("ru-RU") + "\\n" +
    DATA.meta.currentDialogues.toLocaleString("ru-RU") + " диалогов";

  const harnessSelect = document.getElementById("harness-filter");
  const modelSelect = document.getElementById("model-filter");
  const projectSelect = document.getElementById("project-filter");
  const dailyMetricSelect = document.getElementById("daily-metric");
  const monthlyMetricSelect = document.getElementById("monthly-metric");
  const monthlyStackSelect = document.getElementById("monthly-stack");
  const harnesses = ["all"].concat(DATA.harnessStats.map((row) => row.harness).filter(Boolean));
  harnessSelect.innerHTML = harnesses.map((h) => "<option value=\\"" + escapeHtml(h) + "\\">" + (h === "all" ? "все harness'ы" : escapeHtml(h)) + "</option>").join("");
  const models = ["all"].concat(DATA.modelStats.slice(0, 40).map((row) => row.key));
  modelSelect.innerHTML = models.map((m) => "<option value=\\"" + escapeHtml(m) + "\\">" + (m === "all" ? "все модели" : escapeHtml(m.replace(/^[^/]+\\//, ""))) + "</option>").join("");
  const projects = Array.from(new Map(DATA.sessionPoints.map((point) => [point.projectKey, point.project])).entries())
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  projectSelect.innerHTML = '<option value="all">все проекты</option>' + projects.map(([key, label]) =>
    '<option value="' + escapeHtml(key) + '">' + escapeHtml(projectDimensionLabel({ projectKey: key, project: label })) + '</option>'
  ).join("");

  document.getElementById("color-mode").addEventListener("change", (event) => {
    state.colorMode = event.target.value;
    renderScatter();
  });
  document.getElementById("shape-mode").addEventListener("change", (event) => {
    state.shapeMode = event.target.value;
    renderScatter();
  });
  document.getElementById("x-metric").addEventListener("change", (event) => {
    state.xMetric = event.target.value;
    renderScatter();
  });
  document.getElementById("y-metric").addEventListener("change", (event) => {
    state.yMetric = event.target.value;
    renderScatter();
  });
  harnessSelect.addEventListener("change", (event) => {
    state.harness = event.target.value;
    renderScatter();
  });
  modelSelect.addEventListener("change", (event) => {
    state.model = event.target.value;
    renderScatter();
  });
  projectSelect.addEventListener("change", (event) => {
    state.project = event.target.value;
    renderScatter();
  });
  dailyMetricSelect.addEventListener("change", (event) => {
    state.dailyMetric = event.target.value;
    renderDailyCalendar();
  });
  monthlyMetricSelect.addEventListener("change", (event) => {
    state.monthlyMetric = event.target.value;
    renderMonthlyChart();
  });
  monthlyStackSelect.addEventListener("change", (event) => {
    state.monthlyStack = event.target.value;
    renderMonthlyChart();
  });
  for (const axis of ["x", "y"]) {
    for (const scale of ["log", "linear"]) {
      document.getElementById(axis + "-" + scale).addEventListener("click", () => {
        state[axis + "Scale"] = scale;
        renderScatter();
      });
    }
  }
  document.getElementById("toggle-tables").addEventListener("click", () => {
    const section = document.getElementById("tables-section");
    section.classList.toggle("open");
    document.getElementById("toggle-tables").textContent = section.classList.contains("open") ? "Скрыть таблицы" : "Показать таблицы";
  });
}

function renderMetrics() {
  const agentHours = Number(DATA.meta.agentWorkHours || 0);
  const costCoverage = Number(DATA.meta.estimatedCostCoverage || 0);
  const cards = [
    [
      "Диалоги",
      fmtInt(DATA.meta.currentDialogues),
      "empty/no answer: " + fmtInt(DATA.meta.excludedNoAssistantAnswer)
    ],
    ["Проекты", fmtInt(DATA.meta.currentProjects), "без проекта: " + fmtInt(DATA.meta.unassignedProjectDialogues) + " диалогов"],
    ["Сообщения", fmtNumber(DATA.meta.currentMessages), "из них usage: " + fmtNumber(DATA.meta.usageMessages)],
    ["Уникальные токены", fmtNumber(DATA.meta.lineageAdjustedTotalTokens), "raw: " + fmtNumber(DATA.meta.totalTokens) + " · replay: " + fmtNumber(DATA.meta.codexReplayTokens) + " · model unknown: " + fmtNumber(DATA.meta.unattributedModelTokens)],
    ["Суммарное время работы", agentHours.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " ч", (agentHours / 24).toFixed(1) + " д · agent-time"],
    ["Время ожидания", fmtHours(DATA.meta.exactResponseWaitHours), "known end-to-end wait · cancelled turns included"],
    ["Множитель", Number(DATA.meta.agentWorkToUserWaitRatio || 0).toFixed(2) + "×", "agent-time / known user wait"],
    ["Активные дни", fmtInt(DATA.meta.activeDays), DATA.meta.firstActiveDay + " → " + DATA.meta.lastActiveDay, "/ " + fmtInt(DATA.meta.calendarDays) + " дней"],
    ["Общая стоимость", fmtUsd(DATA.meta.estimatedCostUsd), fmtPct(costCoverage) + " токенов · цены на " + DATA.meta.pricingAsOf + " · API-equivalent"]
  ];
  document.getElementById("metrics").innerHTML = cards.map((card) =>
    "<article class=\\"panel metric\\"><h3>" + escapeHtml(card[0]) + "</h3><div><div class=\\"value-line\\"><div class=\\"value\\">" + escapeHtml(card[1]) + "</div>" +
    (card[3] ? "<div class=\\"value-suffix\\">" + escapeHtml(card[3]) + "</div>" : "") +
    "</div><div class=\\"note\\">" + escapeHtml(card[2]) + "</div></div></article>"
  ).join("");
}

function renderPricing() {
  const rows = DATA.modelStats.slice().sort(byDesc("estimatedCostUsd"));
  const sourceCounts = rows.reduce((counts, row) => {
    const kind = row.pricingSourceKind || "unpriced";
    counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  }, {});
  const summary = [
    ["итого", fmtUsd(DATA.meta.estimatedCostUsd)],
    ["покрытие", fmtPct(DATA.meta.estimatedCostCoverage)],
    ["official", fmtInt(sourceCounts.official || 0)],
    ["partner", fmtInt(sourceCounts.official_partner || 0)],
    ["proxy", fmtInt(sourceCounts.fallback_proxy || 0)],
    ["unpriced", fmtInt(sourceCounts.unpriced || 0)]
  ];
  document.getElementById("pricing-summary").innerHTML = summary.map((item) =>
    '<span class="pill"><strong>' + escapeHtml(item[0]) + ':</strong> ' + escapeHtml(item[1]) + '</span>'
  ).join("");

  const header = ["model", "basis", "estimate", "input", "cache read", "cache write", "output", "effective / 1M", "coverage"];
  let html = '<table><thead><tr>' + header.map((label, index) =>
    '<th' + (index >= 2 ? ' class="num"' : '') + '>' + escapeHtml(label) + '</th>'
  ).join("") + '</tr></thead><tbody>';
  for (const row of rows) {
    const pricing = row.pricing || {};
    const notes = Array.isArray(pricing.notes) ? pricing.notes.join(" ") : "";
    const basisLabel = (row.pricingSourceKind || "unpriced") + ": " + (row.pricingSourceLabel || "n/a") +
      (row.pricedAs && row.pricedAs !== row.key ? " (" + row.pricedAs + ")" : "");
    const basis = pricing.sourceUrl
      ? '<a href="' + escapeHtml(pricing.sourceUrl) + '" title="' + escapeHtml(notes) + '">' + escapeHtml(basisLabel) + '</a>'
      : '<span title="' + escapeHtml(notes) + '">' + escapeHtml(basisLabel) + '</span>';
    html += '<tr><td title="' + escapeHtml(row.key) + '">' + escapeHtml(row.model) + '</td><td>' + basis + '</td>' +
      '<td class="num">' + (row.pricingSourceKind === "unpriced" ? "n/a" : fmtUsd(row.estimatedCostUsd)) + '</td>' +
      '<td class="num">' + fmtUsd(row.estimatedInputCostUsd) + '</td>' +
      '<td class="num">' + fmtUsd(row.estimatedCachedInputCostUsd) + '</td>' +
      '<td class="num">' + fmtUsd(row.estimatedCacheWriteCostUsd) + '</td>' +
      '<td class="num">' + fmtUsd(row.estimatedOutputCostUsd) + '</td>' +
      '<td class="num">' + (row.effectiveCostPerMillionTokens ? fmtUsd(row.effectiveCostPerMillionTokens, 2) : "n/a") + '</td>' +
      '<td class="num">' + fmtPct(row.estimatedCostCoverage) + '</td></tr>';
  }
  document.getElementById("pricing-table").innerHTML = html + '</tbody></table>';
}

function renderLineageAudit() {
  const totals = DATA.lineage.totals;
  const items = [
    ["subagents", fmtInt(totals.subagentSessions)],
    ["exact replay", fmtInt(totals.exactReplaySessions)],
    ["without replay", fmtInt(totals.noReplaySessions)],
    ["parent missing", fmtInt(totals.missingParents)],
    ["raw replay events", fmtNumber(totals.replayEvents)],
    ["canonical replay events", fmtNumber(DATA.lineage.canonicalReplayEvents)],
    ["removed", fmtNumber(DATA.lineage.canonicalReplay.totalTokens) + " tokens"],
    ["share of raw", fmtPct(DATA.lineage.replayShareOfRawTotal)],
    ["adjusted total", fmtNumber(DATA.lineage.adjustedTotalTokens)]
  ];
  document.getElementById("lineage-summary").innerHTML = items.map((item) =>
    "<span class=\\\"pill\\\"><strong>" + escapeHtml(item[0]) + ":</strong> " + escapeHtml(item[1]) + "</span>"
  ).join("");
}

function renderAgentTimeComparison() {
  const items = [
    ["known user wait", fmtHours(DATA.meta.exactResponseWaitHours)],
    ["agent-time lower bound", fmtHours(DATA.meta.agentWorkMeasuredHours)],
    ["estimated uplift", fmtHours(DATA.meta.agentWorkEstimatedHours)],
    ["total additive agent-time", fmtHours(DATA.meta.agentWorkHours)],
    ["difference", fmtHours(DATA.meta.agentWorkUpliftHours)],
    ["multiplier", Number(DATA.meta.agentWorkToUserWaitRatio || 0).toFixed(2) + "×"]
  ];
  document.getElementById("agent-time-summary").innerHTML = items.map((item) =>
    "<span class=\\\"pill\\\"><strong>" + escapeHtml(item[0]) + ":</strong> " + escapeHtml(item[1]) + "</span>"
  ).join("");
  renderTable("agent-time-table", DATA.harnessStats, [
    { field: "harness", label: "harness" },
    { field: "agentWorkMeasuredHours", label: "lower bound", num: true, format: fmtHours },
    { field: "agentWorkEstimatedHours", label: "estimated uplift", num: true, format: fmtHours },
    { field: "agentWorkHours", label: "agent-time", num: true, format: fmtHours },
    { field: "responseWaitHours", label: "known user wait", num: true, format: fmtHours },
    { field: "agentWorkToUserWaitRatio", label: "ratio", num: true, format: (value) => Number(value) > 0 ? Number(value).toFixed(2) + "×" : "n/a" },
    { field: "dialogues", label: "sessions", num: true, format: fmtInt }
  ]);
}

function filteredPoints() {
  return DATA.sessionPoints.filter((point) => {
    if (state.harness !== "all" && point.harness !== state.harness) return false;
    if (state.model !== "all" && point.modelKey !== state.model) return false;
    if (state.project !== "all" && point.projectKey !== state.project) return false;
    const x = metricValue(point, state.xMetric);
    const y = metricValue(point, state.yMetric);
    if (!Number.isFinite(x)) return false;
    if (state.xScale === "log" ? x <= 0 : x < 0) return false;
    if (state.yMetric === "project") return Boolean(y);
    if (!Number.isFinite(y)) return false;
    if (state.yScale === "log" ? y <= 0 : y < 0) return false;
    if (x === 0 && y === 0) return false;
    return true;
  });
}

function renderTokenMix() {
  const rows = DATA.modelStats
    .filter((row) => Number(row.tokenBreakdownInputTokens || 0) > 0)
    .sort(byDesc("totalTokens"))
    .slice(0, 16);
  document.getElementById("token-mix").innerHTML = rows.map((row) => {
    const values = [
      Number(row.uncachedInputTokens || 0),
      Number(row.classifiedCachedInputTokens || 0),
      Number(row.classifiedCacheWriteInputTokens || 0),
      Number(row.outputTokens || 0)
    ];
    const total = Math.max(1, values.reduce((sum, value) => sum + value, 0));
    const labels = ["uncached input", "cache read", "cache write", "output"];
    const classes = ["token-uncached", "token-cached", "token-write", "token-output"];
    const stack = values.map((value, index) =>
      "<span class=\\\"token-segment " + classes[index] + "\\\" style=\\\"width:" + ((value / total) * 100).toFixed(4) + "%\\\" title=\\\"" +
      escapeHtml(labels[index] + ": " + fmtNumber(value) + " (" + fmtPct(value / total) + ")") + "\\\"></span>"
    ).join("");
    return "<div class=\\\"token-mix-row\\\"><span class=\\\"bar-label\\\" title=\\\"" + escapeHtml(row.key) + "\\\">" +
      escapeHtml(row.model) + "</span><div class=\\\"token-stack\\\">" + stack + "</div><span class=\\\"bar-value\\\" title=\\\"breakdown coverage\\\">" +
      fmtPct(row.tokenBreakdownCoverage) + "</span></div>";
  }).join("");
}
function extent(values, scale) {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  if (positive.length === 0) return [1, 10];
  const max = Math.max.apply(null, positive);
  if (scale === "linear") return [0, max * 1.06];
  const min = Math.min.apply(null, positive);
  return [Math.max(min * .75, 0.001), max * 1.25];
}
function makeScale(domain, range, mode) {
  const d0 = domain[0], d1 = domain[1], r0 = range[0], r1 = range[1];
  if (mode === "log") {
    const l0 = Math.log10(Math.max(d0, 0.000001));
    const l1 = Math.log10(Math.max(d1, d0 * 10));
    return (value) => r0 + (Math.log10(Math.max(value, d0)) - l0) / (l1 - l0 || 1) * (r1 - r0);
  }
  return (value) => r0 + (value - d0) / (d1 - d0 || 1) * (r1 - r0);
}
function ticks(domain, mode, count) {
  if (mode === "log") {
    const start = Math.floor(Math.log10(Math.max(domain[0], 0.000001)));
    const end = Math.ceil(Math.log10(Math.max(domain[1], domain[0] * 10)));
    const out = [];
    for (let p = start; p <= end; p += 1) {
      for (const m of [1, 2, 5]) {
        const value = m * Math.pow(10, p);
        if (value >= domain[0] && value <= domain[1]) out.push(value);
      }
    }
    return out.length > 0 ? out : [domain[0], domain[1]];
  }
  const step = (domain[1] - domain[0]) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => domain[0] + step * index);
}
function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
  return el;
}
function pointShape(point, x, y, color, index) {
  const shapes = ["circle", "rect", "triangle", "diamond"];
  const harnesses = DATA.harnessStats.map((row) => row.harness);
  const shape = shapes[Math.max(0, harnesses.indexOf(point.harness)) % shapes.length];
  const size = Math.max(3, Math.min(8, Math.sqrt(point.messages || 1) / 4));
  const pointClass = point.waitEstimated ? "point estimated" : "point";
  if (shape === "rect") return svgEl("rect", { x: x - size, y: y - size, width: size * 2, height: size * 2, fill: color, class: pointClass });
  if (shape === "triangle") {
    return svgEl("path", { d: "M " + x + " " + (y - size * 1.2) + " L " + (x - size * 1.15) + " " + (y + size) + " L " + (x + size * 1.15) + " " + (y + size) + " Z", fill: color, class: pointClass });
  }
  if (shape === "diamond") {
    return svgEl("path", { d: "M " + x + " " + (y - size * 1.25) + " L " + (x - size * 1.25) + " " + y + " L " + x + " " + (y + size * 1.25) + " L " + (x + size * 1.25) + " " + y + " Z", fill: color, class: pointClass });
  }
  return svgEl("circle", { cx: x, cy: y, r: size, fill: color, class: pointClass });
}
function renderScatterSvgLegacy() {
  document.getElementById("x-log").classList.toggle("active", state.xScale === "log");
  document.getElementById("x-linear").classList.toggle("active", state.xScale === "linear");
  document.getElementById("y-log").classList.toggle("active", state.yScale === "log");
  document.getElementById("y-linear").classList.toggle("active", state.yScale === "linear");

  const svg = document.getElementById("scatter");
  svg.innerHTML = "";
  const width = 1120, height = 620;
  const margin = { left: 82, right: 28, top: 28, bottom: 72 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const points = filteredPoints();
  const xDomain = extent(points.map((p) => p.activeSeconds), state.xScale);
  const yDomain = extent(points.map((p) => p.totalTokens), state.yScale);
  const xScale = makeScale(xDomain, [margin.left, margin.left + plotW], state.xScale);
  const yScale = makeScale(yDomain, [margin.top + plotH, margin.top], state.yScale);

  const grid = svgEl("g", { class: "grid" });
  for (const tick of ticks(xDomain, state.xScale, 7)) {
    const x = xScale(tick);
    grid.appendChild(svgEl("line", { x1: x, y1: margin.top, x2: x, y2: margin.top + plotH }));
  }
  for (const tick of ticks(yDomain, state.yScale, 6)) {
    const y = yScale(tick);
    grid.appendChild(svgEl("line", { x1: margin.left, y1: y, x2: margin.left + plotW, y2: y }));
  }
  svg.appendChild(grid);

  const axis = svgEl("g", { class: "axis" });
  axis.appendChild(svgEl("line", { x1: margin.left, y1: margin.top + plotH, x2: margin.left + plotW, y2: margin.top + plotH }));
  axis.appendChild(svgEl("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: margin.top + plotH }));
  for (const tick of ticks(xDomain, state.xScale, 7)) {
    const x = xScale(tick);
    axis.appendChild(svgEl("line", { x1: x, y1: margin.top + plotH, x2: x, y2: margin.top + plotH + 6 }));
    const t = svgEl("text", { x, y: margin.top + plotH + 24, "text-anchor": "middle" });
    t.textContent = fmtDurationSeconds(tick);
    axis.appendChild(t);
  }
  for (const tick of ticks(yDomain, state.yScale, 6)) {
    const y = yScale(tick);
    axis.appendChild(svgEl("line", { x1: margin.left - 6, y1: y, x2: margin.left, y2: y }));
    const t = svgEl("text", { x: margin.left - 10, y: y + 4, "text-anchor": "end" });
    t.textContent = fmtNumber(tick);
    axis.appendChild(t);
  }
  const xl = svgEl("text", { x: margin.left + plotW / 2, y: height - 18, "text-anchor": "middle", class: "axis-label" });
  xl.textContent = "Время сессии (" + (state.xScale === "log" ? "лог." : "лин.") + " шкала)";
  axis.appendChild(xl);
  const yl = svgEl("text", { x: 18, y: margin.top + plotH / 2, transform: "rotate(-90 18 " + (margin.top + plotH / 2) + ")", "text-anchor": "middle", class: "axis-label" });
  yl.textContent = "Токены за сессию (" + (state.yScale === "log" ? "лог." : "лин.") + " шкала)";
  axis.appendChild(yl);
  svg.appendChild(axis);

  const layer = svgEl("g", {});
  points.forEach((point, index) => {
    const x = xScale(point.activeSeconds);
    const y = yScale(point.totalTokens);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const el = pointShape(point, x, y, colorFor(point), index);
    const title = svgEl("title", {});
    title.textContent = [
      point.id,
      "external id: " + (point.externalId || "n/a"),
      "harness: " + point.harness,
      "model: " + (point.modelKey || "n/a"),
      "active: " + fmtDurationSeconds(point.activeSeconds),
      "gap active: " + fmtHours(point.gapActiveHours),
      "duration-backed: " + fmtHours(point.durationBackedHours),
      "response wait: " + fmtHours(point.responseWaitHours),
      "exact agent turns: " + fmtHours(point.exactTurnDurationHours),
      "measured total: " + fmtHours(point.measuredActiveHours),
      "estimated wait: " + fmtHours(point.interpolatedResponseWaitHours),
      "wait source: " + (point.waitSource || "n/a"),
      "estimate range: " + (point.waitEstimated ? fmtHours(point.waitEstimateLowerHours) + " .. " + fmtHours(point.waitEstimateUpperHours) : "n/a"),
      "timing quality: " + (point.timingQuality || "n/a"),
      "tokens: " + fmtNumber(point.totalTokens),
      "messages: " + fmtInt(point.messages),
      "model-priced API-equivalent: " + (point.costedUsageMessages ? fmtUsd(point.apiEquivalentCostUsd) + " (" + fmtPct(point.estimatedCostCoverage) + " token coverage)" : "n/a"),
      "cache/input: " + fmtPct(point.cacheShareOfInput),
      "output share: " + fmtPct(point.outputShare)
    ].join("\\n");
    el.appendChild(title);
    layer.appendChild(el);
  });
  svg.appendChild(layer);

  const groups = new Map();
  for (const point of points) {
    const key = state.colorMode === "vendor" ? point.vendor : point.harness;
    groups.set(key || "unknown", colorFor(point));
  }
  document.getElementById("legend").innerHTML = Array.from(groups.entries())
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([key, color]) => "<span class=\\"legend-item\\"><span class=\\"swatch\\" style=\\"background:" + color + "\\"></span>" + escapeHtml(key) + "</span>")
    .join("") + "<span class=\\"legend-item\\"><span class=\\"swatch estimated-swatch\\"></span>estimated wait</span>";
}

function renderScatterEchartsLegacy() {
  document.getElementById("x-log").classList.toggle("active", state.xScale === "log");
  document.getElementById("x-linear").classList.toggle("active", state.xScale === "linear");
  document.getElementById("y-log").classList.toggle("active", state.yScale === "log");
  document.getElementById("y-linear").classList.toggle("active", state.yScale === "linear");

  const container = document.getElementById("scatter");
  if (!scatterChart) {
    scatterChart = echarts.init(container, null, {
      renderer: "canvas",
      useDirtyRect: true,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2)
    });
    scatterChart.on("legendselectchanged", (event) => {
      scatterLegendSelection[state.colorMode] = Object.assign({}, event.selected);
    });
    scatterResizeObserver = new ResizeObserver(() => scatterChart.resize());
    scatterResizeObserver.observe(container);
  }

  const points = filteredPoints();
  const categoryFor = (point) => (state.colorMode === "vendor" ? point.vendor : point.harness) || "unknown";
  const allCategories = Array.from(new Set(DATA.sessionPoints.map(categoryFor))).sort((a, b) => String(a).localeCompare(String(b)));
  const categories = Array.from(new Set(points.map(categoryFor))).sort((a, b) => String(a).localeCompare(String(b)));
  const symbols = ["circle", "rect", "triangle", "diamond", "roundRect", "pin", "arrow"];
  const selected = scatterLegendSelection[state.colorMode];
  for (const category of categories) {
    if (!(category in selected)) selected[category] = true;
  }

  const series = categories.map((category) => {
    const colorMap = state.colorMode === "vendor" ? vendorColors : harnessColors;
    const color = colorMap[category] || colorMap.unknown;
    const symbol = symbols[Math.max(0, allCategories.indexOf(category)) % symbols.length];
    return {
      name: category,
      type: "scatter",
      symbol,
      symbolSize: (_value, params) => {
        const messages = Number(params.data.point.messages || 1);
        return Math.max(7, Math.min(20, 6 + Math.sqrt(messages) / 4));
      },
      data: points.filter((point) => categoryFor(point) === category).map((point) => ({
        value: [point.activeSeconds, point.totalTokens],
        point,
        itemStyle: point.waitEstimated
          ? { color, opacity: .9, borderColor: "#f0bf4c", borderWidth: 2.5, borderType: "dashed" }
          : { color, opacity: .78, borderColor: "#111311", borderWidth: 1 }
      })),
      animation: false,
      progressive: 800,
      progressiveThreshold: 1200,
      emphasis: { focus: "series", scale: 1.35 }
    };
  });

  const tooltipValue = (value) => String(value == null || value === "" ? "n/a" : value).replace(/[{}]/g, "");
  scatterChart.setOption({
    animation: false,
    backgroundColor: "#171917",
    textStyle: { color: "#d8d8d3", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    grid: { left: 92, right: 34, top: 82, bottom: 88, containLabel: false },
    legend: {
      type: "scroll",
      top: 12,
      left: 72,
      right: 24,
      selected,
      itemWidth: 15,
      itemHeight: 11,
      textStyle: { color: "#a9aaa5", fontSize: 12 },
      pageTextStyle: { color: "#a9aaa5" },
      pageIconColor: "#d8d8d3",
      pageIconInactiveColor: "#555852"
    },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      transitionDuration: 0,
      backgroundColor: "rgba(19, 21, 19, .96)",
      borderColor: "#4a4e47",
      borderWidth: 1,
      textStyle: { color: "#e5e5df", fontSize: 12, lineHeight: 18 },
      formatter: (params) => {
        const point = params.data.point;
        return [
          tooltipValue(point.id),
          "external id: " + tooltipValue(point.externalId),
          "harness: " + tooltipValue(point.harness),
          "model: " + tooltipValue(point.modelKey),
          "vendor: " + tooltipValue(point.vendor),
          "session time: " + fmtDurationSeconds(point.activeSeconds),
          "agent-time: " + fmtHours(point.agentWorkHours),
          "agent lower bound: " + fmtHours(point.agentWorkMeasuredHours),
          "agent estimated uplift: " + fmtHours(point.agentWorkEstimatedHours),
          "known user wait: " + fmtHours(point.responseWaitHours),
          "exact agent turns: " + fmtHours(point.exactTurnDurationHours),
          "wait source: " + tooltipValue(point.waitSource),
          "estimate range: " + (point.waitEstimated ? fmtHours(point.waitEstimateLowerHours) + " .. " + fmtHours(point.waitEstimateUpperHours) : "n/a"),
          "timing quality: " + tooltipValue(point.timingQuality),
          "tokens: " + fmtNumber(point.totalTokens),
          "messages: " + fmtInt(point.messages),
          "model-priced API-equivalent: " + (point.costedUsageMessages ? fmtUsd(point.apiEquivalentCostUsd) + " (" + fmtPct(point.estimatedCostCoverage) + " token coverage)" : "n/a"),
          "cache/input: " + fmtPct(point.cacheShareOfInput),
          "output share: " + fmtPct(point.outputShare)
        ].join("\\n");
      }
    },
    xAxis: {
      type: state.xScale === "log" ? "log" : "value",
      logBase: 10,
      min: state.xScale === "log" ? "dataMin" : 0,
      name: "Время сессии (" + (state.xScale === "log" ? "лог." : "лин.") + " шкала)",
      nameLocation: "middle",
      nameGap: 58,
      nameTextStyle: { color: "#a9aaa5", fontWeight: 700 },
      axisLabel: { color: "#a9aaa5", formatter: fmtDurationSeconds, hideOverlap: true },
      axisLine: { lineStyle: { color: "#555852" } },
      splitLine: { lineStyle: { color: "#2d302c" } }
    },
    yAxis: {
      type: state.yScale === "log" ? "log" : "value",
      logBase: 10,
      min: state.yScale === "log" ? "dataMin" : 0,
      name: "Токены за сессию (" + (state.yScale === "log" ? "лог." : "лин.") + " шкала)",
      nameLocation: "middle",
      nameGap: 72,
      nameTextStyle: { color: "#a9aaa5", fontWeight: 700 },
      axisLabel: { color: "#a9aaa5", formatter: fmtNumber, hideOverlap: true },
      axisLine: { lineStyle: { color: "#555852" } },
      splitLine: { lineStyle: { color: "#2d302c" } }
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: "shift", moveOnMouseWheel: true },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        bottom: 18,
        height: 20,
        borderColor: "#3a3d38",
        backgroundColor: "#1d201d",
        fillerColor: "rgba(86, 132, 91, .28)",
        dataBackground: { lineStyle: { color: "#667064" }, areaStyle: { color: "#31372f" } },
        selectedDataBackground: { lineStyle: { color: "#8db193" }, areaStyle: { color: "#58705b" } },
        textStyle: { color: "#a9aaa5" }
      }
    ],
    series
  }, { notMerge: true, lazyUpdate: false });
  scatterChart.resize();
}

function encodingCategories(points, dimension) {
  return Array.from(new Set(points.map((point) => dimensionValue(point, dimension))))
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function ensureEncodingSelection(kind, dimension, categories) {
  const selected = encodingSelection[kind][dimension];
  for (const category of categories) {
    if (!(category in selected)) selected[category] = true;
  }
  return selected;
}

function shapeIndex(category, dimension) {
  const all = encodingCategories(DATA.sessionPoints, dimension);
  return Math.max(0, all.indexOf(category)) % scatterSymbols.length;
}

function renderEncodingLegends(points) {
  const colorCategories = encodingCategories(DATA.sessionPoints, state.colorMode);
  const shapeCategories = encodingCategories(DATA.sessionPoints, state.shapeMode);
  const colorSelected = ensureEncodingSelection("color", state.colorMode, colorCategories);
  const shapeSelected = ensureEncodingSelection("shape", state.shapeMode, shapeCategories);
  const timingSelected = (point) => encodingSelection.timing[point.waitEstimated ? "estimated" : "measured"];
  const colorAvailable = Object.fromEntries(colorCategories.map((category) => [
    category,
    points.some((point) =>
      dimensionValue(point, state.colorMode) === category &&
      shapeSelected[dimensionValue(point, state.shapeMode)] &&
      timingSelected(point)
    )
  ]));
  const activeVendors = state.colorMode === "vendor"
    ? colorCategories.filter((vendor) => colorSelected[vendor] && colorAvailable[vendor])
    : [];
  const drilldownVendor = activeVendors.length === 1 ? activeVendors[0] : null;
  const modelCategories = drilldownVendor ? orderedVendorModels(drilldownVendor) : [];
  const modelSelected = drilldownVendor
    ? (encodingSelection.modelDrilldown[drilldownVendor] ||= {})
    : {};
  for (const model of modelCategories) {
    if (!(model in modelSelected)) modelSelected[model] = true;
  }
  const modelPass = (point) =>
    !drilldownVendor || Boolean(modelSelected[dimensionValue(point, "model")]);
  const modelAvailable = Object.fromEntries(modelCategories.map((model) => [
    model,
    points.some((point) =>
      dimensionValue(point, "vendor") === drilldownVendor &&
      dimensionValue(point, "model") === model &&
      shapeSelected[dimensionValue(point, state.shapeMode)] &&
      timingSelected(point)
    )
  ]));
  const shapeAvailable = Object.fromEntries(shapeCategories.map((category) => [
    category,
    points.some((point) =>
      dimensionValue(point, state.shapeMode) === category &&
      colorSelected[dimensionValue(point, state.colorMode)] &&
      modelPass(point) &&
      timingSelected(point)
    )
  ]));
  const timingAvailable = {
    measured: points.some((point) =>
      !point.waitEstimated && colorSelected[dimensionValue(point, state.colorMode)] &&
      shapeSelected[dimensionValue(point, state.shapeMode)] && modelPass(point)
    ),
    estimated: points.some((point) =>
      point.waitEstimated && colorSelected[dimensionValue(point, state.colorMode)] &&
      shapeSelected[dimensionValue(point, state.shapeMode)] && modelPass(point)
    )
  };
  document.getElementById("color-legend-title").textContent = "Цвет · " + state.colorMode;
  document.getElementById("shape-legend-title").textContent = "Форма · " + state.shapeMode;

  const colorLegend = document.getElementById("scatter-color-legend");
  colorLegend.innerHTML = colorCategories.map((category) => {
    const available = Boolean(colorAvailable[category]);
    const active = Boolean(colorSelected[category] && available);
    return '<button type="button" class="encoding-legend-item' + (active ? "" : " off") +
      (available ? "" : " unavailable") + '" data-category="' + encodeURIComponent(category) +
      '" data-unavailable="' + !available + '" aria-pressed="' + active + '">' +
      '<span class="color-marker" style="background:' + categoryColor(category, state.colorMode) + '"></span>' +
      escapeHtml(category) + '</button>';
  }).join("");
  colorLegend.onclick = (event) => {
    const button = event.target.closest("button[data-category]");
    if (!button || button.dataset.unavailable === "true") return;
    const category = decodeURIComponent(button.dataset.category);
    colorSelected[category] = !colorSelected[category];
    renderScatter();
  };

  const shapeLegend = document.getElementById("scatter-shape-legend");
  const shapeItems = shapeCategories.map((category) => {
    const index = shapeIndex(category, state.shapeMode);
    const available = Boolean(shapeAvailable[category]);
    const active = Boolean(shapeSelected[category] && available);
    return '<button type="button" class="encoding-legend-item' + (active ? "" : " off") +
      (available ? "" : " unavailable") + '" data-category="' + encodeURIComponent(category) +
      '" data-unavailable="' + !available + '" aria-pressed="' + active + '">' +
      '<span class="shape-marker shape-' + index + '"></span>' + escapeHtml(category) + '</button>';
  });
  shapeItems.push(
    '<button type="button" class="encoding-legend-item' + (encodingSelection.timing.measured && timingAvailable.measured ? "" : " off") +
      (timingAvailable.measured ? "" : " unavailable") + '" data-timing="measured" data-unavailable="' + !timingAvailable.measured +
      '" aria-pressed="' + Boolean(encodingSelection.timing.measured && timingAvailable.measured) + '"><span class="outline-marker"></span>measured</button>',
    '<button type="button" class="encoding-legend-item' + (encodingSelection.timing.estimated && timingAvailable.estimated ? "" : " off") +
      (timingAvailable.estimated ? "" : " unavailable") + '" data-timing="estimated" data-unavailable="' + !timingAvailable.estimated +
      '" aria-pressed="' + Boolean(encodingSelection.timing.estimated && timingAvailable.estimated) + '"><span class="outline-marker estimated"></span>interpolated</button>'
  );
  shapeLegend.innerHTML = shapeItems.join("");
  shapeLegend.onclick = (event) => {
    const timingButton = event.target.closest("button[data-timing]");
    if (timingButton) {
      if (timingButton.dataset.unavailable === "true") return;
      const timing = timingButton.dataset.timing;
      encodingSelection.timing[timing] = !encodingSelection.timing[timing];
      renderScatter();
      return;
    }
    const button = event.target.closest("button[data-category]");
    if (!button || button.dataset.unavailable === "true") return;
    const category = decodeURIComponent(button.dataset.category);
    shapeSelected[category] = !shapeSelected[category];
    renderScatter();
  };
  const modelRow = document.getElementById("model-drilldown-row");
  const modelLegend = document.getElementById("scatter-model-legend");
  modelRow.hidden = !drilldownVendor;
  if (drilldownVendor) {
    document.getElementById("model-drilldown-title").textContent = "Модели · " + drilldownVendor;
    modelLegend.innerHTML = modelCategories.map((model) => {
      const available = Boolean(modelAvailable[model]);
      const active = Boolean(modelSelected[model] && available);
      return '<button type="button" class="encoding-legend-item' + (active ? "" : " off") +
        (available ? "" : " unavailable") + '" data-model="' + encodeURIComponent(model) +
        '" data-unavailable="' + !available + '" aria-pressed="' + active + '">' +
        '<span class="color-marker" style="background:' + vendorModelColor(drilldownVendor, model) + '"></span>' +
        escapeHtml(model) + '</button>';
    }).join("");
    modelLegend.onclick = (event) => {
      const button = event.target.closest("button[data-model]");
      if (!button || button.dataset.unavailable === "true") return;
      const model = decodeURIComponent(button.dataset.model);
      modelSelected[model] = !modelSelected[model];
      renderScatter();
    };
  } else {
    modelLegend.innerHTML = "";
    modelLegend.onclick = null;
  }
  return { drilldownVendor, modelSelected };
}

function renderScatter() {
  const yIsProject = state.yMetric === "project";
  document.getElementById("x-log").classList.toggle("active", state.xScale === "log");
  document.getElementById("x-linear").classList.toggle("active", state.xScale === "linear");
  document.getElementById("y-log").classList.toggle("active", !yIsProject && state.yScale === "log");
  document.getElementById("y-linear").classList.toggle("active", !yIsProject && state.yScale === "linear");
  document.getElementById("y-log").disabled = yIsProject;
  document.getElementById("y-linear").disabled = yIsProject;

  const container = document.getElementById("scatter");
  if (!scatterChart) {
    scatterChart = echarts.init(container, null, {
      renderer: "canvas",
      useDirtyRect: true,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2)
    });
    scatterResizeObserver = new ResizeObserver(() => scatterChart.resize());
    scatterResizeObserver.observe(container);
  }

  const basePoints = filteredPoints();
  const encoding = renderEncodingLegends(basePoints);
  const colorCategories = encodingCategories(basePoints, state.colorMode);
  const shapeCategories = encodingCategories(basePoints, state.shapeMode);
  const colorSelected = ensureEncodingSelection("color", state.colorMode, colorCategories);
  const shapeSelected = ensureEncodingSelection("shape", state.shapeMode, shapeCategories);
  const visiblePoints = basePoints.filter((point) => {
    const colorCategory = dimensionValue(point, state.colorMode);
    const shapeCategory = dimensionValue(point, state.shapeMode);
    const timing = point.waitEstimated ? "estimated" : "measured";
    const model = dimensionValue(point, "model");
    const modelActive = !encoding.drilldownVendor || encoding.modelSelected[model];
    return colorSelected[colorCategory] && shapeSelected[shapeCategory] &&
      encodingSelection.timing[timing] && modelActive;
  });
  const projectTotals = new Map();
  if (yIsProject) {
    for (const point of visiblePoints) {
      const project = dimensionValue(point, "project");
      projectTotals.set(project, (projectTotals.get(project) || 0) + Number(point.totalTokens || 0));
    }
  }
  const projectAxisCategories = Array.from(projectTotals.entries())
    .sort((a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])))
    .map((entry) => entry[0]);
  container.style.height = "680px";

  const activeShapeCategories = shapeCategories.filter((category) => shapeSelected[category]);
  const series = activeShapeCategories.map((shapeCategory) => ({
    name: shapeCategory,
    type: "scatter",
    symbol: scatterSymbols[shapeIndex(shapeCategory, state.shapeMode)],
    symbolSize: (_value, params) => {
      const messages = Number(params.data.point.messages || 1);
      return Math.max(7, Math.min(20, 6 + Math.sqrt(messages) / 4));
    },
    data: visiblePoints
      .filter((point) => dimensionValue(point, state.shapeMode) === shapeCategory)
      .map((point) => {
        const colorCategory = dimensionValue(point, state.colorMode);
        const model = dimensionValue(point, "model");
        const color = encoding.drilldownVendor
          ? vendorModelColor(encoding.drilldownVendor, model)
          : categoryColor(colorCategory, state.colorMode);
        return {
          value: [metricValue(point, state.xMetric), metricValue(point, state.yMetric)],
          point,
          itemStyle: point.waitEstimated
            ? { color, opacity: .9, borderColor: "#f0bf4c", borderWidth: 2.5, borderType: "dashed" }
            : { color, opacity: .8, borderColor: "#111311", borderWidth: 1 }
        };
      }),
    animation: false,
    progressive: 800,
    progressiveThreshold: 1200,
    emphasis: { focus: "series", scale: 1.35 }
  }));

  const tooltipValue = (value) => String(value == null || value === "" ? "n/a" : value).replace(/[{}]/g, "");
  scatterChart.setOption({
    animation: false,
    backgroundColor: "#171917",
    textStyle: { color: "#d8d8d3", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    grid: { left: yIsProject ? 210 : 92, right: yIsProject ? 72 : 34, top: 34, bottom: 88, containLabel: false },
    legend: { show: false },
    tooltip: {
      trigger: "item",
      renderMode: "html",
      confine: true,
      transitionDuration: 0,
      backgroundColor: "rgba(19, 21, 19, .96)",
      borderColor: "#4a4e47",
      borderWidth: 1,
      textStyle: { color: "#e5e5df", fontSize: 12, lineHeight: 18 },
      formatter: (params) => {
        const point = params.data.point;
        return [
          tooltipValue(point.id),
          "external id: " + tooltipValue(point.externalId),
          "date: " + tooltipValue(point.date),
          "color / " + state.colorMode + ": " + tooltipValue(dimensionValue(point, state.colorMode)),
          "shape / " + state.shapeMode + ": " + tooltipValue(dimensionValue(point, state.shapeMode)),
          "harness: " + tooltipValue(point.harness),
          "project: " + tooltipValue(point.project),
          "model: " + tooltipValue(point.modelKey),
          metricLabel(state.xMetric) + ": " + metricFormat(state.xMetric, metricValue(point, state.xMetric)),
          metricLabel(state.yMetric) + ": " + metricFormat(state.yMetric, metricValue(point, state.yMetric)),
          "session time: " + fmtDurationSeconds(point.activeSeconds),
          "agent-time: " + fmtHours(point.agentWorkHours),
          "agent lower bound: " + fmtHours(point.agentWorkMeasuredHours),
          "agent estimated uplift: " + fmtHours(point.agentWorkEstimatedHours),
          "known user wait: " + fmtHours(point.responseWaitHours),
          "wait source: " + tooltipValue(point.waitSource),
          "tokens: " + fmtNumber(point.totalTokens),
          "output: " + fmtNumber(point.outputTokens),
          "chars: " + fmtNumber(point.contentChars),
          "messages: " + fmtInt(point.messages),
          "model-priced API-equivalent: " + (point.costedUsageMessages ? fmtUsd(point.apiEquivalentCostUsd) + " (" + fmtPct(point.estimatedCostCoverage) + " token coverage)" : "n/a")
        ].map(escapeHtml).join("<br>");
      }
    },
    xAxis: {
      type: state.xScale === "log" ? "log" : "value",
      logBase: 10,
      min: state.xScale === "log" ? "dataMin" : 0,
      name: metricLabel(state.xMetric) + " (" + (state.xScale === "log" ? "лог." : "лин.") + " шкала)",
      nameLocation: "middle",
      nameGap: 58,
      nameTextStyle: { color: "#a9aaa5", fontWeight: 700 },
      axisLabel: { color: "#a9aaa5", formatter: (value) => metricFormat(state.xMetric, value), hideOverlap: true },
      axisLine: { lineStyle: { color: "#555852" } },
      splitLine: { lineStyle: { color: "#2d302c" } }
    },
    yAxis: yIsProject ? {
      type: "category",
      data: projectAxisCategories,
      name: "Проект",
      nameLocation: "middle",
      nameGap: 184,
      nameTextStyle: { color: "#a9aaa5", fontWeight: 700 },
      axisLabel: { color: "#a9aaa5", width: 150, overflow: "truncate", hideOverlap: false },
      axisLine: { lineStyle: { color: "#555852" } },
      splitLine: { show: true, lineStyle: { color: "#252824" } }
    } : {
      type: state.yScale === "log" ? "log" : "value",
      logBase: 10,
      min: state.yScale === "log" ? "dataMin" : 0,
      name: metricLabel(state.yMetric) + " (" + (state.yScale === "log" ? "лог." : "лин.") + " шкала)",
      nameLocation: "middle",
      nameGap: 72,
      nameTextStyle: { color: "#a9aaa5", fontWeight: 700 },
      axisLabel: { color: "#a9aaa5", formatter: (value) => metricFormat(state.yMetric, value), hideOverlap: true },
      axisLine: { lineStyle: { color: "#555852" } },
      splitLine: { lineStyle: { color: "#2d302c" } }
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: "shift", moveOnMouseWheel: true },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        bottom: 18,
        height: 20,
        borderColor: "#3a3d38",
        backgroundColor: "#1d201d",
        fillerColor: "rgba(86, 132, 91, .28)",
        dataBackground: { lineStyle: { color: "#667064" }, areaStyle: { color: "#31372f" } },
        selectedDataBackground: { lineStyle: { color: "#8db193" }, areaStyle: { color: "#58705b" } },
        textStyle: { color: "#a9aaa5" }
      },
      ...(yIsProject ? [
        {
          type: "inside",
          yAxisIndex: 0,
          filterMode: "filter",
          start: Math.max(0, 100 - (25 / Math.max(1, projectAxisCategories.length)) * 100),
          end: 100,
          zoomOnMouseWheel: true,
          moveOnMouseWheel: true
        },
        {
          type: "slider",
          yAxisIndex: 0,
          filterMode: "filter",
          right: 16,
          top: 34,
          bottom: 88,
          width: 18,
          start: Math.max(0, 100 - (25 / Math.max(1, projectAxisCategories.length)) * 100),
          end: 100,
          borderColor: "#3a3d38",
          backgroundColor: "#1d201d",
          fillerColor: "rgba(86, 132, 91, .28)",
          textStyle: { color: "#a9aaa5" }
        }
      ] : [])
    ],
    series
  }, { notMerge: true, lazyUpdate: false });
  scatterChart.resize();
}

function renderBars(containerId, rows, valueField, formatter) {
  const container = document.getElementById(containerId);
  const top = rows.slice().sort(byDesc(valueField));
  const max = Math.max(1, ...top.map((row) => Number(row[valueField] || 0)));
  container.innerHTML = top.map((row) => {
    const value = Number(row[valueField] || 0);
    const width = Math.max(1, value / max * 100);
    const color = harnessColors[row.harness || row.key] || harnessColors.unknown;
    return "<div class=\\"bar-row\\"><div class=\\"bar-label\\" title=\\"" + escapeHtml(row.label || row.harness || row.key) + "\\">" + escapeHtml(row.label || row.harness || row.key) + "</div><div class=\\"bar-track\\"><div class=\\"bar-fill\\" style=\\"width:" + width.toFixed(2) + "%;background:" + color + "\\"></div></div><div class=\\"bar-value\\">" + formatter(value) + "</div></div>";
  }).join("");
}

function invocationRowsHtml(rows, max, color) {
  return rows.map((row) => {
    const calls = Number(row.calls || 0);
    const width = Math.max(1, calls / Math.max(1, max) * 100);
    const harnesses = Object.entries(row.harnesses || {})
      .map(([harness, count]) => harness + ": " + fmtInt(count))
      .join(" · ");
    return '<div class="ranking-row" title="' + escapeHtml(harnesses) + '">' +
      '<span class="ranking-rank">#' + fmtInt(row.rank) + '</span>' +
      '<span class="ranking-name">' + escapeHtml(row.name) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="display:block;width:' + width.toFixed(2) + '%;background:' + color + '"></span></span>' +
      '<span class="ranking-value">' + fmtNumber(calls) + '<small>' + fmtInt(row.sessions) + ' сесс.</small></span>' +
      '</div>';
  }).join("");
}

function invocationRankingHtml(rows, color) {
  if (!rows || rows.length === 0) return '<p class="hint">Нет распознанных вызовов.</p>';
  const topEnd = Math.min(5, rows.length);
  const bottomStart = Math.max(topEnd, rows.length - 5);
  const top = rows.slice(0, topEnd);
  const middle = rows.slice(topEnd, bottomStart);
  const bottom = rows.slice(bottomStart);
  const max = Number(rows[0].calls || 1);
  let html = '<div class="ranking-group-title">Топ-' + top.length + '</div>' +
    invocationRowsHtml(top, max, color);
  if (middle.length > 0) {
    html += '<details class="ranking-middle"><summary>Показать / скрыть остальные ' +
      fmtInt(middle.length) + '</summary>' + invocationRowsHtml(middle, max, color) + '</details>';
  }
  if (bottom.length > 0) {
    html += '<div class="ranking-group-title">Bottom-' + bottom.length + '</div>' +
      invocationRowsHtml(bottom, max, color);
  }
  return html;
}

function renderInvocationRankings() {
  document.getElementById("invocation-summary").innerHTML = [
    ["вызовы инструментов", fmtNumber(DATA.meta.toolCalls)],
    ["уникальные инструменты", fmtInt(DATA.meta.uniqueTools)],
    ["использования скиллов", fmtNumber(DATA.meta.skillCalls)],
    ["явные Skill-вызовы", fmtNumber(DATA.meta.explicitSkillCalls)],
    ["inferred SKILL.md", fmtNumber(DATA.meta.inferredSkillLoads)],
    ["уникальные скиллы", fmtInt(DATA.meta.uniqueSkills)],
    ["не распознано", fmtInt(DATA.meta.unparsedSkillCalls)]
  ].map(([label, value]) => '<span class="pill">' + escapeHtml(label) + ': <strong>' + escapeHtml(value) + '</strong></span>').join("");
  document.getElementById("tool-ranking").innerHTML =
    invocationRankingHtml(DATA.toolStats || [], "#4f8fe8");
  document.getElementById("skill-ranking").innerHTML =
    invocationRankingHtml(DATA.skillStats || [], "#58c483");
}

function utcDate(isoDay) {
  return new Date(isoDay + "T00:00:00Z");
}
function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(iso, days) {
  const date = utcDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}
function mondayIndex(iso) {
  return (utcDate(iso).getUTCDay() + 6) % 7;
}
function calendarRange(rows) {
  if (!rows.length) return [];
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;
  let cursor = addDays(first, -mondayIndex(first));
  const end = addDays(last, 6 - mondayIndex(last));
  const out = [];
  while (cursor <= end) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}
function levelFor(value, thresholds) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}
function renderDailyCalendar() {
  const metric = state.dailyMetric;
  const rows = DATA.dailyStats || [];
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const positive = rows
    .map((row) => Number(row[metric] || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const thresholds = [
    quantile(positive, .25),
    quantile(positive, .5),
    quantile(positive, .75)
  ];
  const peak = rows.slice().sort((a, b) => Number(b[metric] || 0) - Number(a[metric] || 0))[0];
  document.getElementById("daily-summary").innerHTML = [
    ["active days", fmtInt(DATA.meta.activeDays)],
    ["with tokens", fmtInt(DATA.meta.tokenActiveDays)],
    ["with active time", fmtInt(DATA.meta.timeActiveDays)],
    ["inferred-date messages", fmtNumber(DATA.meta.inferredTimestampMessages)],
    ["range", DATA.meta.firstActiveDay + " → " + DATA.meta.lastActiveDay],
    ["peak", peak ? peak.date + " · " + fmtDaily(metric, peak[metric]) : "n/a"]
  ].map(([label, value]) => "<span class=\\"pill\\">" + escapeHtml(label) + ": <strong>" + escapeHtml(value) + "</strong></span>").join("");

  document.getElementById("daily-calendar").innerHTML = calendarRange(rows).map((date) => {
    const row = byDate.get(date);
    const value = row ? Number(row[metric] || 0) : 0;
    const level = levelFor(value, thresholds);
    const outside = row ? "" : " outside";
    const title = row
      ? [
          date,
          "active: " + fmtHours(row.activeHours),
          "response wait: " + fmtHours(row.responseWaitHours),
          "tokens: " + fmtNumber(row.totalTokens),
          "uncached input: " + fmtNumber(row.uncachedInputTokens),
          "cache read: " + fmtNumber(row.cachedInputTokens),
          "cache write: " + fmtNumber(row.cacheWriteInputTokens),
          "output: " + fmtNumber(row.outputTokens),
          "messages: " + fmtNumber(row.messages),
          "inferred-date messages: " + fmtNumber(row.inferredTimestampMessages),
          "sessions: " + fmtInt(row.sessions),
          "chars: " + fmtNumber(row.contentChars),
          "top harness: " + (row.topHarness || "n/a")
        ].join("\\n")
      : date + "\\nno current-revision activity";
    return "<span class=\\"day-cell level-" + level + outside + "\\" title=\\"" + escapeHtml(title) + "\\"></span>";
  }).join("");
  document.getElementById("calendar-legend").innerHTML =
    "<span>меньше</span>" +
    [0, 1, 2, 3, 4].map((level) => "<span class=\\"legend-square day-cell level-" + level + "\\"></span>").join("") +
    "<span>больше · " + escapeHtml(metric) + "</span>";
}

function renderMonthlyChart() {
  const container = document.getElementById("monthly-chart");
  if (!monthlyChart) {
    monthlyChart = echarts.init(container, null, {
      renderer: "svg"
    });
    monthlyResizeObserver = new ResizeObserver(() => monthlyChart.resize());
    monthlyResizeObserver.observe(container);
  }
  const rows = DATA.monthlyStats || [];
  const metric = state.monthlyMetric;
  const stackSelect = document.getElementById("monthly-stack");
  const stackAllowed = metric !== "projects";
  stackSelect.disabled = !stackAllowed;
  stackSelect.value = stackAllowed ? state.monthlyStack : "none";
  const stackDimension = stackAllowed ? state.monthlyStack : "none";
  const isStacked = stackDimension !== "none";
  const isAgentTotal = metric === "agentWorkHours" && !isStacked;
  let series = isAgentTotal
    ? [
        {
          name: "lower bound",
          type: "bar",
          stack: "agent-work",
          data: rows.map((row) => Number(row.agentWorkMeasuredHours || 0)),
          itemStyle: { color: "#4f8fe8" },
          emphasis: { disabled: true }
        },
        {
          name: "estimated uplift",
          type: "bar",
          stack: "agent-work",
          data: rows.map((row) => Number(row.agentWorkEstimatedHours || 0)),
          itemStyle: { color: "#f0bf4c", borderColor: "#f7d980", borderWidth: 1, borderType: "dashed" },
          emphasis: { disabled: true }
        }
      ]
    : [{
        name: metricLabel(metric),
        type: "bar",
        data: rows.map((row) => Number(row[metric] || 0)),
        itemStyle: { color: "#4f8fe8" },
        emphasis: { disabled: true }
      }];
  if (isStacked) {
    const source = (DATA.monthlyBreakdowns || [])
      .filter((row) => row.dimension === stackDimension);
    const groups = new Map();
    for (const row of source) {
      const group = String(row.group || "unknown");
      const current = groups.get(group) || {
        group,
        label: String(row.label || group),
        total: 0,
        byMonth: new Map()
      };
      const value = Number(row[metric] || 0);
      current.total += value;
      current.byMonth.set(String(row.month), value);
      groups.set(group, current);
    }
    const duplicateLabels = new Map();
    for (const group of groups.values()) {
      duplicateLabels.set(group.label, (duplicateLabels.get(group.label) || 0) + 1);
    }
    series = Array.from(groups.values())
      .filter((group) => group.total > 0)
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
      .map((group) => ({
        name: duplicateLabels.get(group.label) > 1
          ? group.label + " · " + group.group.replace(/^workspace:/, "").slice(0, 8)
          : group.label,
        type: "bar",
        stack: "monthly-" + metric,
        data: rows.map((row) => Number(group.byMonth.get(String(row.month)) || 0)),
        itemStyle: { color: categoryColor(group.group, stackDimension) },
        emphasis: { disabled: true },
        barMaxWidth: 72
      }));
  }
  monthlyChart.setOption({
    animation: false,
    backgroundColor: "#171917",
    textStyle: { color: "#d8d8d3", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    grid: { left: 82, right: 28, top: isAgentTotal || isStacked ? 62 : 28, bottom: 72 },
    legend: {
      show: isAgentTotal || isStacked,
      type: "scroll",
      top: 12,
      left: 72,
      right: 24,
      textStyle: { color: "#a9aaa5" },
      selectedMode: true,
      pageTextStyle: { color: "#a9aaa5" },
      pageIconColor: "#d8d8d3",
      pageIconInactiveColor: "#555852"
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "shadow",
        shadowStyle: { color: "rgba(255, 255, 255, .045)" }
      },
      confine: true,
      renderMode: "richText",
      backgroundColor: "rgba(19, 21, 19, .96)",
      borderColor: "#4a4e47",
      textStyle: { color: "#e5e5df" },
      formatter: (params) => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0];
        const row = rows[first?.dataIndex];
        if (!row) return "n/a";
        if (isStacked) {
          const contributors = items
            .map((item) => ({ name: item.seriesName, value: Number(item.value || 0) }))
            .filter((item) => item.value > 0)
            .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
          const shown = contributors.slice(0, 10);
          const remainder = contributors.slice(10);
          const remainderValue = remainder.reduce((sum, item) => sum + item.value, 0);
          return [
            row.month,
            metricLabel(metric) + ": " + metricFormat(metric, row[metric]),
            "stack: " + stackDimension
          ].concat(
            shown.map((item) => item.name + ": " + metricFormat(metric, item.value)),
            remainder.length > 0
              ? ["остальные " + remainder.length + ": " + metricFormat(metric, remainderValue)]
              : []
          ).join("\\n");
        }
        if (isAgentTotal) {
          return [
            row.month,
            "lower bound: " + fmtHours(row.agentWorkMeasuredHours),
            "estimated uplift: " + fmtHours(row.agentWorkEstimatedHours),
            "agent-time: " + fmtHours(row.agentWorkHours)
          ].join("\\n");
        }
        return row.month + "\\n" + metricLabel(metric) + ": " + metricFormat(metric, row[metric]);
      }
    },
    xAxis: {
      type: "category",
      data: rows.map((row) => row.month),
      axisLabel: { color: "#a9aaa5", rotate: rows.length > 24 ? 45 : 0 },
      axisLine: { lineStyle: { color: "#555852" } }
    },
    yAxis: {
      type: "value",
      name: metricLabel(metric),
      nameTextStyle: { color: "#a9aaa5", fontWeight: 700 },
      axisLabel: { color: "#a9aaa5", formatter: (value) => metricFormat(metric, value) },
      splitLine: { lineStyle: { color: "#2d302c" } }
    },
    dataZoom: rows.length > 18
      ? [{ type: "inside", xAxisIndex: 0 }, { type: "slider", xAxisIndex: 0, bottom: 16, height: 18 }]
      : [],
    series
  }, { notMerge: true, lazyUpdate: false });
  monthlyChart.resize();
}

function renderTable(containerId, rows, columns, limit) {
  const shown = rows.slice(0, limit || rows.length);
  const html = "<table><thead><tr>" + columns.map((c) => "<th class=\\"" + (c.num ? "num" : "") + "\\">" + escapeHtml(c.label) + "</th>").join("") + "</tr></thead><tbody>" +
    shown.map((row) => "<tr>" + columns.map((c) => "<td class=\\"" + (c.num ? "num" : "") + "\\">" + escapeHtml(c.format ? c.format(row[c.field], row) : row[c.field]) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table>";
  document.getElementById(containerId).innerHTML = html;
}

function renderLeaderboards() {
  const modelRows = DATA.modelStats.filter((row) => row.totalTokens > 0 && row.usageMessages > 0);
  renderTable("model-token-table", modelRows.slice().sort(byDesc("avgTokensPerUsageMessage")), [
    { field: "model", label: "model" },
    { field: "vendor", label: "vendor" },
    { field: "avgTokensPerUsageMessage", label: "avg tok/answer", num: true, format: fmtNumber },
    { field: "totalTokens", label: "total", num: true, format: fmtNumber }
  ], 10);
  renderTable("model-yield-table", modelRows.slice().sort(byDesc("outputShare")), [
    { field: "model", label: "model" },
    { field: "outputShare", label: "output/total", num: true, format: fmtPct },
    { field: "cacheShareOfInput", label: "cache/input", num: true, format: fmtPct },
    { field: "usageMessages", label: "answers", num: true, format: fmtInt }
  ], 10);
  renderTable("model-latency-table", modelRows.filter((row) => row.durationCount > 0).sort(byDesc("durationCoverage")), [
    { field: "model", label: "model" },
    { field: "durationCoverage", label: "coverage", num: true, format: fmtPct },
    { field: "durationP50Ms", label: "P50", num: true, format: fmtMs },
    { field: "durationP90Ms", label: "P90", num: true, format: fmtMs },
    { field: "ttftP50Ms", label: "TTFT P50", num: true, format: fmtMs }
  ], 10);
  renderTable("contrast-table", DATA.modelHarnessContrasts, [
    { field: "model", label: "model" },
    { field: "harnesses", label: "harnesses" },
    { field: "totalTokens", label: "tokens", num: true, format: fmtNumber },
    { field: "uncachedInputTokens", label: "input", num: true, format: fmtNumber },
    { field: "classifiedCachedInputTokens", label: "cache read", num: true, format: fmtNumber },
    { field: "classifiedCacheWriteInputTokens", label: "cache write", num: true, format: fmtNumber },
    { field: "outputTokens", label: "output", num: true, format: fmtNumber },
    { field: "tokenBreakdownCoverage", label: "breakdown", num: true, format: fmtPct },
    { field: "avgTokensRatio", label: "avg tok spread", num: true, format: (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(2) + "x" : "n/a" },
    { field: "fastestHarness", label: "top output/h" },
    { field: "outputThroughputMax", label: "max output/h", num: true, format: fmtTokensPerHour },
    { field: "cacheShareMax", label: "max cache", num: true, format: fmtPct },
    { field: "durationP50MaxMs", label: "slow P50", num: true, format: fmtMs }
  ], 20);
}

function renderTimingAudit() {
  document.getElementById("timing-summary").innerHTML = [
    ["gap active", fmtHours(DATA.meta.gapActiveHours)],
    ["measured", fmtHours(DATA.meta.measuredActiveHours)],
    ["exact user wait", fmtHours(DATA.meta.exactResponseWaitHours)],
    ["exact agent turns", fmtHours(DATA.meta.exactTurnDurationHours)],
    ["estimated wait", fmtHours(DATA.meta.interpolatedResponseWaitHours)],
    ["estimated sessions", fmtInt(DATA.meta.interpolatedResponseWaitSessions)],
    ["duration-backed", fmtHours(DATA.meta.durationBackedActiveHours)],
    ["duration-backed sessions", fmtInt(DATA.meta.exactDurationBackedSessions)],
    ["diagnosed replay", fmtInt(DATA.meta.suspiciousTimingSessions)]
  ].map(([label, value]) => "<span class=\\"pill\\">" + escapeHtml(label) + ": <strong>" + escapeHtml(value) + "</strong></span>").join("");
  renderTable("timing-audit-table", DATA.timingAudit || [], [
    { field: "dialogueId", label: "dialogue" },
    { field: "harness", label: "harness" },
    { field: "model", label: "model" },
    { field: "messages", label: "messages", num: true, format: fmtNumber },
    { field: "totalTokens", label: "tokens", num: true, format: fmtNumber },
    { field: "activeHours", label: "active", num: true, format: fmtHours },
    { field: "gapActiveHours", label: "gap active", num: true, format: fmtHours },
    { field: "responseWaitHours", label: "wait", num: true, format: fmtHours },
    { field: "exactTurnDurationHours", label: "agent turns", num: true, format: fmtHours },
    { field: "interpolatedResponseWaitHours", label: "estimated", num: true, format: fmtHours },
    { field: "waitSource", label: "wait source" },
    { field: "waitEstimateLowerHours", label: "estimate low", num: true, format: fmtHours },
    { field: "waitEstimateUpperHours", label: "estimate high", num: true, format: fmtHours },
    { field: "durationBackedHours", label: "duration", num: true, format: fmtHours },
    { field: "elapsedHours", label: "elapsed", num: true, format: fmtHours },
    { field: "timestampSpanHours", label: "ts span", num: true, format: fmtHours },
    { field: "uniqueTimestamps", label: "uniq ts", num: true, format: fmtInt },
    { field: "uniqueTimestampRatio", label: "uniq ratio", num: true, format: fmtPct },
    { field: "timingQuality", label: "quality" },
    { field: "timingWarning", label: "cause" }
  ], 30);
}

function renderInterpolationAudit() {
  const counts = DATA.meta.interpolationSourceCounts || {};
  const sourceSummary = Object.entries(counts)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([source, count]) => source.replace("interpolated_", "") + ": " + fmtInt(count))
    .join(" · ");
  document.getElementById("interpolation-summary").innerHTML = [
    ["estimated sessions", fmtInt(DATA.meta.interpolatedResponseWaitSessions)],
    ["estimated wait", fmtHours(DATA.meta.interpolatedResponseWaitHours)],
    ["exact sessions", fmtInt(DATA.meta.responseWaitBackedSessions)],
    ["donor scope", sourceSummary || "n/a"]
  ].map(([label, value]) => "<span class=\\"pill\\">" + escapeHtml(label) + ": <strong>" + escapeHtml(value) + "</strong></span>").join("");
  renderTable("interpolation-table", DATA.interpolationAudit || [], [
    { field: "dialogueId", label: "dialogue" },
    { field: "harness", label: "harness" },
    { field: "model", label: "model" },
    { field: "interpolatedResponseWaitHours", label: "estimate", num: true, format: fmtHours },
    { field: "waitEstimateLowerHours", label: "P20", num: true, format: fmtHours },
    { field: "waitEstimateUpperHours", label: "P80", num: true, format: fmtHours },
    { field: "waitSource", label: "donor scope" },
    { field: "waitEstimateDonors", label: "donors", num: true, format: fmtInt },
    { field: "durationBackedHours", label: "source floor", num: true, format: fmtHours },
    { field: "totalTokens", label: "tokens", num: true, format: fmtNumber },
    { field: "messages", label: "messages", num: true, format: fmtNumber }
  ], 200);
}

function renderHeatmap() {
  const models = DATA.modelStats.filter((row) => row.totalTokens > 0).slice(0, 12).map((row) => row.model);
  const harnesses = DATA.harnessStats.map((row) => row.harness);
  const byKey = new Map(DATA.modelHarnessStats.map((row) => [row.model + "@@" + row.harness, row]));
  const values = [];
  models.forEach((model) => harnesses.forEach((harness) => {
    const row = byKey.get(model + "@@" + harness);
    if (row && row.avgTokensPerUsageMessage) values.push(row.avgTokensPerUsageMessage);
  }));
  const max = Math.max(1, ...values);
  let html = "<table><thead><tr><th>model</th>" + harnesses.map((h) => "<th class=\\"num\\">" + escapeHtml(h) + "</th>").join("") + "</tr></thead><tbody>";
  for (const model of models) {
    html += "<tr><td>" + escapeHtml(model) + "</td>";
    for (const harness of harnesses) {
      const row = byKey.get(model + "@@" + harness);
      if (!row || !row.avgTokensPerUsageMessage) {
        html += "<td class=\\"num\\">·</td>";
      } else {
        const alpha = Math.max(.08, Math.min(.9, row.avgTokensPerUsageMessage / max));
        html += "<td class=\\"num\\"><span class=\\"heat-cell\\" style=\\"background:rgba(118,183,255," + alpha.toFixed(3) + ")\\">" + fmtNumber(row.avgTokensPerUsageMessage) + "</span></td>";
      }
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  document.getElementById("heatmap").innerHTML = html;
}

function renderDetailedTables() {
  renderTable("harness-table", DATA.harnessStats, [
    { field: "harness", label: "harness" },
    { field: "dialogues", label: "dialogues", num: true, format: fmtInt },
    { field: "messages", label: "messages", num: true, format: fmtNumber },
    { field: "totalTokens", label: "tokens", num: true, format: fmtNumber },
    { field: "uncachedInputTokens", label: "input", num: true, format: fmtNumber },
    { field: "classifiedCachedInputTokens", label: "cache read", num: true, format: fmtNumber },
    { field: "classifiedCacheWriteInputTokens", label: "cache write", num: true, format: fmtNumber },
    { field: "outputTokens", label: "output", num: true, format: fmtNumber },
    { field: "activeHours", label: "active", num: true, format: fmtHours },
    { field: "responseWaitHours", label: "response wait", num: true, format: fmtHours },
    { field: "interpolatedResponseWaitHours", label: "estimated wait", num: true, format: fmtHours },
    { field: "interpolatedWaitSessions", label: "estimated sessions", num: true, format: fmtInt },
    { field: "durationHours", label: "API duration", num: true, format: fmtHours },
    { field: "reportedDurationHours", label: "reported work", num: true, format: fmtHours },
    { field: "estimatedCostUsd", label: "model-priced $", num: true, format: fmtUsd },
    { field: "estimatedCostCoverage", label: "price coverage", num: true, format: fmtPct },
    { field: "reportedCostUsd", label: "harness-reported $", num: true, format: fmtUsd },
    { field: "tokensPerActiveHour", label: "tokens/h", num: true, format: fmtTokensPerHour },
    { field: "cacheShareOfInput", label: "cache/input", num: true, format: fmtPct },
    { field: "outputShare", label: "output/total", num: true, format: fmtPct }
  ]);
  renderTable("model-table", DATA.modelStats, [
    { field: "model", label: "model" },
    { field: "vendor", label: "vendor" },
    { field: "usageMessages", label: "usage msg", num: true, format: fmtNumber },
    { field: "totalTokens", label: "tokens", num: true, format: fmtNumber },
    { field: "uncachedInputTokens", label: "input", num: true, format: fmtNumber },
    { field: "classifiedCachedInputTokens", label: "cache read", num: true, format: fmtNumber },
    { field: "classifiedCacheWriteInputTokens", label: "cache write", num: true, format: fmtNumber },
    { field: "outputTokens", label: "output", num: true, format: fmtNumber },
    { field: "estimatedCostUsd", label: "model-priced $", num: true, format: fmtUsd },
    { field: "effectiveCostPerMillionTokens", label: "effective $/1M", num: true, format: fmtUsd },
    { field: "pricingSourceKind", label: "price source" },
    { field: "tokenBreakdownCoverage", label: "breakdown", num: true, format: fmtPct },
    { field: "avgTokensPerUsageMessage", label: "avg tok/msg", num: true, format: fmtNumber },
    { field: "outputShare", label: "output/total", num: true, format: fmtPct },
    { field: "cacheShareOfInput", label: "cache/input", num: true, format: fmtPct },
    { field: "responseWaitHours", label: "response wait", num: true, format: fmtHours },
    { field: "interpolatedResponseWaitHours", label: "estimated wait", num: true, format: fmtHours },
    { field: "durationHours", label: "API duration", num: true, format: fmtHours },
    { field: "durationP50Ms", label: "P50", num: true, format: fmtMs },
    { field: "durationP90Ms", label: "P90", num: true, format: fmtMs },
    { field: "reportedDurationP50Ms", label: "reported P50", num: true, format: fmtMs }
  ], 80);
  renderTable("model-harness-table", DATA.modelHarnessStats, [
    { field: "model", label: "model" },
    { field: "harness", label: "harness" },
    { field: "usageMessages", label: "usage msg", num: true, format: fmtNumber },
    { field: "totalTokens", label: "tokens", num: true, format: fmtNumber },
    { field: "uncachedInputTokens", label: "input", num: true, format: fmtNumber },
    { field: "classifiedCachedInputTokens", label: "cache read", num: true, format: fmtNumber },
    { field: "classifiedCacheWriteInputTokens", label: "cache write", num: true, format: fmtNumber },
    { field: "outputTokens", label: "output", num: true, format: fmtNumber },
    { field: "tokenBreakdownCoverage", label: "breakdown", num: true, format: fmtPct },
    { field: "avgTokensPerUsageMessage", label: "avg tok/msg", num: true, format: fmtNumber },
    { field: "outputTokensPerActiveHour", label: "output/h", num: true, format: fmtTokensPerHour },
    { field: "cacheShareOfInput", label: "cache/input", num: true, format: fmtPct },
    { field: "responseWaitHours", label: "response wait", num: true, format: fmtHours },
    { field: "interpolatedResponseWaitHours", label: "estimated wait", num: true, format: fmtHours },
    { field: "durationHours", label: "API duration", num: true, format: fmtHours },
    { field: "durationP50Ms", label: "P50", num: true, format: fmtMs },
    { field: "reportedDurationP50Ms", label: "reported P50", num: true, format: fmtMs }
  ], 120);
  renderTable("role-table", DATA.roleStats, [
    { field: "role", label: "role" },
    { field: "messages", label: "messages", num: true, format: fmtNumber },
    { field: "contentChars", label: "chars", num: true, format: fmtNumber },
    { field: "tokens", label: "tokens", num: true, format: fmtNumber },
    { field: "avgCharsPerMessage", label: "chars/msg", num: true, format: fmtNumber }
  ]);
  renderTable("daily-table", DATA.dailyStats.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))), [
    { field: "date", label: "date" },
    { field: "activeHours", label: "active", num: true, format: fmtHours },
    { field: "responseWaitHours", label: "response wait", num: true, format: fmtHours },
    { field: "interpolatedResponseWaitHours", label: "estimated wait", num: true, format: fmtHours },
    { field: "durationHours", label: "API duration", num: true, format: fmtHours },
    { field: "reportedDurationHours", label: "reported", num: true, format: fmtHours },
    { field: "totalTokens", label: "tokens", num: true, format: fmtNumber },
    { field: "messages", label: "messages", num: true, format: fmtNumber },
    { field: "inferredTimestampMessages", label: "inferred-date msg", num: true, format: fmtNumber },
    { field: "sessions", label: "sessions", num: true, format: fmtInt },
    { field: "contentChars", label: "chars", num: true, format: fmtNumber },
    { field: "topHarness", label: "top harness" }
  ]);
}

initControls();
renderMetrics();
renderLineageAudit();
renderDailyCalendar();
renderScatter();
renderMonthlyChart();
renderInvocationRankings();
renderPricing();
renderTokenMix();
renderBars("harness-token-bars", DATA.harnessStats, "totalTokens", fmtNumber);
renderBars("harness-time-bars", DATA.harnessStats, "activeHours", fmtHours);
renderLeaderboards();
renderTimingAudit();
renderHeatmap();
renderDetailedTables();
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const db = await connectDb(cfg);
  try {
    console.log("loading current dialogues");
    const dialoguesByRevision = await loadDialogues(db);
    console.log(`current dialogues: ${dialoguesByRevision.size.toLocaleString("en-US")}`);
    const dialogueFilter = await excludeDialoguesWithoutAssistantAnswer(db, dialoguesByRevision);
    console.log(
      `eligible dialogues: ${dialogueFilter.eligibleCurrentDialogues.toLocaleString("en-US")} ` +
        `(excluded ${dialogueFilter.excludedNoAssistantAnswer.toLocaleString("en-US")} without visible assistant answer)`,
    );
    console.log("analysing Codex subagent lineage");
    const lineage = await analyzeCodexLineage(
      db,
      cfg.archiveRoot,
      new Set(dialoguesByRevision.keys()),
    );
    const lineageByChild = new Map(
      lineage.details.map((row) => [String(row.childId ?? ""), row]),
    );
    const replayMapping = await mapCodexReplayToMessages(db, lineage.replayUsageByRevision);
    console.log(
      `mapped ${replayMapping.mappedEvents.toLocaleString("en-US")} replay events to ` +
        `${replayMapping.deductions.size.toLocaleString("en-US")} canonical messages`,
    );
    const scan = await scanMessages(db, dialoguesByRevision, replayMapping.deductions);
    console.log("scanning tool and skill invocations");
    const invocations = await scanInvocations(db, dialoguesByRevision);
    const responseWaitEstimates = interpolateResponseWaits(dialoguesByRevision.values());
    const interpolationSourceCounts = new Map<string, number>();
    for (const estimate of responseWaitEstimates.values()) {
      interpolationSourceCounts.set(
        estimate.source,
        (interpolationSourceCounts.get(estimate.source) ?? 0) + 1,
      );
    }
    console.log(
      `interpolated response wait for ${responseWaitEstimates.size.toLocaleString("en-US")} sessions`,
    );

    const sessionPoints: Array<Record<string, unknown>> = [];
    const interpolationAuditRows: Array<Record<string, unknown>> = [];
    const timingAuditRows: Array<Record<string, unknown>> = [];
    let totalGapActiveMs = 0;
    let totalDurationBackedMs = 0;
    let totalApiDurationBackedMs = 0;
    let totalResponseWaitMs = 0;
    let totalExactTurnDurationMs = 0;
    let totalMeasuredWaitMs = 0;
    let totalInterpolatedResponseWaitMs = 0;
    let totalAgentWorkMeasuredMs = 0;
    let totalAgentWorkEstimatedMs = 0;
    const monthlyAgentWork = new Map<string, MonthlyAgentAccumulator>();
    let exactDurationBackedSessions = 0;
    let responseWaitBackedSessions = 0;
    let exactTurnDurationBackedSessions = 0;
    let suspiciousTimingSessions = 0;
    for (const dialogue of dialoguesByRevision.values()) {
      const gapActiveMs = activeMsFromTimestamps(dialogue.timestamps);
      const responseWaitMs = dialogue.responseWaitMsSum;
      const exactTurnDurationMs = dialogue.exactTurnDurationMsSum;
      const measuredMs = measuredWaitMs(dialogue);
      const estimate = responseWaitEstimates.get(dialogue.revision);
      const interpolatedWaitMs = estimate?.ms ?? 0;
      dialogue.interpolatedResponseWaitMs = interpolatedWaitMs;
      const apiDurationBackedMs = Math.max(
        dialogue.durationMsSum,
        dialogue.reportedDurationMsSum,
      );
      // Agent-time складывается по сессиям: параллельные агенты намеренно
      // не схлопываются по wall-clock. Интерполяция добавляет только часть
      // сверх наблюдаемого/API-backed нижнего предела.
      const agentWorkMeasuredMs = Math.max(gapActiveMs, apiDurationBackedMs);
      const agentWorkEstimatedMs = estimate
        ? Math.max(0, estimate.ms - agentWorkMeasuredMs)
        : 0;
      const durationBackedMs = measuredMs > 0 ? measuredMs : apiDurationBackedMs;
      const activeMs = measuredMs > 0
        ? measuredMs
        : interpolatedWaitMs > 0
          ? interpolatedWaitMs
          : effectiveActiveMs(gapActiveMs, apiDurationBackedMs, responseWaitMs);
      const elapsed = elapsedMs(dialogue);
      const model = dominantModel(dialogue);
      const timing = timingDiagnostics(
        dialogue,
        gapActiveMs,
        durationBackedMs,
        responseWaitMs,
        exactTurnDurationMs,
        estimate,
      );
      const lineageDetail = dialogue.externalId
        ? lineageByChild.get(dialogue.externalId)
        : undefined;
      if (timing.timingWarning && lineageDetail?.status === "exact_prefix_replay") {
        timing.timingQuality = "confirmed_parent_history_replay";
        timing.timingWarning =
          `${Number(lineageDetail.replayEvents ?? 0).toLocaleString("en-US")} inherited token events ` +
          `were replayed at subagent spawn (${(Number(lineageDetail.replayShare ?? 0) * 100).toFixed(1)}% of child events)`;
      }
      totalGapActiveMs += gapActiveMs;
      totalDurationBackedMs += durationBackedMs;
      totalApiDurationBackedMs += apiDurationBackedMs;
      totalResponseWaitMs += responseWaitMs;
      if (responseWaitMs === 0) totalExactTurnDurationMs += exactTurnDurationMs;
      totalMeasuredWaitMs += measuredMs;
      totalInterpolatedResponseWaitMs += interpolatedWaitMs;
      totalAgentWorkMeasuredMs += agentWorkMeasuredMs;
      totalAgentWorkEstimatedMs += agentWorkEstimatedMs;
      addMonthlyAgentWork(
        monthlyAgentWork,
        scan.monthlyBreakdowns,
        dialogue,
        model,
        agentWorkMeasuredMs,
        agentWorkEstimatedMs,
      );
      if (durationBackedMs > 0) exactDurationBackedSessions += 1;
      if (responseWaitMs > 0) responseWaitBackedSessions += 1;
      if (responseWaitMs === 0 && exactTurnDurationMs > 0) {
        exactTurnDurationBackedSessions += 1;
      }
      if (timing.timingWarning) suspiciousTimingSessions += 1;
      addDailyActiveTime(scan.dayStats, dialogue, estimate);
      addSessionTime(
        dialogue,
        model,
        activeMs,
        responseWaitMs,
        interpolatedWaitMs,
        agentWorkMeasuredMs,
        agentWorkEstimatedMs,
        elapsed,
        scan.harnessStats,
        scan.modelStats,
        scan.modelHarnessStats,
      );
      const point = sessionPoint(
        dialogue,
        activeMs,
        agentWorkMeasuredMs,
        agentWorkEstimatedMs,
        elapsed,
        model,
        timing,
      );
      sessionPoints.push(point);
      if (estimate) interpolationAuditRows.push(point);
      if (timing.timingWarning) {
        timingAuditRows.push(point);
      }
    }

    const harnessStats = [...scan.harnessStats.values()]
      .sort((a, b) => harnessRank(a.harness) - harnessRank(b.harness) || a.key.localeCompare(b.key))
      .map(finalizeGroup);
    const modelStats = [...scan.modelStats.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map(finalizeModelGroup);
    const modelHarnessStats = [...scan.modelHarnessStats.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map(finalizeGroup);
    const roleStats = [...scan.roleStats.values()]
      .sort((a, b) => b.messages - a.messages)
      .map((row) =>
        roundObject({
          role: row.role,
          messages: row.messages,
          contentChars: row.contentChars,
          tokens: row.tokens,
          avgCharsPerMessage: row.messages > 0 ? row.contentChars / row.messages : null,
        }),
      );
    const dailyStats = finalizeDayStats(scan.dayStats);
    const firstActiveDay = typeof dailyStats[0]?.date === "string" ? dailyStats[0].date : null;
    const lastDailyStat = dailyStats.at(-1);
    const lastActiveDay = typeof lastDailyStat?.date === "string" ? lastDailyStat.date : null;
    const monthlyBreakdowns = finalizeMonthlyBreakdowns(scan.monthlyBreakdowns);
    const monthlyStats = finalizeMonthlyStats(
      dailyStats,
      monthlyAgentWork,
      monthlyBreakdowns,
    );
    const projectKeys = new Set(
      [...dialoguesByRevision.values()]
        .map((dialogue) => dialogue.projectKey)
        .filter((project) => project !== "unassigned"),
    );
    const unassignedProjectDialogues = [...dialoguesByRevision.values()]
      .filter((dialogue) => dialogue.projectKey === "unassigned").length;
    const topModel = topBy(modelStats, "totalTokens");
    const totalResponses = sumRows(harnessStats, "responses");
    const durationCount = sumRows(harnessStats, "durationCount");
    const durationHours = sumRows(harnessStats, "durationHours");
    const reportedDurationCount = sumRows(harnessStats, "reportedDurationCount");
    const inputTokens = sumRows(harnessStats, "inputTokens");
    const cachedInputTokens = sumRows(harnessStats, "cachedInputTokens");
    const cacheWriteInputTokens = sumRows(harnessStats, "cacheWriteInputTokens");
    const tokenBreakdownInputTokens = sumRows(harnessStats, "tokenBreakdownInputTokens");
    const uncachedInputTokens = sumRows(harnessStats, "uncachedInputTokens");
    const classifiedCachedInputTokens = sumRows(harnessStats, "classifiedCachedInputTokens");
    const classifiedCacheWriteInputTokens = sumRows(harnessStats, "classifiedCacheWriteInputTokens");
    const invalidTokenBreakdownMessages = sumRows(harnessStats, "invalidTokenBreakdownMessages");
    const lineageAdjustedTotalTokens = sumRows(harnessStats, "totalTokens");
    const attributedModelTokens = sumRows(modelStats, "totalTokens");
    const rawTotalTokens = lineageAdjustedTotalTokens + replayMapping.mappedReplay.totalTokens;
    const estimatedCostUsd = sumRows(harnessStats, "estimatedCostUsd");
    const pricedTokens = sumRows(harnessStats, "pricedTokens");
    const unpricedTokens = sumRows(harnessStats, "unpricedTokens");
    const data = {
      generatedAt: new Date().toISOString(),
      meta: roundObject({
        idleGapSeconds: IDLE_GAP_MS / 1000,
        sourceCurrentDialogues: dialogueFilter.sourceCurrentDialogues,
        messageRowsScanned: scan.rowsScanned,
        eligibilityRowsScanned: dialogueFilter.eligibilityRowsScanned,
        currentDialogues: dialoguesByRevision.size,
        currentProjects: projectKeys.size,
        unassignedProjectDialogues,
        toolCalls: invocations.toolCalls,
        uniqueTools: invocations.uniqueTools,
        skillCalls: invocations.skillCalls,
        explicitSkillCalls: invocations.explicitSkillCalls,
        inferredSkillLoads: invocations.inferredSkillLoads,
        namedSkillCalls: invocations.namedSkillCalls,
        unparsedSkillCalls: invocations.unparsedSkillCalls,
        uniqueSkills: invocations.uniqueSkills,
        excludedNoAssistantAnswer: dialogueFilter.excludedNoAssistantAnswer,
        sourceActiveHours: dialogueFilter.sourceActiveHours,
        eligibleActiveHoursBeforeFilter: dialogueFilter.eligibleActiveHoursBeforeFilter,
        excludedNoAssistantAnswerActiveHours: dialogueFilter.excludedNoAssistantAnswerActiveHours,
        currentMessages: scan.currentMessages,
        usageMessages: sumRows(harnessStats, "usageMessages"),
        totalTokens: rawTotalTokens,
        lineageAdjustedTotalTokens,
        codexReplayTokens: replayMapping.mappedReplay.totalTokens,
        codexReplayInputTokens: replayMapping.mappedReplay.inputTokens,
        codexReplayCachedInputTokens: replayMapping.mappedReplay.cachedInputTokens,
        codexReplayOutputTokens: replayMapping.mappedReplay.outputTokens,
        inputTokens,
        uncachedInputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        tokenBreakdownInputTokens,
        classifiedCachedInputTokens,
        classifiedCacheWriteInputTokens,
        invalidTokenBreakdownMessages,
        unclassifiedInputTokens: inputTokens - tokenBreakdownInputTokens,
        outputTokens: sumRows(harnessStats, "outputTokens"),
        reasoningOutputTokens: sumRows(harnessStats, "reasoningOutputTokens"),
        attributedModelTokens,
        unattributedModelTokens: lineageAdjustedTotalTokens - attributedModelTokens,
        contentChars: sumRows(harnessStats, "contentChars"),
        inferredTimestampMessages: sumRows(dailyStats, "inferredTimestampMessages"),
        activeHours: sumRows(harnessStats, "activeHours"),
        gapActiveHours: totalGapActiveMs / 3_600_000,
        apiDurationBackedActiveHours: totalApiDurationBackedMs / 3_600_000,
        durationBackedActiveHours: totalDurationBackedMs / 3_600_000,
        responseWaitHours: totalResponseWaitMs / 3_600_000,
        exactResponseWaitHours: totalResponseWaitMs / 3_600_000,
        exactTurnDurationHours: totalExactTurnDurationMs / 3_600_000,
        measuredActiveHours: totalMeasuredWaitMs / 3_600_000,
        interpolatedResponseWaitHours: totalInterpolatedResponseWaitMs / 3_600_000,
        totalResponseWaitHours:
          (totalResponseWaitMs + totalInterpolatedResponseWaitMs) / 3_600_000,
        totalModeledActiveHours:
          (totalMeasuredWaitMs + totalInterpolatedResponseWaitMs) / 3_600_000,
        agentWorkMeasuredHours: totalAgentWorkMeasuredMs / 3_600_000,
        agentWorkEstimatedHours: totalAgentWorkEstimatedMs / 3_600_000,
        agentWorkHours:
          (totalAgentWorkMeasuredMs + totalAgentWorkEstimatedMs) / 3_600_000,
        agentWorkToUserWaitRatio:
          totalResponseWaitMs > 0
            ? (totalAgentWorkMeasuredMs + totalAgentWorkEstimatedMs) / totalResponseWaitMs
            : null,
        agentWorkUpliftHours:
          (totalAgentWorkMeasuredMs + totalAgentWorkEstimatedMs - totalResponseWaitMs) /
          3_600_000,
        exactDurationBackedSessions,
        responseWaitBackedSessions,
        exactTurnDurationBackedSessions,
        interpolatedResponseWaitSessions: responseWaitEstimates.size,
        interpolationSourceCounts: Object.fromEntries(interpolationSourceCounts),
        suspiciousTimingSessions,
        activeDays: dailyStats.length,
        tokenActiveDays: dailyStats.filter((row) => Number(row.totalTokens ?? 0) > 0).length,
        timeActiveDays: dailyStats.filter((row) => Number(row.activeHours ?? 0) > 0).length,
        firstActiveDay,
        lastActiveDay,
        calendarDays: inclusiveCalendarDayCount(firstActiveDay, lastActiveDay),
        durationCount,
        durationHours,
        reportedDurationCount,
        reportedDurationHours: sumRows(harnessStats, "reportedDurationHours"),
        durationCoverage: totalResponses > 0 ? durationCount / totalResponses : null,
        cacheShareOfInput:
          tokenBreakdownInputTokens > 0 ? classifiedCachedInputTokens / tokenBreakdownInputTokens : null,
        cacheWriteShareOfInput:
          tokenBreakdownInputTokens > 0 ? classifiedCacheWriteInputTokens / tokenBreakdownInputTokens : null,
        tokenBreakdownCoverage:
          inputTokens > 0 ? tokenBreakdownInputTokens / inputTokens : null,
        rawCacheInputRatio: inputTokens > 0 ? cachedInputTokens / inputTokens : null,
        topModel: topModel?.model ?? null,
        topModelTokens: topModel?.totalTokens ?? null,
        pricingAsOf: REPORT_DATE,
        estimatedCostUsd,
        estimatedInputCostUsd: sumRows(harnessStats, "estimatedInputCostUsd"),
        estimatedCachedInputCostUsd: sumRows(harnessStats, "estimatedCachedInputCostUsd"),
        estimatedCacheWriteCostUsd: sumRows(harnessStats, "estimatedCacheWriteCostUsd"),
        estimatedOutputCostUsd: sumRows(harnessStats, "estimatedOutputCostUsd"),
        pricedUsageMessages: sumRows(harnessStats, "pricedUsageMessages"),
        unpricedUsageMessages: sumRows(harnessStats, "unpricedUsageMessages"),
        pricedTokens,
        unpricedTokens,
        estimatedCostCoverage: pricedTokens + unpricedTokens > 0
          ? pricedTokens / (pricedTokens + unpricedTokens)
          : null,
        reportedCostUsd: sumRows(harnessStats, "reportedCostUsd"),
        reportedCostMessages: sumRows(harnessStats, "reportedCostMessages"),
      }),
      sessionPoints: sessionPoints.sort((a, b) => Number(b.totalTokens ?? 0) - Number(a.totalTokens ?? 0)),
      interpolationAudit: interpolationAuditRows.sort(
        (a, b) => Number(b.interpolatedResponseWaitHours ?? 0) - Number(a.interpolatedResponseWaitHours ?? 0),
      ),
      timingAudit: timingAuditRows
        .sort((a, b) => {
          const byMessages = Number(b.messages ?? 0) - Number(a.messages ?? 0);
          return byMessages !== 0 ? byMessages : Number(b.totalTokens ?? 0) - Number(a.totalTokens ?? 0);
        })
        .slice(0, 80),
      harnessStats,
      modelStats,
      modelHarnessStats,
      modelHarnessContrasts: buildContrasts(modelHarnessStats),
      roleStats,
      dailyStats,
      monthlyStats,
      monthlyBreakdowns,
      toolStats: invocations.toolStats,
      skillStats: invocations.skillStats,
      lineage: {
        totals: lineage.totals,
        canonicalReplay: replayMapping.mappedReplay,
        canonicalReplayEvents: replayMapping.mappedEvents,
        canonicalReplayMessages: replayMapping.deductions.size,
        canonicalReplayRevisions: replayMapping.mappedRevisions,
        adjustedTotalTokens: lineageAdjustedTotalTokens,
        replayShareOfRawTotal: rawTotalTokens > 0
          ? replayMapping.mappedReplay.totalTokens / rawTotalTokens
          : null,
        largestReplays: lineage.details
          .filter((row) => row.status === "exact_prefix_replay")
          .slice(0, 20),
      },
      notes: [
        "No message text or chunk content is exported.",
        "Dialogues without a visible assistant answer are excluded from all aggregates.",
        "Active time uses confirmed end-to-end user wait or exact agent turn duration when present, including aborted turns and separately recorded subagents.",
        "Sessions without measured timing use an explicitly marked nearest-neighbor interpolation: measured time per usage call is scaled to the target call count; donor scope is same model, same vendor, or global, and API/reported duration is a lower bound.",
        "Messages without source timestamps are assigned to dialogue.started_at (or updated_at when start is absent) for daily charts and counted separately as inferredTimestampMessages.",
        "Codex lineage totals are measured by exact longest-common-prefix matching of child and parent last_token_usage streams; lineage-adjusted total removes only confirmed inherited events.",
        "Estimated cost is an API-equivalent calculated per usage message from its canonical model and uncached input, cache read, cache write, and output buckets. Harness and vendor never select the rate.",
        "Official model prices are preferred. Explicitly marked partner/proxy prices are used only when no direct public model tariff is available; unknown/default/synthetic models remain unpriced and reduce coverage.",
        "The estimate is not an actual subscription/OAuth bill. Anthropic cache writes assume 5-minute TTL because canonical usage does not retain TTL; OpenAI long-context and Qwen input tiers are selected per usage message.",
        "Token input is split per usage message into uncached input, cache read/hit, and cache creation/write; contradictory legacy rows remain in totals but not in the classified breakdown.",
        `Daily buckets use ${REPORT_TIME_ZONE} calendar days.`,
        "Model active time is attributed to the dominant model in a dialogue; model token totals remain message-level.",
      ],
    };

    await mkdir(options.outputDir, { recursive: true });
    const dataPath = path.join(options.outputDir, "data.json");
    const htmlPath = path.join(options.outputDir, "report.html");
    const echartsSource = await readFile(
      path.resolve(import.meta.dir, "../node_modules/echarts/dist/echarts.min.js"),
      "utf8",
    );
    await writeFile(dataPath, JSON.stringify(data, null, 2));
    await writeFile(htmlPath, reportHtml(data, echartsSource));
    console.log(`wrote ${dataPath}`);
    console.log(`wrote ${htmlPath}`);
  } finally {
    await db.close();
  }
}

if (import.meta.main) await main();
