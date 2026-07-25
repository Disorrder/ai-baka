import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HARNESS_ORDER } from "../src/sources/adapters/harnesses.ts";
import {
  discoverSourceRoots,
  parseSourceOverride,
} from "../src/sources/discovery/discovery.ts";
import { withTempDir } from "./config.test.ts";

describe("discovery", () => {
  test("охватывает все 7 harness'ов; несуществующие пути не enabled", async () => {
    await withTempDir(async (home) => {
      const report = await discoverSourceRoots({ home, env: {} });
      const harnesses = new Set(report.roots.map((r) => r.harness));
      expect(harnesses).toEqual(new Set(HARNESS_ORDER));
      expect(report.enabled).toEqual([]);
      expect(report.missing.length).toBe(report.roots.length);
      expect(report.roots.every((r) => r.origin === "default")).toBe(true);
    });
  });

  test("существующие на диске root'ы попадают в enabled", async () => {
    await withTempDir(async (home) => {
      await mkdir(path.join(home, ".codex/sessions"), { recursive: true });
      await mkdir(path.join(home, ".qwen/projects"), { recursive: true });
      const report = await discoverSourceRoots({ home, env: {} });
      const enabled = report.enabled.map((r) => `${r.harness}:${r.path}`);
      expect(enabled).toEqual([
        `codex:${home}/.codex/sessions`,
        `qwen-code:${home}/.qwen/projects`,
      ]);
    });
  });

  test("kimi-code учитывает KIMI_CODE_HOME", async () => {
    await withTempDir(async (home) => {
      const kimiHome = path.join(home, "custom-kimi");
      await mkdir(path.join(kimiHome, "sessions"), { recursive: true });
      const report = await discoverSourceRoots({
        home,
        env: { KIMI_CODE_HOME: kimiHome },
      });
      const kimi = report.roots.filter((r) => r.harness === "kimi-code");
      expect(kimi.map((r) => r.path)).toEqual([
        path.join(kimiHome, "sessions"),
        path.join(kimiHome, "session_index.jsonl"),
      ]);
      expect(kimi.filter((r) => r.enabled)).toHaveLength(1);
    });
  });

  test("переопределение root'ов заменяет дефолты и разворачивает ~", async () => {
    await withTempDir(async (home) => {
      const custom = path.join(home, "elsewhere/codex");
      await mkdir(custom, { recursive: true });
      const report = await discoverSourceRoots({
        home,
        env: {},
        overrides: { codex: [custom, "~/missing-override"] },
      });
      const codex = report.roots.filter((r) => r.harness === "codex");
      expect(codex).toHaveLength(2);
      expect(codex[0]).toMatchObject({ path: custom, enabled: true, origin: "override" });
      expect(codex[1]).toMatchObject({
        path: path.join(home, "missing-override"),
        enabled: false,
        origin: "override",
      });
    });
  });

  test("override через env BAKA_SOURCES__*", async () => {
    await withTempDir(async (home) => {
      await writeFile(path.join(home, "one.jsonl"), "{}\n");
      const report = await discoverSourceRoots({
        home,
        env: { BAKA_SOURCES__CLAUDE_CODE: `${home}/one.jsonl, ${home}/two.jsonl` },
      });
      const cc = report.roots.filter((r) => r.harness === "claude-code");
      expect(cc.map((r) => r.enabled)).toEqual([true, false]);
      expect(cc.every((r) => r.origin === "override")).toBe(true);
    });
  });

  test("parseSourceOverride: trim, пустые, тильда", () => {
    expect(parseSourceOverride(" /a , ,~/b ", "/home/u")).toEqual(["/a", "/home/u/b"]);
  });
});
