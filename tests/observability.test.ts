import { describe, expect, test } from "bun:test";
import {
  createRunId,
  createStructuredEvent,
  createStructuredLogger,
  formatStructuredEvent,
  sanitizeLogFields,
} from "../src/observability.ts";

describe("observability run IDs (§22)", () => {
  test("создаёт operation-scoped ID через injectable UUID seam", () => {
    expect(createRunId("restore_test", () => "00000000-0000-4000-8000-000000000001"))
      .toBe("restore_test:00000000-0000-4000-8000-000000000001");
    expect(() => createRunId("Restore Test", () => "id")).toThrow(/snake_case/);
  });

  test("durable sync_run ID можно использовать напрямую для correlation", () => {
    const event = createStructuredEvent({
      event: "source_revision_parsed",
      runId: "sync_run:sync_123",
      timestamp: new Date("2026-07-26T00:00:00Z"),
      fields: { syncRunId: "sync_run:sync_123", sourceRevisionId: "source_revision:rev_1" },
    });
    expect(event.runId).toBe("sync_run:sync_123");
    expect(event.syncRunId).toBe("sync_run:sync_123");
  });
});

describe("privacy-safe structured fields (§22)", () => {
  test("omits corpus content/credentials recursively but retains counts and IDs", () => {
    const safe = sanitizeLogFields({
      syncRunId: "sync_run:one",
      prompt: "private prompt",
      assistantResponse: "private answer",
      toolResult: { content: "private tool output" },
      rawPayload: { private: true },
      openaiApiKey: "sk-this-must-never-appear",
      dbPassword: "secret",
      promptTokens: 42,
      counters: {
        messages: 2,
        content: "nested private content",
      },
    });
    expect(safe).toEqual({
      syncRunId: "sync_run:one",
      promptTokens: 42,
      counters: { messages: 2 },
    });
  });

  test("rejects generic/error text and long strings entirely", () => {
    const safe = sanitizeLogFields({
      error: "provider rejected Bearer abcdef and sk-1234567890abcdef",
      detail: "x".repeat(1100),
      status: "private conversation sentence",
      errorCode: "provider_rate_limited",
    });
    const json = JSON.stringify(safe);
    expect(json).not.toContain("abcdef");
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("x".repeat(100));
    expect(safe).toEqual({ errorCode: "provider_rate_limited" });
  });

  test("unknown recursive objects, errors, cycles and binary values are rejected", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const safe = sanitizeLogFields({
      cycle,
      bytes: new Uint8Array([1, 2, 3]),
      nested: { error: new Error("private raw text"), content: "secret", arbitrary: "secret" },
    });
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(safe).toEqual({});
  });
});

describe("structured JSONL logger", () => {
  test("формирует одну JSON строку с runId, time, level, event и metadata", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      runId: "sync_run:one",
      baseFields: { harness: "codex" },
      sink: (line) => lines.push(line),
      now: () => new Date("2026-07-26T10:11:12Z"),
    });
    const event = logger.info("source_revision_parsed", {
      sourceRevisionId: "source_revision:one",
      dialogues: 1,
      messages: 42,
      chunks: 137,
      durationMs: 218,
      event: "cannot_override",
      password: "cannot_log",
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "info",
      event: "source_revision_parsed",
      timestamp: "2026-07-26T10:11:12.000Z",
      runId: "sync_run:one",
      harness: "codex",
      sourceRevisionId: "source_revision:one",
      dialogues: 1,
      messages: 42,
      chunks: 137,
      durationMs: 218,
    });
    expect(formatStructuredEvent(event)).toBe(lines[0]);
  });

  test("rejects ambiguous event names and credential-shaped run IDs", () => {
    expect(() => createStructuredEvent({ event: "not valid", runId: "run:one" }))
      .toThrow(/snake_case/);
    expect(() => createStructuredLogger({ runId: "sk-1234567890abcdef" }))
      .toThrow(/credential/);
  });
});
