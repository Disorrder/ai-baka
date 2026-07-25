import { describe, expect, test } from "bun:test";
import {
  dialogueIdentityKey,
  fallbackDialogueSourceId,
} from "../src/domain/identity.ts";

describe("dialogueIdentityKey", () => {
  test("<harness-installation-uuid>:<external-id>", () => {
    expect(dialogueIdentityKey("inst-uuid-1", "session-42", "fallback")).toBe(
      "inst-uuid-1:session-42",
    );
  });

  test("fallback при отсутствии external id", () => {
    expect(dialogueIdentityKey("inst-uuid-1", undefined, "codex:sessions/a.jsonl")).toBe(
      "inst-uuid-1:codex:sessions/a.jsonl",
    );
    expect(dialogueIdentityKey("inst-uuid-1", "", "codex:sessions/a.jsonl")).toBe(
      "inst-uuid-1:codex:sessions/a.jsonl",
    );
  });

  test("сценарий 16: один external id на разных installation не мержится", () => {
    const a = dialogueIdentityKey("host-a-install", "session-42", "x");
    const b = dialogueIdentityKey("host-b-install", "session-42", "x");
    expect(a).not.toBe(b);
  });

  test("fallbackDialogueSourceId детерминирован", () => {
    expect(fallbackDialogueSourceId("codex", "2026/07/rollout-1.jsonl")).toBe(
      "codex:2026/07/rollout-1.jsonl",
    );
  });
});
