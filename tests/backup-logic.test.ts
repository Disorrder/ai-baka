/**
 * Unit-тесты backup-модуля: именование export'ов, сжатие (roundtrip),
 * FS-сверка raw manifest'а. Без живой БД.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CORE_TABLES,
  SCHEMA_5_CORE_TABLES,
  backupTimestamp,
  coreTablesForSchemaVersion,
  exportBaseName,
  exportFileName,
  latestExportPath,
  manifestPathForExport,
  parseBackupManifest,
  recordCounts,
  validateRecordCountTables,
} from "../src/backup/backup.ts";
import { compressFile, decompressFile, detectCompression } from "../src/backup/compress.ts";
import {
  hashRawManifest,
  rawManifestFromRows,
  verifyRawFiles,
  type RawManifest,
  type RawManifestSourceRow,
} from "../src/backup/raw-verify.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import {
  publishPreparedFileNoClobber,
  writePrivateFileAtomicNoClobber,
} from "../src/backup/safety.ts";
import type { Surreal } from "surrealdb";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "baka-backup-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function discoveryManifest(exportFile: string, exportBytes: number, schemaVersion = 4) {
  return {
    createdAt: "2026-07-26T00:00:00.000Z",
    surrealdbVersion: "3.2.3",
    schemaVersion,
    bakaCommit: "anonymized-test",
    namespace: "baka_test",
    database: "archive_test",
    recordCounts: {},
    rawManifestSha256: "b".repeat(64),
    exportFile,
    compression: exportFile.endsWith(".zst") ? "zstd" : "gzip",
    exportBytes,
    exportSha256: "a".repeat(64),
  };
}

describe("backup naming", () => {
  test("таблицы backup строго зависят от версии схемы", () => {
    const schema4 = coreTablesForSchemaVersion(4);
    const schema5 = coreTablesForSchemaVersion(5);
    expect(SCHEMA_5_CORE_TABLES).toEqual([
      "migration_row_commit",
      "migration_quarantine",
    ]);
    expect(schema4).toEqual(
      CORE_TABLES.filter((table) => !SCHEMA_5_CORE_TABLES.includes(
        table as typeof SCHEMA_5_CORE_TABLES[number],
      )),
    );
    expect(schema5).toEqual(CORE_TABLES);
    expect(() => coreTablesForSchemaVersion(3)).toThrow(/неподдерживаемая версия схемы/);
    expect(() => coreTablesForSchemaVersion(6)).toThrow(/неподдерживаемая версия схемы/);
  });

  test("timestamp по формату §16.1", () => {
    expect(backupTimestamp(new Date("2026-07-24T12:00:00.000Z"))).toBe("2026-07-24T120000Z");
  });

  test("имя export'а и manifest'а", () => {
    const base = exportBaseName("2026-07-24T120000Z", 4, "3.2.3");
    expect(base).toBe("2026-07-24T120000Z__schema-4__surreal-3.2.3");
    expect(exportFileName(base, "zstd")).toBe(`${base}.surql.zst`);
    expect(exportFileName(base, "gzip")).toBe(`${base}.surql.gz`);
    // строка /version с build metadata нормализуется до semver
    expect(exportBaseName("2026-07-24T120000Z", 4, "surrealdb-3.2.3+20260721.40522d1")).toBe(base);
  });

  test("manifestPathForExport для zst и gz", () => {
    for (const ext of ["zst", "gz"]) {
      const exportPath = `/archive/backups/surreal/ts__schema-4__surreal-3.2.3.surql.${ext}`;
      expect(manifestPathForExport(exportPath)).toBe(
        "/archive/backups/manifests/ts__schema-4__surreal-3.2.3.json",
      );
    }
  });

  test("latestExportPath видит только committed export+manifest и игнорирует .part", async () => {
    await withTempDir(async (dir) => {
      const surreal = path.join(dir, "backups", "surreal");
      const manifests = path.join(dir, "backups", "manifests");
      await mkdir(surreal, { recursive: true });
      await mkdir(manifests, { recursive: true });
      const good = path.join(surreal, "2026-07-24T120000Z__schema-4__surreal-3.2.3.surql.zst");
      await writeFile(good, "x");
      await writeFile(
        manifestPathForExport(good),
        JSON.stringify(discoveryManifest(path.basename(good), 1)),
      );
      // остаток аварийно прерванного backup'а с более поздним timestamp
      await writeFile(
        path.join(surreal, ".tmp-1-2026-07-25T120000Z__schema-4__surreal-3.2.3.surql.zst.part"),
        "partial",
      );
      expect(await latestExportPath(dir)).toBe(good);
    });
  });

  test("latestExportPath пропускает export-only, malformed и mismatched manifests", async () => {
    await withTempDir(async (dir) => {
      const surreal = path.join(dir, "backups", "surreal");
      const manifests = path.join(dir, "backups", "manifests");
      await mkdir(surreal, { recursive: true });
      await mkdir(manifests, { recursive: true });
      const committed = path.join(
        surreal,
        "2026-07-24T120000Z__schema-4__surreal-3.2.3.surql.gz",
      );
      await writeFile(committed, "committed");
      await writeFile(
        manifestPathForExport(committed),
        JSON.stringify(discoveryManifest(path.basename(committed), 9)),
      );

      const exportOnly = path.join(
        surreal,
        "2026-07-25T120000Z__schema-4__surreal-3.2.3.surql.gz",
      );
      await writeFile(exportOnly, "partial");

      const malformed = path.join(
        surreal,
        "2026-07-26T120000Z__schema-4__surreal-3.2.3.surql.gz",
      );
      await writeFile(malformed, "complete-looking");
      await writeFile(manifestPathForExport(malformed), "{not-json");

      const mismatched = path.join(
        surreal,
        "2026-07-27T120000Z__schema-4__surreal-3.2.3.surql.gz",
      );
      await writeFile(mismatched, "same-size");
      await writeFile(
        manifestPathForExport(mismatched),
        JSON.stringify(discoveryManifest("another.surql.gz", 9)),
      );

      const sizedPartial = path.join(
        surreal,
        "2026-07-28T120000Z__schema-4__surreal-3.2.3.surql.gz",
      );
      await writeFile(sizedPartial, "partial");
      await writeFile(
        manifestPathForExport(sizedPartial),
        JSON.stringify(discoveryManifest(path.basename(sizedPartial), 5_875_000_000)),
      );

      expect(await latestExportPath(dir)).toBe(committed);
      await rm(manifestPathForExport(committed));
      await expect(latestExportPath(dir)).rejects.toThrow(/committed export\+manifest/);
    });
  });
});

describe("backup identifier and publication safety", () => {
  test("malicious physical_table is rejected before interpolation", async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT id, physical_table FROM embedding_space")) {
          return [[{
            id: "embedding_space:evil",
            physical_table: "search_embedding_ok; REMOVE NAMESPACE baka; --",
          }]];
        }
        return [[{ n: 0 }]];
      },
    } as unknown as Surreal;
    await expect(recordCounts(db, 5)).rejects.toThrow(/небезопасный внутренний идентификатор/);
    expect(queries.some((sql) => sql.includes("FROM search_embedding_ok;"))).toBe(false);
  });

  test("recordCounts schema 4 не запрашивает таблицы 0005, schema 5 запрашивает обе", async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT id, physical_table FROM embedding_space")) return [[]];
        return [[{ n: 0 }]];
      },
    } as unknown as Surreal;

    const schema4 = await recordCounts(db, 4);
    expect(Object.keys(schema4).sort()).toEqual([...coreTablesForSchemaVersion(4)].sort());
    expect(queries.some((sql) => sql.includes("FROM migration_row_commit"))).toBe(false);
    expect(queries.some((sql) => sql.includes("FROM migration_quarantine"))).toBe(false);

    queries.length = 0;
    const schema5 = await recordCounts(db, 5);
    expect(schema5.migration_row_commit).toBe(0);
    expect(schema5.migration_quarantine).toBe(0);
    expect(queries.some((sql) => sql.includes("FROM migration_row_commit"))).toBe(true);
    expect(queries.some((sql) => sql.includes("FROM migration_quarantine"))).toBe(true);
  });

  test("restore count contract rejects missing and cross-version tables", () => {
    const schema4 = Object.fromEntries(coreTablesForSchemaVersion(4).map((table) => [table, 0]));
    expect(validateRecordCountTables(schema4, new Set(), 4)).toHaveLength(
      coreTablesForSchemaVersion(4).length,
    );
    expect(() => validateRecordCountTables(
      { ...schema4, migration_quarantine: 0 },
      new Set(),
      4,
    )).toThrow(/неизвестную/);

    const incompleteSchema5 = Object.fromEntries(
      CORE_TABLES.filter((table) => table !== "migration_row_commit").map((table) => [table, 0]),
    );
    expect(() => validateRecordCountTables(incompleteSchema5, new Set(), 5))
      .toThrow(/migration_row_commit/);
    expect(() => validateRecordCountTables(schema4, new Set(), 6))
      .toThrow(/неподдерживаемая версия схемы/);
  });

  test("manifest recordCounts injection is rejected during parsing", () => {
    expect(() => parseBackupManifest({
      createdAt: "2026-07-26T00:00:00.000Z",
      surrealdbVersion: "3.2.3",
      schemaVersion: 5,
      bakaCommit: "test",
      namespace: "baka",
      database: "archive",
      recordCounts: { "dialogue; REMOVE NAMESPACE baka; --": 1 },
      exportFile: "backup.surql.gz",
      compression: "gzip",
      exportBytes: 1,
      exportSha256: "a".repeat(64),
    })).toThrow(/небезопасный внутренний идентификатор/);
  });

  test("manifest parser fail-closed для неизвестной схемы", () => {
    expect(() => parseBackupManifest({
      createdAt: "2026-07-26T00:00:00.000Z",
      surrealdbVersion: "3.2.3",
      schemaVersion: 6,
      bakaCommit: "test",
      namespace: "baka_test",
      database: "archive_test",
      recordCounts: {},
      exportFile: "backup.surql.gz",
      compression: "gzip",
      exportBytes: 1,
      exportSha256: "a".repeat(64),
    })).toThrow(/неподдерживаемая версия схемы/);
  });

  test("atomic writer defaults to no-clobber", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "manifest.json");
      await writePrivateFileAtomicNoClobber(target, "first\n");
      await expect(writePrivateFileAtomicNoClobber(target, "second\n"))
        .rejects.toThrow(/не будет перезаписан/);
      expect(await readFile(target, "utf8")).toBe("first\n");
    });
  });

  test("kernel no-replace admits exactly one concurrent private/prepared publisher", async () => {
    await withTempDir(async (dir) => {
      const privateTarget = path.join(dir, "private.json");
      const privateResults = await Promise.allSettled([
        writePrivateFileAtomicNoClobber(privateTarget, "one\n"),
        writePrivateFileAtomicNoClobber(privateTarget, "two\n"),
      ]);
      expect(privateResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(["one\n", "two\n"]).toContain(await readFile(privateTarget, "utf8"));

      const first = path.join(dir, ".first.part");
      const second = path.join(dir, ".second.part");
      const preparedTarget = path.join(dir, "export.surql.gz");
      await writeFile(first, "first");
      await writeFile(second, "second");
      const preparedResults = await Promise.allSettled([
        publishPreparedFileNoClobber(first, preparedTarget),
        publishPreparedFileNoClobber(second, preparedTarget),
      ]);
      expect(preparedResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(["first", "second"]).toContain(await readFile(preparedTarget, "utf8"));
    });
  });
});

describe("raw manifest: legacy_missing_raw (schema 0005)", () => {
  const base: RawManifestSourceRow = {
    id: "source_revision:with-raw",
    path: "raw/codex/a.jsonl",
    sha256: "a".repeat(64),
    sizeBytes: 10,
    harness: "codex",
    snapshotKind: "regular_copy",
  };

  test("намеренный NONE пропускается, физический raw остаётся", () => {
    const manifest = rawManifestFromRows(
      [
        {
          ...base,
          id: "source_revision:legacy-missing",
          path: null,
          snapshotKind: "legacy_missing_raw",
        },
        base,
      ],
      new Date("2026-07-26T00:00:00.000Z"),
    );
    expect(manifest.count).toBe(1);
    expect(manifest.entries.map((entry) => entry.revisionId)).toEqual([
      "source_revision:with-raw",
    ]);
  });

  test("NONE для любого другого snapshot_kind блокирует backup/restore", () => {
    expect(() =>
      rawManifestFromRows([
        { ...base, id: "source_revision:invalid", path: undefined },
      ]),
    ).toThrow(/raw_archive_path=NONE допустим только.*legacy_missing_raw/);
  });
});

describe("hashRawManifest (rawManifestSha256, §16.1)", () => {
  const entries: RawManifest["entries"] = [
    {
      revisionId: "source_revision:a",
      path: "raw/codex/a.jsonl",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      harness: "codex",
    },
    {
      revisionId: "source_revision:b",
      path: "raw/kimi/b.jsonl",
      sha256: "b".repeat(64),
      sizeBytes: 20,
      harness: null,
    },
  ];

  test("детерминирован; createdAt не влияет на hash", () => {
    const m1: RawManifest = { createdAt: "2026-07-24T00:00:00Z", count: 2, entries };
    const m2: RawManifest = { createdAt: "2026-07-25T00:00:00Z", count: 2, entries };
    const hash = hashRawManifest(m1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRawManifest(m2)).toBe(hash);
  });

  test("изменение любой записи меняет hash", () => {
    const base: RawManifest = { createdAt: "x", count: 2, entries };
    const changed: RawManifest = {
      createdAt: "x",
      count: 2,
      entries: [entries[0]!, { ...entries[1]!, sizeBytes: 21 }],
    };
    expect(hashRawManifest(changed)).not.toBe(hashRawManifest(base));
  });
});

describe("compress", () => {
  test("roundtrip zstd/gzip", async () => {
    await withTempDir(async (dir) => {
      const source = path.join(dir, "export.surql");
      await writeFile(source, "CREATE dialogue:test SET title = 'привет';\n".repeat(100));
      const kind = await detectCompression();
      const compressed = path.join(dir, `export.surql.${kind === "zstd" ? "zst" : "gz"}`);
      await compressFile(source, compressed, kind);
      const restored = path.join(dir, "restored.surql");
      await decompressFile(compressed, restored);
      expect(await readFile(restored, "utf8")).toBe(await readFile(source, "utf8"));
    });
  });
});

describe("verifyRawFiles", () => {
  async function makeEntry(
    root: string,
    relPath: string,
    content: string,
  ): Promise<RawManifest["entries"][number]> {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    const hashes = await hashFile(absolute);
    return {
      revisionId: `source_revision:test-${relPath}`,
      path: relPath,
      sha256: hashes.sha256,
      sizeBytes: hashes.sizeBytes,
      harness: "codex",
    };
  }

  test("ok: файлы совпадают по size и sha256", async () => {
    await withTempDir(async (dir) => {
      const entry = await makeEntry(dir, "raw/codex/a.jsonl", "hello");
      const report = await verifyRawFiles(dir, {
        createdAt: new Date().toISOString(),
        count: 1,
        entries: [entry],
      });
      expect(report.ok).toBe(true);
      expect(report.checked).toBe(1);
      expect(report.orphans).toEqual([]);
    });
  });

  test("missing / sizeMismatch / hashMismatch / orphan", async () => {
    await withTempDir(async (dir) => {
      const good = await makeEntry(dir, "raw/codex/good.jsonl", "good");
      const sized = await makeEntry(dir, "raw/codex/sized.jsonl", "12345");
      const hashed = await makeEntry(dir, "raw/codex/hashed.jsonl", "content");
      // orphan: файл на диске без записи в manifest'е
      await makeEntry(dir, "raw/codex/orphan.jsonl", "orphan");
      const report = await verifyRawFiles(dir, {
        createdAt: new Date().toISOString(),
        count: 4,
        entries: [
          good,
          { ...sized, sizeBytes: sized.sizeBytes + 1 },
          { ...hashed, sha256: "0".repeat(64) },
          { ...good, revisionId: "source_revision:gone", path: "raw/codex/gone.jsonl" },
        ],
      });
      expect(report.ok).toBe(false);
      expect(report.checked).toBe(1);
      expect(report.missing).toEqual(["raw/codex/gone.jsonl"]);
      expect(report.sizeMismatch).toHaveLength(1);
      expect(report.hashMismatch).toHaveLength(1);
      expect(report.orphans).toEqual(["raw/codex/orphan.jsonl"]);
    });
  });

  test("порядок проверок: size mismatch не доходит до hash", async () => {
    await withTempDir(async (dir) => {
      const entry = await makeEntry(dir, "raw/codex/a.jsonl", "data");
      const report = await verifyRawFiles(dir, {
        createdAt: new Date().toISOString(),
        count: 1,
        entries: [{ ...entry, sizeBytes: 999, sha256: "f".repeat(64) }],
      });
      expect(report.sizeMismatch).toHaveLength(1);
      expect(report.hashMismatch).toHaveLength(0);
    });
  });

  test("escape и symlink за пределы raw root отклоняются", async () => {
    await withTempDir(async (dir) => {
      const archive = path.join(dir, "archive");
      const raw = path.join(archive, "raw");
      await mkdir(raw, { recursive: true });
      const outside = path.join(dir, "outside.jsonl");
      await writeFile(outside, "private");
      const hashes = await hashFile(outside);
      await symlink(outside, path.join(raw, "linked.jsonl"));
      const report = await verifyRawFiles(archive, {
        createdAt: "2026-07-26T00:00:00.000Z",
        count: 2,
        entries: [
          {
            revisionId: "source_revision:escape",
            path: "raw/../../outside.jsonl",
            sha256: hashes.sha256,
            sizeBytes: hashes.sizeBytes,
            harness: "codex",
          },
          {
            revisionId: "source_revision:symlink",
            path: "raw/linked.jsonl",
            sha256: hashes.sha256,
            sizeBytes: hashes.sizeBytes,
            harness: "codex",
          },
        ],
      });
      expect(report.ok).toBe(false);
      expect(report.checked).toBe(0);
      expect(report.unsafe).toHaveLength(2);
    });
  });
});
