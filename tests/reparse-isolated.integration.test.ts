import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RecordId, Surreal } from "surrealdb";
import {
  withIsolatedSurrealTarget,
  type IsolatedTargetResourceProfile,
} from "../src/backup/isolated-target.ts";
import { applyMigrations } from "../src/db/migrations.ts";
import { selectAll, selectOne } from "../src/db/repositories/helpers.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
} from "../src/db/repositories/identity.ts";
import {
  createIngestError,
  createSyncRun,
  ensureSourceLocation,
  ensureSourceRevision,
  ensureSourceRoot,
  setLocationRevisions,
  updateSourceRevisionParse,
} from "../src/db/repositories/provenance.ts";
import { inspectUnresolvedIngestErrors } from "../src/doctor.ts";
import { reparseSourceRevisions } from "../src/reparse.ts";
import { HARNESSES } from "../src/sources/adapters/harnesses.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

const isolatedTest = process.env.BAKA_RUN_ISOLATED_REPARSE_INTEGRATION === "1"
  ? test
  : test.skip;

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const TEST_RESOURCES: IsolatedTargetResourceProfile = {
  memoryBytes: 2 * GIB,
  memorySwapBytes: 2 * GIB,
  cpus: 2,
  pidsLimit: 256,
  rocksDbBlockCacheBytes: 128 * MIB,
  rocksDbThreadCount: 2,
  rocksDbJobsCount: 2,
  rocksDbMaxConcurrentSubcompactions: 1,
  hnswCacheBytes: 64 * MIB,
  memoryThresholdBytes: 512 * MIB,
  httpMaxImportBodyBytes: GIB,
};

interface SeededTarget {
  revision: RecordId;
  error: RecordId;
}

function largeCodexRaw(externalId: string): string {
  const lines: string[] = [
    JSON.stringify({
      timestamp: "2026-07-27T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: externalId,
        timestamp: "2026-07-27T10:00:00.000Z",
        cwd: "/fixture/reparse",
        originator: "codex_cli_rs",
        source: "cli",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-27T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: `Synthetic prompt ${externalId}` },
    }),
  ];
  const data = "x".repeat(60_000);
  for (let index = 0; index < 175; index += 1) {
    lines.push(JSON.stringify({
      timestamp: "2026-07-27T10:00:02.000Z",
      type: "synthetic_unknown_event",
      payload: { index, data },
    }));
  }
  const answer = `Synthetic answer ${externalId}`;
  lines.push(JSON.stringify({
    timestamp: "2026-07-27T10:00:03.000Z",
    type: "event_msg",
    payload: { type: "agent_message", message: answer, phase: "final_answer" },
  }));
  return `${lines.join("\n")}\n`;
}

async function connectIsolated(url: string, username: string, password: string): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(url);
  await db.signin({ username, password });
  await db.query("DEFINE NAMESPACE IF NOT EXISTS baka_reparse_test");
  await db.use({ namespace: "baka_reparse_test" });
  await db.query("DEFINE DATABASE IF NOT EXISTS archive");
  await db.use({ namespace: "baka_reparse_test", database: "archive" });
  return db;
}

async function tableCount(db: Surreal, table: string): Promise<number> {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("unsafe test table");
  const row = await selectOne<{ n: number }>(
    db,
    `SELECT count() AS n FROM ${table} GROUP ALL`,
  );
  return row?.n ?? 0;
}

