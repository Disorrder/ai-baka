/**
 * Integration-тесты транзакции диалога (этап 5, docs/plan.md §10.4) на живом
 * SurrealDB: полная запись, идемпотентность (§19.2 №1), rollback при ошибке,
 * переключение current revision (№9/№10), os_account на разных host (№15),
 * external id на разных installation не мержится (№16), embedding jobs.
 */

import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
  ensureModel,
  ensureOsAccount,
  ensureVendor,
  ensureWorkspace,
} from "../src/db/repositories/identity.ts";
import {
  createSyncRun,
  ensureSourceLocation,
  ensureSourceRevision,
  ensureSourceRoot,
} from "../src/db/repositories/provenance.ts";
import {
  primaryModelKey,
  writeDialogueRevision,
  type DialogueTxInput,
} from "../src/db/repositories/corpus.ts";
import { dialogueIdentityKey } from "../src/domain/identity.ts";
import { kimiCodeExtractors } from "../src/search/extractors/kimi-code.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import { createTestDb, dbTest, dropTestDb, type TestDb } from "./db-test-utils.ts";

// Явный skip в отчёте, если SurrealDB недоступен (вместо молчаливого pass).
const testDb = await dbTest();

function makeDialogue(externalId: string, assistantText = "Ответ ассистента."): ParsedDialogue {
  return {
    externalId,
    title: "Тестовый диалог",
    workspace: { path: "/tmp/project", name: "project" },
    startedAt: new Date("2026-07-20T10:00:00Z"),
    updatedAt: new Date("2026-07-20T10:05:00Z"),
    messages: [
      {
        sequence: 0,
        role: "user",
        rawRole: "turn.prompt",
        humanAuthored: true,
        visibleToUser: true,
        timestamp: new Date("2026-07-20T10:00:00Z"),
        usageEvents: [],
        chunks: [
          { sequence: 0, kind: "text", rawKind: "text", content: "Вопрос пользователя", metadata: {} },
        ],
        metadata: { origin: { kind: "user" } },
      },
      {
        sequence: 1,
        role: "assistant",
        rawRole: "assistant",
        humanAuthored: false,
        visibleToUser: true,
        timestamp: new Date("2026-07-20T10:01:00Z"),
        model: {
          rawModelName: "kimi-code/k3",
          vendor: "moonshot",
          canonicalName: "k3",
          reasoningEffort: "high",
          serviceProvider: "kimi",
        },
        usageEvents: [
          { scope: "request", inputTokens: 100, outputTokens: 50, source: "test", raw: { i: 100 } },
        ],
        chunks: [
          { sequence: 0, kind: "thought", rawKind: "think", content: "думаю", metadata: {} },
          { sequence: 1, kind: "text", rawKind: "text", content: assistantText, metadata: {} },
        ],
        metadata: {},
      },
    ],
    metadata: {},
  };
}

interface Ctx {
  host: RecordId;
  osAccount: RecordId;
  installation: RecordId;
  sourceRevision: RecordId;
  modelIds: Map<string, RecordId>;
}

