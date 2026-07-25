import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ParsedDialogue } from "../src/domain/canonical-types.ts";
import { openCodeParser } from "../src/parsers/opencode/index.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { openCodeExtractors } from "../src/search/extractors/opencode.ts";
import {
  EXTRACTOR_VERSION,
  FALLBACK_ASSISTANT_FINAL_METHOD,
  FALLBACK_USER_PROMPT_METHOD,
} from "../src/search/extractors/types.ts";

const FIXTURES = "tests/fixtures/opencode";
const TMP = mkdtempSync(join(tmpdir(), "baka-opencode-extractors-"));

let dbCounter = 0;

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

async function parseFixture(name: string): Promise<ParsedDialogue[]> {
  const dbPath = join(TMP, `${name}-${dbCounter++}.db`);
  const db = new Database(dbPath);
  try {
    db.exec(readFileSync(join(FIXTURES, `${name}.sql`), "utf8"));
  } finally {
    db.close();
  }
  return collectDialogues(await openCodeParser.parse(dbPath));
}

describe("opencode extractors: user_prompt", () => {
  test("обычный user prompt → opencode_user_message_text", async () => {
    expect(openCodeExtractors.harnessSlug).toBe("opencode");
    expect(EXTRACTOR_VERSION).toBe(2);
    expect(openCodeExtractors.extractorVersion).toBe(EXTRACTOR_VERSION);
    const [dialogue] = await parseFixture("basic");
    const user = dialogue!.messages.find((m) => m.role === "user")!;
    const doc = openCodeExtractors.extractUserPrompt(user);
    expect(doc).toBeDefined();
    expect(doc!.content).toBe("Explain how the cache works in src/cache.ts");
    expect(doc!.extractionMethod).toBe("opencode_user_message_text");
    expect(doc!.sourceChunks).toEqual([{ messageSequence: user.sequence, chunkSequence: 0 }]);
  });

  test("humanAuthored unknown (SDK format) → fallback_visible_user_text", async () => {
    const [dialogue] = await parseFixture("long-final");
    const user = dialogue!.messages.find((m) => m.role === "user")!;
    const doc = openCodeExtractors.extractUserPrompt(user);
    expect(doc).toBeDefined();
    expect(doc!.content).toBe("Summarize the release in three paragraphs");
    expect(doc!.extractionMethod).toBe(FALLBACK_USER_PROMPT_METHOD);
  });

  test("не-user и пустые сообщения не извлекаются", async () => {
    const [dialogue] = await parseFixture("basic");
    const assistant = dialogue!.messages.find((m) => m.role === "assistant")!;
    expect(openCodeExtractors.extractUserPrompt(assistant)).toBeUndefined();

    const dialogues = await parseFixture("unknown-truncated");
    const weird = dialogues.find((d) => d.externalId === "ses_demo003")!;
    const empty = weird.messages.find((m) => m.externalId === "msg_a202")!;
    expect(openCodeExtractors.extractUserPrompt(empty)).toBeUndefined();
  });
});

describe("opencode extractors: assistant_final", () => {
  test("явный marker finish=stop, без reasoning (basic)", async () => {
    const [dialogue] = await parseFixture("basic");
    const doc = openCodeExtractors.extractAssistantFinal(dialogue!.messages);
    expect(doc).toBeDefined();
    expect(doc!.extractionMethod).toBe("opencode_finish_stop_text");
    expect(doc!.content).toBe("The cache in src/cache.ts is a simple LRU with TTL.");
    expect(doc!.content).not.toContain("recall the cache module");
    // Один text chunk → одна ссылка.
    expect(doc!.sourceChunks).toHaveLength(1);
  });

  test("сценарий 20: финальный ответ из нескольких chunks и messages, текст до/после tool activity", async () => {
    const [dialogue] = await parseFixture("long-final");
    const doc = openCodeExtractors.extractAssistantFinal(dialogue!.messages);
    expect(doc).toBeDefined();
    expect(doc!.extractionMethod).toBe("opencode_finish_stop_text");
    expect(doc!.content).toBe(
      [
        "First paragraph: the release adds incremental sync.",
        "Second paragraph: migration tooling was rewritten.",
        "Third paragraph: known limitations are documented.",
      ].join("\n"),
    );
    expect(doc!.content).not.toContain("CHANGELOG");
    // 1 text chunk в msg_a301 + 2 в msg_a302.
    expect(doc!.sourceChunks).toHaveLength(3);
  });

  test("без tool/system chunks: tools fixture — только видимый текст", async () => {
    const [dialogue] = await parseFixture("tools");
    const doc = openCodeExtractors.extractAssistantFinal(dialogue!.messages);
    expect(doc).toBeDefined();
    expect(doc!.content).toContain("I will read the parser first");
    expect(doc!.content).toContain("Fixed the failing tests");
    expect(doc!.content).not.toContain("export function parse");
    expect(doc!.content).not.toContain("bun test");
    expect(doc!.content).not.toContain("Review the diff");
  });

  test("не «последний text chunk»: текст до tool calls тоже входит", async () => {
    const [dialogue] = await parseFixture("long-final");
    const doc = openCodeExtractors.extractAssistantFinal(dialogue!.messages)!;
    expect(doc.content.startsWith("First paragraph")).toBe(true);
  });

  test("без finish=stop после последнего промпта → fallback_visible_assistant_text", async () => {
    const [dialogue] = await parseFixture("basic");
    // Имитация обрыва: убираем marker finish=stop.
    const messages = dialogue!.messages.map((m) =>
      m.role === "assistant" ? { ...m, metadata: { ...m.metadata, finish: "tool-calls" } } : m,
    );
    const doc = openCodeExtractors.extractAssistantFinal(messages);
    expect(doc).toBeDefined();
    expect(doc!.extractionMethod).toBe(FALLBACK_ASSISTANT_FINAL_METHOD);
    expect(doc!.content).toContain("LRU");
  });

  test("unknown user prompt (SDK format) — граница turn'а: ответы не склеиваются", async () => {
    const [dialogue] = await parseFixture("unknown-turn-boundary");
    const doc = openCodeExtractors.extractAssistantFinal(dialogue!.messages);
    expect(doc).toBeDefined();
    expect(doc!.extractionMethod).toBe("opencode_finish_stop_text");
    expect(doc!.content).toBe("Answer to the second question.");
    expect(doc!.content).not.toContain("Answer to the first question");
  });

  test("диалог без assistant текста → undefined", async () => {
    const dialogues = await parseFixture("unknown-truncated");
    const empty = dialogues.find((d) => d.externalId === "ses_demo004")!;
    expect(openCodeExtractors.extractAssistantFinal(empty.messages)).toBeUndefined();
  });
});
