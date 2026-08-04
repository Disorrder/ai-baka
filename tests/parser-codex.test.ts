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
    expect(CODEX_PARSER_VERSION).toBe(9);
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
    const workedResult = dialogue.messages.find((m) =>
      m.chunks.some((c) => c.toolCallId === "call_bbb002" && c.kind === "tool_result"),
    )!;
    expect(workedResult.metadata.reportedDurationMs).toBe(370000);
    expect(workedResult.metadata.reportedDurationSource).toBe("codex.tool_output.worked_for");
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

describe("codex parser: response timing", () => {
  test("task_complete/turn_aborted сохраняют ожидание на user message", async () => {
    const { dialogue } = await parseFixture("response-timing.jsonl");
    const users = dialogue.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(2);

    expect(users[0]!.responseWaitMs).toBe(5250);
    expect(users[0]!.responseStatus).toBe("completed");
    expect(users[0]!.responseCompletedAt?.toISOString()).toBe("2026-07-07T10:00:06.250Z");
    expect(users[0]!.responseTurnId).toBe("turn-completed");
    expect(users[0]!.metadata.responseWaitSource).toBe("codex.task_events");

    expect(users[1]!.responseWaitMs).toBe(3000);
    expect(users[1]!.responseStatus).toBe("aborted");
    expect(users[1]!.responseCompletedAt?.toISOString()).toBe("2026-07-07T10:01:04.000Z");
    expect(users[1]!.responseTurnId).toBe("turn-aborted");
    expect(users[1]!.metadata.responseAbortReason).toBe("interrupted");

    const completedAnchor = dialogue.messages.find(
      (message) => message.metadata.durationTurnId === "turn-completed",
    );
    expect(completedAnchor?.metadata.durationMs).toBe(6150);
    expect(completedAnchor?.metadata.durationSource).toBe("codex.task_events.completed");
    const abortedAnchor = dialogue.messages.find(
      (message) => message.metadata.durationTurnId === "turn-aborted",
    );
    expect(abortedAnchor?.metadata.durationMs).toBe(4000);
  });

  test("старый turn без turn_id получает общий synthetic id для queued messages", async () => {
    const { dialogue } = await parseFixture("response-timing-no-turn-id.jsonl");
    const users = dialogue.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(3);
    expect(users.map((message) => message.responseWaitMs)).toEqual([9000, 4000, undefined]);
    expect(users[0]!.responseTurnId).toBe("synthetic:1");
    expect(users[1]!.responseTurnId).toBe("synthetic:1");
    expect(users[2]!.responseTurnId).toBeUndefined();
    expect(users[2]!.humanAuthored).toBe("unknown");
    expect(users[2]!.metadata.durationMs).toBe(4000);
  });
});

describe("codex parser: related session metadata", () => {
  test("дополнительный parent session_meta не перезаписывает subagent identity/time", async () => {
    const { dialogue } = await parseFixture("related-session-meta.jsonl");
    expect(dialogue.externalId).toBe("child-session");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/child");
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-06T10:00:00.000Z");
    expect(dialogue.updatedAt?.toISOString()).toBe("2026-07-06T10:00:05.100Z");
    expect(dialogue.metadata.lineage).toEqual({
      parentSourceDialogueId: "parent-session",
      depth: 1,
    });
    expect(dialogue.metadata.relatedSessionMetas).toEqual([
      {
        id: "parent-session",
        source: "vscode",
      },
    ]);
    expect(dialogue.metadata.eventCounts).toMatchObject({
      "top:session_meta.related": 1,
    });
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

  test("token_count bucket-копии с идентичным info отбрасываются", async () => {
    const { dialogue } = await parseFixture("token-count-buckets.jsonl");
    const assistants = dialogue.messages.filter(
      (m) => m.role === "assistant" && m.usageEvents.length > 0,
    );
    expect(assistants).toHaveLength(1);
    // 5 token_count строк (3 + 2 копии rate-limit bucket'ов) → 2 вызова.
    const requests = assistants[0]!.usageEvents.filter((e) => e.scope === "request");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.inputTokens).toBe(1200);
    expect(requests[1]!.inputTokens).toBe(2400);
    const usage = normalizeUsageEvents(assistants[0]!.usageEvents)!;
    expect(usage.inputTokens).toBe(1200 + 2400);
    expect(usage.totalTokensNormalized).toBe(1200 + 300 + 2400 + 500);
    expect(dialogue.metadata.eventCounts).toMatchObject({
      "event_msg.token_count_bucket_duplicate": 3,
    });
  });

  test("forked session: duration_ms replay-истории parent не засчитывается", async () => {
    const { dialogue } = await parseFixture("forked-inherited-duration.jsonl");
    const withDuration = dialogue.messages.filter((m) => m.metadata.durationMs !== undefined);
    // Двухчасовой inherited duration (7200000 ms, started_at до fork'а)
    // отброшен; остаются envelope-delta ~1ms у inherited turn и свои 300000 ms.
    expect(withDuration.map((m) => m.metadata.durationMs)).not.toContain(7200000);
    const own = dialogue.messages.find((m) => m.metadata.durationMs === 300000);
    expect(own).toBeDefined();
    expect(own!.metadata.durationSource).toBe("codex.task_complete.duration_ms");
    expect(dialogue.metadata.eventCounts).toMatchObject({
      "event_msg.task_complete.inherited_duration": 1,
    });
    const sum = withDuration.reduce((s, m) => s + (m.metadata.durationMs as number), 0);
    expect(sum).toBeLessThan(400000);
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
