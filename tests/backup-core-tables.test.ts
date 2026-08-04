import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CORE_TABLES, coreTablesForSchemaVersion } from "../src/backup/backup.ts";
import { SCHEMA_DIR } from "../src/db/migrations.ts";

const SCHEMA_TABLE = /^DEFINE TABLE(?: IF NOT EXISTS)? ([a-z][a-z0-9_]*) SCHEMAFULL;/gmu;

async function durableSchemaTables(maxVersion: number): Promise<string[]> {
  const tables = new Set<string>();
  const files = (await readdir(SCHEMA_DIR)).filter((file) => file.endsWith(".surql"));
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (!Number.isSafeInteger(version) || version > maxVersion) continue;
    const schema = await readFile(path.join(SCHEMA_DIR, file), "utf8");
    for (const match of schema.matchAll(SCHEMA_TABLE)) tables.add(match[1]!);
  }

  // Bootstrap migration metadata is created by the migration runner rather
  // than a numbered .surql file. Dynamic search_embedding_* tables are added
  // separately by ownedEmbeddingTables(), so they do not belong in this set.
  tables.add("schema_migration");
  return [...tables].sort();
}

describe("backup core table coverage", () => {
  test("schemas 4–9 exactly cover their durable numbered-schema and bootstrap tables", async () => {
    expect(new Set(CORE_TABLES).size).toBe(CORE_TABLES.length);
    expect([...coreTablesForSchemaVersion(4)].sort()).toEqual(await durableSchemaTables(4));
    expect([...coreTablesForSchemaVersion(5)].sort()).toEqual(await durableSchemaTables(5));
    expect([...coreTablesForSchemaVersion(6)].sort()).toEqual(await durableSchemaTables(6));
    expect([...coreTablesForSchemaVersion(7)].sort()).toEqual(await durableSchemaTables(7));
    expect([...coreTablesForSchemaVersion(8)].sort()).toEqual(await durableSchemaTables(8));
    expect([...coreTablesForSchemaVersion(9)].sort()).toEqual(await durableSchemaTables(9));
  });
});
