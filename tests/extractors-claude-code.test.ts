import { describe, expect, test } from "bun:test";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { claudeCodeParser } from "../src/parsers/claude-code/index.ts";
import { claudeCodeExtractors } from "../src/search/extractors/claude-code.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

async function parseFixture(name: string): Promise<ParsedDialogue> {
  const snapshot = await claudeCodeParser.parse(`tests/fixtures/claude-code/${name}`);
  return (await collectDialogues(snapshot))[0]!;
}

describe("claude-code extractors: user_prompt", () => {
  test("origin.kind=human → claude_code_origin_human", async () => {
    const dialogue = await parseFixture("basic-dialogue.jsonl");
    const user = dialogue.messages.find((m) => m.role === "user")!;
    const extracted = claudeCodeExtractors.extractUserPrompt(user)!;
    expect(extracted.content).toBe("Объясни, что делает функция renderReport");
    expect(extracted.extractionMethod).toBe("claude_code_origin_human");
    expect(extracted.sourceChunks).toEqual([{ messageSequence: 0, chunkSequence: 0 }]);
  });

  test("tool_result-only запись не извлекается", async () => {
    const dialogue = await parseFixture("tool-calls.jsonl");
    const toolMessages = dialogue.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);
    for (const message of toolMessages) {
      expect(claudeCodeExtractors.extractUserPrompt(message)).toBeUndefined();
    }
  });

  test("user с image: извлекается только текст, без attachment", async () => {
    const dialogue = await parseFixture("tool-calls.jsonl");
    const user = dialogue.messages.find((m) => m.role === "user")!;
    const extracted = claudeCodeExtractors.extractUserPrompt(user)!;
    expect(extracted.content).toContain("Найди, где считается total");
    expect(extracted.sourceChunks).toHaveLength(1);
  });

  test("user без origin → fallback_visible_user_text", async () => {
    const dialogue = await parseFixture("model-switch-usage.jsonl");
    const users = dialogue.messages.filter((m) => m.role === "user");
    const extracted = claudeCodeExtractors.extractUserPrompt(users[1]!)!;
    expect(extracted.content).toBe("А теперь глубокое ревью с приоритетами");
    expect(extracted.extractionMethod).toBe("fallback_visible_user_text");
  });

  test("пустой промпт не извлекается", async () => {
    const dialogue = await parseFixture("unknown-and-empty.jsonl");
    const emptyUser = dialogue.messages.find(
      (m) => m.role === "user" && m.chunks.every((c) => (c.content ?? "").length === 0),
    )!;
    expect(claudeCodeExtractors.extractUserPrompt(emptyUser)).toBeUndefined();
  });
});

describe("claude-code extractors: assistant_final", () => {
  test("простой диалог: финальный ответ, fallback-метод", async () => {
    const dialogue = await parseFixture("basic-dialogue.jsonl");
    const extracted = claudeCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(extracted.content).toBe(
      "Функция renderReport собирает данные из стора и рендерит HTML-отчёт.",
    );
    // thinking не попал в финальный ответ.
    expect(extracted.content).not.toContain("Нужно найти функцию");
  });

  test("сценарий 20: финальный ответ из нескольких сообщений с tool activity между ними", async () => {
    const dialogue = await parseFixture("long-final.jsonl");
    const extracted = claudeCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(extracted.content).toBe(
      "Часть 1 отчёта: модуль billing состоит из трёх подсистем.\n" +
        "Часть 2 отчёта: invoices.ts (120 строк) и payments.ts (80 строк).",
    );
    expect(extracted.sourceChunks).toHaveLength(2);
    // tool call/result не попали в ответ.
    expect(extracted.content).not.toContain("wc -l");
  });

  test("sidechain-сообщения субагента не входят в финальный ответ", async () => {
    const dialogue = await parseFixture("tool-calls.jsonl");
    const extracted = claudeCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.content).toBe(
      "total считается в src/orders.ts:42 — свёртка items через reduce.",
    );
    expect(extracted.content).not.toContain("Типы корректны");
  });

  test("многострочный финальный ответ из склеенного сообщения", async () => {
    const dialogue = await parseFixture("model-switch-usage.jsonl");
    const extracted = claudeCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.content).toContain("1. Высокий приоритет");
    expect(extracted.content).toContain("2. Средний приоритет");
    expect(extracted.content).not.toContain("структурированный разбор");
    // Ответ предыдущего turn'а не подмешан.
    expect(extracted.content).not.toContain("parseConfig валидирует");
    expect(extracted.sourceChunks).toHaveLength(2);
  });

  test("нет видимого assistant текста → undefined", async () => {
    const dialogue = await parseFixture("unknown-and-empty.jsonl");
    const unknownOnly = dialogue.messages.filter(
      (m) => m.role === "assistant" && m.chunks.every((c) => c.kind !== "text"),
    );
    expect(claudeCodeExtractors.extractAssistantFinal(unknownOnly)).toBeUndefined();
    expect(claudeCodeExtractors.extractAssistantFinal([])).toBeUndefined();
  });
});
