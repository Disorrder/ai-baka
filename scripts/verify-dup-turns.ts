import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  // Detail on the 2 shared turns
  const [dupTurns] = await db.query<Array<{ turn: string }>>(
    `SELECT response_turn_id AS turn, array::distinct(dialogue_revision) AS revisions
     FROM message WHERE response_wait_ms > 0 AND response_turn_id != NONE
     GROUP BY response_turn_id`,
  );
  for (const t of dupTurns) {
    const revs = t.revisions as unknown as string[];
    if (revs.length <= 1) continue;
    console.log(`\nturn ${t.turn}`);
    for (const rev of revs) {
      const [info] = await db.query<Array<{ dlg: string; waitMs: number; msgs: number; currentOf: unknown }>>(
        `SELECT dialogue AS dlg, math::sum(response_wait_ms) AS waitMs, count() AS msgs
         FROM message WHERE response_turn_id = $turn AND dialogue_revision = $rev AND response_wait_ms > 0 GROUP BY dialogue`,
        { turn: t.turn, rev },
      );
      const [revInfo] = await db.query<Array<{ id: string }>>(
        `SELECT id FROM dialogue WHERE current_revision = $rev`,
        { rev },
      );
      console.log(`  rev ${rev} -> dialogues: ${JSON.stringify(info)}, is current of: ${revInfo.map((r) => r.id).join(",") || "NONE (historical)"}`);
    }
  }

  // Subagent lineage: find where it lives
  const [revLineage] = await db.query<Array<{ id: string }>>(
    `SELECT id FROM dialogue_revision WHERE metadata.lineage != NONE LIMIT 5`,
  ).catch(() => [[]]);
  console.log(`\ndialogue_revision with metadata.lineage: ${Array.isArray(revLineage) ? revLineage.length : "query failed"}`);

  const [dlgMeta] = await db.query<Array<{ id: string; external_id: string; current_revision: string }>>(
    `SELECT id, external_id, current_revision FROM dialogue WHERE string::contains(string::concat(metadata), "lineage") LIMIT 5`,
  ).catch(() => [[]]);
  console.log(`dialogue metadata containing lineage: ${Array.isArray(dlgMeta) ? dlgMeta.length : "query failed"}`);
} finally {
  await db.close();
}
process.exit(0);