isolatedTest(
  "five exact parser-v1 large Codex failures resolve honestly and reparse idempotently on pinned 3.2.3",
  async () => {
    const archive = await mkdtemp(path.join(os.tmpdir(), "baka-reparse-isolated-"));
    const credentials = { username: "root", password: "isolated-reparse-test-password" };
    let callbackFailure: unknown;
    try {
      const result = await withIsolatedSurrealTarget(
        { credentials, resources: TEST_RESOURCES, readinessTimeoutMs: 60_000 },
        async (target) => {
          let db: Surreal | undefined;
          try {
            db = await connectIsolated(
              target.surrealUrl,
              credentials.username,
              credentials.password,
            );
            await applyMigrations(db, {
              bakaCommit: "reparse-isolated-test",
              surrealdbVersion: "3.2.3",
            });
            const host = await ensureHost(db, {
              hostUuid: "reparse-isolated-host",
              hostname: "isolated",
              platform: "test",
              arch: "test",
            });
            const harness = await ensureHarness(db, {
              slug: "codex",
              displayName: HARNESSES.codex.displayName,
              kind: HARNESSES.codex.sourceKind,
            });
            const installation = await ensureHarnessInstallation(db, {
              host,
              harness,
              installed: true,
            });
            const root = await ensureSourceRoot(db, {
              harnessInstallation: installation,
              path: "/fixture/codex",
              sourceKind: HARNESSES.codex.sourceKind,
              parserName: "codex",
              snapshotStrategy: "copy",
              enabled: true,
            });
            const oldRun = await createSyncRun(db, {
              kind: "fixture",
              host,
              bakaCommit: "reparse-isolated-test",
              schemaVersion: 5,
            });
            const seeded: SeededTarget[] = [];
            for (let index = 0; index < 5; index += 1) {
              const rawRelative = `raw/codex/large-${index + 1}.jsonl`;
              const rawAbsolute = path.join(archive, rawRelative);
              await mkdir(path.dirname(rawAbsolute), { recursive: true });
              await writeFile(rawAbsolute, largeCodexRaw(`large-session-${index + 1}`));
              expect((await Bun.file(rawAbsolute).size)).toBeGreaterThan(10_000_000);
              const hashes = await hashFile(rawAbsolute);
              const location = await ensureSourceLocation(db, {
                sourceRoot: root,
                relativePath: `large-${index + 1}.jsonl`,
                originalPath: `/fixture/codex/large-${index + 1}.jsonl`,
                basename: `large-${index + 1}.jsonl`,
              });
              const revision = await ensureSourceRevision(db, {
                sourceLocation: location.id,
                sha256: hashes.sha256,
                sizeBytes: hashes.sizeBytes,
                mtimeMs: index + 1,
                rawArchivePath: rawRelative,
                snapshotKind: "regular_copy",
                parserName: "codex",
                parserVersion: 1,
                syncRun: oldRun,
              });
              await updateSourceRevisionParse(db, revision.id, {
                parseStatus: "parse_error",
              });
              await setLocationRevisions(db, location.id, { currentRevision: revision.id });
              const error = await createIngestError(db, {
                syncRun: oldRun,
                sourceRevision: revision.id,
                stage: "write",
                errorCode: "dialogue_write_failed",
                errorMessage: "synthetic large dialogue failure",
                parserVersion: 2,
              });
              seeded.push({ revision: revision.id, error });
            }

            // Expected unresolved quarantine remains visible and is classified
            // from exact machine provenance, never from error_message text.
            const unsupportedLocation = await ensureSourceLocation(db, {
              sourceRoot: root,
              relativePath: "state.sqlite",
              originalPath: "/fixture/codex/state.sqlite",
              basename: "state.sqlite",
            });
            const firstHashes = await hashFile(path.join(archive, "raw/codex/large-1.jsonl"));
            const unsupportedRevision = await ensureSourceRevision(db, {
              sourceLocation: unsupportedLocation.id,
              sha256: firstHashes.sha256,
              sizeBytes: firstHashes.sizeBytes,
              mtimeMs: 100,
              rawArchivePath: "raw/codex/large-1.jsonl",
              snapshotKind: "regular_copy",
              parserName: "codex",
              parserVersion: 2,
              syncRun: oldRun,
            });
            await updateSourceRevisionParse(db, unsupportedRevision.id, {
              parseStatus: "unsupported",
            });
            await setLocationRevisions(db, unsupportedLocation.id, {
              currentRevision: unsupportedRevision.id,
            });
            await createIngestError(db, {
              syncRun: oldRun,
              sourceRevision: unsupportedRevision.id,
              stage: "parse",
              errorCode: "unsupported_file",
              errorMessage: "intentionally unsupported fixture kind",
              parserVersion: 2,
            });

            const before = await inspectUnresolvedIngestErrors(db);
            expect(before.filter((item) => item.classification === "actionable_current_failure"))
              .toHaveLength(5);
            expect(before.filter((item) => item.classification === "documented_unsupported"))
              .toHaveLength(1);

            const selection = { sourceRevisions: seeded.map((item) => item.revision) } as const;
            const firstRun = await createSyncRun(db, {
              kind: "reparse",
              host,
              bakaCommit: "reparse-isolated-test",
              schemaVersion: 5,
            });
            const first = await reparseSourceRevisions(db, archive, {
              selection,
              enqueueEmbeddings: false,
              logger: () => {},
            }, { syncRun: firstRun, activeEmbeddingSpaces: [], embeddingTables: [] });
            expect(first.status).toBe("completed");
            expect(first.counters.unitsPlanned).toBe(5);
            expect(first.counters.unitsSucceeded).toBe(5);
            expect(first.counters.messagesWritten).toBe(5 * 177);

            const stored = await selectAll<{
              id: RecordId;
              parser_version: string;
              parse_status: string;
            }>(db,
              "SELECT id, parser_version, parse_status FROM source_revision WHERE id IN $ids ORDER BY id",
              { ids: seeded.map((item) => item.revision) },
            );
            expect(stored).toHaveLength(5);
            expect(stored.every((row) =>
              row.parser_version === "2" && row.parse_status === "parsed"
            )).toBe(true);
            const errorRows = await selectAll<{
              id: RecordId;
              resolved_at?: Date;
              resolution?: string;
            }>(db,
              "SELECT id, resolved_at, resolution FROM ingest_error WHERE id IN $ids ORDER BY id",
              { ids: seeded.map((item) => item.error) },
            );
            expect(errorRows).toHaveLength(5);
            expect(errorRows.every((row) =>
              row.resolved_at !== undefined && row.resolution === "reparse:parsed@2"
            )).toBe(true);

            const afterFirst = await inspectUnresolvedIngestErrors(db);
            expect(afterFirst.filter((item) =>
              item.classification === "actionable_current_failure"
            )).toHaveLength(0);
            expect(afterFirst.map((item) => item.classification))
              .toEqual(["documented_unsupported"]);
            const countsAfterFirst = {
              dialogues: await tableCount(db, "dialogue"),
              revisions: await tableCount(db, "dialogue_revision"),
              messages: await tableCount(db, "message"),
              chunks: await tableCount(db, "chunk"),
              searchDocuments: await tableCount(db, "search_document"),
              ingestErrors: await tableCount(db, "ingest_error"),
            };
            expect(countsAfterFirst).toEqual({
              dialogues: 5,
              revisions: 5,
              messages: 5 * 177,
              chunks: 5 * 177,
              searchDocuments: 10,
              ingestErrors: 6,
            });

            const secondRun = await createSyncRun(db, {
              kind: "reparse",
              host,
              bakaCommit: "reparse-isolated-test",
              schemaVersion: 5,
            });
            const second = await reparseSourceRevisions(db, archive, {
              selection,
              enqueueEmbeddings: false,
              logger: () => {},
            }, { syncRun: secondRun, activeEmbeddingSpaces: [], embeddingTables: [] });
            expect(second.status).toBe("completed");
            expect(second.counters.unitsSucceeded).toBe(5);
            expect(second.counters.messagesWritten).toBe(0);
            expect(second.counters.chunksWritten).toBe(0);
            expect({
              dialogues: await tableCount(db, "dialogue"),
              revisions: await tableCount(db, "dialogue_revision"),
              messages: await tableCount(db, "message"),
              chunks: await tableCount(db, "chunk"),
              searchDocuments: await tableCount(db, "search_document"),
              ingestErrors: await tableCount(db, "ingest_error"),
            }).toEqual(countsAfterFirst);
            return { hostPort: target.hostPort };
          } catch (error) {
            callbackFailure = error;
            throw error;
          } finally {
            await db?.close().catch(() => {});
          }
        },
      ).catch((error) => {
        throw callbackFailure ?? error;
      });

      expect(result.value.hostPort).not.toBe(8901);
      expect(result.evidence.version).toBe("3.2.4");
      expect(result.evidence.runtimeVersion).toStartWith("3.2.4");
      expect(result.evidence.cleanup).toEqual(expect.objectContaining({
        containerRemoved: true,
        volumeRemoved: true,
        timedOut: false,
      }));
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  },
  240_000,
);
