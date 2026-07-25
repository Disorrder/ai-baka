import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  isLocked,
  LockError,
  LOCK_FILE,
  pidAlive,
} from "../src/infra/lock.ts";
import { withTempDir } from "./config.test.ts";

describe("sync lock", () => {
  test("acquire/release", async () => {
    await withTempDir(async (dir) => {
      const release = await acquireLock(dir, "test");
      expect(await isLocked(dir)).toBe(true);
      await release();
      expect(await isLocked(dir)).toBe(false);
    });
  });

  test("двойной acquire отклоняется для чужого живого pid", async () => {
    await withTempDir(async (dir) => {
      // PID 1 (launchd) гарантированно жив и не равен нашему
      await writeFile(
        path.join(dir, LOCK_FILE),
        JSON.stringify({ pid: 1, command: "other", startedAt: "x" }),
      );
      expect(acquireLock(dir, "test")).rejects.toThrow(LockError);
    });
  });

  test("stale lock перезаписывается", async () => {
    await withTempDir(async (dir) => {
      // Подбираем гарантированно мёртвый pid
      let deadPid = 4000000000;
      expect(pidAlive(deadPid)).toBe(false);
      await writeFile(
        path.join(dir, LOCK_FILE),
        JSON.stringify({ pid: deadPid, command: "old", startedAt: "x" }),
      );
      const release = await acquireLock(dir, "test");
      expect(await isLocked(dir)).toBe(true);
      await release();
    });
  });

  test("сценарий §19.2 №29: гонка двух acquire → ровно один успешен", async () => {
    await withTempDir(async (dir) => {
      const results = await Promise.allSettled([
        acquireLock(dir, "one"),
        acquireLock(dir, "two"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LockError);
      // Lock-файл принадлежит победителю и снимается его release.
      expect(await isLocked(dir)).toBe(true);
      await (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value();
      expect(await isLocked(dir)).toBe(false);
    });
  });

  test("повторный acquire тем же процессом отклоняется (lock уже наш)", async () => {
    await withTempDir(async (dir) => {
      const release = await acquireLock(dir, "first");
      await expect(acquireLock(dir, "second")).rejects.toThrow(LockError);
      await release();
    });
  });
});
