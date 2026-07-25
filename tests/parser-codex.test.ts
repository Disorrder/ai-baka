import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import {
  CODEX_PARSER_VERSION,
  codexParser,
} from "../src/parsers/codex/index.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

const FIXTURES = "tests/fixtures/codex";

async function parseFixture(
  name: string,
): Promise<{ dialogue: ParsedDialogue; diagnostics: { code: string }[] }> {
  const snapshot = await codexParser.parse(`${FIXTURES}/${name}`);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return { dialogue: dialogues[0]!, diagnostics: snapshot.diagnostics };
}

describe("codex parser: basic-dialogue", () => {
  test("метаданные диалога и parser version", async () => {
    expect(codexParser.parserName).toBe("codex");
    expect(CODEX_PARSER_VERSION).toBe(2);
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    expect(dialogue.externalId).toBe("11111111-2222-4333-8444-555555555555");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/demo-app");
    expect(dialogue.workspace?.name).toBe("demo-app");
    expect(dialogue.workspace?.repositoryIdentity).toBe(
      "git@github.com:example/demo-app.git",
    );
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(dialogue.metadata.cliVersion).toBe("0.50.0");
  });

  test("авто-контекст не human-authored, промпт подтверждён user_message", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const users = dialogue.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    const [envContext, prompt] = users;
    expect(envContext!.humanAuthored).toBe(false);
    expect(envContext!.visibleToUser).toBe(false);
    expect(envContext!.chunks[0]!.metadata.autoContext).toBe(true);
    expect(prompt!.humanAuthored).toBe(true);
    expect(prompt!.metadata.userMessageText).toContain("parseConfig");
  });

  test("reasoning → thought chunk, невидим", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const reasoning = dialogue.messages.find((m) =>
      m.chunks.some((c) => c.kind === "thought"),
    )!;
    expect(reasoning.role).toBe("assistant");
    expect(reasoning.visibleToUser).toBe(false);
    expect(reasoning.chunks[0]!.content).toContain("parseConfig");
    expect(reasoning.chunks[0]!.metadata.encrypted).toBe(true);
  });

  test("assistant message получает phase final_answer", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const assistant = [...dialogue.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.chunks.some((c) => c.kind === "text"))!;
    expect(assistant.metadata.phase).toBe("final_answer");
    expect(assistant.visibleToUser).toBe(true);
  });

  test("usage: request + cumulative events, нормализация без double-count", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const assistant = [...dialogue.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.usageEvents.length > 0)!;
    expect(assistant.usageEvents.map((e) => e.scope)).toEqual([
      "request",
      "session_cumulative",
    ]);
    // Сценарии 18+19: выбран request, cached/reasoning не плюсуются повторно.
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    expect(usage.scope).toBe("request");
    expect(usage.inputTokens).toBe(5200);
    expect(usage.cachedInputTokens).toBe(3100);
    expect(usage.reasoningOutputTokens).toBe(60);
    expect(usage.totalTokensNormalized).toBe(5340);
    expect(usage.totalTokensReported).toBe(5340);
  });
});

describe("codex parser: tool-calls", () => {
  test("сценарий 17: tool call ↔ tool result по tool_call_id", async () => {
    const { dialogue } = await parseFixture("tool-calls.jsonl");
    const calls = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_call"),
    );
    const results = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_result"),
    );
    expect(calls.map((c) => c.toolCallId).sort()).toEqual(["call_aaa001", "call_bbb002"]);
    expect(results.map((c) => c.toolCallId).sort()).toEqual(["call_aaa001", "call_bbb002"]);
    const rgCall = calls.find((c) => c.toolCallId === "call_aaa001")!;
    expect(rgCall.toolName).toBe("exec_command");
    expect(rgCall.content).toContain("rg -n fetchOrder");
    const rgResult = results.find((c) => c.toolCallId === "call_aaa001")!;
    expect(rgResult.content).toContain("src/api/orders.ts:12");
  });

  test("модель из turn_context на assistant messages", async () => {
    const { dialogue } = await parseFixture("tool-calls.jsonl");
    const assistant = dialogue.messages.find(
      (m) => m.role === "assistant" && m.model,
    )!;
    expect(assistant.model?.rawModelName).toBe("gpt-5.6-sol");
    expect(assistant.model?.canonicalName).toBe("gpt-5.6-sol");
    expect(assistant.model?.vendor).toBe("openai");
    expect(assistant.model?.serviceProvider).toBe("openai");
  });
});

