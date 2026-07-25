import { describe, expect, test } from "bun:test";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import {
  CLAUDE_CODE_PARSER_VERSION,
  claudeCodeParser,
} from "../src/parsers/claude-code/index.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

const FIXTURES = "tests/fixtures/claude-code";

async function parseFixture(
  name: string,
): Promise<{ dialogue: ParsedDialogue; diagnostics: { code: string }[] }> {
  const snapshot = await claudeCodeParser.parse(`${FIXTURES}/${name}`);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return { dialogue: dialogues[0]!, diagnostics: snapshot.diagnostics };
}

describe("claude-code parser: basic-dialogue", () => {
  test("метаданные диалога и parser version", async () => {
    expect(claudeCodeParser.parserName).toBe("claude-code");
    expect(CLAUDE_CODE_PARSER_VERSION).toBe(2);
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    expect(dialogue.externalId).toBe("aaaa1111-2222-4333-8444-555555555555");
    expect(dialogue.title).toBe("Разбор renderReport");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/report-service");
    expect(dialogue.workspace?.name).toBe("report-service");
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-20T10:00:00.100Z");
    expect(dialogue.updatedAt?.toISOString()).toBe("2026-07-20T10:00:03.500Z");
    expect(dialogue.metadata.gitBranch).toBe("main");
    expect(dialogue.metadata.lastPrompt).toBe("Объясни, что делает функция renderReport");
  });

  test("служебные записи — в eventCounts, не сообщения", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["queue-operation"]).toBe(1);
    expect(counts["attachment.hook_additional_context"]).toBe(1);
    expect(counts["system.stop_hook_summary"]).toBe(1);
    expect(counts["custom-title"]).toBe(1);
    expect(counts["last-prompt"]).toBe(1);
    expect(counts["mode"]).toBe(1);
    // Только user + assistant: служебные записи не стали сообщениями.
    expect(dialogue.messages).toHaveLength(2);
  });

  test("user prompt: origin.kind=human подтверждает авторство", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const user = dialogue.messages.find((m) => m.role === "user")!;
    expect(user.humanAuthored).toBe(true);
    expect(user.visibleToUser).toBe(true);
    expect(user.metadata.originKind).toBe("human");
    expect(user.chunks[0]!.kind).toBe("text");
    expect(user.chunks[0]!.content).toContain("renderReport");
  });

  test("стриминг: строки одного message.id склеиваются, usage один раз", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.externalId).toBe("msg_01AAAEXAMPLE0001");
    expect(assistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
    expect(assistant.chunks.map((c) => c.sequence)).toEqual([0, 1]);
    expect(assistant.chunks[0]!.content).toContain("Нужно найти функцию");
    expect(assistant.chunks[0]!.metadata.signed).toBe(true);
    expect(assistant.chunks[1]!.content).toContain("рендерит HTML-отчёт");
    // Сценарий 18: usage повторялся в обеих строках — засчитан один раз.
    expect(assistant.usageEvents).toHaveLength(1);
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["usage.deduped"]).toBe(1);
  });

  test("usage Anthropic: cache_read — часть input, cache creation — не cached", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    const event = assistant.usageEvents[0]!;
    expect(event.scope).toBe("request");
    expect(event.source).toBe("claude-code.message.usage");
    expect(event.inputTokens).toBe(6000); // 1200 + 300 + 4500
    // Единая семантика §7.3: cachedInputTokens = ТОЛЬКО cache read;
    // cache creation (300) — запись в кэш, остаётся в raw события.
    expect(event.cachedInputTokens).toBe(4500);
    expect((event.raw as Record<string, unknown>).cache_creation_input_tokens).toBe(300);
    expect(event.outputTokens).toBe(80);
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    expect(usage.scope).toBe("request");
    expect(usage.inputTokens).toBe(6000);
    expect(usage.cachedInputTokens).toBe(4500);
    // Сценарий 19: cached не прибавляется повторно.
    expect(usage.totalTokensNormalized).toBe(6080);
  });

  test("модель нормализуется: claude-fable-5 → anthropic", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.model?.rawModelName).toBe("claude-fable-5");
    expect(assistant.model?.canonicalName).toBe("claude-fable-5");
    expect(assistant.model?.vendor).toBe("anthropic");
    expect(assistant.model?.serviceProvider).toBe("anthropic");
  });
});

describe("claude-code parser: tool-calls", () => {
  test("сценарий 17: tool call ↔ tool result по tool_call_id", async () => {
    const { dialogue } = await parseFixture("tool-calls.jsonl");
    const calls = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_call"),
    );
    const results = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_result"),
    );
    expect(calls.map((c) => c.toolCallId).sort()).toEqual([
      "toolu_01EXAMPLEAAA",
      "toolu_02EXAMPLEBBB",
    ]);
    expect(results.map((c) => c.toolCallId).sort()).toEqual([
      "toolu_01EXAMPLEAAA",
      "toolu_02EXAMPLEBBB",
    ]);
    const bashCall = calls.find((c) => c.toolCallId === "toolu_01EXAMPLEAAA")!;
    expect(bashCall.toolName).toBe("Bash");
    expect(bashCall.content).toContain("rg -n 'total' src/orders.ts");
    const bashResult = results.find((c) => c.toolCallId === "toolu_01EXAMPLEAAA")!;
    expect(bashResult.content).toContain("src/orders.ts:42");
    // Результат со списочным контентом: text собран, image посчитан.
    const readResult = results.find((c) => c.toolCallId === "toolu_02EXAMPLEBBB")!;
    expect(readResult.content).toBe("File has been modified since read.");
    expect(readResult.metadata.isError).toBe(true);
    expect(readResult.metadata.imageCount).toBe(1);
  });

  test("tool_result-only user запись — role tool, не human", async () => {
    const { dialogue } = await parseFixture("tool-calls.jsonl");
    const toolMessages = dialogue.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    for (const message of toolMessages) {
      expect(message.humanAuthored).toBe(false);
      expect(message.visibleToUser).toBe(false);
      expect(message.chunks.every((c) => c.kind === "tool_result")).toBe(true);
    }
  });

  test("sidechain-сообщения помечены и не видны пользователю", async () => {
    const { dialogue } = await parseFixture("tool-calls.jsonl");
    const sidechain = dialogue.messages.filter((m) => m.metadata.sidechain === true);
    expect(sidechain).toHaveLength(2);
    for (const message of sidechain) {
      expect(message.visibleToUser).toBe(false);
    }
  });

  test("image в user message → attachment chunk", async () => {
    const { dialogue } = await parseFixture("tool-calls.jsonl");
    const user = dialogue.messages.find((m) => m.role === "user")!;
    expect(user.chunks.map((c) => c.kind)).toEqual(["text", "attachment"]);
    expect(user.chunks[1]!.metadata.mediaType).toBe("image/png");
  });
});

