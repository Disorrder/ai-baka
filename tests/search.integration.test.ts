/**
 * Integration-тесты full-text search (этап 6, docs/plan.md §12, §14) на
 * живом SurrealDB: BM25 по search_document находит известные фразы,
 * фильтры работают, сегментированный длинный документ находится по фразе
 * из середины, старые revisions не в обычной выдаче, а отключённый глобальный
 * forensic mode fail closed без scan; rebuild пересоздаёт projection.
 * Плюс: vector over-fetch при активных фильтрах §14 (документ вне
 * глобального top-50 находится с --harness), vector mode уважает limit,
 * provider ↔ space сопоставляется включая provider.
 * Без живой БД integration-тесты ЯВНО skip'аются (dbTest), unit-тесты
 * hybrid pipeline (diversification) выполняются всегда.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import {
  isForensic,
  searchForensic,
  searchText,
  type SearchFilters,
  type SearchHit,
} from "../src/search/fulltext.ts";
import {
  dedupByMessage,
  diversifyByDialogue,
  searchHybrid,
  searchVector,
  VectorSearchUnavailable,
} from "../src/search/hybrid.ts";
import { rebuildSearchProjection } from "../src/search/rebuild.ts";
import { SEGMENTATION_VERSION } from "../src/search/segmenter.ts";
import { computeSearchCorpusFingerprint } from "../src/search/evaluation.ts";
import type { EmbeddingProvider } from "../src/embeddings/provider.ts";
import { createSpace, physicalTableName } from "../src/embeddings/spaces.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  isDbAvailable,
  type TestDb,
} from "./db-test-utils.ts";

// Прогрев кеша доступности; сами тесты регистрируются через testDb.
beforeAll(async () => {
  await isDbAvailable();
});

/** `test` при живой БД, иначе явный `test.skip` (проверка один раз на файл). */
const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

const USER_PHRASE = "запечённые яблоки с корицей";
const MIDDLE_MARKER = "срединный маркер абракадабра";
const OLD_PHRASE = "старая уникальная фраза первой версии";
const REASONING_MARKER = "тайное рассуждение ксиволь";
const TOOL_MARKER = "результат инструмента йолопуки";
const SYSTEM_MARKER = "системная инструкция фыркол";
const DEVELOPER_MARKER = "developer послание жумбра";

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
          reasoningEffort: "high",
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

