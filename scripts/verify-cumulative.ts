import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

// For class-B outlier sessions: sum(last_token_usage) should equal the final
// cumulative total_token_usage in the same file. If sum >> cumulative, events
// are duplicated/replayed inside one file.

const data = JSON.parse(await Bun.file("reports/model-efficiency-2026-08-03/data.json").text()) as {
  sessionPoints: Array<{ dialogueId: string; waitSource: string; tokensPerActiveHour: number; totalTokens: number; activeHours: number }>;
};
const targets = data.sessionPoints
  .filter((p) => p.waitSource === "exact_response_wait" && p.tokensPerActiveHour > 30e6)
  .sort((a, b) => b.totalTokens - a.totalTokens)
  .slice(0, 12);

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  for (const t of targets) {
    const [rows] = await db.query<Array<{ external_id: string; rawPath?: string }>>(
      `SELECT external_id, current_revision.source_revision.raw_archive_path AS rawPath FROM ${t.dialogueId}`,
    );
    const d = rows[0];
    if (!d?.rawPath) {
      console.log(`${t.dialogueId.slice(9, 30)}: no raw path`);
      continue;
    }
    const file = `${cfg.archiveRoot}/${d.rawPath}`;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let sumLast = 0;
    let maxCumulative = 0;
    let events = 0;
    for await (const line of lines) {
      if (!line.includes('"token_count"')) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (event.type !== "event_msg") continue;
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.type !== "token_count") continue;
      const info = payload.info as Record<string, unknown> | undefined;
      const last = info?.last_token_usage as Record<string, unknown> | undefined;
      const total = info?.total_token_usage as Record<string, unknown> | undefined;
      if (last) {
        events += 1;
        sumLast += (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
      }
      if (total) {
        const cum = Number(total.total_tokens) || 0;
        if (cum > maxCumulative) maxCumulative = cum;
      }
    }
    const ratio = maxCumulative > 0 ? sumLast / maxCumulative : NaN;
    console.log(
      `${(d.external_id ?? "?").slice(0, 8)} events=${String(events).padStart(5)} ` +
        `sumLast=${(sumLast / 1e6).toFixed(0).padStart(4)}M cumulative=${(maxCumulative / 1e6).toFixed(0).padStart(4)}M ` +
        `ratio=${ratio.toFixed(2)} reportTokens=${(t.totalTokens / 1e6).toFixed(0)}M active=${t.activeHours.toFixed(1)}h`,
    );
  }
} finally {
  await db.close();
}
process.exit(0);
