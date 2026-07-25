import { describe, expect, test } from "bun:test";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import {
  QWEN_CODE_PARSER_VERSION,
  qwenCodeParser,
} from "../src/parsers/qwen-code/index.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

const FIXTURES = "tests/fixtures/qwen-code";

async function parseChat(
  name: string,
): Promise<{ dialogue: ParsedDialogue; diagnostics: { code: string }[] }> {
  const snapshot = await qwenCodeParser.parse(`${FIXTURES}/${name}`);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return { dialogue: dialogues[0]!, diagnostics: snapshot.diagnostics };
}

describe("qwen-code parser: basic-dialogue", () => {
  test("метаданные диалога и parser version", async () => {
    expect(qwenCodeParser.parserName).toBe("qwen-code");
    expect(QWEN_CODE_PARSER_VERSION).toBe(1);
    const { dialogue } = await parseChat("basic-dialogue.jsonl");
    expect(dialogue.externalId).toBe("11111111-1111-4111-8111-111111111111");
    expect(dialogue.title).toBeUndefined();
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/demo-app");
    expect(dialogue.workspace?.name).toBe("demo-app");
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-20T10:00:00.000Z");
    expect(dialogue.updatedAt?.toISOString()).toBe("2026-07-20T10:01:14.000Z");
    expect(dialogue.metadata.cliVersion).toBe("0.20.1");
    expect(dialogue.metadata.gitBranch).toBe("main");
  });

  test("операционные system-события — только eventCounts, не сообщения", async () => {
    const { dialogue } = await parseChat("basic-dialogue.jsonl");
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["system.attribution_snapshot"]).toBe(1);
    expect(counts["system.file_history_snapshot"]).toBe(1);
    expect(counts["system.ui_telemetry"]).toBe(1);
    // user + assistant + mid_turn user + assistant.
    expect(dialogue.messages).toHaveLength(4);
  });

  test("user human-authored, mid_turn — тоже человек", async () => {
    const { dialogue } = await parseChat("basic-dialogue.jsonl");
    const users = dialogue.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]!.humanAuthored).toBe(true);
    expect(users[0]!.visibleToUser).toBe(true);
    expect(users[0]!.chunks[0]!.content).toBe(
      "Объясни, что делает функция parseConfig в этом проекте.",
    );
    expect(users[1]!.humanAuthored).toBe(true);
    expect(users[1]!.metadata.subtype).toBe("mid_turn_user_message");
  });

  test("assistant: thought/text-чанки, модель qwen → alibaba", async () => {
    const { dialogue } = await parseChat("basic-dialogue.jsonl");
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
    expect(assistant.chunks[0]!.content).toContain("найти функцию parseConfig");
    expect(assistant.rawRole).toBe("model");
    expect(assistant.model?.rawModelName).toBe("qwen3.8-max-preview");
    expect(assistant.model?.canonicalName).toBe("qwen3.8-max-preview");
    expect(assistant.model?.vendor).toBe("alibaba");
    expect(assistant.metadata.contextWindowSize).toBe(1000000);
  });

  test("сценарий 19: cached/reasoning не double-counted", async () => {
    const { dialogue } = await parseChat("basic-dialogue.jsonl");
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.usageEvents).toHaveLength(1);
    const event = assistant.usageEvents[0]!;
    expect(event.scope).toBe("request");
    expect(event.inputTokens).toBe(1200);
    expect(event.cachedInputTokens).toBe(300);
    expect(event.outputTokens).toBe(90);
    expect(event.reasoningOutputTokens).toBe(40);
    expect(event.totalTokensReported).toBe(1290);
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    // 1200 + 90: cached (внутри input) и thoughts (внутри output) не прибавляются.
    expect(usage.totalTokensNormalized).toBe(1290);
  });
});

