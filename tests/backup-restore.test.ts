import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Surreal } from "surrealdb";
import { manifestPathForExport } from "../src/backup/backup.ts";
import { compressFile } from "../src/backup/compress.ts";
import { StreamHttpUploadError } from "../src/backup/http-upload.ts";
import {
  connectRestoreDb,
  createRestoreNamespace,
  expectedSuccessfulRestoreCheckNames,
  isRestoreNamespace,
  parseRestoreTargetEvidence,
  parsePersistedRestoreTestReport,
  PINNED_RESTORE_TARGET_IMAGE_DIGEST,
  PINNED_RESTORE_TARGET_VERSION,
  requiredRestoreCheckNamesForSchemaVersion,
  restoreRelationalChecksForSchemaVersion,
  RestoreTestAttemptError,
  runRestoreTest,
  validateRestoreFulltextIndexReadiness,
  verifyRestoredSearch,
  type RestoreTargetEvidence,
} from "../src/backup/restore-test.ts";
import type { AppConfig } from "../src/config.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

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

async function withTempDir(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "baka-restore-test-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

async function writeManifest(
  archiveRoot: string,
  exportPath: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
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
    ...overrides,
  })}\n`);
}

function isolatedTargetEvidence(
  overrides: Record<string, unknown> = {},
): RestoreTargetEvidence {
  return {
    mode: "isolated_pinned_container",
    image: {
      version: PINNED_RESTORE_TARGET_VERSION,
      digest: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
    },
    dataIdentitySha256: "d".repeat(64),
    resourceBounds: {
      memoryBytes: 12 * 1024 * 1024 * 1024,
      memorySwapBytes: 12 * 1024 * 1024 * 1024,
      nanoCpus: 4_000_000_000,
      pidsLimit: 512,
      rocksDbBlockCacheBytes: 1024 * 1024 * 1024,
      rocksDbThreadCount: 4,
      rocksDbJobsCount: 4,
      rocksDbMaxConcurrentSubcompactions: 2,
      hnswCacheBytes: 256 * 1024 * 1024,
      memoryThresholdBytes: 6 * 1024 * 1024 * 1024,
      httpMaxImportBodyBytes: 32 * 1024 * 1024 * 1024,
      indexBuildResumeIntervalSeconds: 0,
    },
    pinnedIndexingBehavior: {
      probeRecords: 16,
      targetBytes: 8_388_608,
      maxRecords: 250,
    },
    fulltextIndexes: [
      {
        ordinal: 1,
        name: "search_document_content",
        table: "search_document",
        field: "content",
        analyzer: "archive_mixed",
        state: "ready",
      },
    ],
    cleanup: {
      containerRemoved: true,
      dataVolumeRemoved: true,
    },
    ...overrides,
  } as RestoreTargetEvidence;
}

function persistedRestoreReport(
  archiveRoot: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const attemptId = "a".repeat(32);
  const exportFile = "backup.surql.gz";
  const manifestFile = "backup.json";
  const searchDocuments = 0;
  return {
    formatVersion: 5,
    ok: true,
    attemptId,
    runId: "restore_test:contract",
    startedAt: "2026-07-26T12:00:00.000Z",
    finishedAt: "2026-07-26T12:01:00.000Z",
    createdAt: "2026-07-26T12:01:01.000Z",
    namespace: `baka_restore_test_${attemptId}`,
    database: "archive",
    archiveRoot,
    rawArchiveRoot: archiveRoot,
    exportPath: path.join(archiveRoot, "backups", "surreal", exportFile),
    exportFile,
    exportBytes: 123,
    exportSha256: "a".repeat(64),
    manifestPath: path.join(archiveRoot, "backups", "manifests", manifestFile),
    manifestFile,
    manifestSha256: "b".repeat(64),
    rawManifestSha256: "c".repeat(64),
    schemaVersion: 5,
    searchDocuments,
    chunks: 0,
    checks: expectedSuccessfulRestoreCheckNames(searchDocuments, 0).map((name) => ({
      name,
      ok: true,
      detail: "verified",
    })),
    cleanup: {
      databaseClosed: true,
      temporaryExportRemoved: true,
      namespaceRemoved: true,
    },
    target: isolatedTargetEvidence(),
    ...overrides,
  };
}

describe("restore namespace and connection lifecycle", () => {
  test("concurrent attempts receive distinct strict identifiers", async () => {
    const namespaces = await Promise.all(
      Array.from({ length: 128 }, async () => createRestoreNamespace()),
    );
    expect(new Set(namespaces).size).toBe(namespaces.length);
    expect(namespaces.every(isRestoreNamespace)).toBe(true);
  });

  for (const failedStep of ["signin", "use"] as const) {
    test(`connectRestoreDb closes the socket when ${failedStep} fails`, async () => {
      let closeCalls = 0;
      const fake = {
        connect: async () => {},
        signin: async () => {
          if (failedStep === "signin") throw new Error("private signin failure");
        },
        use: async () => {
          if (failedStep === "use") throw new Error("private use failure");
        },
        close: async () => {
          closeCalls += 1;
        },
      } as unknown as Surreal;
      await expect(connectRestoreDb(
        config("/tmp/not-used"),
        createRestoreNamespace(),
        () => fake,
      )).rejects.toThrow(/private/);
      expect(closeCalls).toBe(1);
    });
  }
});

describe("strict persisted restore evidence v5", () => {
  test("accepts the exact schema-5 zero-document contract", () => {
    const root = path.resolve("/tmp/baka-restore-contract");
    const parsed = parsePersistedRestoreTestReport(persistedRestoreReport(root));
    expect(parsed.namespace).toBe(`baka_restore_test_${"a".repeat(32)}`);
    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.searchDocuments).toBe(0);
  });

  test("requires sequential nonzero BM25 probes for a nonempty projection", () => {
    const root = path.resolve("/tmp/baka-restore-contract-search");
    const report = persistedRestoreReport(root, {
      searchDocuments: 4,
      checks: expectedSuccessfulRestoreCheckNames(4, 2).map((name) => ({
        name,
        ok: true,
        detail: "verified",
      })),
    });
    expect(parsePersistedRestoreTestReport(report).searchDocuments).toBe(4);
    const partial = structuredClone(report);
    (partial.checks as unknown[]).splice(-3, 1);
    expect(() => parsePersistedRestoreTestReport(partial)).toThrow(/probe|checks/);
  });

  test("retains nonempty canonical chunk counts without requiring a forensic index probe", () => {
    const root = path.resolve("/tmp/baka-restore-contract-chunks");
    const report = persistedRestoreReport(root, {
      chunks: 7,
    });
    expect(parsePersistedRestoreTestReport(report).chunks).toBe(7);
    const forgedForensic = structuredClone(report);
    (forgedForensic.checks as unknown[]).splice(-2, 0, {
      name: "forensic chunk probes",
      ok: true,
      detail: "not part of core restore acceptance",
    });
    expect(() => parsePersistedRestoreTestReport(forgedForensic)).toThrow(/unknown|checks/);
  });

  test("accepts schema 4 with its exact pre-migration check contract", () => {
    const root = path.resolve("/tmp/baka-restore-contract-schema4");
    const checks = expectedSuccessfulRestoreCheckNames(0, 0, 4).map((name) => ({
      name,
      ok: true,
      detail: "verified",
    }));
    const parsed = parsePersistedRestoreTestReport(persistedRestoreReport(root, {
      schemaVersion: 4,
      checks,
    }));
    expect(parsed.schemaVersion).toBe(4);
    expect(checks.some((check) => check.name.includes("migration_row_commit"))).toBe(false);
    expect(checks.some((check) => check.name.includes("migration_quarantine"))).toBe(false);
  });

  test("schema-specific reports cannot substitute the other version's checks", () => {
    const root = path.resolve("/tmp/baka-restore-contract-schema-binding");
    const schema4Names = requiredRestoreCheckNamesForSchemaVersion(4);
    const schema5Names = requiredRestoreCheckNamesForSchemaVersion(5);
    expect(schema5Names).toContain("invariant: migration_row_commit migration/target");
    expect(schema5Names).toContain("invariant: migration_quarantine migration/previous_attempt");
    expect(schema4Names.some((name) => name.includes("migration_row_commit"))).toBe(false);
    expect(schema4Names.some((name) => name.includes("migration_quarantine"))).toBe(false);
    expect(restoreRelationalChecksForSchemaVersion(4).some(
      ([name]) => name.includes("migration_quarantine"),
    )).toBe(false);

    const wrongSchema4 = persistedRestoreReport(root, { schemaVersion: 4 });
    expect(() => parsePersistedRestoreTestReport(wrongSchema4)).toThrow(/checks/);

    const wrongSchema5 = persistedRestoreReport(root, {
      checks: expectedSuccessfulRestoreCheckNames(0, 0, 4).map((name) => ({
        name,
        ok: true,
        detail: "verified",
      })),
    });
    expect(() => parsePersistedRestoreTestReport(wrongSchema5)).toThrow(/checks/);
  });

  test("rejects unknown, duplicate, partial, fixed-namespace and incomplete-cleanup reports", () => {
    const root = path.resolve("/tmp/baka-restore-contract-tamper");
    const valid = persistedRestoreReport(root);
    expect(() => parsePersistedRestoreTestReport({ ...valid, extra: true })).toThrow(/exact fields/);

    const duplicate = structuredClone(valid);
    (duplicate.checks as unknown[]).push((duplicate.checks as unknown[])[0]);
    expect(() => parsePersistedRestoreTestReport(duplicate)).toThrow(/duplicated|checks/);

    const partial = structuredClone(valid);
    (partial.checks as unknown[]).pop();
    expect(() => parsePersistedRestoreTestReport(partial)).toThrow(/missing|checks/);

    expect(() => parsePersistedRestoreTestReport({
      ...valid,
      namespace: "baka_restore_test",
    })).toThrow(/identity/);
    expect(() => parsePersistedRestoreTestReport({
      ...valid,
      cleanup: { ...(valid.cleanup as object), namespaceRemoved: false },
    })).toThrow(/cleanup/);
  });

  test("rejects stale v3 reports which claimed unsupported batch 64", () => {
    const root = path.resolve("/tmp/baka-restore-contract-stale-batch");
    const stale = persistedRestoreReport(root, { formatVersion: 3 });
    const staleTarget = stale.target as Record<string, unknown>;
    const staleResources = staleTarget.resourceBounds as Record<string, unknown>;
    staleResources.indexingBatchSize = 64;
    delete staleTarget.pinnedIndexingBehavior;
    expect(() => parsePersistedRestoreTestReport(stale)).toThrow(/formatVersion\/ok/);
    expect(() => parseRestoreTargetEvidence(staleTarget)).toThrow(/exact fields/);
  });

  test("rejects legacy v4 reports whose acceptance required the global forensic index", () => {
    const root = path.resolve("/tmp/baka-restore-contract-v4-forensic");
    const legacy = persistedRestoreReport(root, { formatVersion: 4 });
    expect(() => parsePersistedRestoreTestReport(legacy)).toThrow(/formatVersion\/ok/);
  });
});

describe("strict isolated restore target evidence", () => {
  test("accepts only the exact pinned isolated evidence and approved resource profile", () => {
    const parsed = parseRestoreTargetEvidence(isolatedTargetEvidence());
    expect(parsed.mode).toBe("isolated_pinned_container");
    expect(parsed.image).toEqual({
      version: "3.2.3",
      digest: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
    });
    expect(parsed.fulltextIndexes.map((index) => index.name)).toEqual([
      "search_document_content",
    ]);
    expect(parsed.resourceBounds).toEqual({
      memoryBytes: 12 * 1024 ** 3,
      memorySwapBytes: 12 * 1024 ** 3,
      nanoCpus: 4_000_000_000,
      pidsLimit: 512,
      rocksDbBlockCacheBytes: 1024 ** 3,
      rocksDbThreadCount: 4,
      rocksDbJobsCount: 4,
      rocksDbMaxConcurrentSubcompactions: 2,
      hnswCacheBytes: 256 * 1024 ** 2,
      memoryThresholdBytes: 6 * 1024 ** 3,
      httpMaxImportBodyBytes: 32 * 1024 ** 3,
      indexBuildResumeIntervalSeconds: 0,
    });
    expect(parsed.pinnedIndexingBehavior).toEqual({
      probeRecords: 16,
      targetBytes: 8_388_608,
      maxRecords: 250,
    });
  });

  test("rejects weaker bounded values instead of treating the approved profile as minimums", () => {
    for (const mutation of [
      { memoryBytes: 2 * 1024 ** 3 },
      { memorySwapBytes: 2 * 1024 ** 3 },
      { nanoCpus: 500_000_000 },
      { pidsLimit: 64 },
      { rocksDbBlockCacheBytes: 16 * 1024 ** 2 },
      { hnswCacheBytes: 16 * 1024 ** 2 },
      { memoryThresholdBytes: 1024 ** 3 },
      { memoryThresholdBytes: 64 * 1024 ** 2 },
      { httpMaxImportBodyBytes: 1024 ** 2 },
    ]) {
      expect(() => parseRestoreTargetEvidence({
        ...isolatedTargetEvidence(),
        resourceBounds: {
          ...isolatedTargetEvidence().resourceBounds,
          ...mutation,
        },
      })).toThrow(/exact bounded approved isolated profile/);
    }
  });

  test("rejects stronger alternatives because durable evidence requires the exact profile", () => {
    expect(() => parseRestoreTargetEvidence({
      ...isolatedTargetEvidence(),
      resourceBounds: {
        ...isolatedTargetEvidence().resourceBounds,
        memoryBytes: 16 * 1024 ** 3,
        memorySwapBytes: 16 * 1024 ** 3,
      },
    })).toThrow(/exact bounded approved isolated profile/);
  });

  test("requires the exact pinned adaptive indexing behavior separately from resources", () => {
    for (const pinnedIndexingBehavior of [
      { probeRecords: 64, targetBytes: 8_388_608, maxRecords: 250 },
      { probeRecords: 16, targetBytes: 64, maxRecords: 250 },
      { probeRecords: 16, targetBytes: 8_388_608, maxRecords: 64 },
    ]) {
      expect(() => parseRestoreTargetEvidence({
        ...isolatedTargetEvidence(),
        pinnedIndexingBehavior,
      })).toThrow(/pinned indexing behavior/);
    }
  });

  test("rejects same-server namespace evidence for production acceptance", () => {
    expect(() => parseRestoreTargetEvidence({
      ...isolatedTargetEvidence(),
      mode: "same_server_namespace",
    })).toThrow(/isolated_pinned_container/);
  });

  test("rejects missing, duplicate, non-core and non-ready FULLTEXT indexes", () => {
    const indexes = isolatedTargetEvidence().fulltextIndexes;
    for (const invalid of [
      [],
      [indexes[0], indexes[0]],
      [{ ...indexes[0], state: "building" }],
      [{ ...indexes[0], name: "private_content" }],
      [{
        ordinal: 2,
        name: "chunk_content",
        table: "chunk",
        field: "content",
        analyzer: "archive_mixed",
        state: "ready",
      }],
    ]) {
      expect(() => parseRestoreTargetEvidence({
        ...isolatedTargetEvidence(),
        fulltextIndexes: invalid,
      })).toThrow(/exact search_document_content ready index/);
    }
  });

  test("rejects missing, duplicate, wrong or non-ready builder diagnostics", () => {
    const ready = [
      {
        ordinal: 1,
        name: "search_document_content",
        table: "search_document",
        state: "ready",
        category: "ready",
        status: "ready",
        polls: 1,
        elapsedMs: 1,
        indexElapsedMs: 1,
      },
    ] as const;
    expect(validateRestoreFulltextIndexReadiness(ready).map((item) => item.name)).toEqual([
      "search_document_content",
    ]);
    for (const invalid of [
      [],
      [ready[0], ready[0]],
      [{ ...ready[0], name: "wrong_content" }],
      [{ ...ready[0], state: "building", category: "progress" }],
    ]) {
      expect(() => validateRestoreFulltextIndexReadiness(invalid as never)).toThrow(
        /exactly one|missing or invalid/,
      );
    }
  });

  test("rejects incomplete target cleanup and unbounded resource claims", () => {
    expect(() => parseRestoreTargetEvidence({
      ...isolatedTargetEvidence(),
      cleanup: { containerRemoved: true, dataVolumeRemoved: false },
    })).toThrow(/cleanup is incomplete/);
    expect(() => parseRestoreTargetEvidence({
      ...isolatedTargetEvidence(),
      resourceBounds: {
        ...isolatedTargetEvidence().resourceBounds,
        memoryBytes: Number.POSITIVE_INFINITY,
      },
    })).toThrow(/bounded/);
    for (const mutation of [
      { rocksDbThreadCount: 3 },
      { rocksDbJobsCount: 8 },
      { rocksDbMaxConcurrentSubcompactions: 1 },
      { indexBuildResumeIntervalSeconds: 30 },
    ]) {
      expect(() => parseRestoreTargetEvidence({
        ...isolatedTargetEvidence(),
        resourceBounds: {
          ...isolatedTargetEvidence().resourceBounds,
          ...mutation,
        },
      })).toThrow(/exact proven RocksDB\/index profile/);
    }
  });

  test("rejects extra fields without leaking credential or private content", () => {
    const secret = "operator-password-SuperPrivateToken";
    let message = "";
    try {
      parseRestoreTargetEvidence({
        ...isolatedTargetEvidence(),
        credentials: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("exact fields");
    expect(message).not.toContain(secret);

    const nested = isolatedTargetEvidence() as unknown as Record<string, unknown>;
    expect(() => parseRestoreTargetEvidence({
      ...nested,
      cleanup: {
        ...(nested.cleanup as Record<string, unknown>),
        privatePath: secret,
      },
    })).toThrow(/exact fields/);
  });

  test("persisted success rejects missing or malformed target evidence", () => {
    const root = path.resolve("/tmp/baka-restore-contract-target");
    const missing = persistedRestoreReport(root);
    delete missing.target;
    expect(() => parsePersistedRestoreTestReport(missing)).toThrow(/exact fields/);

    expect(() => parsePersistedRestoreTestReport(persistedRestoreReport(root, {
      target: {
        ...isolatedTargetEvidence(),
        cleanup: { containerRemoved: false, dataVolumeRemoved: true },
      },
    }))).toThrow(/cleanup is incomplete/);

    expect(() => parsePersistedRestoreTestReport(persistedRestoreReport(root, {
      target: {
        ...isolatedTargetEvidence(),
        resourceBounds: {
          ...isolatedTargetEvidence().resourceBounds,
          memoryBytes: 2 * 1024 ** 3,
          memorySwapBytes: 2 * 1024 ** 3,
          nanoCpus: 500_000_000,
          rocksDbBlockCacheBytes: 16 * 1024 ** 2,
        },
      },
    }))).toThrow(/exact bounded approved isolated profile/);
  });

  test("run fails before file/DB access when static target evidence is missing or malformed", async () => {
    const missing = await failureOf(runRestoreTest(config("/private/not-read")));
    expect(missing.report.failure).toEqual({
      stage: "input_validation",
      code: "target_evidence_required",
    });
    expect(missing.report.cleanupFailures).toEqual([]);

    const secret = "SuperPrivateCredentialValue";
    const malformed = await failureOf(runRestoreTest(config("/private/not-read"), {
      targetEvidence: {
        ...isolatedTargetEvidence(),
        credentials: secret,
      } as never,
    }));
    expect(malformed.report.failure).toEqual({
      stage: "input_validation",
      code: "target_evidence_invalid",
    });
    expect(JSON.stringify(malformed.report)).not.toContain(secret);
  });
});

describe("restore failure evidence", () => {
  for (const schemaVersion of [4, 5] as const) {
    test(`schema ${schemaVersion} without rawManifestSha256 fails durably before DB access`, async () => {
      await withTempDir(async (directory) => {
        const exportPath = path.join(directory, "backups", "surreal", "missing-raw.surql.gz");
        await mkdir(path.dirname(exportPath), { recursive: true });
        await writeFile(exportPath, "not imported");
        await writeManifest(directory, exportPath, {
          schemaVersion,
          rawManifestSha256: undefined,
        });

        const error = await failureOf(runRestoreTest(config(directory), {
          exportPath,
          targetEvidence: isolatedTargetEvidence(),
        }));
        expect(error.report.failure).toEqual({
          stage: "manifest_validation",
          code: "raw_manifest_hash_required",
        });
        expect(error.report.cleanupFailures).toEqual([]);
      });
    });
  }

  for (const schemaVersion of [4, 5] as const) {
    test(`schema ${schemaVersion} manifest filename/exportFile binding fails before DB access`, async () => {
      await withTempDir(async (directory) => {
        const exportPath = path.join(directory, "backups", "surreal", "selected.surql.gz");
        await mkdir(path.dirname(exportPath), { recursive: true });
        await writeFile(exportPath, "anonymized export");
        await writeManifest(directory, exportPath, {
          schemaVersion,
          exportFile: "different.surql.gz",
        });

        const error = await failureOf(runRestoreTest(config(directory), {
          exportPath,
          targetEvidence: isolatedTargetEvidence(),
        }));
        expect(error.report.failure).toEqual({
          stage: "manifest_validation",
          code: "manifest_export_binding_failed",
        });
        expect(error.report.cleanupFailures).toEqual([]);
      });
    });
  }

  test("schema 4 exportBytes mismatch fails before namespace creation/import", async () => {
    await withTempDir(async (directory) => {
      const exportPath = path.join(directory, "backups", "surreal", "wrong-size.surql.gz");
      await mkdir(path.dirname(exportPath), { recursive: true });
      await writeFile(exportPath, "anonymized export");
      const hashes = await hashFile(exportPath);
      await writeManifest(directory, exportPath, {
        schemaVersion: 4,
        exportBytes: hashes.sizeBytes + 1,
      });

      const error = await failureOf(runRestoreTest(config(directory), {
        exportPath,
        targetEvidence: isolatedTargetEvidence(),
      }));
      expect(error.report.failure).toEqual({
        stage: "export_integrity",
        code: "export_size_mismatch",
      });
      expect(error.report.cleanupFailures).toEqual([]);
    });
  });

  test("pre-import checksum failure returns privacy-safe artifact evidence", async () => {
    await withTempDir(async (directory) => {
      const exportPath = path.join(directory, "backups", "surreal", "private-name.surql.gz");
      await mkdir(path.dirname(exportPath), { recursive: true });
      await writeFile(exportPath, "private payload must not enter evidence");
      await writeManifest(directory, exportPath, { exportSha256: "a".repeat(64) });

      const error = await failureOf(runRestoreTest(config(directory), {
        exportPath,
        targetEvidence: isolatedTargetEvidence(),
      }));
      expect(error.report.failure).toEqual({
        stage: "export_integrity",
        code: "export_sha256_mismatch",
      });
      const serialized = JSON.stringify(error.report);
      expect(serialized).not.toContain(directory);
      expect(serialized).not.toContain("private payload must not enter evidence");
      expect(error.cause).toBeDefined();
    });
  });

  test("import failure is structured and cleanup targets only the attempt namespace", async () => {
    await withTempDir(async (directory) => {
      const plain = path.join(directory, "plain.surql");
      const exportPath = path.join(directory, "backups", "surreal", "import-failure.surql.gz");
      await mkdir(path.dirname(exportPath), { recursive: true });
      await writeFile(plain, "OPTION IMPORT;\nDEFINE TABLE test SCHEMALESS;\n");
      await compressFile(plain, exportPath, "gzip");
      await writeManifest(directory, exportPath);

      const removed: string[] = [];
      let connectCalls = 0;
      const error = await failureOf(runRestoreTest(
        config(directory),
        { exportPath, targetEvidence: isolatedTargetEvidence() },
        {
          removeNamespace: async (_cfg, namespace) => {
            removed.push(namespace);
            if (removed.length === 2) throw new Error("private cleanup failure");
          },
          uploadFile: async () => {
            throw new StreamHttpUploadError({
              category: "http_server_error",
              bytesSent: 17,
              statusCode: 500,
              responseBodyBytes: 23,
              responseBodySha256: "d".repeat(64),
              responseBodyTruncated: false,
            }, "restore import");
          },
          connectDb: async () => {
            connectCalls += 1;
            throw new Error("unreachable");
          },
        },
      ));

      expect(error.report.failure).toEqual({ stage: "import", code: "import_failed" });
      expect(error.report.schemaVersion).toBe(5);
      expect(error.report.importTransport).toEqual({
        category: "http_server_error",
        bytesSent: 17,
        statusCode: 500,
        responseBodyBytes: 23,
        responseBodySha256: "d".repeat(64),
        responseBodyTruncated: false,
      });
      expect(connectCalls).toBe(0);
      expect(removed).toEqual([error.report.namespace, error.report.namespace]);
      expect(removed.every(isRestoreNamespace)).toBe(true);
      expect(error.report.cleanupFailures).toEqual(["namespace_remove"]);
      expect(JSON.stringify(error.report)).not.toContain("private cleanup failure");
    });
  });

  test("connect failure is structured after a successful authenticated import", async () => {
    await withTempDir(async (directory) => {
      const plain = path.join(directory, "plain.surql");
      const exportPath = path.join(directory, "backups", "surreal", "connect-failure.surql.gz");
      await mkdir(path.dirname(exportPath), { recursive: true });
      await writeFile(plain, "OPTION IMPORT;\nDEFINE TABLE test SCHEMALESS;\n");
      await compressFile(plain, exportPath, "gzip");
      await writeManifest(directory, exportPath);

      const error = await failureOf(runRestoreTest(
        config(directory),
        { exportPath, targetEvidence: isolatedTargetEvidence() },
        {
          removeNamespace: async () => {},
          uploadFile: async () => ({
            bytesSent: 0,
            statusCode: 200,
          }),
          connectDb: async () => {
            throw new Error("private connection details");
          },
        },
      ));

      expect(error.report.failure).toEqual({ stage: "connect", code: "connect_failed" });
      expect(error.report.cleanupFailures).toEqual([]);
      expect(JSON.stringify(error.report)).not.toContain("private connection details");
    });
  });
});

describe("authenticated standalone search probes", () => {
  test("a restored token must produce a nonzero hit and terms are never reported", async () => {
    const privateContent = "SuperPrivateToken alpha beta";
    const boundTerms: unknown[] = [];
    const sourceQueries: string[] = [];
    const db = {
      query: async (sql: string, vars?: Record<string, unknown>) => {
        if (sql.startsWith("SELECT id, content FROM search_document")) {
          sourceQueries.push(sql);
          return [[{ id: "search_document:one", content: privateContent }]];
        }
        if (sql.includes("content @0@")) {
          boundTerms.push(vars?.q);
          return [[{ n: 0 }]];
        }
        throw new Error("unexpected query");
      },
    } as unknown as Surreal;

    const checks = await verifyRestoredSearch(db, 1);
    expect(sourceQueries).toEqual([
      "SELECT id, content FROM search_document ORDER BY id LIMIT 32",
    ]);
    expect(boundTerms.length).toBe(3);
    expect(checks.find((check) => check.name === "search probes")?.ok).toBe(false);
    expect(checks.filter((check) => check.name.startsWith("search: "))
      .every((check) => !check.ok)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain(privateContent);
    expect(JSON.stringify(checks)).not.toContain("superprivatetoken");
  });

  test("source query failure is not reported as a zero-hit BM25 result", async () => {
    const privateFailure = "private ordered query diagnostic";
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql === "SELECT id, content FROM search_document ORDER BY id LIMIT 32") {
          throw new Error(privateFailure);
        }
        if (sql.includes("content @0@")) return [[{ n: 0 }]];
        throw new Error("unexpected query");
      },
    } as unknown as Surreal;

    const checks = await verifyRestoredSearch(db, 1);
    expect(queries).toEqual([
      "SELECT id, content FROM search_document ORDER BY id LIMIT 32",
    ]);
    expect(checks).toEqual([{
      name: "search probes",
      ok: false,
      detail: "probe source query failed",
    }]);
    expect(checks.some((check) => check.name.startsWith("search: probe_"))).toBe(false);
    expect(JSON.stringify(checks)).not.toContain(privateFailure);
    expect(JSON.stringify(checks)).not.toContain("restored 0");
  });

});
