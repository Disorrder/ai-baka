import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { AppConfig } from "../src/config.ts";
import type { BackupResult } from "../src/backup/backup.ts";
import { runLogicalBackup } from "../src/backup/backup.ts";
import { connectDb } from "../src/db/client.ts";
import { applyMigrations } from "../src/db/migrations.ts";
import type { MigrationRunReport } from "../src/migration/reconciliation.ts";
import {
  canonicalMigrationJson,
  migrationApprovalKeyFingerprint,
  migrationArtifactSha256,
  type LegacyHostMappingApproval,
} from "../src/migration/authorization.ts";
import { LEGACY_TABLES } from "../src/migration/legacy-reader.ts";
import {
  createRestoreNamespace,
  expectedSuccessfulRestoreCheckNames,
  REQUIRED_RESTORE_CHECK_NAMES,
  runRestoreTest,
  type RestoreTestFailureEvidence,
  type RestoreTestReport,
} from "../src/backup/restore-test.ts";
import { isolatedRestoreTargetEvidence } from "./restore-target-fixture.ts";
import {
  DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE,
  IsolatedTargetLifecycleError,
  withIsolatedSurrealTarget,
  type IsolatedSurrealTarget,
  type IsolatedTargetEvidence,
} from "../src/backup/isolated-target.ts";
import {
  EXACT_TOKENIZER_SCRIPT,
  MAX_EVALUATION_CANDIDATE_DOCUMENTS,
  MAX_EVALUATION_JOBS_PER_SPACE,
  assertBoundedPaidEmbeddingOptions,
  assertDoctorCliSafety,
  assertGenericEmbeddingRunDisabled,
  assertMigrationApply,
  assertMigrationProductionOutcome,
  boundedCandidateOptions,
  formatHit,
  formatProductionBackfillPlan,
  formatRecoveryRebuildSuccess,
  normalizedEmbeddingPrivacy,
  parseCsv,
  parseEvaluationExclusions,
  parseNonNegativeNumber,
  parseNonNegativeInteger,
  parseParserVersion,
  parsePositiveInteger,
  pinCliExpectedJudgmentArtifact,
  parseApprovedHostMappings,
  parseReparseSelection,
  persistRestoreTestReport,
  persistRestoreTestFailureReport,
  persistIsolatedRestoreTargetFailureReport,
  program,
  RESTORE_GRACEFUL_SIGNALS,
  RestoreSignalTerminationError,
  requireEmbeddingPrice,
  runMigrationAfterBackupGate,
  runMigrationPreBackupGate,
  loadStrictMigrationCliArtifacts,
  migrationSafetyContextFromConfig,
  runConfiguredMigrationSafetyCliGate,
  runStrictMigrationCliArtifactGate,
  withRestoreTestSignalHandlers,
  withProductionMaintenanceForIsolatedRestore,
  restoreTargetEvidenceFromIsolated,
  isolatedRestoreConfig,
  runManagedIsolatedRestoreTest,
  runMaintenanceProcess,
  isolatedTargetFailureEvidence,
  ProductionMaintenanceError,
  validateProductionContainer,
  MigrationSafetyGateError,
  type ManagedRestoreTestDependencies,
  type MaintenanceProcessRuntime,
  type ProductionContainerInspection,
  type ProductionCorpusBaseline,
  type ProductionMaintenanceDependencies,
  type RestoreGracefulSignal,
  type RestoreSignalRuntime,
  type MigrationSafetyStage,
} from "../src/cli.ts";

const RESTORE_TEST_ATTEMPT_UUID = "11111111-1111-4111-8111-111111111111";
const RESTORE_TEST_ATTEMPT_ID = RESTORE_TEST_ATTEMPT_UUID.replaceAll("-", "");
const RESTORE_TEST_NAMESPACE = createRestoreNamespace(
  RESTORE_TEST_ATTEMPT_UUID,
);
const isolatedRoundtripTest = process.env.BAKA_RUN_ISOLATED_RESTORE_INTEGRATION === "1"
  ? test
  : test.skip;

function exactRestoreReport(input: {
  archiveRoot: string;
  database?: string;
  exportFile: string;
  exportBytes: number;
  exportSha256: string;
  manifestFile: string;
  manifestSha256: string;
  rawManifestSha256?: string;
  schemaVersion?: 1;
  startedAt?: string;
  finishedAt?: string;
}): RestoreTestReport {
  const schemaVersion = input.schemaVersion ?? 1;
  const checks = expectedSuccessfulRestoreCheckNames(0, 0, schemaVersion).map((name) => ({
    name,
    ok: true as const,
    detail: "verified",
  }));
  return {
    formatVersion: 5,
    ok: true,
    attemptId: RESTORE_TEST_ATTEMPT_ID,
    startedAt: input.startedAt ?? "2026-07-26T11:30:00.000Z",
    finishedAt: input.finishedAt ?? "2026-07-26T11:59:00.000Z",
    database: input.database ?? "baka",
    archiveRoot: input.archiveRoot,
    rawArchiveRoot: input.archiveRoot,
    exportPath: path.join(input.archiveRoot, "backups", "surreal", input.exportFile),
    exportFile: input.exportFile,
    exportBytes: input.exportBytes,
    exportSha256: input.exportSha256,
    manifestPath: path.join(input.archiveRoot, "backups", "manifests", input.manifestFile),
    manifestFile: input.manifestFile,
    manifestSha256: input.manifestSha256,
    rawManifestSha256: input.rawManifestSha256 ?? "c".repeat(64),
    schemaVersion,
    searchDocuments: 0,
    chunks: 0,
    namespace: RESTORE_TEST_NAMESPACE,
    checks,
    target: isolatedRestoreTargetEvidence(),
    cleanup: {
      databaseClosed: true,
      temporaryExportRemoved: true,
      namespaceRemoved: true,
    },
  };
}

function command(parent: Command, name: string): Command {
  const found = parent.commands.find((item) => item.name() === name);
  if (!found) throw new Error(`command not found: ${name}`);
  return found;
}

function flags(item: Command): string[] {
  return item.options.map((option) => option.long ?? option.short).filter(Boolean) as string[];
}

const PINNED_SURREAL_IMAGE_ID =
  "sha256:51baed8709f57f67dcf04b30e3177db846803fa9342dae2be58c6fa5f8d59843";
const PINNED_SURREAL_IMAGE = `surrealdb/surrealdb:v3.2.4@${PINNED_SURREAL_IMAGE_ID}`;

function productionMaintenanceConfig(archiveRoot = "/safe/archive"): AppConfig {
  return {
    archiveRoot,
    dbRoot: "/safe/internal/rocksdb",
    surrealUrl: "ws://127.0.0.1:8901/rpc",
    surrealUser: "root",
    surrealPass: "private-password",
    surrealNamespace: "baka",
    surrealDatabase: "archive",
    minFreeBytes: 1,
    deletionConfirmations: 2,
    sourceOverrides: {},
    embeddings: {
      excludeHarnesses: [],
      excludeWorkspaces: [],
      excludeDocumentTypes: [],
    },
  };
}

function productionInspection(
  cfg: AppConfig,
  running = true,
): ProductionContainerInspection {
  return {
    id: "a".repeat(64),
    name: "/baka-surrealdb",
    imageId: PINNED_SURREAL_IMAGE_ID,
    configImage: PINNED_SURREAL_IMAGE,
    restartPolicy: "unless-stopped",
    mounts: [
      {
        Type: "bind",
        Source: cfg.dbRoot,
        Destination: "/data/db",
        RW: true,
      },
      {
        Type: "volume",
        Name: "b".repeat(64),
        Driver: "local",
        Source: `/var/lib/docker/volumes/${"b".repeat(64)}/_data`,
        Destination: "/data",
        RW: true,
      },
      {
        Type: "volume",
        Name: "c".repeat(64),
        Driver: "local",
        Source: `/var/lib/docker/volumes/${"c".repeat(64)}/_data`,
        Destination: "/logs",
        RW: true,
      },
    ],
    portBindings: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }] },
    state: { Running: running, Health: { Status: running ? "healthy" : "unhealthy" } },
  };
}

function productionBaseline(hash = "b".repeat(64)): ProductionCorpusBaseline {
  return {
    schemaVersion: 1,
    dialogueCount: 12,
    currentRevisionCount: 11,
    currentRevisionSha256: hash,
  };
}

function isolatedLifecycleEvidence(): IsolatedTargetEvidence {
  const token = "1".repeat(32);
  return {
    formatVersion: 2,
    image: PINNED_SURREAL_IMAGE,
    version: "3.2.4",
    runtimeVersion: "3.2.4 for linux on aarch64",
    identity: {
      attemptToken: token,
      containerName: `baka-restore-target-${token}`,
      volumeName: `baka-restore-target-data-${token}`,
    },
    hostAddress: "127.0.0.1",
    hostPort: 49152,
    containerPort: 8000,
    storage: { type: "volume", source: `baka-restore-target-data-${token}`, target: "/data" },
    resources: { ...DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE },
    pinnedIndexingBehavior: {
      probeRecords: 16,
      targetBytes: 8_388_608,
      maxRecords: 250,
    },
    containerUser: "0:0",
    restartPolicy: "no",
    indexBuildResumeInterval: "0",
    startedAt: "2026-07-27T12:00:00.000Z",
    readyAt: "2026-07-27T12:00:01.000Z",
    finishedAt: "2026-07-27T12:10:00.000Z",
    observation: { statsSamples: 2, peakMemoryBytes: 1024, oomKilled: false, exitCode: 0 },
    cleanup: { containerRemoved: true, volumeRemoved: true, timedOut: false, failures: [] },
  };
}

function optionDescription(item: Command, long: string): string {
  const option = item.options.find((candidate) => candidate.long === long);
  if (!option) throw new Error(`option not found: ${long}`);
  return option.description;
}

