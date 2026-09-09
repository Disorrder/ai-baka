import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { runReparse } from "../src/reparse.ts";

// Reparse codex subagent/fork dialogues with parser v9: inherited parent
// turn durations (replayed task_complete payloads) must not count.

const cfg = loadConfig();
const db = await connectDb(cfg);
let locations: string[];
try {
  const rows = await selectAll<{ locationId: string }>(
    db,
    `SELECT id, current_revision.source_revision.source_location AS locationId
     FROM dialogue
     WHERE current_revision != NONE
       AND current_revision.parent_source_dialogue_id != NONE
     ORDER BY id`,
  );
  locations = [...new Set(rows.map((r) => String(r.locationId)).filter((id) => id && id !== "NONE"))];
} finally {
  await db.close();
}
console.log(`subagent/fork locations: ${locations.length}`);

const summary = await runReparse(cfg, {
  selection: { sourceLocations: locations },
  onlyOutdated: true,
  enqueueEmbeddings: false,
  logger: (event) => {
    if (event.event === "reparse_unit" || event.event === "reparse_finished") {
      console.log(JSON.stringify(event));
    }
  },
});
console.log(JSON.stringify({ status: summary.status, counters: summary.counters }, null, 2));
for (const error of summary.errors.slice(0, 20)) console.log(`ERROR ${error}`);
process.exit(summary.status === "completed_with_errors" ? 1 : 0);
