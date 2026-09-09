/**
 * Integration-тесты structured sync (этап 5, docs/plan.md §10) на живом
 * SurrealDB и фейковых source root'ах из tests/fixtures (temp dirs; живые
 * источники не трогаются).
 *
 * Сценарии §19.2: №1 (второй sync пустой), №4–6 (missing → deleted →
 * active), №9 (укоротившийся файл), №10 (parse error не меняет current),
 * №12 (orphan raw находит validate).
 */

import { afterAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordId } from "surrealdb";
import type { AppConfig } from "../src/config.ts";
import { runSync, type SyncSummary } from "../src/sync/sync-run.ts";
import { runValidation } from "../src/validate.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import { snapshotSource } from "../src/sources/snapshot/raw-snapshot.ts";
import {
  setLocationRevisions,
  updateSourceRevisionParse,
} from "../src/db/repositories/provenance.ts";
import {
  SURREAL_PASS,
  SURREAL_URL,
  SURREAL_USER,
  TEST_NAMESPACE,
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  type TestDb,
} from "./db-test-utils.ts";

const FIXTURES = path.resolve(import.meta.dir, "fixtures/kimi-code");
const BASIC_ID = "session_11111111-aaaa-4bbb-8ccc-111111111111";
const TOOLS_ID = "session_22222222-bbbb-4ccc-8ddd-222222222222";

// Явный skip в отчёте, если SurrealDB недоступен (вместо молчаливого pass).
const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

interface SyncEnv {
  t: TestDb;
  cfg: AppConfig;
  archiveRoot: string;
  srcRoot: string;
  cleanup: () => Promise<void>;
}

/** Фейковый kimi-code home: sessions root с двумя fixture-сессиями. */
async function makeSyncEnv(): Promise<SyncEnv> {
  const t = await createTestDb();
  const base = await mkdtemp(path.join(tmpdir(), "baka-sync-test-"));
  const archiveRoot = path.join(base, "archive");
  const srcRoot = path.join(base, "sessions");
  await mkdir(archiveRoot, { recursive: true });
  await cp(path.join(FIXTURES, "basic", BASIC_ID), path.join(srcRoot, "wd_test", BASIC_ID), {
    recursive: true,
  });
  await cp(path.join(FIXTURES, "tools-and-subagent", TOOLS_ID), path.join(srcRoot, "wd_test", TOOLS_ID), {
    recursive: true,
  });
  const cfg: AppConfig = {
    archiveRoot,
    dbRoot: path.join(base, "db"),
    surrealUrl: SURREAL_URL,
    surrealUser: SURREAL_USER,
    surrealPass: SURREAL_PASS,
    surrealNamespace: TEST_NAMESPACE,
    surrealDatabase: t.name,
    minFreeBytes: 0,
    deletionConfirmations: 2,
    sourceOverrides: { "kimi-code": [srcRoot] },
    embeddings: {
      excludeHarnesses: [],
      excludeWorkspaces: [],
      excludeDocumentTypes: [],
    },
  };
  return {
    t,
    cfg,
    archiveRoot,
    srcRoot,
    cleanup: async () => {
      await dropTestDb(t);
      await rm(base, { recursive: true, force: true });
    },
  };
}

function syncOptions(env: SyncEnv) {
  return {
    harness: "kimi-code" as const,
    preflight: false,
    hostIdPath: path.join(env.archiveRoot, "host-id"),
    logger: () => {},
  };
}

async function tableCount(t: TestDb, table: string): Promise<number> {
  const row = await selectOne<{ n: number }>(t.db, `SELECT count() AS n FROM ${table} GROUP ALL`);
  return row?.n ?? 0;
}

const basicWire = (env: SyncEnv) =>
  path.join(env.srcRoot, "wd_test", BASIC_ID, "agents/main/wire.jsonl");
const basicState = (env: SyncEnv) => path.join(env.srcRoot, "wd_test", BASIC_ID, "state.json");

