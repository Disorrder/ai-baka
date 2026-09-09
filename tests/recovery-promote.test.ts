import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import {
  recoveryPromotionPaths,
  readRecoveryDirectoryIdentity,
  runRecoveryPromotion,
  type RecoveryPromotionDependencies,
  type RecoveryPromotionOptions,
  type RecoveryPromotionStorageEvidence,
} from "../src/backup/recovery-promote.ts";
import { PINNED_RESTORE_TARGET_IMAGE_DIGEST } from "../src/backup/restore-test.ts";

const ATTEMPT = "1".repeat(32);
const CONTAINER_ID = "2".repeat(64);

async function withTempDir(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "baka-recovery-promote-")));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function config(root: string, currentDbRoot: string): AppConfig {
  return {
    archiveRoot: path.join(root, "archive"),
    dbRoot: currentDbRoot,
    surrealUrl: "ws://127.0.0.1:8901/rpc",
    surrealUser: "unused",
    surrealPass: "unused",
    surrealNamespace: "baka",
    surrealDatabase: "archive",
  } as AppConfig;
}

function successfulReport(input: {
  reportPath: string;
  currentDbRoot: string;
  freshDbRoot: string;
}): Record<string, unknown> {
  return {
    formatVersion: 1,
    ok: true,
    attemptId: ATTEMPT,
    startedAt: "2026-07-27T01:00:00.000Z",
    finishedAt: "2026-07-27T01:15:00.000Z",
    exportFile: "backup__schema-5.surql.zst",
    exportBytes: 123,
    exportSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    rawManifestSha256: "c".repeat(64),
    schemaVersion: 1,
    dbRoot: input.freshDbRoot,
    corruptDbRoot: input.currentDbRoot,
    sourceMode: "current-internal",
    stoppedCorruptContainerId: CONTAINER_ID,
    stagingContainerRemoved: true,
    stagingAnonymousVolumes: {
      data: "d".repeat(64),
      logs: "e".repeat(64),
      absentAfterCleanup: true,
    },
    temporaryFilesRemoved: true,
    storage: {
      minimumAvailableBytes: 64 * 1024 * 1024 * 1024,
      availableBytesBefore: 65 * 1024 * 1024 * 1024,
      sameInternalDevice: true,
      supportedPosixFilesystem: true,
    },
    indexBuilds: [{ name: "search_document_content", state: "ready" }],
    stagedVerification: {
      ok: true,
      schemaVersion: 1,
      recordCounts: { search_document: 2, chunk: 3 },
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
    },
    journalPath: path.join(path.dirname(input.reportPath), "recovery-journal.json"),
    reportPath: input.reportPath,
  };
}

async function writeReport(
  reportPath: string,
  report: Record<string, unknown>,
): Promise<string> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, text, { mode: 0o600 });
  return createHash("sha256").update(text).digest("hex");
}

async function fixture(root: string) {
  const currentDbRoot = path.join(root, "current-db");
  const freshDbRoot = path.join(root, "fresh-db");
  const quarantineDbRoot = path.join(root, "quarantine-db");
  const reportPath = path.join(root, "recovery", ATTEMPT, "recovery-report.json");
  await mkdir(currentDbRoot);
  await mkdir(freshDbRoot);
  await writeFile(path.join(currentDbRoot, "old.marker"), "old");
  await writeFile(path.join(freshDbRoot, "fresh.marker"), "fresh");
  await mkdir(path.join(root, "archive"));
  const report = successfulReport({ reportPath, currentDbRoot, freshDbRoot });
  report.currentDbIdentity = await readRecoveryDirectoryIdentity(
    currentDbRoot,
    "fixture current DB",
  );
  report.freshDbIdentity = await readRecoveryDirectoryIdentity(
    freshDbRoot,
    "fixture fresh DB",
  );
  const reportSha256 = await writeReport(reportPath, report);
  return {
    cfg: config(root, currentDbRoot),
    report,
    options: {
      reportPath,
      expectedReportSha256: reportSha256,
      currentDbRoot,
      freshDbRoot,
      quarantineDbRoot,
      stoppedContainerId: CONTAINER_ID,
      confirmPromote: true,
    } satisfies RecoveryPromotionOptions,
  };
}