describe("qwen-code parser: tool-calls", () => {
  test("сценарий 17: tool call ↔ tool result по toolCallId", async () => {
    const { dialogue } = await parseChat("tool-calls.jsonl");
    const calls = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_call"),
    );
    const results = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_result"),
    );
    expect(calls.map((c) => c.toolCallId)).toEqual(["call_aaa111", "call_bbb222"]);
    expect(results.map((c) => c.toolCallId)).toEqual(["call_aaa111", "call_bbb222"]);
    expect(calls[0]!.toolName).toBe("run_shell_command");
    expect(JSON.parse(calls[0]!.content!)).toMatchObject({ command: "rg -n createOrder src" });
    const readResult = results.find((c) => c.toolCallId === "call_bbb222")!;
    expect(readResult.toolName).toBe("read_file");
    expect(readResult.content).toContain("submit(); submit();");
    expect(readResult.metadata.status).toBe("success");
  });

  test("tool_result — role tool, невидим; assistant с вызовами тоже невидим", async () => {
    const { dialogue } = await parseChat("tool-calls.jsonl");
    const roles = dialogue.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    const toolMessages = dialogue.messages.filter((m) => m.role === "tool");
    for (const message of toolMessages) {
      expect(message.visibleToUser).toBe(false);
      expect(message.humanAuthored).toBe(false);
    }
  });

  test("usage: большой cache в input, нормализация без двойного счёта", async () => {
    const { dialogue } = await parseChat("tool-calls.jsonl");
    const first = dialogue.messages.find((m) => m.role === "assistant")!;
    const usage = normalizeUsageEvents(first.usageEvents)!;
    expect(usage.inputTokens).toBe(8000);
    expect(usage.cachedInputTokens).toBe(5000);
    expect(usage.outputTokens).toBe(120);
    expect(usage.totalTokensNormalized).toBe(8120);
  });
});

describe("qwen-code parser: unknown-truncated", () => {
  test("сценарий 11: неизвестные события → unknown chunks + diagnostics", async () => {
    const { dialogue, diagnostics } = await parseChat("unknown-truncated.jsonl");
    const unknownChunks = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "unknown"),
    );
    const rawTypes = unknownChunks.map((c) => c.rawEventType);
    expect(rawTypes).toContain("system.quantum_checkpoint");
    expect(rawTypes).toContain("time_travel");
    expect(rawTypes.some((t) => t?.startsWith("part.unknown_part:hologram"))).toBe(true);
    expect(
      diagnostics.filter((d) => d.code === "unknown_event").length,
    ).toBeGreaterThanOrEqual(4);
    // Известные сообщения не потеряны.
    expect(
      dialogue.messages.some((m) =>
        m.chunks.some((c) => c.content === "Отвечу коротко."),
      ),
    ).toBe(true);
  });

  test("пустое user message (parts: []) не роняет разбор", async () => {
    const { dialogue } = await parseChat("unknown-truncated.jsonl");
    const empty = dialogue.messages.find((m) => m.role === "user" && m.chunks.length === 0)!;
    expect(empty.humanAuthored).toBe(true);
    expect(empty.sequence).toBe(0);
  });

  test("notification и cron — не human-authored", async () => {
    const { dialogue } = await parseChat("unknown-truncated.jsonl");
    const notification = dialogue.messages.find((m) => m.metadata.subtype === "notification")!;
    expect(notification.humanAuthored).toBe(false);
    const cron = dialogue.messages.find((m) => m.metadata.subtype === "cron")!;
    expect(cron.humanAuthored).toBe(false);
    expect(cron.visibleToUser).toBe(false);
  });

  test("неизвестный user subtype: humanAuthored unknown + diagnostic", async () => {
    const { dialogue, diagnostics } = await parseChat("unknown-truncated.jsonl");
    const mystery = dialogue.messages.find((m) => m.metadata.subtype === "mystery_subtype")!;
    expect(mystery.role).toBe("user");
    expect(mystery.humanAuthored).toBe("unknown");
    expect(mystery.chunks[0]!.kind).toBe("text");
    expect(
      diagnostics.some(
        (d) => d.code === "unknown_event" && d.code !== undefined,
      ),
    ).toBe(true);
  });

  test("обрезанная последняя строка → diagnostic, диалог цел", async () => {
    const { dialogue, diagnostics } = await parseChat("unknown-truncated.jsonl");
    expect(diagnostics.some((d) => d.code === "jsonl_parse_error")).toBe(true);
    expect(dialogue.externalId).toBe("33333333-3333-4333-8333-333333333333");
    expect(dialogue.messages.length).toBeGreaterThan(0);
  });
});

describe("qwen-code parser: subagent (sidechain)", () => {
  test("externalId = agentId, parentSessionId в metadata", async () => {
    const { dialogue } = await parseChat("subagent.jsonl");
    expect(dialogue.externalId).toBe("Explore-call_ccc333");
    expect(dialogue.metadata.isSidechain).toBe(true);
    expect(dialogue.metadata.agentName).toBe("Explore");
    expect(dialogue.metadata.parentSessionId).toBe("22222222-2222-4222-8222-222222222222");
  });

  test("промпт субагента не human-authored и невидим", async () => {
    const { dialogue } = await parseChat("subagent.jsonl");
    const prompt = dialogue.messages.find((m) => m.role === "user")!;
    expect(prompt.humanAuthored).toBe(false);
    expect(prompt.visibleToUser).toBe(false);
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.visibleToUser).toBe(false);
    expect(assistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
  });
});
