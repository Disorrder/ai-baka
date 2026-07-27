import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { latestExportPath, manifestPathForExport } from "../src/backup/backup.ts";
import {
  AtomicNoReplaceUnsupportedError,
  publishPreparedFileNoClobber,
  writePrivateFileAtomicNoClobber,
  type PublishPreparedFileOptions,
} from "../src/backup/safety.ts";

async function withTempDir(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "baka-publication-test-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const unsupportedAtomicRename: NonNullable<PublishPreparedFileOptions["atomicRename"]> =
  async () => {
    throw new AtomicNoReplaceUnsupportedError(45);
  };

describe("ExFAT-compatible no-clobber publication", () => {
  test("forced unsupported atomic path completes a bounded copy and removes its temp", async () => {
    await withTempDir(async (directory) => {
      const source = path.join(directory, ".large-export.part");
      const destination = path.join(directory, "large-export.surql.gz");
      const content = Buffer.alloc(3 * 1024 * 1024 + 137);
      for (let offset = 0; offset < content.length; offset += 1) content[offset] = offset % 251;
      await writeFile(source, content, { mode: 0o600 });
      const progress: number[] = [];

      await publishPreparedFileNoClobber(source, destination, {
        atomicRename: unsupportedAtomicRename,
        copyChunkBytes: 64 * 1024,
        afterCopyChunk: (copied) => { progress.push(copied); },
      });

      expect(progress.length).toBeGreaterThan(2);
      expect(Math.max(...progress)).toBe(content.byteLength);
      expect(await readFile(destination)).toEqual(content);
      expect((await lstat(destination)).mode & 0o777).toBe(0o600);
      expect(await lstat(source).catch(() => undefined)).toBeUndefined();
    });
  });

  test("forced fallback admits one racing publisher and never overwrites the winner", async () => {
    await withTempDir(async (directory) => {
      const first = path.join(directory, ".first.part");
      const second = path.join(directory, ".second.part");
      const destination = path.join(directory, "export.surql.gz");
      await writeFile(first, "first-publisher", { mode: 0o600 });
      await writeFile(second, "second-publisher", { mode: 0o600 });

      const results = await Promise.allSettled([
        publishPreparedFileNoClobber(first, destination, {
          atomicRename: unsupportedAtomicRename,
          copyChunkBytes: 4096,
        }),
        publishPreparedFileNoClobber(second, destination, {
          atomicRename: unsupportedAtomicRename,
          copyChunkBytes: 4096,
        }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(["first-publisher", "second-publisher"]).toContain(
        await readFile(destination, "utf8"),
      );
      const retainedSources = await Promise.all(
        [first, second].map((file) => lstat(file).then(() => true).catch(() => false)),
      );
      expect(retainedSources.filter(Boolean)).toHaveLength(1);
    });
  });

  test("mid-copy failure removes only its owned partial destination", async () => {
    await withTempDir(async (directory) => {
      const source = path.join(directory, ".source.part");
      const destination = path.join(directory, "export.surql.gz");
      const content = Buffer.alloc(256 * 1024, 0x5a);
      await writeFile(source, content, { mode: 0o600 });

      await expect(publishPreparedFileNoClobber(source, destination, {
        atomicRename: unsupportedAtomicRename,
        copyChunkBytes: 16 * 1024,
        afterCopyChunk: () => {
          throw new Error("injected mid-copy failure");
        },
      })).rejects.toThrow(/injected mid-copy failure/);

      expect(await lstat(destination).catch(() => undefined)).toBeUndefined();
      expect(await readFile(source)).toEqual(content);
    });
  });

  test("failure cleanup refuses to unlink a path replaced by a racer", async () => {
    await withTempDir(async (directory) => {
      const source = path.join(directory, ".source.part");
      const destination = path.join(directory, "export.surql.gz");
      const displaced = path.join(directory, ".displaced-owned-partial");
      await writeFile(source, Buffer.alloc(128 * 1024, 0x61), { mode: 0o600 });
      let replaced = false;

      await expect(publishPreparedFileNoClobber(source, destination, {
        atomicRename: unsupportedAtomicRename,
        copyChunkBytes: 16 * 1024,
        afterCopyChunk: async () => {
          if (replaced) return;
          replaced = true;
          await rename(destination, displaced);
          await writeFile(destination, "racer-owned", { flag: "wx", mode: 0o600 });
          throw new Error("injected replacement race");
        },
      })).rejects.toBeInstanceOf(AggregateError);

      expect(await readFile(destination, "utf8")).toBe("racer-owned");
      expect((await lstat(displaced)).isFile()).toBe(true);
      expect((await lstat(source)).isFile()).toBe(true);
    });
  });

  test("private manifest writer also accepts the unsupported atomic fallback", async () => {
    await withTempDir(async (directory) => {
      const manifest = path.join(directory, "backup.json");
      await writePrivateFileAtomicNoClobber(manifest, "{\"committed\":true}\n", {
        atomicRename: unsupportedAtomicRename,
        copyChunkBytes: 4096,
      });
      expect(await readFile(manifest, "utf8")).toBe("{\"committed\":true}\n");
      await expect(writePrivateFileAtomicNoClobber(manifest, "replacement", {
        atomicRename: unsupportedAtomicRename,
        copyChunkBytes: 4096,
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(manifest, "utf8")).toBe("{\"committed\":true}\n");
    });
  });

  test("complete fallback export becomes discoverable only after its fallback manifest commit", async () => {
    await withTempDir(async (archiveRoot) => {
      const surrealDir = path.join(archiveRoot, "backups", "surreal");
      const manifestsDir = path.join(archiveRoot, "backups", "manifests");
      await mkdir(surrealDir, { recursive: true });
      await mkdir(manifestsDir, { recursive: true });
      const exportFile = "2026-07-27T120000Z__schema-4__surreal-3.2.3.surql.gz";
      const exportPath = path.join(surrealDir, exportFile);
      const exportTemp = path.join(surrealDir, ".prepared-export.part");
      const content = Buffer.from("complete fallback export");
      await writeFile(exportTemp, content, { mode: 0o600 });

      await publishPreparedFileNoClobber(exportTemp, exportPath, {
        atomicRename: unsupportedAtomicRename,
        copyChunkBytes: 4096,
      });
      await expect(latestExportPath(archiveRoot)).rejects.toThrow(/committed export\+manifest/);

      const manifest = {
        createdAt: "2026-07-27T12:00:00.000Z",
        surrealdbVersion: "3.2.3",
        schemaVersion: 4,
        bakaCommit: "anonymized-test",
        namespace: "baka_test",
        database: "archive_test",
        recordCounts: {},
        rawManifestSha256: "b".repeat(64),
        exportFile,
        compression: "gzip",
        exportBytes: content.byteLength,
        exportSha256: "a".repeat(64),
      };
      await writePrivateFileAtomicNoClobber(
        manifestPathForExport(exportPath),
        `${JSON.stringify(manifest)}\n`,
        { atomicRename: unsupportedAtomicRename, copyChunkBytes: 4096 },
      );
      expect(await latestExportPath(archiveRoot)).toBe(exportPath);
    });
  });
});
