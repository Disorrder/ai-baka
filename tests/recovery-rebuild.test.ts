import { describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import type { BackupManifest } from "../src/backup/backup.ts";
import {
  authenticateRecoveryBackup,
  assertRecoveryStorageTopology,
  createFreshRecoveryTargetPaths,
  RECOVERY_MIN_AVAILABLE_BYTES,
  recoveryAvailableBytes,
  resolveRecoveryDbRoot,
  resolveRecoveryCurrentDbRoot,
  recoveryPaths,
  runRecoveryRebuild,
  type RecoveryBackupEvidence,
  type RecoveryRebuildDependencies,
} from "../src/backup/recovery-rebuild.ts";
import {
  RECOVERY_PINNED_IMAGE,
  type RecoveryTargetEvidence,
  type StoppedProductionEvidence,
} from "../src/backup/recovery-target.ts";
import type { RecoveryDatabaseVerification } from "../src/backup/recovery-verification.ts";
import { PINNED_RESTORE_TARGET_IMAGE_DIGEST } from "../src/backup/restore-test.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

const ATTEMPT = "1".repeat(32);
const EXPORT_SHA = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);

function config(archiveRoot: string): AppConfig {
  return {
    archiveRoot,
    dbRoot: path.join(path.dirname(archiveRoot), "configured-db"),
    surrealUrl: "ws://127.0.0.1:8901/rpc",
    surrealUser: "recovery-user",
    surrealPass: "not-in-argv",
    surrealNamespace: "baka",
    surrealDatabase: "archive",
  } as AppConfig;
}

function manifest(): BackupManifest {
  return {
    createdAt: "2026-07-27T00:01:50.000Z",
    surrealdbVersion: "surrealdb-3.2.4",
    schemaVersion: 1,
    bakaCommit: "test",
    namespace: "baka",
    database: "archive",
    recordCounts: { search_document: 2, chunk: 3 },
    rawManifestSha256: "c".repeat(64),
    exportFile: "2026-07-27T161832Z__schema-1__surreal-3.2.4.surql.zst",
    compression: "zstd",
    exportBytes: 123,
    exportSha256: EXPORT_SHA,
  };
}

function verification(): RecoveryDatabaseVerification {
  return {
    ok: true,
    schemaVersion: 1,
    recordCounts: manifest().recordCounts,
    rawManifestSha256: "c".repeat(64),
    rawFilesChecked: 1,
    rawOrphans: 0,
    searchSourceChunkOwnership: {
      documentsChecked: 2,
      referencesChecked: 3,
      valid: true,
    },
    searchProbes: [
      { name: "search: probe_1", ok: true, detail: "ok" },
      { name: "search: probe_2", ok: true, detail: "ok" },
      { name: "search probes", ok: true, detail: "2/2" },
    ],
    fulltext: {
      name: "search_document_content",
      table: "search_document",
      ready: true,
      chunkContentAbsent: true,
    },
  };
}

async function withTempDir(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "baka-recovery-rebuild-")),
  );
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function backupEvidence(exportPath: string): RecoveryBackupEvidence {
  return {
    exportPath,
    exportBytes: 123,
    exportSha256: EXPORT_SHA,
    sourceIdentity: {
      resolvedPath: exportPath,
      device: "1",
      inode: "1",
      sizeBytes: 123,
      mode: String(0o100600),
      sha256: EXPORT_SHA,
    },
    manifestPath: `${exportPath}.json`,
    manifestSha256: MANIFEST_SHA,
    manifest: manifest(),
  };
}

