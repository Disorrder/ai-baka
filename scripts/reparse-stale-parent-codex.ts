import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { runReparse } from "../src/reparse.ts";

// Reparse parent rollout files of codex dialogues whose current revision was
// parsed by parser v1/v2 from a subagent/fork file of ANOTHER session
// (v1/v2 took externalId from the LAST session_meta = replayed parent meta,
// so fork files landed under the parent dialogue; from v4 the identity moved
// to the child dialogue and the parent dialogue stayed stale at pv2).
// Reparsing the parent's own rollout (filename UUID == external_id) with
// parser v9 restores correct tokens, durations and bucket dedup.

const ROLLOUT_RE = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})__[^/]*\.jsonl$/;

const cfg = loadConfig();
const db = await connectDb(cfg);
let locations: string[];
try {
  const dialogues = await selectAll<Record<string, unknown>>(
    db,
    `SELECT id, external_id,
       current_revision.source_revision.raw_archive_path AS raw
     FROM dialogue WHERE current_revision.parser_name = "codex"`,
  );
  const staleExts: string[] = [];
  for (const d of dialogues) {
    const m = ROLLOUT_RE.exec(String(d.raw ?? ""));
    if (m && d.external_id && m[1] !== d.external_id) staleExts.push(String(d.external_id));
  }
  const revisions = await selectAll<Record<string, unknown>>(
    db,
    `SELECT id, raw_archive_path, source_location AS location
     FROM source_revision
     WHERE source_location.source_root.harness_installation.harness.slug = "codex"
       AND raw_archive_path IS NOT NONE
       AND id = source_location.current_revision`,
  );
  const byFileUuid = new Map<string, Array<Record<string, unknown>>>();
  for (const r of revisions) {
    const m = ROLLOUT_RE.exec(String(r.raw_archive_path ?? ""));
    if (!m) continue;
    const list = byFileUuid.get(m[1]!) ?? [];
    list.push(r);
    byFileUuid.set(m[1]!, list);
  }
  const found: string[] = [];
  const missing: string[] = [];
  for (const ext of staleExts) {
    const candidates = byFileUuid.get(ext) ?? [];
    const uniquePaths = [...new Set(candidates.map((c) => String(c.raw_archive_path)))];
    if (candidates.length === 0 || uniquePaths.length > 1) {
      missing.push(ext);
      continue;
    }
    found.push(String(candidates[0]!.location));
  }
  console.log(`stale fork-sourced dialogues: ${staleExts.length}, parent locations: ${found.length}, unresolved: ${missing.length}`);
  for (const ext of missing) console.log(`UNRESOLVED ${ext}`);
  locations = [...new Set(found)];
} finally {
  await db.close();
}
if (locations.length === 0) {
  console.log("nothing to reparse");
  process.exit(1);
}

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
for (const skipped of summary.skipped.slice(0, 20)) {
  console.log(`SKIP ${skipped.id}: ${skipped.reason}${skipped.detail ? ` (${skipped.detail})` : ""}`);
}
for (const error of summary.errors.slice(0, 20)) console.log(`ERROR ${error}`);
process.exit(summary.status === "completed_with_errors" ? 1 : 0);
