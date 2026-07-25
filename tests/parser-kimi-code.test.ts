import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import {
  KIMI_CODE_PARSER_VERSION,
  kimiCodeParser,
} from "../src/parsers/kimi-code/index.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

const FIXTURES = "tests/fixtures/kimi-code";
const BASIC = join(FIXTURES, "basic/session_11111111-aaaa-4bbb-8ccc-111111111111");
const TOOLS = join(FIXTURES, "tools-and-subagent/session_22222222-bbbb-4ccc-8ddd-222222222222");
const UNKNOWN = join(FIXTURES, "unknown-truncated/session_33333333-cccc-4ddd-8eee-333333333333");

async function parseSession(
  path: string,
): Promise<{ dialogue: ParsedDialogue; diagnostics: { code: string }[] }> {
  const snapshot = await kimiCodeParser.parse(path);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return { dialogue: dialogues[0]!, diagnostics: snapshot.diagnostics };
}

describe("kimi-code parser: basic", () => {
  test("метаданные диалога из state.json и parser version", async () => {
    expect(kimiCodeParser.parserName).toBe("kimi-code");
    expect(KIMI_CODE_PARSER_VERSION).toBe(1);
    const { dialogue } = await parseSession(BASIC);
    expect(dialogue.externalId).toBe("session_11111111-aaaa-4bbb-8ccc-111111111111");
    expect(dialogue.title).toContain("кэша");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/demo-app");
    expect(dialogue.workspace?.name).toBe("demo-app");
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-10T12:00:00.000Z");
    expect(dialogue.metadata.protocolVersion).toBe("1.4");
  });

  test("turn.prompt human-authored, append_message дедуплицирован", async () => {
    const { dialogue } = await parseSession(BASIC);
    const users = dialogue.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.humanAuthored).toBe(true);
    expect(users[0]!.chunks[0]!.content).toBe("Объясни работу кэша в src/cache.ts");
  });

  test("assistant: think → thought, text → text, модель из llm.request", async () => {
    const { dialogue } = await parseSession(BASIC);
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
    expect(assistant.chunks[0]!.content).toContain("прочитаю");
    expect(assistant.model?.rawModelName).toBe("kimi-code/k3");
    expect(assistant.model?.canonicalName).toBe("k3");
    expect(assistant.model?.vendor).toBe("moonshot");
    expect(assistant.model?.reasoningEffort).toBe("high");
    expect(assistant.model?.serviceProvider).toBe("kimi");
  });

  test("usage: step.end (request) + usage.record (turn), input включает cache", async () => {
    const { dialogue } = await parseSession(BASIC);
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.usageEvents.map((e) => e.scope).sort()).toEqual(["request", "turn"]);
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    expect(usage.scope).toBe("request");
    // inputOther 800 + cacheRead 4200 + cacheCreation 0.
    expect(usage.inputTokens).toBe(5000);
    expect(usage.cachedInputTokens).toBe(4200);
    expect(usage.outputTokens).toBe(120);
    expect(usage.totalTokensNormalized).toBe(5120);
  });

  test("parse принимает и отдельный wire.jsonl", async () => {
    const { dialogue } = await parseSession(join(BASIC, "agents/main/wire.jsonl"));
    expect(dialogue.externalId).toBe("session_11111111-aaaa-4bbb-8ccc-111111111111");
    expect(dialogue.messages.length).toBeGreaterThan(0);
  });
});

