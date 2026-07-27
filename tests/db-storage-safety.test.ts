import { describe, expect, test } from "bun:test";
import type { StatsFs } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import {
  assertDbRootLexicallySeparate,
  assertProductionDbStorageSafety,
  configuredRecoveryDbRoot,
  DbStorageSafetyError,
  parseMacDiskutilEvidence,
  type DbStorageSafetyDependencies,
} from "../src/db/storage-safety.ts";

async function withTempDir(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "baka-storage-safety-")));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeStatfs(type: number | bigint): typeof statfs {
  return (async () => ({ type } as StatsFs)) as unknown as typeof statfs;
}

function linuxDependencies(type: number | bigint): Partial<DbStorageSafetyDependencies> {
  return {
    platform: "linux",
    statfs: fakeStatfs(type),
  };
}

function diskutilPlist(internal: boolean, filesystemType: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>FilesystemType</key><string>${filesystemType}</string>
<key>Internal</key><${internal ? "true" : "false"}/>
</dict></plist>`;
}

describe("production DB storage safety", () => {
  test("lexically rejects archive/db equality, descendants and ancestors", () => {
    const archive = "/Volumes/Archive/Conversations";
    expect(() => assertDbRootLexicallySeparate(archive, `${archive}/db`))
      .toThrow(DbStorageSafetyError);
    expect(() => assertDbRootLexicallySeparate(archive, `${archive}/db/new`))
      .toThrow(DbStorageSafetyError);
    expect(() => assertDbRootLexicallySeparate(archive, archive))
      .toThrow(DbStorageSafetyError);
    expect(assertDbRootLexicallySeparate(archive, "/Users/test/internal/rocksdb").dbRoot)
      .toBe("/Users/test/internal/rocksdb");
  });

  test("loadConfig applies the lexical archive/db guard to the effective root", () => {
    expect(() => loadConfig({
      BAKA_ARCHIVE_ROOT: "/safe/archive",
      BAKA_DB_ROOT: "/safe",
    })).toThrow(ConfigError);
  });

  test("recovery explicit root must normalize to effective cfg.dbRoot", () => {
    const effective = "/Users/test/Library/Application Support/ai-baka/rocksdb";
    expect(configuredRecoveryDbRoot(effective, undefined)).toBe(effective);
    expect(configuredRecoveryDbRoot(effective, `${effective}/../rocksdb`)).toBe(effective);
    expect(() => configuredRecoveryDbRoot(effective, "/Volumes/Internal/other"))
      .toThrow(/совпадать/);
    expect(() => configuredRecoveryDbRoot(effective, "  ")).toThrow(/совпадать/);
  });

  test("uses the nearest existing real parent without creating the DB root", async () => {
    await withTempDir(async (root) => {
      const parent = path.join(root, "internal");
      const dbRoot = path.join(parent, "future", "rocksdb");
      await mkdir(parent);
      let statfsTarget = "";
      const evidence = await assertProductionDbStorageSafety(
        { archiveRoot: path.join(root, "archive"), dbRoot },
        {
          ...linuxDependencies(0xef53),
          statfs: (async (target: Parameters<typeof statfs>[0]) => {
            statfsTarget = String(target);
            return { type: 0xef53 } as StatsFs;
          }) as unknown as typeof statfs,
        },
      );
      expect(evidence.checkedPath).toBe(parent);
      expect(evidence.filesystem).toBe("ext2/3/4");
      expect(statfsTarget).toBe(parent);
      await expect(lstat(dbRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("rejects an existing symlink, a symlinked parent and a non-directory", async () => {
    await withTempDir(async (root) => {
      const real = path.join(root, "real");
      const linked = path.join(root, "linked");
      const file = path.join(root, "file");
      await mkdir(real);
      await symlink(real, linked);
      await writeFile(file, "not a directory");
      const archiveRoot = path.join(root, "archive");

      await expect(assertProductionDbStorageSafety(
        { archiveRoot, dbRoot: linked },
        linuxDependencies(0xef53),
      )).rejects.toMatchObject({ code: "path_is_symlink" });
      await expect(assertProductionDbStorageSafety(
        { archiveRoot, dbRoot: path.join(linked, "missing") },
        linuxDependencies(0xef53),
      )).rejects.toMatchObject({ code: "path_is_symlink" });
      await expect(assertProductionDbStorageSafety(
        { archiveRoot, dbRoot: file },
        linuxDependencies(0xef53),
      )).rejects.toMatchObject({ code: "path_is_not_directory" });
    });
  });

  test("Linux accepts only the local POSIX filesystem allowlist", async () => {
    await withTempDir(async (root) => {
      const config = {
        archiveRoot: path.join(root, "archive"),
        dbRoot: path.join(root, "rocksdb"),
      };
      for (const [type, name] of [
        [0xef53, "ext2/3/4"],
        [0x58465342, "xfs"],
        [0x9123683e, "btrfs"],
      ] as const) {
        expect((await assertProductionDbStorageSafety(
          config,
          linuxDependencies(type),
        )).filesystem).toBe(name);
      }
      for (const type of [0x2011bab0, 0x794c7630, 0x6969]) { // ExFAT, overlayfs, NFS
        await expect(assertProductionDbStorageSafety(
          config,
          linuxDependencies(type),
        )).rejects.toMatchObject({ code: "unsupported_filesystem" });
      }
    });
  });

  test("macOS requires read-only diskutil Internal=true and APFS evidence", async () => {
    await withTempDir(async (root) => {
      const config = {
        archiveRoot: path.join(root, "archive"),
        dbRoot: path.join(root, "rocksdb"),
      };
      let checkedPath = "";
      const mac = (plist: string): Partial<DbStorageSafetyDependencies> => ({
        platform: "darwin",
        macDiskutilInfo: async (target) => {
          checkedPath = target;
          return plist;
        },
      });
      const evidence = await assertProductionDbStorageSafety(
        config,
        mac(diskutilPlist(true, "apfs")),
      );
      expect(evidence.filesystem).toBe("apfs");
      expect(checkedPath).toBe(root);

      await expect(assertProductionDbStorageSafety(
        config,
        mac(diskutilPlist(false, "apfs")),
      )).rejects.toMatchObject({ code: "diskutil_not_internal" });
      await expect(assertProductionDbStorageSafety(
        config,
        mac(diskutilPlist(true, "exfat")),
      )).rejects.toMatchObject({ code: "diskutil_not_apfs" });
    });
  });

  test("diskutil parser fails closed when either required fact is absent", () => {
    expect(parseMacDiskutilEvidence(diskutilPlist(true, "APFS"))).toEqual({
      internal: true,
      filesystemType: "apfs",
    });
    expect(() => parseMacDiskutilEvidence(
      "<plist><dict><key>FilesystemType</key><string>apfs</string></dict></plist>",
    )).toThrow(/Internal\/FilesystemType/);
  });
});
