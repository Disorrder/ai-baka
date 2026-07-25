import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ParsedDialogue } from "../src/domain/canonical-types.ts";
import { OPENCODE_PARSER_VERSION, openCodeParser } from "../src/parsers/opencode/index.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";

const FIXTURES = "tests/fixtures/opencode";
const TMP = mkdtempSync(join(tmpdir(), "baka-opencode-fixtures-"));

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Собрать временную SQLite-базу из .sql fixture и распарсить её. */
let dbCounter = 0;

async function parseFixture(
  name: string,
): Promise<{ dialogues: ParsedDialogue[]; diagnostics: { code: string }[] }> {
  const dbPath = join(TMP, `${name}-${dbCounter++}.db`);
  const db = new Database(dbPath);
  try {
    db.exec(readFileSync(join(FIXTURES, `${name}.sql`), "utf8"));
  } finally {
    db.close();
  }
  const snapshot = await openCodeParser.parse(dbPath);
  const dialogues = await collectDialogues(snapshot);
  return { dialogues, diagnostics: snapshot.diagnostics };
}

describe("opencode parser: basic", () => {
  test("метаданные диалога и parser version", async () => {
    expect(openCodeParser.parserName).toBe("opencode");
    expect(OPENCODE_PARSER_VERSION).toBe(1);
    const { dialogues, diagnostics } = await parseFixture("basic");
    expect(diagnostics).toHaveLength(0);
    expect(dialogues).toHaveLength(1);
    const dialogue = dialogues[0]!;
    expect(dialogue.externalId).toBe("ses_demo001");
    expect(dialogue.title).toBe("Demo: cache explanation");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/demo-app");
    expect(dialogue.workspace?.name).toBe("demo-app");
    expect(dialogue.workspace?.metadata?.projectId).toBe("proj_demo");
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-23T09:46:40.000Z");
    expect(dialogue.updatedAt?.toISOString()).toBe("2026-07-23T09:47:40.000Z");
    expect(dialogue.metadata.opencodeVersion).toBe("1.18.4");
    expect(dialogue.metadata.agent).toBe("build");
  });

  test("user message: human-authored, текст промпта", async () => {
    const { dialogues } = await parseFixture("basic");
    const user = dialogues[0]!.messages.find((m) => m.role === "user")!;
    expect(user.externalId).toBe("msg_u001");
    expect(user.humanAuthored).toBe(true);
    expect(user.visibleToUser).toBe(true);
    expect(user.model).toBeUndefined(); // у user модель — только metadata
    expect(user.chunks).toHaveLength(1);
    expect(user.chunks[0]!.kind).toBe("text");
    expect(user.chunks[0]!.content).toBe("Explain how the cache works in src/cache.ts");
    expect(user.chunks[0]!.sourceLocator).toBe("session/ses_demo001/message/msg_u001/part/prt_u001a");
  });

  test("assistant: reasoning → thought, text → text, модель нормализована", async () => {
    const { dialogues } = await parseFixture("basic");
    const assistant = dialogues[0]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.humanAuthored).toBe(false);
    expect(assistant.chunks.map((c) => c.kind)).toEqual(["thought", "text"]);
    expect(assistant.chunks.map((c) => c.sequence)).toEqual([0, 1]);
    expect(assistant.chunks[0]!.rawKind).toBe("reasoning");
    expect(assistant.chunks[1]!.content).toContain("LRU");
    expect(assistant.model?.rawModelName).toBe("qwen3.8-max-preview");
    expect(assistant.model?.canonicalName).toBe("qwen3.8-max-preview");
    expect(assistant.model?.vendor).toBe("alibaba");
    expect(assistant.model?.serviceProvider).toBe("aliyun-token-plan");
    expect(assistant.metadata.finish).toBe("stop");
    expect(assistant.metadata.parentId).toBe("msg_u001");
  });

  test("usage: request + session_cumulative, cached внутри input (сценарии 18–19)", async () => {
    const { dialogues } = await parseFixture("basic");
    const assistant = dialogues[0]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.usageEvents.map((e) => e.scope).sort()).toEqual([
      "request",
      "session_cumulative",
    ]);
    const request = assistant.usageEvents.find((e) => e.scope === "request")!;
    // input 2000 + cache.read 3000 + cache.write 500 (opencode input без cached).
    expect(request.inputTokens).toBe(5500);
    expect(request.cachedInputTokens).toBe(3000);
    expect(request.outputTokens).toBe(150);
    expect(request.reasoningOutputTokens).toBe(40);
    expect(request.totalTokensReported).toBe(5690);

    // Сценарий 18: cumulative не суммируется с request — scope остаётся request.
    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    expect(usage.scope).toBe("request");
    expect(usage.inputTokens).toBe(5500);
    // Сценарий 19: cached/reasoning не double-counted.
    expect(usage.cachedInputTokens).toBe(3000);
    expect(usage.reasoningOutputTokens).toBe(40);
    expect(usage.totalTokensNormalized).toBe(5650);
  });
});

