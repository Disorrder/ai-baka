import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

const IDS = process.argv.slice(2);
if (IDS.length === 0 || IDS.some((id) => !/^dlg_[a-zA-Z0-9_]+$/.test(id))) {
  throw new Error("usage: verify-parallel-sessions.ts <dlg_id> [dlg_id ...]");
}

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  for (const id of IDS) {
    const [rows] = await db.query<[Array<Record<string, unknown>>]>(
      `SELECT external_id,
              current_revision.source_revision.raw_archive_path AS rawPath,
              current_revision.parent_source_dialogue_id AS parent,
              current_revision.agent_nickname AS nick
       FROM dialogue:${id}`,
    );
    const d = rows[0];
    if (!d?.rawPath) { console.log(`${id.slice(0, 14)}: not found`); continue; }
    const file = `${cfg.archiveRoot}/${d.rawPath}`;
    let taskStarted = 0, taskCompleted = 0, taskAborted = 0;
    let explicitDurSum = 0, explicitDurCount = 0;
    let subAgentActivity = 0, interAgent = 0, turnAborted = 0;
    let firstTs = "", lastTs = "";
    const starts: number[] = [];
    let completedTimestamps: number[] = [];
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const ts = typeof event.timestamp === "string" ? event.timestamp : "";
      if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
      if (event.type !== "event_msg") continue;
      const payload = event.payload as Record<string, unknown> | undefined;
      switch (payload?.type) {
        case "task_started": taskStarted += 1; if (ts) starts.push(Date.parse(ts)); break;
        case "task_complete": {
          taskCompleted += 1;
          if (ts) completedTimestamps.push(Date.parse(ts));
          const dur = Number(payload.duration_ms);
          if (Number.isFinite(dur) && dur > 0) { explicitDurSum += dur; explicitDurCount += 1; }
          break;
        }
        case "turn_aborted": taskAborted += 1; break;
        case "sub_agent_activity": subAgentActivity += 1; break;
      }
      if (event.type === "event_msg" && payload?.type === "inter_agent_communication_metadata") interAgent += 1;
    }
    const wallH = (Date.parse(lastTs) - Date.parse(firstTs)) / 3600000;
    // overlap: max concurrent open tasks (starts sorted vs completes sorted)
    starts.sort((a, b) => a - b); completedTimestamps = completedTimestamps.sort((a, b) => a - b);
    let maxOpen = 0, open = 0, si = 0, ci = 0;
    while (si < starts.length) {
      if (ci < completedTimestamps.length && completedTimestamps[ci]! < starts[si]!) { open -= 1; ci += 1; }
      else { open += 1; si += 1; maxOpen = Math.max(maxOpen, open); }
    }
    console.log(
      `${id.slice(4, 14)} nick=${String(d.nick ?? "-").padEnd(10)} parent=${String(d.parent ?? "NONE").slice(0, 13)} ` +
        `tasks s/c/a=${taskStarted}/${taskCompleted}/${taskAborted} explicitDur=${(explicitDurSum / 3600000).toFixed(1)}h(${explicitDurCount}) ` +
        `wall=${wallH.toFixed(2)}h maxParallel=${maxOpen} subAgentEv=${subAgentActivity}`,
    );
  }
} finally {
  await db.close();
}
process.exit(0);
