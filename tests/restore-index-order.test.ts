import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { manifestPathForExport } from "../src/backup/backup.ts";
import { SqlRootError } from "../src/backup/http.ts";
import { reorderImportFile } from "../src/backup/reorder-import.ts";
import {
  buildDeferredFulltextIndexes,
  RESTORE_FULLTEXT_INDEX_DEFINITIONS,
  RestoreIndexBuildError,
} from "../src/backup/restore-indexes.ts";
import {
  isRestoreNamespace,
  RestoreTestAttemptError,
  runRestoreTest,
} from "../src/backup/restore-test.ts";
import type { AppConfig } from "../src/config.ts";
import { persistRestoreTestFailureReport } from "../src/cli.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import { isolatedRestoreTargetEvidence } from "./restore-target-fixture.ts";

const SEARCH_INDEX = `DEFINE INDEX IF NOT EXISTS search_document_content
ON TABLE search_document
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25(1.2,0.75) HIGHLIGHTS;`;

const CHUNK_INDEX = `DEFINE INDEX IF NOT EXISTS chunk_content
ON TABLE chunk
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25(1.2,0.75) HIGHLIGHTS;`;

const SCHEMA_PREFIX = `OPTION IMPORT;
DEFINE TABLE IF NOT EXISTS chunk SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS content ON TABLE chunk TYPE string;
DEFINE TABLE IF NOT EXISTS search_document SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS content ON TABLE search_document TYPE string;
DEFINE ANALYZER IF NOT EXISTS archive_mixed
TOKENIZERS class, camel
FILTERS lowercase;

`;

const TABLE_DATA = `

-- TABLE DATA: chunk
INSERT [
  { id: chunk:one, content: "literal; DEFINE INDEX fake FULLTEXT ANALYZER x;" }
];

-- TABLE DATA: search_document
INSERT [
  { id: search_document:one, content: "bulk restore" }
];
`;

const VALID_EXPORT = SCHEMA_PREFIX + SEARCH_INDEX + "\n\n" + CHUNK_INDEX + TABLE_DATA;

async function withTempDir(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "baka-restore-index-order-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function config(archiveRoot: string): AppConfig {
  return {
    archiveRoot,
    surrealUrl: "ws://127.0.0.1:1/rpc",
    surrealUser: "root",
    surrealPass: "private-password",
    surrealNamespace: "source_must_not_be_queried",
    surrealDatabase: "archive",
    lockPath: path.join(archiveRoot, ".lock"),
  } as unknown as AppConfig;
}