/** Диалог с system/developer сообщениями (forensic --include-system, §12.1). */
function dialogueWithSystem(externalId: string): ParsedDialogue {
  const d = dialogueV1(externalId);
  d.messages.push(
    makeMessage(2, {
      role: "system",
      humanAuthored: false,
      chunks: [
        { sequence: 0, kind: "system", content: `Первая ${SYSTEM_MARKER} для ассистента`, metadata: {} },
      ],
    }),
    makeMessage(3, {
      role: "developer",
      humanAuthored: false,
      chunks: [
        { sequence: 0, kind: "developer", content: `Второе ${DEVELOPER_MARKER} от команды`, metadata: {} },
      ],
    }),
  );
  return d;
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
  testDb("search corpus fingerprint детерминирован и замечает projection drift", async () => {
    const t = await createTestDb();
    try {
      await seedV1(t, "session_fingerprint");
      const first = await computeSearchCorpusFingerprint(t.db, 1);
      const repeated = await computeSearchCorpusFingerprint(t.db, 2);
      expect(repeated).toEqual(first);
      expect(first.documents).toBeGreaterThan(1);
      await t.db.query(
        "UPDATE search_document SET content_sha256 = $sha WHERE id = (SELECT VALUE id FROM search_document ORDER BY id LIMIT 1)[0]",
        { sha: "f".repeat(64) },
      );
      await expect(computeSearchCorpusFingerprint(t.db, 2)).rejects.toThrow(
        /stored content hash mismatch/,
      );
      const replacement = "валидный projection drift";
      await t.db.query(
        "UPDATE search_document SET content = $content, content_sha256 = $sha WHERE id = (SELECT VALUE id FROM search_document ORDER BY id LIMIT 1)[0]",
        {
          content: replacement,
          sha: createHash("sha256").update(replacement).digest("hex"),
        },
      );
      const drifted = await computeSearchCorpusFingerprint(t.db, 2);
      expect(drifted.documents).toBe(first.documents);
      expect(drifted.sha256).not.toBe(first.sha256);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("обычный поиск находит известную фразу, контекст и фильтры работают", async () => {
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
      expect(hit.user).toBe("example");
      expect(hit.workspace).toBe("project");
      expect(hit.vendor).toBe("moonshot");
      expect(hit.role).toBe("user");
      expect(hit.reasoningEffort).toBeUndefined();
      expect(hit.sourcePath).toBe("/tmp/sessions/wd_x/session_s/agents/main/wire.jsonl");
      expect(hit.revisionId).toContain("dialogue_revision:");
      expect(hit.timestamp).toContain("2026-07-20");

      // фильтры §14
      expect(await searchText(t.db, "яблоки", filters({ harness: "kimi-code" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ harness: "codex" }))).toHaveLength(0);
      expect(await searchText(t.db, "яблоки", filters({ workspace: "project" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ workspace: "other" }))).toHaveLength(0);
      expect(await searchText(t.db, "яблоки", filters({ host: "search-host" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ host: "other-host" }))).toHaveLength(0);
      expect(await searchText(t.db, "яблоки", filters({ user: "example" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ user: "other" }))).toHaveLength(0);
      expect(await searchText(t.db, "яблоки", filters({ vendor: "moonshot" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ vendor: "openai" }))).toHaveLength(0);
      expect(await searchText(t.db, "яблоки", filters({ role: "user" }))).toHaveLength(1);
      expect(await searchText(t.db, "яблоки", filters({ role: "assistant" }))).toHaveLength(0);
      expect(
        await searchText(t.db, "яблоки", filters({ reasoningEffort: "high" })),
      ).toHaveLength(0);
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

  testDb("сегментированный длинный документ: находится по фразе из середины, метаданные сегментов корректны", async () => {
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
      expect(hits[0]).toMatchObject({
        user: "example",
        vendor: "moonshot",
        role: "assistant",
        reasoningEffort: "high",
        sourcePath: "/tmp/sessions/wd_x/session_s/agents/main/wire.jsonl",
      });
      // фильтр по модели (raw и canonical)
      expect(await searchText(t.db, "абракадабра", filters({ model: "k3" }))).not.toHaveLength(0);
      expect(await searchText(t.db, "абракадабра", filters({ model: "gpt-5" }))).toHaveLength(0);
      expect(
        await searchText(t.db, "абракадабра", filters({ reasoningEffort: "high" })),
      ).not.toHaveLength(0);
      expect(
        await searchText(t.db, "абракадабра", filters({ reasoningEffort: "low" })),
      ).toHaveLength(0);
      expect(
        await searchText(t.db, "абракадабра", filters({ role: "assistant" })),
      ).not.toHaveLength(0);
      expect(await searchText(t.db, "абракадабра", filters({ role: "user" }))).toHaveLength(0);
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("старые revisions не в обычной выдаче; forensic --all-revisions fail closed", async () => {
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

      // Canonical v1 chunks сохранены, но глобальный chunk_content index
      // отключён: legacy forensic API отказывает до любого DB scan.
      expect(
        searchForensic(t.db, "абракадабра", filters({ allRevisions: true })),
      ).rejects.toThrow("forensic search отключён");
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("reasoning/tool контент не попадает в normal projection; forensic fail closed", async () => {
    const t = await createTestDb();
    try {
      await seedV1(t, "session_forensic");
      expect(isForensic(filters())).toBe(false);
      expect(isForensic(filters({ includeReasoning: true }))).toBe(true);

      // обычный поиск reasoning/tool НЕ видит
      expect(await searchText(t.db, "ксиволь", filters())).toHaveLength(0);
      expect(await searchText(t.db, "йолопуки", filters())).toHaveLength(0);
      expect(
        searchForensic(
          t.db,
          "ксиволь",
          filters({ includeReasoning: true, role: "assistant", reasoningEffort: "high" }),
        ),
      ).rejects.toThrow("forensic search отключён");
      expect(
        searchForensic(t.db, "йолопуки", filters({ includeTools: true })),
      ).rejects.toThrow("forensic search отключён");
    } finally {
      await dropTestDb(t);
    }
  });

  testDb("search:rebuild пересоздаёт projection current revisions идемпотентно", async () => {
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

describe("отключённый forensic --include-system (integration)", () => {
  testDb("system/developer контент не попадает в normal projection; forensic fail closed", async () => {
    const t = await createTestDb();
    try {
      const ctx = await makeCtx(t);
      const key = dialogueIdentityKey(ctx.installation.toString(), "session_system", "fb");
      await writeDialogueRevision(t.db, txInput(ctx, dialogueWithSystem("session_system"), key));

      expect(isForensic(filters())).toBe(false);
      expect(isForensic(filters({ includeSystem: true }))).toBe(true);

      // обычный поиск system/developer НЕ видит
      expect(await searchText(t.db, "фыркол", filters())).toHaveLength(0);
      expect(await searchText(t.db, "жумбра", filters())).toHaveLength(0);
      expect(
        searchForensic(t.db, "фыркол", filters({ includeSystem: true })),
      ).rejects.toThrow("forensic search отключён");
      expect(
        searchForensic(t.db, "жумбра", filters({ includeSystem: true })),
      ).rejects.toThrow("forensic search отключён");
    } finally {
      await dropTestDb(t);
    }
  });
});

describe("hybrid pipeline: dedup + diversification (unit, §14 шаги 4–5)", () => {
  function hit(id: string, dialogueId: string, messageId?: string): SearchHit {
    return { id, score: 1, snippet: "", dialogueId, revisionId: "dialogue_revision:x", messageId };
  }

  test("5 hits одного диалога в топе → не более 3 в выдаче", () => {
    const hits = [
      ...Array.from({ length: 5 }, (_, i) => hit(`doc${i}`, "dlg_1", `m${i}`)),
      hit("other1", "dlg_2", "m9"),
      hit("other2", "dlg_3", "m8"),
    ];
    const out = diversifyByDialogue(dedupByMessage(hits));
    expect(out.filter((h) => h.dialogueId === "dlg_1")).toHaveLength(3);
    // лучшие по порядку сохраняются, остальные диалоги не пострадали
    expect(out.map((h) => h.id)).toEqual(["doc0", "doc1", "doc2", "other1", "other2"]);
  });

  test("dedup по message идёт до diversification: сегменты одного message не тратят лимит диалога", () => {
    const hits = [
      hit("seg0", "dlg_1", "m1"),
      hit("seg1", "dlg_1", "m1"), // тот же message — выпадает на dedup
      hit("seg2", "dlg_1", "m2"),
      hit("seg3", "dlg_1", "m3"),
      hit("seg4", "dlg_1", "m4"),
    ];
    const out = diversifyByDialogue(dedupByMessage(hits));
    expect(out.map((h) => h.id)).toEqual(["seg0", "seg2", "seg3"]);
  });
});

describe("vector search: over-fetch, limit, provider (integration)", () => {
  const VECTOR_DIMS = 16;
  const DECOYS = 60;
  // Query = [1,0,…]; decoy'и — близкие, но РАЗЛИЧНЫЕ векторы (dist ≈ 1e-6·i):
  // на 120 одинаковых векторах HNSW-граф в SurrealDB вырождается и ANN
  // недетерминированно теряет точки (проверено на живой базе).
  // Codex-документы — противоположный вектор (dist ≈ 2): детерминированно
  // ВНЕ глобального top-50.
  const QUERY_VECTOR = [1, ...Array.from({ length: VECTOR_DIMS - 1 }, () => 0)];
  const decoyVector = (i: number): number[] => [
    1,
    (i + 1) * 1e-3,
    ...Array.from({ length: VECTOR_DIMS - 2 }, () => 0),
  ];
  const FAR_VECTOR = [-1, 1e-3, ...Array.from({ length: VECTOR_DIMS - 2 }, () => 0)];

  function fixedProvider(): EmbeddingProvider {
    return {
      provider: "mock",
      model: "mock-embedding",
      dimensions: VECTOR_DIMS,
      embed: (texts: string[]) =>
        Promise.resolve({
          vectors: texts.map(() => [...QUERY_VECTOR]),
          usage: { promptTokens: 1, totalTokens: 1 },
        }),
    };
  }

  function shortDialogue(externalId: string, prompt: string): ParsedDialogue {
    return {
      externalId,
      title: `Диалог ${externalId}`,
      workspace: { path: "/tmp/project", name: "project" },
      startedAt: new Date("2026-07-20T10:00:00Z"),
      updatedAt: new Date("2026-07-20T10:05:00Z"),
      messages: [
        makeMessage(0, {
          metadata: { origin: { kind: "user" } },
          chunks: [{ sequence: 0, kind: "text", content: prompt, metadata: {} }],
        }),
        makeMessage(1, {
          role: "assistant",
          humanAuthored: false,
          timestamp: new Date("2026-07-20T10:01:00Z"),
          model: {
            rawModelName: "kimi-code/k3",
            vendor: "moonshot",
            canonicalName: "k3",
            reasoningEffort: "medium",
          },
          chunks: [{ sequence: 0, kind: "text", content: `Ответ на ${prompt}`, metadata: {} }],
        }),
      ],
      metadata: {},
    };
  }

  testDb("документ редкого harness'а вне глобального top-50 находится с --harness; limit уважается; provider сверяется", async () => {
    const t = await createTestDb();
    const physicalTable = physicalTableName("search_overfetch_16");
    try {
      const ctx = await makeCtx(t);
      // 60 decoy-диалогов kimi-code (вектор = query, dist 0).
      for (let i = 0; i < DECOYS; i++) {
        const key = dialogueIdentityKey(ctx.installation.toString(), `decoy_${i}`, "fb");
        await writeDialogueRevision(
          t.db,
          txInput(ctx, shortDialogue(`decoy_${i}`, `обычный вопрос номер ${i}`), key),
        );
      }
      // 1 диалог редкого harness'а codex (вектор противоположный, dist 2).
      const codexHarness = await ensureHarness(t.db, {
        slug: "codex",
        displayName: "Codex",
        kind: "file_tree",
      });
      const codexInstallation = await ensureHarnessInstallation(t.db, {
        host: ctx.host,
        harness: codexHarness,
        installed: true,
      });
      const rareKey = dialogueIdentityKey(codexInstallation.toString(), "rare_codex", "fb");
      await writeDialogueRevision(t.db, {
        ...txInput(ctx, shortDialogue("rare_codex", "редкий вопрос codex"), rareKey),
        harnessInstallation: codexInstallation,
      });

      const { space } = await createSpace(t.db, {
        slug: "search_overfetch_16",
        provider: "mock",
        model: "mock-embedding",
        dimensions: VECTOR_DIMS,
        activate: true,
      });
      expect(space.physical_table).toBe(physicalTable);
      // Векторы пишем напрямую (без worker'а): детерминированные расстояния.
      const docs = await selectAll<{ id: RecordId; harness?: string }>(
        t.db,
        "SELECT id, dialogue.harness_installation.harness.slug AS harness FROM search_document",
      );
      expect(docs.length).toBe((DECOYS + 1) * 2);
      for (const [i, doc] of docs.entries()) {
        await t.db.query(
          `CREATE ${space.physical_table} SET search_document = $doc, embedding_space = $space, ` +
            `input_sha256 = "manual", vector = $vec, prompt_tokens = 1, created_at = time::now()`,
          { doc: doc.id, space: space.id, vec: doc.harness === "codex" ? FAR_VECTOR : decoyVector(i) },
        );
      }

      // HNSW-индекс догоняет вставки асинхронно: ждём, пока ANN увидит все
      // векторы, иначе выдача недетерминированна.
      for (let attempt = 0; ; attempt++) {
        const ann = await selectAll<{ search_document: RecordId }>(
          t.db,
          `SELECT search_document FROM ${space.physical_table} WHERE vector <|200, 200|> $q`,
          { q: QUERY_VECTOR },
        );
        if (ann.length === docs.length) break;
        if (attempt >= 25) throw new Error(`HNSW не догнал индексацию: ${ann.length}/${docs.length}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const provider = fixedProvider();
      // Без фильтров глобальный top-50 — только decoy'и (dist 0).
      const unfiltered = await searchVector(t.db, provider, "запрос", filters({ limit: 50 }));
      expect(unfiltered).toHaveLength(50);
      expect(unfiltered.every((h) => h.harness === "kimi-code")).toBe(true);

      // С фильтром --harness codex over-fetch доходит и до худшего вектора.
      const rare = await searchVector(t.db, provider, "запрос", filters({ harness: "codex" }));
      expect(rare.length).toBeGreaterThan(0);
      expect(rare.every((h) => h.harness === "codex")).toBe(true);
      expect(rare.every((h) => h.user === "example" && h.vendor === "moonshot")).toBe(true);
      expect(
        rare.every(
          (h) => h.sourcePath === "/tmp/sessions/wd_x/session_s/agents/main/wire.jsonl",
        ),
      ).toBe(true);

      // Новые §14 filters применяются после ANN и поэтому используют over-fetch.
      const rareAssistant = await searchVector(
        t.db,
        provider,
        "запрос",
        filters({
          harness: "codex",
          user: "example",
          vendor: "moonshot",
          role: "assistant",
          reasoningEffort: "medium",
        }),
      );
      expect(rareAssistant).toHaveLength(1);
      expect(rareAssistant[0]).toMatchObject({
        harness: "codex",
        user: "example",
        vendor: "moonshot",
        role: "assistant",
        reasoningEffort: "medium",
        sourcePath: "/tmp/sessions/wd_x/session_s/agents/main/wire.jsonl",
      });
      expect(
        await searchVector(t.db, provider, "запрос", filters({ harness: "codex", role: "system" })),
      ).toHaveLength(0);

      const hybrid = await searchHybrid(
        t.db,
        provider,
        "редкий",
        filters({ harness: "codex", role: "assistant", reasoningEffort: "medium" }),
      );
      expect(hybrid).toHaveLength(1);
      expect(hybrid[0]).toMatchObject({
        harness: "codex",
        user: "example",
        vendor: "moonshot",
        role: "assistant",
        reasoningEffort: "medium",
        sourcePath: "/tmp/sessions/wd_x/session_s/agents/main/wire.jsonl",
      });

      // Vector mode уважает пользовательский limit.
      const limited = await searchVector(t.db, provider, "запрос", filters({ limit: 5 }));
      expect(limited).toHaveLength(5);

      // Тот же model/dimensions, но другой provider — space не подходит.
      const alien: EmbeddingProvider = { ...fixedProvider(), provider: "other" };
      await expect(searchVector(t.db, alien, "запрос", filters())).rejects.toBeInstanceOf(
        VectorSearchUnavailable,
      );
    } finally {
      // Explicitly retire the HNSW table before removing its database. Surreal
      // otherwise may keep RocksDB index cleanup running after REMOVE DATABASE,
      // starving a following live /export or pair of /import requests.
      try {
        await t.db.query(`REMOVE TABLE IF EXISTS ${physicalTable}`);
      } finally {
        // Database cleanup must still run if partial HNSW creation/removal
        // itself fails.
        await dropTestDb(t);
      }
    }
  });
});