describe("kimi-code parser: tools-and-subagent", () => {
  test("сценарий 17: tool call ↔ tool result по toolCallId", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const calls = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_call"),
    );
    const results = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_result"),
    );
    expect(calls.map((c) => c.toolCallId).sort()).toEqual([
      "tool_call_aaa111",
      "tool_call_bbb222",
    ]);
    expect(results.map((c) => c.toolCallId).sort()).toEqual([
      "tool_call_aaa111",
      "tool_call_bbb222",
    ]);
    const bashCall = calls.find((c) => c.toolCallId === "tool_call_aaa111")!;
    expect(bashCall.toolName).toBe("Bash");
    const bashResult = results.find((c) => c.toolCallId === "tool_call_aaa111")!;
    expect(bashResult.content).toContain("heap grew 12MB");
  });

  test("субагент: часть диалога, metadata.subagentId, не human-authored", async () => {
    const { dialogue } = await parseSession(TOOLS);
    expect(dialogue.metadata.forkedFrom).toBe(
      "session_00000000-dead-4eef-8000-000000000000",
    );
    expect(dialogue.metadata.subagentIds).toEqual(["agent-0"]);
    const subMessages = dialogue.messages.filter(
      (m) => m.metadata.subagentId === "agent-0",
    );
    expect(subMessages.length).toBeGreaterThan(0);
    const subPrompt = subMessages.find((m) => m.role === "user")!;
    expect(subPrompt.humanAuthored).toBe(false);
    expect(subPrompt.visibleToUser).toBe(false);
    const subAssistant = subMessages.find((m) => m.role === "assistant")!;
    expect(subAssistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
    // main-сообщения без subagentId.
    expect(
      dialogue.messages.filter((m) => m.metadata.subagentId === undefined).length,
    ).toBeGreaterThan(subMessages.length);
  });

  test("сообщения main и субагента слиты по времени", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const sequences = dialogue.messages.map((m) => m.sequence);
    expect(sequences).toEqual([...sequences.keys()]);
    const subPrompt = dialogue.messages.find(
      (m) => m.metadata.subagentId === "agent-0" && m.role === "user",
    )!;
    const mainToolCall = dialogue.messages.find((m) =>
      m.chunks.some((c) => c.toolCallId === "tool_call_bbb222"),
    )!;
    // Субагент запущен (1783500002002) после tool.call (1783500001400).
    expect(subPrompt.sequence).toBeGreaterThan(mainToolCall.sequence);
  });

  test("usage turn scope на последнем assistant сообщении turn'а", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const mainAssistants = dialogue.messages.filter(
      (m) => m.role === "assistant" && m.metadata.subagentId === undefined,
    );
    const last = mainAssistants[mainAssistants.length - 1]!;
    const turnEvent = last.usageEvents.find((e) => e.scope === "turn")!;
    // Накопительные значения turn'а из usage.record.
    expect(turnEvent.inputTokens).toBe(3800 + 17600 + 500);
    expect(turnEvent.cachedInputTokens).toBe(17600);
  });
});

describe("kimi-code parser: unknown-truncated", () => {
  test("сценарий 11: unknown loop/top-level/content-part события сохраняются", async () => {
    const { dialogue, diagnostics } = await parseSession(UNKNOWN);
    const unknownChunks = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "unknown"),
    );
    const rawTypes = unknownChunks.map((c) => c.rawEventType).sort();
    expect(rawTypes).toContain("loop.quantum.entangle");
    expect(rawTypes).toContain("time_travel");
    expect(rawTypes).toContain("content.part.hologram");
    expect(diagnostics.filter((d) => d.code === "unknown_event").length).toBeGreaterThanOrEqual(3);
  });

  test("пустое user message не роняет разбор", async () => {
    const { dialogue } = await parseSession(UNKNOWN);
    const user = dialogue.messages.find((m) => m.role === "user")!;
    expect(user.humanAuthored).toBe(true);
    expect(user.chunks[0]!.content).toBe("");
  });

  test("обрезанный хвост wire.jsonl → diagnostic, диалог цел", async () => {
    const { dialogue, diagnostics } = await parseSession(UNKNOWN);
    expect(diagnostics.some((d) => d.code === "jsonl_parse_error")).toBe(true);
    expect(dialogue.externalId).toBe("session_33333333-cccc-4ddd-8eee-333333333333");
  });
});
