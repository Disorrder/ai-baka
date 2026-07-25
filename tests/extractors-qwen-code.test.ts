import { describe, expect, test } from "bun:test";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { qwenCodeParser } from "../src/parsers/qwen-code/index.ts";
import { qwenCodeExtractors } from "../src/search/extractors/qwen-code.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

async function parseChat(name: string): Promise<ParsedDialogue> {
  const snapshot = await qwenCodeParser.parse(`tests/fixtures/qwen-code/${name}`);
  return (await collectDialogues(snapshot))[0]!;
}

describe("qwen-code extractors: user_prompt", () => {
  test("обычный промпт человека", async () => {
    const dialogue = await parseChat("basic-dialogue.jsonl");
    const user = dialogue.messages.find((m) => m.role === "user")!;
    const extracted = qwenCodeExtractors.extractUserPrompt(user)!;
    expect(extracted.content).toBe(
      "Объясни, что делает функция parseConfig в этом проекте.",
    );
    expect(extracted.extractionMethod).toBe("qwen_code_user_prompt");
    expect(extracted.sourceChunks).toEqual([{ messageSequence: 0, chunkSequence: 0 }]);
  });

  test("mid_turn_user_message — тоже промпт человека", async () => {
    const dialogue = await parseChat("basic-dialogue.jsonl");
    const midTurn = dialogue.messages.find(
      (m) => m.metadata.subtype === "mid_turn_user_message",
    )!;
    const extracted = qwenCodeExtractors.extractUserPrompt(midTurn)!;
    expect(extracted.content).toBe("А где она вызывается?");
    expect(extracted.extractionMethod).toBe("qwen_code_user_prompt");
  });

  test("notification и cron не извлекаются", async () => {
    const dialogue = await parseChat("unknown-truncated.jsonl");
    for (const subtype of ["notification", "cron"]) {
      const message = dialogue.messages.find((m) => m.metadata.subtype === subtype)!;
      expect(qwenCodeExtractors.extractUserPrompt(message)).toBeUndefined();
    }
  });

  test("humanAuthored unknown → fallback_visible_user_text", async () => {
    const dialogue = await parseChat("unknown-truncated.jsonl");
    const mystery = dialogue.messages.find((m) => m.metadata.subtype === "mystery_subtype")!;
    const extracted = qwenCodeExtractors.extractUserPrompt(mystery)!;
    expect(extracted.content).toBe("Странное сообщение неизвестного происхождения");
    expect(extracted.extractionMethod).toBe("fallback_visible_user_text");
  });

  test("пустое сообщение не извлекается", async () => {
    const dialogue = await parseChat("unknown-truncated.jsonl");
    const empty = dialogue.messages.find((m) => m.role === "user" && m.chunks.length === 0)!;
    expect(qwenCodeExtractors.extractUserPrompt(empty)).toBeUndefined();
  });
});

describe("qwen-code extractors: assistant_final", () => {
  test("basic: только текст после последнего human-authored сообщения", async () => {
    const dialogue = await parseChat("basic-dialogue.jsonl");
    const extracted = qwenCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    // Граница — mid_turn вопрос «А где она вызывается?»; первый ответ не входит.
    expect(extracted.content).toBe("Она вызывается один раз при старте CLI в src/cli.ts.");
    expect(extracted.content).not.toContain("parseConfig читает TOML-файл");
  });

  test("сценарий 20: финальный ответ из нескольких chunks, текст до и после tool activity", async () => {
    const dialogue = await parseChat("tool-calls.jsonl");
    const extracted = qwenCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(extracted.content).toBe(
      "Сначала поищу вызовы создания заказа по проекту.\n" +
        "Нашёл два вызова. Первый — в api-слое.\n" +
        "Второй — в UI-корзине, он дублирует запрос.\n" +
        "Итог: заказ уходит дважды, потому что cart.ts вызывает submit() два раза подряд без защиты от повтора.",
    );
    // Четыре text-чанка из трёх assistant-сообщений — источники.
    expect(extracted.sourceChunks).toHaveLength(4);
    // Reasoning, tool calls и tool results не попали в ответ.
    expect(extracted.content).not.toContain("Нужно найти места создания заказа");
    expect(extracted.content).not.toContain("rg -n createOrder");
    expect(extracted.content).not.toContain("submit(); submit();");
    // И не «последний text chunk»: видимый текст до tool activity сохранён.
    expect(extracted.content).toContain("Сначала поищу вызовы");
  });

  test("sidechain: видимых assistant-сообщений нет → undefined", async () => {
    const dialogue = await parseChat("subagent.jsonl");
    expect(qwenCodeExtractors.extractAssistantFinal(dialogue.messages)).toBeUndefined();
  });
});