function dependencyFakes(
  archiveRoot: string,
  dbRoot: string,
  events: string[],
  attemptId = ATTEMPT,
): Partial<RecoveryRebuildDependencies> {
  const production = {
    id: "d".repeat(64),
    imageId: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
    corruptDbRoot: path.join(archiveRoot, "db"),
  } satisfies StoppedProductionEvidence;
  const target = {
    id: "e".repeat(64),
    name: `baka-recovery-stage-${attemptId}`,
    dbRoot,
    temporaryRoot: path.join(
      path.dirname(dbRoot),
      ".ai-baka-recovery",
      attemptId,
      "temp",
    ),
    image: RECOVERY_PINNED_IMAGE,
    hostPort: 8901 as const,
    anonymousVolumes: {
      data: "8".repeat(64),
      logs: "9".repeat(64),
    },
  } satisfies RecoveryTargetEvidence;
  return {
    randomToken: () => attemptId,
    now: () => new Date("2026-07-27T01:00:00.000Z"),
    acquireArchiveLock: async () => {
      events.push("lock");
      return async () => {
        events.push("release");
      };
    },
    authenticateBackup: async (_cfg, exportPath) => {
      events.push("authenticate");
      return backupEvidence(path.resolve(exportPath));
    },
    pinnedImage: async () => {
      events.push("pinned");
      return RECOVERY_PINNED_IMAGE;
    },
    inspectStoppedProduction: async () => {
      events.push("inspect-stopped-production");
      return production;
    },
    prepareAttemptPaths: async (paths) => {
      events.push("prepare-attempt-paths");
      await mkdir(paths.workRoot, { recursive: true });
      return {
        minimumAvailableBytes: RECOVERY_MIN_AVAILABLE_BYTES,
        availableBytesBefore: RECOVERY_MIN_AVAILABLE_BYTES + 1,
        sameInternalDevice: true,
        supportedPosixFilesystem: true,
      };
    },
    createFreshTargetPaths: async (paths) => {
      events.push("create-fresh-target-paths");
      await createFreshRecoveryTargetPaths(paths);
    },
    writeInitialJournal: async () => {
      events.push("journal-create");
    },
    updateJournal: async (_filePath, journal) => {
      events.push(`journal-update:${journal.status}`);
    },
    startTarget: async () => {
      const serverTemporaryRoot = path.join(target.temporaryRoot, "server");
      const serverTemporaryInfo = await lstat(serverTemporaryRoot);
      if (!serverTemporaryInfo.isDirectory() ||
          (serverTemporaryInfo.mode & 0o777) !== 0o700) {
        throw new Error("server temporary directory was not ready with mode 0700");
      }
      events.push("server-temp-ready");
      events.push("start-staging");
      return target;
    },
    prepareImport: async (_source, destination) => {
      events.push("prepare-import");
      await writeFile(destination, "OPTION IMPORT;\n-- ordered import\n", { mode: 0o600 });
      return [
        "DEFINE INDEX search_document_content ON TABLE search_document FIELDS content " +
          "FULLTEXT ANALYZER archive_mixed BM25 HIGHLIGHTS;",
      ];
    },
    upload: async () => {
      events.push("import");
    },
    buildIndex: async () => {
      events.push("build-core-index");
      return [{ name: "search_document_content", state: "ready" }];
    },
    verify: async () => {
      events.push("verify");
      return verification();
    },
    stopTarget: async () => {
      events.push("stop-staging");
      return { ...target, oomKilled: false, exitCode: 0 };
    },
    removeTarget: async (_target, force) => {
      events.push(force ? "remove-staging-force" : "remove-staging");
    },
    cleanupTemporaryRoot: async (temporaryRoot) => {
      events.push("cleanup-large-temp");
      await rm(temporaryRoot, { recursive: true, force: true });
    },
    directoryIdentity: async (directory, label) => {
      events.push(label.includes("fresh") ? "identity-fresh" : "identity-current");
      return {
        path: directory,
        device: "1",
        inode: label.includes("fresh") ? "20" : "10",
        mode: String(0o40700),
        nonSymlinkDirectory: true,
      };
    },
    writeReport: async (filePath, report) => {
      if (filePath !== report.reportPath) throw new Error("report path evidence mismatch");
      events.push("report-create");
    },
  };
}

function options(exportPath: string, dbRoot: string) {
  return {
    exportPath,
    expectedExportSha256: EXPORT_SHA,
    expectedManifestSha256: MANIFEST_SHA,
    dbRoot,
    confirmRebuild: true,
  };
}

