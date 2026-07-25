import { beforeAll, describe, expect, test } from "bun:test";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Surreal } from "surrealdb";
import {
  applyMigrations,
  checkSchemaVersion,
  checksum,
  MigrationError,
  SCHEMA_DIR,
} from "../src/db/migrations.ts";
import type { ArchiveSentinel } from "../src/infra/sentinel.ts";
import { withTempDir } from "./config.test.ts";

const SURREAL_URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8901/rpc";
const SURREAL_USER = process.env.SURREAL_USER ?? "root";
const SURREAL_PASS = process.env.SURREAL_PASS ?? "root";
const TEST_NAMESPACE = "baka_test";

let dbAvailable = false;

beforeAll(async () => {
  const probe = new Surreal();
  try {
    // connect к мёртвому URL может висеть дольше таймаута хука — ограничиваем сами
    await Promise.race([
      probe.connect(SURREAL_URL),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connect timeout")), 2000),
      ),
    ]);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  } finally {
    await probe.close().catch(() => {});
  }
});

function skipIfNoDb(): boolean {
  if (!dbAvailable) {
    console.warn("SKIP: SurrealDB недоступен (docker не поднят)");
    return true;
  }
  return false;
}

interface TestDb {
  db: Surreal;
  name: string;
}

async function createTestDb(): Promise<TestDb> {
  const db = new Surreal();
  await db.connect(SURREAL_URL);
  await db.signin({ username: SURREAL_USER, password: SURREAL_PASS });
  await db.use({ namespace: TEST_NAMESPACE });
  const name = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.query(`DEFINE DATABASE ${name}`);
  await db.use({ namespace: TEST_NAMESPACE, database: name });
  return { db, name };
}

async function dropTestDb(t: TestDb): Promise<void> {
  try {
    await t.db.use({ namespace: TEST_NAMESPACE });
    await t.db.query(`REMOVE DATABASE ${t.name}`);
  } finally {
    await t.db.close();
  }
}

function sentinelFor(dbName: string): ArchiveSentinel {
  return {
    archiveId: "test-archive-uuid",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    expectedNamespace: TEST_NAMESPACE,
    expectedDatabase: dbName,
  };
}

describe("migrations (integration, живой SurrealDB)", () => {
  test("пустая база создаётся с нуля, archive_meta:main заполнен", async () => {
    if (skipIfNoDb()) return;
    const t = await createTestDb();
    try {
      const result = await applyMigrations(t.db, {
        sentinel: sentinelFor(t.name),
        bakaCommit: "test-commit",
        surrealdbVersion: "test-server",
      });
      expect(result.applied).toEqual([1, 2, 3, 4]);
      expect(result.version).toBe(4);
      expect(await checkSchemaVersion(t.db)).toBe(4);

      const [rows] = await t.db.query<
        [Array<{ version: number; checksum: string; baka_commit: string }>]
      >("SELECT version, checksum, baka_commit FROM schema_migration ORDER BY version");
      expect(rows!.map((r) => r.version)).toEqual([1, 2, 3, 4]);
      const firstContent = await readFile(path.join(SCHEMA_DIR, "0001_initial.surql"), "utf8");
      expect(rows![0]!.checksum).toBe(checksum(firstContent));
      expect(rows![0]!.baka_commit).toBe("test-commit");

      const [meta] = await t.db.query<
        [Array<{ archive_uuid: string; schema_version: number; created_by_baka_commit: string }>]
      >("SELECT archive_uuid, schema_version, created_by_baka_commit FROM archive_meta:main");
      expect(meta).toHaveLength(1);
      expect(meta![0]!.archive_uuid).toBe("test-archive-uuid");
      expect(meta![0]!.schema_version).toBe(4);
      expect(meta![0]!.created_by_baka_commit).toBe("test-commit");

      const [info] = await t.db.query<
        [{ tables: Record<string, string>; analyzers: Record<string, string>; indexes: Record<string, string> }]
      >("INFO FOR DB");
      for (const table of ["dialogue", "message", "chunk", "search_document", "embedding_job", "legacy_identity_map"]) {
        expect(info!.tables).toHaveProperty(table);
      }
      expect(info!.analyzers).toHaveProperty("archive_mixed");
      // Индексы в SurrealDB per-table: INFO FOR DB их не возвращает
      const [sdInfo] = await t.db.query<[{ indexes: Record<string, string> }]>(
        "INFO FOR TABLE search_document",
      );
      expect(sdInfo!.indexes).toHaveProperty("search_document_content");
      const [chunkInfo] = await t.db.query<[{ indexes: Record<string, string> }]>(
        "INFO FOR TABLE chunk",
      );
      expect(chunkInfo!.indexes).toHaveProperty("chunk_content");
    } finally {
      await dropTestDb(t);
    }
  });

  test("повторное применение идемпотентно", async () => {
    if (skipIfNoDb()) return;
    const t = await createTestDb();
    try {
      await applyMigrations(t.db, { sentinel: sentinelFor(t.name), bakaCommit: "c", surrealdbVersion: "v" });
      const second = await applyMigrations(t.db, {
        sentinel: sentinelFor(t.name),
        bakaCommit: "c",
        surrealdbVersion: "v",
      });
      expect(second.applied).toEqual([]);
      expect(second.version).toBe(4);
      const [rows] = await t.db.query<[Array<{ version: number }>]>(
        "SELECT version FROM schema_migration",
      );
      expect(rows).toHaveLength(4);
    } finally {
      await dropTestDb(t);
    }
  });

  test("tampered-файл миграции детектируется", async () => {
    if (skipIfNoDb()) return;
    const t = await createTestDb();
    try {
      await withTempDir(async (dir) => {
        await cp(SCHEMA_DIR, dir, { recursive: true });
        await applyMigrations(t.db, { schemaDir: dir });
        // «Подделываем» уже применённый файл
        await writeFile(
          path.join(dir, "0002_search_documents.surql"),
          "-- комментарий, изменивший checksum\n",
          { flag: "a" },
        );
        expect(applyMigrations(t.db, { schemaDir: dir })).rejects.toThrow(MigrationError);
        expect(applyMigrations(t.db, { schemaDir: dir })).rejects.toThrow(/checksum/);
      });
    } finally {
      await dropTestDb(t);
    }
  });

  test("неизвестная более новая версия в БД отклоняется", async () => {
    if (skipIfNoDb()) return;
    const t = await createTestDb();
    try {
      await applyMigrations(t.db, { schemaDir: SCHEMA_DIR });
      await t.db.query(
        `CREATE schema_migration SET
          version = 99, name = "from_the_future", checksum = "x",
          applied_at = time::now(), baka_commit = "?", surrealdb_version = "?"`,
      );
      expect(applyMigrations(t.db, { schemaDir: SCHEMA_DIR })).rejects.toThrow(
        /новее всех известных/,
      );
    } finally {
      await dropTestDb(t);
    }
  });
});
