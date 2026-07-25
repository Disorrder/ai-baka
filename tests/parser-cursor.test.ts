import { afterEach, describe, expect, test } from "bun:test";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import {
  CURSOR_PARSER_VERSION,
  cursorParser,
} from "../src/parsers/cursor/index.ts";
import type {
  ParsedDialogue,
  ParsedSourceSnapshot,
} from "../src/domain/canonical-types.ts";
import { makeCursorDb, type CursorFixtureDb } from "./fixtures/cursor/make-db.ts";
import {
  COMPOSER_BASIC,
  COMPOSER_CORRUPT_BAD,
  COMPOSER_CORRUPT_OK,
  COMPOSER_SECOND,
  COMPOSER_TOOLS,
  basicDialogue,
  corrupted,
  multiDialogue,
  toolCallsDialogue,
  unknownAndEmpty,
  type CursorFixtureSpec,
} from "./fixtures/cursor/specs.ts";

const opened: CursorFixtureDb[] = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.cleanup();
});

async function parseFixture(
  spec: CursorFixtureSpec,
  workspaceHint?: string,
): Promise<{ snapshot: ParsedSourceSnapshot; dialogues: ParsedDialogue[] }> {
  const db = await makeCursorDb(spec);
  opened.push(db);
  const snapshot = await cursorParser.parse(
    db.path,
    workspaceHint !== undefined ? { workspaceHint } : undefined,
  );
  return { snapshot, dialogues: await collectDialogues(snapshot) };
}

describe("cursor parser: basic-dialogue", () => {
  test("метаданные диалога, workspace из composerHeaders, parser version", async () => {
    expect(cursorParser.parserName).toBe("cursor");
    expect(CURSOR_PARSER_VERSION).toBe(1);
    const { snapshot, dialogues } = await parseFixture(basicDialogue);
    expect(snapshot.sourceKind).toBe("sqlite");
    expect(dialogues).toHaveLength(1);
    const dialogue = dialogues[0]!;
    expect(dialogue.externalId).toBe(COMPOSER_BASIC);
    expect(dialogue.title).toBe("Объяснение кэша в src/cache.ts");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/demo-app");
    expect(dialogue.workspace?.name).toBe("demo-app");
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-10T12:00:00.000Z");
    expect(dialogue.updatedAt?.toISOString()).toBe("2026-07-10T12:05:00.000Z");
    expect(dialogue.metadata.unifiedMode).toBe("chat");
    expect(dialogue.metadata.isArchived).toBe(false);
  });

  test("роли, human_authored/visible_to_user, external_id сообщений", async () => {
    const { dialogues } = await parseFixture(basicDialogue);
    const [user, assistant] = dialogues[0]!.messages;
    expect(user!.sequence).toBe(0);
    expect(user!.role).toBe("user");
    expect(user!.rawRole).toBe("user");
    expect(user!.externalId).toBe("b-user-0001");
    expect(user!.humanAuthored).toBe(true);
    expect(user!.visibleToUser).toBe(true);
    expect(user!.chunks[0]!.kind).toBe("text");
    expect(user!.chunks[0]!.content).toBe("Объясни работу кэша в src/cache.ts");
    expect(assistant!.role).toBe("assistant");
    expect(assistant!.humanAuthored).toBe(false);
    expect(assistant!.visibleToUser).toBe(true);
    expect(assistant!.chunks[0]!.content).toContain("in-memory Map с TTL");
  });

  test("модель из usageData (одна модель) нормализуется на assistant message", async () => {
    const { dialogues } = await parseFixture(basicDialogue);
    const assistant = dialogues[0]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.model?.rawModelName).toBe("claude-4-sonnet-thinking");
    expect(assistant.model?.vendor).toBe("anthropic");
    expect(assistant.model?.canonicalName).toBe("claude-4-sonnet-thinking");
  });

  test("usage: request из tokenCount + cumulative usageData без double-count (№18, №19)", async () => {
    const { dialogues } = await parseFixture(basicDialogue);
    const assistant = dialogues[0]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.usageEvents.map((e) => e.scope)).toEqual([
      "request",
      "session_cumulative",
    ]);
    const request = assistant.usageEvents[0]!;
    expect(request.inputTokens).toBe(2350);
    expect(request.outputTokens).toBe(140);
    expect(request.isEstimated).toBe(true);
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    // Cumulative не прибавляется к request (№18).
    expect(usage.scope).toBe("request");
    expect(usage.inputTokens).toBe(2350);
    expect(usage.outputTokens).toBe(140);
    expect(usage.totalTokensNormalized).toBe(2490);
  });
});

