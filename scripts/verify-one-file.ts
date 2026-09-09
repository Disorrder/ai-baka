import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const FILE = process.argv[2];
if (!FILE || process.argv.length !== 3) {
  throw new Error("usage: verify-one-file.ts <raw-jsonl>");
}

const lines = createInterface({ input: createReadStream(FILE), crlfDelay: Infinity });
interface Ev { ts: string; lastIn: number; lastOut: number; cum: number }
const events: Ev[] = [];
let sessionMetas = 0;
for await (const line of lines) {
  if (line.includes('"session_meta"')) sessionMetas += 1;
  if (!line.includes('"token_count"')) continue;
  let event: Record<string, unknown>;
  try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
  if (event.type !== "event_msg") continue;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload?.type !== "token_count") continue;
  const info = payload.info as Record<string, unknown> | undefined;
  const last = info?.last_token_usage as Record<string, unknown> | undefined;
  const total = info?.total_token_usage as Record<string, unknown> | undefined;
  if (!last || !total) continue;
  events.push({
    ts: String(event.timestamp ?? "").slice(11, 19),
    lastIn: Number(last.input_tokens) || 0,
    lastOut: Number(last.output_tokens) || 0,
    cum: Number(total.total_tokens) || 0,
  });
}
console.log(`session_meta lines: ${sessionMetas}, token_count events: ${events.length}`);
console.log("\nfirst 12 events:");
for (const e of events.slice(0, 12)) console.log(`  ${e.ts} last=${((e.lastIn + e.lastOut) / 1e3).toFixed(1)}K cum=${(e.cum / 1e6).toFixed(2)}M`);
// find resets (cumulative drops)
let resets = 0;
for (let i = 1; i < events.length; i++) {
  if (events[i]!.cum < events[i - 1]!.cum * 0.5) {
    resets += 1;
    if (resets <= 6) {
      console.log(`\nRESET at event ${i} (${events[i]!.ts}): cum ${(events[i - 1]!.cum / 1e6).toFixed(1)}M -> ${(events[i]!.cum / 1e6).toFixed(2)}M`);
      for (let j = i; j < Math.min(i + 5, events.length); j++)
        console.log(`  ${events[j]!.ts} last=${((events[j]!.lastIn + events[j]!.lastOut) / 1e3).toFixed(1)}K cum=${(events[j]!.cum / 1e6).toFixed(2)}M`);
    }
  }
}
console.log(`\ntotal resets: ${resets}`);
// duplication check: how often does the same (lastIn,lastOut) vector repeat?
const seen = new Map<string, number>();
for (const e of events) {
  const k = `${e.lastIn}:${e.lastOut}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
const dupes = [...seen.values()].filter((c) => c > 1).reduce((s, c) => s + c - 1, 0);
console.log(`repeated identical usage vectors: ${dupes} of ${events.length}`);
// sum of last vs final cumulative per segment (between resets)
let segStart = 0;
let seg = 0;
for (let i = 1; i <= events.length; i++) {
  const isBoundary = i === events.length || events[i]!.cum < events[i - 1]!.cum * 0.5;
  if (!isBoundary) continue;
  const segEvents = events.slice(segStart, i);
  const sumLast = segEvents.reduce((s, e) => s + e.lastIn + e.lastOut, 0);
  const cumEnd = segEvents.at(-1)!.cum;
  console.log(`segment ${++seg}: events=${segEvents.length} sumLast=${(sumLast / 1e6).toFixed(0)}M cumEnd=${(cumEnd / 1e6).toFixed(0)}M ratio=${(sumLast / Math.max(1, cumEnd)).toFixed(2)}`);
  segStart = i;
}
