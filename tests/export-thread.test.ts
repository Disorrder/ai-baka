import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import {
  buildThreadExport,
  exportThread,
  serializeThreadExport,
  ThreadExportNotFoundError,
} from "../src/export-thread.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
} from "../src/db/repositories/identity.ts";
import {
  createSyncRun,
  ensureSourceLocation,
  ensureSourceRevision,
  ensureSourceRoot,
  updateSourceRevisionParse,
} from "../src/db/repositories/provenance.ts";
import { writeDialogueRevision } from "../src/db/repositories/corpus.ts";
import { codexExtractors } from "../src/search/extractors/codex.ts";
import { HARNESSES } from "../src/sources/adapters/harnesses.ts";
import {
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  isDbAvailable,
} from "./db-test-utils.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function rid(table: string, id: string): RecordId {
  return new RecordId(table, id);
}

function exportDb(): Surreal {
  const revision = rid("dialogue_revision", "rev_1");
  const message = rid("message", "msg_1");
  const source = rid("source_revision", "src_1");
  const rows = {
    dialogue: [{
      id: rid("dialogue", "dlg_1"),
      identity_key: "harness_installation:hi_1:external-1",
      harness_installation: rid("harness_installation", "hi_1"),
      harness_slug: "codex",
      host: rid("host", "host_1"),
      workspace: rid("workspace", "workspace_1"),
      external_id: "external-1",
      title: "Exported dialogue",
      current_revision: revision,
      started_at: new Date("2026-01-01T00:00:00Z"),
      first_seen_at: new Date("2026-01-01T00:00:00Z"),
      last_seen_at: new Date("2026-01-02T00:00:00Z"),
    }],
    revisions: [{
      id: revision,
      source_revision: source,
      source_dialogue_id: "external-1",
      parser_name: "codex",
      parser_version: "2",
      canonical_hash: "c".repeat(64),
      status: "ready",
      message_count: 1,
      chunk_count: 1,
      created_at: new Date("2026-01-01T00:01:00Z"),
    }],
    messages: [{
      id: message,
      dialogue_revision: revision,
      sequence: 0,
      role: "user",
      human_authored: true,
      visible_to_user: true,
      usage: { z: 2, a: 1 },
      raw_usage_events: [{ source: "canonical-stored-event", inputTokens: 7 }],
      metadata: { nested: { z: true, a: false } },
    }],
    chunks: [{
      id: rid("chunk", "chunk_1"),
      dialogue_revision: revision,
      message,
      sequence: 0,
      kind: "text",
      role: "user",
      content: "canonical content",
      content_sha256: "d".repeat(64),
      content_bytes: 17,
    }],
    sources: [{
      id: source,
      sha256: "e".repeat(64),
      size_bytes: 123,
      mtime_ms: 456,
      snapshot_kind: "regular_copy",
      captured_at: new Date("2026-01-01T00:00:30Z"),
      parser_name: "codex",
      parser_version: "2",
      parse_status: "parsed",
      canonical_hash: "f".repeat(64),
      dialogues_discovered: 1,
      source_location: rid("source_location", "loc_1"),
      source_root: rid("source_root", "root_1"),
      harness_slug: "codex",
      source_kind: "file_tree",
      relative_path: "private-workspace/session.jsonl",
      // These emulate sensitive columns present on a SELECT * row. The
      // exporter must never request or serialize them.
      original_path: "/Users/private/.codex/session.jsonl",
      raw_archive_path: "raw/secret.jsonl",
      raw_payload: { secret: "must-not-leak" },
    }],
  };

  return {
    query: async (sql: string) => {
      // Query-level whitelist: future refactors cannot silently broaden it.
      expect(sql).not.toContain("original_path");
      expect(sql).not.toContain("raw_archive_path");
      expect(sql).not.toContain("raw_payload");
      if (sql.includes("FROM ONLY $dialogue")) return [rows.dialogue];
      if (sql.includes("FROM dialogue_revision")) return [rows.revisions];
      if (sql.includes("FROM message")) return [rows.messages];
      if (sql.includes("FROM chunk")) return [rows.chunks];
      if (sql.includes("FROM source_revision")) return [rows.sources];
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Surreal;
}

describe("thread export", () => {
  test("deterministic nested JSON includes provenance and canonical content", async () => {
    const db = exportDb();
    const first = await buildThreadExport(db, "dialogue:dlg_1");
    const second = await buildThreadExport(db, "dlg_1");
    expect(serializeThreadExport(first)).toBe(serializeThreadExport(second));
    expect(first.dialogue.harness).toBe("codex");
    expect(first.revisions).toHaveLength(1);
    expect(first.revisions[0]!.current).toBe(true);
    expect(first.revisions[0]!.source?.sha256).toBe("e".repeat(64));
    expect(first.revisions[0]!.source?.relativePath).toBeUndefined();
    expect(first.revisions[0]!.messages[0]!.chunks[0]!.content).toBe("canonical content");
    const json = serializeThreadExport(first);
    expect(json.endsWith("\n")).toBe(true);
    expect(json).not.toContain("/Users/private");
    expect(json).not.toContain("raw/secret");
    expect(json).not.toContain("must-not-leak");
    // Stable key ordering also applies to flexible canonical metadata.
    expect(json.indexOf('"a": 1')).toBeLessThan(json.indexOf('"z": 2'));
  });

  test("relative source path is explicit opt-in", async () => {
    const document = await buildThreadExport(exportDb(), "dlg_1", {
      includeRelativeSourcePaths: true,
    });
    expect(document.revisions[0]!.source?.relativePath).toBe("private-workspace/session.jsonl");
  });

  test("atomic file output is private and stdout mode performs no write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baka-export-test-"));
    temporaryDirectories.push(dir);
    const target = path.join(dir, "nested", "thread.json");
    const result = await exportThread(exportDb(), "dlg_1", { outputPath: target });
    expect(result.outputPath).toBe(path.resolve(target));
    expect(await readFile(target, "utf8")).toBe(result.json);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await exportThread(exportDb(), "dlg_1", { outputPath: "-" })).outputPath).toBeUndefined();
  });

  test("file output is no-clobber by default and overwrites only with explicit force", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baka-export-clobber-"));
    temporaryDirectories.push(dir);
    const target = path.join(dir, "thread.json");
    await writeFile(target, "keep-me", { mode: 0o600 });
    await expect(exportThread(exportDb(), "dlg_1", { outputPath: target })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(target, "utf8")).toBe("keep-me");

    const forced = await exportThread(exportDb(), "dlg_1", { outputPath: target, force: true });
    expect(await readFile(target, "utf8")).toBe(forced.json);
  });

  test("force refuses to replace a symlink output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baka-export-symlink-"));
    temporaryDirectories.push(dir);
    const outside = path.join(dir, "outside.txt");
    const target = path.join(dir, "thread.json");
    await writeFile(outside, "do-not-touch");
    await symlink(outside, target);
    await expect(
      exportThread(exportDb(), "dlg_1", { outputPath: target, force: true }),
    ).rejects.toThrow(/non-regular output/);
    expect(await readFile(outside, "utf8")).toBe("do-not-touch");
  });

  test("missing dialogue is an explicit error", async () => {
    const db = { query: async () => [[]] } as unknown as Surreal;
    await expect(buildThreadExport(db, "missing")).rejects.toBeInstanceOf(ThreadExportNotFoundError);
  });
});

