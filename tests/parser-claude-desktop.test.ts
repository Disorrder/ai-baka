import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import {
  CLAUDE_DESKTOP_PARSER_VERSION,
  claudeDesktopParser,
} from "../src/parsers/claude-desktop/index.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

const FIXTURES = "tests/fixtures/claude-desktop";
const BASIC_DIR = join(FIXTURES, "basic/local_11111111-1111-4111-8111-111111111111");
const BASIC = join(BASIC_DIR, "audit.jsonl");
const TOOLS = join(FIXTURES, "tools-sidechain/local_22222222-2222-4222-8222-222222222222/audit.jsonl");
const STREAMING = join(FIXTURES, "streaming/local_55555555-5555-4555-8555-555555555555/audit.jsonl");
const UNKNOWN = join(FIXTURES, "unknown-truncated/local_33333333-3333-4333-8333-333333333333/audit.jsonl");
const METADATA_ONLY = join(FIXTURES, "metadata-only/local_44444444-4444-4444-8444-444444444444.json");
const LEVELDB = join(FIXTURES, "leveldb/000005.ldb");

async function parseSession(
  path: string,
): Promise<{ dialogue: ParsedDialogue; diagnostics: { code: string }[] }> {
  const snapshot = await claudeDesktopParser.parse(path);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return { dialogue: dialogues[0]!, diagnostics: snapshot.diagnostics };
}

describe("claude-desktop parser: basic", () => {
  test("метаданные диалога из local_*.json и parser version", async () => {
    expect(claudeDesktopParser.parserName).toBe("claude-desktop");
    expect(CLAUDE_DESKTOP_PARSER_VERSION).toBe(4);
    const { dialogue } = await parseSession(BASIC);
    expect(dialogue.externalId).toBe("local_11111111-1111-4111-8111-111111111111");
    expect(dialogue.title).toBe("VACUUM INTO и копирование SQLite");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/demo-app");
    expect(dialogue.workspace?.name).toBe("demo-app");
    expect(dialogue.startedAt?.getTime()).toBe(1783900000000);
    expect(dialogue.updatedAt?.getTime()).toBe(1783900060000);
    expect(dialogue.metadata.cliSessionId).toBe("aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa");
    expect(dialogue.metadata.permissionMode).toBe("acceptEdits");
  });

  test("user string content — human-authored промпт", async () => {
    const { dialogue } = await parseSession(BASIC);
    const user = dialogue.messages.find((m) => m.role === "user")!;
    expect(user.humanAuthored).toBe(true);
    expect(user.visibleToUser).toBe(true);
    expect(user.externalId).toBe("11111111-0000-4000-8000-000000000001");
    expect(user.chunks).toHaveLength(1);
    expect(user.chunks[0]!.kind).toBe("text");
    expect(user.chunks[0]!.content).toContain("VACUUM INTO");
  });

  test("assistant: thinking → thought, text → text, модель нормализована", async () => {
    const { dialogue } = await parseSession(BASIC);
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    expect(assistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
    expect(assistant.chunks[0]!.metadata.hasSignature).toBe(true);
    expect(assistant.model?.rawModelName).toBe("claude-opus-4-6");
    expect(assistant.model?.canonicalName).toBe("claude-opus-4-6");
    expect(assistant.model?.vendor).toBe("anthropic");
    expect(assistant.model?.reasoningEffort).toBe("high");
  });

  test("сценарий 18/19: request usage + cumulative result usage не суммируются, cache не double-counted", async () => {
    const { dialogue } = await parseSession(BASIC);
    const assistant = dialogue.messages.find((m) => m.role === "assistant")!;
    // message.usage (request) + result.usage (turn) на одном сообщении.
    expect(assistant.usageEvents.map((e) => e.scope).sort()).toEqual(["request", "turn"]);
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    expect(usage.scope).toBe("request");
    // 12 + 3000 + 15000 (input_tokens НЕ включает cache в формате Anthropic).
    expect(usage.inputTokens).toBe(18012);
    expect(usage.cachedInputTokens).toBe(15000);
    expect(usage.cacheWriteInputTokens).toBe(3000);
    expect(usage.outputTokens).toBe(240);
    expect(usage.totalTokensNormalized).toBe(18252);
    // marker конца turn'а от result-события (для extractor'а).
    expect(assistant.metadata.turnResult).toMatchObject({
      subtype: "success",
      stopReason: "end_turn",
      numTurns: 1,
      durationMs: 4200,
      durationApiMs: 4000,
    });
    expect(assistant.metadata.durationMs).toBe(4200);
    expect(assistant.metadata.durationSource).toBe("claude-desktop.result.duration_ms");
    expect(assistant.metadata.durationApiMs).toBe(4000);
  });

  test("операционные события — только eventCounts", async () => {
    const { dialogue } = await parseSession(BASIC);
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["system.init"]).toBe(1);
    expect(counts["rate_limit_event"]).toBe(1);
    expect(counts["result.success"]).toBe(1);
    // init/rate_limit/result не стали сообщениями.
    expect(dialogue.messages).toHaveLength(2);
  });

  test("parse принимает каталог сессии", async () => {
    const { dialogue } = await parseSession(BASIC_DIR);
    expect(dialogue.externalId).toBe("local_11111111-1111-4111-8111-111111111111");
    expect(dialogue.messages.length).toBeGreaterThan(0);
  });
});

