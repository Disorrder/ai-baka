import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

const reportPath = process.argv[2];
if (!reportPath || process.argv.length !== 3) {
  throw new Error("usage: verify-outliers.ts <private-report-json>");
}

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  // Select outliers from an operator-provided private report.
  const data = JSON.parse(
    await Bun.file(reportPath).text(),
  ) as { sessionPoints: Array<{ dialogueId: string; timingQuality: string; totalTokens: number; activeMinutes: number }> };
  const targets = data.sessionPoints
    .filter((p) => p.timingQuality === "exact_turn_duration" && p.totalTokens > 50e6)
    .slice(0, 8);
  console.log(`exact_turn_duration outliers >50M: ${targets.length}`);

  for (const t of targets) {
    const [dlg] = await db.query<[Array<Record<string, unknown>>]>(
      `SELECT id, external_id, current_revision,
              current_revision.parent_source_dialogue_id AS parent,
              current_revision.agent_depth AS depth,
              current_revision.agent_nickname AS nick,
              current_revision.parser_name AS parser,
              source_revision AS sourceRevision,
              started_at, updated_at
       FROM ${t.dialogueId}`,
    );
    const d = dlg[0] as Record<string, unknown> | undefined;
    if (!d) {
      console.log(`${t.dialogueId}: NOT FOUND`);
      continue;
    }
    console.log(
      `\n${t.dialogueId.slice(9, 30)} ext=${String(d.external_id).slice(0, 13)} parent=${d.parent ?? "NONE"} depth=${d.depth ?? "-"} nick=${d.nick ?? "-"} srcRev=${String(d.sourceRevision ?? "NONE").slice(0, 60)}`,
    );
    // message timing/usage pattern
    const [stats] = await db.query<[Array<Record<string, unknown>>]>(
      `SELECT count() AS msgs,
              math::sum(\`usage\`.totalTokensNormalized ?? 0) AS tokens,
              time::min(timestamp) AS firstTs,
              time::max(timestamp) AS lastTs
       FROM message WHERE dialogue_revision = $rev GROUP ALL`,
      { rev: d.current_revision },
    );
    console.log(`  msgs=${stats[0]?.msgs} tokens=${((Number(stats[0]?.tokens) || 0) / 1e6).toFixed(0)}M first=${stats[0]?.firstTs} last=${stats[0]?.lastTs}`);
    const [durRows] = await db.query<[Array<{ d: number; role: string; ts: string }>]>(
      `SELECT metadata.durationMs AS d, role, timestamp AS ts FROM message
       WHERE dialogue_revision = $rev AND metadata.durationMs != NONE ORDER BY metadata.durationMs DESC LIMIT 5`,
      { rev: d.current_revision },
    );
    for (const r of durRows) console.log(`  durationMs=${r.d} role=${r.role} ts=${r.ts}`);
  }
} finally {
  await db.close();
}
process.exit(0);
