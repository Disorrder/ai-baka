import { afterEach, describe, expect, test } from "bun:test";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { cursorParser } from "../src/parsers/cursor/index.ts";
import { cursorExtractors } from "../src/search/extractors/cursor.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";
import { makeCursorDb, type CursorFixtureDb } from "./fixtures/cursor/make-db.ts";
import {
  basicDialogue,
  toolCallsDialogue,
  unknownAndEmpty,
  type CursorFixtureSpec,
} from "./fixtures/cursor/specs.ts";

const opened: CursorFixtureDb[] = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.cleanup();
});

async function parseFixture(spec: CursorFixtureSpec): Promise<ParsedDialogue> {
  const db = await makeCursorDb(spec);
  opened.push(db);
  const snapshot = await cursorParser.parse(db.path);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return dialogues[0]!;
}

describe("cursor extractors: user_prompt", () => {
  test("текст user bubble, метод cursor_user_bubble_text", async () => {
    const dialogue = await parseFixture(basicDialogue);
    const user = dialogue.messages.find((m) => m.role === "user")!;
    const extracted = cursorExtractors.extractUserPrompt(user)!;
    expect(extracted.content).toBe("Объясни работу кэша в src/cache.ts");
    expect(extracted.extractionMethod).toBe("cursor_user_bubble_text");
    expect(extracted.sourceChunks).toEqual([{ messageSequence: 0, chunkSequence: 0 }]);
  });

  test("не-user сообщения не извлекаются", async () => {
    const dialogue = await parseFixture(basicDialogue);
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(cursorExtractors.extractUserPrompt(assistant)).toBeUndefined();
  });
});

describe("cursor extractors: assistant_final", () => {
  test("fallback: последний turn, без tool/thought", async () => {
    const dialogue = await parseFixture(basicDialogue);
    const extracted = cursorExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(extracted.content).toBe(
      "Кэш в src/cache.ts устроен как in-memory Map с TTL и инвалидацией по тегам.",
    );
  });

  test("сценарий 20: длинный финальный ответ из нескольких bubbles целиком, текст до и после tool activity", async () => {
    const dialogue = await parseFixture(toolCallsDialogue);
    const extracted = cursorExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    // Текст до tool call и обе части после — в исходном порядке.
    expect(extracted.content).toBe(
      "Сейчас поищу вызовы fetchOrder по проекту.\n" +
        "Нашёл два вызова. Первый — в api-слое (src/api/orders.ts:12).\n" +
        "Второй — в UI-корзине (src/ui/cart.ts:48), он дублирует запрос. Рекомендую убрать вызов из корзины и подписаться на store.",
    );
    // Reasoning (isThought) не попал в финальный ответ.
    expect(extracted.content).not.toContain("как устроен слой API");
    // Tool call/result не попали.
    expect(extracted.content).not.toContain("grep_search");
    expect(extracted.sourceChunks).toHaveLength(3);
  });

  test("пустое assistant message не даёт пустой документ", async () => {
    const dialogue = await parseFixture(unknownAndEmpty);
    const extracted = cursorExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.content).toBe("Вот список заметок: первая, вторая.");
    expect(extracted.sourceChunks).toHaveLength(1);
  });
});
