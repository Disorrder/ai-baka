import { afterAll, describe, expect } from "bun:test";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyMigrations,
  checkSchemaVersion,
  checksum,
  MigrationError,
  SCHEMA_DIR,
} from "../src/db/migrations.ts";
import type { ArchiveSentinel } from "../src/infra/sentinel.ts";
import { withTempDir } from "./config.test.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  TEST_NAMESPACE,
} from "./db-test-utils.ts";

// Явный skip в отчёте, если SurrealDB не поднят (вместо молчаливого return).
const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

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
  testDb("пустая база создаётся с нуля, archive_meta:main заполнен", async () => {
    const t = await createTestDb(false);
    try {
      const result = await applyMigrations(t.db, {
        sentinel: sentinelFor(t.name),
        bakaCommit: "test-commit",
        surrealdbVersion: "test-server",
      });
      expect(result.applied).toEqual([1, 2, 3, 4, 5]);
      expect(result.version).toBe(5);
      expect(await checkSchemaVersion(t.db)).toBe(5);

      const [rows] = await t.db.query<
        [Array<{ version: number; checksum: string; baka_commit: string }>]
      >("SELECT version, checksum, baka_commit FROM schema_migration ORDER BY version");
      expect(rows!.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
      const firstContent = await readFile(path.join(SCHEMA_DIR, "0001_initial.surql"), "utf8");
      expect(rows![0]!.checksum).toBe(checksum(firstContent));
      expect(rows![0]!.baka_commit).toBe("test-commit");

      const [meta] = await t.db.query<
        [Array<{ archive_uuid: string; schema_version: number; created_by_baka_commit: string }>]
      >("SELECT archive_uuid, schema_version, created_by_baka_commit FROM archive_meta:main");
      expect(meta).toHaveLength(1);
      expect(meta![0]!.archive_uuid).toBe("test-archive-uuid");
      expect(meta![0]!.schema_version).toBe(5);
      expect(meta![0]!.created_by_baka_commit).toBe("test-commit");

      const [info] = await t.db.query<
        [{ tables: Record<string, string>; analyzers: Record<string, string>; indexes: Record<string, string> }]
      >("INFO FOR DB");
      for (const table of ["dialogue", "message", "chunk", "search_document", "embedding_job", "legacy_identity_map", "migration_quarantine"]) {
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
      expect(chunkInfo!.indexes).not.toHaveProperty("chunk_content");
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("upgrade schema 4→5 удаляет только chunk_content index и сохраняет canonical chunks", async () => {
    const t = await createTestDb(false);
    try {
      await withTempDir(async (dir) => {
        const schemaDir = path.join(dir, "schema");
        await mkdir(schemaDir);
        for (const file of [
          "0001_initial.surql",
          "0002_search_documents.surql",
          "0003_embedding_spaces.surql",
          "0004_legacy_migration_metadata.surql",
        ]) {
          await copyFile(path.join(SCHEMA_DIR, file), path.join(schemaDir, file));
        }

        const before = await applyMigrations(t.db, {
          schemaDir,
          sentinel: sentinelFor(t.name),
          bakaCommit: "schema4",
          surrealdbVersion: "test-server",
        });
        expect(before.version).toBe(4);
        const [indexed] = await t.db.query<[{ indexes: Record<string, string> }]>(
          "INFO FOR TABLE chunk",
        );
        expect(indexed!.indexes).toHaveProperty("chunk_content");

        await t.db.query(`CREATE chunk:preserved SET
          dialogue = dialogue:preserved,
          dialogue_revision = dialogue_revision:preserved,
          message = message:preserved,
          sequence = 0,
          kind = "thought",
          role = "assistant",
          content = "canonical survives",
          content_sha256 = "${"a".repeat(64)}",
          content_bytes = 18`);

        await copyFile(
          path.join(SCHEMA_DIR, "0005_legacy_migration_run.surql"),
          path.join(schemaDir, "0005_legacy_migration_run.surql"),
        );
        const upgraded = await applyMigrations(t.db, {
          schemaDir,
          sentinel: sentinelFor(t.name),
          bakaCommit: "schema5",
          surrealdbVersion: "test-server",
        });
        expect(upgraded).toEqual({ applied: [5], version: 5 });
        const [withoutGlobalForensic] = await t.db.query<
          [{ indexes: Record<string, string> }]
        >("INFO FOR TABLE chunk");
        expect(withoutGlobalForensic!.indexes).not.toHaveProperty("chunk_content");
        const [preserved] = await t.db.query<[Array<{ content: string }>]>(
          "SELECT content FROM chunk:preserved",
        );
        expect(preserved).toEqual([{ content: "canonical survives" }]);
      });
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("повторное применение идемпотентно", async () => {
    const t = await createTestDb(false);
    try {
      await applyMigrations(t.db, { sentinel: sentinelFor(t.name), bakaCommit: "c", surrealdbVersion: "v" });
      const second = await applyMigrations(t.db, {
        sentinel: sentinelFor(t.name),
        bakaCommit: "c",
        surrealdbVersion: "v",
      });
      expect(second.applied).toEqual([]);
      expect(second.version).toBe(5);
      const [rows] = await t.db.query<[Array<{ version: number }>]>(
        "SELECT version FROM schema_migration",
      );
      expect(rows).toHaveLength(5);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("tampered-файл миграции детектируется", async () => {
    const t = await createTestDb(false);
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

  testDb("неизвестная более новая версия в БД отклоняется", async () => {
    const t = await createTestDb(false);
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
