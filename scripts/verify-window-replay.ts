import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";

// Window matching: child prefix may match parent stream at ANY offset
// (codex subagent spawned late inherits the context tail, not full history).

interface U { input: number; cached: number; output: number; reasoning: number; total: number }
interface SessionMeta { id?: string; parentId?: string; nickname?: string }

function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }
function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

async function usage(file: string): Promise<U[]> {
  const result: U[] = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"token_count"') || !line.includes('"last_token_usage"')) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.type !== "event_msg") continue;
    const payload = obj(event.payload);
    if (payload?.type !== "token_count") continue;
    const last = obj(obj(payload.info)?.last_token_usage);
    if (!last) continue;
    result.push({
      input: num(last.input_tokens), cached: num(last.cached_input_tokens),
      output: num(last.output_tokens), reasoning: num(last.reasoning_output_tokens),
      total: num(last.total_tokens),
    });
  }
  return result;
}

async function meta(file: string): Promise<SessionMeta> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"session_meta"')) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== "session_meta") continue;
        const payload = obj(event.payload) ?? {};
        const spawn = obj(obj(obj(payload.source)?.subagent)?.thread_spawn);
        return {
          id: typeof payload.id === "string" ? payload.id : undefined,
          parentId: (typeof payload.forked_from_id === "string" ? payload.forked_from_id : undefined) ??
            (typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : undefined),
          nickname: typeof spawn?.agent_nickname === "string" ? spawn.agent_nickname : undefined,
        };
      } catch { continue; }
    }
  } finally { lines.close(); }
  return {};
}

function same(a: U, b: U): boolean {
  return a.input === b.input && a.cached === b.cached && a.output === b.output && a.reasoning === b.reasoning && a.total === b.total;
}

// Longest child prefix matching a contiguous run of parent starting at any offset.
// Returns { offset, length }. Requires length >= 3 to count as replay.
function windowMatch(child: U[], parent: U[]): { offset: number; length: number } {
  if (child.length === 0 || parent.length === 0) return { offset: -1, length: 0 };
  // Index parent positions by a cheap key for the first child event
  const first = child[0]!;
  let best = { offset: -1, length: 0 };
  for (let i = 0; i < parent.length; i++) {
    if (!same(first, parent[i]!)) continue;
    let k = 1;
    while (k < child.length && i + k < parent.length && same(child[k]!, parent[i + k]!)) k += 1;
    if (k > best.length) best = { offset: i, length: k };
    if (best.length >= child.length) break;
  }
  return best;
}

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  // Latest raw snapshot per codex session id (same logic as analyze-codex-lineage)
  const rows = await selectAll<{ raw_archive_path?: string; captured_at?: string }>(
    db,
    `SELECT id, raw_archive_path, captured_at FROM source_revision
     WHERE source_location.source_root.harness_installation.harness.slug = "codex"
       AND raw_archive_path IS NOT NONE
     ORDER BY captured_at DESC, id DESC`,
  );
  const seen = new Set<string>();
  const bySessionId = new Map<string, string>();
  for (const row of rows) {
    if (!row.raw_archive_path || seen.has(row.raw_archive_path)) continue;
    seen.add(row.raw_archive_path);
    const file = `${cfg.archiveRoot}/${row.raw_archive_path}`;
    const m = await meta(file);
    if (m.id && !bySessionId.has(m.id)) bySessionId.set(m.id, file);
  }
  console.error(`sessions indexed: ${bySessionId.size}`);

  const usageCache = new Map<string, Promise<U[]>>();
  const getUsage = (file: string): Promise<U[]> => {
    let p = usageCache.get(file);
    if (!p) { p = usage(file); usageCache.set(file, p); }
    return p;
  };

  const MIN_MATCH = 3;
  let children = 0;
  let prefixReplay = 0;
  let windowReplay = 0;
  let noReplay = 0;
  let windowReplayTokens = 0;
  let windowReplayEvents = 0;
  const samples: string[] = [];
  for (const [childId, childFile] of bySessionId) {
    const m = await meta(childFile);
    if (!m.parentId) continue;
    const parentFile = bySessionId.get(m.parentId);
    if (!parentFile) continue;
    children += 1;
    const [childU, parentU] = await Promise.all([getUsage(childFile), getUsage(parentFile)]);
    // strict prefix first
    let k = 0;
    while (k < Math.min(childU.length, parentU.length) && same(childU[k]!, parentU[k]!)) k += 1;
    if (k > 0) { prefixReplay += 1; continue; }
    const w = windowMatch(childU, parentU);
    if (w.length >= MIN_MATCH) {
      windowReplay += 1;
      const tokens = childU.slice(0, w.length).reduce((s, r) => s + r.input + r.output, 0);
      windowReplayTokens += tokens;
      windowReplayEvents += w.length;
      if (samples.length < 12) {
        samples.push(
          `${m.nickname ?? childId.slice(0, 8)} match=${w.length}/${childU.length} at parent offset ${w.offset} tokens=${(tokens / 1e6).toFixed(0)}M`,
        );
      }
    } else noReplay += 1;
    if (children % 25 === 0) console.error(`children processed: ${children}`);
  }
  console.log(JSON.stringify({
    children, prefixReplay, windowReplay, noReplay,
    windowReplayTokens, windowReplayEvents,
    samples,
  }, null, 2));
} finally {
  await db.close();
}
process.exit(0);
