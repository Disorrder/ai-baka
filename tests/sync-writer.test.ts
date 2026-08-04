/**
 * Unit-тесты sync writer'а без БД: canonical hash, детерминированные id,
 * session-группировка kimi-code.
 */

import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import {
  canonicalDialogueHash,
  dialogueRevisionId,
  messageRecordId,
  searchDocumentRecordId,
} from "../src/sync/canonical-hash.ts";
import { kimiSessionDir } from "../src/sync/harness-tools.ts";
import { contentChars, writeDialogueRevision } from "../src/db/repositories/corpus.ts";
import { kimiCodeExtractors } from "../src/search/extractors/kimi-code.ts";
import { deterministicId } from "../src/db/transactions.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

function dialogue(content: string): ParsedDialogue {
  return {
    externalId: "s1",
    messages: [
      {
        sequence: 0,
        role: "user",
        humanAuthored: true,
        visibleToUser: true,
        usageEvents: [],
        chunks: [{ sequence: 0, kind: "text", content, metadata: {} }],
        metadata: { volatile: "hashed" },
      },
    ],
    metadata: { alsoIgnored: 42 },
  };
}

describe("canonical hash", () => {
  test("детерминирован и чувствителен к содержимому", () => {
    const a = canonicalDialogueHash(dialogue("привет"));
    expect(canonicalDialogueHash(dialogue("привет"))).toBe(a);
    expect(canonicalDialogueHash(dialogue("пока"))).not.toBe(a);
    // metadata ДИАЛОГА в hash не входит (writer её не сохраняет)
    const withMeta = dialogue("привет");
    withMeta.metadata = { other: true };
    expect(canonicalDialogueHash(withMeta)).toBe(a);
    // metadata сообщения и чанка входит: writer сохраняет их в БД, иначе
    // два snapshot'а с разной metadata получали бы одинаковый revision id
    const withMsgMeta = dialogue("привет");
    withMsgMeta.messages[0]!.metadata = { changed: true };
    expect(canonicalDialogueHash(withMsgMeta)).not.toBe(a);
    const withChunkMeta = dialogue("привет");
    withChunkMeta.messages[0]!.chunks[0]!.metadata = { x: 1 };
    expect(canonicalDialogueHash(withChunkMeta)).not.toBe(a);
  });

  test("порядок ключей metadata не влияет на hash", () => {
    const d1 = dialogue("x");
    d1.messages[0]!.metadata = { a: 1, b: { c: 2, d: [3, 4] } };
    const d2 = dialogue("x");
    d2.messages[0]!.metadata = { b: { d: [3, 4], c: 2 }, a: 1 };
    expect(canonicalDialogueHash(d1)).toBe(canonicalDialogueHash(d2));
  });

  test("raw payload usage events входит в hash", () => {
    const d1 = dialogue("x");
    d1.messages[0]!.usageEvents = [
      { scope: "request", inputTokens: 1, source: "s", raw: { a: 1 } },
    ];
    const d2 = dialogue("x");
    d2.messages[0]!.usageEvents = [
      { scope: "request", inputTokens: 1, source: "s", raw: { a: 999 } },
    ];
    expect(canonicalDialogueHash(d1)).not.toBe(canonicalDialogueHash(d2));
    const d3 = dialogue("x");
    d3.messages[0]!.usageEvents = [
      { scope: "request", inputTokens: 1, source: "s", raw: { a: 1 } },
    ];
    expect(canonicalDialogueHash(d1)).toBe(canonicalDialogueHash(d3));
  });

  test("cache write usage входит в hash", () => {
    const d1 = dialogue("x");
    d1.messages[0]!.usageEvents = [
      { scope: "request", inputTokens: 10, cacheWriteInputTokens: 2, source: "s" },
    ];
    const d2 = dialogue("x");
    d2.messages[0]!.usageEvents = [
      { scope: "request", inputTokens: 10, cacheWriteInputTokens: 3, source: "s" },
    ];
    expect(canonicalDialogueHash(d1)).not.toBe(canonicalDialogueHash(d2));
  });

  test("response timing не входит в hash как производный кеш", () => {
    const d1 = dialogue("x");
    const d2 = dialogue("x");
    d2.messages[0]!.responseWaitMs = 1234;
    d2.messages[0]!.responseStatus = "completed";
    d2.messages[0]!.responseCompletedAt = new Date("2026-01-01T00:00:02.000Z");
    d2.messages[0]!.responseTurnId = "turn-1";
    expect(canonicalDialogueHash(d1)).toBe(canonicalDialogueHash(d2));
  });
});