describe("CLI safe parsers", () => {
  test("positive integers reject floats, zero, negative and unsafe values", () => {
    expect(parsePositiveInteger("12", "--n")).toBe(12);
    for (const value of ["0", "-1", "1.5", "1x", "9007199254740992"]) {
      expect(() => parsePositiveInteger(value, "--n")).toThrow(/--n/);
    }
  });

  test("non-negative configured number and CSV parsing are explicit", () => {
    expect(parseNonNegativeNumber("0.13", "price")).toBe(0.13);
    expect(() => parseNonNegativeNumber("-0.1", "price")).toThrow(/price/);
    expect(parseCsv("text, vector,text", "--modes")).toEqual(["text", "vector"]);
    expect(() => parseCsv(" , ", "--modes")).toThrow(/список пуст/);
    expect(requireEmbeddingPrice(0)).toBe(0);
    expect(() => requireEmbeddingPrice(undefined)).toThrow(/OPENAI_EMBEDDING_PRICE/);
    expect(parseNonNegativeInteger("0", "--count")).toBe(0);
    expect(parseNonNegativeInteger("42", "--count")).toBe(42);
    for (const value of ["-1", "1.5", "1x", "9007199254740992"]) {
      expect(() => parseNonNegativeInteger(value, "--count")).toThrow(/--count/);
    }
  });

  test("parser version accepts only latest or a positive integer", () => {
    expect(parseParserVersion("latest")).toBe("latest");
    expect(parseParserVersion("2")).toBe(2);
    expect(() => parseParserVersion("current")).toThrow(/parser-version/);
  });

  test("reparse requires exactly one selector", () => {
    expect(parseReparseSelection({ sourceRevision: "source_revision:one" })).toEqual({
      sourceRevisions: ["source_revision:one"],
    });
    expect(parseReparseSelection({
      sourceRevision: ["source_revision:one", "source_revision:two", "source_revision:one"],
    })).toEqual({
      sourceRevisions: ["source_revision:one", "source_revision:two"],
    });
    expect(parseReparseSelection({ all: true })).toEqual({ all: true });
    expect(() => parseReparseSelection({})).toThrow(/ровно один selector/);
    expect(() => parseReparseSelection({ all: true, harness: "codex" })).toThrow(
      /ровно один selector/,
    );
    expect(() => parseReparseSelection({ sourceRevision: " " })).toThrow(/не может быть пустым/);
    expect(() => parseReparseSelection({ harness: "invalid" })).toThrow(/неизвестный harness/);
  });

  test("doctor destructive gate fails before action setup", () => {
    expect(() => assertDoctorCliSafety({ apply: true, removeStaleStaging: true }))
      .toThrow(/allow-destructive/);
    expect(() => assertDoctorCliSafety({ apply: true, rebuildSearchProjection: true }))
      .toThrow(/allow-destructive/);
    expect(() => assertDoctorCliSafety({ apply: true, repairManifest: true }))
      .toThrow(/allow-destructive/);
    expect(() => assertDoctorCliSafety({
      apply: true,
      repairManifest: true,
      allowDestructive: true,
    })).not.toThrow();
    expect(() => assertDoctorCliSafety({ repairManifest: true })).not.toThrow();
  });

  test("migration requires apply and strict operator-approved host mappings", () => {
    expect(() => assertMigrationApply({})).toThrow(/--apply/);
    expect(() => assertMigrationApply({ apply: true })).not.toThrow();
    const parsed = parseApprovedHostMappings([{
      mappingId: "current-mac",
      host: {
        hostUuid: "host-test",
        hostname: "mac.test",
        platform: "darwin",
        arch: "arm64",
        osUsername: "example",
        homePath: "/Users/example",
      },
      sourceFileIds: [1, "2"],
      pathPrefixes: ["/Users/example/.codex"],
    }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.mappingId).toBe("current-mac");
    expect(() => parseApprovedHostMappings([])).toThrow(/непустой JSON array/);
    expect(() => parseApprovedHostMappings([{
      mappingId: "bad",
      host: parsed[0]!.host,
      pathPrefixes: ["relative/path"],
    }])).toThrow(/абсолютный/);
    expect(() => parseApprovedHostMappings([{
      mappingId: "bad",
      host: parsed[0]!.host,
      typoSelector: [1],
    }])).toThrow(/неизвестные поля/);
  });

  test("migration safety source environment is derived only from current config", () => {
    expect(migrationSafetyContextFromConfig({
      surrealNamespace: "current_ns",
      surrealDatabase: "current_db",
      archiveRoot: "/private/archive/../archive",
    }, 1, RESTORE_TEST_NAMESPACE)).toEqual({
      schemaVersion: 1,
      sourceNamespace: "current_ns",
      sourceDatabase: "current_db",
      restoreNamespace: RESTORE_TEST_NAMESPACE,
      archiveRoot: "/private/archive",
    });
  });

  test("configured migration safety rejects fully rehashed foreign source before writer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-cli-source-env-"));
    const archiveRoot = path.join(root, "archive");
    const surrealDir = path.join(archiveRoot, "backups", "surreal");
    const manifestDir = path.join(archiveRoot, "backups", "manifests");
    await mkdir(surrealDir, { recursive: true });
    await mkdir(manifestDir, { recursive: true });
    const exportFile = "source-env.surql.gz";
    const exportPath = path.join(surrealDir, exportFile);
    const manifestPath = path.join(manifestDir, "source-env.json");
    const restorePath = path.join(manifestDir, "restore-source-env.json");
    const exportBytes = Buffer.from("authenticated logical export\n");
    const exportSha256 = createHash("sha256").update(exportBytes).digest("hex");
    await writeFile(exportPath, exportBytes);
    const writeEvidence = async (sourceNamespace: string, sourceDatabase: string) => {
      const manifest = {
        createdAt: "2026-07-26T10:00:00.000Z",
        surrealdbVersion: "surrealdb-3.2.3",
        schemaVersion: 1,
        bakaCommit: "test",
        namespace: sourceNamespace,
        database: sourceDatabase,
        recordCounts: {},
        rawManifestSha256: "d".repeat(64),
        exportFile,
        compression: "gzip",
        exportBytes: exportBytes.byteLength,
        exportSha256,
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      await writeFile(manifestPath, manifestBytes);
      const report = {
        ...exactRestoreReport({
          archiveRoot,
          database: sourceDatabase,
          exportFile,
          exportBytes: exportBytes.byteLength,
          exportSha256,
          manifestFile: "source-env.json",
          manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
          rawManifestSha256: "d".repeat(64),
          startedAt: "2026-07-26T11:00:00.000Z",
          finishedAt: "2026-07-26T11:01:00.000Z",
        }),
        runId: "source-env-fixture",
        createdAt: "2026-07-26T11:02:00.000Z",
      };
      await writeFile(restorePath, `${JSON.stringify(report)}\n`);
      return report;
    };
    const cfg = {
      surrealNamespace: "current_ns",
      surrealDatabase: "current_db",
      archiveRoot,
    };
    let writerInvocations = 0;
    const writer = async () => {
      writerInvocations += 1;
      return true;
    };
    try {
      const valid = await writeEvidence("current_ns", "current_db");
      await expect(runConfiguredMigrationSafetyCliGate({
        cfg,
        schemaVersion: 1,
        restoreReport: valid,
        restoreReportPath: restorePath,
      }, writer)).resolves.toBe(true);
      expect(writerInvocations).toBe(1);

      for (const [namespace, database] of [
        ["other_ns", "current_db"],
        ["current_ns", "other_db"],
      ] as const) {
        const foreign = await writeEvidence(namespace, database);
        await expect(runConfiguredMigrationSafetyCliGate({
          cfg,
          schemaVersion: 1,
          restoreReport: foreign,
          restoreReportPath: restorePath,
        }, writer)).rejects.toThrow(/source namespace\/database|current schema\/database/);
        expect(writerInvocations).toBe(1);
      }

      const current = await writeEvidence("current_ns", "current_db");
      await expect(runConfiguredMigrationSafetyCliGate({
        cfg: { ...cfg, surrealNamespace: "wrong_cfg" },
        schemaVersion: 1,
        restoreReport: current,
        restoreReportPath: restorePath,
      }, writer)).rejects.toThrow("source namespace/database runtime binding mismatch");
      expect(writerInvocations).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  test("full-corpus accept pins reviewed judgments before DB/complete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-cli-judgment-pin-"));
    try {
      const reviewed = path.join(root, "judgments.json");
      const bytes = Buffer.from('{"reviewed":true}\n');
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(reviewed, bytes, { mode: 0o600 });
      await expect(pinCliExpectedJudgmentArtifact({
        judgments: reviewed,
        judgmentsSha256: sha256,
        judgmentsSizeBytes: bytes.byteLength,
      })).resolves.toMatchObject({
        resolvedPath: reviewed,
        sha256,
        sizeBytes: bytes.byteLength,
      });
      await expect(pinCliExpectedJudgmentArtifact({
        judgments: reviewed,
        judgmentsSha256: "f".repeat(64),
        judgmentsSizeBytes: bytes.byteLength,
      })).rejects.toThrow(/identity mismatch/);
      await expect(pinCliExpectedJudgmentArtifact({
        judgments: reviewed,
        judgmentsSha256: sha256,
        judgmentsSizeBytes: bytes.byteLength + 1,
      })).rejects.toThrow(/size mismatch/);
      await expect(pinCliExpectedJudgmentArtifact({
        judgments: path.join(root, "missing.json"),
        judgmentsSha256: sha256,
        judgmentsSizeBytes: bytes.byteLength,
      })).rejects.toThrow(/path_error/);

      const link = path.join(root, "judgments-link.json");
      await symlink(reviewed, link);
      await expect(pinCliExpectedJudgmentArtifact({
        judgments: link,
        judgmentsSha256: sha256,
        judgmentsSizeBytes: bytes.byteLength,
      })).rejects.toThrow(/stable_open/);

      await writeFile(reviewed, Buffer.from('{"reviewed":fals}\n'));
      await expect(pinCliExpectedJudgmentArtifact({
        judgments: reviewed,
        judgmentsSha256: sha256,
        judgmentsSizeBytes: bytes.byteLength,
      })).rejects.toThrow(/identity mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("generic paid worker never reaches a provider and candidate bounds fail closed", () => {
    let providerInvoked = false;
    const invokeGeneric = (options: { allowPaidApi?: boolean; space?: string; limit?: number }) => {
      assertGenericEmbeddingRunDisabled(options);
      providerInvoked = true;
    };
    expect(() => invokeGeneric({ space: "candidate", limit: 1 })).toThrow(/allow-paid-api/);
    expect(() => invokeGeneric({ allowPaidApi: true, space: "candidate", limit: 0 }))
      .toThrow(/положительный/);
    expect(() => invokeGeneric({
      allowPaidApi: true,
      space: "candidate",
      limit: 1,
    })).toThrow(/Stage 11 authorization/);
    expect(providerInvoked).toBe(false);
    expect(() => assertBoundedPaidEmbeddingOptions({
      allowPaidApi: true,
      space: "candidate",
      limit: Number.MAX_SAFE_INTEGER,
    })).toThrow(/--limit/);

    const judgmentSet = {
      formatVersion: 1 as const,
      name: "private",
      queries: [{
        id: "q1",
        query: "private query",
        expectedDialogues: [{ dialogueId: "dialogue:one", relevance: 1 }],
        expectedSnippets: [],
        mustNotMatchExamples: [],
        queryLanguage: "ru",
        queryType: "exact_fact",
      }],
    };
    const base = {
      privacy: {
        excludeHarnesses: [],
        excludeWorkspaces: [],
        excludeDocumentTypes: [],
      },
      spaces: ["small", "large-1024", "large-3072"],
      maxDocuments: 10,
      maxJobsPerSpace: 2,
      selectionSeedSha256: "a".repeat(64),
      judgmentSet,
    };
    expect(boundedCandidateOptions(base).requiredDialogueIds).toEqual(["dialogue:one"]);
    expect(() => boundedCandidateOptions({
      ...base,
      maxDocuments: MAX_EVALUATION_CANDIDATE_DOCUMENTS + 1,
    })).toThrow(/max-documents/);
    expect(() => boundedCandidateOptions({
      ...base,
      maxJobsPerSpace: MAX_EVALUATION_JOBS_PER_SPACE + 1,
      maxDocuments: MAX_EVALUATION_JOBS_PER_SPACE + 1,
    })).toThrow(/max-jobs-per-space/);
  });

  test("documented exclusions require exact row identities and stable category codes", () => {
    const valid = {
      selected_space: [{
        category: "privacy" as const,
        code: "privacy_excluded_document_type",
        jobId: "embedding_job:job_one",
        documentId: "search_document:doc_one",
        evidence: "privacy-policy-ticket-1",
      }, {
        category: "permanent" as const,
        code: "provider_permanent_error",
        jobId: "embedding_job:job_two",
        documentId: "search_document:doc_two",
        evidence: "provider-incident-2",
      }],
    };
    expect(parseEvaluationExclusions(valid)).toEqual(valid);
    expect(normalizedEmbeddingPrivacy({
      excludeHarnesses: ["kimi-code", "codex"],
      excludeWorkspaces: ["z", "a"],
      excludeDocumentTypes: ["tool", "system"],
      maxDocumentBytes: 42,
      pricePer1MTokens: 9,
    })).toEqual({
      excludeHarnesses: ["codex", "kimi-code"],
      excludeWorkspaces: ["a", "z"],
      excludeDocumentTypes: ["system", "tool"],
      maxDocumentBytes: 42,
    });

    const first = valid.selected_space[0]!;
    for (const invalid of [
      { selected_space: [{ ...first, count: 1 }] },
      { selected_space: [{ ...first, evidence: "" }] },
      { selected_space: [{ ...first, code: "provider_permanent_error" }] },
      { selected_space: [{ ...first, jobId: "all-jobs" }] },
      { selected_space: [{ ...first, documentId: "all-documents" }] },
      { selected_space: [first, { ...first, evidence: "duplicate" }] },
    ]) expect(() => parseEvaluationExclusions(invalid)).toThrow(/documented-exclusions/);
  });
});

function fakeRestoreSignalRuntime() {
  const listeners = Object.fromEntries(
    RESTORE_GRACEFUL_SIGNALS.map((signal) => [signal, new Set<() => void>()]),
  ) as Record<RestoreGracefulSignal, Set<() => void>>;
  const terminated: RestoreGracefulSignal[] = [];
  const runtime: RestoreSignalRuntime = {
    on: (signal, listener) => listeners[signal].add(listener),
    off: (signal, listener) => listeners[signal].delete(listener),
    terminate: async (signal) => {
      terminated.push(signal);
    },
  };
  return {
    listeners,
    terminated,
    runtime,
    emit: (signal: RestoreGracefulSignal) => {
      for (const listener of [...listeners[signal]]) listener();
    },
  };
}

describe("restore:test scoped graceful signals", () => {
  test("removes only scoped handlers and never installs a SIGKILL handler", async () => {
    const fake = fakeRestoreSignalRuntime();
    const prior = () => {};
    fake.listeners.SIGHUP.add(prior);

    const result = await withRestoreTestSignalHandlers(async (signal) => {
      expect(signal.aborted).toBe(false);
      expect(fake.listeners.SIGINT.size).toBe(1);
      expect(fake.listeners.SIGTERM.size).toBe(1);
      expect(fake.listeners.SIGHUP.size).toBe(2);
      return 42;
    }, fake.runtime);

    expect(result).toBe(42);
    expect(fake.listeners.SIGINT.size).toBe(0);
    expect(fake.listeners.SIGTERM.size).toBe(0);
    expect([...fake.listeners.SIGHUP]).toEqual([prior]);
    expect(fake.terminated).toEqual([]);
    expect(RESTORE_GRACEFUL_SIGNALS).not.toContain("SIGKILL" as RestoreGracefulSignal);
  });

  test("repeated signals abort and terminate once after operation cleanup", async () => {
    const fake = fakeRestoreSignalRuntime();
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let cleanupCalls = 0;
    let abortEvents = 0;
    const operation = withRestoreTestSignalHandlers(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          abortEvents += 1;
          resolve();
        }, { once: true });
      });
      cleanupCalls += 1;
      await cleanupGate;
      throw new Error("SuperPrivateToken operation failure");
    }, fake.runtime);

    fake.emit("SIGTERM");
    fake.emit("SIGINT");
    fake.emit("SIGTERM");
    await Promise.resolve();
    expect(cleanupCalls).toBe(1);
    expect(fake.terminated).toEqual([]);
    finishCleanup();

    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RestoreSignalTerminationError);
    expect((caught as RestoreSignalTerminationError).signal).toBe("SIGTERM");
    expect(abortEvents).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(fake.terminated).toEqual(["SIGTERM"]);
    expect(RESTORE_GRACEFUL_SIGNALS.every(
      (signal) => fake.listeners[signal].size === 0,
    )).toBe(true);
    expect((caught as Error).message).not.toContain("SuperPrivateToken");
  });
});

