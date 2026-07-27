import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { codexParser } from "../src/parsers/codex/index.ts";
import { kimiCodeParser } from "../src/parsers/kimi-code/index.ts";
import { codexExtractors } from "../src/search/extractors/codex.ts";
import { kimiCodeExtractors } from "../src/search/extractors/kimi-code.ts";
import { prepareSearchDocuments } from "../src/db/repositories/corpus.ts";
import { searchDocumentRecordId } from "../src/sync/canonical-hash.ts";
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

  test("final_answer предыдущего turn'а не подменяет ответ текущего (обрыв)", async () => {
    const dialogue = await parseCodex("stale-final.jsonl");
    const extracted = codexExtractors.extractAssistantFinal(dialogue.messages)!;
    // Turn 1 завершён (phase final_answer), turn 2 оборвался после видимого
    // текста: extractor обязан вернуть текст ТЕКУЩЕГО turn'а, а не старый
    // marked final.
    expect(extracted.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(extracted.content).toBe("Частичный ответ на второй вопрос: вызов в src/cli.ts");
    expect(extracted.content).not.toContain("Ответ на первый вопрос");
  });

  test("projection: каждый user prompt получает свой assistant final", async () => {
    const dialogue = await parseCodex("stale-final.jsonl");
    const docs = prepareSearchDocuments(dialogue, "rev_turn_projection", codexExtractors);
    const prompts = docs.filter((doc) => doc.documentType === "user_prompt");
    const finals = docs.filter((doc) => doc.documentType === "assistant_final");

    expect(prompts.map((doc) => doc.content)).toEqual([
      "Первый вопрос: что делает parseConfig?",
      "Второй вопрос: а где она вызывается?",
    ]);
    expect(finals.map((doc) => doc.content)).toEqual([
      "Ответ на первый вопрос: parseConfig читает TOML.",
      "Частичный ответ на второй вопрос: вызов в src/cli.ts",
    ]);
    expect(finals.map((doc) => doc.method)).toEqual([
      "codex_final_answer_phase",
      "fallback_visible_assistant_text",
    ]);
    expect(finals.map((doc) => doc.recordKey)).toEqual([
      searchDocumentRecordId("rev_turn_projection", "assistant_final", 0, 0),
      searchDocumentRecordId("rev_turn_projection", "assistant_final", 1, 0),
    ]);
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

  test("промпт без origin.kind: fallback + граница turn'а", async () => {
    const dialogue = await parseKimi(
      "unknown-origin/session_44444444-dddd-4eee-8fff-444444444444",
    );
    const users = dialogue.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]!.humanAuthored).toBe(true);
    expect(users[1]!.humanAuthored).toBe("unknown");
    const prompt = kimiCodeExtractors.extractUserPrompt(users[1]!)!;
    expect(prompt.extractionMethod).toBe("fallback_visible_user_text");
    expect(prompt.content).toBe("Второй вопрос без origin в wire");
    // Unknown-промпт — граница turn'а: ответ первого turn'а не склеивается.
    const final = kimiCodeExtractors.extractAssistantFinal(dialogue.messages)!;
    expect(final.extractionMethod).toBe("fallback_visible_assistant_text");
    expect(final.content).toBe("Ответ на второй вопрос.");
    expect(final.content).not.toContain("Ответ на первый вопрос");
  });

  test("projection: harness fallback сохраняет реальный unknown-origin prompt и его final", async () => {
    const dialogue = await parseKimi(
      "unknown-origin/session_44444444-dddd-4eee-8fff-444444444444",
    );
    const docs = prepareSearchDocuments(dialogue, "rev_unknown_origin", kimiCodeExtractors);
    const prompts = docs.filter((doc) => doc.documentType === "user_prompt");
    const finals = docs.filter((doc) => doc.documentType === "assistant_final");

    expect(prompts.map((doc) => [doc.content, doc.method])).toEqual([
      ["Первый вопрос: что делает parseConfig?", "kimi_code_turn_prompt_user"],
      ["Второй вопрос без origin в wire", "fallback_visible_user_text"],
    ]);
    expect(finals.map((doc) => doc.content)).toEqual([
      "Ответ на первый вопрос: parseConfig читает TOML.",
      "Ответ на второй вопрос.",
    ]);
  });
});
