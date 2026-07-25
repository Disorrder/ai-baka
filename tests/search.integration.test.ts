/**
 * Integration-тесты full-text search (этап 6, docs/plan.md §12, §14) на
 * живом SurrealDB: BM25 по search_document находит известные фразы,
 * фильтры работают, сегментированный длинный документ находится по фразе
 * из середины, старые revisions не в обычной выдаче, reasoning/tool —
 * только через forensic mode, rebuild пересоздаёт projection.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import type { ParsedDialogue, ParsedMessage } from "../src/domain/canonical-types.ts";
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
import { writeDialogueRevision, type DialogueTxInput } from "../src/db/repositories/corpus.ts";
import { dialogueIdentityKey } from "../src/domain/identity.ts";
import { kimiCodeExtractors } from "../src/search/extractors/kimi-code.ts";
import { isForensic, searchForensic, searchText, type SearchFilters } from "../src/search/fulltext.ts";
import { rebuildSearchProjection } from "../src/search/rebuild.ts";
import { SEGMENTATION_VERSION } from "../src/search/segmenter.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import { createTestDb, dropTestDb, isDbAvailable, type TestDb } from "./db-test-utils.ts";

let dbReady = false;
beforeAll(async () => {
  dbReady = await isDbAvailable();
});

const USER_PHRASE = "запечённые яблоки с корицей";
const MIDDLE_MARKER = "срединный маркер абракадабра";
const OLD_PHRASE = "старая уникальная фраза первой версии";
const REASONING_MARKER = "тайное рассуждение ксиволь";
const TOOL_MARKER = "результат инструмента йолопуки";

/** Длинный текст > TARGET токенов с маркером в середине (проверка §13.4). */
function longAssistantText(marker: string): string {
  const paragraphs: string[] = [];
  for (let i = 0; i < 20; i++) {
    paragraphs.push(`Раздел ${i}. ${"подробное объяснение архитектуры ".repeat(60)}`);
    if (i === 10) paragraphs.push(`Вот здесь находится ${marker} посередине документа.`);
  }
  return paragraphs.join("\n\n");
}

function makeMessage(sequence: number, overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    sequence,
    role: "user",
    humanAuthored: true,
    visibleToUser: true,
    timestamp: new Date("2026-07-20T10:00:00Z"),
    usageEvents: [],
    chunks: [],
    metadata: {},
    ...overrides,
  };
}

/** v1: user prompt + длинный assistant final + reasoning + tool result. */
function dialogueV1(externalId: string): ParsedDialogue {
  return {
    externalId,
    title: "Поисковый диалог",
    workspace: { path: "/tmp/project", name: "project" },
    startedAt: new Date("2026-07-20T10:00:00Z"),
    updatedAt: new Date("2026-07-20T10:05:00Z"),
    messages: [
      makeMessage(0, {
        role: "user",
        metadata: { origin: { kind: "user" } },
        chunks: [
          { sequence: 0, kind: "text", content: `Расскажи про ${USER_PHRASE}`, metadata: {} },
        ],
      }),
      makeMessage(1, {
        role: "assistant",
        humanAuthored: false,
        timestamp: new Date("2026-07-20T10:01:00Z"),
        model: {
          rawModelName: "kimi-code/k3",
          vendor: "moonshot",
          canonicalName: "k3",
          serviceProvider: "kimi",
        },
        chunks: [
          { sequence: 0, kind: "thought", content: REASONING_MARKER, metadata: {} },
          {
            sequence: 1,
            kind: "tool_result",
            content: TOOL_MARKER,
            toolName: "bash",
            metadata: {},
          },
          { sequence: 2, kind: "text", content: longAssistantText(MIDDLE_MARKER), metadata: {} },
        ],
      }),
    ],
    metadata: {},
  };
}

/** v2: тот же диалог, другое содержимое (старые phrases исчезают из current). */
function dialogueV2(externalId: string): ParsedDialogue {
  const v1 = dialogueV1(externalId);
  v1.updatedAt = new Date("2026-07-20T11:00:00Z");
  v1.messages[1]!.chunks = [
    { sequence: 0, kind: "text", content: "Совершенно новый лаконичный ответ второй версии.", metadata: {} },
  ];
  return v1;
}

interface Ctx {
  host: RecordId;
  osAccount: RecordId;
  installation: RecordId;
  sourceRevision: RecordId;
  modelIds: Map<string, RecordId>;
  workspace: RecordId;
}