async function writeLogicalArtifact(directory: string): Promise<string> {
  const exportPath = path.join(directory, "backups", "surreal", "test.surql.gz");
  await mkdir(path.dirname(exportPath), { recursive: true });
  await writeFile(exportPath, "authenticated compressed placeholder");
  const hashes = await hashFile(exportPath);
  const manifestPath = manifestPathForExport(exportPath);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({
    createdAt: "2026-07-26T00:00:00.000Z",
    surrealdbVersion: "3.2.3",
    schemaVersion: 5,
    bakaCommit: "test",
    namespace: "source_must_not_be_queried",
    database: "archive",
    recordCounts: {},
    rawManifestSha256: "b".repeat(64),
    exportFile: path.basename(exportPath),
    compression: "gzip",
    exportBytes: hashes.sizeBytes,
    exportSha256: hashes.sha256,
  })}\n`);
  return exportPath;
}

async function failureOf(operation: Promise<unknown>): Promise<RestoreTestAttemptError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreTestAttemptError);
    return error as RestoreTestAttemptError;
  }
  throw new Error("expected restore attempt to fail");
}

describe("restore FULLTEXT reorder", () => {
  test("strips both legacy indexes but defers only the core search index", async () => {
    await withTempDir(async (directory) => {
      const input = path.join(directory, "export.surql");
      const output = path.join(directory, "import.surql");
      await writeFile(input, VALID_EXPORT);

      const deferred = await reorderImportFile(input, output);

      expect(deferred).toEqual([SEARCH_INDEX]);
      expect(await readFile(output, "utf8")).toBe(
        SCHEMA_PREFIX + "\n\n" + TABLE_DATA,
      );
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(reorderImportFile(input, output)).rejects.toMatchObject({ code: "EEXIST" });
    });
  });

  test("buffers a populated multi-line export without overflowing writev", async () => {
    await withTempDir(async (directory) => {
      const input = path.join(directory, "populated-export.surql");
      const output = path.join(directory, "populated-import.surql");
      const rows = Array.from(
        { length: 2_048 },
        (_, index) => `-- TABLE DATA row ${index}\n`,
      ).join("");
      const populatedExport = SCHEMA_PREFIX + SEARCH_INDEX + "\n\n" + CHUNK_INDEX +
        "\n" + rows + TABLE_DATA;
      await writeFile(input, populatedExport);

      const deferred = await reorderImportFile(input, output);

      expect(deferred).toEqual([SEARCH_INDEX]);
      expect(await readFile(output, "utf8")).toBe(
        SCHEMA_PREFIX + "\n\n\n" + rows + TABLE_DATA,
      );
    });
  });

  test("accepts an absent forensic index but requires the exact core search index", async () => {
    await withTempDir(async (directory) => {
      const input = path.join(directory, "export.surql");
      const output = path.join(directory, "import.surql");
      await writeFile(input, SCHEMA_PREFIX + SEARCH_INDEX + TABLE_DATA);
      expect(await reorderImportFile(input, output)).toEqual([SEARCH_INDEX]);
      expect((await stat(output)).mode & 0o777).toBe(0o600);

      const wrongTargetOutput = path.join(directory, "wrong-target.surql");
      await writeFile(
        input,
        SCHEMA_PREFIX + CHUNK_INDEX + TABLE_DATA,
      );
      await expect(reorderImportFile(input, wrongTargetOutput)).rejects.toThrow(
        /required core index search_document_content@search_document/,
      );

      const absentOutput = path.join(directory, "absent.surql");
      await writeFile(input, "OPTION IMPORT;\nDEFINE TABLE IF NOT EXISTS test SCHEMALESS;\n");
      await expect(reorderImportFile(input, absentOutput)).rejects.toThrow(
        /got tables none and indexes none/,
      );
    });
  });

  test("fails closed when OPTION IMPORT is absent or only commented", async () => {
    await withTempDir(async (directory) => {
      const absentInput = path.join(directory, "absent-option.surql");
      const absentOutput = path.join(directory, "absent-option.import.surql");
      await writeFile(absentInput, VALID_EXPORT.replace("OPTION IMPORT;\n", ""));
      await expect(reorderImportFile(absentInput, absentOutput)).rejects.toThrow(
        /missing an active OPTION IMPORT directive/,
      );

      const commentedInput = path.join(directory, "commented-option.surql");
      const commentedOutput = path.join(directory, "commented-option.import.surql");
      await writeFile(commentedInput, VALID_EXPORT.replace("OPTION IMPORT;", "-- OPTION IMPORT;"));
      await expect(reorderImportFile(commentedInput, commentedOutput)).rejects.toThrow(
        /missing an active OPTION IMPORT directive/,
      );
    });
  });

  test("reports index_reorder and removes both temporary files on validation failure", async () => {
    await withTempDir(async (directory) => {
      const exportPath = await writeLogicalArtifact(directory);
      const removedNamespaces: string[] = [];
      let importCalls = 0;
      let tmpExport = "";
      const error = await failureOf(runRestoreTest(
        config(directory),
        { exportPath, targetEvidence: isolatedRestoreTargetEvidence() },
        {
          removeNamespace: async (_cfg, namespace) => {
            removedNamespaces.push(namespace);
          },
          decompress: async (_source, destination) => {
            tmpExport = destination;
            await writeFile(destination, SCHEMA_PREFIX + CHUNK_INDEX + TABLE_DATA);
          },
          uploadFile: async () => {
            importCalls += 1;
            return { bytesSent: 0, statusCode: 200 };
          },
          buildDeferredIndexes: async () => {
            throw new Error("must not build an invalid index set");
          },
          connectDb: async () => {
            throw new Error("must not connect after reorder failure");
          },
        },
      ));

      expect(error.report.failure).toEqual({
        stage: "index_reorder",
        code: "index_reorder_failed",
      });
      expect(importCalls).toBe(0);
      expect(removedNamespaces).toHaveLength(2);
      expect(removedNamespaces.every(isRestoreNamespace)).toBe(true);
      await expect(stat(tmpExport)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(`${tmpExport}.without-fulltext.surql`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  test("tracks a failed core index for allowlisted cleanup", async () => {
    await withTempDir(async (directory) => {
      const exportPath = await writeLogicalArtifact(directory);
      const calls: string[] = [];
      let tmpExport = "";
      let imported = "";
      let deferredSql = "";
      let importMode = 0;
      const removedNamespaces: string[] = [];
      const cleanupOrder: string[] = [];
      const error = await failureOf(runRestoreTest(
        config(directory),
        { exportPath, targetEvidence: isolatedRestoreTargetEvidence() },
        {
          removeNamespace: async (_cfg, namespace) => {
            removedNamespaces.push(namespace);
            cleanupOrder.push(`namespace:${removedNamespaces.length}`);
          },
          removeDeferredIndexes: async (_cfg, namespace, database, indexes) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            expect(database).toBe("archive");
            expect(indexes).toEqual(RESTORE_FULLTEXT_INDEX_DEFINITIONS);
            cleanupOrder.push(`index:${indexes[0]!.name}`);
            throw new Error("SuperPrivateToken cleanup transport detail");
          },
          decompress: async (_source, destination) => {
            tmpExport = destination;
            await writeFile(destination, VALID_EXPORT);
          },
          uploadFile: async (options) => {
            calls.push("import");
            expect(options.headers?.Accept).toBe("application/json");
            imported = await readFile(options.sourcePath, "utf8");
            importMode = (await stat(`${tmpExport}.without-fulltext.surql`)).mode & 0o777;
            return {
              bytesSent: Buffer.byteLength(imported),
              statusCode: 200,
            };
          },
          buildDeferredIndexes: async (_cfg, namespace, database, statements) => {
            calls.push("index_build");
            expect(isRestoreNamespace(namespace)).toBe(true);
            expect(database).toBe("archive");
            deferredSql = statements.join("\n");
            throw new RestoreIndexBuildError([
              {
                name: "search_document_content",
                table: "search_document",
                ordinal: 1,
                state: "failed",
                category: "asynchronous_failure",
                status: "error",
                polls: 7,
                elapsedMs: 123,
                indexElapsedMs: 23,
                responseBytes: 29,
                responseSha256: "d".repeat(64),
              },
            ], new Error("SuperPrivateToken index builder failure"),
            [RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]]);
          },
          connectDb: async () => {
            throw new Error("must not connect after index build failure");
          },
        },
      ));

      expect(calls).toEqual(["import", "index_build"]);
      expect(imported).toContain("TABLE DATA: chunk");
      expect(imported).not.toContain("search_document_content");
      expect(imported).not.toContain("chunk_content");
      expect(imported).toContain("DEFINE INDEX fake FULLTEXT ANALYZER x;");
      expect(deferredSql).toContain("search_document_content");
      expect(deferredSql).not.toContain("chunk_content");
      expect(importMode).toBe(0o600);
      expect(error.report.failure).toEqual({
        stage: "index_build",
        code: "index_build_failed",
      });
      expect(error.report.indexBuilds).toEqual([
        expect.objectContaining({
          name: "search_document_content",
          table: "search_document",
          ordinal: 1,
          category: "asynchronous_failure",
          status: "error",
          polls: 7,
        }),
      ]);
      expect(removedNamespaces).toEqual([error.report.namespace, error.report.namespace]);
      expect(cleanupOrder).toEqual([
        "namespace:1",
        "index:search_document_content",
        "namespace:2",
      ]);
      expect(error.report.cleanupFailures).toEqual(["index_remove"]);
      expect(JSON.stringify(error.report)).not.toContain("SuperPrivateToken");
      await expect(stat(tmpExport)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(`${tmpExport}.without-fulltext.surql`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  test("retains the successfully built core index through a later failure and cleans it first", async () => {
    await withTempDir(async (directory) => {
      const exportPath = await writeLogicalArtifact(directory);
      const cleanupOrder: string[] = [];
      let namespaceRemovals = 0;
      const readyDiagnostics = RESTORE_FULLTEXT_INDEX_DEFINITIONS.map((index) => ({
        name: index.name,
        table: index.table,
        ordinal: index.ordinal,
        state: "ready" as const,
        category: "ready" as const,
        status: "ready",
        polls: 1,
        elapsedMs: index.ordinal,
        indexElapsedMs: 1,
      }));

      const error = await failureOf(runRestoreTest(
        config(directory),
        { exportPath, targetEvidence: isolatedRestoreTargetEvidence() },
        {
          removeNamespace: async (_cfg, namespace) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            namespaceRemovals += 1;
            cleanupOrder.push(`namespace:${namespaceRemovals}`);
          },
          removeDeferredIndexes: async (_cfg, namespace, database, indexes) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            expect(database).toBe("archive");
            expect(indexes).toEqual(RESTORE_FULLTEXT_INDEX_DEFINITIONS);
            for (const index of [...indexes].reverse()) {
              cleanupOrder.push(`index:${index.name}`);
            }
          },
          decompress: async (_source, destination) => {
            await writeFile(destination, VALID_EXPORT);
          },
          uploadFile: async (options) => ({
            bytesSent: (await stat(options.sourcePath)).size,
            statusCode: 200,
          }),
          buildDeferredIndexes: async () => readyDiagnostics,
          connectDb: async () => {
            throw new Error("post-build private connection failure");
          },
        },
      ));

      expect(error.report.failure).toEqual({ stage: "connect", code: "connect_failed" });
      expect(error.report.indexBuilds).toEqual(readyDiagnostics);
      expect(error.report.cleanupFailures).toEqual([]);
      expect(cleanupOrder).toEqual([
        "namespace:1",
        "index:search_document_content",
        "namespace:2",
      ]);
      expect(JSON.stringify(error.report)).not.toContain("private connection failure");
    });
  });

  test("memory pressure cleans the started index and namespace before target finalization", async () => {
    await withTempDir(async (directory) => {
      const exportPath = await writeLogicalArtifact(directory);
      const order: string[] = [];
      let namespaceRemovals = 0;
      const error = await failureOf(runRestoreTest(
        config(directory),
        { exportPath },
        {
          removeNamespace: async (_cfg, namespace) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            namespaceRemovals += 1;
            order.push(`namespace:${namespaceRemovals}`);
          },
          removeDeferredIndexes: async (_cfg, namespace, database, indexes) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            expect(database).toBe("archive");
            expect(indexes).toEqual([RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]]);
            order.push("index:search_document_content");
          },
          resolveTargetEvidence: async (_provided, context) => {
            expect(context.verificationSucceeded).toBe(false);
            expect(context.restoreCleanupComplete).toBe(true);
            order.push("target-finalize");
            return undefined;
          },
          decompress: async (_source, destination) => {
            await writeFile(destination, VALID_EXPORT);
          },
          uploadFile: async (options) => ({
            bytesSent: (await stat(options.sourcePath)).size,
            statusCode: 200,
          }),
          buildDeferredIndexes: async () => {
            throw new RestoreIndexBuildError([{
              name: "search_document_content",
              table: "search_document",
              ordinal: 1,
              state: "failed",
              category: "memory_pressure",
              envelope: "table_info",
              status: "err",
              polls: 9,
              elapsedMs: 40_264,
              indexElapsedMs: 40_264,
            }], new Error("SuperPrivateToken raw threshold response"), [
              RESTORE_FULLTEXT_INDEX_DEFINITIONS[0],
            ]);
          },
          connectDb: async () => {
            throw new Error("must not connect after memory pressure");
          },
        },
      ));

      expect(order).toEqual([
        "namespace:1",
        "index:search_document_content",
        "namespace:2",
        "target-finalize",
      ]);
      expect(error.report.failure).toEqual({
        stage: "index_build",
        code: "index_build_failed",
      });
      expect(error.report.indexBuilds).toEqual([expect.objectContaining({
        category: "memory_pressure",
        envelope: "table_info",
        status: "err",
        polls: 9,
      })]);
      expect(error.report.cleanupFailures).toEqual([]);
      expect(JSON.stringify(error.report)).not.toContain("SuperPrivateToken");
    });
  });

  test("owns a lost DEFINE dispatch and removes its allowlisted index before namespace cleanup", async () => {
    await withTempDir(async (directory) => {
      const exportPath = await writeLogicalArtifact(directory);
      const cleanupOrder: string[] = [];
      const removedIndexes: string[][] = [];
      let namespaceRemovals = 0;
      let lostResponseError: RestoreIndexBuildError | undefined;
      let connectCalls = 0;
      const error = await failureOf(runRestoreTest(
        config(directory),
        { exportPath, targetEvidence: isolatedRestoreTargetEvidence() },
        {
          removeNamespace: async () => {
            namespaceRemovals += 1;
            cleanupOrder.push(`namespace:${namespaceRemovals}`);
          },
          removeDeferredIndexes: async (_cfg, namespace, database, indexes) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            expect(database).toBe("archive");
            removedIndexes.push(indexes.map((index) => `${index.name}@${index.table}`));
            cleanupOrder.push("index:search_document_content@search_document");
          },
          decompress: async (_source, destination) => {
            await writeFile(destination, VALID_EXPORT);
          },
          uploadFile: async (options) => ({
            bytesSent: (await stat(options.sourcePath)).size,
            statusCode: 200,
          }),
          buildDeferredIndexes: async (cfg, namespace, database, statements) => {
            try {
              return await buildDeferredFulltextIndexes(
                cfg,
                namespace,
                database,
                statements,
                {
                  executeCommand: async () => {
                    throw new Error(
                      "SuperPrivateToken lost response with Authorization and raw SQL",
                    );
                  },
                },
              );
            } catch (cause) {
              expect(cause).toBeInstanceOf(RestoreIndexBuildError);
              lostResponseError = cause as RestoreIndexBuildError;
              throw cause;
            }
          },
          connectDb: async () => {
            connectCalls += 1;
            throw new Error("must not connect after a lost DEFINE response");
          },
        },
      ));

      expect(lostResponseError?.startedIndexes).toEqual([
        RESTORE_FULLTEXT_INDEX_DEFINITIONS[0],
      ]);
      expect(removedIndexes).toEqual([["search_document_content@search_document"]]);
      expect(cleanupOrder).toEqual([
        "namespace:1",
        "index:search_document_content@search_document",
        "namespace:2",
      ]);
      expect(connectCalls).toBe(0);
      expect(error.report.failure).toEqual({
        stage: "index_build",
        code: "index_build_failed",
      });
      expect(error.report.indexBuilds).toEqual([expect.objectContaining({
        name: "search_document_content",
        table: "search_document",
        ordinal: 1,
        category: "define_request",
        state: "failed",
      })]);
      expect(error.report.cleanupFailures).toEqual([]);
      const persistedEvidence = JSON.stringify(error.report);
      expect(persistedEvidence).not.toContain("SuperPrivateToken");
      expect(persistedEvidence).not.toContain("Authorization");
      expect(persistedEvidence).not.toContain("raw SQL");
    });
  });

  test("cancellation during index polling removes the index before bounded namespace cleanup", async () => {
    await withTempDir(async (directory) => {
      const exportPath = await writeLogicalArtifact(directory);
      const controller = new AbortController();
      const cleanupOrder: string[] = [];
      let buildStarted!: () => void;
      const atBuild = new Promise<void>((resolve) => {
        buildStarted = resolve;
      });
      let namespaceRemovals = 0;
      const operation = runRestoreTest(
        config(directory),
        {
          exportPath,
          signal: controller.signal,
          targetEvidence: isolatedRestoreTargetEvidence(),
        },
        {
          removeNamespace: async (_cfg, namespace) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            namespaceRemovals += 1;
            cleanupOrder.push(`namespace:${namespaceRemovals}`);
            if (namespaceRemovals === 2) {
              throw new SqlRootError(
                { category: "timeout" },
                new Error("SuperPrivateToken namespace response body"),
              );
            }
          },
          removeDeferredIndexes: async (_cfg, namespace, database, indexes) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            expect(database).toBe("archive");
            expect(indexes).toEqual([RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]]);
            cleanupOrder.push("index:search_document_content");
          },
          decompress: async (_source, destination) => {
            await writeFile(destination, VALID_EXPORT);
          },
          uploadFile: async (options) => {
            expect(options.signal).toBe(controller.signal);
            return { bytesSent: (await stat(options.sourcePath)).size, statusCode: 200 };
          },
          buildDeferredIndexes: async (_cfg, namespace, database, _statements, signal) => {
            expect(isRestoreNamespace(namespace)).toBe(true);
            expect(database).toBe("archive");
            expect(signal).toBe(controller.signal);
            buildStarted();
            await new Promise<void>((_resolve, reject) => {
              signal!.addEventListener("abort", () => reject(new RestoreIndexBuildError(
                [{
                  name: "search_document_content",
                  table: "search_document",
                  ordinal: 1,
                  state: "failed",
                  category: "cancelled",
                  polls: 3,
                  elapsedMs: 30,
                  indexElapsedMs: 30,
                }],
                new Error("SuperPrivateToken polling failure"),
                [RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]],
              )), { once: true });
            });
            return [];
          },
          connectDb: async () => {
            throw new Error("must not connect after cancellation");
          },
        },
      );

      await atBuild;
      controller.abort(new Error("SuperPrivateToken operator reason"));
      const error = await failureOf(operation);

      expect(error.report.failure).toEqual({ stage: "index_build", code: "cancelled" });
      expect(error.report.cleanupFailures).toEqual(["namespace_remove"]);
      expect(cleanupOrder).toEqual([
        "namespace:1",
        "index:search_document_content",
        "namespace:2",
      ]);
      const persisted = await persistRestoreTestFailureReport(directory, error.report, {
        now: new Date("2026-07-27T12:00:00.000Z"),
      });
      expect(JSON.parse(await readFile(persisted.reportPath, "utf8"))).toMatchObject({
        failure: { stage: "index_build", code: "cancelled" },
        cleanupFailures: ["namespace_remove"],
      });
      const durable = JSON.stringify(error.report);
      expect(durable).not.toContain("SuperPrivateToken");
      expect(durable).not.toContain("private-password");
    });
  });
});