describe("derived content stats", () => {
  test("contentChars считает Unicode code points, а не UTF-8 bytes", () => {
    expect(contentChars("abc")).toBe(3);
    expect(Buffer.byteLength("привет", "utf8")).toBeGreaterThan(contentChars("привет"));
    expect(contentChars("привет")).toBe(6);
  });
});

describe("deterministic ids", () => {
  test("revision id: identity + parser@version + hash", () => {
    const r1 = dialogueRevisionId("inst:s1", "kimi-code", 1, "abc");
    expect(dialogueRevisionId("inst:s1", "kimi-code", 1, "abc")).toBe(r1);
    expect(dialogueRevisionId("inst:s1", "kimi-code", 2, "abc")).not.toBe(r1);
    expect(dialogueRevisionId("inst:s2", "kimi-code", 1, "abc")).not.toBe(r1);
    expect(r1.startsWith("rev_")).toBe(true);
    expect(r1).toHaveLength(4 + 64);
  });

  test("message/search doc id пространства revision", () => {
    expect(messageRecordId("r", 0)).not.toBe(messageRecordId("r", 1));
    expect(searchDocumentRecordId("r", "user_prompt", 0, 0)).not.toBe(
      searchDocumentRecordId("r", "assistant_final", 0, 0),
    );
    expect(searchDocumentRecordId("r", "user_prompt", 0, 0)).not.toBe(
      searchDocumentRecordId("r", "user_prompt", 0, 1),
    );
    expect(searchDocumentRecordId("r", "user_prompt", 0, 0)).not.toBe(
      searchDocumentRecordId("r", "user_prompt", 1, 0),
    );
    expect(deterministicId("p", "k")).toBe(`p_${"0".repeat(0)}`.slice(0, 2) + deterministicId("p", "k").slice(2));
  });
});

describe("kimiSessionDir", () => {
  test("session dir из путей сессии", () => {
    expect(kimiSessionDir("wd_x/session_1/state.json")).toBe("wd_x/session_1");
    expect(kimiSessionDir("wd_x/session_1/agents/main/wire.jsonl")).toBe("wd_x/session_1");
    expect(kimiSessionDir("wd_x/session_1/agents/agent-0/wire.jsonl")).toBe("wd_x/session_1");
    expect(kimiSessionDir("session_index.jsonl")).toBeUndefined();
    expect(kimiSessionDir("wd_x/session_1/notes.txt")).toBeUndefined();
  });
});

describe("writeDialogueRevision: защита от обрыва транзакции", () => {
  test("switch-путь: усечённый результат → ошибка, а не switched:true", async () => {
    // Fake Surreal: SELECT находит существующую revision (current — другая),
    // транзакция возвращает усечённый массив без RETURN — как SDK 2.0.8
    // при молчаливом обрыве (см. corpus.ts).
    let calls = 0;
    const fakeDb = {
      query: async () => {
        calls += 1;
        if (calls === 1) {
          return [
            [
              {
                dialogue: new RecordId("dialogue", "d1"),
                current: new RecordId("dialogue_revision", "other"),
              },
            ],
          ];
        }
        return [];
      },
    } as unknown as Surreal;
    await expect(
      writeDialogueRevision(fakeDb, {
        identityKey: "inst:s1",
        harnessInstallation: new RecordId("harness_installation", "h1"),
        sourceRevision: new RecordId("source_revision", "r1"),
        sourceDialogueId: "s1",
        parserName: "kimi-code",
        parserVersion: 1,
        parsed: dialogue("x"),
        extractors: kimiCodeExtractors,
        modelIds: new Map(),
        activeEmbeddingSpaces: [],
        enqueueEmbeddings: false,
      }),
    ).rejects.toThrow(/оборвалась/);
  });
});