describe("claude-code parser: model-switch-usage", () => {
  test("модель задана per-message и может меняться между turn'ами", async () => {
    const { dialogue } = await parseFixture("model-switch-usage.jsonl");
    const assistants = dialogue.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.model?.rawModelName).toBe("claude-fable-5");
    expect(assistants[0]!.model?.vendor).toBe("anthropic");
    expect(assistants[1]!.model?.rawModelName).toBe("claude-opus-4-8");
    expect(assistants[1]!.model?.canonicalName).toBe("claude-opus-4-8");
  });

  test("user без origin → humanAuthored unknown", async () => {
    const { dialogue } = await parseFixture("model-switch-usage.jsonl");
    const users = dialogue.messages.filter((m) => m.role === "user");
    expect(users[0]!.humanAuthored).toBe(true);
    expect(users[1]!.humanAuthored).toBe("unknown");
  });

  test("три строки одного msg id: чанки склеены, usage один раз", async () => {
    const { dialogue } = await parseFixture("model-switch-usage.jsonl");
    const merged = dialogue.messages.find(
      (m) => m.role === "assistant" && m.externalId === "msg_07GGGEXAMPLE0007",
    )!;
    expect(merged.chunks.map((c) => c.kind)).toEqual(["thought", "text", "text"]);
    expect(merged.chunks.map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(merged.usageEvents).toHaveLength(1);
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["usage.deduped"]).toBe(2);
    // Сценарии 18+19: запрос не суммируется трижды, cached не double-counted.
    const usage = normalizeUsageEvents(merged.usageEvents)!;
    expect(usage.inputTokens).toBe(5500); // 1500 + 4000
    expect(usage.cachedInputTokens).toBe(4000);
    expect(usage.totalTokensNormalized).toBe(5700);
  });
});

describe("claude-code parser: unknown-and-empty", () => {
  test("сценарий 11: неизвестные события → unknown chunks, диалог цел", async () => {
    const { dialogue, diagnostics } = await parseFixture("unknown-and-empty.jsonl");
    const unknownChunks = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "unknown"),
    );
    expect(unknownChunks.map((c) => c.rawEventType).sort()).toEqual([
      "content.hologram",
      "quantum-flux",
    ]);
    expect(diagnostics.filter((d) => d.code === "unknown_event")).toHaveLength(2);
    // Диалог не потерян: user prompt и финальный ответ на месте.
    expect(dialogue.messages.some((m) => m.role === "user")).toBe(true);
    const final = [...dialogue.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.chunks.some((c) => c.kind === "text"))!;
    expect(final.chunks[0]!.content).toContain("список заметок");
  });

  test("пустое assistant message парсится с нулём чанков", async () => {
    const { dialogue } = await parseFixture("unknown-and-empty.jsonl");
    const empty = dialogue.messages.find(
      (m) => m.role === "assistant" && m.chunks.length === 0,
    );
    expect(empty).toBeDefined();
  });
});

describe("claude-code parser: unknown-large", () => {
  test("unknown chunk хранит событие полностью, без обрезки (§7.3)", async () => {
    const { dialogue, diagnostics } = await parseFixture("unknown-large.jsonl");
    const chunk = dialogue.messages
      .flatMap((m) => m.chunks)
      .find((c) => c.kind === "unknown")!;
    expect(chunk.rawEventType).toBe("content.hologram");
    expect(chunk.content!.length).toBeGreaterThan(4000);
    expect(chunk.content).toContain("TAIL_MARKER_UNKNOWN_EVENT");
    expect(diagnostics.some((d) => d.code === "unknown_event")).toBe(true);
  });
});

describe("claude-code parser: truncated", () => {
  test("обрезанная строка → diagnostic, остальной диалог парсится", async () => {
    const { dialogue, diagnostics } = await parseFixture("truncated.jsonl");
    expect(diagnostics.some((d) => d.code === "jsonl_parse_error")).toBe(true);
    expect(dialogue.externalId).toBe("ffff6666-2222-4333-8444-555555555555");
    expect(dialogue.messages.some((m) => m.role === "user")).toBe(true);
    expect(dialogue.messages.some((m) => m.role === "assistant")).toBe(true);
  });
});

describe("claude-code parser: long-final", () => {
  test("текст до и после tool activity — разные сообщения одного turn'а", async () => {
    const { dialogue } = await parseFixture("long-final.jsonl");
    const assistants = dialogue.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    // Первая часть отчёта и tool_call склеены в одно API-сообщение.
    expect(assistants[0]!.chunks.map((c) => c.kind)).toEqual(["text", "tool_call"]);
    expect(assistants[1]!.chunks.map((c) => c.kind)).toEqual(["text"]);
  });
});