beforeAll(async () => {
  await isDbAvailable();
});
const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

describe("thread export integration", () => {
  testDb("live Surreal corpus exports through the whitelisted projections", async () => {
    const t = await createTestDb();
    try {
      const host = await ensureHost(t.db, {
        hostUuid: "export-host",
        hostname: "test-host",
        platform: "test",
        arch: "test",
      });
      const harness = await ensureHarness(t.db, {
        slug: "codex",
        displayName: HARNESSES.codex.displayName,
        kind: HARNESSES.codex.sourceKind,
      });
      const installation = await ensureHarnessInstallation(t.db, {
        host,
        harness,
        installed: true,
      });
      const root = await ensureSourceRoot(t.db, {
        harnessInstallation: installation,
        path: "/private/source/root",
        sourceKind: "file_tree",
        parserName: "codex",
        snapshotStrategy: "copy",
        enabled: true,
      });
      const run = await createSyncRun(t.db, {
        kind: "fixture",
        host,
        bakaCommit: "test",
        schemaVersion: 1,
      });
      const location = await ensureSourceLocation(t.db, {
        sourceRoot: root,
        relativePath: "private/session.jsonl",
        originalPath: "/Users/private/.codex/session.jsonl",
        basename: "session.jsonl",
      });
      const source = await ensureSourceRevision(t.db, {
        sourceLocation: location.id,
        sha256: "a".repeat(64),
        sizeBytes: 17,
        mtimeMs: 1,
        rawArchivePath: "raw/private/session.jsonl",
        snapshotKind: "regular_copy",
        parserName: "codex",
        parserVersion: 2,
        syncRun: run,
      });
      await updateSourceRevisionParse(t.db, source.id, {
        parseStatus: "parsed",
        dialoguesDiscovered: 1,
        canonicalHash: "b".repeat(64),
      });
      const written = await writeDialogueRevision(t.db, {
        identityKey: `${installation.toString()}:export-dialogue`,
        harnessInstallation: installation,
        sourceRevision: source.id,
        sourceDialogueId: "export-dialogue",
        parserName: "codex",
        parserVersion: 2,
        parsed: {
          externalId: "export-dialogue",
          title: "Integration export",
          messages: [{
            sequence: 0,
            role: "user",
            humanAuthored: true,
            visibleToUser: true,
            usageEvents: [],
            chunks: [{ sequence: 0, kind: "text", content: "live canonical text", metadata: {} }],
            metadata: {},
          }],
          metadata: {},
        },
        extractors: codexExtractors,
        modelIds: new Map(),
        activeEmbeddingSpaces: [],
        enqueueEmbeddings: false,
      });

      const result = await exportThread(t.db, written.dialogueId);
      expect(result.document.dialogue.id).toBe(written.dialogueId.toString());
      expect(result.document.revisions[0]!.source?.sha256).toBe("a".repeat(64));
      expect(result.document.revisions[0]!.messages[0]!.chunks[0]!.content)
        .toBe("live canonical text");
      expect(result.json).not.toContain("/Users/private");
      expect(result.json).not.toContain("raw/private");
    } finally {
      await dropTestDb(t);
    }
  });
});
