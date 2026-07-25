/**
 * Integration-тесты structured sync (этап 5, docs/plan.md §10) на живом
 * SurrealDB и фейковых source root'ах из tests/fixtures (temp dirs; живые
 * источники не трогаются).
 *
 * Сценарии §19.2: №1 (второй sync пустой), №4–6 (missing → deleted →
 * active), №9 (укоротившийся файл), №10 (parse error не меняет current),
 * №12 (orphan raw находит validate).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordId } from "surrealdb";
import type { AppConfig } from "../src/config.ts";
import { runSync, type SyncSummary } from "../src/sync/sync-run.ts";
import { runValidation } from "../src/validate.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import {
  SURREAL_PASS,
  SURREAL_URL,
  SURREAL_USER,
  TEST_NAMESPACE,
  createTestDb,
  dropTestDb,
  isDbAvailable,
  type TestDb,
} from "./db-test-utils.ts";

const FIXTURES = path.resolve(import.meta.dir, "fixtures/kimi-code");
const BASIC_ID = "session_11111111-aaaa-4bbb-8ccc-111111111111";
const TOOLS_ID = "session_22222222-bbbb-4ccc-8ddd-222222222222";

let dbReady = false;
beforeAll(async () => {
  dbReady = await isDbAvailable();
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
    surrealUrl: SURREAL_URL,
    surrealUser: SURREAL_USER,
    surrealPass: SURREAL_PASS,
    surrealNamespace: TEST_NAMESPACE,
    surrealDatabase: t.name,
    minFreeBytes: 0,
    deletionConfirmations: 2,
    sourceOverrides: { "kimi-code": [srcRoot] },
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
  test("полный цикл: первый sync, идемпотентность (№1), truncate (№9), parse error (№10), deletion (№4–6), orphan raw (№12)", async () => {
    if (!dbReady) return;
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

  test("dry-run не пишет ни в БД, ни в raw", async () => {
    if (!dbReady) return;
    const env = await makeSyncEnv();
    try {
      const summary = await runSync(env.cfg, { ...syncOptions(env), dryRun: true });
      expect(summary.counters.filesNew).toBe(5);
      expect(await tableCount(env.t, "sync_run")).toBe(0);
      expect(await tableCount(env.t, "source_revision")).toBe(0);
      expect(await tableCount(env.t, "dialogue")).toBe(0);
    } finally {
      await env.cleanup();
    }
  });
});