describe("opencode parser: tools", () => {
  test("сценарий 17: tool call ↔ tool result по toolCallId, error → tool_result", async () => {
    const { dialogues, diagnostics } = await parseFixture("tools");
    expect(diagnostics).toHaveLength(0);
    const first = dialogues[0]!.messages.find((m) => m.externalId === "msg_a101")!;
    const kinds = first.chunks.map((c) => c.kind);
    expect(kinds).toEqual(["text", "tool_call", "tool_result", "tool_call", "tool_result", "object"]);

    const call1 = first.chunks.find((c) => c.kind === "tool_call" && c.toolName === "read")!;
    const result1 = first.chunks.find((c) => c.kind === "tool_result" && c.toolName === "read")!;
    expect(call1.toolCallId).toBe("call_001");
    expect(result1.toolCallId).toBe("call_001");
    expect(JSON.parse(call1.content!)).toEqual({ filePath: "src/parser.ts" });
    expect(result1.content).toBe("export function parse() {}");

    // status error → output отсутствует, content берётся из state.error.
    const result2 = first.chunks.find((c) => c.kind === "tool_result" && c.toolName === "bash")!;
    expect(result2.toolCallId).toBe("call_002");
    expect(result2.metadata.status).toBe("error");
    expect(result2.content).toBe("2 tests failed");

    const patch = first.chunks.find((c) => c.kind === "object")!;
    expect(patch.rawKind).toBe("patch");
  });

  test("step-start/step-finish — операционные, не чанки и не usage events", async () => {
    const { dialogues } = await parseFixture("tools");
    const dialogue = dialogues[0]!;
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["part.step-start"]).toBe(2);
    expect(counts["part.step-finish"]).toBe(2);
    // step-finish.tokens не дублируется в usage events: только message.tokens.
    const first = dialogue.messages.find((m) => m.externalId === "msg_a101")!;
    expect(first.usageEvents.filter((e) => e.scope === "request")).toHaveLength(1);
  });

  test("model switch между assistant messages, subtask и file parts", async () => {
    const { dialogues } = await parseFixture("tools");
    const dialogue = dialogues[0]!;
    const a1 = dialogue.messages.find((m) => m.externalId === "msg_a101")!;
    const a2 = dialogue.messages.find((m) => m.externalId === "msg_a102")!;
    expect(a1.model?.canonicalName).toBe("gpt-5.6-sol");
    expect(a1.model?.vendor).toBe("openai");
    expect(a2.model?.canonicalName).toBe("kimi-k2");
    expect(a2.model?.vendor).toBe("moonshot");
    expect(a2.model?.serviceProvider).toBe("openrouter");

    const subtask = a2.chunks.find((c) => c.rawKind === "subtask")!;
    expect(subtask.kind).toBe("object");
    expect(subtask.content).toContain("Review the diff");
    expect(subtask.metadata.agent).toBe("reviewer");

    const file = a2.chunks.find((c) => c.rawKind === "file")!;
    expect(file.kind).toBe("attachment");
    expect(file.content).toBe("@notes.txt");
    expect(file.metadata.mime).toBe("text/plain");
  });
});

