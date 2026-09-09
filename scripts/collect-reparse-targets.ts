import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";

// Collect source_location ids of codex dialogues whose raw rollout has
// rate-limit bucket-duplicated token_count events (sum of last_token_usage
// exceeds final cumulative by >20%). Output: JSON list for targeted reparse.

const outputPath = process.argv[2];
if (!outputPath || process.argv.length !== 3) {
  throw new Error("usage: collect-reparse-targets.ts <private-output-json>");
}

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  const rows = await selectAll<{ external_id?: string; rawPath?: string; locationId?: string }>(
    db,
    `SELECT id, external_id,
            current_revision.source_revision.raw_archive_path AS rawPath,
            current_revision.source_revision.source_location AS locationId
     FROM dialogue
     WHERE current_revision.parser_name = "codex"
       AND current_revision.source_revision.raw_archive_path IS NOT NONE
     ORDER BY id`,
  );
  console.error(`codex dialogues: ${rows.length}`);
  const affected = new Map<string, { externalId: string; ratio: number }>();
  let scanned = 0;
  for (const row of rows) {
    if (!row.rawPath || !row.locationId) continue;
    let sumLast = 0;
    let maxCum = 0;
    try {
      const lines = createInterface({
        input: createReadStream(`${cfg.archiveRoot}/${row.rawPath}`),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.includes('"token_count"')) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (event.type !== "event_msg") continue;
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload?.type !== "token_count") continue;
        const info = payload.info as Record<string, unknown> | null | undefined;
        if (!info) continue;
        const last = info.last_token_usage as Record<string, unknown> | undefined;
        const total = info.total_token_usage as Record<string, unknown> | undefined;
        if (last) sumLast += (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
        if (total) maxCum = Math.max(maxCum, Number(total.total_tokens) || 0);
      }
    } catch {
      continue;
    }
    scanned += 1;
    if (maxCum > 0 && sumLast > maxCum * 1.2) {
      affected.set(String(row.locationId), {
        externalId: row.external_id ?? "",
        ratio: sumLast / maxCum,
      });
    }
    if (scanned % 500 === 0) console.error(`scanned ${scanned}, affected ${affected.size}`);
  }
  const out = [...affected.entries()].map(([location, info]) => ({ location, ...info }));
  await writeFile(outputPath, JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(`affected locations: ${out.length} -> ${outputPath}`);
} finally {
  await db.close();
}
process.exit(0);
