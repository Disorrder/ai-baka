import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import {
  MIGRATION_PLAN_LOCK_COMMAND,
  probeMigrationPlanLiveCorpus,
  program,
  withMigrationPlanArchiveSafety,
} from "../src/cli.ts";
import { acquireLock, LockError, readLock } from "../src/infra/lock.ts";

function config(): AppConfig {
  return {
    archiveRoot: "/test/archive",
    dbRoot: "/test/internal/rocksdb",
    surrealUrl: "ws://127.0.0.1:8901/rpc",
    surrealUser: "root",
    surrealPass: "root",
    surrealNamespace: "baka",
    surrealDatabase: "archive",
    minFreeBytes: 1,
    deletionConfirmations: 2,
    sourceOverrides: {},
    embeddings: {
      excludeHarnesses: [],
      excludeWorkspaces: [],
      excludeDocumentTypes: [],
    },
  };
}

describe("migration plan archive safety", () => {
  test("preflight runs before one lock that encloses every write stage", async () => {
    const events: string[] = [];
    const result = await withMigrationPlanArchiveSafety(
      config(),
      async () => {
        events.push("snapshot", "checkpoint", "report");
        return "ok";
      },
      {
        assertPreflight: async () => {
          events.push("preflight");
        },
        acquireLock: async (archiveRoot, command) => {
          expect(archiveRoot).toBe("/test/archive");
          expect(command).toBe(MIGRATION_PLAN_LOCK_COMMAND);
          events.push("lock");
          return async () => {
            events.push("release");
          };
        },
      },
    );

    expect(result).toBe("ok");
    expect(events).toEqual([
      "preflight",
      "lock",
      "snapshot",
      "checkpoint",
      "report",
      "release",
    ]);
  });

  test("preflight failure prevents lock acquisition and all plan writes", async () => {
    const events: string[] = [];
    await expect(withMigrationPlanArchiveSafety(
      config(),
      async () => {
        events.push("operation");
      },
      {
        assertPreflight: async () => {
          events.push("preflight");
          throw new Error("unsafe archive");
        },
        acquireLock: async () => {
          events.push("lock");
          return async () => {
            events.push("release");
          };
        },
      },
    )).rejects.toThrow("unsafe archive");
    expect(events).toEqual(["preflight"]);
  });

  test("lock is released when snapshot, checkpoint or report work fails", async () => {
    const events: string[] = [];
    await expect(withMigrationPlanArchiveSafety(
      config(),
      async () => {
        events.push("operation");
        throw new Error("plan write failed");
      },
      {
        assertPreflight: async () => {
          events.push("preflight");
        },
        acquireLock: async () => {
          events.push("lock");
          return async () => {
            events.push("release");
          };
        },
      },
    )).rejects.toThrow("plan write failed");
    expect(events).toEqual(["preflight", "lock", "operation", "release"]);
  });

  test("real process lock excludes a concurrent archive writer and is cleaned up", async () => {
    const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "baka-migration-plan-lock-"));
    try {
      await withMigrationPlanArchiveSafety(
        { ...config(), archiveRoot },
        async () => {
          expect(await readLock(archiveRoot)).toMatchObject({
            pid: process.pid,
            command: MIGRATION_PLAN_LOCK_COMMAND,
          });
          await expect(acquireLock(archiveRoot, "concurrent writer"))
            .rejects.toBeInstanceOf(LockError);
        },
        {
          // The preflight contract/order is isolated above; this test exercises
          // the real O_EXCL process-lock implementation on a disposable root.
          assertPreflight: async () => {},
          acquireLock,
        },
      );
      expect(await readLock(archiveRoot)).toBeNull();
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  test("--skip-live bypasses only the live probe", async () => {
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return {
        available: true,
        revisionSha256: new Set<string>(),
        dialogueKeys: new Set<string>(),
      };
    };

    expect(await probeMigrationPlanLiveCorpus(config(), true, probe)).toBeUndefined();
    expect(probes).toBe(0);
    expect(await probeMigrationPlanLiveCorpus(config(), false, probe)).toEqual({
      available: true,
      revisionSha256: new Set<string>(),
      dialogueKeys: new Set<string>(),
    });
    expect(probes).toBe(1);

    const migration = program.commands.find((command) => command.name() === "migration");
    const plan = migration?.commands.find((command) => command.name() === "plan");
    expect(plan?.options.map((option) => option.long)).toContain("--skip-live");
  });
});
