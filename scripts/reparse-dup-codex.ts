import { loadConfig } from "../src/config.ts";
import { runReparse } from "../src/reparse.ts";

// Targeted reparse of codex sessions affected by rate-limit bucket
// token_count duplication. Targets collected privately by
// scripts/collect-reparse-targets.ts.

const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) {
  throw new Error("usage: reparse-dup-codex.ts <private-targets-json>");
}

const targets = JSON.parse(
  await Bun.file(inputPath).text(),
) as Array<{ location: string }>;
if (!Array.isArray(targets) || targets.length === 0 ||
    targets.some((target) => typeof target?.location !== "string" || !target.location.trim())) {
  throw new Error("reparse targets must be a non-empty array of source locations");
}

const cfg = loadConfig();
const summary = await runReparse(cfg, {
  selection: { sourceLocations: targets.map((t) => t.location) },
  onlyOutdated: true,
  enqueueEmbeddings: false,
  logger: (event) => console.log(JSON.stringify(event)),
});
console.log(JSON.stringify({ status: summary.status, counters: summary.counters }, null, 2));
for (const skipped of summary.skipped.slice(0, 20)) {
  console.log(`SKIP ${skipped.id}: ${skipped.reason}${skipped.detail ? ` (${skipped.detail})` : ""}`);
}
for (const error of summary.errors.slice(0, 20)) console.log(`ERROR ${error}`);
process.exit(summary.status === "completed_with_errors" ? 1 : 0);
