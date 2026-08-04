import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir, readFile, stat, writeFile, appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { hashFile, headHashOf, HEAD_HASH_BYTES } from "../src/sources/snapshot/hashing.ts";
import {
  MAX_RAW_NAME_BYTES,
  rawFileName,
  truncateUtf8Bytes,
} from "../src/sources/snapshot/naming.ts";
import {
  SnapshotError,
  snapshotRegularFile,
  snapshotSource,
  snapshotSqlite,
} from "../src/sources/snapshot/raw-snapshot.ts";
import {
  findRawOrphans,
  findStagingOrphans,
  sha256FromRawName,
} from "../src/sources/snapshot/orphans.ts";
import { withTempDir } from "./config.test.ts";

const SHA = "a".repeat(64);

function optsFor(archiveRoot: string, extra: Record<string, unknown> = {}) {
  return { archiveRoot, harness: "codex", runId: "run-1", ...extra };
}

async function rawFiles(archiveRoot: string, harness = "codex"): Promise<string[]> {
  return readdir(path.join(archiveRoot, "raw", harness));
}

describe("naming (flat raw naming, §4.2)", () => {
  test("формат: <basename>__<sha256>.<ext>", () => {
    expect(rawFileName("rollout-1.jsonl", SHA)).toBe(`rollout-1__${SHA}.jsonl`);
  });

  test("sanitize недопустимых символов", () => {
    // "мой диалог: #1?" → 13 '_' + "1" + '_'
    expect(rawFileName("мой диалог: #1?.jsonl", SHA)).toBe(
      `_____________1___${SHA}.jsonl`,
    );
    expect(rawFileName("no-extension", SHA)).toBe(`no-extension__${SHA}`);
  });

  test("обрезка длинных имён по байтам до лимита", () => {
    const long = "д".repeat(300) + ".jsonl"; // 'д' = 2 байта UTF-8
    const name = rawFileName(long, SHA);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(MAX_RAW_NAME_BYTES);
    expect(name.endsWith(`__${SHA}.jsonl`)).toBe(true);
  });

  test("truncateUtf8Bytes не рвёт многобайтовый символ", () => {
    const s = "д".repeat(10); // 20 байт
    expect(Buffer.byteLength(truncateUtf8Bytes(s, 5), "utf8")).toBe(4);
  });

  test("basename collision: разный hash → разные имена", () => {
    const a = rawFileName("same.jsonl", "a".repeat(64));
    const b = rawFileName("same.jsonl", "b".repeat(64));
    expect(a).not.toBe(b);
  });
});

describe("hashing", () => {
  test("полный SHA-256 и head_hash", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "a.jsonl");
      await writeFile(file, "hello");
      const hashes = await hashFile(file);
      expect(hashes.sizeBytes).toBe(5);
      expect(hashes.sha256).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
      expect(hashes.headHash).toBe(headHashOf(Buffer.from("hello"), 5));
      expect(hashes.headHash).not.toBe(hashes.sha256);
    });
  });

  test("head_hash — не identity: общее начало, разный хвост", async () => {
    await withTempDir(async (dir) => {
      const head = Buffer.alloc(HEAD_HASH_BYTES, 0x41);
      const f1 = path.join(dir, "f1.bin");
      const f2 = path.join(dir, "f2.bin");
      await writeFile(f1, Buffer.concat([head, Buffer.from("tail-1")]));
      await writeFile(f2, Buffer.concat([head, Buffer.from("tail-2-different")]));
      const h1 = await hashFile(f1);
      const h2 = await hashFile(f2);
      expect(h1.sha256).not.toBe(h2.sha256);
      // head одинаковый; различается только size — этого достаточно, чтобы
      // показать, что head_hash не доказывает идентичность содержимого.
      const sameSizeF2 = path.join(dir, "f3.bin");
      await writeFile(sameSizeF2, Buffer.concat([head, Buffer.from("tail-2")]));
      const h3 = await hashFile(sameSizeF2);
      expect(h3.sha256).not.toBe(h1.sha256);
    });
  });
});

