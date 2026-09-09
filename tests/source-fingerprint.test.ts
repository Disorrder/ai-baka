import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSourceFingerprint } from "../src/sources/snapshot/source-fingerprint.ts";
import { snapshotSource } from "../src/sources/snapshot/raw-snapshot.ts";

test("SQLite fingerprint tracks WAL commits, not VACUUM output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "baka-source-state-"));
  const file = path.join(dir, "source.db");
  const db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('first')");
    const opts = { archiveRoot: path.join(dir, "archive"), harness: "codex", runId: "test" };
    const first = await snapshotSource(file, opts);
    expect(first.sourceFingerprint).toBeDefined();
    expect(await readSourceFingerprint(file)).toBe(first.sourceFingerprint);
    db.exec("INSERT INTO sample VALUES ('second')");
    expect(await readSourceFingerprint(file)).not.toBe(first.sourceFingerprint);
    const second = await snapshotSource(file, opts);
    const restored = new Database(second.rawArchivePath, { readonly: true, create: false });
    try {
      expect(restored.query("SELECT value FROM sample ORDER BY rowid").all()).toEqual([{value: "first"}, {value: "second"}]);
    } finally { restored.close(); }
    await writeFile(`${file}-journal`, "in-flight transaction");
    expect(await readSourceFingerprint(file)).toBeUndefined();
  } finally {
    db.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test("a source changed during capture cannot acquire an observation for its old state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "baka-source-race-"));
  const file = path.join(dir, "source.jsonl");
  try {
    await writeFile(file, "before");
    const result = await snapshotSource(file, {
      archiveRoot: path.join(dir, "archive"), harness: "codex", runId: "test",
      afterCopyAttempt: async (attempt) => { if (attempt === 1) await writeFile(file, "changed source"); },
    });
    expect(await Bun.file(result.rawArchivePath).text()).toBe("changed source");
    expect(result.sourceFingerprint).toBeUndefined();
    expect(await readSourceFingerprint(path.join(dir, "missing.db"))).toBeUndefined();
  } finally { await rm(dir, {recursive: true, force: true}); }
});
