import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../src/config.ts";

describe("loadConfig", () => {
  test("требует BAKA_ARCHIVE_ROOT", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  test("применяет дефолты", () => {
    const cfg = loadConfig({
      BAKA_ARCHIVE_ROOT: "/tmp/archive",
      HOME: "/Users/test-user",
    });
    expect(cfg.archiveRoot).toBe("/tmp/archive");
    expect(cfg.dbRoot).toBe(
      "/Users/test-user/Library/Application Support/ai-baka/rocksdb",
    );
    expect(cfg.surrealUrl).toBe("ws://127.0.0.1:8901/rpc");
    expect(cfg.surrealNamespace).toBe("baka");
    expect(cfg.surrealDatabase).toBe("archive");
    expect(cfg.minFreeBytes).toBe(1024 * 1024 * 1024);
    expect(cfg.deletionConfirmations).toBe(2);
  });

  test("читает переопределения", () => {
    const cfg = loadConfig({
      BAKA_ARCHIVE_ROOT: "/tmp/archive",
      BAKA_DB_ROOT: "/tmp/internal-db",
      SURREAL_NAMESPACE: "other",
      BAKA_ARCHIVE_ID: "uuid-1",
      BAKA_MIN_FREE_BYTES: "1024",
    });
    expect(cfg.surrealNamespace).toBe("other");
    expect(cfg.dbRoot).toBe("/tmp/internal-db");
    expect(cfg.expectedArchiveId).toBe("uuid-1");
    expect(cfg.minFreeBytes).toBe(1024);
  });

  test("не допускает live RocksDB внутри archive root", () => {
    expect(() => loadConfig({
      BAKA_ARCHIVE_ROOT: "/tmp/archive",
      BAKA_DB_ROOT: "/tmp/archive/db",
    })).toThrow(ConfigError);
  });
});

export async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "baka-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