describe("structured sync (integration)", () => {
  testDb("полный цикл: первый sync, идемпотентность (№1), truncate (№9), parse error (№10), deletion (№4–6), orphan raw (№12)", async () => {
    const env = await makeSyncEnv();
    try {
      // --- первый sync ---
      const first: SyncSummary = await runSync(env.cfg, syncOptions(env));
      expect(first.status).toBe("completed");
      expect(first.counters.dialoguesWritten).toBe(2);
      expect(await tableCount(env.t, "dialogue")).toBe(2);
      expect(await tableCount(env.t, "dialogue_revision")).toBe(2);
      expect(await tableCount(env.t, "source_revision")).toBe(5); // 2+3 файла
      expect(await tableCount(env.t, "source_location")).toBe(5);
      const messageCount = await tableCount(env.t, "message");
      expect(messageCount).toBeGreaterThan(0);
      expect(await tableCount(env.t, "search_document")).toBeGreaterThan(0);
      expect(await tableCount(env.t, "embedding_job")).toBe(0); // нет active space
      expect(await tableCount(env.t, "sync_run")).toBe(1);
      expect(await tableCount(env.t, "source_scan")).toBe(1);
      // workspace из state.json.workDir
      expect(await tableCount(env.t, "workspace")).toBeGreaterThan(0);
      // external_id = sessionId; заголовок из state.json
      const dlg = await selectOne<{ external_id: string; title: string }>(
        env.t.db,
        "SELECT external_id, title FROM dialogue WHERE external_id = $id",
        { id: BASIC_ID },
      );
      expect(dlg).toBeDefined();
      expect(dlg!.title).toContain("кэша");
      // у subagent-сессии основной диалог — один (subagent wire в той же сессии)
      const toolsMsgs = await selectAll<{ n: number }>(
        env.t.db,
        "SELECT count() AS n FROM message WHERE dialogue.external_id = $id GROUP ALL",
        { id: TOOLS_ID },
      );
      expect(toolsMsgs[0]?.n ?? 0).toBeGreaterThan(0);

      // --- второй sync: ничего нового (сценарий №1) ---
      const second = await runSync(env.cfg, syncOptions(env));
      expect(second.status).toBe("completed");
      expect(second.counters.filesNew).toBe(0);
      expect(second.counters.filesChanged).toBe(0);
      expect(second.counters.revisionsCreated).toBe(0);
      expect(second.counters.dialoguesWritten).toBe(0);
      expect(second.counters.messagesWritten).toBe(0);
      expect(await tableCount(env.t, "dialogue")).toBe(2);
      expect(await tableCount(env.t, "dialogue_revision")).toBe(2);
      expect(await tableCount(env.t, "message")).toBe(messageCount);
      expect(await tableCount(env.t, "sync_run")).toBe(2);

      const revisionOf = async (externalId: string) =>
        selectOne<{ current_revision: RecordId }>(
          env.t.db,
          "SELECT current_revision FROM dialogue WHERE external_id = $id",
          { id: externalId },
        );
      const currentBeforeTruncate = (await revisionOf(BASIC_ID))!.current_revision;

      // --- truncate wire.jsonl (сценарий №9) ---
      const wireContent = await readFile(basicWire(env), "utf8");
      const lines = wireContent.trimEnd().split("\n");
      await writeFile(basicWire(env), lines.slice(0, Math.max(1, lines.length - 2)).join("\n") + "\n");
      const third = await runSync(env.cfg, syncOptions(env));
      expect(third.counters.filesChanged).toBeGreaterThan(0);
      const currentAfterTruncate = (await revisionOf(BASIC_ID))!.current_revision;
      expect(String(currentAfterTruncate)).not.toBe(String(currentBeforeTruncate));
      // старая revision сохранилась; stale tail невозможен — сообщения current
      // принадлежат только ей (§10.5)
      expect(await tableCount(env.t, "dialogue_revision")).toBe(3);
      const msgsCurrent = await selectOne<{ n: number }>(
        env.t.db,
        "SELECT count() AS n FROM message WHERE dialogue_revision = $rev GROUP ALL",
        { rev: currentAfterTruncate },
      );
      const revRow = await selectOne<{ message_count: number }>(
        env.t.db,
        "SELECT message_count FROM ONLY $rev",
        { rev: currentAfterTruncate },
      );
      expect(msgsCurrent?.n).toBe(revRow!.message_count);
      // projection только от current
      const validation1 = await runValidation(env.cfg);
      expect(validation1.issues.filter((i) => i.check === "search_document_not_current")).toHaveLength(0);

      // --- parse error (сценарий №10): битый state.json + wire.jsonl ---
      await writeFile(basicState(env), "{ not json");
      await writeFile(basicWire(env), "garbage line 1\ngarbage line 2\n");
      const fourth = await runSync(env.cfg, syncOptions(env));
      expect(fourth.status).toBe("completed_with_errors");
      expect(fourth.counters.ingestErrors).toBeGreaterThan(0);
      // current диалога НЕ изменился
      const currentAfterError = (await revisionOf(BASIC_ID))!.current_revision;
      expect(String(currentAfterError)).toBe(String(currentAfterTruncate));
      // location: current_revision = новая (parse_error), last_successful = прежняя
      const loc = await selectOne<{
        current_revision: RecordId;
        last_successful_revision: RecordId;
      }>(
        env.t.db,
        `SELECT current_revision, last_successful_revision FROM source_location
         WHERE relative_path = $rel`,
        { rel: `wd_test/${BASIC_ID}/agents/main/wire.jsonl` },
      );
      const badRevision = await selectOne<{ parse_status: string }>(
        env.t.db,
        "SELECT parse_status FROM ONLY $rev",
        { rev: loc!.current_revision },
      );
      expect(badRevision!.parse_status).toBe("parse_error");
      // last_successful — это source_revision, созданная при truncate (parsed)
      const lastOk = await selectOne<{ parse_status: string; sha256: string }>(
        env.t.db,
        "SELECT parse_status, sha256 FROM ONLY $rev",
        { rev: loc!.last_successful_revision },
      );
      expect(lastOk!.parse_status).toBe("parsed");
      expect(String(loc!.last_successful_revision)).not.toBe(String(loc!.current_revision));
      expect(await tableCount(env.t, "ingest_error")).toBeGreaterThan(0);

      // --- deletion (сценарии №4–6) на tools-сессии ---
      const toolsDir = path.join(env.srcRoot, "wd_test", TOOLS_ID);
      const backupDir = path.join(env.srcRoot, "..", "tools-backup");
      await cp(toolsDir, backupDir, { recursive: true });
      await rm(toolsDir, { recursive: true, force: true });
      await runSync(env.cfg, syncOptions(env));
      const presenceOf = async () =>
        (
          await selectAll<{ relative_path: string; presence_status: string }>(
            env.t.db,
            "SELECT relative_path, presence_status FROM source_location",
          )
        ).filter((p) => p.relative_path.includes(TOOLS_ID));
      let presence = await presenceOf();
      expect(presence.length).toBe(3);
      expect(presence.every((p) => p.presence_status === "missing")).toBe(true);
      await runSync(env.cfg, syncOptions(env));
      presence = await presenceOf();
      expect(presence.every((p) => p.presence_status === "deleted_in_source")).toBe(true);
      // canonical данные не удаляются (инвариант №8)
      expect(await tableCount(env.t, "dialogue")).toBe(2);
      // повторное появление → active
      await cp(backupDir, toolsDir, { recursive: true });
      await runSync(env.cfg, syncOptions(env));
      presence = await presenceOf();
      expect(presence.every((p) => p.presence_status === "active")).toBe(true);

      // --- validate: orphan raw (сценарий №12, detect-часть doctor) ---
      const cleanValidation = await runValidation(env.cfg);
      const preExisting = cleanValidation.issues.filter((i) => i.check === "orphan_raw_file");
      expect(preExisting).toHaveLength(0);
      const orphanDir = path.join(env.archiveRoot, "raw", "kimi-code");
      await rm(orphanDir, { recursive: false }).catch(() => {});
      await writeFile(
        path.join(orphanDir, `orphan__${"f".repeat(64)}.jsonl`),
        '{"x":1}\n',
      );
      const validation = await runValidation(env.cfg);
      const orphans = validation.issues.filter((i) => i.check === "orphan_raw_file");
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.detail).toContain("orphan__");
    } finally {
      await env.cleanup();
    }
  });

  testDb("dry-run не пишет ни в БД, ни в raw", async () => {
    const env = await makeSyncEnv();
    try {
      const summary = await runSync(env.cfg, { ...syncOptions(env), dryRun: true });
      expect(summary.counters.filesNew).toBe(5);
      expect(await tableCount(env.t, "sync_run")).toBe(0);
      expect(await tableCount(env.t, "source_revision")).toBe(0);
      expect(await tableCount(env.t, "dialogue")).toBe(0);
      // read-only режим: identity/provenance-записи тоже не создаются
      expect(await tableCount(env.t, "host")).toBe(0);
      expect(await tableCount(env.t, "os_account")).toBe(0);
      expect(await tableCount(env.t, "harness")).toBe(0);
      expect(await tableCount(env.t, "harness_installation")).toBe(0);
      expect(await tableCount(env.t, "source_root")).toBe(0);
      expect(await tableCount(env.t, "source_location")).toBe(0);
      expect(await tableCount(env.t, "source_scan")).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  testDb("head_hash: тот же size/mtime, другое содержимое → новая revision (§10.3)", async () => {
    const env = await makeSyncEnv();
    try {
      await runSync(env.cfg, syncOptions(env));
      const revisionsBefore = await tableCount(env.t, "source_revision");
      const wire = basicWire(env);
      const before = await stat(wire);
      // Меняем один ASCII-байт (длина сохраняется) и возвращаем mtime назад:
      // size/mtime fingerprint совпадает, отличие ловит только head_hash.
      const buf = await readFile(wire);
      const idx = buf.indexOf(0x65); // 'e'
      expect(idx).toBeGreaterThan(0);
      buf[idx] = 0x45; // 'E'
      await writeFile(wire, buf);
      await utimes(wire, before.atime, before.mtime);

      const second = await runSync(env.cfg, syncOptions(env));
      expect(second.counters.filesChanged).toBeGreaterThan(0);
      expect(await tableCount(env.t, "source_revision")).toBe(revisionsBefore + 1);
    } finally {
      await env.cleanup();
    }
  });

  testDb("snapshot failure файла сессии → сессия не пересобирается (§9.3, §23.4)", async () => {
    const env = await makeSyncEnv();
    try {
      const statePath = basicState(env);
      let injectedFailures = 0;
      const summary = await runSync(env.cfg, {
        ...syncOptions(env),
        snapshotSource: async (sourcePath, options) => {
          if (path.resolve(sourcePath) === path.resolve(statePath)) {
            injectedFailures += 1;
            throw new Error("deterministic snapshot fixture failure");
          }
          return snapshotSource(sourcePath, options);
        },
      });
      expect(injectedFailures).toBe(1);
      expect(summary.counters.ingestErrors).toBeGreaterThan(0);
      // Ошибка одного snapshot остаётся локальной к этой сессии, а не
      // превращается в root-level failure, скрывающий соседнюю сессию.
      expect(summary.errors).toEqual([]);
      // Смешанный parse-view не собирался: basic-сессия НЕ распарсена
      // (диалог только от tools-сессии), current_revision её wire-файла
      // не двинулся — честный retry на следующем sync.
      expect(await tableCount(env.t, "dialogue")).toBe(1);
      const toolsDialogue = await selectOne<{ id: RecordId }>(
        env.t.db,
        "SELECT id FROM dialogue WHERE external_id = $id",
        { id: TOOLS_ID },
      );
      expect(toolsDialogue).toBeDefined();
      const loc = await selectOne<{ id: RecordId; current_revision?: RecordId }>(
        env.t.db,
        "SELECT id, current_revision FROM source_location WHERE relative_path = $rel",
        { rel: `wd_test/${BASIC_ID}/agents/main/wire.jsonl` },
      );
      expect(loc).toBeDefined();
      expect(loc!.current_revision ?? null).toBeNull();
      const failedState = await selectOne<{ id: RecordId }>(
        env.t.db,
        "SELECT id FROM source_location WHERE relative_path = $rel",
        { rel: `wd_test/${BASIC_ID}/state.json` },
      );
      const snapshotError = await selectOne<{
        source_record_key?: string;
        error_code: string;
        resolved_at?: Date;
      }>(
        env.t.db,
        `SELECT source_record_key, error_code, resolved_at FROM ingest_error
         WHERE stage = "snapshot" LIMIT 1`,
      );
      expect(snapshotError).toEqual(expect.objectContaining({
        source_record_key: failedState!.id.toString(),
        error_code: "snapshot_exception",
      }));
      expect(snapshotError!.resolved_at).toBeUndefined();
      // После восстановления доступа сессия собирается и парсится.
      const retry = await runSync(env.cfg, syncOptions(env));
      expect(retry.status).toBe("completed");
      expect(await tableCount(env.t, "dialogue")).toBe(2);
      const resolvedSnapshotError = await selectOne<{
        resolved_at?: Date;
        resolution?: string;
      }>(
        env.t.db,
        `SELECT resolved_at, resolution FROM ingest_error
         WHERE stage = "snapshot" LIMIT 1`,
      );
      expect(resolvedSnapshotError?.resolved_at).toBeDefined();
      expect(resolvedSnapshotError?.resolution).toBe("resync:snapshot_succeeded");
    } finally {
      await env.cleanup();
    }
  });

  testDb("observed mtime survives raw SHA reuse without losing retry", async () => {
    const env = await makeSyncEnv();
    try {
      await runSync(env.cfg, syncOptions(env));
      const file = basicWire(env);
      const before = await stat(file);
      await utimes(file, before.atime, new Date(before.mtimeMs + 5000));
      const touched = await runSync(env.cfg, syncOptions(env));
      expect(touched.counters.filesChanged).toBe(1);
      expect(touched.counters.revisionsCreated).toBe(0);
      const repeat = await runSync(env.cfg, syncOptions(env));
      expect(repeat.counters.filesChanged).toBe(0);
      const loc = await selectOne<{current_revision: RecordId}>(env.t.db,
        "SELECT current_revision FROM source_location WHERE relative_path = $path",
        {path: `wd_test/${BASIC_ID}/agents/main/wire.jsonl`});
      await updateSourceRevisionParse(env.t.db, loc!.current_revision, {parseStatus: "partial"});
      const snapshots: string[] = [];
      const retry = await runSync(env.cfg, {
        ...syncOptions(env),
        snapshotSource: async (file, options) => {
          snapshots.push(file);
          return snapshotSource(file, options);
        },
      });
      expect(retry.counters.filesChanged).toBe(1);
      expect(retry.counters.dialoguesWritten).toBe(1);
      expect(snapshots).toEqual([]);
    } finally { await env.cleanup(); }
  });

  testDb("completed SQLite roots stay cached after interruption before the next root", async () => {
    const env = await makeSyncEnv();
    try {
      const files = ["first.db", "second.db"].map((name) => path.join(env.srcRoot, name));
      for (const file of files) {
        const source = new Database(file);
        source.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('one')");
        source.close();
      }
      env.cfg.sourceOverrides.codex = files;
      const child = Bun.spawn([process.execPath, "-e", `
        import { runSync } from ${JSON.stringify(new URL("../src/sync/sync-run.ts", import.meta.url).href)};
        const { cfg, options } = JSON.parse(await Bun.stdin.text());
        await runSync(cfg, { ...options, logger: () => {}, onProgress: (progress) => {
          if (progress.detail === "Подготовка источника" && progress.rootsCompleted === 1) process.exit(77);
        } });
      `], {
        stdin: new Blob([JSON.stringify({
          cfg: env.cfg,
          options: { ...syncOptions(env), harness: "codex" },
        })]),
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(77);
      const snapshots: string[] = [];
      const resumed = await runSync(env.cfg, {
        ...syncOptions(env),
        harness: "codex",
        snapshotSource: async (file, options) => {
          snapshots.push(file);
          return snapshotSource(file, options);
        },
      });
      expect(snapshots).toEqual([files[1]!]);
      expect(resumed.counters.filesChanged).toBe(0);
      expect(resumed.counters.filesNew).toBe(1);
    } finally { await env.cleanup(); }
  });

  testDb("SQLite repeat sync skips VACUUM but WAL-only commits are captured", async () => {
    const env = await makeSyncEnv();
    const file = path.join(env.srcRoot, "source.db");
    const source = new Database(file);
    try {
      source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('one')");
      env.cfg.sourceOverrides.codex = [file];
      let snapshots = 0;
      const options = { ...syncOptions(env), harness: "codex" as const,
        snapshotSource: async (...args: Parameters<typeof snapshotSource>) => {
          snapshots += 1;
          return snapshotSource(...args);
        } };
      await runSync(env.cfg, options);
      snapshots = 0;
      const repeat = await runSync(env.cfg, options);
      expect(repeat.counters.filesChanged).toBe(0);
      expect(snapshots).toBe(0);
      const before = await stat(file);
      source.exec("INSERT INTO sample VALUES ('two')");
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
      const changed = await runSync(env.cfg, options);
      expect(changed.counters.filesChanged).toBe(1);
      expect(changed.counters.revisionsCreated).toBe(1);
      expect(snapshots).toBe(1);
      const again = await runSync(env.cfg, options);
      expect(again.counters.filesChanged).toBe(0);
      const metadata = await stat(file);
      await utimes(file, metadata.atime, new Date(metadata.mtimeMs + 5000));
      const touched = await runSync(env.cfg, options);
      expect(touched.counters.filesChanged).toBe(1);
      expect(touched.counters.revisionsCreated).toBe(0);
      // Same raw + current pipeline must not create another unsupported diagnostic.
      expect(touched.counters.ingestErrors).toBe(0);
      expect(snapshots).toBe(2);
      expect((await runSync(env.cfg, options)).counters.filesChanged).toBe(0);
    } finally { source.close(); await env.cleanup(); }
  });

  testDb("duplicate hash reuse recognizes hardlinks but rejects same-size mutations", async () => {
    const env = await makeSyncEnv();
    try {
      const native = path.join(env.srcRoot, "native");
      const orca = path.join(env.srcRoot, "Library/Application Support/orca/codex-runtime-home/home/sessions");
      await mkdir(native, {recursive: true});
      await mkdir(orca, {recursive: true});
      const file = path.join(native, "sample.jsonl");
      await writeFile(file, "first");
      await link(file, path.join(orca, "sample.jsonl"));
      env.cfg.sourceOverrides.codex = [native, orca];
      const events: Record<string, unknown>[] = [];
      const options = {...syncOptions(env), harness: "codex" as const, dryRun: true,
        logger: (event: Record<string, unknown>) => { events.push(event); }};
      const first = await runSync(env.cfg, options);
      expect(first.counters.filesDuplicateSkipped).toBe(1);
      expect(events.find(e => e.event === "source_duplicate_filter")?.physicalCacheHits).toBe(1);
      expect(events.find(e => e.event === "source_duplicate_filter")?.bytesHashed).toBe(0);
      const changed = await runSync(env.cfg, {...options, logger: (event) => {
        if (event.event === "source_duplicate_index") writeFileSync(file, "other");
      }});
      expect(changed.counters.filesDuplicateSkipped).toBe(0);
      expect(changed.counters.filesSeen).toBe(2);
      const copy = path.join(orca, "copy.jsonl");
      await cp(file, copy);
      const copied = await runSync(env.cfg, options);
      expect(copied.counters.filesDuplicateSkipped).toBe(2);
      // A distinct inode with identical metadata is not proof of identical bytes.
      const metadata = await stat(copy);
      await writeFile(copy, "third");
      await utimes(copy, metadata.atime, metadata.mtime);
      const diverged = await runSync(env.cfg, options);
      expect(diverged.counters.filesDuplicateSkipped).toBe(1);
      expect(diverged.counters.filesSeen).toBe(2);
    } finally { await env.cleanup(); }
  });

  testDb("stable malformed JSONL retries parsing without recapturing raw", async () => {
    const env = await makeSyncEnv();
    try {
      const file = path.join(env.srcRoot, "session.jsonl");
      const valid = await readFile(path.join(import.meta.dir, "fixtures/codex/basic-dialogue.jsonl"), "utf8");
      await writeFile(file, `${valid}\n{`);
      env.cfg.sourceOverrides.codex = [file];
      let snapshots = 0;
      const options = { ...syncOptions(env), harness: "codex" as const,
        snapshotSource: async (...args: Parameters<typeof snapshotSource>) => {
          snapshots += 1;
          return snapshotSource(...args);
        } };
      const first = await runSync(env.cfg, options);
      expect(first.status).toBe("completed_with_errors");
      expect(first.counters.dialoguesWritten).toBe(1);
      expect(snapshots).toBe(1);
      const retry = await runSync(env.cfg, options);
      expect(retry.status).toBe("completed_with_errors");
      expect(retry.counters.ingestErrors).toBeGreaterThan(0);
      expect(retry.counters.dialoguesWritten).toBe(1);
      expect(snapshots).toBe(1);
      await writeFile(file, valid);
      const repaired = await runSync(env.cfg, options);
      expect(repaired.status).toBe("completed");
      expect(snapshots).toBe(2);
    } finally { await env.cleanup(); }
  });

  testDb("stable SQLite parse errors retry without VACUUM and missing raw is recaptured", async () => {
    const env = await makeSyncEnv();
    try {
      const file = path.join(env.srcRoot, "source.db");
      const source = new Database(file);
      source.exec("CREATE TABLE sample (value TEXT)");
      source.close();
      env.cfg.sourceOverrides.opencode = [file];
      let snapshots = 0;
      const options = { ...syncOptions(env), harness: "opencode" as const,
        snapshotSource: async (...args: Parameters<typeof snapshotSource>) => {
          snapshots += 1;
          return snapshotSource(...args);
        } };
      expect((await runSync(env.cfg, options)).status).toBe("completed_with_errors");
      expect(snapshots).toBe(1);
      expect((await runSync(env.cfg, options)).counters.ingestErrors).toBeGreaterThan(0);
      expect(snapshots).toBe(1);
      const revision = await selectOne<{raw_archive_path: string}>(env.t.db,
        "SELECT raw_archive_path FROM source_revision LIMIT 1");
      await rm(path.join(env.archiveRoot, revision!.raw_archive_path));
      expect((await runSync(env.cfg, options)).counters.ingestErrors).toBeGreaterThan(0);
      expect(snapshots).toBe(2);
    } finally { await env.cleanup(); }
  });

  testDb("capture checkpoint survives interruption while reparsing an existing SQLite revision", async () => {
    const env = await makeSyncEnv();
    try {
      const file = path.join(env.srcRoot, "source.db");
      const db = new Database(file);
      db.exec("CREATE TABLE sample (value TEXT)");
      db.close();
      env.cfg.sourceOverrides.codex = [file];
      const options = { ...syncOptions(env), harness: "codex" as const };
      const initial = await runSync(env.cfg, options);
      await rm(path.join(path.dirname(env.cfg.dbRoot), "sync-cache"), { recursive: true, force: true });
      const child = Bun.spawn([process.execPath, "-e", `
        import { runSync } from ${JSON.stringify(new URL("../src/sync/sync-run.ts", import.meta.url).href)};
        const { cfg, options } = JSON.parse(await Bun.stdin.text());
        await runSync(cfg, { ...options, logger: () => {}, onProgress: (progress) => {
          if (progress.detail === "Чтение диалогов") process.exit(77);
        } });
      `], {
        stdin: new Blob([JSON.stringify({ cfg: env.cfg, options })]),
        stdout: "ignore", stderr: "pipe",
      });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(77);
      let snapshots = 0;
      const resumed = await runSync(env.cfg, { ...options,
        snapshotSource: async (...args: Parameters<typeof snapshotSource>) => {
          snapshots += 1;
          return snapshotSource(...args);
        } });
      expect(resumed.status).toBe(initial.status);
      expect(snapshots).toBe(0);
      expect(resumed.counters.revisionsCreated).toBe(0);
    } finally { await env.cleanup(); }
  });

  testDb("recognized Claude history is archived once, while corrupt records remain errors", async () => {
    const env = await makeSyncEnv();
    try {
      const file = path.join(env.srcRoot, "history.jsonl");
      const history = JSON.stringify({ display: "Synthetic prompt", timestamp: 1783400001000 }) + "\n";
      await writeFile(file, history);
      env.cfg.sourceOverrides["claude-code"] = [file];
      let snapshots = 0;
      const options = { ...syncOptions(env), harness: "claude-code" as const,
        snapshotSource: async (...args: Parameters<typeof snapshotSource>) => {
          snapshots += 1;
          return snapshotSource(...args);
        } };
      const first = await runSync(env.cfg, options);
      expect(first.status).toBe("completed");
      expect(first.counters.revisionsCreated).toBe(1);
      expect(first.counters.dialoguesWritten).toBe(0);
      expect((await runSync(env.cfg, options)).status).toBe("completed");
      expect(snapshots).toBe(1);
      await writeFile(file, `${history}{`);
      const malformed = await runSync(env.cfg, options);
      expect(malformed.status).toBe("completed_with_errors");
      expect(malformed.counters.ingestErrors).toBeGreaterThan(0);
      expect(snapshots).toBe(2);
    } finally { await env.cleanup(); }
  });

  testDb("last_successful_revision очищается при parse_error re-parse + validate (§23.3)", async () => {
    const env = await makeSyncEnv();
    try {
      await runSync(env.cfg, syncOptions(env));
      const rel = `wd_test/${BASIC_ID}/agents/main/wire.jsonl`;
      const loc = await selectOne<{
        id: RecordId;
        current_revision: RecordId;
        last_successful_revision: RecordId;
      }>(
        env.t.db,
        "SELECT id, current_revision, last_successful_revision FROM source_location WHERE relative_path = $rel",
        { rel },
      );
      expect(loc).toBeDefined();
      expect(String(loc!.last_successful_revision)).toBe(String(loc!.current_revision));

      // Re-parse той же revision завершился ошибкой (--full-rescan, фикс
      // parser'а): parse_status → parse_error, location перепривязан без
      // last_successful → указатель на failed revision очищается.
      await updateSourceRevisionParse(env.t.db, loc!.current_revision, {
        parseStatus: "parse_error",
      });
      await setLocationRevisions(env.t.db, loc!.id, { currentRevision: loc!.current_revision });
      const cleared = await selectOne<{ last_successful_revision?: RecordId }>(
        env.t.db,
        "SELECT last_successful_revision FROM ONLY $id",
        { id: loc!.id },
      );
      expect(cleared!.last_successful_revision ?? null).toBeNull();

      // validate находит указатели на revision без успешного parse.
      await env.t.db.query("UPDATE $id SET last_successful_revision = $rev", {
        id: loc!.id,
        rev: loc!.current_revision,
      });
      const report = await runValidation(env.cfg);
      const bad = report.issues.filter((i) => i.check === "last_successful_not_parsed");
      expect(bad).toHaveLength(1);
      expect(bad[0]!.detail).toContain(rel);
    } finally {
      await env.cleanup();
    }
  });
});
