import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const IMPORT_LIMIT_BYTES = "34359738368";
const DB_MOUNT =
  '"${BAKA_DB_ROOT:-${HOME:?HOME must be set}/Library/Application Support/ai-baka/rocksdb}:/data/db"';

describe("SurrealDB compose import limit", () => {
  test("keeps one explicit bounded 32 GiB compose default", async () => {
    const compose = await readFile(path.join(PROJECT_ROOT, "docker-compose.yml"), "utf8");
    const contract =
      `SURREAL_HTTP_MAX_IMPORT_BODY_SIZE: "\${SURREAL_HTTP_MAX_IMPORT_BODY_SIZE:-${IMPORT_LIMIT_BYTES}}"`;
    expect(compose.split(contract)).toHaveLength(2);
    expect(compose).not.toMatch(/SURREAL_HTTP_MAX_IMPORT_BODY_SIZE[^\n]*(?:unlimited|:\s*["']?0)/iu);
  });

  test("documents the same exact byte value in the environment template", async () => {
    const template = await readFile(path.join(PROJECT_ROOT, ".env.example"), "utf8");
    expect(template.match(/^SURREAL_HTTP_MAX_IMPORT_BODY_SIZE=(\d+)$/mu)?.[1]).toBe(
      IMPORT_LIMIT_BYTES,
    );
    expect(Number(IMPORT_LIMIT_BYTES)).toBe(32 * 1024 ** 3);
  });
});

describe("SurrealDB compose storage root", () => {
  test("uses a persistent internal default with an explicit override", async () => {
    const compose = await readFile(path.join(PROJECT_ROOT, "docker-compose.yml"), "utf8");
    expect(compose.split(DB_MOUNT)).toHaveLength(2);
    expect(compose).not.toContain('"${BAKA_ARCHIVE_ROOT}/db:/data/db"');
    expect(compose).not.toContain("${BAKA_DB_ROOT:-${BAKA_ARCHIVE_ROOT}/db}");
    expect(compose).toContain("${HOME:?HOME must be set}");
    expect(compose).toContain("rocksdb:///data/db");
  });

  test("documents the override without moving archive payloads", async () => {
    const template = await readFile(path.join(PROJECT_ROOT, ".env.example"), "utf8");
    expect(template).toMatch(/^# BAKA_DB_ROOT=\/Users\/.+\/rocksdb$/mu);
    expect(template).toContain("<HOME>/Library/Application Support/ai-baka/rocksdb");
    expect(template).toContain("ExFAT для live RocksDB не поддержан");
  });
});
