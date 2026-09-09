import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const [PARENT, FIRST_CHILD, SECOND_CHILD] = process.argv.slice(2);
if (!PARENT || !FIRST_CHILD || !SECOND_CHILD || process.argv.length !== 5) {
  throw new Error("usage: verify-stream-compare.ts <parent-jsonl> <first-child-jsonl> <second-child-jsonl>");
}

interface U { input: number; cached: number; output: number; reasoning: number; total: number }

async function usage(file: string): Promise<U[]> {
  const result: U[] = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"token_count"') || !line.includes('"last_token_usage"')) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.type !== "event_msg") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload?.type !== "token_count") continue;
    const info = payload.info as Record<string, unknown> | undefined;
    const last = info?.last_token_usage as Record<string, unknown> | undefined;
    if (!last) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    result.push({
      input: num(last.input_tokens),
      cached: num(last.cached_input_tokens),
      output: num(last.output_tokens),
      reasoning: num(last.reasoning_output_tokens),
      total: num(last.total_tokens),
    });
  }
  return result;
}

function same(a: U, b: U): boolean {
  return a.input === b.input && a.cached === b.cached && a.output === b.output && a.reasoning === b.reasoning && a.total === b.total;
}

function lcp(a: U[], b: U[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && same(a[i]!, b[i]!)) i += 1;
  return i;
}

const [parent, firstChild, secondChild] = await Promise.all([usage(PARENT), usage(FIRST_CHILD), usage(SECOND_CHILD)]);
console.log(`parent events: ${parent.length}, first child: ${firstChild.length}, second child: ${secondChild.length}`);
const lcpM = lcp(firstChild, parent);
const lcpP = lcp(secondChild, parent);
console.log(`LCP first child vs parent: ${lcpM} (${((100 * lcpM) / firstChild.length).toFixed(1)}% of child)`);
console.log(`LCP second child vs parent: ${lcpP} (${((100 * lcpP) / secondChild.length).toFixed(1)}% of child)`);
if (lcpM < firstChild.length) {
  console.log("\nFirst child first divergence at", lcpM);
  for (let i = Math.max(0, lcpM - 2); i < Math.min(lcpM + 3, firstChild.length, parent.length); i++) {
    console.log(`  [${i}] child=${JSON.stringify(firstChild[i])}`);
    console.log(`       parent=${JSON.stringify(parent[i])}`);
  }
}
// Does the first child's prefix appear anywhere inside parent (not only at 0)?
const needle = firstChild.slice(0, Math.min(5, firstChild.length));
let foundAt = -1;
outer: for (let i = 0; i + needle.length <= parent.length; i++) {
  for (let j = 0; j < needle.length; j++) if (!same(needle[j]!, parent[i + j]!)) continue outer;
  foundAt = i;
  break;
}
console.log(`\nFirst child first 5 events found in parent at offset: ${foundAt}`);
// how far does the match extend from that offset?
if (foundAt >= 0) {
  let k = 0;
  while (foundAt + k < parent.length && k < firstChild.length && same(firstChild[k]!, parent[foundAt + k]!)) k += 1;
  console.log(`match length from offset ${foundAt}: ${k} events (${((100 * k) / firstChild.length).toFixed(1)}% of child)`);
}
const sum = (rows: U[]) => rows.reduce((s, r) => s + r.input + r.output, 0);
console.log(`\nchild total: ${(sum(firstChild) / 1e6).toFixed(0)}M, first-divergence prefix total: ${(sum(firstChild.slice(0, lcpM)) / 1e6).toFixed(0)}M`);