async function makeCtx(t: TestDb): Promise<Ctx> {
  const host = await ensureHost(t.db, {
    hostUuid: "host-uuid-search",
    hostname: "search-host",
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
  const installation = await ensureHarnessInstallation(t.db, { host, harness, installed: true });
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
    relativePath: "wd_x/session_s/agents/main/wire.jsonl",
    originalPath: "/tmp/sessions/wd_x/session_s/agents/main/wire.jsonl",
    basename: "wire.jsonl",
  });
  const sourceRevision = await ensureSourceRevision(t.db, {
    sourceLocation: location.id,
    sha256: "b".repeat(64),
    sizeBytes: 100,
    mtimeMs: 1000,
    rawArchivePath: "raw/kimi-code/wire__bbb.jsonl",
    snapshotKind: "regular_copy",
    parserName: "kimi-code",
    parserVersion: 1,
    syncRun,
  });
  const vendor = await ensureVendor(t.db, "moonshot");
  const model = await ensureModel(t.db, { vendor, canonicalName: "k3", rawName: "kimi-code/k3" });
  const workspace = await ensureWorkspace(t.db, { host, path: "/tmp/project", name: "project" });
  if (!workspace) throw new Error("ensureWorkspace вернул undefined");
  return {
    host,
    osAccount,
    installation,
    sourceRevision: sourceRevision.id,
    modelIds: new Map([["moonshot/k3", model]]),
    workspace,
  };
}

