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
  manifestPathForExport,
} from "../src/backup/backup.ts";
import { compressFile, decompressFile, detectCompression } from "../src/backup/compress.ts";
import { verifyRawFiles, type RawManifest } from "../src/backup/raw-verify.ts";
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
  });

  test("manifestPathForExport для zst и gz", () => {
    for (const ext of ["zst", "gz"]) {
      const exportPath = `/archive/backups/surreal/ts__schema-4__surreal-3.2.3.surql.${ext}`;
      expect(manifestPathForExport(exportPath)).toBe(
        "/archive/backups/manifests/ts__schema-4__surreal-3.2.3.json",
      );
    }
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
