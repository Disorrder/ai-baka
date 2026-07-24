import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  initArchive,
  readSentinel,
  SentinelError,
  ARCHIVE_DIRS,
} from "../src/infra/sentinel.ts";
import { withTempDir } from "./config.test.ts";

describe("sentinel", () => {
  test("init создаёт каталоги и sentinel", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "archive");
      const sentinel = await initArchive(root, {
        namespace: "baka",
        database: "archive",
      });
      expect(sentinel.archiveId).toBeString();
      expect(sentinel.formatVersion).toBe(1);
      for (const sub of ARCHIVE_DIRS) {
        expect(existsSync(path.join(root, sub))).toBe(true);
      }
      const read = await readSentinel(root);
      expect(read.archiveId).toBe(sentinel.archiveId);
    });
  });

  test("повторный init отклоняется", async () => {
    await withTempDir(async (dir) => {
      const expected = { namespace: "baka", database: "archive" };
      await initArchive(dir, expected);
      expect(initArchive(dir, expected)).rejects.toThrow(SentinelError);
    });
  });

  test("readSentinel без файла — SentinelError", async () => {
    await withTempDir(async (dir) => {
      expect(readSentinel(dir)).rejects.toThrow(SentinelError);
    });
  });
});