describe("recovery:rebuild orchestration", () => {
  test("authenticates the exact schema-1 export and pinned manifest bytes", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const exportPath = path.join(root, "internal-source", manifest().exportFile);
      await mkdir(path.dirname(exportPath), { recursive: true });
      await writeFile(exportPath, "authenticated compressed bytes");
      const exportHash = await hashFile(exportPath);
      const exact = {
        ...manifest(),
        exportBytes: exportHash.sizeBytes,
        exportSha256: exportHash.sha256,
      };
      const manifestPath = path.join(
        path.dirname(exportPath),
        `${path.basename(exportPath).replace(/\.surql\.zst$/u, "")}.json`,
      );
      await writeFile(manifestPath, `${JSON.stringify(exact)}\n`);
      const evidence = await authenticateRecoveryBackup(config(archiveRoot), exportPath);
      expect(evidence.exportSha256).toBe(exportHash.sha256);
      expect(evidence.manifest.schemaVersion).toBe(1);
      expect(evidence.sourceIdentity).toMatchObject({
        resolvedPath: exportPath,
        sha256: exportHash.sha256,
        sizeBytes: exportHash.sizeBytes,
        device: expect.stringMatching(/^\d+$/u),
        inode: expect.stringMatching(/^\d+$/u),
        mode: expect.stringMatching(/^\d+$/u),
      });

      await writeFile(manifestPath, `${JSON.stringify({
        ...exact,
        surrealdbVersion: "3.2.3",
      })}\n`);
      await expect(authenticateRecoveryBackup(config(archiveRoot), exportPath))
        .rejects.toThrow("exact authenticated schema-1");

      await writeFile(manifestPath, `${JSON.stringify({
        ...exact,
        schemaVersion: 5,
      })}\n`);
      await expect(authenticateRecoveryBackup(config(archiveRoot), exportPath))
        .rejects.toThrow(/неподдерживаемая версия схемы/);
    });
  });

  test("uses an explicitly separate BAKA_DB_ROOT", () => {
    const cfg = config("/Volumes/Archive/Conversations");
    expect(resolveRecoveryDbRoot(cfg, undefined, {
      BAKA_DB_ROOT: "/Volumes/Internal/baka-recovered",
    })).toBe("/Volumes/Internal/baka-recovered");
    expect(() => resolveRecoveryDbRoot(cfg, "/Volumes/Archive/Conversations/db"))
      .toThrow("separate");
    expect(() => resolveRecoveryDbRoot(cfg, "/Volumes/Archive/Conversations/db/new"))
      .toThrow("separate");
  });

  test("accepts only an exact internal current root and a distinct fresh target", () => {
    const currentDbRoot = "/Users/test/Library/Application Support/ai-baka/rocksdb";
    const cfg = {
      ...config("/Volumes/Archive/Conversations"),
      dbRoot: currentDbRoot,
    };
    expect(resolveRecoveryCurrentDbRoot(cfg, currentDbRoot)).toEqual({
      path: currentDbRoot,
      mode: "current-internal",
    });
    const paths = recoveryPaths(cfg, {
      attemptId: ATTEMPT,
      dbRoot: "/Users/test/Library/Application Support/ai-baka/rocksdb-rebuilt",
      currentDbRoot,
    });
    expect(paths).toMatchObject({
      corruptDbRoot: currentDbRoot,
      sourceMode: "current-internal",
      dbRoot: "/Users/test/Library/Application Support/ai-baka/rocksdb-rebuilt",
    });

    expect(() => resolveRecoveryCurrentDbRoot(cfg, "/Users/test/other"))
      .toThrow("exactly match effective BAKA_DB_ROOT");
    expect(() => resolveRecoveryCurrentDbRoot({
      ...cfg,
      dbRoot: "/Volumes/Archive/internal-looking",
    }, "/Volumes/Archive/internal-looking")).toThrow("outside BAKA_ARCHIVE_ROOT/archive volume");
    expect(() => resolveRecoveryCurrentDbRoot({ ...cfg, dbRoot: "/" }, "/"))
      .toThrow("filesystem root");
    expect(() => resolveRecoveryDbRoot(cfg, homedir())).toThrow("broad home directory");
    expect(() => resolveRecoveryCurrentDbRoot({ ...cfg, dbRoot: homedir() }, homedir()))
      .toThrow("broad home directory");
    expect(() => recoveryPaths(cfg, {
      attemptId: ATTEMPT,
      dbRoot: currentDbRoot,
      currentDbRoot,
    })).toThrow("fresh and separate");
    expect(() => recoveryPaths(cfg, {
      attemptId: ATTEMPT,
      dbRoot: path.join(currentDbRoot, "child"),
      currentDbRoot,
    })).toThrow("fresh and separate");
    expect(() => recoveryPaths(cfg, {
      attemptId: ATTEMPT,
      dbRoot: path.dirname(currentDbRoot),
      currentDbRoot,
    })).toThrow("fresh and separate");
  });

  test("attests the supplied stopped internal bind before creating a fresh target", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const currentDbRoot = path.join(root, "current-db");
      const dbRoot = path.join(root, "fresh-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const events: string[] = [];
      const cfg = { ...config(archiveRoot), dbRoot: currentDbRoot };
      const fakes = dependencyFakes(archiveRoot, dbRoot, events);
      fakes.inspectStoppedProduction = async (source) => {
        expect(source).toBe(currentDbRoot);
        events.push("inspect-stopped-production");
        return {
          id: "d".repeat(64),
          imageId: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
          corruptDbRoot: source,
        };
      };
      const result = await runRecoveryRebuild(cfg, {
        ...options(path.join(root, "internal-source", manifest().exportFile), dbRoot),
        currentDbRoot,
      }, fakes);
      expect(result).toMatchObject({
        ok: true,
        dbRoot,
        corruptDbRoot: currentDbRoot,
        sourceMode: "current-internal",
      });
      expect(events.indexOf("inspect-stopped-production"))
        .toBeLessThan(events.indexOf("create-fresh-target-paths"));
    });
  });

  test("rejects an archive volume/archive work root and defaults beside the internal DB", () => {
    const cfg = config("/Volumes/Archive/Conversations");
    expect(() => recoveryPaths(cfg, {
      attemptId: ATTEMPT,
      dbRoot: "/Users/test/Library/Application Support/ai-baka/rocksdb",
      workRoot: "/Volumes/Archive/Conversations/recovery",
    })).toThrow("never BAKA_ARCHIVE_ROOT/archive volume");
    const paths = recoveryPaths(cfg, {
      attemptId: ATTEMPT,
      dbRoot: "/Users/test/Library/Application Support/ai-baka/rocksdb",
    });
    expect(paths.workRoot).toBe(
      `/Users/test/Library/Application Support/ai-baka/.ai-baka-recovery/${ATTEMPT}`,
    );
  });

  test("requires the 64 GiB internal free-space floor before creating paths", () => {
    expect(recoveryAvailableBytes({
      bavail: RECOVERY_MIN_AVAILABLE_BYTES / 4096,
      bsize: 4096,
    })).toBe(RECOVERY_MIN_AVAILABLE_BYTES);
    expect(() => recoveryAvailableBytes({
      bavail: RECOVERY_MIN_AVAILABLE_BYTES / 4096 - 1,
      bsize: 4096,
    })).toThrow("at least");
  });

  test("rejects an existing workBase mountpoint on a different device", () => {
    expect(() => assertRecoveryStorageTopology({
      sourceMode: "current-internal",
      dbParentDevice: "1",
      workBaseDevice: "2",
      backupParentDevice: "1",
      currentDbDevice: "1",
      dbFilesystemSupported: true,
      workBaseFilesystemSupported: true,
      backupFilesystemSupported: true,
      currentFilesystemSupported: true,
    })).toThrow("must share internal storage");
  });

  test("performs authenticated import and core-only verification without cutover", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const events: string[] = [];
      const exportPath = path.join(archiveRoot, "backups", "surreal", manifest().exportFile);
      const report = await runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        dependencyFakes(archiveRoot, dbRoot, events),
      );
      expect(report.ok).toBe(true);
      expect(report.dbRoot).toBe(dbRoot);
      expect(report.currentDbIdentity).toMatchObject({
        path: path.join(archiveRoot, "db"),
        device: "1",
        inode: "10",
      });
      expect(report.freshDbIdentity).toMatchObject({
        path: dbRoot,
        device: "1",
        inode: "20",
      });
      expect(report.stagingContainerRemoved).toBe(true);
      expect(report.stagingAnonymousVolumes).toEqual({
        data: "8".repeat(64),
        logs: "9".repeat(64),
        absentAfterCleanup: true,
      });
      expect(report.temporaryFilesRemoved).toBe(true);
      expect(report.reportPath).toBe(path.join(
        path.dirname(dbRoot),
        ".ai-baka-recovery",
        ATTEMPT,
        "recovery-report.json",
      ));
      expect(events.filter((item) => item === "verify")).toHaveLength(1);
      expect(events.indexOf("lock")).toBeLessThan(events.indexOf("authenticate"));
      expect(events.indexOf("authenticate")).toBeLessThan(events.indexOf("start-staging"));
      expect(events.indexOf("journal-create"))
        .toBeLessThan(events.indexOf("create-fresh-target-paths"));
      expect(events.indexOf("create-fresh-target-paths"))
        .toBeLessThan(events.indexOf("server-temp-ready"));
      expect(events.indexOf("server-temp-ready"))
        .toBeLessThan(events.indexOf("start-staging"));
      expect(events.indexOf("prepare-import")).toBeLessThan(events.indexOf("import"));
      expect(events.indexOf("build-core-index")).toBeLessThan(events.indexOf("stop-staging"));
      expect(events.indexOf("cleanup-large-temp"))
        .toBeLessThan(events.indexOf("journal-update:completed"));
      expect(events.indexOf("journal-update:completed"))
        .toBeLessThan(events.indexOf("identity-current"));
      expect(events.indexOf("identity-current"))
        .toBeLessThan(events.indexOf("report-create"));
      expect(events.indexOf("identity-fresh"))
        .toBeLessThan(events.indexOf("report-create"));
      expect(events).toContain("remove-staging");
      expect(events).toContain("cleanup-large-temp");
      await expect(access(path.join(
        path.dirname(dbRoot),
        ".ai-baka-recovery",
        ATTEMPT,
        "temp",
      ))).rejects.toThrow();
      expect(events.at(-1)).toBe("release");
    });
  });

  test("uploads one prepared import without materializing a decompressed sibling", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const events: string[] = [];
      const exportPath = path.join(root, "internal-source", manifest().exportFile);
      const fakes = dependencyFakes(archiveRoot, dbRoot, events);
      let preparedPath = "";
      fakes.prepareImport = async (source, destination, identity) => {
        expect(source).toBe(path.resolve(exportPath));
        expect(identity).toEqual(backupEvidence(path.resolve(exportPath)).sourceIdentity);
        preparedPath = destination;
        await writeFile(destination, "OPTION IMPORT;\n-- durable ordered import\n", {
          flag: "wx",
          mode: 0o600,
        });
        expect((await readdir(path.dirname(destination))).sort()).toEqual([
          "recovery-import.surql",
          "server",
        ]);
        events.push("prepare-import");
        return [
          "DEFINE INDEX search_document_content ON TABLE search_document FIELDS content " +
            "FULLTEXT ANALYZER archive_mixed BM25 HIGHLIGHTS;",
        ];
      };
      fakes.upload = async (_cfg, sourcePath) => {
        expect(sourcePath).toBe(preparedPath);
        expect(await readFile(sourcePath, "utf8"))
          .toBe("OPTION IMPORT;\n-- durable ordered import\n");
        events.push("import");
      };

      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        fakes,
      )).resolves.toMatchObject({ ok: true });

      expect(events.indexOf("prepare-import")).toBeLessThan(events.indexOf("import"));
      await expect(access(path.dirname(preparedPath))).rejects.toThrow();
    });
  });

  test("failed journal survives retry while only a proven-empty exact DB root is removed", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      const sibling = path.join(root, "must-remain");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      await mkdir(sibling);
      const exportPath = path.join(root, "internal-source", manifest().exportFile);
      const failedEvents: string[] = [];
      const failed = dependencyFakes(archiveRoot, dbRoot, failedEvents);
      failed.writeInitialJournal = async (filePath, journal) => {
        failedEvents.push("journal-create");
        await writeFile(filePath, `${JSON.stringify(journal)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      };
      failed.updateJournal = async (filePath, journal) => {
        failedEvents.push(`journal-update:${journal.status}`);
        await writeFile(filePath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      };
      failed.startTarget = async () => {
        failedEvents.push("start-staging-failed");
        throw new Error("observed staging launch failure");
      };

      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        failed,
      )).rejects.toThrow("observed staging launch failure");

      const failedPaths = recoveryPaths(config(archiveRoot), {
        attemptId: ATTEMPT,
        dbRoot,
      });
      expect(JSON.parse(await readFile(failedPaths.journalPath, "utf8")).status)
        .toBe("failed");
      expect(await readdir(dbRoot)).toEqual([]);
      await expect(access(failedPaths.temporaryRoot)).rejects.toThrow();

      const retryAttempt = "a".repeat(32);
      const retryEvents: string[] = [];
      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        dependencyFakes(archiveRoot, dbRoot, retryEvents, retryAttempt),
      )).rejects.toThrow("independently prove it empty and remove only this exact failed DB root");
      expect(retryEvents).not.toContain("start-staging");
      expect(JSON.parse(await readFile(failedPaths.journalPath, "utf8")).status)
        .toBe("failed");

      // This simulates the coordinator's separate proof and exact, non-recursive
      // removal. Neither the failed journal nor an adjacent path is a target.
      expect(await readdir(dbRoot)).toEqual([]);
      await rmdir(dbRoot);
      expect(await readdir(sibling)).toEqual([]);

      const successfulAttempt = "f".repeat(32);
      const successfulEvents: string[] = [];
      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        dependencyFakes(archiveRoot, dbRoot, successfulEvents, successfulAttempt),
      )).resolves.toMatchObject({ ok: true, attemptId: successfulAttempt });
      expect(JSON.parse(await readFile(failedPaths.journalPath, "utf8")).status)
        .toBe("failed");
      expect(await readdir(sibling)).toEqual([]);
    });
  });

  test("independent SHA mismatch fails before inspecting or starting Docker", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const events: string[] = [];
      const exportPath = path.join(archiveRoot, "backups", "surreal", manifest().exportFile);
      await expect(runRecoveryRebuild(
        config(archiveRoot),
        { ...options(exportPath, dbRoot), expectedManifestSha256: "f".repeat(64) },
        dependencyFakes(archiveRoot, dbRoot, events),
      )).rejects.toThrow("independently pinned");
      expect(events).toEqual([
        "lock",
        "authenticate",
        "cleanup-large-temp",
        "release",
      ]);
    });
  });

  test("inconsistent compressed source identity fails before Docker", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const events: string[] = [];
      const exportPath = path.join(root, "internal-source", manifest().exportFile);
      const fakes = dependencyFakes(archiveRoot, dbRoot, events);
      fakes.authenticateBackup = async () => {
        events.push("authenticate");
        const evidence = backupEvidence(path.resolve(exportPath));
        return {
          ...evidence,
          sourceIdentity: { ...evidence.sourceIdentity, inode: "2", sha256: "f".repeat(64) },
        };
      };

      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        fakes,
      )).rejects.toThrow("source identity evidence is inconsistent");
      expect(events).toEqual(["lock", "authenticate", "cleanup-large-temp", "release"]);
    });
  });

  test("archive O_EXCL lock contention prevents every recovery action", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const events: string[] = [];
      const fakes = dependencyFakes(archiveRoot, dbRoot, events);
      fakes.acquireArchiveLock = async () => {
        events.push("lock-contended");
        throw new Error("lock already held");
      };
      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(path.join(root, "internal-source", manifest().exportFile), dbRoot),
        fakes,
      )).rejects.toThrow("lock already held");
      expect(events).toEqual(["lock-contended"]);
    });
  });

  test("staging failure stops/removes staging and cleans large temp files", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const events: string[] = [];
      const fakes = dependencyFakes(archiveRoot, dbRoot, events);
      fakes.buildIndex = async () => {
        events.push("build-core-index");
        throw new Error("index failed");
      };
      const exportPath = path.join(archiveRoot, "backups", "surreal", manifest().exportFile);
      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        fakes,
      )).rejects.toThrow("index failed");
      expect(events).toContain("stop-staging");
      expect(events).toContain("remove-staging");
      expect(events).toContain("cleanup-large-temp");
      expect(events.at(-1)).toBe("release");
    });
  });

  test("stream preparation failure preserves source and removes the sole temp import", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const sourceRoot = path.join(root, "internal-source");
      const exportPath = path.join(sourceRoot, manifest().exportFile);
      await mkdir(sourceRoot);
      await writeFile(exportPath, "authenticated source remains immutable");
      const events: string[] = [];
      const fakes = dependencyFakes(archiveRoot, dbRoot, events);
      let importPath = "";
      fakes.prepareImport = async (_source, destination) => {
        importPath = destination;
        await writeFile(destination, "partial import");
        events.push("prepare-import-failed");
        throw new Error("decompress checksum failed");
      };

      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        fakes,
      )).rejects.toThrow("decompress checksum failed");

      expect(await readFile(exportPath, "utf8"))
        .toBe("authenticated source remains immutable");
      await expect(access(importPath)).rejects.toThrow();
      await expect(access(path.dirname(importPath))).rejects.toThrow();
      expect(events).toContain("stop-staging");
      expect(events).toContain("remove-staging");
      expect(events).toContain("cleanup-large-temp");
    });
  });

  test("journal durability gates fresh temp/DB creation and final report publication", async () => {
    await withTempDir(async (root) => {
      const archiveRoot = path.join(root, "archive");
      const dbRoot = path.join(root, "new-db");
      await mkdir(path.join(archiveRoot, "db"), { recursive: true });
      const exportPath = path.join(root, "internal-source", manifest().exportFile);

      const initialEvents: string[] = [];
      const initialFailure = dependencyFakes(archiveRoot, dbRoot, initialEvents);
      initialFailure.writeInitialJournal = async () => {
        initialEvents.push("journal-create-failed");
        throw new Error("journal unavailable");
      };
      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        initialFailure,
      )).rejects.toThrow("journal unavailable");
      expect(initialEvents).not.toContain("create-fresh-target-paths");
      expect(initialEvents).not.toContain("start-staging");

      const finalEvents: string[] = [];
      const completedFailure = dependencyFakes(archiveRoot, dbRoot, finalEvents);
      completedFailure.updateJournal = async (_filePath, journal) => {
        finalEvents.push(`journal-update:${journal.status}`);
        if (journal.status === "completed") throw new Error("completed journal unavailable");
      };
      await expect(runRecoveryRebuild(
        config(archiveRoot),
        options(exportPath, dbRoot),
        completedFailure,
      )).rejects.toThrow("completed journal unavailable");
      expect(finalEvents).not.toContain("report-create");
    });
  });

  test("explicit rebuild gate rejects before acquiring the archive lock", async () => {
    const events: string[] = [];
    await expect(runRecoveryRebuild(
      config("/safe/archive"),
      { ...options("/safe/export", "/safe/new-db"), confirmRebuild: false },
      { acquireArchiveLock: async () => {
        events.push("lock");
        return async () => {};
      } },
    )).rejects.toThrow("--confirm-rebuild");
    expect(events).toEqual([]);
  });
});
