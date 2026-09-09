import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";

const [parentId, ...childIds] = process.argv.slice(2);
if (!parentId || childIds.length === 0) {
  throw new Error("usage: verify-parent-snapshots.ts <parent-external-id> <child-external-id> [...]");
}

const cfg = loadConfig();
const db = await connectDb(cfg);
try {
  // Resolve the explicitly selected parent and children by exact external ID.
  const [dlgRows] = await db.query<[Array<Record<string, unknown>>]>(
    `SELECT external_id,
            current_revision.source_revision.raw_archive_path AS rawPath,
            current_revision.source_revision AS srcRev
     FROM dialogue
     WHERE external_id IN $ids`,
    { ids: [parentId, ...childIds] },
  );
  console.log(JSON.stringify({ dlgRows }, null, 2));
  const parent = dlgRows.find((row) => row.external_id === parentId);
  if (typeof parent?.rawPath !== "string") {
    throw new Error("parent session has no raw snapshot");
  }

  // All source revisions (snapshots) of the parent's source location
  const [srcRevs] = await db.query<[Array<Record<string, unknown>>]>(
    `SELECT id, raw_archive_path, captured_at
     FROM source_revision
     WHERE source_location = (
       SELECT VALUE source_location FROM source_revision
       WHERE raw_archive_path = $p LIMIT 1
     )
     ORDER BY captured_at`,
    { p: parent.rawPath },
  );
  console.log(`parent snapshots: ${srcRevs.length}`);
  for (const r of srcRevs) console.log(`  ${r.captured_at} ${r.raw_archive_path}`);
} finally {
  await db.close();
}
process.exit(0);
