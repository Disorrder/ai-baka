import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  kimiLegacyReplaySemanticPath,
  materializeKimiLegacyRecoveryView,
} from "../src/migration/store.ts";
import { kimiCodeParser } from "../src/parsers/kimi-code/index.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { snapshotRegularFile } from "../src/sources/snapshot/raw-snapshot.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const WIRE = [
  { type: "metadata", protocol_version: "1.4", created_at: 1_783_800_000_000 },
  {
    type: "turn.prompt",
    input: [{ type: "text", text: "Synthetic migration prompt" }],
    origin: { kind: "user" },
    time: 1_783_800_001_000,
  },
  {
    type: "context.append_loop_event",
    event: { type: "step.begin", uuid: "step-safe", turnId: "turn-safe", step: 1 },
    time: 1_783_800_001_001,
  },
  {
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      uuid: "part-safe",
      turnId: "turn-safe",
      step: 1,
      stepUuid: "step-safe",
      part: { type: "text", text: "Synthetic migration answer" },
    },
    time: 1_783_800_001_100,
  },
  {
    type: "context.append_loop_event",
    event: {
      type: "step.end",
      uuid: "end-safe",
      turnId: "turn-safe",
      step: 1,
      usage: { inputOther: 2, inputCacheRead: 0, inputCacheCreation: 0, output: 3 },
      finishReason: "stop",
      messageId: "message-safe",
    },
    time: 1_783_800_001_200,
  },
].map((event) => JSON.stringify(event)).join("\n") + "\n";

async function rawFixture(): Promise<{ archiveRoot: string; rawPath: string }> {
  const archiveRoot = await mkdtemp(path.join(tmpdir(), "baka-kimi-recovery-test-"));
  temporaryRoots.push(archiveRoot);
  const legacySourceDir = path.join(archiveRoot, "legacy-source");
  await mkdir(legacySourceDir, { recursive: true });
  const legacySourcePath = path.join(legacySourceDir, "wire.jsonl");
  await writeFile(legacySourcePath, WIRE);
  const snapshot = await snapshotRegularFile(legacySourcePath, {
    archiveRoot,
    harness: "kimi-code",
    runId: "migration-kimi-recovery-test",
  });
  return { archiveRoot, rawPath: snapshot.rawArchivePath };
}

describe("legacy Kimi raw recovery view", () => {
  test("restores session/wire layout without changing content-addressed raw", async () => {
    const { archiveRoot, rawPath } = await rawFixture();
    const rawBefore = await readFile(rawPath);

    const view = await materializeKimiLegacyRecoveryView({
      archiveRoot,
      immutableRawPath: rawPath,
      semanticPaths: [
        "workdir-safe/session-safe/agents/main/wire.jsonl",
        String.raw`C:\Users\safe\.kimi-code\sessions\session-safe\agents\main\wire.jsonl`,
      ],
    });

    expect(view).toBeDefined();
    expect(path.basename(rawPath)).toMatch(/^wire__[0-9a-f]{64}\.jsonl$/);
    expect(view!.materializedPath).toBe(
      path.join(view!.viewRoot, "session-safe", "agents", "main", "wire.jsonl"),
    );
    expect(view!.parsePath).toBe(path.join(view!.viewRoot, "session-safe"));

    const snapshot = await kimiCodeParser.parse(view!.parsePath);
    const dialogues = await collectDialogues(snapshot);
    expect(snapshot.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]!.externalId).toBe("session-safe");
    expect(dialogues[0]!.messages.flatMap((message) => message.chunks).map((chunk) => chunk.content))
      .toContain("Synthetic migration answer");

    await rm(view!.viewRoot, { recursive: true, force: true });
    expect(await readFile(rawPath)).toEqual(rawBefore);
  });

  test("fails closed for unsupported semantics and raw outside the Kimi archive", async () => {
    const { archiveRoot, rawPath } = await rawFixture();

    for (const semanticPaths of [
      ["session-safe/state.json"],
      ["../session-safe/agents/main/wire.jsonl"],
      ["session-safe/agents/main/wire__deadbeef.jsonl"],
    ]) {
      expect(await materializeKimiLegacyRecoveryView({
        archiveRoot,
        immutableRawPath: rawPath,
        semanticPaths,
      })).toBeUndefined();
    }

    const outsideRaw = path.join(archiveRoot, "outside.jsonl");
    await writeFile(outsideRaw, WIRE);
    expect(materializeKimiLegacyRecoveryView({
      archiveRoot,
      immutableRawPath: outsideRaw,
      semanticPaths: ["session-safe/agents/main/wire.jsonl"],
    })).rejects.toThrow("escapes archive raw/kimi-code");
    expect(await readFile(rawPath, "utf8")).toBe(WIRE);
  });

  test("builds safe replay semantics and rejects path-bearing external IDs", () => {
    expect(kimiLegacyReplaySemanticPath("session-safe"))
      .toBe("session-safe/agents/main/wire.jsonl");
    expect(kimiLegacyReplaySemanticPath("../escape")).toBeUndefined();
    expect(kimiLegacyReplaySemanticPath("nested/session")).toBeUndefined();
    expect(kimiLegacyReplaySemanticPath("unsafe\\session")).toBeUndefined();
    expect(kimiLegacyReplaySemanticPath("\0session")).toBeUndefined();
  });
});
