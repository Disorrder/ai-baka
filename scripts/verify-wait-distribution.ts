import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  // Per-turn waits (human-authored only, current revisions only), bucketed.
  const [rows] = await db.query<Array<{ waitMs: number }>>(
    `SELECT dialogue_revision, response_turn_id, math::max(response_wait_ms) AS waitMs
     FROM message
     WHERE response_wait_ms > 0 AND human_authored = true
       AND dialogue_revision INSIDE (SELECT VALUE current_revision FROM dialogue WHERE current_revision != NONE)
     GROUP BY dialogue_revision, response_turn_id`,
  );
  const buckets: Array<[string, number, number]> = []; // label, ms threshold, sum
  const edges: Array<[string, number]> = [
    ["< 10 мин", 10 * 60_000],
    ["10–60 мин", 60 * 60_000],
    ["1–3 ч", 3 * 3600_000],
    ["3–8 ч", 8 * 3600_000],
    ["8–24 ч", 24 * 3600_000],
    ["> 24 ч", Infinity],
  ];
  const sums = new Map<string, { turns: number; ms: number }>();
  let total = 0;
  for (const { waitMs } of rows) {
    total += waitMs;
    const label = edges.find(([, e]) => waitMs < e)![0];
    const cur = sums.get(label) ?? { turns: 0, ms: 0 };
    cur.turns += 1;
    cur.ms += waitMs;
    sums.set(label, cur);
  }
  console.log(`turns: ${rows.length}, total wait: ${(total / 3600000).toFixed(1)} h`);
  for (const [label] of edges) {
    const cur = sums.get(label);
    if (!cur) continue;
    console.log(`${label.padEnd(10)} turns=${String(cur.turns).padStart(5)} wait=${(cur.ms / 3600000).toFixed(1).padStart(7)} h (${((100 * cur.ms) / total).toFixed(1)}%)`);
  }
  const over3h = [...sums.entries()].filter(([l]) => l === "3–8 ч" || l === "8–24 ч" || l === "> 24 ч").reduce((s, [, c]) => s + c.ms, 0);
  console.log(`\nwait from turns > 3h: ${(over3h / 3600000).toFixed(1)} h (${((100 * over3h) / total).toFixed(1)}% of exact wait)`);
} finally {
  await db.close();
}
process.exit(0);