describe("opencode parser: unknown-truncated", () => {
  test("сценарий 11: неизвестный part → unknown chunk + diagnostic, диалог не роняется", async () => {
    const { dialogues, diagnostics } = await parseFixture("unknown-truncated");
    expect(dialogues).toHaveLength(2);
    const dialogue = dialogues.find((d) => d.externalId === "ses_demo003")!;
    const assistant = dialogue.messages.find((m) => m.externalId === "msg_a201")!;
    const unknowns = assistant.chunks.filter((c) => c.kind === "unknown" && c.rawKind === "widget");
    expect(unknowns).toHaveLength(2);
    expect(unknowns[0]!.content).toContain('"foo":1');
    // Диагностика — один раз на тип, оба чанка сохранены.
    expect(diagnostics.filter((d) => d.code === "unknown_part_type")).toHaveLength(1);
    // Текст вокруг неизвестных событий выжил.
    expect(assistant.chunks.some((c) => c.kind === "text" && c.content === "Partial answer survives.")).toBe(true);
    const counts = dialogue.metadata.eventCounts as Record<string, number>;
    expect(counts["part.unknown.widget"]).toBe(2);
  });

  test("corrupted message/part data → diagnostics + unknown chunks", async () => {
    const { dialogues, diagnostics } = await parseFixture("unknown-truncated");
    const dialogue = dialogues.find((d) => d.externalId === "ses_demo003")!;
    expect(diagnostics.some((d) => d.code === "message_data_parse_error")).toBe(true);
    expect(diagnostics.some((d) => d.code === "part_data_parse_error")).toBe(true);

    const broken = dialogue.messages.find((m) => m.externalId === "msg_u201")!;
    expect(broken.role).toBe("unknown");
    expect(broken.chunks).toHaveLength(1);
    expect(broken.chunks[0]!.kind).toBe("unknown");
    expect(broken.timestamp?.toISOString()).toBe("2026-07-23T10:20:01.000Z");

    const assistant = dialogue.messages.find((m) => m.externalId === "msg_a201")!;
    const corruptedPart = assistant.chunks.find((c) => c.rawEventType === "part_data_parse_error")!;
    expect(corruptedPart.kind).toBe("unknown");
    expect(corruptedPart.content).toBe('["broken part"');
  });

  test("пустое сообщение (без parts) и пустая сессия выживают", async () => {
    const { dialogues } = await parseFixture("unknown-truncated");
    const dialogue = dialogues.find((d) => d.externalId === "ses_demo003")!;
    const empty = dialogue.messages.find((m) => m.externalId === "msg_a202")!;
    expect(empty.chunks).toHaveLength(0);
    expect(empty.metadata.error).toBeDefined();
    // Нулевые session tokens → нет session_cumulative события.
    expect(empty.usageEvents.every((e) => e.scope !== "session_cumulative")).toBe(true);

    const emptySession = dialogues.find((d) => d.externalId === "ses_demo004")!;
    expect(emptySession.messages).toHaveLength(0);
    // Сессия без project_id: workspace из session.directory.
    expect(dialogue.workspace?.path).toBe("/Users/example");
  });
});

describe("opencode parser: long-final", () => {
  test("user message с format (SDK) → humanAuthored unknown", async () => {
    const { dialogues, diagnostics } = await parseFixture("long-final");
    expect(diagnostics).toHaveLength(0);
    const user = dialogues[0]!.messages.find((m) => m.role === "user")!;
    expect(user.humanAuthored).toBe("unknown");
    expect(user.metadata.format).toBeDefined();
  });

  test("текст до и после tool activity в разных assistant messages", async () => {
    const { dialogues } = await parseFixture("long-final");
    const messages = dialogues[0]!.messages;
    const a1 = messages.find((m) => m.externalId === "msg_a301")!;
    const a2 = messages.find((m) => m.externalId === "msg_a302")!;
    expect(a1.metadata.finish).toBe("tool-calls");
    expect(a1.chunks.map((c) => c.kind)).toEqual(["text", "tool_call", "tool_result"]);
    expect(a2.metadata.finish).toBe("stop");
    expect(a2.chunks.map((c) => c.kind)).toEqual(["text", "text"]);
  });
});

describe("opencode parser: не-sqlite вход", () => {
  test("отсутствующий файл → sqlite_open_error, без диалогов", async () => {
    const snapshot = await openCodeParser.parse(join(TMP, "no-such.db"));
    const dialogues = await collectDialogues(snapshot);
    expect(dialogues).toHaveLength(0);
    expect(snapshot.diagnostics.some((d) => d.code === "sqlite_open_error")).toBe(true);
  });

  test("база без таблицы session → missing_table", async () => {
    const dbPath = join(TMP, "not-opencode.db");
    const db = new Database(dbPath);
    db.exec("create table something (id text)");
    db.close();
    const snapshot = await openCodeParser.parse(dbPath);
    const dialogues = await collectDialogues(snapshot);
    expect(dialogues).toHaveLength(0);
    expect(snapshot.diagnostics.some((d) => d.code === "missing_table")).toBe(true);
  });

  test("JSON-файл (session_diff) → unsupported_file, без SQLiteError", async () => {
    const jsonPath = join(TMP, "ses_test.json");
    writeFileSync(jsonPath, '{"diff": []}');
    const snapshot = await openCodeParser.parse(jsonPath);
    const dialogues = await collectDialogues(snapshot);
    expect(dialogues).toHaveLength(0);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]!.code).toBe("unsupported_file");
  });
});
