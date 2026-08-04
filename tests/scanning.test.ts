import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HARNESS_FILE_MATCHERS,
  matchAll,
} from "../src/sources/adapters/file-matchers.ts";
import { scanSourceRoot } from "../src/sources/scanning/scanner.ts";
import { withTempDir } from "./config.test.ts";

describe("scanning", () => {
  test("complete: собирает файлы по matcher'у, игнорирует AppleDouble и чужие расширения", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "root");
      await mkdir(path.join(root, "a/b"), { recursive: true });
      await writeFile(path.join(root, "one.jsonl"), "x");
      await writeFile(path.join(root, "a/two.jsonl"), "yy");
      await writeFile(path.join(root, "a/b/three.jsonl"), "zzz");
      await writeFile(path.join(root, "notes.txt"), "nope");
      await writeFile(path.join(root, "._one.jsonl"), "appledouble");
      await writeFile(path.join(root, "a/._two.jsonl"), "appledouble");

      const result = await scanSourceRoot(root, HARNESS_FILE_MATCHERS["qwen-code"]);
      expect(result.status).toBe("complete");
      expect(result.errors).toEqual([]);
      expect(result.files.map((f) => f.relativePath)).toEqual([
        "a/b/three.jsonl",
        "a/two.jsonl",
        "one.jsonl",
      ]);
      const two = result.files.find((f) => f.relativePath === "a/two.jsonl");
      expect(two?.sizeBytes).toBe(2);
      expect(typeof two?.mtimeMs).toBe("number");
    });
  });

  test("kimi-code matcher берёт только session topology, не task artifacts", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "root");
      await mkdir(path.join(root, "wd/session/agents/main/tasks"), { recursive: true });
      await mkdir(path.join(root, "wd/session/agents/agent-0"), { recursive: true });
      await writeFile(path.join(root, "session_index.jsonl"), "{}\n");
      await writeFile(path.join(root, "wd/session/state.json"), "{}");
      await writeFile(path.join(root, "wd/session/agents/main/wire.jsonl"), "{}\n");
      await writeFile(path.join(root, "wd/session/agents/agent-0/wire.jsonl"), "{}\n");
      await writeFile(path.join(root, "wd/session/agents/main/tasks/bash-1.json"), "{}");

      const result = await scanSourceRoot(root, HARNESS_FILE_MATCHERS["kimi-code"]);
      expect(result.status).toBe("complete");
      expect(result.files.map((f) => f.relativePath)).toEqual([
        "session_index.jsonl",
        "wd/session/agents/agent-0/wire.jsonl",
        "wd/session/agents/main/wire.jsonl",
        "wd/session/state.json",
      ]);
    });
  });

  test("unavailable: несуществующий root", async () => {
    const result = await scanSourceRoot("/nonexistent/baka-root");
    expect(result.status).toBe("unavailable");
    expect(result.files).toEqual([]);
    expect(result.errors[0]?.code).toBe("ENOENT");
  });

  test("partial: нечитаемая поддиректория не роняет scan", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    await withTempDir(async (dir) => {
      const root = path.join(dir, "root");
      const locked = path.join(root, "locked");
      await mkdir(locked, { recursive: true });
      await writeFile(path.join(root, "ok.jsonl"), "x");
      await writeFile(path.join(locked, "hidden.jsonl"), "y");
      await chmod(locked, 0o000);
      try {
        const result = await scanSourceRoot(root);
        expect(result.status).toBe("partial");
        expect(result.files.map((f) => f.relativePath)).toEqual(["ok.jsonl"]);
        expect(result.errors).toHaveLength(1);
      } finally {
        await chmod(locked, 0o755);
      }
    });
  });

  test("permission_denied: нечитаемый root", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    await withTempDir(async (dir) => {
      const root = path.join(dir, "root");
      await mkdir(root);
      await chmod(root, 0o000);
      try {
        const result = await scanSourceRoot(root);
        expect(result.status).toBe("permission_denied");
      } finally {
        await chmod(root, 0o755);
      }
    });
  });

  test("root — одиночный файл (history.jsonl)", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "history.jsonl");
      await writeFile(file, "line\n");
      const result = await scanSourceRoot(file, HARNESS_FILE_MATCHERS["claude-code"]);
      expect(result.status).toBe("complete");
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.relativePath).toBe("history.jsonl");
    });
  });

  test("symlink'и не обходятся", async () => {
    await withTempDir(async (dir) => {
      const root = path.join(dir, "root");
      const outside = path.join(dir, "outside");
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.jsonl"), "s");
      await writeFile(path.join(root, "real.jsonl"), "r");
      const { symlink } = await import("node:fs/promises");
      await symlink(outside, path.join(root, "link"));
      const result = await scanSourceRoot(root);
      expect(result.status).toBe("complete");
      expect(result.files.map((f) => f.relativePath)).toEqual(["real.jsonl"]);
    });
  });

  test("claude-desktop matcher принимает LevelDB fallback, но не plugin assets", async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, "skills-plugin/plugin/skills/docx"), { recursive: true });
      await mkdir(path.join(dir, "session/rpm"), { recursive: true });
      await writeFile(path.join(dir, "MANIFEST-000001"), "x");
      await writeFile(path.join(dir, "000003.log"), "y");
      await writeFile(path.join(dir, "skills-plugin/plugin/skills/docx/SKILL.md"), "no");
      await writeFile(path.join(dir, "session/rpm/manifest.json"), "no");
      const result = await scanSourceRoot(dir, HARNESS_FILE_MATCHERS["claude-desktop"]);
      expect(result.status).toBe("complete");
      expect(result.files.map((f) => f.relativePath)).toEqual([
        "000003.log",
        "MANIFEST-000001",
      ]);
    });
  });
});
