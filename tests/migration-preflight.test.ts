/**
 * Этап 9 (docs/plan.md §15.2/§15.3): snapshot legacy SQLite и preflight report.
 * Синтетическая legacy-подобная SQLite создаётся в tmpdir через bun:sqlite —
 * реальный архив не трогается.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureLegacySnapshot } from "../src/migration/legacy-snapshot.ts";
import {
  analysisCheckpointPath,
  analyzeLegacySnapshot,
  buildPreflightReport,
  loadAnalysisCheckpoint,
  saveAnalysisCheckpoint,
  type LiveCorpusProbe,
  type PreflightReport,
} from "../src/migration/preflight.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import type { LocalIdentity } from "../src/sync/host-identity.ts";

const IDENTITY: LocalIdentity = {
  hostUuid: "test-host-uuid",
  hostname: "test-host",
  platform: "darwin",
  arch: "arm64",
  osUsername: "example",
  homePath: "/Users/example",
};

let dir: string;
let archiveRoot: string;
let legacyDbPath: string;
let rawBackupFile: string;

/** Минимальная схема = фактические колонки legacy index.sqlite (план §15.5). */
function createLegacyDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE agent_systems (id integer primary key, slug text not null unique)`);
  db.run(`CREATE TABLE projects (id integer primary key, agent_id integer not null, external_id text not null)`);
  db.run(`CREATE TABLE threads (
    id integer primary key, agent_id integer not null, external_id text not null)`);
  db.run(`CREATE TABLE source_files (
    id integer primary key, original_path text not null, status text not null,
    sha256 text not null, deleted_at text)`);
  db.run(`CREATE TABLE raw_backups (
    id integer primary key, source_file_id integer not null,
    archive_path text not null, status text not null)`);
  db.run(`CREATE TABLE thread_records (
    id integer primary key, thread_id integer not null,
    source_file_id integer, sequence integer not null, payload text not null)`);
  db.run(`CREATE TABLE messages (
    id integer primary key, thread_id integer not null, sequence integer not null)`);
  db.run(`CREATE TABLE message_chunks (
    id integer primary key, message_id integer not null, sequence integer not null)`);
  return db;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "baka-migration-test-"));
  archiveRoot = path.join(dir, "archive");
  legacyDbPath = path.join(dir, "index.sqlite");
  rawBackupFile = path.join(dir, "raw-backup-1.jsonl");
  await writeFile(rawBackupFile, '{"type":"user"}\n');

  const db = createLegacyDb(legacyDbPath);
  db.run(`INSERT INTO agent_systems (id, slug) VALUES (1, 'claude-code')`);
  // sf1: текущий host, raw backup на диске есть
  db.run(
    `INSERT INTO source_files VALUES (1, '/Users/example/.claude/a.jsonl', 'active', 'sha-a', NULL)`,
  );
  // sf2: чужой home, raw backup есть, но файл отсутствует на диске
  db.run(
    `INSERT INTO source_files VALUES (2, '/Users/other/.claude/b.jsonl', 'active', 'sha-b', NULL)`,
  );
  // sf3: deleted_in_source, дубликат sha с sf2, raw backup отсутствует
  db.run(
    `INSERT INTO source_files VALUES (3, '/Volumes/ext/c.jsonl', 'deleted_in_source', 'sha-b', '2026-01-01')`,
  );
  // sf4: текущий host, без raw backup
  db.run(
    `INSERT INTO source_files VALUES (4, '/Users/example/.claude/d.jsonl', 'active', 'sha-d', NULL)`,
  );
  db.run(
    `INSERT INTO raw_backups VALUES (1, 1, '${rawBackupFile}', 'active')`,
  );
  db.run(
    `INSERT INTO raw_backups VALUES (2, 2, '/nonexistent/raw/b.jsonl', 'active')`,
  );
  // t1: все записи из sf1 → reconstructable from raw (+ дубль против live)
  db.run(`INSERT INTO threads VALUES (1, 1, 'd1')`);
  db.run(`INSERT INTO thread_records VALUES (1, 1, 1, 0, '{"a":1}')`);
  db.run(`INSERT INTO thread_records VALUES (2, 1, 1, 1, '{"b":2}')`);
  // t2: raw backup есть, но файл потерян; payload валиден → from payload
  db.run(`INSERT INTO threads VALUES (2, 1, 'd2')`);
  db.run(`INSERT INTO thread_records VALUES (3, 2, 2, 0, '{"c":3}')`);
  // t3: payload невалиден, есть messages → only normalized
  db.run(`INSERT INTO threads VALUES (3, 1, 'd3')`);
  db.run(`INSERT INTO thread_records VALUES (4, 3, NULL, 0, '{broken')`);
  db.run(`INSERT INTO messages VALUES (1, 3, 0)`);
  db.run(`INSERT INTO messages VALUES (2, 3, 1)`);
  db.run(`INSERT INTO message_chunks VALUES (1, 1, 0)`);
  // t4: пустой payload, messages нет → quarantined
  db.run(`INSERT INTO threads VALUES (4, 1, 'd4')`);
  db.run(`INSERT INTO thread_records VALUES (5, 4, 4, 0, '')`);
  // t5: вообще без записей → quarantined
  db.run(`INSERT INTO threads VALUES (5, 1, 'd5')`);
  // t6: битый agent_id — тред НЕ теряется (orphan agent), но фиксируется
  db.run(`INSERT INTO threads VALUES (6, 999, 'd6')`);
  db.run(`INSERT INTO thread_records VALUES (6, 6, 1, 0, '{"f":6}')`);
  // t7: часть записей без source_file_id (null_file) — связь тред→raw
  // неполная, from_raw заблокирован; payload валиден → from payload
  db.run(`INSERT INTO threads VALUES (7, 1, 'd7')`);
  db.run(`INSERT INTO thread_records VALUES (7, 7, 1, 0, '{"g":7}')`);
  db.run(`INSERT INTO thread_records VALUES (8, 7, NULL, 1, '{"h":8}')`);
  // orphan-строки без родителя: record/message/chunk/raw backup/project
  db.run(`INSERT INTO thread_records VALUES (100, 999, 1, 0, '{"orphan":1}')`);
  db.run(`INSERT INTO messages VALUES (99, 999, 0)`);
  db.run(`INSERT INTO message_chunks VALUES (99, 999, 0)`);
  db.run(`INSERT INTO raw_backups VALUES (3, 999, '${rawBackupFile}', 'active')`);
  db.run(`INSERT INTO projects VALUES (1, 1, 'p1')`);
  db.run(`INSERT INTO projects VALUES (2, 999, 'p-orphan')`);
  db.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("legacy snapshot (§15.3)", () => {
  test("создаёт snapshot, оригинал не изменяется, повторный вызов переиспользует", async () => {
    const before = await hashFile(legacyDbPath);
    const first = await ensureLegacySnapshot(legacyDbPath, archiveRoot);
    expect(first.reused).toBe(false);
    expect(first.snapshotPath).toBe(
      path.join(archiveRoot, "migration-input", `index__${first.sha256}.sqlite`),
    );
    const after = await hashFile(legacyDbPath);
    expect(after).toEqual(before);

    // snapshot — валидная SQLite с теми же данными
    const snap = new Database(first.snapshotPath, { readonly: true });
    expect(snap.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM threads`).get()?.c).toBe(7);
    snap.close();

    const second = await ensureLegacySnapshot(legacyDbPath, archiveRoot);
    expect(second.reused).toBe(true);
    expect(second.snapshotPath).toBe(first.snapshotPath);
    expect(second.sha256).toBe(first.sha256);
  });

  test("изменение источника (size/mtime) → новый snapshot, sidecar не срабатывает", async () => {
    const otherDb = path.join(dir, "other.sqlite");
    const db = new Database(otherDb, { create: true });
    db.run("CREATE TABLE t (id integer)");
    db.run("INSERT INTO t VALUES (1)");
    db.close();

    const first = await ensureLegacySnapshot(otherDb, archiveRoot);
    expect(first.reused).toBe(false);
    const second = await ensureLegacySnapshot(otherDb, archiveRoot);
    expect(second.reused).toBe(true); // sidecar: vacuum не повторялся

    // mtime не меняется в ту же миллисекунду гарантированно — меняем и размер
    const db2 = new Database(otherDb);
    db2.run("INSERT INTO t VALUES (2)");
    db2.close();
    const third = await ensureLegacySnapshot(otherDb, archiveRoot);
    expect(third.reused).toBe(false);
    expect(third.sha256).not.toBe(first.sha256);
  });
});