function dependencies(events: string[]): Partial<RecoveryPromotionDependencies> {
  return {
    now: () => new Date("2026-07-27T02:00:00.000Z"),
    acquireArchiveLock: async () => {
      events.push("lock");
      return async () => {
        events.push("release");
      };
    },
    inspectStoppedProduction: async (currentDbRoot) => {
      events.push("inspect-stopped");
      return {
        id: CONTAINER_ID,
        imageId: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
        corruptDbRoot: currentDbRoot,
      };
    },
    rename: async (source, destination) => {
      events.push(`rename:${path.basename(source)}>${path.basename(destination)}`);
      await rename(source, destination);
    },
  };
}

describe("recovery:promote", () => {
  test("promotes verified fresh inode, retains previous tree and never starts or deletes", async () => {
    await withTempDir(async (root) => {
      const { cfg, options } = await fixture(root);
      const events: string[] = [];
      const result = await runRecoveryPromotion(cfg, options, dependencies(events));
      expect(result).toMatchObject({
        ok: true,
        schemaVersion: 1,
        currentDbRoot: options.currentDbRoot,
        quarantineDbRoot: options.quarantineDbRoot,
        stoppedContainerId: CONTAINER_ID,
        productionStarted: false,
        databaseOpened: false,
        freshPathAbsent: true,
      });
      expect(await readFile(path.join(options.currentDbRoot, "fresh.marker"), "utf8"))
        .toBe("fresh");
      expect(await readFile(path.join(options.quarantineDbRoot, "old.marker"), "utf8"))
        .toBe("old");
      await expect(access(options.freshDbRoot)).rejects.toThrow();
      expect(events.filter((event) => event === "inspect-stopped")).toHaveLength(2);
      expect(events.filter((event) => event.startsWith("rename:"))).toEqual([
        "rename:current-db>quarantine-db",
        "rename:fresh-db>current-db",
      ]);
      expect(events.at(-1)).toBe("release");
    });
  });

  test("rolls the first rename back when the second rename fails", async () => {
    await withTempDir(async (root) => {
      const { cfg, options } = await fixture(root);
      const events: string[] = [];
      const deps = dependencies(events);
      let calls = 0;
      deps.rename = async (source, destination) => {
        calls += 1;
        events.push(`rename-${calls}`);
        if (calls === 2) throw new Error("injected second rename failure");
        await rename(source, destination);
      };
      await expect(runRecoveryPromotion(cfg, options, deps))
        .rejects.toThrow("first rename was rolled back");
      expect(calls).toBe(3);
      expect(await readFile(path.join(options.currentDbRoot, "old.marker"), "utf8"))
        .toBe("old");
      expect(await readFile(path.join(options.freshDbRoot, "fresh.marker"), "utf8"))
        .toBe("fresh");
      await expect(access(options.quarantineDbRoot)).rejects.toThrow();
      expect(events.at(-1)).toBe("release");
    });
  });

  test("rolls both renames back when post-promotion verification fails", async () => {
    await withTempDir(async (root) => {
      const { cfg, options } = await fixture(root);
      const events: string[] = [];
      const deps = dependencies(events);
      let inspections = 0;
      deps.inspectStoppedProduction = async (currentDbRoot) => {
        inspections += 1;
        if (inspections === 2) throw new Error("injected post-rename verification failure");
        return {
          id: CONTAINER_ID,
          imageId: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
          corruptDbRoot: currentDbRoot,
        };
      };

      await expect(runRecoveryPromotion(cfg, options, deps))
        .rejects.toThrow("promotion was rolled back");
      expect(await readFile(path.join(options.currentDbRoot, "old.marker"), "utf8"))
        .toBe("old");
      expect(await readFile(path.join(options.freshDbRoot, "fresh.marker"), "utf8"))
        .toBe("fresh");
      await expect(access(options.quarantineDbRoot)).rejects.toThrow();
      expect(events.filter((event) => event.startsWith("rename:"))).toEqual([
        "rename:current-db>quarantine-db",
        "rename:fresh-db>current-db",
        "rename:current-db>fresh-db",
        "rename:quarantine-db>current-db",
      ]);
      expect(events.at(-1)).toBe("release");
    });
  });

  test("rejects a fresh/current directory swap after the recovery report was pinned", async () => {
    await withTempDir(async (root) => {
      const { cfg, options } = await fixture(root);
      const displaced = path.join(root, "swap-temp");
      await rename(options.currentDbRoot, displaced);
      await rename(options.freshDbRoot, options.currentDbRoot);
      await rename(displaced, options.freshDbRoot);
      const events: string[] = [];
      await expect(runRecoveryPromotion(cfg, options, dependencies(events)))
        .rejects.toThrow("no longer matches pinned recovery report identity");
      expect(events.some((event) => event.startsWith("rename:"))).toBe(false);
      expect(await readFile(path.join(options.currentDbRoot, "fresh.marker"), "utf8"))
        .toBe("fresh");
      expect(await readFile(path.join(options.freshDbRoot, "old.marker"), "utf8"))
        .toBe("old");
    });
  });

  test("rejects missing confirmation and unsafe path plans before lock", async () => {
    await withTempDir(async (root) => {
      const { cfg, options } = await fixture(root);
      const events: string[] = [];
      await expect(runRecoveryPromotion(
        cfg,
        { ...options, confirmPromote: false },
        dependencies(events),
      )).rejects.toThrow("--confirm-promote");
      expect(events).toEqual([]);

      expect(() => recoveryPromotionPaths(cfg, {
        currentDbRoot: options.currentDbRoot,
        freshDbRoot: path.join(options.currentDbRoot, "child"),
        quarantineDbRoot: options.quarantineDbRoot,
      })).toThrow("non-ancestor");
      expect(() => recoveryPromotionPaths(cfg, {
        currentDbRoot: options.currentDbRoot,
        freshDbRoot: options.freshDbRoot,
        quarantineDbRoot: options.currentDbRoot,
      })).toThrow("non-ancestor");
      const archiveCurrent = path.join(cfg.archiveRoot, "db");
      expect(() => recoveryPromotionPaths(
        { ...cfg, dbRoot: archiveCurrent },
        {
          currentDbRoot: archiveCurrent,
          freshDbRoot: options.freshDbRoot,
          quarantineDbRoot: options.quarantineDbRoot,
        },
      )).toThrow("outside BAKA_ARCHIVE_ROOT/archive volume");
    });
  });

  test("rejects existing quarantine and changed or cross-device identity before rename", async () => {
    await withTempDir(async (root) => {
      const { cfg, options } = await fixture(root);
      await mkdir(options.quarantineDbRoot);
      const existingEvents: string[] = [];
      await expect(runRecoveryPromotion(cfg, options, dependencies(existingEvents)))
        .rejects.toThrow("must not exist");
      expect(existingEvents.some((event) => event.startsWith("rename:"))).toBe(false);
      await rm(options.quarantineDbRoot, { recursive: true });

      const actualFresh = path.join(root, "actual-fresh");
      await rename(options.freshDbRoot, actualFresh);
      await symlink(actualFresh, options.freshDbRoot);
      const symlinkEvents: string[] = [];
      await expect(runRecoveryPromotion(cfg, options, dependencies(symlinkEvents)))
        .rejects.toThrow("real non-symlink directory");
      expect(symlinkEvents.some((event) => event.startsWith("rename:"))).toBe(false);
      await rm(options.freshDbRoot);
      await rename(actualFresh, options.freshDbRoot);

      const identityEvents: string[] = [];
      const identityDeps = dependencies(identityEvents);
      let observed: RecoveryPromotionStorageEvidence | undefined;
      const originalInspect = (await import("../src/backup/recovery-promote.ts"))
        .inspectRecoveryPromotionStorage;
      identityDeps.inspectStorage = async (paths) => {
        observed ??= await originalInspect(paths);
        return identityEvents.filter((event) => event === "storage").length === 0
          ? (identityEvents.push("storage"), observed)
          : {
            ...observed,
            fresh: { ...observed.fresh, inode: String(Number(observed.fresh.inode) + 1) },
          };
      };
      await expect(runRecoveryPromotion(cfg, options, identityDeps))
        .rejects.toThrow("identities changed before rename");
      expect(identityEvents.some((event) => event.startsWith("rename:"))).toBe(false);

      const deviceEvents: string[] = [];
      const deviceDeps = dependencies(deviceEvents);
      deviceDeps.inspectStorage = async (paths) => {
        const storage = await originalInspect(paths);
        return { ...storage, fresh: { ...storage.fresh, device: "999999" } };
      };
      await expect(runRecoveryPromotion(cfg, options, deviceDeps))
        .rejects.toThrow("storage evidence is inconsistent");
      expect(deviceEvents.some((event) => event.startsWith("rename:"))).toBe(false);
    });
  });

  test("rejects report hash, malformed/non-success evidence and container failures", async () => {
    await withTempDir(async (root) => {
      const { cfg, report, options } = await fixture(root);
      const hashEvents: string[] = [];
      await expect(runRecoveryPromotion(
        cfg,
        { ...options, expectedReportSha256: "f".repeat(64) },
        dependencies(hashEvents),
      )).rejects.toThrow("pinned SHA-256");
      expect(hashEvents.some((event) => event.startsWith("rename:"))).toBe(false);

      for (const missingIdentity of ["currentDbIdentity", "freshDbIdentity"] as const) {
        const altered = { ...report };
        delete altered[missingIdentity];
        const sha = await writeReport(options.reportPath, altered);
        const events: string[] = [];
        await expect(runRecoveryPromotion(
          cfg,
          { ...options, expectedReportSha256: sha },
          dependencies(events),
        )).rejects.toThrow(/identity is (?:invalid|malformed)/u);
        expect(events.some((event) => event.startsWith("rename:"))).toBe(false);
      }

      await writeFile(options.reportPath, "{malformed", { mode: 0o600 });
      const malformedText = await readFile(options.reportPath, "utf8");
      const malformedSha = createHash("sha256").update(malformedText).digest("hex");
      const malformedEvents: string[] = [];
      await expect(runRecoveryPromotion(
        cfg,
        { ...options, expectedReportSha256: malformedSha },
        dependencies(malformedEvents),
      )).rejects.toThrow("malformed JSON");
      expect(malformedEvents.some((event) => event.startsWith("rename:"))).toBe(false);

      for (const altered of [
        { ...report, ok: false },
        { ...report, sourceMode: "archive-corrupt" },
        { ...report, schemaVersion: 4 },
        { ...report, dbRoot: path.join(root, "wrong-fresh") },
        { ...report, stagedVerification: { ok: false } },
      ]) {
        const sha = await writeReport(options.reportPath, altered);
        const events: string[] = [];
        await expect(runRecoveryPromotion(
          cfg,
          { ...options, expectedReportSha256: sha },
          dependencies(events),
        )).rejects.toThrow(/recovery report/u);
        expect(events.some((event) => event.startsWith("rename:"))).toBe(false);
      }

      const validSha = await writeReport(options.reportPath, report);
      for (const failure of ["absent", "running"] as const) {
        const events: string[] = [];
        const deps = dependencies(events);
        deps.inspectStoppedProduction = async () => {
          events.push(`container-${failure}`);
          throw new Error(`${failure} production container`);
        };
        await expect(runRecoveryPromotion(
          cfg,
          { ...options, expectedReportSha256: validSha },
          deps,
        )).rejects.toThrow(`${failure} production container`);
        expect(events.some((event) => event.startsWith("rename:"))).toBe(false);
      }

      const mismatchEvents: string[] = [];
      const mismatch = dependencies(mismatchEvents);
      mismatch.inspectStoppedProduction = async (currentDbRoot) => ({
        id: "9".repeat(64),
        imageId: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
        corruptDbRoot: currentDbRoot,
      });
      await expect(runRecoveryPromotion(
        cfg,
        { ...options, expectedReportSha256: validSha },
        mismatch,
      )).rejects.toThrow("does not match promotion authorization");
      expect(mismatchEvents.some((event) => event.startsWith("rename:"))).toBe(false);
    });
  });
});
