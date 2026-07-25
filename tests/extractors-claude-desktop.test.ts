import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claudeDesktopParser } from "../src/parsers/claude-desktop/index.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { claudeDesktopExtractors } from "../src/search/extractors/claude-desktop.ts";
import { EXTRACTOR_VERSION } from "../src/search/extractors/types.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

const FIXTURES = "tests/fixtures/claude-desktop";
const BASIC = join(FIXTURES, "basic/local_11111111-1111-4111-8111-111111111111/audit.jsonl");
const TOOLS = join(FIXTURES, "tools-sidechain/local_22222222-2222-4222-8222-222222222222/audit.jsonl");
const UNKNOWN = join(FIXTURES, "unknown-truncated/local_33333333-3333-4333-8333-333333333333/audit.jsonl");

async function parseDialogue(path: string): Promise<ParsedDialogue> {
  const snapshot = await claudeDesktopParser.parse(path);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return dialogues[0]!;
}

describe("claude-desktop extractors: user_prompt", () => {
  test("промпт человека из основной цепочки", async () => {
    const dialogue = await parseDialogue(BASIC);
    const user = dialogue.messages.find((m) => m.role === "user")!;
    const doc = claudeDesktopExtractors.extractUserPrompt(user);
    expect(claudeDesktopExtractors.harnessSlug).toBe("claude-desktop");
    expect(claudeDesktopExtractors.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(doc?.extractionMethod).toBe("claude_desktop_audit_user_prompt");
    expect(doc?.content).toBe(
      "Объясни, чем VACUUM INTO отличается от обычного копирования SQLite-базы.",
    );
    expect(doc?.sourceChunks).toEqual([{ messageSequence: 0, chunkSequence: 0 }]);
  });

  test("обёртка <uploaded_files> не попадает в user_prompt", async () => {
    const dialogue = await parseDialogue(TOOLS);
    const user = dialogue.messages[0]!;
    const doc = claudeDesktopExtractors.extractUserPrompt(user);
    expect(doc?.content).toBe("Прочитай spec.md и перечисли три главных риска проекта.");
    expect(doc?.content).not.toContain("<uploaded_files>");
    // Только text-чанк, attachment не входит в sourceChunks.
    expect(doc?.sourceChunks).toEqual([{ messageSequence: 0, chunkSequence: 1 }]);
  });

  test("sidechain-промпт субагента не извлекается", async () => {
    const dialogue = await parseDialogue(TOOLS);
    const subPrompt = dialogue.messages.find(
      (m) => m.role === "user" && m.metadata.parentToolUseId === "toolu_01CCC333",
    )!;
    expect(claudeDesktopExtractors.extractUserPrompt(subPrompt)).toBeUndefined();
  });

  test("пустой промпт → undefined", async () => {
    const dialogue = await parseDialogue(UNKNOWN);
    const user = dialogue.messages.find((m) => m.role === "user")!;
    expect(claudeDesktopExtractors.extractUserPrompt(user)).toBeUndefined();
  });

  test("tool/system/assistant сообщения не извлекаются как user_prompt", async () => {
    const dialogue = await parseDialogue(TOOLS);
    for (const message of dialogue.messages) {
      if (message.role !== "user") {
        expect(claudeDesktopExtractors.extractUserPrompt(message)).toBeUndefined();
      }
    }
  });
});

describe("claude-desktop extractors: assistant_final", () => {
  test("явный marker result: метод claude_desktop_turn_result", async () => {
    const dialogue = await parseDialogue(BASIC);
    const doc = claudeDesktopExtractors.extractAssistantFinal(dialogue.messages);
    expect(doc?.extractionMethod).toBe("claude_desktop_turn_result");
    expect(doc?.content).toContain("консистентную копию живой базы");
    expect(doc?.content).not.toContain("консистентности snapshot"); // thinking не входит
  });

  test("сценарий 20: финальный ответ из нескольких chunks/сообщений извлекается полностью, включая текст до и после tool activity", async () => {
    const dialogue = await parseDialogue(TOOLS);
    const doc = claudeDesktopExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(doc.extractionMethod).toBe("claude_desktop_turn_result");
    // Текст ДО tool activity (msg 1) и ПОСЛЕ (msg 8) — в исходном порядке.
    expect(doc.content).toBe(
      "Сначала прочитаю spec.md.\n" +
        "Готово — три главных риска:\n\n1. Устаревшая схема БД без миграций.\n" +
        "2. Отсутствие тестов на критическом пути.\n3. Жёсткая связанность модулей.",
    );
    // Без thinking, без tool/tool_result, без sidechain-текста субагента.
    expect(doc.content).not.toContain("сверюсь со структурой");
    expect(doc.content).not.toContain("Каталог содержит три приложения");
    expect(doc.content).not.toContain("Пример спецификации");
    expect(doc.sourceChunks).toEqual([
      { messageSequence: 1, chunkSequence: 0 },
      { messageSequence: 8, chunkSequence: 0 },
    ]);
  });

  test("truncated источник без result → fallback_visible_assistant_text", async () => {
    const dialogue = await parseDialogue(UNKNOWN);
    const doc = claudeDesktopExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(doc.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(doc.content).toContain("Похоже, сообщение пришло пустым.");
    expect(doc.content).toContain("Промежуточный видимый текст.");
    // unknown-чанк не попадает в ответ.
    expect(doc.content).not.toContain("hologram");
  });
});