describe("cursor parser: tool-calls", () => {
  test("сценарий 17: tool call ↔ tool result по tool_call_id", async () => {
    const { dialogues } = await parseFixture(toolCallsDialogue);
    const dialogue = dialogues[0]!;
    const calls = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_call"),
    );
    const results = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "tool_result"),
    );
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(calls[0]!.toolCallId).toBe("toolu_aaa001");
    expect(results[0]!.toolCallId).toBe("toolu_aaa001");
    expect(calls[0]!.toolName).toBe("grep_search");
    expect(calls[0]!.content).toContain("fetchOrder");
    expect(results[0]!.content).toContain("src/api/orders.ts");
    // tool result — отдельное tool-сообщение, невидимое.
    const toolMessage = dialogue.messages.find((m) =>
      m.chunks.some((c) => c.kind === "tool_result"),
    )!;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.visibleToUser).toBe(false);
  });

  test("reasoning: isThought bubble → thought chunk, невидим", async () => {
    const { dialogues } = await parseFixture(toolCallsDialogue);
    const thought = dialogues[0]!.messages.find((m) =>
      m.chunks.some((c) => c.kind === "thought"),
    )!;
    expect(thought.role).toBe("assistant");
    expect(thought.visibleToUser).toBe(false);
    expect(thought.chunks[0]!.content).toContain("как устроен слой API");
  });

  test("model switch: две модели → metadata.models, message.model не назначается", async () => {
    const { dialogues } = await parseFixture(toolCallsDialogue);
    const dialogue = dialogues[0]!;
    expect(dialogue.metadata.models).toEqual(["claude-4-sonnet", "gpt-5.6-sol"]);
    for (const message of dialogue.messages) {
      expect(message.model).toBeUndefined();
    }
  });

  test("операционные ключи → metadata.eventCounts, не чанки", async () => {
    const { dialogues } = await parseFixture(toolCallsDialogue);
    const dialogue = dialogues[0]!;
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts.checkpointId).toBe(2);
    expect(counts.codeBlockDiff).toBe(1);
    expect(
      dialogue.messages.flatMap((m) => m.chunks).every((c) => c.rawEventType !== "checkpointId"),
    ).toBe(true);
  });
});

describe("cursor parser: multi-dialogue", () => {
  test("несколько диалогов в одном snapshot, старый формат conversation, workspaceHint fallback", async () => {
    const { dialogues } = await parseFixture(multiDialogue, "/Users/example/projects/legacy-app");
    // Пустой draft не становится диалогом.
    expect(dialogues.map((d) => d.externalId)).toEqual([COMPOSER_BASIC, COMPOSER_SECOND]);
    const second = dialogues[1]!;
    expect(second.title).toBe("Второй диалог");
    expect(second.workspace?.path).toBe("/Users/example/projects/legacy-app");
    expect(second.workspace?.name).toBe("legacy-app");
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(second.messages[0]!.chunks[0]!.content).toBe("Покажи статус задачи");
  });
});

describe("cursor parser: unknown-and-empty", () => {
  test("сценарий 11: неизвестный bubble type → unknown chunk, диалог цел", async () => {
    const { snapshot, dialogues } = await parseFixture(unknownAndEmpty);
    const dialogue = dialogues[0]!;
    const unknown = dialogue.messages.find((m) =>
      m.chunks.some((c) => c.kind === "unknown"),
    )!;
    expect(unknown.role).toBe("unknown");
    expect(unknown.chunks[0]!.rawEventType).toBe("bubble.type.99");
    expect(unknown.chunks[0]!.content).toContain("hologramPayload");
    expect(snapshot.diagnostics.some((d) => d.code === "unknown_event")).toBe(true);
    // Диалог не потерян: user prompt и финальный ответ на месте.
    expect(dialogue.messages.some((m) => m.role === "user")).toBe(true);
    const last = dialogue.messages[dialogue.messages.length - 1]!;
    expect(last.chunks[0]!.content).toContain("список заметок");
  });

  test("пустое сообщение парсится, text-чанк с пустым содержимым", async () => {
    const { dialogues } = await parseFixture(unknownAndEmpty);
    const empty = dialogues[0]!.messages.find(
      (m) => m.role === "assistant" && m.chunks[0]?.content === "",
    );
    expect(empty).toBeDefined();
    expect(empty!.chunks[0]!.metadata.empty).toBe(true);
  });
});

describe("cursor parser: corrupted", () => {
  test("битый composerData пропускает один диалог, остальные парсятся", async () => {
    const { snapshot, dialogues } = await parseFixture(corrupted);
    expect(dialogues.map((d) => d.externalId)).toEqual([COMPOSER_CORRUPT_OK]);
    expect(
      snapshot.diagnostics.some(
        (d) => d.code === "composer_data_parse_error" && d.message.includes(COMPOSER_CORRUPT_BAD),
      ),
    ).toBe(true);
  });

  test("битый bubble → diagnostic + unknown chunk; missing bubble → diagnostic", async () => {
    const { snapshot, dialogues } = await parseFixture(corrupted);
    const dialogue = dialogues[0]!;
    expect(snapshot.diagnostics.some((d) => d.code === "bubble_parse_error")).toBe(true);
    expect(snapshot.diagnostics.some((d) => d.code === "missing_bubble")).toBe(true);
    const broken = dialogue.messages.find((m) =>
      m.chunks.some((c) => c.rawEventType === "bubble_parse_error"),
    )!;
    expect(broken.role).toBe("unknown");
    expect(broken.chunks[0]!.kind).toBe("unknown");
    // Остальные сообщения диалога на месте и sequence монотонен.
    expect(dialogue.messages.map((m) => m.sequence)).toEqual([0, 1, 2]);
    expect(dialogue.messages.some((m) => m.role === "user")).toBe(true);
    expect(dialogue.messages.some((m) => m.role === "assistant")).toBe(true);
  });
});

describe("cursor parser: не-sqlite вход (workspace.json)", () => {
  test("JSON-файл → unsupported_file, без SQLiteError", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "baka-cursor-json-"));
    try {
      const jsonPath = join(dir, "workspace.json");
      writeFileSync(jsonPath, '{"folder": "file:///Users/example/proj"}');
      const snapshot = await cursorParser.parse(jsonPath);
      const dialogues = await collectDialogues(snapshot);
      expect(dialogues).toHaveLength(0);
      expect(snapshot.diagnostics).toHaveLength(1);
      expect(snapshot.diagnostics[0]!.code).toBe("unsupported_file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
