import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";

// Quantify token_count duplication across ALL current codex dialogues:
// codex emits one token_count per rate_limits bucket with identical `info`;
// real usage per API call = the shared info, not the sum over buckets.

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  const rows = await selectAll<{ external_id?: string; rawPath?: string }>(
    db,
    `SELECT id, external_id, current_revision.source_revision.raw_archive_path AS rawPath
     FROM dialogue
     WHERE current_revision.parser_name = "codex"
       AND current_revision.source_revision.raw_archive_path IS NOT NONE
     ORDER BY id`,
  );
  console.error(`codex dialogues with raw: ${rows.length}`);

  let scanned = 0;
  let dupSessions = 0;
  let cleanSessions = 0;
  let failed = 0;
  let inflatedTokens = 0;
  let realTokens = 0;
  const worst: Array<{ id: string; ratio: number; sum: number; cum: number; buckets: number }> = [];
  for (const row of rows) {
    if (!row.rawPath) continue;
    const file = `${cfg.archiveRoot}/${row.rawPath}`;
    let sumLast = 0;
    let maxCum = 0;
    const buckets = new Set<string>();
    try {
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.includes('"token_count"')) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (event.type !== "event_msg") continue;
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload?.type !== "token_count") continue;
        const info = payload.info as Record<string, unknown> | null | undefined;
        const rl = payload.rate_limits as Record<string, unknown> | undefined;
        if (typeof rl?.limit_id === "string") buckets.add(rl.limit_id);
        if (!info) continue;
        const last = info.last_token_usage as Record<string, unknown> | undefined;
        const total = info.total_token_usage as Record<string, unknown> | undefined;
        if (last) sumLast += (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
        if (total) maxCum = Math.max(maxCum, Number(total.total_tokens) || 0);
      }
    } catch {
      failed += 1;
      continue;
    }
    scanned += 1;
    realTokens += maxCum;
    if (maxCum > 0 && sumLast > maxCum * 1.2) {
      dupSessions += 1;
      inflatedTokens += sumLast - maxCum;
      worst.push({ id: (row.external_id ?? "?").slice(0, 8), ratio: sumLast / maxCum, sum: sumLast, cum: maxCum, buckets: buckets.size });
    } else {
      cleanSessions += 1;
      realTokens += 0; // maxCum already added above
    }
    if (scanned % 250 === 0) console.error(`scanned ${scanned}`);
  }
  worst.sort((a, b) => b.sum - b.cum - (a.sum - a.cum));
  console.log(JSON.stringify({
    scanned, dupSessions, cleanSessions, failed,
    inflatedTokens: Math.round(inflatedTokens),
    inflatedTokensB: Number((inflatedTokens / 1e9).toFixed(2)),
    dupShare: dupSessions / Math.max(1, scanned),
    topInflated: worst.slice(0, 10).map((w) => ({
      id: w.id, ratio: Number(w.ratio.toFixed(2)),
      sumM: Math.round(w.sum / 1e6), cumM: Math.round(w.cum / 1e6), buckets: w.buckets,
    })),
  }, null, 2));
} finally {
  await db.close();
}
process.exit(0);
