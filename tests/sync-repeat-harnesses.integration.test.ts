import { afterAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.ts";
import { HARNESS_ORDER, type HarnessSlug } from "../src/sources/adapters/harnesses.ts";
import { snapshotSource } from "../src/sources/snapshot/raw-snapshot.ts";
import { runSync } from "../src/sync/sync-run.ts";
import { makeCursorDb } from "./fixtures/cursor/make-db.ts";
import { basicDialogue } from "./fixtures/cursor/specs.ts";
import {
  createTestDb, dbTest, dropTestDb, finishLiveTestFile,
  SURREAL_PASS, SURREAL_URL, SURREAL_USER, TEST_NAMESPACE,
} from "./db-test-utils.ts";

const liveTest = await dbTest();
afterAll(finishLiveTestFile);
const fixtures = path.join(import.meta.dir, "fixtures");

async function sourceFor(harness: HarnessSlug, root: string): Promise<{ mutate: () => Promise<void> }> {
  if (harness === "cursor" || harness === "opencode") {
    const file = path.join(root, harness === "cursor" ? "state.vscdb" : "opencode.db");
    if (harness === "cursor") {
      const fixture = await makeCursorDb(basicDialogue);
      try { await cp(fixture.path, file); } finally { await fixture.cleanup(); }
    } else {
      const db = new Database(file);
      try { db.exec(await readFile(path.join(fixtures, "opencode/basic.sql"), "utf8")); }
      finally { db.close(); }
    }
    return { mutate: async () => {
      const db = new Database(file);
      try {
        if (harness === "cursor") {
          db.exec("UPDATE cursorDiskKV SET value = replace(CAST(value AS TEXT), 'Объясни', 'Поясни') WHERE key LIKE 'bubbleId:%'");
        } else {
          db.exec("UPDATE part SET data = replace(data, 'Explain', 'Describe')");
        }
      } finally { db.close(); }
    } };
  }
  let file: string;
  if (harness === "kimi-code") {
    await cp(path.join(fixtures, "kimi-code/basic"), root, { recursive: true });
    file = path.join(root, "session_11111111-aaaa-4bbb-8ccc-111111111111/agents/main/wire.jsonl");
  } else if (harness === "claude-desktop") {
    await cp(path.join(fixtures, "claude-desktop/basic"), root, { recursive: true });
    file = path.join(root, "local_11111111-1111-4111-8111-111111111111/audit.jsonl");
  } else {
    file = path.join(root, "session.jsonl");
    await cp(path.join(fixtures, harness, "basic-dialogue.jsonl"), file);
  }
  return { mutate: async () => {
    const content = await readFile(file, "utf8");
    expect(content).toContain("Объясни");
    await writeFile(file, content.replaceAll("Объясни", "Поясни"));
  } };
}

describe("incremental capture across every registered harness", () => {
  for (const harness of HARNESS_ORDER) {
    liveTest(`${harness}: unchanged skips capture and ingestion; changed content is ingested`, async () => {
      const t = await createTestDb();
      const base = await mkdtemp(path.join(tmpdir(), "baka-repeat-matrix-"));
      try {
        const archiveRoot = path.join(base, "archive");
        const sourceRoot = path.join(base, "sources");
        await mkdir(archiveRoot);
        await mkdir(sourceRoot);
        const source = await sourceFor(harness, sourceRoot);
        const cfg: AppConfig = {
          archiveRoot, dbRoot: path.join(base, "db"),
          surrealUrl: SURREAL_URL, surrealUser: SURREAL_USER, surrealPass: SURREAL_PASS,
          surrealNamespace: TEST_NAMESPACE, surrealDatabase: t.name,
          minFreeBytes: 0, deletionConfirmations: 2,
          sourceOverrides: { [harness]: [sourceRoot] },
          embeddings: { excludeHarnesses: [], excludeWorkspaces: [], excludeDocumentTypes: [] },
        };
        const snapshots: string[] = [];
        const options = {
          harness, preflight: false, hostIdPath: path.join(base, "host-id"),
          logger: () => {},
          snapshotSource: async (file: string, opts: Parameters<typeof snapshotSource>[1]) => {
            snapshots.push(file);
            return snapshotSource(file, opts);
          },
        };
        const first = await runSync(cfg, options);
        expect(first.status).toBe("completed");
        expect(first.counters.messagesWritten).toBeGreaterThan(0);
        snapshots.length = 0;
        const repeat = await runSync(cfg, options);
        expect(repeat.status).toBe("completed");
        expect(snapshots).toEqual([]);
        expect(repeat.counters.dialoguesWritten).toBe(0);
        expect(repeat.counters.messagesWritten).toBe(0);
        await source.mutate();
        const changed = await runSync(cfg, options);
        expect(changed.status).toBe("completed");
        expect(snapshots).toHaveLength(1);
        expect(changed.counters.revisionsCreated).toBe(1);
        expect(changed.counters.messagesWritten).toBeGreaterThan(0);
        snapshots.length = 0;
        const afterChange = await runSync(cfg, options);
        expect(afterChange.status).toBe("completed");
        expect(snapshots).toEqual([]);
        expect(afterChange.counters.dialoguesWritten).toBe(0);
      } finally {
        await dropTestDb(t);
        await rm(base, { recursive: true, force: true });
      }
    });
  }
});