describe("codex parser: model-switch", () => {
  test("смена модели и reasoning effort между turn'ами", async () => {
    const { dialogue } = await parseFixture("model-switch.jsonl");
    const assistants = dialogue.messages.filter(
      (m) => m.role === "assistant" && m.chunks.some((c) => c.kind === "text"),
    );
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.model?.rawModelName).toBe("gpt-5.6-sol");
    expect(assistants[0]!.model?.reasoningEffort).toBeUndefined();
    // turn_context сообщил raw имя с effort-суффиксом (пример из плана §7.1).
    expect(assistants[1]!.model?.rawModelName).toBe("gpt-5.6-sol-xhigh");
    expect(assistants[1]!.model?.canonicalName).toBe("gpt-5.6-sol");
    expect(assistants[1]!.model?.reasoningEffort).toBe("xhigh");
    expect(assistants[1]!.model?.serviceProvider).toBe("openai");
  });

  test("сценарий 18: cumulative token_count не суммируется как turns", async () => {
    const { dialogue } = await parseFixture("model-switch.jsonl");
    const assistants = dialogue.messages.filter(
      (m) => m.role === "assistant" && m.usageEvents.length > 0,
    );
    expect(assistants).toHaveLength(2);
    // Второй ответ: cumulative total 9400, per-request 6400 — берём request.
    const usage = normalizeUsageEvents(assistants[1]!.usageEvents)!;
    expect(usage.scope).toBe("request");
    expect(usage.inputTokens).toBe(6400);
    // Суммы сообщений (3000+6400=9400) получаются из request-событий,
    // а не из cumulative-события напрямую.
  });
});

describe("codex parser: unknown-and-empty", () => {
  test("сценарий 11: неизвестные события → unknown chunks, диалог цел", async () => {
    const { dialogue, diagnostics } = await parseFixture("unknown-and-empty.jsonl");
    const unknownChunks = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "unknown"),
    );
    expect(unknownChunks.map((c) => c.rawEventType).sort()).toEqual([
      "event_msg.hologram_rendered",
      "response_item.quantum_flux_capacitor",
    ]);
    expect(diagnostics.filter((d) => d.code === "unknown_event")).toHaveLength(2);
    // Диалог не потерян: user prompt и финальный ответ на месте.
    expect(dialogue.messages.some((m) => m.role === "user")).toBe(true);
    const final = [...dialogue.messages]
      .reverse()
      .find((m) => m.metadata.phase === "final_answer")!;
    expect(final.chunks[0]!.content).toContain("список заметок");
  });

  test("пустое сообщение парсится с нулём чанков", async () => {
    const { dialogue } = await parseFixture("unknown-and-empty.jsonl");
    const empty = dialogue.messages.find(
      (m) => m.role === "assistant" && m.chunks.length === 0,
    );
    expect(empty).toBeDefined();
  });
});

describe("codex parser: truncated", () => {
  test("обрезанная строка → diagnostic, остальной диалог парсится", async () => {
    const { dialogue, diagnostics } = await parseFixture("truncated.jsonl");
    expect(diagnostics.some((d) => d.code === "jsonl_parse_error")).toBe(true);
    expect(dialogue.externalId).toBe("55555555-6666-4777-8888-999999999999");
    expect(dialogue.messages.some((m) => m.role === "user")).toBe(true);
  });
});

describe("codex parser: sqlite source (~/.codex/sqlite)", () => {
  test("sqlite-файл → одна unsupported_file-диагностика, без jsonl_parse_error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "baka-codex-sqlite-"));
    try {
      const file = path.join(dir, "state_5.sqlite");
      await writeFile(
        file,
        Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(128, 7)]),
      );
      const snapshot = await codexParser.parse(file);
      expect(await collectDialogues(snapshot)).toHaveLength(0);
      expect(snapshot.diagnostics).toHaveLength(1);
      expect(snapshot.diagnostics[0]!.code).toBe("unsupported_file");
      expect(snapshot.diagnostics[0]!.severity).toBe("error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