function txInput(ctx: Ctx, dialogue: ParsedDialogue, identityKey: string): DialogueTxInput {
  return {
    identityKey,
    harnessInstallation: ctx.installation,
    osAccount: ctx.osAccount,
    workspace: ctx.workspace,
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

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { limit: 20, ...overrides };
}

/** Записать v1 диалога в свежую тестовую БД. */
async function seedV1(t: TestDb, externalId: string) {
  const ctx = await makeCtx(t);
  const key = dialogueIdentityKey(ctx.installation.toString(), externalId, "fb");
  const result = await writeDialogueRevision(t.db, txInput(ctx, dialogueV1(externalId), key));
  return { ctx, key, result };
}

describe("full-text search (integration)", () => {
  test("обычный поиск находит известную фразу, контекст и фильтры работают", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seedV1(t, "session_search");

      const hits = await searchText(t.db, "яблоки корицей", filters());
      expect(hits).toHaveLength(1);
      const hit = hits[0]!;
      expect(hit.documentType).toBe("user_prompt");
      expect(hit.snippet).toContain("<em>");
      expect(hit.dialogueTitle).toBe("Поисковый диалог");
      expect(hit.harness).toBe("kimi-code");
      expect(hit.host).toBe("search-host");
      expect(hit.workspace).toBe("project");
      expect(hit.revisionId).toContain("dialogue_revision:");
      expect(hit.timestamp).toContain("2026-07-20");

      // фильтры §14
      expect(await searchText(t.db, "яблоки", filters({ harness: "kimi-code" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ harness: "codex" }))).toHaveLength(0);
      expect(await searchText(t.db, "яблоки", filters({ workspace: "project" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ workspace: "other" }))).toHaveLength(0);
      expect(await searchText(t.db, "яблоки", filters({ host: "search-host" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ host: "other-host" }))).toHaveLength(0);
      expect(
        await searchText(t.db, "яблоки", filters({ documentType: "user_prompt" })),
      ).toHaveLength(1);
      expect(
        await searchText(t.db, "яблоки", filters({ documentType: "assistant_final" })),
      ).toHaveLength(0);
      // source_location active → --deleted-only пуст
      expect(await searchText(t.db, "яблоки", filters({ deletedOnly: true }))).toHaveLength(0);
      // timestamp фильтры (message.timestamp = 2026-07-20)
      expect(
        await searchText(t.db, "яблоки", filters({ from: new Date("2026-07-21T00:00:00Z") })),
      ).toHaveLength(0);
      expect(
        await searchText(t.db, "яблоки", filters({ from: new Date("2026-07-19T00:00:00Z") })),
      ).toHaveLength(1);
      expect(
        await searchText(t.db, "яблоки", filters({ to: new Date("2026-07-19T00:00:00Z") })),
      ).toHaveLength(0);
    } finally {
      await dropTestDb(t);
    }
  });

  test("сегментированный длинный документ: находится по фразе из середины, метаданные сегментов корректны", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      const { result } = await seedV1(t, "session_segmented");
      // user_prompt + несколько сегментов assistant_final
      expect(result.searchDocumentCount).toBeGreaterThan(2);

      const docs = await selectAll<{
        document_type: string;
        segment_no: number;
        token_count: number;
        segmentation_version: string;
      }>(
        t.db,
        "SELECT document_type, segment_no, token_count, segmentation_version FROM search_document WHERE document_type = 'assistant_final' ORDER BY segment_no",
      );
      expect(docs.length).toBeGreaterThan(1);
      expect(docs.map((d) => d.segment_no)).toEqual(docs.map((_, i) => i));
      for (const doc of docs) {
        expect(doc.token_count).toBeGreaterThan(0);
        expect(doc.segmentation_version).toBe(SEGMENTATION_VERSION);
      }

      // фраза из середины длинного документа находится обычным поиском
      const hits = await searchText(t.db, "абракадабра", filters());
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.documentType).toBe("assistant_final");
      expect(hits[0]!.snippet).toContain("абракадабра");
      // фильтр по модели (raw и canonical)
      expect(await searchText(t.db, "абракадабра", filters({ model: "k3" }))).not.toHaveLength(0);
      expect(await searchText(t.db, "абракадабра", filters({ model: "gpt-5" }))).toHaveLength(0);
    } finally {
      await dropTestDb(t);
    }
  });

  test("старые revisions не в обычной выдаче; forensic --all-revisions их видит", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      const { ctx, key } = await seedV1(t, "session_revisions");
      // v1 содержит OLD_PHRASE? нет — добавим её в v1 отдельным сообщением
      void OLD_PHRASE;
      // Переключаем current на v2 (короткий ответ без маркеров).
      await writeDialogueRevision(t.db, txInput(ctx, dialogueV2("session_revisions"), key));

      // обычный поиск: маркер середины длинного ответа v1 не находится
      expect(await searchText(t.db, "абракадабра", filters())).toHaveLength(0);
      // но находится текст v2
      expect(await searchText(t.db, "лаконичный", filters())).toHaveLength(1);
      // projection только current revision (инвариант №10)
      const stale = await selectAll<{ id: RecordId }>(
        t.db,
        "SELECT id FROM search_document WHERE dialogue_revision != dialogue.current_revision",
      );
      expect(stale).toHaveLength(0);

      // forensic без --all-revisions: chunk'и v1 тоже не видны
      expect(await searchForensic(t.db, "абракадабра", filters())).toHaveLength(0);
      // forensic --all-revisions: chunk v1 находится
      const all = await searchForensic(t.db, "абракадабра", filters({ allRevisions: true }));
      expect(all).toHaveLength(1);
      expect(all[0]!.kind).toBe("text");
    } finally {
      await dropTestDb(t);
    }
  });

  test("reasoning/tool контент доступен только через forensic mode", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      await seedV1(t, "session_forensic");
      expect(isForensic(filters())).toBe(false);
      expect(isForensic(filters({ includeReasoning: true }))).toBe(true);

      // обычный поиск reasoning/tool НЕ видит
      expect(await searchText(t.db, "ксиволь", filters())).toHaveLength(0);
      expect(await searchText(t.db, "йолопуки", filters())).toHaveLength(0);
      // forensic без флагов: только kind=text → тоже не видит
      expect(await searchForensic(t.db, "ксиволь", filters())).toHaveLength(0);
      expect(await searchForensic(t.db, "йолопуки", filters())).toHaveLength(0);
      // --include-reasoning: thought находится
      const reasoning = await searchForensic(t.db, "ксиволь", filters({ includeReasoning: true }));
      expect(reasoning).toHaveLength(1);
      expect(reasoning[0]!.kind).toBe("thought");
      // --include-tools: tool_result находится
      const tools = await searchForensic(t.db, "йолопуки", filters({ includeTools: true }));
      expect(tools).toHaveLength(1);
      expect(tools[0]!.kind).toBe("tool_result");
    } finally {
      await dropTestDb(t);
    }
  });

  test("search:rebuild пересоздаёт projection current revisions идемпотентно", async () => {
    if (!dbReady) return;
    const t = await createTestDb();
    try {
      const { ctx, result } = await seedV1(t, "session_rebuild");
      const before = await selectAll<{ id: RecordId; content_sha256: string }>(
        t.db,
        "SELECT id, content_sha256 FROM search_document",
      );
      expect(before.length).toBe(result.searchDocumentCount);

      // Ломаем projection: удаляем все search_document.
      await t.db.query("DELETE search_document");
      expect(await searchText(t.db, "яблоки", filters())).toHaveLength(0);

      const summary = await rebuildSearchProjection(t.db, {
        host: ctx.host,
        schemaVersion: 4,
        enqueueEmbeddings: true,
      });
      expect(summary.revisions).toBe(1);
      expect(summary.skipped).toBe(0);
      expect(summary.searchDocuments).toBe(result.searchDocumentCount);

      // Детерминированные id совпадают с исходными (содержимое то же).
      const after = await selectAll<{ id: RecordId; content_sha256: string }>(
        t.db,
        "SELECT id, content_sha256 FROM search_document",
      );
      expect(new Set(after.map((d) => String(d.id)))).toEqual(
        new Set(before.map((d) => String(d.id))),
      );

      // Поиск снова работает, включая середину сегментированного документа.
      expect(await searchText(t.db, "яблоки", filters())).toHaveLength(1);
      expect(await searchText(t.db, "абракадабра", filters())).not.toHaveLength(0);

      // Повторный rebuild идемпотентен (те же id, то же число документов).
      const second = await rebuildSearchProjection(t.db, {
        host: ctx.host,
        schemaVersion: 4,
        enqueueEmbeddings: true,
      });
      expect(second.searchDocuments).toBe(summary.searchDocuments);
      const count = await selectOne<{ n: number }>(
        t.db,
        "SELECT count() AS n FROM search_document GROUP ALL",
      );
      expect(count?.n).toBe(result.searchDocumentCount);
    } finally {
      await dropTestDb(t);
    }
  });
});