describe("claude-desktop parser: streaming", () => {
  test("записи одного message.id склеиваются, usage не задваивается", async () => {
    const { dialogue } = await parseSession(STREAMING);
    const assistants = dialogue.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    const assistant = assistants[0]!;
    expect(assistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
    expect(assistant.chunks.map((c) => c.sequence)).toEqual([0, 1]);
    // Первая запись стриминга без text была невидимой; после склейки — видима.
    expect(assistant.visibleToUser).toBe(true);
    expect(assistant.metadata.stopReason).toBe("end_turn");
    // usage повторялся в обеих записях — засчитан один раз (+ turn от result).
    expect(assistant.usageEvents.map((e) => e.scope).sort()).toEqual(["request", "turn"]);
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["usage.deduped"]).toBe(1);
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    expect(usage.inputTokens).toBe(2520); // 20 + 500 + 2000, один раз
    expect(usage.cachedInputTokens).toBe(2000);
    expect(usage.cacheWriteInputTokens).toBe(500);
    // result-событие привязалось к склеенному сообщению.
    expect(assistant.metadata.turnResult).toMatchObject({ subtype: "success" });
  });
});

describe("claude-desktop parser: tools-sidechain", () => {
  test("<uploaded_files> → attachment chunk, текст промпта чистый", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const user = dialogue.messages[0]!;
    expect(user.role).toBe("user");
    expect(user.chunks.map((c) => c.kind)).toEqual(["attachment", "text"]);
    expect(user.chunks[0]!.metadata.uploadedFiles).toEqual(["/Users/example/docs/spec.md"]);
    expect(user.chunks[1]!.content).toBe("Прочитай spec.md и перечисли три главных риска проекта.");
  });

  test("сценарий 17: tool_call ↔ tool_result по toolCallId", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const calls = dialogue.messages.flatMap((m) => m.chunks.filter((c) => c.kind === "tool_call"));
    const results = dialogue.messages.flatMap((m) => m.chunks.filter((c) => c.kind === "tool_result"));
    const readCall = calls.find((c) => c.toolCallId === "toolu_01AAA111")!;
    expect(readCall.toolName).toBe("Read");
    expect(readCall.content).toContain("spec.md");
    const readResult = results.find((c) => c.toolCallId === "toolu_01AAA111")!;
    expect(readResult.content).toContain("Пример спецификации");
    // tool_result — сообщение роли tool, невидимое.
    const toolMessage = dialogue.messages.find((m) =>
      m.chunks.some((c) => c.toolCallId === "toolu_01AAA111" && c.kind === "tool_result"),
    )!;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.visibleToUser).toBe(false);
  });

  test("sidechain (parent_tool_use_id): не human-authored, не видим, metadata.parentToolUseId", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const sidechain = dialogue.messages.filter((m) => m.metadata.parentToolUseId === "toolu_01CCC333");
    expect(sidechain.length).toBeGreaterThanOrEqual(3);
    const subPrompt = sidechain.find((m) => m.role === "user")!;
    expect(subPrompt.humanAuthored).toBe(false);
    expect(subPrompt.visibleToUser).toBe(false);
    expect(subPrompt.chunks[0]!.content).toBe("Изучи структуру каталога проекта.");
    // Основная цепочка не помечена parentToolUseId.
    const mainUser = dialogue.messages[0]!;
    expect(mainUser.metadata.parentToolUseId).toBeUndefined();
  });

  test("модель sidechain-сообщения из его собственного события", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const sub = dialogue.messages.find(
      (m) => m.metadata.parentToolUseId === "toolu_01CCC333" && m.role === "assistant",
    )!;
    expect(sub.model?.rawModelName).toBe("claude-haiku-4-5-20251001");
    expect(sub.model?.vendor).toBe("anthropic");
  });

  test("сценарий 18: result.usage (turn) не суммируется с request usage", async () => {
    const { dialogue } = await parseSession(TOOLS);
    const last = dialogue.messages[dialogue.messages.length - 1]!;
    expect(last.role).toBe("assistant");
    const turnEvent = last.usageEvents.find((e) => e.scope === "turn")!;
    // Cumulative за весь запуск: 20 + 4200 + 57000.
    expect(turnEvent.inputTokens).toBe(61220);
    expect(turnEvent.cachedInputTokens).toBe(57000);
    expect(turnEvent.cacheWriteInputTokens).toBe(4200);
    const usage = normalizeUsageEvents(last.usageEvents)!;
    expect(usage.scope).toBe("request");
    // Только request-событие сообщения, turn не прибавился.
    expect(usage.inputTokens).toBe(43208);
    expect(usage.totalTokensNormalized).toBe(43388);
  });
});

