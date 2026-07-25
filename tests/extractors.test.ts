import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { codexParser } from "../src/parsers/codex/index.ts";
import { kimiCodeParser } from "../src/parsers/kimi-code/index.ts";
import { codexExtractors } from "../src/search/extractors/codex.ts";
import { kimiCodeExtractors } from "../src/search/extractors/kimi-code.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

async function parseCodex(name: string): Promise<ParsedDialogue> {
  const snapshot = await codexParser.parse(`tests/fixtures/codex/${name}`);
  return (await collectDialogues(snapshot))[0]!;
}

async function parseKimi(sessionDir: string): Promise<ParsedDialogue> {
  const snapshot = await kimiCodeParser.parse(join("tests/fixtures/kimi-code", sessionDir));
  return (await collectDialogues(snapshot))[0]!;
}

describe("codex extractors", () => {
  test("user_prompt: текст user_message event, авто-контекст исключён", async () => {
    const dialogue = await parseCodex("basic-dialogue.jsonl");
    const [envContext, prompt] = dialogue.messages.filter((m) => m.role === "user");
    expect(codexExtractors.extractUserPrompt(envContext!)).toBeUndefined();
    const extracted = codexExtractors.extractUserPrompt(prompt!)!;
    expect(extracted.content).toBe("Объясни, что делает функция parseConfig в этом проекте.");
    expect(extracted.extractionMethod).toBe("codex_user_message_event");
  });

  test("assistant_final: явный phase marker", async () => {
    const dialogue = await parseCodex("basic-dialogue.jsonl");
    const extracted = codexExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("codex_final_answer_phase");
    expect(extracted.content).toContain("parseConfig читает TOML-файл");
  });

  test("сценарий 20: финальный ответ из нескольких chunks целиком", async () => {
    const dialogue = await parseCodex("tool-calls.jsonl");
    const extracted = codexExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("codex_final_answer_phase");
    expect(extracted.content).toBe(
      "Нашёл два вызова. Первый — в api-слое.\nВторой — в UI-корзине, он дублирует запрос.",
    );
    // Оба text-чанка указаны как источник.
    expect(extracted.sourceChunks).toHaveLength(2);
    // Reasoning/tool не попали в финальный ответ.
    expect(extracted.content).not.toContain("rg -n fetchOrder");
  });
});

describe("kimi-code extractors", () => {
  test("user_prompt: только origin.kind=user", async () => {
    const dialogue = await parseKimi("basic/session_11111111-aaaa-4bbb-8ccc-111111111111");
    const user = dialogue.messages.find((m) => m.role === "user")!;
    const extracted = kimiCodeExtractors.extractUserPrompt(user)!;
    expect(extracted.content).toBe("Объясни работу кэша в src/cache.ts");
    expect(extracted.extractionMethod).toBe("kimi_code_turn_prompt_user");
  });

  test("user_prompt: system_trigger субагента не извлекается", async () => {
    const dialogue = await parseKimi(
      "tools-and-subagent/session_22222222-bbbb-4ccc-8ddd-222222222222",
    );
    const subPrompt = dialogue.messages.find(
      (m) => m.role === "user" && m.metadata.subagentId === "agent-0",
    )!;
    expect(kimiCodeExtractors.extractUserPrompt(subPrompt)).toBeUndefined();
  });

  test("assistant_final: fallback, без think, только основной агент", async () => {
    const dialogue = await parseKimi("basic/session_11111111-aaaa-4bbb-8ccc-111111111111");
    const extracted = kimiCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(extracted.content).toBe("Кэш в src/cache.ts устроен как in-memory Map с TTL.");
    expect(extracted.content).not.toContain("прочитаю");
  });

  test("сценарий 20: текст до и после tool activity, без субагента", async () => {
    const dialogue = await parseKimi(
      "tools-and-subagent/session_22222222-bbbb-4ccc-8ddd-222222222222",
    );
    const extracted = kimiCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    // Текст первого шага (до tool results) и второго шага (после) — вместе.
    expect(extracted.content).toContain("Сначала соберу профиль памяти");
    expect(extracted.content).toContain("Профиль показывает рост heap на 12MB в минуту.");
    expect(extracted.content).toContain("таймер в src/worker.ts:48 удерживает буфер");
    // Tool calls/results и reasoning не включены.
    expect(extracted.content).not.toContain("heap grew 12MB over 60s");
    expect(extracted.content).not.toContain("Запущу субагента");
    // Текст субагента не попал в финальный ответ основного диалога
    // (его реплика отличается формулировкой "таймер держит ссылку").
    expect(extracted.content).not.toContain("таймер держит ссылку");
  });
});
