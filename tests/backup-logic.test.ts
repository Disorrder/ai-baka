/**
 * Unit-тесты backup-модуля: именование export'ов, сжатие (roundtrip),
 * FS-сверка raw manifest'а. Без живой БД.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  backupTimestamp,
  exportBaseName,
  exportFileName,
  latestExportPath,
  manifestPathForExport,
} from "../src/backup/backup.ts";
import { compressFile, decompressFile, detectCompression } from "../src/backup/compress.ts";
import { hashRawManifest, verifyRawFiles, type RawManifest } from "../src/backup/raw-verify.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "baka-backup-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("backup naming", () => {
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

  test("latestExportPath игнорирует tmp .part (частичный export не «последний»)", async () => {
    await withTempDir(async (dir) => {
      const surreal = path.join(dir, "backups", "surreal");
      await mkdir(surreal, { recursive: true });
      const good = path.join(surreal, "2026-07-24T120000Z__schema-4__surreal-3.2.3.surql.zst");
      await writeFile(good, "x");
      // остаток аварийно прерванного backup'а с более поздним timestamp
      await writeFile(
        path.join(surreal, ".tmp-1-2026-07-25T120000Z__schema-4__surreal-3.2.3.surql.zst.part"),
        "partial",
      );
      expect(await latestExportPath(dir)).toBe(good);
    });
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
});