async function makeCtx(t: TestDb, hostUuid: string): Promise<Ctx> {
  const host = await ensureHost(t.db, {
    hostUuid,
    hostname: "test-host",
    platform: "darwin",
    arch: "arm64",
  });
  const osAccount = await ensureOsAccount(t.db, {
    host,
    osUsername: "example",
    homePath: "/Users/example",
  });
  const harness = await ensureHarness(t.db, {
    slug: "kimi-code",
    displayName: "Kimi Code",
    kind: "file_tree",
  });
  const installation = await ensureHarnessInstallation(t.db, {
    host,
    harness,
    installed: true,
  });
  const syncRun = await createSyncRun(t.db, {
    kind: "live_sync",
    host,
    bakaCommit: "test",
    schemaVersion: 4,
  });
  const root = await ensureSourceRoot(t.db, {
    harnessInstallation: installation,
    path: "/tmp/sessions",
    sourceKind: "file_tree",
    parserName: "kimi-code",
    snapshotStrategy: "copy",
    enabled: true,
  });
  const location = await ensureSourceLocation(t.db, {
    sourceRoot: root,
    relativePath: "wd_x/session_1/agents/main/wire.jsonl",
    originalPath: "/tmp/sessions/wd_x/session_1/agents/main/wire.jsonl",
    basename: "wire.jsonl",
  });
  const sourceRevision = await ensureSourceRevision(t.db, {
    sourceLocation: location.id,
    sha256: "a".repeat(64),
    sizeBytes: 100,
    mtimeMs: 1000,
    rawArchivePath: "raw/kimi-code/wire__aaa.jsonl",
    snapshotKind: "regular_copy",
    parserName: "kimi-code",
    parserVersion: 1,
    syncRun,
  });
  const vendor = await ensureVendor(t.db, "moonshot");
  const model = await ensureModel(t.db, { vendor, canonicalName: "k3", rawName: "kimi-code/k3" });
  return {
    host,
    osAccount,
    installation,
    sourceRevision: sourceRevision.id,
    modelIds: new Map([["moonshot/k3", model]]),
  };
}

function txInput(
  ctx: Ctx,
  dialogue: ParsedDialogue,
  identityKey: string,
  workspace?: RecordId,
): DialogueTxInput {
  return {
    identityKey,
    harnessInstallation: ctx.installation,
    osAccount: ctx.osAccount,
    workspace,
    sourceRevision: ctx.sourceRevision,
    sourceDialogueId: dialogue.externalId ?? "fallback",
    parserName: "kimi-code",
    parserVersion: 1,
    parsed: dialogue,
    extractors: kimiCodeExtractors,
    modelIds: ctx.modelIds,
    activeEmbeddingSpaces: [],
    enqueueEmbeddings: true,
  };
}

async function tableCount(t: TestDb, table: string): Promise<number> {
  const row = await selectOne<{ n: number }>(t.db, `SELECT count() AS n FROM ${table} GROUP ALL`);
  return row?.n ?? 0;
}