describe("managed isolated restore:test lifecycle", () => {
  test("maps lifecycle evidence to strict v5 only after cleanup and finalization", async () => {
    const cfg = productionMaintenanceConfig("/safe/archive");
    const lifecycle = isolatedLifecycleEvidence();
    const strictIndexes = isolatedRestoreTargetEvidence().fulltextIndexes;
    const trace: string[] = [];
    let finalized = false;
    const target: IsolatedSurrealTarget = {
      surrealUrl: "ws://127.0.0.1:49152/rpc",
      httpBaseUrl: "http://127.0.0.1:49152",
      hostAddress: "127.0.0.1",
      hostPort: 49152,
      containerName: lifecycle.identity.containerName,
      volumeName: lifecycle.identity.volumeName,
      finalize: async () => {
        trace.push("target-finalize");
        finalized = true;
        return lifecycle;
      },
    };
    const dependencies: ManagedRestoreTestDependencies = {
      withMaintenance: async (_cfg, operation) => {
        trace.push("production-stop");
        const value = await operation();
        trace.push("production-restart-baseline-ok");
        return value;
      },
      withTarget: async (_options, operation) => {
        trace.push("target-start");
        const value = await operation(target);
        expect(finalized).toBe(true);
        trace.push("target-outer-return");
        return { value, evidence: lifecycle };
      },
      restore: async (isolatedCfg, options, restoreDependencies) => {
        expect(isolatedCfg.surrealUrl).toBe("ws://127.0.0.1:49152/rpc");
        expect(isolatedCfg.surrealUrl).not.toContain(":8901/");
        expect(options?.targetEvidence).toBeUndefined();
        trace.push("restore");
        trace.push("index-namespace-cleanup");
        const targetEvidence = await restoreDependencies?.resolveTargetEvidence?.(undefined, {
          attemptId: RESTORE_TEST_ATTEMPT_ID,
          verificationSucceeded: true,
          restoreCleanupComplete: true,
          fulltextIndexes: strictIndexes,
        });
        expect(finalized).toBe(true);
        trace.push("restore-return");
        return {
          ...exactRestoreReport({
            archiveRoot: cfg.archiveRoot,
            exportFile: "small.surql.gz",
            exportBytes: 42,
            exportSha256: "a".repeat(64),
            manifestFile: "small.json",
            manifestSha256: "b".repeat(64),
          }),
          target: targetEvidence as RestoreTestReport["target"],
        };
      },
    };

    const report = await runManagedIsolatedRestoreTest(cfg, {}, dependencies);
    trace.push("publish-eligible");
    expect(trace).toEqual([
      "production-stop",
      "target-start",
      "restore",
      "index-namespace-cleanup",
      "target-finalize",
      "restore-return",
      "target-outer-return",
      "production-restart-baseline-ok",
      "publish-eligible",
    ]);
    expect(report.target.mode).toBe("isolated_pinned_container");
    expect(report.target.resourceBounds.nanoCpus).toBe(4_000_000_000);
    expect(report.target.resourceBounds).not.toHaveProperty("indexingBatchSize");
    expect(report.target.pinnedIndexingBehavior).toEqual({
      probeRecords: 16,
      targetBytes: 8_388_608,
      maxRecords: 250,
    });
    expect(report.target.fulltextIndexes).toEqual(strictIndexes);
    expect(JSON.stringify(report.target)).not.toContain(lifecycle.identity.containerName);
    expect(JSON.stringify(report.target)).not.toContain(lifecycle.identity.volumeName);
    expect(JSON.stringify(report.target)).not.toContain("49152");
  });

  test("strict adapter rejects pre-cleanup, production port and missing index evidence", () => {
    const lifecycle = isolatedLifecycleEvidence();
    const context = {
      attemptId: RESTORE_TEST_ATTEMPT_ID,
      verificationSucceeded: true,
      restoreCleanupComplete: true,
      fulltextIndexes: isolatedRestoreTargetEvidence().fulltextIndexes,
    };
    expect(() => restoreTargetEvidenceFromIsolated({
      ...lifecycle,
      cleanup: { ...lifecycle.cleanup, volumeRemoved: false },
    }, context)).toThrow(/incomplete/);
    expect(() => restoreTargetEvidenceFromIsolated({
      ...lifecycle,
      hostPort: 8901,
    }, context)).toThrow(/incomplete/);
    expect(() => restoreTargetEvidenceFromIsolated(lifecycle, {
      ...context,
      fulltextIndexes: [],
    })).toThrow(/exactly one|exact search_document/);
  });

  test("persists OOM and exact cleanup evidence without names, ports or credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-target-failure-"));
    const lifecycle = {
      ...isolatedLifecycleEvidence(),
      observation: { statsSamples: 3, oomKilled: true, exitCode: 137 },
    };
    const safe = isolatedTargetFailureEvidence(
      new IsolatedTargetLifecycleError("operation", "target_oom_killed", lifecycle),
    );
    expect(safe.formatVersion).toBe(2);
    expect(safe.target?.pinnedIndexingBehavior).toEqual({
      probeRecords: 16,
      targetBytes: 8_388_608,
      maxRecords: 250,
    });
    const secret = "indexing-evidence-SuperPrivateToken";
    const hostileLifecycle = {
      ...lifecycle,
      pinnedIndexingBehavior: {
        ...lifecycle.pinnedIndexingBehavior,
        privateDiagnostic: secret,
      },
    } as unknown as IsolatedTargetEvidence;
    const whitelisted = isolatedTargetFailureEvidence(
      new IsolatedTargetLifecycleError("operation", "target_oom_killed", hostileLifecycle),
    );
    expect(JSON.stringify(whitelisted)).not.toContain(secret);
    try {
      const reportPath = await persistIsolatedRestoreTargetFailureReport(root, safe, {
        now: new Date("2026-07-27T12:20:00.000Z"),
        suffix: "oom",
      });
      const serialized = await readFile(reportPath, "utf8");
      expect(JSON.parse(serialized)).toEqual(safe);
      expect(serialized).toContain('"oomKilled": true');
      expect(serialized).toContain('"containerRemoved": true');
      expect(serialized).not.toContain(lifecycle.identity.containerName);
      expect(serialized).not.toContain(lifecycle.identity.volumeName);
      expect(serialized).not.toContain("49152");
      expect(serialized).not.toContain("private-password");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("managed isolated restore:test disposable integration", () => {
  isolatedRoundtripTest("roundtrips a schema-1 logical export across two pinned disposable targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-isolated-roundtrip-"));
    const credentials = { username: "root", password: "ephemeral-test-password" };
    const baseCfg = productionMaintenanceConfig(root);
    const sourceCfg = {
      ...baseCfg,
      surrealUser: credentials.username,
      surrealPass: credentials.password,
      surrealNamespace: "baka_integration_source",
      surrealDatabase: "archive",
    };
    try {
      let sourceCallbackFailure: unknown;
      let source: Awaited<ReturnType<typeof withIsolatedSurrealTarget<BackupResult>>>;
      try {
        source = await withIsolatedSurrealTarget(
          { credentials },
          async (target) => {
            try {
              const cfg = isolatedRestoreConfig(sourceCfg, target);
              const db = await connectDb(cfg);
              try {
                await applyMigrations(db, {
                  bakaCommit: "isolated-integration",
                  surrealdbVersion: "3.2.3",
                });
              } finally {
                await db.close();
              }
              const backup = await runLogicalBackup(cfg);
              await target.finalize();
              return backup;
            } catch (error) {
              sourceCallbackFailure = error;
              throw error;
            }
          },
        );
      } catch (error) {
        throw sourceCallbackFailure ?? error;
      }

      let restoreCallbackFailure: unknown;
      let restored: Awaited<ReturnType<typeof withIsolatedSurrealTarget<RestoreTestReport>>>;
      try {
        restored = await withIsolatedSurrealTarget(
          { credentials },
          async (target) => {
            try {
              const cfg = isolatedRestoreConfig(sourceCfg, target);
              return await runRestoreTest(
                cfg,
                { exportPath: source.value.exportPath, rawArchiveRoot: root },
                {
                  resolveTargetEvidence: async (_provided, context) => {
                    const evidence = await target.finalize();
                    if (!context.verificationSucceeded || !context.restoreCleanupComplete) {
                      return undefined;
                    }
                    return restoreTargetEvidenceFromIsolated(evidence, context);
                  },
                },
              );
            } catch (error) {
              restoreCallbackFailure = error;
              throw error;
            }
          },
        );
      } catch (error) {
        throw restoreCallbackFailure ?? error;
      }

      expect(restored.value.ok).toBe(true);
      expect(restored.value.formatVersion).toBe(5);
      expect(restored.value.schemaVersion).toBe(1);
      expect(restored.value.target.fulltextIndexes.map((index) => index.name)).toEqual([
        "search_document_content",
      ]);
      expect(restored.value.target.cleanup).toEqual({
        containerRemoved: true,
        dataVolumeRemoved: true,
      });
      expect(source.evidence.cleanup.containerRemoved).toBe(true);
      expect(source.evidence.cleanup.volumeRemoved).toBe(true);
      expect(restored.evidence.cleanup.containerRemoved).toBe(true);
      expect(restored.evidence.cleanup.volumeRemoved).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("production maintenance wrapper", () => {
  test("bounded maintenance commands kill and await a hung child at the injected deadline", async () => {
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let resolveExit: ((code: number) => void) | undefined;
    let killed = false;
    let deadline: (() => void) | undefined;
    const runtime: MaintenanceProcessRuntime = {
      spawn: () => ({
        stdout: new ReadableStream({ start: (controller) => { stdoutController = controller; } }),
        stderr: new ReadableStream({ start: (controller) => { stderrController = controller; } }),
        exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
        kill: () => {
          if (killed) return;
          killed = true;
          stdoutController?.close();
          stderrController?.close();
          resolveExit?.(137);
        },
      }),
      setDeadline: (callback, milliseconds) => {
        if (milliseconds === 10_000) deadline = callback;
        return callback;
      },
      clearDeadline: () => {},
    };
    const operation = runMaintenanceProcess("docker", ["container", "inspect"], 10_000, runtime);
    await Promise.resolve();
    expect(deadline).toBeDefined();
    deadline!();
    await expect(operation).resolves.toEqual({ exitCode: 124, stdout: "" });
    expect(killed).toBe(true);
  });

  test("accepts only cfg.dbRoot plus two distinct local anonymous volumes", () => {
    const cfg = productionMaintenanceConfig("/Volumes/Archive/Conversations");
    const exact = productionInspection(cfg);
    expect(validateProductionContainer(exact, cfg, PINNED_SURREAL_IMAGE, {
      requireHealthy: true,
    })).toBe(exact);

    const unsafeMounts: ProductionContainerInspection[] = [
      {
        ...exact,
        mounts: [
          ...exact.mounts,
          { Type: "bind", Source: "/private/extra", Destination: "/extra", RW: true },
        ],
      },
      {
        ...exact,
        mounts: exact.mounts.map((mount) =>
          mount.Destination === "/data/db" ? { ...mount, Source: "/wrong/archive/db" } : mount
        ),
      },
      {
        ...exact,
        // Do not collapse a source containing a possible symlink before `..`.
        mounts: exact.mounts.map((mount) =>
          mount.Destination === "/data/db"
            ? { ...mount, Source: `${cfg.dbRoot}-link/../rocksdb` }
            : mount
        ),
      },
    ];
    for (const inspection of unsafeMounts) {
      expect(() => validateProductionContainer(inspection, cfg, PINNED_SURREAL_IMAGE, {
        requireHealthy: true,
      })).toThrow(/mount mismatch/);
    }
  });

  test("rejects reused or non-local anonymous data/log volume identities", () => {
    const cfg = productionMaintenanceConfig();
    const exact = productionInspection(cfg);
    const dataName = exact.mounts.find((mount) => mount.Destination === "/data")?.Name;
    expect(dataName).toMatch(/^[0-9a-f]{64}$/u);
    const unsafe = [
      {
        ...exact,
        mounts: exact.mounts.map((mount) =>
          mount.Destination === "/logs" ? { ...mount, Name: dataName } : mount
        ),
      },
      {
        ...exact,
        mounts: exact.mounts.map((mount) =>
          mount.Destination === "/data" ? { ...mount, Driver: "foreign" } : mount
        ),
      },
    ];
    for (const inspection of unsafe) {
      expect(() => validateProductionContainer(inspection, cfg, PINNED_SURREAL_IMAGE, {
        requireHealthy: true,
      })).toThrow(/mount mismatch/);
    }
  });

  test("binds immutable Docker image ID to the digest in the pinned reference", () => {
    const cfg = productionMaintenanceConfig();
    const exact = productionInspection(cfg);
    expect(() => validateProductionContainer({
      ...exact,
      imageId: `sha256:${"d".repeat(64)}`,
    }, cfg, PINNED_SURREAL_IMAGE, { requireHealthy: true })).toThrow(/identity mismatch/);
    expect(() => validateProductionContainer(
      exact,
      cfg,
      "surrealdb/surrealdb:v3.2.4",
      { requireHealthy: true },
    )).toThrow(/identity mismatch/);
  });

  test("rejects altered production restart policy or loopback bind", () => {
    const cfg = productionMaintenanceConfig();
    const exact = productionInspection(cfg);
    expect(() => validateProductionContainer({
      ...exact,
      restartPolicy: "always",
    }, cfg, PINNED_SURREAL_IMAGE, { requireHealthy: true })).toThrow(/identity mismatch/);

    expect(() => validateProductionContainer({
      ...exact,
      portBindings: { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "8901" }] },
    }, cfg, PINNED_SURREAL_IMAGE, { requireHealthy: true })).toThrow(/bind mismatch/);
  });

  function fakeMaintenance(
    cfg: AppConfig,
    options: { afterBaseline?: ProductionCorpusBaseline; clients?: number } = {},
  ): { dependencies: ProductionMaintenanceDependencies; trace: string[] } {
    const trace: string[] = [];
    let running = true;
    let baselineCalls = 0;
    return {
      trace,
      dependencies: {
        pinnedImage: async () => PINNED_SURREAL_IMAGE,
        inspectContainer: async () => productionInspection(cfg, running),
        archiveLocked: async () => false,
        acquireMaintenanceLock: async () => {
          trace.push("lock-acquire");
          return async () => {
            trace.push("lock-release");
          };
        },
        activeProductionClients: async () => options.clients ?? 0,
        captureBaseline: async () => {
          trace.push(baselineCalls === 0 ? "baseline-before" : "baseline-after");
          baselineCalls += 1;
          return baselineCalls === 1
            ? productionBaseline()
            : options.afterBaseline ?? productionBaseline();
        },
        stopExact: async (id) => {
          expect(id).toBe("a".repeat(64));
          trace.push("stop-exact-id");
          running = false;
        },
        startExact: async (id) => {
          expect(id).toBe("a".repeat(64));
          trace.push("start-exact-id");
          running = true;
        },
        waitUntilHealthy: async () => {
          trace.push("healthy");
          return productionInspection(cfg, true);
        },
      },
    };
  }

  test("always restarts after drill failure and releases maintenance lock after unchanged proof", async () => {
    const cfg = productionMaintenanceConfig();
    const fake = fakeMaintenance(cfg);
    await expect(withProductionMaintenanceForIsolatedRestore(
      cfg,
      async () => {
        fake.trace.push("drill");
        throw new Error("private drill failure");
      },
      fake.dependencies,
    )).rejects.toThrow("private drill failure");
    expect(fake.trace).toEqual([
      "lock-acquire",
      "baseline-before",
      "stop-exact-id",
      "drill",
      "start-exact-id",
      "healthy",
      "baseline-after",
      "lock-release",
    ]);
  });

  test("withholds success when schema/current baseline changes after restart", async () => {
    const cfg = productionMaintenanceConfig();
    const fake = fakeMaintenance(cfg, { afterBaseline: productionBaseline("c".repeat(64)) });
    const failure = withProductionMaintenanceForIsolatedRestore(
      cfg,
      async () => "would-be-success",
      fake.dependencies,
    );
    await expect(failure).rejects.toBeInstanceOf(ProductionMaintenanceError);
    await expect(failure).rejects.toThrow(/baseline\/production_baseline_changed/);
    expect(fake.trace.at(-1)).toBe("lock-release");
  });

  test("fails closed on active clients before stop and releases its own lock", async () => {
    const cfg = productionMaintenanceConfig();
    const fake = fakeMaintenance(cfg, { clients: 1 });
    await expect(withProductionMaintenanceForIsolatedRestore(
      cfg,
      async () => "unreachable",
      fake.dependencies,
    )).rejects.toThrow(/preflight\/quiescence_not_proven/);
    expect(fake.trace).toEqual(["lock-acquire", "baseline-before", "lock-release"]);
    expect(fake.trace).not.toContain("stop-exact-id");
  });

  test("restart command failures expose only a stable stage/code", async () => {
    const cfg = productionMaintenanceConfig();
    const fake = fakeMaintenance(cfg);
    fake.dependencies.startExact = async () => {
      throw new Error("SuperPrivateDockerDiagnostic");
    };
    let caught: unknown;
    try {
      await withProductionMaintenanceForIsolatedRestore(
        cfg,
        async () => "completed-drill",
        fake.dependencies,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProductionMaintenanceError);
    expect(String(caught)).toContain("restart/exact_restart_not_proven");
    expect(String(caught)).not.toContain("SuperPrivateDockerDiagnostic");
    expect(fake.trace.at(-1)).toBe("lock-release");
  });
});

describe("restore:test status artifact", () => {
  test("persists a private top-level successful report discoverable by status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-cli-restore-report-"));
    try {
      const exportContent = "surreal export\n";
      const exportSha256 = createHash("sha256").update(exportContent).digest("hex");
      const rawManifestSha256 = "e".repeat(64);
      const exportPath = path.join(root, "backups", "surreal", "backup.surql.zst");
      const manifestPath = path.join(root, "backups", "manifests", "backup.json");
      await mkdir(path.dirname(exportPath), { recursive: true });
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(exportPath, exportContent);
      const manifestJson = `${JSON.stringify({
        createdAt: "2026-07-26T11:00:00.000Z",
        surrealdbVersion: "3.2.3",
        schemaVersion: 1,
        bakaCommit: "test",
        namespace: "baka",
        database: "baka",
        recordCounts: { search_document: 0 },
        rawManifestSha256,
        exportFile: "backup.surql.zst",
        compression: "zstd",
        exportBytes: Buffer.byteLength(exportContent),
        exportSha256,
      }, null, 2)}\n`;
      await writeFile(manifestPath, manifestJson);
      const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");
      const report = exactRestoreReport({
        archiveRoot: root,
        exportFile: "backup.surql.zst",
        exportBytes: Buffer.byteLength(exportContent),
        exportSha256,
        manifestFile: "backup.json",
        manifestSha256,
        rawManifestSha256,
      });
      const result = await persistRestoreTestReport(
        root,
        report,
        {
          runId: "restore_test:one",
          now: new Date("2026-07-26T12:00:00Z"),
          suffix: "test",
        },
      );
      expect(result.reportPath).toEndWith("restore-test-2026-07-26T120000Z-test.json");
      expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
      const persisted = JSON.parse(await readFile(result.reportPath, "utf8"));
      expect(persisted).toMatchObject({
        createdAt: "2026-07-26T12:00:00.000Z",
        runId: "restore_test:one",
        ok: true,
        exportFile: "backup.surql.zst",
      });
      expect(persisted).toEqual(result.persisted);
      expect(result.persisted.checks.slice(0, REQUIRED_RESTORE_CHECK_NAMES.length).map(
        (check) => check.name,
      )).toEqual([...REQUIRED_RESTORE_CHECK_NAMES]);
      await expect(persistRestoreTestReport(
        root,
        report,
        {
          runId: "restore_test:two",
          now: new Date("2026-07-26T12:00:00Z"),
          suffix: "test",
        },
      )).rejects.toThrow(/не будет перезаписан/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed successful reports before any final publication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-cli-restore-reject-"));
    const base = exactRestoreReport({
      archiveRoot: root,
      exportFile: "backup.surql.zst",
      exportBytes: 42,
      exportSha256: "a".repeat(64),
      manifestFile: "backup.json",
      manifestSha256: "b".repeat(64),
    });
    const failedChecks = base.checks.map((check, index) =>
      index === 0 ? { ...check, ok: false } : check
    );
    const cases: Array<{
      name: string;
      report: unknown;
      now?: Date;
    }> = [
      { name: "unknown", report: { ...base, unexpected: "durably-persisted" } },
      {
        name: "created-order",
        report: base,
        now: new Date("2026-07-26T11:58:00.000Z"),
      },
      { name: "time-format", report: { ...base, startedAt: "2026-07-26T11:30:00Z" } },
      { name: "attempt-namespace", report: { ...base, attemptId: "2".repeat(32) } },
      {
        name: "path",
        report: { ...base, exportPath: path.join(root, "elsewhere", base.exportFile) },
      },
      { name: "basename", report: { ...base, exportFile: `nested/${base.exportFile}` } },
      { name: "hash", report: { ...base, exportSha256: "A".repeat(64) } },
      { name: "schema", report: { ...base, schemaVersion: 4 } },
      {
        name: "cleanup",
        report: { ...base, cleanup: { ...base.cleanup, namespaceRemoved: false } },
      },
      { name: "checks-incomplete", report: { ...base, checks: base.checks.slice(0, -1) } },
      {
        name: "checks-duplicate",
        report: { ...base, checks: [...base.checks, base.checks[0]!] },
      },
      { name: "checks-failed", report: { ...base, checks: failedChecks } },
    ];
    try {
      for (const item of cases) {
        const suffix = item.name;
        const now = item.now ?? new Date("2026-07-26T12:00:00.000Z");
        await expect(persistRestoreTestReport(
          root,
          item.report as RestoreTestReport,
          { runId: "restore_test:adversarial", now, suffix },
        )).rejects.toThrow();
        const finalPath = path.join(
          root,
          "backups",
          "manifests",
          `restore-test-${
            now.toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/u, "Z")
          }-${suffix}.json`,
        );
        await expect(stat(finalPath)).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("persists only privacy-safe unique-namespace failure evidence no-clobber", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-cli-restore-failure-"));
    const failureAttemptUuid = "22222222-2222-4222-8222-222222222222";
    const report: RestoreTestFailureEvidence = {
      formatVersion: 1,
      ok: false,
      attemptId: failureAttemptUuid.replaceAll("-", ""),
      startedAt: "2026-07-26T12:00:00.000Z",
      namespace: createRestoreNamespace(failureAttemptUuid),
      checks: [],
      failure: { stage: "import", code: "import_failed" },
      cleanupFailures: ["namespace_remove"],
    };
    try {
      const first = await persistRestoreTestFailureReport(root, report, {
        now: new Date("2026-07-26T12:01:00.000Z"),
      });
      expect((await stat(first.reportPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(first.reportPath, "utf8"))).toEqual(report);
      expect(JSON.stringify(report)).not.toContain("/Users/");
      await expect(persistRestoreTestFailureReport(root, report, {
        now: new Date("2026-07-26T12:01:00.000Z"),
      })).rejects.toThrow(/не будет перезаписан/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("migration mandatory backup/restore gate", () => {
  const cfg: AppConfig = {
    archiveRoot: "/private/archive/secret-project",
    dbRoot: "/private/internal/ai-baka/rocksdb",
    surrealUrl: "ws://127.0.0.1:8901/rpc",
    surrealUser: "root",
    surrealPass: "not-logged",
    surrealNamespace: "baka",
    surrealDatabase: "archive",
    minFreeBytes: 1,
    deletionConfirmations: 2,
    sourceOverrides: {},
    embeddings: {
      excludeHarnesses: [],
      excludeWorkspaces: [],
      excludeDocumentTypes: [],
    },
  };
  const backup: BackupResult = {
    exportPath: "/private/archive/secret-project/backups/surreal/fresh.surql.zst",
    manifestPath: "/private/archive/secret-project/backups/manifests/fresh.json",
    manifest: {
      createdAt: "2026-07-26T12:00:00.000Z",
      surrealdbVersion: "3.2.3",
      schemaVersion: 1,
      bakaCommit: "test",
      namespace: "baka",
      database: "archive",
      recordCounts: {},
      rawManifestSha256: "c".repeat(64),
      exportFile: "fresh.surql.zst",
      compression: "zstd",
      exportBytes: 42,
      exportSha256: "a".repeat(64),
    },
  };
  const restore = exactRestoreReport({
    archiveRoot: cfg.archiveRoot,
    database: cfg.surrealDatabase,
    exportFile: backup.manifest.exportFile,
    exportBytes: backup.manifest.exportBytes,
    exportSha256: backup.manifest.exportSha256,
    manifestFile: "fresh.json",
    manifestSha256: "b".repeat(64),
    rawManifestSha256: backup.manifest.rawManifestSha256!,
    startedAt: "2026-07-26T12:00:10.000Z",
    finishedAt: "2026-07-26T12:00:50.000Z",
  });

  function dependencies(
    trace: string[],
    overrides: Partial<Parameters<typeof runMigrationAfterBackupGate<string>>[2]> = {},
  ): Parameters<typeof runMigrationAfterBackupGate<string>>[2] {
    return {
      backup: async () => {
        trace.push("backup");
        return backup;
      },
      verify: async () => {
        trace.push("verify");
        return { manifestSha256: restore.manifestSha256 };
      },
      restore: async (_cfg, options) => {
        trace.push(`restore:${options.exportPath}:${options.rawArchiveRoot}`);
        return restore;
      },
      persist: async (_root, report, options) => {
        trace.push("persist");
        const reportPath = "/private/archive/secret-project/backups/manifests/restore.json";
        return {
          reportPath,
          persisted: {
            ...report,
            createdAt: "2026-07-26T12:01:00.000Z",
            runId: options.runId,
          },
          artifact: {
            path: reportPath,
            sha256: "d".repeat(64),
            sizeBytes: 123,
            createdAt: "2026-07-26T12:01:00.000Z",
            ok: true as const,
          },
        };
      },
      loadSafety: async ({ exportPath, restoreReportPath }) => {
        trace.push("safety");
        return {
          backup: {
            path: exportPath,
            sha256: backup.manifest.exportSha256,
            sizeBytes: backup.manifest.exportBytes,
            createdAt: backup.manifest.createdAt,
          },
          restore: {
            path: restoreReportPath,
            sha256: "d".repeat(64),
            sizeBytes: 123,
            createdAt: "2026-07-26T12:01:00.000Z",
            ok: true as const,
          },
        };
      },
      runner: async () => {
        trace.push("runner");
        return "migrated";
      },
      ...overrides,
    };
  }

  test("orders fresh backup, authentication, exact restore, persistence, then runner", async () => {
    const trace: string[] = [];
    let runnerEvidence: Parameters<
      Parameters<typeof runMigrationAfterBackupGate<string>>[2]["runner"]
    >[0] | undefined;
    const result = await runMigrationAfterBackupGate(
      cfg,
      "migration_run:test",
      dependencies(trace, {
        runner: async (evidence) => {
          trace.push("runner");
          runnerEvidence = evidence;
          return "migrated";
        },
      }),
    );
    expect(result.result).toBe("migrated");
    expect(trace).toEqual([
      "backup",
      "verify",
      `restore:${backup.exportPath}:${cfg.archiveRoot}`,
      "persist",
      "safety",
      "runner",
    ]);
    expect(result.restoreReportPath).toEndWith("restore.json");
    expect(runnerEvidence).toEqual({
      backup: {
        path: backup.exportPath,
        sha256: backup.manifest.exportSha256,
        sizeBytes: backup.manifest.exportBytes,
        createdAt: backup.manifest.createdAt,
      },
      restore: {
        path: "/private/archive/secret-project/backups/manifests/restore.json",
        sha256: "d".repeat(64),
        sizeBytes: 123,
        createdAt: "2026-07-26T12:01:00.000Z",
        ok: true,
      },
    });
  });

  test("every prerequisite failure is fail-closed before runner", async () => {
    const cases: Array<{
      expectedStage: MigrationSafetyStage;
      override: (
        trace: string[],
      ) => Partial<Parameters<typeof runMigrationAfterBackupGate<string>>[2]>;
    }> = [
      {
        expectedStage: "logical_backup",
        override: (trace) => ({
          backup: async () => {
            trace.push("backup");
            throw new Error("private backup failure /secret/path");
          },
        }),
      },
      {
        expectedStage: "backup_integrity",
        override: (trace) => ({
          verify: async () => {
            trace.push("verify");
            throw new Error("manifest contains private content");
          },
        }),
      },
      {
        expectedStage: "restore_drill",
        override: (trace) => ({
          restore: async () => {
            trace.push("restore");
            throw new Error("integrity failure at /private/export");
          },
        }),
      },
      {
        expectedStage: "restore_binding",
        override: (trace) => ({
          restore: async () => {
            trace.push("restore");
            return { ...restore, exportSha256: "f".repeat(64) };
          },
        }),
      },
      {
        expectedStage: "restore_binding",
        override: (trace) => ({
          restore: async () => {
            trace.push("restore");
            return {
              ...restore,
              checks: restore.checks.filter((check) => check.name !== "raw references"),
            };
          },
        }),
      },
      {
        expectedStage: "restore_report_persist",
        override: (trace) => ({
          persist: async () => {
            trace.push("persist");
            throw new Error("report path /private/report exists");
          },
        }),
      },
      {
        expectedStage: "safety_evidence",
        override: (trace) => ({
          loadSafety: async () => {
            trace.push("safety");
            throw new Error("semantic safety mismatch /private/report");
          },
        }),
      },
      {
        expectedStage: "restore_report_persist",
        override: (trace) => ({
          persist: async (_root, report, options) => {
            trace.push("persist");
            const reportPath = "/private/report.json";
            return {
              reportPath,
              persisted: {
                ...report,
                exportSha256: "0".repeat(64),
                createdAt: "2026-07-26T12:01:00.000Z",
                runId: options.runId,
              },
              artifact: {
                path: reportPath,
                sha256: "d".repeat(64),
                sizeBytes: 123,
                createdAt: "2026-07-26T12:01:00.000Z",
                ok: true as const,
              },
            };
          },
        }),
      },
    ];
    for (const item of cases) {
      const trace: string[] = [];
      let caught: unknown;
      try {
        await runMigrationAfterBackupGate(
          cfg,
          "migration_run:test",
          dependencies(trace, item.override(trace)),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationSafetyGateError);
      expect((caught as MigrationSafetyGateError).stage).toBe(item.expectedStage);
      expect((caught as Error).message).not.toContain("private");
      expect((caught as Error).message).not.toContain("secret");
      expect(trace).not.toContain("runner");
    }
  });

  test("structured gate events contain only stable stages/status, never private data", async () => {
    const trace: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const deps = dependencies(trace, {
      emit: (event) => events.push(event),
      verify: async () => {
        throw new Error("raw content /Users/private/secret.jsonl sk-private-value");
      },
    });
    await expect(runMigrationAfterBackupGate(cfg, "migration_run:test", deps))
      .rejects.toThrow("migration safety gate failed: backup_integrity");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("/Users/private");
    expect(serialized).not.toContain("sk-private");
    expect(serialized).not.toContain("secret-project");
    expect(events.every((event) => Object.keys(event).every((key) =>
      ["event", "stage", "status"].includes(key)
    ))).toBe(true);
    expect(trace).not.toContain("runner");
  });
});

describe("migration production outcome gate", () => {
  const assignment = {
    table: "source_files" as const,
    legacyId: "7",
    mappingId: "operator-map",
    basis: "explicit" as const,
  };
  const hostMapping = {
    kind: "baka-legacy-host-mapping-approval",
    formatVersion: 1,
    snapshotSha256: "a".repeat(64),
    mappings: [{
      mappingId: "operator-map",
      host: {
        hostUuid: "host-test",
        hostname: "test.local",
        platform: "darwin",
        arch: "arm64",
        osUsername: "tester",
        homePath: "/Users/tester",
      },
      sourceFileIds: ["7"],
    }],
    assignments: [assignment],
    artifactSha256: "b".repeat(64),
  } satisfies LegacyHostMappingApproval;
  const report = {
    createdAt: "2026-07-26T12:00:00.000Z",
    status: "completed",
    snapshotPath: "/private/snapshot.sqlite",
    snapshotSha256: "a".repeat(64),
    reconciliation: {
      legacyTotal: 1,
      matched: 1,
      inserted: 0,
      quarantined: 0,
      accounted: 1,
      lost: 0,
      ok: true,
      tables: {
        source_files: {
          total: 1,
          matched: 1,
          inserted: 0,
          quarantined: 0,
          accounted: 1,
          lost: 0,
        },
      },
    },
    recovery: { raw: 0, payload: 0, normalized: 0 },
    hostAttribution: {
      approvedMappings: [{
        mappingId: "operator-map",
        hostUuid: "host-test",
        attributedRows: 1,
      }],
      actualAssignments: [assignment],
      uncertainty: [],
    },
    assignmentCoverageOk: true,
  } as unknown as MigrationRunReport;

  test("requires exact consumed assignments, counts, and durable reconciliation", () => {
    expect(() => assertMigrationProductionOutcome(report, hostMapping)).not.toThrow();
    expect(() => assertMigrationProductionOutcome({
      ...report,
      hostAttribution: { ...report.hostAttribution, actualAssignments: [] },
    }, hostMapping)).toThrow(/assignments differ/);
    expect(() => assertMigrationProductionOutcome({
      ...report,
      hostAttribution: {
        ...report.hostAttribution,
        approvedMappings: [{ ...report.hostAttribution.approvedMappings[0]!, attributedRows: 0 }],
      },
    }, hostMapping)).toThrow(/counts differ/);
    expect(() => assertMigrationProductionOutcome({
      ...report,
      reconciliation: { ...report.reconciliation, accounted: 0, lost: 1, ok: false },
    }, hostMapping)).toThrow(/reconciliation/);
    expect(() => assertMigrationProductionOutcome({
      ...report,
      status: "completed_with_errors",
    }, hostMapping)).toThrow(/reconciliation/);
    expect(() => assertMigrationProductionOutcome({
      ...report,
      assignmentCoverageOk: false,
    }, hostMapping)).toThrow(/reconciliation/);
    expect(() => assertMigrationProductionOutcome({
      ...report,
      reconciliation: { ...report.reconciliation, quarantined: 1 },
    }, hostMapping)).toThrow(/reconciliation/);
  });
});

describe("strict migration CLI authorization artifacts", () => {
  async function fixture(root: string) {
    await mkdir(root, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const keyFingerprint = migrationApprovalKeyFingerprint(publicKeyPem);
    const hostMappingBody = {
      kind: "baka-legacy-host-mapping-approval" as const,
      formatVersion: 1 as const,
      snapshotSha256: "a".repeat(64),
      mappings: [{
        mappingId: "operator-map",
        host: {
          hostUuid: "host-test",
          hostname: "test.local",
          platform: "darwin",
          arch: "arm64",
          osUsername: "tester",
          homePath: "/Users/tester",
        },
        sourceFileIds: ["7"],
      }],
      assignments: [{
        table: "source_files" as const,
        legacyId: "7",
        mappingId: "operator-map",
        basis: "explicit" as const,
      }],
    };
    const hostMapping = {
      ...hostMappingBody,
      artifactSha256: migrationArtifactSha256(hostMappingBody),
    };
    const tableTotals = Object.fromEntries(LEGACY_TABLES.map((table) => [table, 0]));
    const evidence = {
      snapshotSha256: "a".repeat(64),
      snapshotSizeBytes: 123,
      checkRawFiles: true,
      tableTotals,
      problems: [],
      liveProbe: { available: true, revisionSha256: [], dialogueKeys: [] },
      expectedDeletedCount: 0,
      hostMappingArtifactSha256: hostMapping.artifactSha256,
    };
    const approvalBody = {
      kind: "baka-legacy-preflight-approval" as const,
      formatVersion: 1 as const,
      approvedAt: "2026-07-26T10:00:00.000Z",
      approvedBy: "manual-operator-label",
      evidence,
      evidenceSha256: migrationArtifactSha256(evidence),
    };
    const approval = {
      ...approvalBody,
      artifactSha256: migrationArtifactSha256(approvalBody),
    };
    const paths = {
      approval: path.join(root, "approval.json"),
      attestation: path.join(root, "attestation.json"),
      hostMapping: path.join(root, "host-map.json"),
      restore: path.join(root, "restore.json"),
      key: path.join(root, "approval-key.pem"),
    };
    const approvalBytes = `${JSON.stringify(approval, null, 2)}\n`;
    await writeFile(paths.approval, approvalBytes, { mode: 0o600 });
    const payload = {
      approvalFileSha256: createHash("sha256").update(approvalBytes).digest("hex"),
      approvalArtifactSha256: approval.artifactSha256,
      hostMappingArtifactSha256: hostMapping.artifactSha256,
      snapshotSha256: evidence.snapshotSha256,
      snapshotSizeBytes: evidence.snapshotSizeBytes,
      observedDeletedCount: evidence.expectedDeletedCount,
      issuedAt: "2026-07-26T11:00:00.000Z",
    };
    const attestation = {
      kind: "baka-legacy-migration-attestation" as const,
      formatVersion: 1 as const,
      keyFingerprint,
      payload,
      signature: sign(
        null,
        Buffer.from(canonicalMigrationJson(payload), "utf8"),
        privateKey,
      ).toString("base64"),
    };
    const restore = {
      ...exactRestoreReport({
        archiveRoot: path.join(root, "archive"),
        exportFile: "backup.surql.zst",
        exportBytes: 10,
        exportSha256: "b".repeat(64),
        manifestFile: "backup.json",
        manifestSha256: "c".repeat(64),
      }),
      runId: "restore-fixture",
      createdAt: "2026-07-26T12:00:00.000Z",
    };
    await Promise.all([
      writeFile(paths.attestation, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.hostMapping, `${JSON.stringify(hostMapping, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.restore, `${JSON.stringify(restore, null, 2)}\n`, { mode: 0o600 }),
      writeFile(paths.key, publicKeyPem, { mode: 0o600 }),
    ]);
    const input = {
      approvalPath: paths.approval,
      attestationPath: paths.attestation,
      hostMappingApprovalPath: paths.hostMapping,
      restoreReportPath: paths.restore,
      approvalPublicKeyPath: paths.key,
      approvalKeySha256: keyFingerprint,
    };
    return { input, paths, approvalBytes, approval, attestation, hostMapping, restore };
  }

  test("valid exact fixture passes; forged/copied/wrong/altered inputs fail closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baka-migration-cli-auth-"));
    try {
      const valid = await fixture(root);
      let runnerInvocations = 0;
      const runner = async (artifacts: Awaited<ReturnType<typeof loadStrictMigrationCliArtifacts>>) => {
        runnerInvocations += 1;
        return artifacts;
      };
      await expect(runStrictMigrationCliArtifactGate(valid.input, runner)).resolves.toMatchObject({
        approval: { artifactSha256: valid.approval.artifactSha256 },
        hostMapping: { artifactSha256: valid.hostMapping.artifactSha256 },
        restoreReport: { formatVersion: 5, ok: true },
      });
      expect(runnerInvocations).toBe(1);

      await writeFile(valid.paths.attestation, `${JSON.stringify({
        ...valid.attestation,
        signature: `${valid.attestation.signature.slice(0, -4)}AAAA`,
      })}\n`);
      await expect(runStrictMigrationCliArtifactGate(valid.input, runner)).rejects.toThrow(/signature/);

      const copied = await fixture(path.join(root, "copied"));
      await expect(runStrictMigrationCliArtifactGate({
        ...copied.input,
        approvalKeySha256: valid.input.approvalKeySha256,
      }, runner)).rejects.toThrow(/pinned SHA-256/);
      await writeFile(copied.paths.attestation, `${JSON.stringify(valid.attestation)}\n`);
      await expect(runStrictMigrationCliArtifactGate(copied.input, runner)).rejects.toThrow(/signer/);

      const alteredApproval = await fixture(path.join(root, "altered-approval"));
      await writeFile(alteredApproval.paths.approval, `${alteredApproval.approvalBytes} `);
      await expect(runStrictMigrationCliArtifactGate(alteredApproval.input, runner))
        .rejects.toThrow(/exact approved evidence/);

      const alteredMap = await fixture(path.join(root, "altered-map"));
      await writeFile(alteredMap.paths.hostMapping, JSON.stringify({
        ...alteredMap.hostMapping,
        snapshotSha256: "f".repeat(64),
      }));
      await expect(runStrictMigrationCliArtifactGate(alteredMap.input, runner)).rejects.toThrow();

      const alteredRestore = await fixture(path.join(root, "altered-restore"));
      await writeFile(alteredRestore.paths.restore, JSON.stringify({
        ...alteredRestore.restore,
        ok: false,
      }));
      await expect(runStrictMigrationCliArtifactGate(alteredRestore.input, runner))
        .rejects.toThrow(/formatVersion\/ok/);

      await expect(runStrictMigrationCliArtifactGate({
        ...valid.input,
        approvalPublicKeyPath: path.join(root, "missing.pem"),
      }, runner)).rejects.toThrow();
      expect(runnerInvocations).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("migration operator evidence gate", () => {
  function dependencies(
    trace: string[],
    fail?: MigrationSafetyStage,
  ): Parameters<typeof runMigrationPreBackupGate<string, string, string, string>>[0] {
    const step = async (stage: MigrationSafetyStage, value: string): Promise<string> => {
      trace.push(stage);
      if (fail === stage) throw new Error(`private ${stage} failure /Users/secret`);
      return value;
    };
    return {
      loadApproval: () => step("operator_approval", "approval"),
      verifySnapshot: () => step("snapshot_evidence", "snapshot"),
      verifyHostMapping: () => step("host_mapping_evidence", "mapping"),
      verifyLiveEvidence: () => step("live_probe_evidence", "live"),
      verifyReportTarget: async () => {
        await step("report_target", "report");
      },
    };
  }

  test("all approval gates complete before backup or writer can be selected", async () => {
    const trace: string[] = [];
    const prepared = await runMigrationPreBackupGate(dependencies(trace));
    trace.push("backup");
    trace.push("writer");
    expect(prepared).toEqual({
      approval: "approval",
      snapshot: "snapshot",
      mapping: "mapping",
      live: "live",
    });
    expect(trace).toEqual([
      "operator_approval",
      "snapshot_evidence",
      "host_mapping_evidence",
      "live_probe_evidence",
      "report_target",
      "backup",
      "writer",
    ]);
  });

  test("stale/wrong evidence at every stage prevents backup and writer", async () => {
    for (const stage of [
      "operator_approval",
      "snapshot_evidence",
      "host_mapping_evidence",
      "live_probe_evidence",
      "report_target",
    ] as const) {
      const trace: string[] = [];
      let backupInvoked = false;
      let writerInvoked = false;
      try {
        await runMigrationPreBackupGate(dependencies(trace, stage));
        backupInvoked = true;
        writerInvoked = true;
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationSafetyGateError);
        expect((error as MigrationSafetyGateError).stage).toBe(stage);
        expect((error as Error).message).not.toContain("secret");
        expect((error as Error).message).not.toContain("private");
      }
      expect(backupInvoked, stage).toBe(false);
      expect(writerInvoked, stage).toBe(false);
      expect(trace).not.toContain("backup");
      expect(trace).not.toContain("writer");
    }
  });
});

describe("CLI command surface", () => {
  test("preserves existing commands and exposes all stable Stage 11/12 APIs", () => {
    const names = program.commands.map((item) => item.name());
    for (const existing of [
      "archive:init",
      "discover",
      "db",
      "disk",
      "sync",
      "search",
      "search:rebuild",
      "status",
      "validate",
      "backup",
      "restore:test",
      "raw:verify",
      "embeddings",
      "migration",
    ]) {
      expect(names).toContain(existing);
    }
    for (const added of ["relevance", "doctor", "export-thread", "reparse"]) {
      expect(names).toContain(added);
    }

    const embeddings = command(program, "embeddings");
    expect(embeddings.commands.map((item) => item.name())).toEqual(expect.arrayContaining([
      "exact-tokens",
      "candidates",
      "backfill",
      "privacy",
      "space:retire",
      "audit",
    ]));
    expect(command(embeddings, "candidates").commands.map((item) => item.name())).toEqual([
      "plan",
      "run",
    ]);
    expect(command(embeddings, "backfill").commands.map((item) => item.name())).toEqual([
      "plan",
      "run",
    ]);
    expect(command(embeddings, "privacy").commands.map((item) => item.name())).toEqual([
      "plan",
      "apply",
    ]);
    expect(command(embeddings, "space:retire").commands.map((item) => item.name())).toEqual([
      "plan",
      "run",
    ]);
    const offDevice = command(command(program, "backup"), "off-device");
    expect(offDevice.commands.map((item) => item.name())).toEqual(["plan", "run", "verify"]);
  });

  test("production backfill output is progress-only; completion belongs to final acceptance", () => {
    const lines = formatProductionBackfillPlan({
      space: { slug: "selected", model: "mock", dimensions: 8 },
      corpusDocuments: 4,
      eligibleDocuments: 3,
      privacyExcludedDocuments: 1,
      eligibleTokens: 12,
      exactPriceUsd: 0.01,
      maxJobs: 2,
      relevanceEvidence: { scenarioId: "candidate_hybrid_selected" },
      jobs: { completed: 1, pending: 2 },
      vectors: 1,
      runnableJobs: [{ jobId: "embedding_job:one" }],
      blockers: ["pending_jobs=2"],
      permanentErrors: [],
      confirmation: `RUN EMBEDDINGS selected ${"a".repeat(64)} ${"b".repeat(64)}`,
    } as unknown as Parameters<typeof formatProductionBackfillPlan>[0]);
    expect(lines.join("\n")).toContain("progress: vectors 1, runnable jobs 1");
    expect(lines.join("\n")).toContain("BLOCKER pending_jobs=2");
    expect(lines.join("\n").toLowerCase()).not.toContain("completion");

    const finalAcceptance = command(command(program, "relevance"), "full-corpus");
    expect(command(finalAcceptance, "accept").description()).toContain("Stage11Completion");
  });

  test("migration exposes run and signed operator-exclusion lifecycle with explicit write gates", () => {
    const migration = command(program, "migration");
    expect(migration.commands.map((item) => item.name())).toEqual([
      "plan",
      "run",
      "retry",
      "exclusions",
      "status",
    ]);
    for (const name of ["run", "retry"]) {
      const migrationFlags = flags(command(migration, name));
      expect(migrationFlags).toEqual(expect.arrayContaining([
        "--legacy-db",
        "--approval",
        "--attestation",
        "--host-mapping-approval",
        "--restore-report",
        "--approval-public-key",
        "--approval-key-sha256",
        "--report",
        "--apply",
        "--json",
      ]));
      for (const deprecated of [
        "--approval-sha256",
        "--approve-sha256",
        "--confirm-deleted-count",
        "--host-mapping-sha256",
      ]) expect(migrationFlags).not.toContain(deprecated);
      expect(migrationFlags.some((flag) => /skip.*(backup|restore)|no-(backup|restore)/.test(flag)))
        .toBe(false);
    }
    expect(flags(command(migration, "plan"))).toContain("--json");
    expect(flags(command(migration, "plan"))).not.toContain("--approval");
    expect(flags(command(migration, "status"))).toContain("--json");

    const exclusions = command(migration, "exclusions");
    expect(exclusions.commands.map((item) => item.name())).toEqual(["plan", "apply", "status"]);
    expect(flags(command(exclusions, "plan"))).toEqual(expect.arrayContaining([
      "--legacy-db",
      "--source-migration",
      "--artifact",
      "--json",
    ]));
    expect(flags(command(exclusions, "apply"))).toEqual(expect.arrayContaining([
      "--legacy-db",
      "--artifact",
      "--exclusion-attestation",
      "--approval-public-key",
      "--approval-key-sha256",
      "--report",
      "--apply",
      "--json",
    ]));
    expect(flags(command(exclusions, "apply"))).not.toContain("--restore-report");
    expect(flags(command(exclusions, "status"))).toContain("--json");
  });

  test("search exposes the four new filters and enriched human formatter", () => {
    const search = command(program, "search");
    expect(flags(search)).toEqual(expect.arrayContaining([
      "--user",
      "--vendor",
      "--reasoning-effort",
      "--role",
    ]));
    const rendered = formatHit(0, {
      id: "search_document:one",
      score: 1,
      snippet: "answer",
      dialogueId: "dialogue:one",
      revisionId: "dialogue_revision:one",
      role: "assistant",
      user: "example",
      vendor: "openai",
      reasoningEffort: "high",
      sourcePath: "/private/source.jsonl",
    });
    expect(rendered).toContain("role assistant");
    expect(rendered).toContain("user example");
    expect(rendered).toContain("vendor openai");
    expect(rendered).toContain("reasoning high");
    expect(rendered).toContain("source: /private/source.jsonl");
  });

  test("paid/destructive/privacy gates are visible in help contracts", () => {
    const embeddings = command(program, "embeddings");
    const exact = command(embeddings, "exact-tokens");
    expect(flags(exact)).toEqual(expect.arrayContaining(["--model", "--report", "--overwrite", "--json"]));
    expect(flags(exact).some((flag) => flag.includes("price"))).toBe(false);
    expect(EXACT_TOKENIZER_SCRIPT).toEndWith("scripts/exact-tokenizer.py");

    const genericRun = command(embeddings, "run");
    expect(genericRun.description()).toContain("generic mock-only worker is not exposed");
    expect(flags(genericRun)).toEqual(expect.arrayContaining([
      "--space",
      "--limit",
      "--allow-paid-api",
    ]));
    const candidateRun = command(command(embeddings, "candidates"), "run");
    expect(flags(candidateRun)).toEqual(expect.arrayContaining([
      "--plan",
      "--judgments",
      "--confirm",
      "--allow-paid-api",
      "--json",
    ]));
    const candidatePlan = command(command(embeddings, "candidates"), "plan");
    expect(flags(candidatePlan)).toEqual(expect.arrayContaining([
      "--judgments",
      "--spaces",
      "--max-documents",
      "--max-jobs-per-space",
      "--selection-seed-sha256",
      "--report",
      "--json",
    ]));

    const evaluate = command(command(program, "relevance"), "evaluate");
    expect(flags(evaluate)).toEqual(expect.arrayContaining([
      "--judgments",
      "--report",
      "--candidate-plan",
      "--confirm",
      "--spaces",
      "--resource-measurements",
      "--documented-exclusions",
      "--allow-paid-api",
      "--include-query-text",
      "--json",
    ]));
    const candidateExclusionsHelp = optionDescription(evaluate, "--documented-exclusions");
    for (const field of ["category", "code", "jobId", "documentId", "evidence"]) {
      expect(candidateExclusionsHelp).toContain(field);
    }
    expect(candidateExclusionsHelp).toContain("no count");
    expect(candidateExclusionsHelp).toContain("normalized privacy");
    expect(evaluate.description()).toContain("authenticated ordered hit identities");
    const fullCorpus = command(command(program, "relevance"), "full-corpus");
    expect(fullCorpus.commands.map((item) => item.name())).toEqual([
      "plan",
      "evaluate",
      "accept",
    ]);
    expect(flags(command(fullCorpus, "plan"))).toEqual(expect.arrayContaining([
      "--space",
      "--exact-report",
      "--json",
    ]));
    expect(flags(command(fullCorpus, "evaluate"))).toEqual(expect.arrayContaining([
      "--space",
      "--exact-report",
      "--judgments",
      "--resource-measurements",
      "--documented-exclusions",
      "--confirm",
      "--report",
      "--allow-paid-api",
      "--include-query-text",
      "--json",
    ]));
    const finalEvaluate = command(fullCorpus, "evaluate");
    const finalExclusionsHelp = optionDescription(finalEvaluate, "--documented-exclusions");
    expect(finalExclusionsHelp).toContain("jobId/documentId/evidence");
    expect(finalExclusionsHelp).toContain("no count");
    expect(finalEvaluate.description()).toContain("authenticated hit identities");
    expect(flags(command(fullCorpus, "accept"))).toEqual(expect.arrayContaining([
      "--evidence",
      "--exact-report",
      "--space",
      "--judgments",
      "--judgments-sha256",
      "--judgments-size-bytes",
      "--json",
    ]));

    const backfillRun = command(command(embeddings, "backfill"), "run");
    expect(flags(backfillRun)).toEqual(expect.arrayContaining([
      "--exact-report",
      "--accepted-relevance",
      "--confirm",
      "--max-jobs",
      "--allow-paid-api",
      "--json",
    ]));
    const backfillPlan = command(command(embeddings, "backfill"), "plan");
    expect(flags(backfillPlan)).toEqual(expect.arrayContaining([
      "--exact-report",
      "--accepted-relevance",
      "--max-jobs",
      "--json",
    ]));
    expect(flags(backfillRun).some((flag) => flag.includes("price"))).toBe(false);
    expect(flags(backfillPlan).some((flag) => flag.includes("price"))).toBe(false);
    const privacyPlan = command(command(embeddings, "privacy"), "plan");
    const privacyApply = command(command(embeddings, "privacy"), "apply");
    expect(privacyPlan.description()).toContain("provider is never");
    expect(flags(privacyPlan)).toEqual(expect.arrayContaining([
      "--space",
      "--report",
      "--overwrite",
      "--json",
    ]));
    expect(flags(privacyApply)).toEqual(expect.arrayContaining([
      "--plan",
      "--confirm",
      "--json",
    ]));
    expect(flags(privacyApply).some((flag) => flag.includes("paid"))).toBe(false);
    const retire = command(embeddings, "space:retire");
    expect(flags(command(retire, "plan"))).toEqual(expect.arrayContaining([
      "--space",
      "--accepted-space",
      "--report",
      "--overwrite",
      "--json",
    ]));
    expect(flags(command(retire, "run"))).toEqual(expect.arrayContaining([
      "--plan",
      "--accepted-space",
      "--confirm",
      "--json",
    ]));
    expect(command(embeddings, "audit").description()).toContain("jobs/vectors/hashes/dimensions/orphans");
    expect(flags(command(program, "doctor"))).toEqual(expect.arrayContaining([
      "--apply",
      "--allow-destructive",
      "--import-orphan-raw",
      "--remove-stale-staging",
      "--requeue-stuck-embeddings",
      "--rebuild-search-projection",
      "--recalculate-primary-models",
      "--repair-manifest",
    ]));
    expect(flags(command(program, "export-thread"))).toEqual(expect.arrayContaining([
      "--include-relative-source-paths",
      "--force",
      "--json",
    ]));
  });

  test("restore/off-device/reparse expose required paths and JSON modes", () => {
    expect(flags(command(program, "restore:test"))).toEqual(expect.arrayContaining([
      "--raw-archive-root",
      "--json",
    ]));
    const recovery = command(program, "recovery:rebuild");
    expect(flags(recovery)).toEqual(expect.arrayContaining([
      "--export-sha256",
      "--manifest-sha256",
      "--db-root",
      "--work-root",
      "--confirm-rebuild",
      "--json",
    ]));
    const workRoot = recovery.options.find((option) => option.long === "--work-root");
    expect(workRoot?.description).toContain("internal APFS/POSIX");
    const offDevice = command(command(program, "backup"), "off-device");
    expect(flags(command(offDevice, "run"))).toEqual(expect.arrayContaining([
      "--destination",
      "--confirm-physical-device",
      "--json",
    ]));
    expect(flags(command(program, "reparse"))).toEqual(expect.arrayContaining([
      "--source-revision",
      "--source-location",
      "--harness",
      "--all",
      "--dry-run",
      "--no-enqueue-embeddings",
      "--no-verify-raw",
      "--json",
    ]));
  });

  test("recovery success text prints both durable evidence paths", () => {
    expect(formatRecoveryRebuildSuccess({
      exportFile: "backup.surql.zst",
      dbRoot: "/internal/rocksdb",
      corruptDbRoot: "/Volumes/Archive/Conversations/db",
      journalPath: "/internal/recovery/attempt/recovery-journal.json",
    })).toEqual([
      "recovery:rebuild: ok — backup.surql.zst",
      "new DB: /internal/rocksdb",
      "corrupt DB retained: /Volumes/Archive/Conversations/db",
      "staging container removed; production not started",
      "journal: /internal/recovery/attempt/recovery-journal.json",
      "report: /internal/recovery/attempt/recovery-report.json",
    ]);
  });

  test("real entrypoint renders help without requiring archive configuration", async () => {
    const cli = path.resolve(import.meta.dir, "../src/cli.ts");
    const child = Bun.spawn({
      cmd: [process.execPath, cli, "embeddings", "backfill", "run", "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--allow-paid-api");
    expect(stdout).toContain("--confirm <phrase>");

    const finalHelp = Bun.spawn({
      cmd: [process.execPath, cli, "relevance", "full-corpus", "evaluate", "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [finalHelpExit, finalHelpStdout, finalHelpStderr] = await Promise.all([
      finalHelp.exited,
      new Response(finalHelp.stdout).text(),
      new Response(finalHelp.stderr).text(),
    ]);
    expect(finalHelpExit).toBe(0);
    expect(finalHelpStderr).toBe("");
    expect(finalHelpStdout).toContain("--allow-paid-api");
    expect(finalHelpStdout).toContain("--exact-report <path>");

    const blockedFinalEvaluation = Bun.spawn({
      cmd: [
        process.execPath,
        cli,
        "relevance",
        "full-corpus",
        "evaluate",
        "--space",
        "production",
        "--exact-report",
        "/definitely/missing-exact.json",
        "--judgments",
        "/definitely/missing-judgments.json",
        "--resource-measurements",
        "/definitely/missing-resources.json",
        "--documented-exclusions",
        "/definitely/missing-exclusions.json",
        "--confirm",
        `EVALUATE FULL CORPUS production ${"a".repeat(64)}`,
        "--report",
        "/definitely/not-written.json",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENAI_API_KEY: "SHOULD-NOT-BE-READ" },
    });
    const [blockedFinalExit, blockedFinalStdout, blockedFinalStderr] = await Promise.all([
      blockedFinalEvaluation.exited,
      new Response(blockedFinalEvaluation.stdout).text(),
      new Response(blockedFinalEvaluation.stderr).text(),
    ]);
    expect(blockedFinalExit).toBe(1);
    expect(blockedFinalStdout).toBe("");
    expect(blockedFinalStderr).toContain("--allow-paid-api");
    expect(blockedFinalStderr).not.toContain("SHOULD-NOT-BE-READ");
    expect(blockedFinalStderr).not.toContain("missing-exact");

    const genericPaid = Bun.spawn({
      cmd: [
        process.execPath,
        cli,
        "embeddings",
        "run",
        "--space",
        "candidate-small",
        "--limit",
        "1",
        "--allow-paid-api",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENAI_API_KEY: "SHOULD-NOT-BE-READ" },
    });
    const [genericExit, genericStdout, genericStderr] = await Promise.all([
      genericPaid.exited,
      new Response(genericPaid.stdout).text(),
      new Response(genericPaid.stderr).text(),
    ]);
    expect(genericExit).toBe(1);
    expect(genericStdout).toBe("");
    expect(genericStderr).toContain("generic embeddings run не имеет Stage 11 authorization");
    expect(genericStderr).not.toContain("SHOULD-NOT-BE-READ");
    expect(genericStderr).not.toContain("OPENAI_API_KEY");

    const migration = Bun.spawn({
      cmd: [process.execPath, cli, "migration", "run", "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [migrationExit, migrationStdout, migrationStderr] = await Promise.all([
      migration.exited,
      new Response(migration.stdout).text(),
      new Response(migration.stderr).text(),
    ]);
    expect(migrationExit).toBe(0);
    expect(migrationStderr).toBe("");
    expect(migrationStdout).toContain("--approval <path>");
    expect(migrationStdout).toContain("--attestation <path>");
    expect(migrationStdout).toContain("--host-mapping-approval <path>");
    expect(migrationStdout).toContain("--restore-report <path>");
    expect(migrationStdout).toContain("--approval-public-key <path>");
    expect(migrationStdout).toContain("--approval-key-sha256 <sha256>");
    expect(migrationStdout).not.toContain("--approve-sha256");
    expect(migrationStdout).not.toContain("--confirm-deleted-count");
    expect(migrationStdout).toContain("--apply");

    const deprecatedApproval = Bun.spawn({
      cmd: [
        process.execPath,
        cli,
        "migration",
        "run",
        "--approval", "/missing/approval.json",
        "--attestation", "/missing/attestation.json",
        "--host-mapping-approval", "/missing/host-map.json",
        "--restore-report", "/missing/restore.json",
        "--approval-public-key", "/missing/key.pem",
        "--approval-key-sha256", "b".repeat(64),
        "--report", "/missing/report.json",
        "--apply",
        "--approve-sha256",
        "a".repeat(64),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [deprecatedExit, deprecatedStderr] = await Promise.all([
      deprecatedApproval.exited,
      new Response(deprecatedApproval.stderr).text(),
    ]);
    expect(deprecatedExit).toBe(1);
    expect(deprecatedStderr).toContain("unknown option '--approve-sha256'");

    const blockedMigration = Bun.spawn({
      cmd: [
        process.execPath,
        cli,
        "migration",
        "run",
        "--approval",
        "/definitely/missing/private-approval.json",
        "--attestation", "/definitely/missing/attestation.json",
        "--host-mapping-approval", "/definitely/missing/host-map.json",
        "--restore-report", "/definitely/missing/restore.json",
        "--approval-public-key", "/definitely/missing/key.pem",
        "--approval-key-sha256", "a".repeat(64),
        "--report", "/definitely/missing/output.json",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BAKA_ARCHIVE_ROOT: "" },
    });
    const [blockedExit, blockedStderr] = await Promise.all([
      blockedMigration.exited,
      new Response(blockedMigration.stderr).text(),
    ]);
    expect(blockedExit).toBe(1);
    expect(blockedStderr).toContain("--apply");
    expect(blockedStderr).not.toContain("private-host-mappings");

    const privateFailure = Bun.spawn({
      cmd: [
        process.execPath,
        cli,
        "migration",
        "run",
        "--approval",
        "/Users/private/secret-project/private-approval.json",
        "--attestation", "/Users/private/secret-project/attestation.json",
        "--host-mapping-approval", "/Users/private/secret-project/host-map.json",
        "--restore-report", "/Users/private/secret-project/restore.json",
        "--approval-public-key", "/Users/private/secret-project/key.pem",
        "--approval-key-sha256", "a".repeat(64),
        "--report", "/Users/private/secret-project/output.json",
        "--apply",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BAKA_ARCHIVE_ROOT: "" },
    });
    const [privateExit, privateStderr] = await Promise.all([
      privateFailure.exited,
      new Response(privateFailure.stderr).text(),
    ]);
    expect(privateExit).toBe(1);
    expect(privateStderr).toContain("migration safety gate failed: preconditions");
    expect(privateStderr).not.toContain("/Users/private");
    expect(privateStderr).not.toContain("secret-project");
    expect(privateStderr).not.toContain("private-approval");
  });
});