describe("raw snapshot (§9.1)", () => {
  test("snapshot создаёт immutable raw с hash в имени", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "rollout-1.jsonl");
      await writeFile(src, "line1\nline2\n");
      const archive = path.join(dir, "archive");
      const result = await snapshotRegularFile(src, optsFor(archive));
      expect(result.reused).toBe(false);
      expect(result.snapshotKind).toBe("regular_copy");
      expect(path.basename(result.rawArchivePath)).toBe(
        `rollout-1__${result.sha256}.jsonl`,
      );
      expect(result.relativeRawPath).toBe(
        path.join("raw", "codex", path.basename(result.rawArchivePath)),
      );
      const content = await readFile(result.rawArchivePath);
      expect(content.toString()).toBe("line1\nline2\n");
      // staging текущего run пуст после rename
      const staging = await readdir(path.join(archive, "staging", "run-1"));
      expect(staging).toEqual([]);
    });
  });

  test("иммутабельность: повторный snapshot того же содержимого переиспользует raw", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "a.jsonl");
      await writeFile(src, "data");
      const archive = path.join(dir, "archive");
      const first = await snapshotRegularFile(src, optsFor(archive));
      const firstMtime = (await stat(first.rawArchivePath)).mtimeMs;
      const second = await snapshotRegularFile(src, optsFor(archive, { runId: "run-2" }));
      expect(second.reused).toBe(true);
      expect(second.rawArchivePath).toBe(first.rawArchivePath);
      expect(await rawFiles(archive)).toHaveLength(1);
      expect((await stat(first.rawArchivePath)).mtimeMs).toBe(firstMtime);
    });
  });

  test("изменившийся файл создаёт новую raw-ревизию, старая сохраняется", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "a.jsonl");
      await writeFile(src, "v1");
      const archive = path.join(dir, "archive");
      const first = await snapshotRegularFile(src, optsFor(archive));
      await writeFile(src, "v1-and-more");
      const second = await snapshotRegularFile(src, optsFor(archive, { runId: "run-2" }));
      expect(second.reused).toBe(false);
      expect(second.sha256).not.toBe(first.sha256);
      expect(second.rawArchivePath).not.toBe(first.rawArchivePath);
      expect(await rawFiles(archive)).toHaveLength(2);
      expect((await readFile(first.rawArchivePath)).toString()).toBe("v1");
    });
  });

  test("сценарий §19.2 №30: одинаковый basename, разный hash — оба сохраняются", async () => {
    await withTempDir(async (dir) => {
      const d1 = path.join(dir, "src1");
      const d2 = path.join(dir, "src2");
      await mkdir(d1);
      await mkdir(d2);
      await writeFile(path.join(d1, "same.jsonl"), "content-A");
      await writeFile(path.join(d2, "same.jsonl"), "content-B-different");
      const archive = path.join(dir, "archive");
      const r1 = await snapshotRegularFile(path.join(d1, "same.jsonl"), optsFor(archive));
      const r2 = await snapshotRegularFile(path.join(d2, "same.jsonl"), optsFor(archive));
      expect(r1.rawArchivePath).not.toBe(r2.rawArchivePath);
      const files = await rawFiles(archive);
      expect(files).toHaveLength(2);
      expect((await readFile(r1.rawArchivePath)).toString()).toBe("content-A");
      expect((await readFile(r2.rawArchivePath)).toString()).toBe("content-B-different");
    });
  });

  test("сценарий §19.2 №14: файл изменился во время копирования — retry", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "live.jsonl");
      await writeFile(src, "before");
      const archive = path.join(dir, "archive");
      const attempts: number[] = [];
      const result = await snapshotRegularFile(
        src,
        optsFor(archive, {
          afterCopyAttempt: async (attempt: number) => {
            attempts.push(attempt);
            if (attempt === 1) await appendFile(src, "-after");
          },
        }),
      );
      expect(attempts).toEqual([1, 2]);
      const finalHash = await hashFile(src);
      expect(result.sha256).toBe(finalHash.sha256);
      expect((await readFile(result.rawArchivePath)).toString()).toBe("before-after");
    });
  });

  test("нестабильный источник: после лимита попыток — SnapshotError", async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, "live.jsonl");
      await writeFile(src, "x");
      const archive = path.join(dir, "archive");
      await expect(
        snapshotRegularFile(
          src,
          optsFor(archive, {
            maxAttempts: 3,
            afterCopyAttempt: async () => {
              await appendFile(src, "x");
            },
          }),
        ),
      ).rejects.toThrow(SnapshotError);
      // staging дочищен, raw не создан
      expect((await readdir(path.join(archive, "staging", "run-1"))).length).toBe(0);
    });
  });
});

