import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  // 1) Global: any response_turn_id shared across different dialogue revisions with wait>0?
  const [dupTurns] = await db.query<Array<{ turn: string; revisions: number; waitMs: number }>>(
    `SELECT response_turn_id AS turn,
            count() AS rows,
            array::distinct(dialogue_revision) AS revisions,
            math::sum(response_wait_ms) AS waitMs
     FROM message
     WHERE response_wait_ms > 0 AND response_turn_id != NONE
     GROUP BY response_turn_id`,
  );
  const shared = dupTurns.filter((r) => (r.revisions as unknown as unknown[]).length > 1);
  const sharedWait = shared.reduce((s, r) => s + (r.waitMs ?? 0), 0);
  console.log(`turns with wait>0: ${dupTurns.length}, shared across revisions: ${shared.length}, their summed wait: ${(sharedWait / 3600000).toFixed(2)} h`);

  // 2) Codex subagent dialogues (metadata.lineage present) — total wait vs parents
  const [subagentDlg] = await db.query<Array<{ id: string; current_revision: string; external_id: string }>>(
    `SELECT id, current_revision, external_id FROM dialogue
     WHERE current_revision != NONE AND metadata.lineage != NONE`,
  );
  console.log(`dialogues with lineage metadata: ${subagentDlg.length}`);
  let subWaitMs = 0;
  let subWithWait = 0;
  for (const d of subagentDlg) {
    const [rows] = await db.query<Array<{ w: number }>>(
      `SELECT math::sum(response_wait_ms) AS w FROM message WHERE dialogue_revision = $rev GROUP ALL`,
      { rev: d.current_revision },
    );
    const w = rows[0]?.w ?? 0;
    if (w > 0) subWithWait += 1;
    subWaitMs += w;
  }
  console.log(`subagent dialogues total response wait: ${(subWaitMs / 3600000).toFixed(2)} h (with wait: ${subWithWait})`);

  // 3) claude-code: dialogues sourced from subagents/ paths — check via source_file path
  const [ccPaths] = await db.query<Array<{ path: string; cnt: number }>>(
    `SELECT string::lower(path) AS path FROM source_file WHERE path CONTAINS "/subagents/" LIMIT 100000`,
  ).catch(() => [[] as Array<{ path: string; cnt: number }>]);
  console.log(`source_file rows with /subagents/ in path: ${Array.isArray(ccPaths) ? ccPaths.length : 0}`);
  if (Array.isArray(ccPaths) && ccPaths.length > 0) {
    for (const p of ccPaths.slice(0, 10)) console.log("  ", (p as unknown as { path: string }).path);
  }
} finally {
  await db.close();
}
process.exit(0);