describe("migration preflight report (§15.2)", () => {
  let report: PreflightReport;

  beforeAll(async () => {
    const snapshot = await ensureLegacySnapshot(legacyDbPath, archiveRoot);
    const live: LiveCorpusProbe = {
      available: true,
      revisionSha256: new Set(["sha-a"]),
      dialogueKeys: new Set(["claude-code:d1"]),
    };
    report = await buildPreflightReport({
      snapshotPath: snapshot.snapshotPath,
      snapshotSha256: snapshot.sha256,
      identity: IDENTITY,
      live,
    });
  });

  test("counts и соответствие схемы плану §15.5", () => {
    expect(report.counts).toEqual({
      sourceFiles: 4,
      rawBackups: 3,
      dialogues: 7,
      messages: 3,
      chunks: 2,
      threadRecords: 9,
    });
    for (const present of Object.values(report.schema.expected)) {
      expect(present).toBe(true);
    }
  });

  test("payload coverage: present/missing/valid/invalid", () => {
    expect(report.payload.present).toBe(8);
    expect(report.payload.missing).toBe(1);
    expect(report.payload.validJson).toBe(7);
    expect(report.payload.invalidJson).toBe(1);
    expect(report.payload.threadsFullyCovered).toBe(4); // t1, t2, t6, t7
    // t3 (невалиден), t4 (пустой), t5 (вообще без thread_records)
    expect(report.payload.threadsUncovered).toBe(3);
    expect(report.payload.coversAllDialogues).toBe(false);
  });

  test("классификация по приоритету §15.4", () => {
    expect(report.reconstructable.fromRaw).toBe(2); // t1, t6
    expect(report.reconstructable.fromPayload).toBe(2); // t2, t7
    expect(report.reconstructable.onlyNormalized).toBe(1); // t3
    expect(report.reconstructable.quarantined).toBe(2); // t4, t5
  });

  test("null_file блокирует from_raw (неполная связь тред→raw)", () => {
    // t7: все payload валидны и sf1 имеет raw backup на диске, но один
    // thread_record без source_file_id → не from_raw, а from_payload
    const analysis = report.reconstructable;
    expect(analysis.fromRaw).toBe(2); // без t7
    expect(analysis.fromPayload).toBe(2); // t7 здесь
  });

  test("reconciliation §15.9: legacyTotal честный, каждая строка учтена", () => {
    const r = report.reconciliation;
    // Полное число legacy rows по всем таблицам (до фильтрации):
    // 1 agent + 2 projects + 4 source_files + 3 raw_backups + 7 threads
    // + 9 thread_records + 3 messages + 2 message_chunks
    expect(r.legacyTotal).toBe(31);
    expect(r.accounted).toBe(31);
    expect(r.lost).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.tables.threads).toEqual({ total: 7, accounted: 7, withProblems: 3, lost: 0 });
    expect(r.tables.thread_records).toEqual({ total: 9, accounted: 9, withProblems: 1, lost: 0 });
    expect(r.tables.messages).toEqual({ total: 3, accounted: 3, withProblems: 1, lost: 0 });
    expect(r.tables.message_chunks).toEqual({ total: 2, accounted: 2, withProblems: 1, lost: 0 });
    expect(r.tables.raw_backups).toEqual({ total: 3, accounted: 3, withProblems: 2, lost: 0 });
    expect(r.tables.projects).toEqual({ total: 2, accounted: 2, withProblems: 1, lost: 0 });
  });

  test("orphan-строки учтены с record ID, не потеряны бесшумно", () => {
    const byKey = new Map(report.problems.map((p) => [`${p.table}:${p.recordId}`, p.reason]));
    expect(byKey.get("thread_records:100")).toContain("orphan");
    expect(byKey.get("messages:99")).toContain("orphan");
    expect(byKey.get("message_chunks:99")).toContain("orphan");
    expect(byKey.get("raw_backups:3")).toContain("orphan");
    expect(byKey.get("projects:2")).toContain("orphan");
    // битый agent_id: тред не выпал из анализа
    expect(byKey.get("threads:6")).toContain("agent_id=999");
    expect(report.counts.dialogues).toBe(7); // t6 посчитан
  });

  test("deleted_in_source и missing raw backup", () => {
    expect(report.deletedInSource).toBe(1); // sf3
    expect(report.missingRawBackup.withoutBackupRow).toBe(2); // sf3, sf4
    expect(report.missingRawBackup.fileMissingOnDisk).toBe(1); // rb2
  });

  test("каждая проблема с конкретным record ID", () => {
    const key = (p: { table: string; recordId: string }) => `${p.table}:${p.recordId}`;
    const keys = new Set(report.problems.map(key));
    expect(keys.has("threads:4")).toBe(true); // quarantine
    expect(keys.has("threads:5")).toBe(true);
    expect(keys.has("threads:6")).toBe(true); // битый agent_id
    expect(keys.has("thread_records:100")).toBe(true); // orphan record
    expect(keys.has("raw_backups:2")).toBe(true); // файл отсутствует на диске
    expect(keys.has("source_files:3")).toBe(true); // нет raw_backups
    expect(keys.has("source_files:4")).toBe(true);
    for (const p of report.problems) expect(p.reason.length).toBeGreaterThan(0);
  });

  test("duplicates внутри legacy и против live corpus", () => {
    expect(report.duplicates.withinLegacy.duplicateSha256Groups).toBe(1);
    expect(report.duplicates.withinLegacy.affectedSourceFiles).toBe(2);
    expect(report.duplicates.withinLegacy.examples[0]?.sha256).toBe("sha-b");
    expect(report.duplicates.vsLiveCorpus.revisionsMatched).toBe(1); // sf1 sha-a
    expect(report.duplicates.vsLiveCorpus.dialoguesMatched).toBe(1); // t1
  });

  test("host mapping preview (§15.6)", () => {
    expect(report.hostMapping.currentHost).toBe(2); // sf1, sf4
    const legacy = Object.keys(report.hostMapping.legacyHosts);
    expect(legacy.length).toBe(1);
    expect(legacy[0]).toMatch(/^legacy-[0-9a-f]{12}$/); // /Users/other
    expect(report.hostMapping.legacyHosts[legacy[0]!]).toBe(1);
    expect(report.hostMapping.uncertain).toEqual({ "/Volumes/ext": 1 }); // sf3
  });

  test("без live probe секция vsLiveCorpus помечается unavailable", async () => {
    const snapshot = await ensureLegacySnapshot(legacyDbPath, archiveRoot);
    const noLive = await buildPreflightReport({
      snapshotPath: snapshot.snapshotPath,
      identity: IDENTITY,
      checkRawFiles: false,
    });
    expect(noLive.duplicates.vsLiveCorpus.available).toBe(false);
    expect(noLive.missingRawBackup.fileMissingOnDisk).toBe(0);
    // без проверки файлов t2 классифицируется как from_raw (backup row есть)
    expect(noLive.reconstructable.fromRaw).toBe(3); // t1, t2, t6
    expect(noLive.reconciliation.ok).toBe(true);
    expect(noLive.reconciliation.lost).toBe(0);
  });
});

