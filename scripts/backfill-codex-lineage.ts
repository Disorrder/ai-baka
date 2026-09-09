#!/usr/bin/env bun
import { RecordId, type Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { checkSchemaVersion } from "../src/db/migrations.ts";
import { acquireLock } from "../src/infra/lock.ts";
import { analyzeCodexLineage } from "./analyze-codex-lineage.ts";

function revisionId(value: unknown): RecordId {
  const text = String(value);
  const prefix = "dialogue_revision:";
  if (!text.startsWith(prefix)) throw new Error(`invalid dialogue revision: ${text}`);
  return new RecordId("dialogue_revision", text.slice(prefix.length));
}

async function updateLineage(db: Surreal, row: Record<string, unknown>): Promise<void> {
  await db.query(
    `UPDATE ONLY $revision SET
       parent_source_dialogue_id = $parent,
       agent_depth = $depth,
       agent_nickname = $nickname,
       agent_role = $role
     RETURN NONE`,
    {
      revision: revisionId(row.revision),
      parent: row.parentId,
      depth: row.depth ?? undefined,
      nickname: row.nickname ?? undefined,
      role: row.role ?? undefined,
    },
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const release = await acquireLock(cfg.archiveRoot, "codex lineage backfill");
  let db: Surreal | undefined;
  try {
    db = await connectDb(cfg);
    const schemaVersion = await checkSchemaVersion(db);
    if (schemaVersion !== 1) throw new Error(`schema version ${schemaVersion} does not have lineage fields`);
    const lineage = await analyzeCodexLineage(db, cfg.archiveRoot);
    let updated = 0;
    for (const row of lineage.details) {
      await updateLineage(db, row);
      updated += 1;
    }
    console.log(JSON.stringify({ updated, totals: lineage.totals }, null, 2));
  } finally {
    await db?.close();
    await release();
  }
}

await main();