describe("claude-desktop parser: unknown-truncated", () => {
  test("сценарий 11: неизвестные события сохраняются как unknown чанки", async () => {
    const { dialogue, diagnostics } = await parseSession(UNKNOWN);
    const unknownChunks = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "unknown"),
    );
    const rawTypes = unknownChunks.map((c) => c.rawEventType).sort();
    expect(rawTypes).toEqual([
      "assistant.content.hologram",
      "quantum_flux",
      "system.wormhole",
    ]);
    expect(
      diagnostics.filter((d) => d.code === "unknown_event").length,
    ).toBeGreaterThanOrEqual(3);
    // Диалог не упал: текст до и после unknown-блока на месте.
    const texts = dialogue.messages.flatMap((m) =>
      m.chunks.filter((c) => c.kind === "text").map((c) => c.content),
    );
    expect(texts).toContain("Промежуточный видимый текст.");
  });

  test("пустое user message сохраняется и не роняет разбор", async () => {
    const { dialogue } = await parseSession(UNKNOWN);
    const user = dialogue.messages.find((m) => m.role === "user")!;
    expect(user.humanAuthored).toBe(true);
    expect(user.chunks[0]!.kind).toBe("text");
    expect(user.chunks[0]!.content).toBe("");
  });

  test("обрезанный хвост audit.jsonl → diagnostic, диалог цел", async () => {
    const { dialogue, diagnostics } = await parseSession(UNKNOWN);
    expect(diagnostics.some((d) => d.code === "jsonl_parse_error")).toBe(true);
    expect(dialogue.externalId).toBe("local_33333333-3333-4333-8333-333333333333");
    expect(dialogue.title).toBe("Граничные случаи");
  });

  test("без result-события turnResult marker отсутствует", async () => {
    const { dialogue } = await parseSession(UNKNOWN);
    for (const message of dialogue.messages) {
      expect(message.metadata.turnResult).toBeUndefined();
    }
  });
});

describe("claude-desktop parser: не-транскриптные файлы", () => {
  test("standalone local_*.json → diagnostic, без диалога", async () => {
    const snapshot = await claudeDesktopParser.parse(METADATA_ONLY);
    const dialogues = await collectDialogues(snapshot);
    expect(dialogues).toHaveLength(0);
    expect(snapshot.diagnostics.map((d) => d.code)).toContain("session_metadata_only");
  });

  test("LevelDB-файл IndexedDB → diagnostic unsupported_file, без диалога", async () => {
    const snapshot = await claudeDesktopParser.parse(LEVELDB);
    const dialogues = await collectDialogues(snapshot);
    expect(dialogues).toHaveLength(0);
    expect(snapshot.diagnostics.map((d) => d.code)).toContain("unsupported_file");
  });
});