describe("dialogue transaction (integration)", () => {
  testDb("сценарий 15: два host с username example → два os_account", async () => {
    const t = await createTestDb();
    try {
      const ctx1 = await makeCtx(t, "host-uuid-1");
      const ctx2 = await makeCtx(t, "host-uuid-2");
      expect(ctx1.osAccount.toString()).not.toBe(ctx2.osAccount.toString());
      expect(await tableCount(t, "os_account")).toBe(2);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("сценарий 16: один external id на разных installation не мержится", async () => {
    const t = await createTestDb();
    try {
      const ctx1 = await makeCtx(t, "host-uuid-1");
      const ctx2 = await makeCtx(t, "host-uuid-2");
      const dialogue = makeDialogue("session_shared");
      const key1 = dialogueIdentityKey(ctx1.installation.toString(), "session_shared", "fb");
      const key2 = dialogueIdentityKey(ctx2.installation.toString(), "session_shared", "fb");
      expect(key1).not.toBe(key2);
      await writeDialogueRevision(t.db, txInput(ctx1, dialogue, key1));
      await writeDialogueRevision(t.db, txInput(ctx2, dialogue, key2));
      expect(await tableCount(t, "dialogue")).toBe(2);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("полная запись: dialogue/revision/messages/chunks/search docs, идемпотентность (№1)", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t, "host-uuid-1");
      const dialogue = makeDialogue("session_full");
      const key = dialogueIdentityKey(ctx.installation.toString(), "session_full", "fb");
      // workspace в реальном потоке подключает ingestor (ensureWorkspace)
      const workspace = await ensureWorkspace(t.db, {
        host: ctx.host,
        path: "/tmp/project",
        name: "project",
      });

      const first = await writeDialogueRevision(t.db, txInput(ctx, dialogue, key, workspace));
      expect(first.created).toBe(true);
      expect(first.messageCount).toBe(2);
      expect(first.chunkCount).toBe(3);
      expect(first.searchDocumentCount).toBe(2); // user_prompt + assistant_final
      expect(first.embeddingJobCount).toBe(0); // нет active space

      const dlg = await selectOne<{
        current_revision: RecordId;
        primary_model: RecordId;
        title: string;
        workspace: RecordId;
      }>(
        t.db,
        "SELECT current_revision, primary_model, title, workspace FROM dialogue WHERE identity_key = $k",
        { k: key },
      );
      expect(dlg).toBeDefined();
      expect(String(dlg!.current_revision)).toBe(String(first.revisionId));
      expect(dlg!.title).toBe("Тестовый диалог");
      expect(dlg!.workspace).toBeDefined();
      expect(dlg!.primary_model).toBeDefined();

      // usage нормализован; thought-чанк сохранён
      // `usage` — keyword в SurrealQL, поле читаем через SELECT *
      const messages = await selectAll<{ role: string; usage?: { scope: string } }>(
        t.db,
        "SELECT * FROM message ORDER BY sequence",
      );
      expect(messages).toHaveLength(2);
      expect(messages[1]!.usage?.scope).toBe("request");
      const kinds = await selectAll<{ kind: string }>(
        t.db,
        "SELECT kind FROM chunk ORDER BY kind",
      );
      expect(kinds.map((k) => k.kind).sort()).toEqual(["text", "text", "thought"].sort());

      const docs = await selectAll<{ document_type: string; content: string }>(
        t.db,
        "SELECT document_type, content FROM search_document",
      );
      expect(docs.map((d) => d.document_type).sort()).toEqual(["assistant_final", "user_prompt"]);
      expect(docs.find((d) => d.document_type === "user_prompt")!.content).toContain("Вопрос");
      expect(docs.find((d) => d.document_type === "assistant_final")!.content).toBe("Ответ ассистента.");

      // Повторная запись: ничего нового (сценарий №1).
      const countsBefore = {
        dialogue: await tableCount(t, "dialogue"),
        revision: await tableCount(t, "dialogue_revision"),
        message: await tableCount(t, "message"),
        chunk: await tableCount(t, "chunk"),
        sdoc: await tableCount(t, "search_document"),
      };
      const second = await writeDialogueRevision(t.db, txInput(ctx, dialogue, key));
      expect(second.created).toBe(false);
      expect(second.switched).toBe(false);
      expect(await tableCount(t, "dialogue")).toBe(countsBefore.dialogue);
      expect(await tableCount(t, "dialogue_revision")).toBe(countsBefore.revision);
      expect(await tableCount(t, "message")).toBe(countsBefore.message);
      expect(await tableCount(t, "chunk")).toBe(countsBefore.chunk);
      expect(await tableCount(t, "search_document")).toBe(countsBefore.sdoc);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("rollback: ошибка в середине транзакции не оставляет частичных записей", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t, "host-uuid-1");
      const broken = makeDialogue("session_broken");
      // sequence дробный → coercion error в int-поле на 2-м сообщении,
      // т.е. ПОСЛЕ создания dialogue/revision/первого message.
      broken.messages[1]!.sequence = 1.5;
      const key = dialogueIdentityKey(ctx.installation.toString(), "session_broken", "fb");
      await expect(writeDialogueRevision(t.db, txInput(ctx, broken, key))).rejects.toThrow();
      expect(await tableCount(t, "dialogue")).toBe(0);
      expect(await tableCount(t, "dialogue_revision")).toBe(0);
      expect(await tableCount(t, "message")).toBe(0);
      expect(await tableCount(t, "chunk")).toBe(0);
      expect(await tableCount(t, "search_document")).toBe(0);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("сценарий 9: укоротившийся диалог — новая revision без stale tail, projection переключена", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t, "host-uuid-1");
      const key = dialogueIdentityKey(ctx.installation.toString(), "session_short", "fb");

      const v1 = makeDialogue("session_short", "Длинный ответ, версия 1");
      // Третье сообщение — «хвост», который исчезнет в v2.
      v1.messages.push({
        sequence: 2,
        role: "user",
        humanAuthored: true,
        visibleToUser: true,
        usageEvents: [],
        chunks: [{ sequence: 0, kind: "text", content: "Уточнение", metadata: {} }],
        metadata: {},
      });
      const first = await writeDialogueRevision(t.db, txInput(ctx, v1, key));
      expect(first.created).toBe(true);

      const v2 = makeDialogue("session_short", "Короткий ответ, версия 2");
      const second = await writeDialogueRevision(t.db, txInput(ctx, v2, key));
      expect(second.created).toBe(true);
      expect(second.revisionId.toString()).not.toBe(first.revisionId.toString());

      // current переключён; обе revision в базе; stale messages не в current.
      const dlg = await selectOne<{ current_revision: RecordId }>(
        t.db,
        "SELECT current_revision FROM dialogue WHERE identity_key = $k",
        { k: key },
      );
      expect(String(dlg!.current_revision)).toBe(String(second.revisionId));
      expect(await tableCount(t, "dialogue_revision")).toBe(2);
      const currentMessages = await selectAll<{ n: number }>(
        t.db,
        "SELECT count() AS n FROM message WHERE dialogue_revision = $rev GROUP ALL",
        { rev: second.revisionId },
      );
      expect(currentMessages[0]?.n ?? 0).toBe(2);

      // projection только от current revision
      const stale = await selectAll<{ id: RecordId }>(
        t.db,
        "SELECT id FROM search_document WHERE dialogue_revision != dialogue.current_revision",
      );
      expect(stale).toHaveLength(0);

      // Возврат к содержимому v1: revision переиспользуется, projection пересоздаётся.
      const third = await writeDialogueRevision(t.db, txInput(ctx, v1, key));
      expect(third.created).toBe(false);
      expect(third.switched).toBe(true);
      expect(await tableCount(t, "dialogue_revision")).toBe(2);
      expect(await tableCount(t, "message")).toBe(5); // 3 + 2, дублей нет
      const docsNow = await selectAll<{ dialogue_revision: RecordId }>(
        t.db,
        "SELECT dialogue_revision FROM search_document",
      );
      for (const doc of docsNow) {
        expect(String(doc.dialogue_revision)).toBe(String(first.revisionId));
      }
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("embedding jobs создаются только при active embedding_space", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t, "host-uuid-1");
      await t.db.query(
        `CREATE ONLY embedding_space SET slug = "openai-small", provider = "openai",
           model = "text-embedding-3-small", dimensions = 1536, distance = "cosine",
           vector_type = "f32", segmentation_version = "0", active = true,
           physical_table = "search_embedding_openai_small", created_at = time::now()`,
      );
      const space = await selectOne<{ id: RecordId }>(t.db, "SELECT id FROM embedding_space");
      const dialogue = makeDialogue("session_jobs");
      const key = dialogueIdentityKey(ctx.installation.toString(), "session_jobs", "fb");
      const input = txInput(ctx, dialogue, key);
      input.activeEmbeddingSpaces = [space!.id];
      const result = await writeDialogueRevision(t.db, input);
      expect(result.embeddingJobCount).toBe(2); // user_prompt + assistant_final
      const jobs = await selectAll<{ status: string; input_sha256: string }>(
        t.db,
        "SELECT status, input_sha256 FROM embedding_job",
      );
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => j.status === "pending")).toBe(true);
      expect(jobs.every((j) => j.input_sha256.length === 64)).toBe(true);
    } finally {
      await dropTestDb(t);
    }
  });

  test("primary_model: самая частая модель assistant messages", () => {
    const dialogue = makeDialogue("x");
    expect(primaryModelKey(dialogue)).toBe("moonshot/k3");
    const empty = makeDialogue("y");
    empty.messages = empty.messages.filter((m) => m.role !== "assistant");
    expect(primaryModelKey(empty)).toBeUndefined();
  });

  testDb("primary_model очищается (NONE) при revision без модели", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t, "host-uuid-1");
      const key = dialogueIdentityKey(ctx.installation.toString(), "session_nomodel", "fb");
      const primaryModelOf = async () =>
        (
          await selectOne<{ primary_model?: RecordId }>(
            t.db,
            "SELECT primary_model FROM dialogue WHERE identity_key = $k",
            { k: key },
          )
        )?.primary_model;

      const withModel = makeDialogue("session_nomodel");
      await writeDialogueRevision(t.db, txInput(ctx, withModel, key));
      expect(await primaryModelOf()).toBeDefined();

      // Та же сессия, но assistant message без модели → новая revision;
      // primary_model обязан очиститься, а не сохранить прежнюю модель.
      const noModel = makeDialogue("session_nomodel", "Другой ответ");
      delete noModel.messages[1]!.model;
      const second = await writeDialogueRevision(t.db, txInput(ctx, noModel, key));
      expect(second.created).toBe(true);
      expect((await primaryModelOf()) ?? null).toBeNull();

      // Switch-путь: возврат к revision с моделью и обратно.
      const backToModel = await writeDialogueRevision(t.db, txInput(ctx, withModel, key));
      expect(backToModel.switched).toBe(true);
      expect(await primaryModelOf()).toBeDefined();
      const backToNoModel = await writeDialogueRevision(t.db, txInput(ctx, noModel, key));
      expect(backToNoModel.switched).toBe(true);
      expect((await primaryModelOf()) ?? null).toBeNull();
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("ensureWorkspace: workspace+location одной транзакцией, повтор идемпотентен", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t, "host-uuid-1");
      const ws1 = await ensureWorkspace(t.db, {
        host: ctx.host,
        path: "/tmp/proj-a",
        name: "proj-a",
        repositoryIdentity: "git@x:proj-a",
      });
      expect(ws1).toBeDefined();
      // Обе записи созданы вместе (orphan workspace невозможен).
      expect(await tableCount(t, "workspace")).toBe(1);
      expect(await tableCount(t, "workspace_location")).toBe(1);
      const ws2 = await ensureWorkspace(t.db, {
        host: ctx.host,
        path: "/tmp/proj-a",
        repositoryIdentity: "git@x:proj-a",
      });
      expect(String(ws2)).toBe(String(ws1));
      expect(await tableCount(t, "workspace")).toBe(1);
      expect(await tableCount(t, "workspace_location")).toBe(1);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("ensureWorkspace: конфликт ключей — repository_identity побеждает path", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t, "host-uuid-1");
      const byRepo = await ensureWorkspace(t.db, {
        host: ctx.host,
        repositoryIdentity: "git@x:proj",
        name: "proj",
      });
      const byPath = await ensureWorkspace(t.db, { host: ctx.host, path: "/tmp/proj", name: "proj" });
      // Два независимых workspace: один по repo, другой по path.
      expect(String(byRepo)).not.toBe(String(byPath));
      // Оба ключа в одном вызове: побеждает repository_identity (главный
      // ключ проекта), location перелинковывается на него.
      const resolved = await ensureWorkspace(t.db, {
        host: ctx.host,
        path: "/tmp/proj",
        repositoryIdentity: "git@x:proj",
      });
      expect(String(resolved)).toBe(String(byRepo));
      const locRow = await selectOne<{ workspace: RecordId }>(
        t.db,
        "SELECT workspace FROM workspace_location",
      );
      expect(String(locRow!.workspace)).toBe(String(byRepo));
      // Детерминированно: повтор даёт тот же результат, новых записей нет.
      const again = await ensureWorkspace(t.db, {
        host: ctx.host,
        path: "/tmp/proj",
        repositoryIdentity: "git@x:proj",
      });
      expect(String(again)).toBe(String(byRepo));
      expect(await tableCount(t, "workspace")).toBe(2);
      expect(await tableCount(t, "workspace_location")).toBe(1);
    } finally {
      await dropTestDb(t);
    }
  });
});
