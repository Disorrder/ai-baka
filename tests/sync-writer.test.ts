/**
 * Unit-тесты sync writer'а без БД: canonical hash, детерминированные id,
 * session-группировка kimi-code.
 */

import { describe, expect, test } from "bun:test";
import {
  canonicalDialogueHash,
  dialogueRevisionId,
  messageRecordId,
  searchDocumentRecordId,
} from "../src/sync/canonical-hash.ts";
import { kimiSessionDir } from "../src/sync/harness-tools.ts";
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
        metadata: { volatile: "ignored" },
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
    // metadata в hash не входит
    const withMeta = dialogue("привет");
    withMeta.metadata = { other: true };
    withMeta.messages[0]!.metadata = { changed: true };
    expect(canonicalDialogueHash(withMeta)).toBe(a);
  });

  test("raw payload usage events в hash не входит", () => {
    const d1 = dialogue("x");
    d1.messages[0]!.usageEvents = [
      { scope: "request", inputTokens: 1, source: "s", raw: { a: 1 } },
    ];
    const d2 = dialogue("x");
    d2.messages[0]!.usageEvents = [
      { scope: "request", inputTokens: 1, source: "s", raw: { a: 999 } },
    ];
    expect(canonicalDialogueHash(d1)).toBe(canonicalDialogueHash(d2));
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
    expect(searchDocumentRecordId("r", "user_prompt", 0)).not.toBe(
      searchDocumentRecordId("r", "assistant_final", 0),
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
