import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

// Verify whether codex subagent child dialogues double-count parent response wait:
// shared response_turn_id between child and parent revisions with positive wait in both.

interface MsgRow {
  responseTurnId?: string;
  responseWaitMs?: number;
  role?: string;
  timestamp?: string;
}

const data = JSON.parse(
  await Bun.file(new URL("../reports/model-efficiency-2026-08-03/data.json", import.meta.url).pathname).text(),
) as { lineage: { largestReplays: Array<{ childId: string; parentId: string; nickname?: string; replayShare?: number }> } };

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  let totalSharedWaitMs = 0;
  let totalOwnWaitMs = 0;
  let pairsChecked = 0;
  for (const row of data.lineage.largestReplays) {
    const [childDlg] = await db.query<Array<{ id: string; current_revision: string }>>(
      `SELECT id, current_revision FROM dialogue WHERE external_id = $eid LIMIT 1`,
      { eid: row.childId },
    );
    const [parentDlg] = await db.query<Array<{ id: string; current_revision: string }>>(
      `SELECT id, current_revision FROM dialogue WHERE external_id = $eid LIMIT 1`,
      { eid: row.parentId },
    );
    const child = childDlg[0];
    const parent = parentDlg[0];
    if (!child || !parent) {
      console.log(`skip ${row.nickname}: child=${!!child} parent=${!!parent}`);
      continue;
    }
    const [childMsgs] = await db.query<MsgRow[]>(
      `SELECT response_turn_id AS responseTurnId, response_wait_ms AS responseWaitMs FROM message WHERE dialogue_revision = $rev AND response_wait_ms > 0`,
      { rev: child.current_revision },
    );
    const [parentMsgs] = await db.query<MsgRow[]>(
      `SELECT response_turn_id AS responseTurnId, response_wait_ms AS responseWaitMs FROM message WHERE dialogue_revision = $rev AND response_wait_ms > 0`,
      { rev: parent.current_revision },
    );
    const parentWaits = new Map<string, number>();
    for (const m of parentMsgs) {
      if (m.responseTurnId) parentWaits.set(m.responseTurnId, Math.max(parentWaits.get(m.responseTurnId) ?? 0, m.responseWaitMs ?? 0));
    }
    const childTurns = new Map<string, number>();
    for (const m of childMsgs) {
      if (m.responseTurnId) childTurns.set(m.responseTurnId, Math.max(childTurns.get(m.responseTurnId) ?? 0, m.responseWaitMs ?? 0));
    }
    let sharedWait = 0;
    let ownWait = 0;
    let sharedTurns = 0;
    for (const [turn, wait] of childTurns) {
      if (parentWaits.has(turn)) {
        sharedWait += wait;
        sharedTurns += 1;
      } else ownWait += wait;
    }
    totalSharedWaitMs += sharedWait;
    totalOwnWaitMs += ownWait;
    pairsChecked += 1;
    console.log(
      `${(row.nickname ?? "?").padEnd(12)} replayShare=${(row.replayShare ?? 0).toFixed(2)} ` +
        `child turns=${childTurns.size} sharedWithParent=${sharedTurns} ` +
        `sharedWait=${(sharedWait / 3600000).toFixed(2)}h ownWait=${(ownWait / 3600000).toFixed(2)}h`,
    );
  }
  console.log(`\npairs checked: ${pairsChecked}`);
  console.log(`TOTAL shared (potentially double-counted) wait: ${(totalSharedWaitMs / 3600000).toFixed(2)} h`);
  console.log(`TOTAL own child wait: ${(totalOwnWaitMs / 3600000).toFixed(2)} h`);
} finally {
  await db.close();
}
process.exit(0);