describe("SQLite snapshot (§9.2, сценарий §19.2 №13)", () => {
  test("VACUUM INTO живой WAL-базы с открытым соединением", async () => {
    await withTempDir(async (dir) => {
      const dbPath = path.join(dir, "opencode.db");
      const live = new Database(dbPath);
      live.run("PRAGMA journal_mode = WAL");
      live.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT)");
      live.run("INSERT INTO sessions VALUES ('s1', 'hello')");
      // Соединение открыто, WAL не checkpoint'нут — данные могут быть в -wal.

      const archive = path.join(dir, "archive");
      const result = await snapshotSqlite(
        dbPath,
        optsFor(archive, { harness: "opencode" }),
      );
      expect(result.snapshotKind).toBe("vacuum_into");
      expect(path.basename(result.rawArchivePath)).toBe(
        `opencode__${result.sha256}.db`,
      );

      const snap = new Database(result.rawArchivePath, { readonly: true });
      const rows = snap.query("SELECT id, data FROM sessions").all();
      snap.close();
      expect(rows).toEqual([{ id: "s1", data: "hello" }]);

      // Источник жив: можно продолжать писать.
      live.run("INSERT INTO sessions VALUES ('s2', 'world')");
      const count = live.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
      expect(count.c).toBe(2);
      live.close();
    });
  });

  test("закрытая WAL-база без -shm/-wal (readonly+create не открывает — Cursor state.vscdb)", async () => {
    await withTempDir(async (dir) => {
      const dbPath = path.join(dir, "state.vscdb");
      const live = new Database(dbPath);
      live.run("PRAGMA journal_mode = WAL");
      live.run("CREATE TABLE t (x TEXT)");
      live.run("INSERT INTO t VALUES ('1')");
      live.close(); // чистое закрытие: -wal/-shm удаляются, база остаётся в WAL-режиме

      const archive = path.join(dir, "archive");
      const result = await snapshotSqlite(dbPath, optsFor(archive));
      const snap = new Database(result.rawArchivePath, { readonly: true });
      const rows = snap.query("SELECT x FROM t").all();
      snap.close();
      expect(rows).toEqual([{ x: "1" }]);
    });
  });

  test("закрытая WAL-база без sidecar snapshot'ится из read-only каталога", async () => {
    await withTempDir(async (dir) => {
      const sourceDir = path.join(dir, "closed-workspace");
      await mkdir(sourceDir);
      const dbPath = path.join(sourceDir, "state.vscdb");
      const live = new Database(dbPath);
      live.run("PRAGMA journal_mode = WAL");
      live.run("CREATE TABLE t (x TEXT)");
      live.run("INSERT INTO t VALUES ('cursor-message')");
      live.close();

      await chmod(sourceDir, 0o555);
      try {
        const result = await snapshotSqlite(dbPath, optsFor(path.join(dir, "archive")));
        const snap = new Database(result.rawArchivePath, { readonly: true });
        const rows = snap.query("SELECT x FROM t").all();
        snap.close();
        expect(rows).toEqual([{ x: "cursor-message" }]);
      } finally {
        await chmod(sourceDir, 0o755);
      }
    });
  });

  test("snapshotSource выбирает vacuum_into по расширению .db", async () => {
    await withTempDir(async (dir) => {
      const dbPath = path.join(dir, "state.db");
      const live = new Database(dbPath);
      live.run("CREATE TABLE t (x TEXT)");
      live.run("INSERT INTO t VALUES ('1')");
      const archive = path.join(dir, "archive");
      const result = await snapshotSource(dbPath, optsFor(archive));
      expect(result.snapshotKind).toBe("vacuum_into");
      live.close();
    });
  });
});

describe("orphan detection", () => {
  test("staging: каталоги чужих run'ов — orphans", async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, "staging/run-current"), { recursive: true });
      await mkdir(path.join(dir, "staging/run-stale"), { recursive: true });
      await writeFile(path.join(dir, "staging/stray.part"), "x");
      const orphans = await findStagingOrphans(dir, "run-current");
      expect(orphans).toEqual([
        path.join(dir, "staging/run-stale"),
        path.join(dir, "staging/stray.part"),
      ]);
      expect(await findStagingOrphans(path.join(dir, "empty"), "run-1")).toEqual([]);
    });
  });

  test("raw: неизвестные hash и невалидные имена — orphans", async () => {
    await withTempDir(async (dir) => {
      const raw = path.join(dir, "raw/codex");
      await mkdir(raw, { recursive: true });
      const known = "a".repeat(64);
      const unknown = "b".repeat(64);
      await writeFile(path.join(raw, `one__${known}.jsonl`), "1");
      await writeFile(path.join(raw, `two__${unknown}.jsonl`), "2");
      await writeFile(path.join(raw, "garbage-name.jsonl"), "3");
      const orphans = await findRawOrphans(dir, new Set([known]));
      expect(orphans).toEqual([
        path.join(raw, "garbage-name.jsonl"),
        path.join(raw, `two__${unknown}.jsonl`),
      ]);
      expect(sha256FromRawName(`one__${known}.jsonl`)).toBe(known);
      expect(sha256FromRawName("garbage-name.jsonl")).toBeNull();
    });
  });
});
