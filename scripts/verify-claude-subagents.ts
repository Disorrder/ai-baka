import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  // claude-code subagent files in source_location
  const [locRows] = await db.query<Array<{ path: string; status?: string }>>(
    `SELECT path, latest_status AS status FROM source_location WHERE path CONTAINS "/subagents/"`,
  ).catch(async () => {
    const [fallback] = await db.query<Array<{ path: string }>>(
      `SELECT path FROM source_location LIMIT 3`,
    );
    console.log("sample source_location paths:", JSON.stringify(fallback));
    return [[] as Array<{ path: string; status?: string }>];
  });
  console.log(`source_location with /subagents/: ${locRows.length}`);
  const byRoot = new Map<string, number>();
  for (const r of locRows) {
    const root = r.path.split("/subagents/")[0] ?? "";
    byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
  }
  for (const [root, cnt] of [...byRoot.entries()].slice(0, 5)) console.log(`  ${cnt}x under ${root.slice(-80)}`);

  // Do their sessions become dialogues? claude-code subagent file sessionIds
  // Take a few subagent file paths, extract uuid filename, look up dialogue external_id
  const sample = locRows.slice(0, 20);
  let found = 0;
  for (const r of sample) {
    const file = r.path.split("/").pop() ?? "";
    const uuid = file.replace(/\.jsonl$/, "");
    const [dlg] = await db.query<Array<{ id: string; external_id: string }>>(
      `SELECT id, external_id FROM dialogue WHERE external_id = $eid LIMIT 1`,
      { eid: uuid },
    );
    if (dlg.length > 0) found += 1;
  }
  console.log(`sampled ${sample.length} subagent files -> dialogues found by filename uuid: ${found}`);

  // Sanity: verify the largest Codex session from its messages
  const [top] = await db.query<Array<{ dialogue: string; waitMs: number; msgs: number; turns: number }>>(
    `SELECT dialogue AS dialogue, math::sum(response_wait_ms) AS waitMs, count() AS msgs,
            array::len(array::distinct(response_turn_id)) AS turns
     FROM message WHERE response_wait_ms > 0 GROUP BY dialogue
     ORDER BY waitMs DESC LIMIT 5`,
  );
  for (const t of top) {
    console.log(`dlg ${t.dialogue} wait=${(t.waitMs / 3600000).toFixed(1)}h msgs=${t.msgs} turns=${t.turns} avgTurn=${(t.waitMs / 60000 / t.turns).toFixed(1)}min`);
  }
} finally {
  await db.close();
}
process.exit(0);
