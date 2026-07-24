import { describe, expect, test } from "bun:test";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { initArchive } from "../src/infra/sentinel.ts";
import { runPreflight } from "../src/infra/preflight.ts";
import { withTempDir } from "./config.test.ts";

function cfgFor(root: string, extra: Record<string, string> = {}) {
  return loadConfig({ BAKA_ARCHIVE_ROOT: root, ...extra });
}

describe("preflight", () => {
  test("несуществующий root — отказ", async () => {
    const report = await runPreflight(cfgFor("/nonexistent/baka-archive"));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.check)).toContain("archive_root_exists");
  });

  test("root без sentinel — отказ", async () => {
    await withTempDir(async (dir) => {
      const report = await runPreflight(cfgFor(dir));
      expect(report.ok).toBe(false);
      expect(report.issues.map((i) => i.check)).toContain("sentinel");
    });
  });

  test("несовпадение BAKA_ARCHIVE_ID — отказ", async () => {
    await withTempDir(async (dir) => {
      await initArchive(dir, { namespace: "baka", database: "archive" });
      const report = await runPreflight(cfgFor(dir, { BAKA_ARCHIVE_ID: "wrong" }));
      expect(report.ok).toBe(false);
      expect(report.issues.map((i) => i.check)).toContain("archive_id_match");
    });
  });

  test("tmp dir на корневой FS — mounted_volume отказ", async () => {
    await withTempDir(async (dir) => {
      await initArchive(dir, { namespace: "baka", database: "archive" });
      const report = await runPreflight(cfgFor(dir));
      // tmp dir лежит на /, поэтому проверка mounted_volume обязана сработать
      expect(report.issues.map((i) => i.check)).toContain("mounted_volume");
    });
  });

  test("несовпадение namespace — отказ", async () => {
    await withTempDir(async (dir) => {
      await initArchive(dir, { namespace: "baka", database: "archive" });
      const report = await runPreflight(
        cfgFor(dir, { SURREAL_NAMESPACE: "other" }),
      );
      expect(report.issues.map((i) => i.check)).toContain("namespace_match");
    });
  });
});