describe("analysis checkpoint (повторные запуски без пересканирования)", () => {
  test("round-trip: save → load, отчёт из checkpoint совпадает с прямым", async () => {
    const snapshot = await ensureLegacySnapshot(legacyDbPath, archiveRoot);
    const analysis = await analyzeLegacySnapshot(snapshot.snapshotPath, IDENTITY, {
      snapshotSha256: snapshot.sha256,
    });
    const checkpoint = analysisCheckpointPath(dir, snapshot.sha256);
    await saveAnalysisCheckpoint(checkpoint, analysis);

    const loaded = await loadAnalysisCheckpoint(checkpoint, snapshot.sha256, true);
    expect(loaded).toEqual(analysis);

    // отчёт из checkpoint'а: БД не открывается — подменяем snapshot мусором
    const garbage = path.join(dir, "garbage.sqlite");
    await writeFile(garbage, "not a sqlite file");
    const live: LiveCorpusProbe = {
      available: true,
      revisionSha256: new Set(["sha-a"]),
      dialogueKeys: new Set(["claude-code:d1"]),
    };
    const fromCache = await buildPreflightReport({
      snapshotPath: garbage,
      snapshotSha256: snapshot.sha256,
      identity: IDENTITY,
      live,
      analysis: loaded!,
    });
    const direct = await buildPreflightReport({
      snapshotPath: snapshot.snapshotPath,
      snapshotSha256: snapshot.sha256,
      identity: IDENTITY,
      live,
    });
    const { createdAt: _a, snapshotPath: _b, ...cachedRest } = fromCache;
    const { createdAt: _c, snapshotPath: _d, ...directRest } = direct;
    expect(cachedRest).toEqual(directRest);
  });

  test("checkpoint отклоняется при несовпадении sha/checkRawFiles или повреждении", async () => {
    const snapshot = await ensureLegacySnapshot(legacyDbPath, archiveRoot);
    const analysis = await analyzeLegacySnapshot(snapshot.snapshotPath, IDENTITY, {
      snapshotSha256: snapshot.sha256,
    });
    const checkpoint = analysisCheckpointPath(dir, snapshot.sha256);
    await saveAnalysisCheckpoint(checkpoint, analysis);

    expect(await loadAnalysisCheckpoint(checkpoint, "0".repeat(64), true)).toBeNull();
    expect(await loadAnalysisCheckpoint(checkpoint, snapshot.sha256, false)).toBeNull();
    await writeFile(checkpoint, "{broken json");
    expect(await loadAnalysisCheckpoint(checkpoint, snapshot.sha256, true)).toBeNull();
    expect(
      await loadAnalysisCheckpoint(path.join(dir, "missing.json"), snapshot.sha256, true),
    ).toBeNull();
  });
});
