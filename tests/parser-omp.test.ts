import { describe, expect, test } from "bun:test";
import { normalizeUsageEvents } from "../src/parsers/shared/usage-normalization.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import {
  OMP_PARSER_VERSION,
  ompParser,
} from "../src/parsers/omp/index.ts";
import type { ParsedDialogue } from "../src/domain/canonical-types.ts";

const FIXTURES = "tests/fixtures/omp";

async function parseFixture(
  name: string,
): Promise<{ dialogue: ParsedDialogue; diagnostics: { code: string }[] }> {
  const snapshot = await ompParser.parse(`${FIXTURES}/${name}`);
  const dialogues = await collectDialogues(snapshot);
  expect(dialogues).toHaveLength(1);
  return { dialogue: dialogues[0]!, diagnostics: snapshot.diagnostics };
}

describe("omp parser: basic-dialogue", () => {
  test("метаданные диалога и parser version", async () => {
    expect(ompParser.parserName).toBe("omp");
    expect(OMP_PARSER_VERSION).toBe(2);
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    expect(dialogue.externalId).toBe("019fb900-1111-7000-8111-111111111111");
    expect(dialogue.title).toBe("Explain cache invalidation");
    expect(dialogue.workspace?.path).toBe("/Users/example/projects/demo-app");
    expect(dialogue.workspace?.name).toBe("demo-app");
    expect(dialogue.startedAt?.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(dialogue.updatedAt?.toISOString()).toBe("2026-07-31T12:00:15.000Z");
    expect(dialogue.metadata.sessionVersion).toBe(3);
  });

  test("user/assistant/tool roles and chunks", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    expect(dialogue.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const user = dialogue.messages[0]!;
    expect(user.humanAuthored).toBe(true);
    expect(user.visibleToUser).toBe(true);
    expect(user.chunks[0]!.content).toContain("cache invalidation");

    const assistant = dialogue.messages[1]!;
    expect(assistant.chunks.map((c) => c.kind)).toEqual([
      "thought",
      "text",
      "tool_call",
    ]);
    expect(assistant.chunks[2]!.toolCallId).toBe("call_read");
    expect(assistant.chunks[2]!.toolName).toBe("bash");

    const tool = dialogue.messages[2]!;
    expect(tool.visibleToUser).toBe(false);
    expect(tool.chunks[0]!.kind).toBe("tool_result");
    expect(tool.chunks[0]!.toolCallId).toBe("call_read");
  });

  test("model/provider, timing metadata and usage normalization", async () => {
    const { dialogue } = await parseFixture("basic-dialogue.jsonl");
    const assistant = dialogue.messages[1]!;
    expect(assistant.model?.rawModelName).toBe("alibaba-token-plan/qwen3.8-max-preview");
    expect(assistant.model?.canonicalName).toBe("qwen3.8-max-preview");
    expect(assistant.model?.vendor).toBe("alibaba");
    expect(assistant.model?.serviceProvider).toBe("alibaba-token-plan");
    expect(assistant.model?.reasoningEffort).toBe("high");
    expect(assistant.metadata.durationMs).toBe(1500.5);
    expect(assistant.metadata.ttftMs).toBe(220.25);
    expect(assistant.metadata.cost).toMatchObject({ total: 0.0034 });

    const usage = normalizeUsageEvents(assistant.usageEvents)!;
    expect(usage.scope).toBe("request");
    expect(usage.inputTokens).toBe(4050);
    expect(usage.cachedInputTokens).toBe(3000);
    expect(usage.cacheWriteInputTokens).toBe(50);
    expect(usage.outputTokens).toBe(120);
    expect(usage.reasoningOutputTokens).toBe(40);
    expect(usage.totalTokensReported).toBe(4170);
    expect(usage.totalTokensNormalized).toBe(4170);
  });
});

describe("omp parser: unknown-truncated", () => {
  test("unknown parts/events and truncated line do not drop the dialogue", async () => {
    const { dialogue, diagnostics } = await parseFixture("unknown-truncated.jsonl");
    expect(dialogue.externalId).toBe("019fb900-2222-7000-8222-222222222222");
    expect(dialogue.messages.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.code === "jsonl_parse_error")).toBe(true);
    expect(diagnostics.filter((d) => d.code === "unknown_event").length).toBeGreaterThanOrEqual(2);
    const unknown = dialogue.messages.flatMap((m) => m.chunks).filter((c) => c.kind === "unknown");
    expect(unknown.map((c) => c.rawEventType)).toContain("top:quantum_checkpoint");
    expect(unknown.some((c) => c.rawEventType?.startsWith("message.content.unknown_part"))).toBe(true);
  });
});
