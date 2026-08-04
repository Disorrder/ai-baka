#!/usr/bin/env bun
import { type Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import type { ParsedUsageEvent } from "../src/domain/canonical-types.ts";
import { acquireLock } from "../src/infra/lock.ts";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";

const PAGE_SIZE = 50_000;
const WRITE_BATCH_SIZE = 250;

interface MessageUsageRow {
  id: unknown;
  dialogue_revision: unknown;
  usage?: Record<string, unknown>;
  raw_usage_events?: ParsedUsageEvent[];
}

interface Options {
  dryRun: boolean;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  if (args.length === 0) return { dryRun: false };
  if (args.length === 1 && args[0] === "--dry-run") return { dryRun: true };
  throw new Error("usage: backfill-usage-breakdown.ts [--dry-run]");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function cacheWriteFromRaw(raw: unknown): number | undefined {
  const payload = object(raw);
  if (!payload) return undefined;
  const direct = [
    payload.cache_creation_input_tokens,
    payload.inputCacheCreation,
    payload.cacheWrite,
    payload.tokens_cache_write,
  ].map(nonNegativeNumber).find((value) => value !== undefined);
  if (direct !== undefined) return direct;
  return nonNegativeNumber(object(payload.cache)?.write);
}

function enrichedEvents(events: readonly ParsedUsageEvent[]): ParsedUsageEvent[] {
  return events.map((event) => {
    const raw = object(event.raw);
    const anthropicInput = nonNegativeNumber(raw?.input_tokens);
    const anthropicRead = nonNegativeNumber(raw?.cache_read_input_tokens);
    const anthropicWrite = nonNegativeNumber(raw?.cache_creation_input_tokens);
    if (
      anthropicInput !== undefined &&
      (anthropicRead !== undefined || anthropicWrite !== undefined)
    ) {
      return {
        ...event,
        inputTokens: anthropicInput + (anthropicRead ?? 0) + (anthropicWrite ?? 0),
        cachedInputTokens: anthropicRead ?? 0,
        cacheWriteInputTokens: anthropicWrite ?? 0,
      };
    }
    if (event.cacheWriteInputTokens !== undefined) return event;
    const cacheWriteInputTokens = cacheWriteFromRaw(event.raw);
    return cacheWriteInputTokens === undefined
      ? event
      : { ...event, cacheWriteInputTokens };
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = object(value);
  if (record) {
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function currentRevisionIds(db: Surreal): Promise<Set<string>> {
  const rows = await selectAll<{ current_revision: unknown }>(
    db,
    "SELECT current_revision FROM dialogue WHERE current_revision != NONE",
  );
  return new Set(rows.map((row) => String(row.current_revision)));
}

async function writeBatch(
  db: Surreal,
  updates: Array<{ id: unknown; usage: Record<string, unknown> }>,
): Promise<void> {
  if (updates.length === 0) return;
  const vars: Record<string, unknown> = {};
  const statements = ["BEGIN;"];
  for (const [index, update] of updates.entries()) {
    vars[`id${index}`] = update.id;
    vars[`usage${index}`] = update.usage;
    statements.push(`UPDATE $id${index} SET usage = $usage${index} RETURN NONE;`);
  }
  statements.push("COMMIT;");
  await db.query(statements.join("\n"), vars);
}

async function main(): Promise<void> {
  const options = parseOptions();
  const cfg = loadConfig();
  const release = await acquireLock(
    cfg.archiveRoot,
    options.dryRun ? "usage breakdown backfill --dry-run" : "usage breakdown backfill",
  );
  let db: Surreal | undefined;
  try {
    db = await connectDb(cfg);
    const current = await currentRevisionIds(db);
    const summary = {
      dryRun: options.dryRun,
      currentRevisions: current.size,
      rowsScanned: 0,
      currentUsageRows: 0,
      rowsUpdated: 0,
      rowsWithCacheWrite: 0,
      rowsWithoutRawUsage: 0,
      invalidBreakdownRows: 0,
    };
    let after: unknown | undefined;
    let pending: Array<{ id: unknown; usage: Record<string, unknown> }> = [];
    for (;;) {
      const rows = await selectAll<MessageUsageRow>(
        db,
        `SELECT id, dialogue_revision, \`usage\` AS usage, raw_usage_events FROM message
         ${after === undefined ? "" : "WHERE id > $after"}
         ORDER BY id LIMIT $limit`,
        after === undefined ? { limit: PAGE_SIZE } : { after, limit: PAGE_SIZE },
      );
      if (rows.length === 0) break;
      after = rows.at(-1)!.id;
      summary.rowsScanned += rows.length;
      for (const row of rows) {
        if (!current.has(String(row.dialogue_revision)) || !row.usage) continue;
        summary.currentUsageRows += 1;
        const events = Array.isArray(row.raw_usage_events) ? enrichedEvents(row.raw_usage_events) : [];
        if (events.length === 0) {
          summary.rowsWithoutRawUsage += 1;
          continue;
        }
        const normalized = normalizeUsageEvents(events);
        if (!normalized) continue;
        const input = nonNegativeNumber(normalized.inputTokens) ?? 0;
        const read = nonNegativeNumber(normalized.cachedInputTokens) ?? 0;
        const write = nonNegativeNumber(normalized.cacheWriteInputTokens) ?? 0;
        if (read + write > input) summary.invalidBreakdownRows += 1;
        if (write > 0) summary.rowsWithCacheWrite += 1;
        if (stableJson(row.usage) === stableJson(normalized)) continue;
        summary.rowsUpdated += 1;
        if (!options.dryRun) {
          pending.push({ id: row.id, usage: normalized as unknown as Record<string, unknown> });
          if (pending.length >= WRITE_BATCH_SIZE) {
            await writeBatch(db, pending);
            pending = [];
          }
        }
      }
      console.error(JSON.stringify({ event: "usage_breakdown_backfill_progress", ...summary }));
    }
    if (!options.dryRun) await writeBatch(db, pending);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db?.close();
    await release();
  }
}

await main();
