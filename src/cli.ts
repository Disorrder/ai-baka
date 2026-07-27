#!/usr/bin/env bun
import { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import { loadConfig, type AppConfig } from "./config.ts";
import { initArchive } from "./infra/sentinel.ts";
import { runPreflight } from "./infra/preflight.ts";
import {
  composeDown,
  composeLogs,
  composeStatus,
  composeUp,
} from "./infra/compose.ts";
import { ejectDisk } from "./infra/disk-eject.ts";
import { connectDb, serverVersion } from "./db/client.ts";
import {
  assertProductionDbStorageSafety,
  configuredRecoveryDbRoot,
} from "./db/storage-safety.ts";
import { applyMigrations, checkSchemaVersion, gitHead } from "./db/migrations.ts";
import { assertPreflight } from "./infra/preflight.ts";
import { acquireLock } from "./infra/lock.ts";
import { isLocked } from "./infra/lock.ts";
import { readSentinel } from "./infra/sentinel.ts";
import { discoverSourceRoots } from "./sources/discovery/discovery.ts";
import { runSync } from "./sync/sync-run.ts";
import { HARNESSES, type HarnessSlug } from "./sources/adapters/harnesses.ts";
import { collectStatus, formatStatus } from "./status.ts";
import { runValidation } from "./validate.ts";
import {
  assertForensicSearchDisabled,
  searchText,
  type SearchHit,
} from "./search/fulltext.ts";
import {
  searchHybrid,
  searchVector,
  VectorSearchUnavailable,
} from "./search/hybrid.ts";
import { rebuildSearchProjection } from "./search/rebuild.ts";
import {
  backupTimestamp,
  manifestPathForExport,
  parseBackupManifest,
  runLogicalBackup,
  type BackupResult,
} from "./backup/backup.ts";
import { runRecoveryRebuild } from "./backup/recovery-rebuild.ts";
import { runRecoveryPromotion } from "./backup/recovery-promote.ts";
import {
  RestoreTestAttemptError,
  isRestoreNamespace,
  parseRestoreTargetEvidence,
  parsePersistedRestoreTestReport,
  PINNED_RESTORE_TARGET_IMAGE_DIGEST,
  PINNED_RESTORE_TARGET_VERSION,
  runRestoreTest,
  type PersistedRestoreTestReport,
  type RestoreTargetEvidence,
  type RestoreTargetFinalizationContext,
  type RestoreTestFailureEvidence,
  type RestoreTestOptions,
  type RestoreTestReport,
} from "./backup/restore-test.ts";
import {
  IsolatedTargetLifecycleError,
  PINNED_SURREAL_INDEXING_BEHAVIOR,
  pinnedSurrealImageFromCompose,
  withIsolatedSurrealTarget,
  type IsolatedSurrealTarget,
  type IsolatedTargetEvidence,
  type IsolatedTargetRunResult,
} from "./backup/isolated-target.ts";
import { runRawVerify } from "./backup/raw-verify.ts";
import {
  assertRegularNonSymlinkFile,
  writePrivateFileAtomicNoClobber,
} from "./backup/safety.ts";
import {
  planOffDeviceBackup,
  runOffDeviceBackup,
  verifyOffDeviceBackup,
  type OffDeviceBackupOptions,
} from "./backup/off-device.ts";
import { OpenAIEmbeddingProvider } from "./embeddings/openai-provider.ts";
import type { EmbeddingProvider } from "./embeddings/provider.ts";
import type { PrivacyPolicy } from "./embeddings/privacy.ts";
import {
  activateSpace,
  createSpace,
  getActiveSpace,
  loadRetireSpacePlan,
  listSpaces,
  prepareRetireSpace,
  retireSpace,
  SLUG_RE,
  writeRetireSpacePlan,
  type EmbeddingSpace,
} from "./embeddings/spaces.ts";
import {
  BATCH_SIZE,
  cancelPendingJobs,
  defaultProviderFactory,
  embeddingsPlan,
  embeddingsStatus,
  rebuildStaleJobs,
  retryFailedJobs,
} from "./embeddings/jobs.ts";
import { localIdentity, type LocalIdentity } from "./sync/host-identity.ts";
import { ensureLegacySnapshot, migrationInputDir } from "./migration/legacy-snapshot.ts";
import {
  analysisCheckpointPath,
  analyzeLegacySnapshot,
  buildPreflightReport,
  formatPreflightSummary,
  loadAnalysisCheckpoint,
  probeLiveCorpus,
  probeLiveCorpusFromDb,
  saveAnalysisCheckpoint,
  type LiveCorpusProbe,
} from "./migration/preflight.ts";
import {
  retryLegacyMigration,
  runLegacyMigrationWithSurreal,
  verifyMigrationSnapshot,
} from "./migration/run.ts";
import type { MigrationRunReport } from "./migration/reconciliation.ts";
import {
  SurrealLegacyMigrationBackend,
  type ApprovedLegacyHostMapping,
} from "./migration/store.ts";
import { ensureHost } from "./db/repositories/identity.ts";
import { TARGET_TOKENS } from "./search/segmenter.ts";
import {
  createCommandTokenCounter,
  EXACT_TOKENIZER_ID,
  exactEmbeddingsPlan,
  validateExactTokenCountReport,
  writeExactTokenCountReport,
  type ExactTokenCountReport,
} from "./embeddings/token-count.ts";
import {
  auditHnswIndex,
  auditProductionEmbeddingSpace,
  auditVectorDimensions,
  applyPrivacyReconciliation,
  completeStage11,
  loadPrivacyReconciliationPlan,
  loadEvaluationCandidatePlanArtifact,
  MAX_EVALUATION_CANDIDATE_DOCUMENTS,
  MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE,
  pinExpectedJudgmentArtifact,
  preparePrivacyReconciliation,
  prepareEvaluationCandidatePlan,
  prepareProductionBackfill,
  runConfirmedEvaluationCandidateBackfill,
  runConfirmedProductionBackfill,
  writePrivacyReconciliationPlan,
  writeEvaluationCandidatePlan,
  type AcceptedFullCorpusRelevanceEvidence,
  type AcceptedRelevanceEvidence,
  type EvaluationCandidatePlan,
  type EvaluationCandidatePlanOptions,
  type ProductionBackfillPlan,
} from "./embeddings/backfill.ts";
import {
  createFullCorpusHybridScenario,
  createEvaluationScenarios,
  fullCorpusEvaluationConfirmation,
  loadJudgmentSet,
  runFullCorpusHybridEvaluation,
  runRelevanceEvaluation,
  writeEvaluationReport,
  writeFullCorpusEvaluationReport,
  type EvaluationReadinessExclusion,
  type EvaluationMode,
  type EvaluationResourceMeasurements,
  type RelevanceJudgmentSet,
} from "./search/evaluation.ts";
import { runDoctor, type DoctorOptions, type DoctorReport } from "./doctor.ts";
import { exportThread } from "./export-thread.ts";
import { runReparse, type ReparseSelection } from "./reparse.ts";
import {
  createRunId,
  createStructuredLogger,
  type StructuredLogger,
} from "./observability.ts";
import { hashFile } from "./sources/snapshot/hashing.ts";
import { COMPOSE_FILE } from "./infra/compose.ts";
import {
  APPROVAL_ANALYSIS_IDENTITY,
  buildLegacyHostMappingApproval,
  canonicalLiveProbe,
  canonicalMigrationJson,
  canonicalProblems,
  loadMigrationSafetyEvidence,
  migrationApprovalKeyFingerprint,
  migrationArtifactSha256,
  parseMigrationManualAttestation,
  validateMigrationPreflightApproval,
  validateMigrationRunAttestation,
  verifyMigrationManualAttestation,
  type LegacyHostMappingApproval,
  type MigrationApprovalTrustAnchor,
  type MigrationEvidenceFile,
  type MigrationManualAttestation,
  type MigrationPreflightApproval,
  type MigrationRunAuthorization,
  type MigrationSafetyEvidence,
  type MigrationSafetyRuntimeContext,
} from "./migration/authorization.ts";

export const EXACT_TOKENIZER_SCRIPT = path.resolve(import.meta.dir, "../scripts/exact-tokenizer.py");
export { MAX_EVALUATION_CANDIDATE_DOCUMENTS } from "./embeddings/backfill.ts";
/** @deprecated compatibility name; the library-owned ceiling is authoritative. */
export const MAX_EVALUATION_JOBS_PER_SPACE = MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE;
export const MAX_GENERIC_EMBEDDING_LIMIT = BATCH_SIZE;

export function exactTokenizerCommandOptions(model: string) {
  if (!model.trim()) throw new Error("--model не может быть пустым");
  return {
    executable: "uv",
    args: ["run", "--quiet", "--offline", "--script", EXACT_TOKENIZER_SCRIPT],
    id: EXACT_TOKENIZER_ID,
    model,
    requireOffline: true,
  } as const;
}

export function assertBoundedPaidEmbeddingOptions(options: {
  allowPaidApi?: boolean;
  space?: string;
  limit?: number;
}): asserts options is { allowPaidApi: true; space: string; limit: number } {
  if (options.allowPaidApi !== true) {
    throw new Error("paid embedding operation требует --allow-paid-api");
  }
  if (!options.space?.trim()) throw new Error("paid embedding operation требует --space");
  if (!Number.isSafeInteger(options.limit) || options.limit! < 1) {
    throw new Error("paid embedding operation требует положительный --limit");
  }
  if (options.limit! > MAX_GENERIC_EMBEDDING_LIMIT) {
    throw new Error(`--limit должен быть <= ${MAX_GENERIC_EMBEDDING_LIMIT}`);
  }
}

export function assertGenericEmbeddingRunDisabled(options: {
  allowPaidApi?: boolean;
  space?: string;
  limit?: number;
}): never {
  assertBoundedPaidEmbeddingOptions(options);
  throw new Error(
    "generic embeddings run не имеет Stage 11 authorization; используйте embeddings candidates run или embeddings backfill run",
  );
}

export function parsePositiveInteger(value: string, flag = "значение"): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag}: ожидалось целое число > 0`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag}: число слишком велико`);
  return parsed;
}

export function parseNonNegativeInteger(value: string, flag = "значение"): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag}: ожидалось целое число >= 0`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag}: число слишком велико`);
  return parsed;
}

export function parseNonNegativeNumber(value: string, flag = "значение"): number {
  if (value.trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`${flag}: ожидалось число >= 0`);
  }
  return Number(value);
}

/** CLI seam: pins are explicit operator inputs and are never derived from evidence/file. */
export async function pinCliExpectedJudgmentArtifact(options: {
  judgments: string;
  judgmentsSha256: string;
  judgmentsSizeBytes: number;
}) {
  return pinExpectedJudgmentArtifact(
    options.judgments,
    options.judgmentsSha256,
    options.judgmentsSizeBytes,
  );
}

export function parseCsv(value: string, flag = "значение"): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${flag}: список пуст`);
  return [...new Set(values)];
}

export function parseParserVersion(value: string): "latest" | number {
  return value === "latest" ? value : parsePositiveInteger(value, "--parser-version");
}

export function assertDoctorCliSafety(options: {
  apply?: boolean;
  allowDestructive?: boolean;
  removeStaleStaging?: boolean;
  rebuildSearchProjection?: boolean;
  repairManifest?: boolean;
}): void {
  const destructiveRequested =
    options.removeStaleStaging || options.rebuildSearchProjection || options.repairManifest;
  if (options.apply && destructiveRequested && !options.allowDestructive) {
    throw new Error(
      "destructive doctor actions требуют --allow-destructive до любых repair writes",
    );
  }
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseDate(value: string | undefined, flag: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${flag}: некорректная дата "${value}"`);
  return date;
}

function operationLogger(logger: StructuredLogger): (input: Record<string, unknown>) => void {
  return (input) => {
    const rawEvent = input.event;
    const event = typeof rawEvent === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(rawEvent)
      ? rawEvent
      : "operation_event";
    const { event: _event, ...fields } = input;
    logger.info(event, fields);
  };
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writePrivateFileAtomicNoClobber(
    path.resolve(filePath),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

export const MIGRATION_PLAN_LOCK_COMMAND = "migration plan";

export interface MigrationPlanArchiveSafetyDependencies {
  assertPreflight: (cfg: AppConfig) => Promise<void>;
  acquireLock: (archiveRoot: string, command: string) => Promise<() => Promise<void>>;
}

/**
 * Guard the complete migration-plan write window: legacy snapshot copy,
 * analysis checkpoint and final report. Preflight intentionally runs before
 * lock acquisition because it checks for an existing live process lock; the
 * atomic acquire closes the race before the first durable write.
 */
export async function withMigrationPlanArchiveSafety<T>(
  cfg: AppConfig,
  operation: () => Promise<T>,
  dependencies: MigrationPlanArchiveSafetyDependencies = {
    assertPreflight,
    acquireLock,
  },
): Promise<T> {
  await dependencies.assertPreflight(cfg);
  const release = await dependencies.acquireLock(
    cfg.archiveRoot,
    MIGRATION_PLAN_LOCK_COMMAND,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

/** Testable seam preserving `migration plan --skip-live` exactly. */
export async function probeMigrationPlanLiveCorpus(
  cfg: AppConfig,
  skipLive: boolean | undefined,
  probe: (cfg: AppConfig) => Promise<LiveCorpusProbe> = probeLiveCorpus,
): Promise<LiveCorpusProbe | undefined> {
  return skipLive ? undefined : await probe(cfg);
}

export async function persistRestoreTestReport(
  archiveRoot: string,
  report: RestoreTestReport,
  options: { runId: string; now?: Date; suffix?: string },
): Promise<{
  reportPath: string;
  persisted: PersistedRestoreTestReport;
  artifact: MigrationEvidenceFile & { ok: true };
}> {
  if (report.ok !== true || !isRestoreNamespace(report.namespace)) {
    throw new Error("successful restore report required for persistence");
  }
  const now = options.now ?? new Date();
  const suffix = options.suffix ?? randomUUID().slice(0, 8);
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(suffix)) throw new Error("restore report suffix невалиден");
  // Preserve runtime-only keys in the assembled candidate so the exact parser
  // can reject them. Only its normalized, field-exact result may reach disk.
  const persisted = parsePersistedRestoreTestReport({
    ...report,
    createdAt: now.toISOString(),
    runId: options.runId,
  });
  const reportPath = path.join(
    archiveRoot,
    "backups",
    "manifests",
    `restore-test-${backupTimestamp(now)}-${suffix}.json`,
  );
  await writePrivateJsonAtomic(reportPath, persisted);
  const hashed = await hashFile(reportPath);
  return {
    reportPath,
    persisted,
    artifact: {
      path: reportPath,
      sha256: hashed.sha256,
      sizeBytes: hashed.sizeBytes,
      createdAt: persisted.createdAt,
      ok: true,
    },
  };
}

export async function persistRestoreTestFailureReport(
  archiveRoot: string,
  report: RestoreTestFailureEvidence,
  options: { now?: Date } = {},
): Promise<{ reportPath: string; artifact: MigrationEvidenceFile }> {
  if (report.ok !== false || !isRestoreNamespace(report.namespace)) {
    throw new Error("restore failure evidence invalid");
  }
  const attemptId = report.attemptId.toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(attemptId)) throw new Error("restore attempt id invalid");
  const now = options.now ?? new Date();
  const reportPath = path.join(
    archiveRoot,
    "backups",
    "manifests",
    `restore-test-failure-${backupTimestamp(now)}-${attemptId.slice(0, 12)}.json`,
  );
  await writePrivateJsonAtomic(reportPath, report);
  const hashed = await hashFile(reportPath);
  return {
    reportPath,
    artifact: {
      path: reportPath,
      sha256: hashed.sha256,
      sizeBytes: hashed.sizeBytes,
      createdAt: report.startedAt,
    },
  };
}

export interface VerifiedFreshBackup {
  manifestSha256: string;
}

/**
 * Independently authenticate the fresh backup before the restore drill.
 * Paths and file contents never cross the structured logger seam.
 */
export async function verifyFreshBackup(
  cfg: AppConfig,
  backup: BackupResult,
): Promise<VerifiedFreshBackup> {
  const exportPath = await assertRegularNonSymlinkFile(backup.exportPath, "migration safety export");
  const manifestPath = await assertRegularNonSymlinkFile(
    backup.manifestPath,
    "migration safety manifest",
  );
  if (path.resolve(manifestPathForExport(exportPath)) !== path.resolve(manifestPath)) {
    throw new Error("migration safety backup export/manifest path binding mismatch");
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseBackupManifest(JSON.parse(manifestText), "migration safety manifest");
  if (JSON.stringify(manifest) !== JSON.stringify(backup.manifest)) {
    throw new Error("migration safety backup manifest differs from returned manifest");
  }
  if (
    manifest.namespace !== cfg.surrealNamespace ||
    manifest.database !== cfg.surrealDatabase ||
    manifest.exportFile !== path.basename(exportPath)
  ) {
    throw new Error("migration safety backup does not identify the current live database/export");
  }
  const exportHashes = await hashFile(exportPath);
  if (
    exportHashes.sizeBytes !== manifest.exportBytes ||
    exportHashes.sha256 !== manifest.exportSha256
  ) {
    throw new Error("migration safety backup export integrity mismatch");
  }
  return { manifestSha256: (await hashFile(manifestPath)).sha256 };
}

export function assertRestoreAuthenticatesBackup(
  cfg: AppConfig,
  backup: BackupResult,
  verified: VerifiedFreshBackup,
  restore: RestoreTestReport,
): void {
  if (
    restore.ok !== true ||
    !isRestoreNamespace(restore.namespace) ||
    restore.exportFile !== backup.manifest.exportFile ||
    restore.exportBytes !== backup.manifest.exportBytes ||
    restore.exportSha256 !== backup.manifest.exportSha256 ||
    restore.manifestFile !== path.basename(backup.manifestPath) ||
    restore.manifestSha256 !== verified.manifestSha256 ||
    path.resolve(restore.rawArchiveRoot) !== path.resolve(cfg.archiveRoot) ||
    restore.checks.length === 0 ||
    restore.checks.some((check) => check.ok !== true)
  ) {
    throw new Error("migration safety restore report is not bound to the fresh authenticated backup");
  }
  const successfulChecks = new Set(
    restore.checks.filter((check) => check.ok).map((check) => check.name),
  );
  for (const required of ["record_counts", "raw references"]) {
    if (!successfulChecks.has(required)) {
      throw new Error(`migration safety restore report missing required check: ${required}`);
    }
  }
  if (backup.manifest.rawManifestSha256 && !successfulChecks.has("raw manifest hash")) {
    throw new Error("migration safety restore report missing required raw manifest hash check");
  }
}

export type MigrationSafetyStage =
  | "preconditions"
  | "operator_approval"
  | "snapshot_evidence"
  | "host_mapping_evidence"
  | "live_probe_evidence"
  | "report_target"
  | "logical_backup"
  | "backup_integrity"
  | "restore_drill"
  | "restore_binding"
  | "restore_report_persist"
  | "safety_evidence"
  | "migration_runner";

/** Safe outer error: cause can contain private paths/content but message never does. */
export class MigrationSafetyGateError extends Error {
  constructor(readonly stage: MigrationSafetyStage, cause: unknown) {
    super(`migration safety gate failed: ${stage}`, { cause });
    this.name = "MigrationSafetyGateError";
  }
}

export interface MigrationBackupGateDependencies<T> {
  backup(cfg: AppConfig): Promise<BackupResult>;
  verify(cfg: AppConfig, backup: BackupResult): Promise<VerifiedFreshBackup>;
  restore(cfg: AppConfig, options: RestoreTestOptions): Promise<RestoreTestReport>;
  persist(
    archiveRoot: string,
    report: RestoreTestReport,
    options: { runId: string },
  ): Promise<{
    reportPath: string;
    persisted: PersistedRestoreTestReport;
    artifact: MigrationEvidenceFile & { ok: true };
  }>;
  loadSafety(input: {
    exportPath: string;
    restoreReportPath: string;
  }): Promise<MigrationSafetyEvidence>;
  runner(evidence: MigrationSafetyEvidence): Promise<T>;
  emit?: (event: Record<string, unknown>) => void;
}

export interface MigrationBackupGateResult<T> {
  result: T;
  backup: BackupResult;
  restore: RestoreTestReport;
  restoreReportPath: string;
  restoreArtifact: MigrationEvidenceFile & { ok: true };
  safety: MigrationSafetyEvidence;
}

async function migrationSafetyStage<T>(
  stage: MigrationSafetyStage,
  operation: () => Promise<T>,
  emit?: (event: Record<string, unknown>) => void,
): Promise<T> {
  emit?.({ event: "migration_safety_stage", stage, status: "started" });
  try {
    const result = await operation();
    emit?.({ event: "migration_safety_stage", stage, status: "completed" });
    return result;
  } catch (error) {
    emit?.({ event: "migration_safety_stage", stage, status: "failed" });
    throw error instanceof MigrationSafetyGateError
      ? error
      : new MigrationSafetyGateError(stage, error);
  }
}

/**
 * Caller owns one process lock around this entire sequence. Dependencies are
 * deliberately lock-free library APIs; runner is unreachable until the
 * authenticated restore report is durably published without clobbering.
 */
export async function runMigrationAfterBackupGate<T>(
  cfg: AppConfig,
  runId: string,
  dependencies: MigrationBackupGateDependencies<T>,
): Promise<MigrationBackupGateResult<T>> {
  const backup = await migrationSafetyStage(
    "logical_backup",
    () => dependencies.backup(cfg),
    dependencies.emit,
  );
  const verified = await migrationSafetyStage(
    "backup_integrity",
    () => dependencies.verify(cfg, backup),
    dependencies.emit,
  );
  const restore = await migrationSafetyStage(
    "restore_drill",
    () => dependencies.restore(cfg, {
      exportPath: backup.exportPath,
      rawArchiveRoot: cfg.archiveRoot,
    }),
    dependencies.emit,
  );
  await migrationSafetyStage(
    "restore_binding",
    async () => assertRestoreAuthenticatesBackup(cfg, backup, verified, restore),
    dependencies.emit,
  );
  const persisted = await migrationSafetyStage(
    "restore_report_persist",
    async () => {
      const publication = await dependencies.persist(cfg.archiveRoot, restore, { runId });
      const durable = publication.persisted;
      if (
        !publication.reportPath ||
        path.resolve(publication.artifact.path) !== path.resolve(publication.reportPath) ||
        !/^[a-f0-9]{64}$/u.test(publication.artifact.sha256) ||
        !Number.isSafeInteger(publication.artifact.sizeBytes) ||
        publication.artifact.sizeBytes < 1 ||
        publication.artifact.createdAt !== durable.createdAt ||
        publication.artifact.ok !== true ||
        durable.runId !== runId ||
        durable.ok !== true ||
        durable.exportFile !== restore.exportFile ||
        durable.exportBytes !== restore.exportBytes ||
        durable.exportSha256 !== restore.exportSha256 ||
        durable.manifestFile !== restore.manifestFile ||
        durable.manifestSha256 !== restore.manifestSha256
      ) {
        throw new Error("migration safety persisted restore report binding mismatch");
      }
      return publication;
    },
    dependencies.emit,
  );
  const safety = await migrationSafetyStage(
    "safety_evidence",
    async () => {
      const evidence = await dependencies.loadSafety({
        exportPath: backup.exportPath,
        restoreReportPath: persisted.reportPath,
      });
      if (
        path.resolve(evidence.backup.path) !== path.resolve(backup.exportPath) ||
        evidence.backup.sha256 !== backup.manifest.exportSha256 ||
        evidence.backup.sizeBytes !== backup.manifest.exportBytes ||
        path.resolve(evidence.restore.path) !== path.resolve(persisted.reportPath) ||
        evidence.restore.sha256 !== persisted.artifact.sha256 ||
        evidence.restore.sizeBytes !== persisted.artifact.sizeBytes ||
        evidence.restore.ok !== true
      ) throw new Error("migration safety evidence differs from fresh backup/restore artifacts");
      return evidence;
    },
    dependencies.emit,
  );
  const result = await migrationSafetyStage(
    "migration_runner",
    () => dependencies.runner(safety),
    dependencies.emit,
  );
  return {
    result,
    backup,
    restore,
    restoreReportPath: persisted.reportPath,
    restoreArtifact: persisted.artifact,
    safety,
  };
}

export interface MigrationPreBackupGateDependencies<Approval, Snapshot, Mapping, Live> {
  loadApproval(): Promise<Approval>;
  verifySnapshot(approval: Approval): Promise<Snapshot>;
  verifyHostMapping(approval: Approval, snapshot: Snapshot): Promise<Mapping>;
  verifyLiveEvidence(
    approval: Approval,
    snapshot: Snapshot,
    mapping: Mapping,
  ): Promise<Live>;
  verifyReportTarget(): Promise<void>;
  emit?: (event: Record<string, unknown>) => void;
}

export async function runMigrationPreBackupGate<Approval, Snapshot, Mapping, Live>(
  dependencies: MigrationPreBackupGateDependencies<Approval, Snapshot, Mapping, Live>,
): Promise<{ approval: Approval; snapshot: Snapshot; mapping: Mapping; live: Live }> {
  const approval = await migrationSafetyStage(
    "operator_approval",
    dependencies.loadApproval,
    dependencies.emit,
  );
  const snapshot = await migrationSafetyStage(
    "snapshot_evidence",
    () => dependencies.verifySnapshot(approval),
    dependencies.emit,
  );
  const mapping = await migrationSafetyStage(
    "host_mapping_evidence",
    () => dependencies.verifyHostMapping(approval, snapshot),
    dependencies.emit,
  );
  const live = await migrationSafetyStage(
    "live_probe_evidence",
    () => dependencies.verifyLiveEvidence(approval, snapshot, mapping),
    dependencies.emit,
  );
  await migrationSafetyStage(
    "report_target",
    dependencies.verifyReportTarget,
    dependencies.emit,
  );
  return { approval, snapshot, mapping, live };
}

function assertLowerSha256(value: string, flag: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${flag}: требуется lowercase SHA-256`);
}

export interface StableCliArtifact {
  path: string;
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
}

/** O_NOFOLLOW loader used before any migration writer connection is opened. */
export async function readStableMigrationCliArtifact(
  filePath: string,
  label: string,
): Promise<StableCliArtifact> {
  const resolved = path.resolve(filePath);
  const descriptor = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat();
    const linked = await lstat(resolved);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size ||
      linked.isSymbolicLink() || !linked.isFile() || linked.dev !== after.dev ||
      linked.ino !== after.ino || linked.size !== after.size || linked.mtimeMs !== after.mtimeMs
    ) throw new Error(`${label} changed while reading`);
    return {
      path: resolved,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    };
  } finally {
    await descriptor.close();
  }
}

function exactMigrationArtifactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  onlyKeys(value, [...required, ...optional], label);
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`${label}: отсутствуют поля ${missing.join(", ")}`);
}

function parseMigrationPreflightApprovalArtifact(value: unknown): MigrationPreflightApproval {
  const raw = plainObject(value, "migration preflight approval");
  exactMigrationArtifactKeys(raw, [
    "kind", "formatVersion", "approvedAt", "approvedBy", "evidence",
    "evidenceSha256", "artifactSha256",
  ], [], "migration preflight approval");
  const evidence = plainObject(raw.evidence, "migration preflight approval.evidence");
  exactMigrationArtifactKeys(evidence, [
    "snapshotSha256", "snapshotSizeBytes", "checkRawFiles", "tableTotals", "problems",
    "liveProbe", "expectedDeletedCount", "hostMappingArtifactSha256",
  ], [], "migration preflight approval.evidence");
  if (
    !Number.isSafeInteger(evidence.snapshotSizeBytes) || (evidence.snapshotSizeBytes as number) < 1 ||
    typeof evidence.checkRawFiles !== "boolean" ||
    !Number.isSafeInteger(evidence.expectedDeletedCount) ||
    (evidence.expectedDeletedCount as number) < 0
  ) throw new Error("migration preflight approval evidence scalar fields invalid");
  const liveProbe = plainObject(evidence.liveProbe, "migration preflight approval.evidence.liveProbe");
  exactMigrationArtifactKeys(
    liveProbe,
    ["available", "revisionSha256", "dialogueKeys"],
    ["note"],
    "migration preflight approval.evidence.liveProbe",
  );
  if (
    liveProbe.available !== true || !Array.isArray(liveProbe.revisionSha256) ||
    !Array.isArray(liveProbe.dialogueKeys) ||
    !(liveProbe.revisionSha256 as unknown[]).every((item) =>
      typeof item === "string" && /^[a-f0-9]{64}$/u.test(item)) ||
    !(liveProbe.dialogueKeys as unknown[]).every((item) => typeof item === "string" && item.length > 0) ||
    (liveProbe.note !== undefined && typeof liveProbe.note !== "string")
  ) throw new Error("migration preflight approval live probe invalid");
  if (!Array.isArray(evidence.problems)) {
    throw new Error("migration preflight approval problems must be an array");
  }
  for (const [index, item] of evidence.problems.entries()) {
    const problem = plainObject(item, `migration preflight approval problems[${index}]`);
    exactMigrationArtifactKeys(
      problem,
      ["table", "recordId", "reason"],
      [],
      `migration preflight approval problems[${index}]`,
    );
    if ([problem.table, problem.recordId, problem.reason].some((field) =>
      typeof field !== "string" || field.length === 0)) {
      throw new Error(`migration preflight approval problems[${index}] invalid`);
    }
  }
  const approval = raw as unknown as MigrationPreflightApproval;
  validateMigrationPreflightApproval(approval);
  return approval;
}

function parseHostMappingApprovalArtifact(value: unknown): LegacyHostMappingApproval {
  const raw = plainObject(value, "host mapping approval");
  onlyKeys(
    raw,
    ["kind", "formatVersion", "snapshotSha256", "mappings", "assignments", "artifactSha256"],
    "host mapping approval",
  );
  if (raw.kind !== "baka-legacy-host-mapping-approval" || raw.formatVersion !== 1) {
    throw new Error("unsupported host mapping approval artifact");
  }
  if (typeof raw.snapshotSha256 !== "string") {
    throw new Error("host mapping approval snapshotSha256 missing");
  }
  assertLowerSha256(raw.snapshotSha256, "host mapping approval snapshotSha256");
  if (typeof raw.artifactSha256 !== "string") {
    throw new Error("host mapping approval artifactSha256 missing");
  }
  assertLowerSha256(raw.artifactSha256, "host mapping approval artifactSha256");
  const mappings = parseApprovedHostMappings(raw.mappings);
  if (!Array.isArray(raw.assignments)) throw new Error("host mapping approval assignments missing");
  const assignments = raw.assignments.map((item, index) => {
    const assignment = plainObject(item, `host mapping approval assignments[${index}]`);
    onlyKeys(
      assignment,
      ["table", "legacyId", "mappingId", "basis"],
      `host mapping approval assignments[${index}]`,
    );
    if (!(["projects", "source_files", "threads"] as unknown[]).includes(assignment.table)) {
      throw new Error(`host mapping approval assignments[${index}].table invalid`);
    }
    if (!(["explicit", "path", "source_relation", "project_relation"] as unknown[])
      .includes(assignment.basis)) {
      throw new Error(`host mapping approval assignments[${index}].basis invalid`);
    }
    return {
      table: assignment.table as "projects" | "source_files" | "threads",
      legacyId: requiredMappingString(
        assignment.legacyId,
        `host mapping approval assignments[${index}].legacyId`,
      ),
      mappingId: requiredMappingString(
        assignment.mappingId,
        `host mapping approval assignments[${index}].mappingId`,
      ),
      basis: assignment.basis as "explicit" | "path" | "source_relation" | "project_relation",
    };
  });
  const body = {
    kind: "baka-legacy-host-mapping-approval" as const,
    formatVersion: 1 as const,
    snapshotSha256: raw.snapshotSha256,
    mappings,
    assignments,
  };
  if (migrationArtifactSha256(body) !== raw.artifactSha256) {
    throw new Error("host mapping approval artifact SHA mismatch");
  }
  return { ...body, artifactSha256: raw.artifactSha256 };
}

export interface StrictMigrationCliArtifacts {
  approval: MigrationPreflightApproval;
  approvalFile: MigrationEvidenceFile;
  attestation: MigrationManualAttestation;
  attestationFile: StableCliArtifact;
  hostMapping: LegacyHostMappingApproval;
  hostMappingFile: StableCliArtifact;
  restoreReport: PersistedRestoreTestReport;
  restoreReportFile: StableCliArtifact;
  trustAnchor: MigrationApprovalTrustAnchor;
}

/** Pure CLI seam: strict parsing and trust pinning, with no DB/archive writes. */
export async function loadStrictMigrationCliArtifacts(input: {
  approvalPath: string;
  attestationPath: string;
  hostMappingApprovalPath: string;
  restoreReportPath: string;
  approvalPublicKeyPath: string;
  approvalKeySha256: string;
}): Promise<StrictMigrationCliArtifacts> {
  assertLowerSha256(input.approvalKeySha256, "--approval-key-sha256");
  const [approvalFile, attestationFile, hostMappingFile, restoreReportFile, keyFile] =
    await Promise.all([
      readStableMigrationCliArtifact(input.approvalPath, "migration approval artifact"),
      readStableMigrationCliArtifact(input.attestationPath, "migration detached attestation"),
      readStableMigrationCliArtifact(input.hostMappingApprovalPath, "host mapping approval artifact"),
      readStableMigrationCliArtifact(input.restoreReportPath, "persisted restore report"),
      readStableMigrationCliArtifact(input.approvalPublicKeyPath, "migration approval public key"),
    ]);
  const approval = parseMigrationPreflightApprovalArtifact(
    JSON.parse(approvalFile.bytes.toString("utf8")),
  );
  const attestation = parseMigrationManualAttestation(
    JSON.parse(attestationFile.bytes.toString("utf8")),
  );
  const hostMapping = parseHostMappingApprovalArtifact(
    JSON.parse(hostMappingFile.bytes.toString("utf8")),
  );
  const restoreReport = parsePersistedRestoreTestReport(
    JSON.parse(restoreReportFile.bytes.toString("utf8")),
  );
  const ed25519PublicKeyPem = keyFile.bytes.toString("utf8");
  if (migrationApprovalKeyFingerprint(ed25519PublicKeyPem) !== input.approvalKeySha256) {
    throw new Error("migration approval public key does not match independently pinned SHA-256");
  }
  if (
    hostMapping.artifactSha256 !== approval.evidence.hostMappingArtifactSha256 ||
    hostMapping.snapshotSha256 !== approval.evidence.snapshotSha256
  ) throw new Error("host mapping approval is not bound to exact preflight approval");
  verifyMigrationManualAttestation({
    attestation,
    approval,
    approvalFileSha256: approvalFile.sha256,
    trustAnchor: { ed25519PublicKeyPem, sha256Fingerprint: input.approvalKeySha256 },
  });
  return {
    approval,
    approvalFile: {
      path: approvalFile.path,
      sha256: approvalFile.sha256,
      sizeBytes: approvalFile.sizeBytes,
      createdAt: approval.approvedAt,
    },
    attestation,
    attestationFile,
    hostMapping,
    hostMappingFile,
    restoreReport,
    restoreReportFile,
    trustAnchor: { ed25519PublicKeyPem, sha256Fingerprint: input.approvalKeySha256 },
  };
}

/** Dependency seam proving malformed/untrusted inputs cannot select a writer. */
export async function runStrictMigrationCliArtifactGate<T>(
  input: Parameters<typeof loadStrictMigrationCliArtifacts>[0],
  runner: (artifacts: StrictMigrationCliArtifacts) => Promise<T>,
): Promise<T> {
  return runner(await loadStrictMigrationCliArtifacts(input));
}

/** Source environment authority comes exclusively from live application config. */
export function migrationSafetyContextFromConfig(
  cfg: Pick<AppConfig, "surrealNamespace" | "surrealDatabase" | "archiveRoot">,
  schemaVersion: number,
  restoreNamespace: string,
): MigrationSafetyRuntimeContext {
  return {
    schemaVersion,
    sourceNamespace: cfg.surrealNamespace,
    sourceDatabase: cfg.surrealDatabase,
    restoreNamespace,
    archiveRoot: path.resolve(cfg.archiveRoot),
  };
}

export async function loadConfiguredMigrationSafetyEvidence(input: {
  cfg: Pick<AppConfig, "surrealNamespace" | "surrealDatabase" | "archiveRoot">;
  schemaVersion: number;
  restoreReport: PersistedRestoreTestReport;
  restoreReportPath: string;
}): Promise<{ safety: MigrationSafetyEvidence; context: MigrationSafetyRuntimeContext }> {
  const context = migrationSafetyContextFromConfig(
    input.cfg,
    input.schemaVersion,
    input.restoreReport.namespace,
  );
  if (
    input.restoreReport.schemaVersion !== input.schemaVersion ||
    input.restoreReport.database !== input.cfg.surrealDatabase ||
    input.restoreReport.archiveRoot !== context.archiveRoot
  ) throw new Error("persisted restore report does not match current schema/database/archiveRoot");
  const safety = await loadMigrationSafetyEvidence({
    exportPath: input.restoreReport.exportPath,
    restoreReportPath: input.restoreReportPath,
    context,
  });
  return { safety, context };
}

/** Test seam proving configured safety failure occurs before writer selection. */
export async function runConfiguredMigrationSafetyCliGate<T>(
  input: Parameters<typeof loadConfiguredMigrationSafetyEvidence>[0],
  runner: (prepared: Awaited<ReturnType<typeof loadConfiguredMigrationSafetyEvidence>>) => Promise<T>,
): Promise<T> {
  return runner(await loadConfiguredMigrationSafetyEvidence(input));
}

async function assertMigrationReportTargetAvailable(reportPath: string): Promise<void> {
  try {
    await lstat(reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("migration report target already exists");
}

async function verifyFreshMigrationApprovalEvidence(
  snapshotPath: string,
  snapshotSha256: string,
  approval: MigrationPreflightApproval,
  currentLiveProbe: LiveCorpusProbe,
): Promise<void> {
  const evidence = approval.evidence;
  const analysis = await analyzeLegacySnapshot(
    snapshotPath,
    APPROVAL_ANALYSIS_IDENTITY,
    { snapshotSha256, checkRawFiles: evidence.checkRawFiles },
  );
  if (!analysis.reconciliation.ok || analysis.reconciliation.lost !== 0) {
    throw new Error("fresh migration analysis lost legacy rows");
  }
  for (const [table, expected] of Object.entries(evidence.tableTotals)) {
    if (analysis.reconciliation.tables[table]?.total !== expected) {
      throw new Error("migration approval table totals are stale");
    }
  }
  if (analysis.deletedInSource !== evidence.expectedDeletedCount) {
    throw new Error("migration approval deleted count is stale");
  }
  if (
    migrationArtifactSha256(canonicalProblems(analysis.problems)) !==
    migrationArtifactSha256(canonicalProblems(evidence.problems))
  ) throw new Error("migration approval problem set is stale");
  if (
    canonicalMigrationJson(canonicalLiveProbe(currentLiveProbe)) !==
    canonicalMigrationJson(evidence.liveProbe)
  ) throw new Error("migration approval live probe is stale");
}

async function loadExactReport(filePath: string): Promise<ExactTokenCountReport> {
  let report: ExactTokenCountReport;
  try {
    report = JSON.parse(await readFile(filePath, "utf8")) as ExactTokenCountReport;
  } catch {
    throw new Error("не удалось прочитать private exact token report");
  }
  validateExactTokenCountReport(report);
  return report;
}

async function loadAcceptedRelevance(filePath: string): Promise<AcceptedRelevanceEvidence> {
  let evidence: AcceptedRelevanceEvidence;
  try {
    evidence = JSON.parse(await readFile(filePath, "utf8")) as AcceptedRelevanceEvidence;
  } catch {
    throw new Error("не удалось прочитать private accepted relevance evidence");
  }
  if (evidence?.formatVersion !== 2) {
    throw new Error("accepted relevance evidence требует formatVersion 2");
  }
  return evidence;
}

async function loadAcceptedFullCorpusRelevance(
  filePath: string,
): Promise<AcceptedFullCorpusRelevanceEvidence> {
  let evidence: AcceptedFullCorpusRelevanceEvidence;
  try {
    evidence = JSON.parse(await readFile(filePath, "utf8")) as AcceptedFullCorpusRelevanceEvidence;
  } catch {
    throw new Error("не удалось прочитать private full-corpus relevance evidence");
  }
  if (evidence?.formatVersion !== 1) {
    throw new Error("full-corpus relevance evidence требует formatVersion 1");
  }
  return evidence;
}

async function loadEvaluationResources(
  filePath: string,
): Promise<Record<string, EvaluationResourceMeasurements>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("не удалось прочитать private resource measurements artifact");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--resource-measurements: ожидался JSON object keyed by space slug");
  }
  return parsed as Record<string, EvaluationResourceMeasurements>;
}

const PRIVACY_EXCLUSION_CODE =
  /^privacy_excluded_(?:harness|workspace|document_type|document_size|policy)$/u;
const PERMANENT_EXCLUSION_CODE =
  /^provider_(?:permanent_error|retry_exhausted|unexpected_error)$|^(?:vector_dimension_mismatch|provider_vector_count_mismatch) expected=\d+ actual=\d+$|^(?:search_document_missing|permanent_error_detail_redacted)$/u;

/** Strict data-only CLI boundary for row-level Stage 11 exclusion evidence. */
export function parseEvaluationExclusions(
  value: unknown,
): Record<string, readonly EvaluationReadinessExclusion[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--documented-exclusions: ожидался JSON object keyed by space slug");
  }
  const parsed: Record<string, EvaluationReadinessExclusion[]> = {};
  for (const [slug, rows] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!SLUG_RE.test(slug) || !Array.isArray(rows)) {
      throw new Error("--documented-exclusions: invalid space entry");
    }
    const jobIds = new Set<string>();
    const documentIds = new Set<string>();
    parsed[slug] = rows.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`--documented-exclusions ${slug}[${index}]: ожидался exact object`);
      }
      const row = raw as Record<string, unknown>;
      const expectedKeys = ["category", "code", "jobId", "documentId", "evidence"];
      if (
        Object.keys(row).length !== expectedKeys.length ||
        expectedKeys.some((key) => !Object.hasOwn(row, key))
      ) {
        throw new Error(
          `--documented-exclusions ${slug}[${index}]: ` +
            "требуются только category/code/jobId/documentId/evidence; aggregate count запрещён",
        );
      }
      const category = row.category;
      const code = row.code;
      const jobId = row.jobId;
      const documentId = row.documentId;
      const evidence = row.evidence;
      const stableCode = category === "privacy"
        ? typeof code === "string" && PRIVACY_EXCLUSION_CODE.test(code)
        : category === "permanent"
        ? typeof code === "string" && PERMANENT_EXCLUSION_CODE.test(code)
        : false;
      if (
        !stableCode || typeof jobId !== "string" || !/^embedding_job:\S+$/u.test(jobId) ||
        typeof documentId !== "string" || !/^search_document:\S+$/u.test(documentId) ||
        typeof evidence !== "string" || evidence !== evidence.trim() || evidence.length < 1 ||
        evidence.length > 512 || /[\r\n\u0000-\u001f]/u.test(evidence) ||
        jobIds.has(jobId) || documentIds.has(documentId)
      ) {
        throw new Error(`--documented-exclusions ${slug}[${index}]: invalid exact identity`);
      }
      jobIds.add(jobId);
      documentIds.add(documentId);
      return { category, code, jobId, documentId, evidence } as EvaluationReadinessExclusion;
    }).sort((a, b) => a.documentId.localeCompare(b.documentId) || a.jobId.localeCompare(b.jobId));
  }
  return parsed;
}

async function loadEvaluationExclusions(
  filePath: string,
): Promise<Record<string, readonly EvaluationReadinessExclusion[]>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("не удалось прочитать private documented exclusions artifact");
  }
  return parseEvaluationExclusions(value);
}

export function requiredJudgmentDialogueIds(set: RelevanceJudgmentSet): string[] {
  const ids = new Set<string>();
  for (const query of set.queries) {
    for (const expected of query.expectedDialogues) ids.add(expected.dialogueId);
    for (const snippet of query.expectedSnippets) {
      if (snippet.dialogueId) ids.add(snippet.dialogueId);
    }
  }
  if (ids.size === 0) throw new Error("judgment set не содержит required dialogue ids");
  return [...ids].sort();
}

/** Exact normalization shared by every Stage 11 CLI artifact boundary. */
export function normalizedEmbeddingPrivacy(
  policy: AppConfig["embeddings"],
): PrivacyPolicy {
  return {
    excludeHarnesses: [...policy.excludeHarnesses].sort(),
    excludeWorkspaces: [...policy.excludeWorkspaces].sort(),
    excludeDocumentTypes: [...policy.excludeDocumentTypes].sort(),
    maxDocumentBytes: policy.maxDocumentBytes,
  };
}

function assertExactExclusionSpaces(
  exclusions: Readonly<Record<string, readonly EvaluationReadinessExclusion[]>>,
  spaceSlugs: readonly string[],
): void {
  const actual = Object.keys(exclusions).sort();
  const expected = [...spaceSlugs].sort();
  if (canonicalMigrationJson(actual) !== canonicalMigrationJson(expected)) {
    throw new Error("--documented-exclusions должен содержать exact entry для каждого selected space");
  }
}

export function boundedCandidateOptions(input: {
  privacy: AppConfig["embeddings"];
  spaces: string[];
  maxDocuments: number;
  maxJobsPerSpace: number;
  selectionSeedSha256: string;
  judgmentSet: RelevanceJudgmentSet;
}): EvaluationCandidatePlanOptions {
  if (input.spaces.length !== 3 || new Set(input.spaces).size !== 3) {
    throw new Error("candidate flow требует ровно три distinct spaces из §13.2");
  }
  if (
    !Number.isSafeInteger(input.maxDocuments) || input.maxDocuments < 1 ||
    input.maxDocuments > MAX_EVALUATION_CANDIDATE_DOCUMENTS
  ) {
    throw new Error(`--max-documents должен быть 1..${MAX_EVALUATION_CANDIDATE_DOCUMENTS}`);
  }
  if (
    !Number.isSafeInteger(input.maxJobsPerSpace) || input.maxJobsPerSpace < 1 ||
    input.maxJobsPerSpace > MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE ||
    input.maxJobsPerSpace > input.maxDocuments
  ) {
    throw new Error(
      `--max-jobs-per-space должен быть 1..min(max-documents, ${MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE})`,
    );
  }
  assertLowerSha256(input.selectionSeedSha256, "--selection-seed-sha256");
  return {
    privacy: normalizedEmbeddingPrivacy(input.privacy),
    spaceSlugs: input.spaces,
    maxDocuments: input.maxDocuments,
    maxJobsPerSpace: input.maxJobsPerSpace,
    selectionSeedSha256: input.selectionSeedSha256,
    requiredDialogueIds: requiredJudgmentDialogueIds(input.judgmentSet),
  };
}

export function requireEmbeddingPrice(price: number | undefined): number {
  if (price === undefined) {
    throw new Error(
      "production backfill требует OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS; CLI price override запрещён",
    );
  }
  return parseNonNegativeNumber(String(price), "OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS");
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: ожидался JSON object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label}: неизвестные поля ${unknown.join(", ")}`);
}

function requiredMappingString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 512) {
    throw new Error(`${label}: ожидалась непустая строка без внешних пробелов`);
  }
  return value;
}

function mappingIds(value: unknown, label: string): Array<string | number> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: ожидался непустой JSON array`);
  }
  const result = value.map((item, index) => {
    if (typeof item === "string" && item.trim() && item === item.trim()) return item;
    if (typeof item === "number" && Number.isSafeInteger(item)) return item;
    throw new Error(`${label}[${index}]: ожидался непустой string или safe integer`);
  });
  if (new Set(result.map(String)).size !== result.length) {
    throw new Error(`${label}: duplicate legacy ids`);
  }
  return result;
}

function mappingPaths(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: ожидался непустой JSON array`);
  }
  const result = value.map((item, index) => {
    const prefix = requiredMappingString(item, `${label}[${index}]`);
    if (!path.isAbsolute(prefix) || path.parse(prefix).root === prefix) {
      throw new Error(`${label}[${index}]: нужен абсолютный небазовый path prefix`);
    }
    return prefix;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label}: duplicate path prefixes`);
  return result;
}

function parseMappingHost(value: unknown, label: string): LocalIdentity {
  const host = plainObject(value, label);
  onlyKeys(
    host,
    ["hostUuid", "hostname", "platform", "arch", "osUsername", "homePath"],
    label,
  );
  const parsed = {
    hostUuid: requiredMappingString(host.hostUuid, `${label}.hostUuid`),
    hostname: requiredMappingString(host.hostname, `${label}.hostname`),
    platform: requiredMappingString(host.platform, `${label}.platform`),
    arch: requiredMappingString(host.arch, `${label}.arch`),
    osUsername: requiredMappingString(host.osUsername, `${label}.osUsername`),
    homePath: requiredMappingString(host.homePath, `${label}.homePath`),
  };
  if (!path.isAbsolute(parsed.homePath)) throw new Error(`${label}.homePath должен быть абсолютным`);
  return parsed;
}

/** Strict parser for the private, operator-approved §15.6 host mapping artifact. */
export function parseApprovedHostMappings(value: unknown): ApprovedLegacyHostMapping[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("host mappings: ожидался непустой JSON array");
  }
  const result = value.map((item, index) => {
    const label = `host mappings[${index}]`;
    const row = plainObject(item, label);
    onlyKeys(
      row,
      ["mappingId", "host", "sourceFileIds", "projectIds", "threadIds", "pathPrefixes"],
      label,
    );
    const mapping: ApprovedLegacyHostMapping = {
      mappingId: requiredMappingString(row.mappingId, `${label}.mappingId`),
      host: parseMappingHost(row.host, `${label}.host`),
      sourceFileIds: mappingIds(row.sourceFileIds, `${label}.sourceFileIds`),
      projectIds: mappingIds(row.projectIds, `${label}.projectIds`),
      threadIds: mappingIds(row.threadIds, `${label}.threadIds`),
      pathPrefixes: mappingPaths(row.pathPrefixes, `${label}.pathPrefixes`),
    };
    if (
      !mapping.sourceFileIds && !mapping.projectIds && !mapping.threadIds &&
      !mapping.pathPrefixes
    ) {
      throw new Error(`${label}: нужен хотя бы один explicit id selector или pathPrefixes`);
    }
    return mapping;
  });
  if (new Set(result.map((mapping) => mapping.mappingId)).size !== result.length) {
    throw new Error("host mappings: duplicate mappingId");
  }
  return result;
}

export async function loadApprovedHostMappings(
  filePath: string,
): Promise<ApprovedLegacyHostMapping[]> {
  let parsed: unknown;
  try {
    const resolved = await assertRegularNonSymlinkFile(filePath, "host mappings artifact");
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    throw new Error("не удалось прочитать private host mappings artifact");
  }
  return parseApprovedHostMappings(parsed);
}

export function assertMigrationApply(options: { apply?: boolean }): void {
  if (options.apply !== true) {
    throw new Error("migration run/retry изменяет новый архив и требует явный --apply");
  }
}

const program = new Command();

program
  .name("baka")
  .description("Локальный архив AI-диалогов: SurrealDB + immutable raw")
  .version("0.1.0");

function handle<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      console.error(`ошибка: ${error instanceof Error ? error.message : error}`);
      // Жёсткий exit: на путях ошибок могут остаться незакрытые ресурсы
      // (WS-соединение SurrealDB и т.п.), держащие event loop, — тогда
      // exitCode=1 не завершит процесс и зомби удержит sync lock
      // (live acceptance, этап 8).
      process.exit(1);
    }
  };
}

export const RESTORE_GRACEFUL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type RestoreGracefulSignal = (typeof RESTORE_GRACEFUL_SIGNALS)[number];

export interface RestoreSignalRuntime {
  on(signal: RestoreGracefulSignal, listener: () => void): void;
  off(signal: RestoreGracefulSignal, listener: () => void): void;
  terminate(signal: RestoreGracefulSignal): Promise<void> | void;
}

export class RestoreSignalTerminationError extends Error {
  constructor(readonly signal: RestoreGracefulSignal) {
    super(`restore:test terminated by ${signal}`);
    this.name = "RestoreSignalTerminationError";
  }
}

const RESTORE_SIGNAL_EXIT_CODES: Record<RestoreGracefulSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

const DEFAULT_RESTORE_SIGNAL_RUNTIME: RestoreSignalRuntime = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  terminate: async (signal) => {
    try {
      // Our scoped listener has already been removed, so the re-raised signal
      // regains the platform's conventional termination semantics.
      process.kill(process.pid, signal);
    } catch {
      process.exit(RESTORE_SIGNAL_EXIT_CODES[signal]);
    }
    // A pre-existing listener could consume the re-raised signal. Retain a
    // short bounded fallback to the conventional 128+signal exit status.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    process.exit(RESTORE_SIGNAL_EXIT_CODES[signal]);
  },
};

/**
 * Installs signal listeners only around one restore operation. Handlers do
 * nothing except abort once; validated DB cleanup remains inside runRestoreTest.
 */
export async function withRestoreTestSignalHandlers<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  runtime: RestoreSignalRuntime = DEFAULT_RESTORE_SIGNAL_RUNTIME,
): Promise<T> {
  const controller = new AbortController();
  let received: RestoreGracefulSignal | undefined;
  const listeners = new Map<RestoreGracefulSignal, () => void>();
  for (const signal of RESTORE_GRACEFUL_SIGNALS) {
    const listener = () => {
      if (received !== undefined) return;
      received = signal;
      controller.abort();
    };
    listeners.set(signal, listener);
    runtime.on(signal, listener);
  }

  let result: T | undefined;
  let operationError: unknown;
  let failed = false;
  try {
    result = await operation(controller.signal);
  } catch (error) {
    failed = true;
    operationError = error;
  } finally {
    for (const [signal, listener] of listeners) runtime.off(signal, listener);
  }

  if (received !== undefined) {
    await runtime.terminate(received);
    // Test runtimes return; the production runtime terminates the process.
    throw new RestoreSignalTerminationError(received);
  }
  if (failed) throw operationError;
  return result as T;
}

const PRODUCTION_CONTAINER_NAME = "baka-surrealdb";
const PRODUCTION_SURREAL_URL = "ws://127.0.0.1:8901/rpc";
const PRODUCTION_HOST_PORT = 8901;
const MAX_MAINTENANCE_OUTPUT_BYTES = 256 * 1024;

export interface ProductionContainerInspection {
  id: string;
  name: string;
  imageId: string;
  configImage: string;
  restartPolicy: string;
  mounts: Array<{
    Type?: string;
    Name?: string;
    Driver?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
  portBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  state: {
    Running?: boolean;
    Health?: { Status?: string };
  };
}

export interface ProductionCorpusBaseline {
  schemaVersion: number;
  dialogueCount: number;
  currentRevisionCount: number;
  currentRevisionSha256: string;
}

export type ProductionMaintenanceStage =
  | "preflight"
  | "stop"
  | "drill"
  | "restart"
  | "baseline";

/** Privacy-safe outer failure; raw Docker/DB/lsof diagnostics never escape. */
export class ProductionMaintenanceError extends Error {
  constructor(readonly stage: ProductionMaintenanceStage, readonly code: string) {
    super(`production maintenance failed: ${stage}/${code}`);
    this.name = "ProductionMaintenanceError";
  }
}

export interface ProductionMaintenanceDependencies {
  pinnedImage(): Promise<string>;
  inspectContainer(): Promise<ProductionContainerInspection>;
  archiveLocked(archiveRoot: string): Promise<boolean>;
  acquireMaintenanceLock(archiveRoot: string): Promise<() => Promise<void>>;
  activeProductionClients(): Promise<number>;
  captureBaseline(cfg: AppConfig): Promise<ProductionCorpusBaseline>;
  stopExact(containerId: string): Promise<void>;
  startExact(containerId: string, cfg: AppConfig): Promise<void>;
  waitUntilHealthy(
    containerId: string,
    cfg: AppConfig,
    pinnedImage: string,
  ): Promise<ProductionContainerInspection>;
}

async function readBoundedMaintenanceStream(
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (bytes + item.value.byteLength > MAX_MAINTENANCE_OUTPUT_BYTES) {
        stop();
        throw new Error("bounded process output exceeded");
      }
      chunks.push(item.value);
      bytes += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

export interface MaintenanceProcessHandle {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface MaintenanceProcessRuntime {
  spawn(executable: string, args: readonly string[]): MaintenanceProcessHandle;
  setDeadline(callback: () => void, milliseconds: number): unknown;
  clearDeadline(handle: unknown): void;
}

const DEFAULT_MAINTENANCE_PROCESS_RUNTIME: MaintenanceProcessRuntime = {
  spawn: (executable, args) => {
    const child = Bun.spawn({
      cmd: [executable, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      child.kill();
      throw new Error("maintenance process streams unavailable");
    }
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: () => child.kill(),
    };
  },
  setDeadline: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearDeadline: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function runMaintenanceProcess(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  runtime: MaintenanceProcessRuntime = DEFAULT_MAINTENANCE_PROCESS_RUNTIME,
): Promise<{ exitCode: number; stdout: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) {
    throw new Error("maintenance command deadline is invalid");
  }
  let child: MaintenanceProcessHandle;
  try {
    child = runtime.spawn(executable, args);
  } catch {
    return { exitCode: 127, stdout: "" };
  }
  const stop = () => child.kill();
  let timedOut = false;
  let deadlineHandle: unknown;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineHandle = runtime.setDeadline(() => {
      timedOut = true;
      stop();
      reject(new Error("maintenance command deadline expired"));
    }, timeoutMs);
  });
  try {
    const [exitCode, stdout] = await Promise.race([
      Promise.all([
        child.exited,
        readBoundedMaintenanceStream(child.stdout, stop),
        readBoundedMaintenanceStream(child.stderr, stop),
      ]),
      deadline,
    ]);
    return { exitCode, stdout };
  } catch {
    stop();
    let exitGraceHandle: unknown;
    await Promise.race([
      child.exited.catch(() => 1),
      new Promise<number>((resolve) => {
        exitGraceHandle = runtime.setDeadline(() => resolve(1), 5_000);
      }),
    ]);
    if (exitGraceHandle !== undefined) runtime.clearDeadline(exitGraceHandle);
    return { exitCode: timedOut ? 124 : 1, stdout: "" };
  } finally {
    if (deadlineHandle !== undefined) runtime.clearDeadline(deadlineHandle);
  }
}

const PRODUCTION_INSPECT_FORMAT =
  "{" +
  '"id":{{json .Id}},' +
  '"name":{{json .Name}},' +
  '"imageId":{{json .Image}},' +
  '"configImage":{{json .Config.Image}},' +
  '"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},' +
  '"mounts":{{json .Mounts}},' +
  '"portBindings":{{json .HostConfig.PortBindings}},' +
  '"state":{{json .State}}' +
  "}";

async function inspectProductionContainer(): Promise<ProductionContainerInspection> {
  const result = await runMaintenanceProcess("docker", [
    "container",
    "inspect",
    "--format",
    PRODUCTION_INSPECT_FORMAT,
    PRODUCTION_CONTAINER_NAME,
  ], 10_000);
  if (result.exitCode !== 0) throw new Error("production container inspection failed");
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as ProductionContainerInspection;
  } catch {
    throw new Error("production container inspection was not bounded JSON");
  }
}

export function validateProductionContainer(
  inspection: ProductionContainerInspection,
  cfg: AppConfig,
  pinnedImage: string,
  options: { requireHealthy: boolean; expectedId?: string },
): ProductionContainerInspection {
  const pinnedImageId = pinnedImage.match(/@(?<imageId>sha256:[0-9a-f]{64})$/u)
    ?.groups?.imageId;
  if (
    !/^[0-9a-f]{64}$/u.test(inspection.id) ||
    (options.expectedId !== undefined && inspection.id !== options.expectedId) ||
    inspection.name !== `/${PRODUCTION_CONTAINER_NAME}` ||
    pinnedImageId === undefined ||
    inspection.imageId !== pinnedImageId ||
    inspection.configImage !== pinnedImage ||
    inspection.restartPolicy !== "unless-stopped"
  ) {
    throw new Error("production container identity mismatch");
  }
  const expectedDataPath = path.resolve(cfg.dbRoot);
  const mountsByDestination = new Map(
    inspection.mounts?.map((mount) => [mount.Destination, mount]) ?? [],
  );
  const dataMount = mountsByDestination.get("/data/db");
  const anonymousData = mountsByDestination.get("/data");
  const anonymousLogs = mountsByDestination.get("/logs");
  const safeAnonymousVolume = (mount: typeof anonymousData): boolean =>
    mount?.Type === "volume" && mount.Driver === "local" && mount.RW === true &&
    /^[0-9a-f]{64}$/u.test(mount.Name ?? "");
  if (
    !Array.isArray(inspection.mounts) || inspection.mounts.length !== 3 ||
    mountsByDestination.size !== 3 ||
    dataMount?.Type !== "bind" || dataMount.RW !== true ||
    dataMount.Source !== expectedDataPath ||
    !safeAnonymousVolume(anonymousData) || !safeAnonymousVolume(anonymousLogs) ||
    anonymousData?.Name === anonymousLogs?.Name
  ) {
    throw new Error("production container data mount mismatch");
  }
  const bindings = inspection.portBindings?.["8000/tcp"];
  if (
    !Array.isArray(bindings) || bindings.length !== 1 ||
    bindings[0]?.HostIp !== "127.0.0.1" || bindings[0]?.HostPort !== "8901" ||
    Object.keys(inspection.portBindings).length !== 1
  ) {
    throw new Error("production container bind mismatch");
  }
  if (
    options.requireHealthy &&
    (inspection.state?.Running !== true || inspection.state.Health?.Status !== "healthy")
  ) {
    throw new Error("production container is not healthy");
  }
  return inspection;
}

async function activeProductionClientCount(): Promise<number> {
  const result = await runMaintenanceProcess("lsof", [
    "-nP",
    "-a",
    `-iTCP@127.0.0.1:${PRODUCTION_HOST_PORT}`,
    "-sTCP:ESTABLISHED",
    "-Fp",
  ], 10_000);
  if (result.exitCode === 1 && result.stdout.trim() === "") return 0;
  if (result.exitCode !== 0) throw new Error("production client inspection failed");
  return new Set(
    result.stdout.split("\n").filter((line) => /^p\d+$/u.test(line)),
  ).size || 1;
}

export async function captureProductionCorpusBaseline(
  cfg: AppConfig,
): Promise<ProductionCorpusBaseline> {
  const db = await connectDb(cfg);
  try {
    const schemaVersion = await checkSchemaVersion(db);
    const [rows] = await db.query<[
      Array<{ id: unknown; current_revision?: unknown }>,
    ]>("SELECT id, current_revision FROM dialogue");
    const canonical = (rows ?? []).map((row) => ({
      id: String(row.id),
      currentRevision: row.current_revision === undefined || row.current_revision === null
        ? null
        : String(row.current_revision),
    })).sort((left, right) => left.id.localeCompare(right.id));
    return {
      schemaVersion,
      dialogueCount: canonical.length,
      currentRevisionCount: canonical.filter((row) => row.currentRevision !== null).length,
      currentRevisionSha256: createHash("sha256")
        .update(JSON.stringify(canonical), "utf8")
        .digest("hex"),
    };
  } finally {
    await db.close();
  }
}

function exactBaselinesEqual(
  before: ProductionCorpusBaseline,
  after: ProductionCorpusBaseline,
): boolean {
  return before.schemaVersion === after.schemaVersion &&
    before.dialogueCount === after.dialogueCount &&
    before.currentRevisionCount === after.currentRevisionCount &&
    before.currentRevisionSha256 === after.currentRevisionSha256;
}

const DEFAULT_PRODUCTION_MAINTENANCE_DEPENDENCIES: ProductionMaintenanceDependencies = {
  pinnedImage: async () => pinnedSurrealImageFromCompose(await readFile(COMPOSE_FILE, "utf8")).image,
  inspectContainer: inspectProductionContainer,
  archiveLocked: isLocked,
  acquireMaintenanceLock: (archiveRoot) => acquireLock(archiveRoot, "restore:test maintenance"),
  activeProductionClients: activeProductionClientCount,
  captureBaseline: captureProductionCorpusBaseline,
  stopExact: async (containerId) => {
    const result = await runMaintenanceProcess("docker", [
      "container",
      "stop",
      "--time",
      "60",
      containerId,
    ], 75_000);
    if (result.exitCode !== 0) throw new Error("production stop failed");
  },
  startExact: async (containerId, cfg) => {
    await assertProductionDbStorageSafety(cfg);
    const result = await runMaintenanceProcess(
      "docker",
      ["container", "start", containerId],
      30_000,
    );
    if (result.exitCode !== 0) throw new Error("production start failed");
  },
  waitUntilHealthy: async (containerId, cfg, pinnedImage) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const inspection = await inspectProductionContainer();
      validateProductionContainer(inspection, cfg, pinnedImage, {
        requireHealthy: false,
        expectedId: containerId,
      });
      if (inspection.state?.Running === true && inspection.state.Health?.Status === "healthy") {
        return inspection;
      }
      if (Date.now() >= deadline) throw new Error("production restart readiness timeout");
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
  },
};

/**
 * Explicit production maintenance window. It never calls compose down and
 * targets only the immutable ID proven to be the exact healthy baka container.
 * The operation completes externally only after restart and baseline equality.
 */
export async function withProductionMaintenanceForIsolatedRestore<T>(
  cfg: AppConfig,
  operation: () => Promise<T>,
  dependencyOverrides: Partial<ProductionMaintenanceDependencies> = {},
): Promise<T> {
  const dependencies = {
    ...DEFAULT_PRODUCTION_MAINTENANCE_DEPENDENCIES,
    ...dependencyOverrides,
  };
  if (cfg.surrealUrl !== PRODUCTION_SURREAL_URL) {
    throw new ProductionMaintenanceError("preflight", "production_endpoint_mismatch");
  }

  let pinnedImage: string;
  let original: ProductionContainerInspection;
  let baseline: ProductionCorpusBaseline;
  let releaseMaintenanceLock: (() => Promise<void>) | undefined;
  try {
    pinnedImage = await dependencies.pinnedImage();
    original = validateProductionContainer(
      await dependencies.inspectContainer(),
      cfg,
      pinnedImage,
      { requireHealthy: true },
    );
    if (await dependencies.archiveLocked(cfg.archiveRoot)) {
      throw new Error("archive lock is active");
    }
    releaseMaintenanceLock = await dependencies.acquireMaintenanceLock(cfg.archiveRoot);
    baseline = await dependencies.captureBaseline(cfg);
    if (await dependencies.activeProductionClients() !== 0) {
      throw new Error("production client remains connected");
    }
    validateProductionContainer(
      await dependencies.inspectContainer(),
      cfg,
      pinnedImage,
      { requireHealthy: true, expectedId: original.id },
    );
  } catch {
    await releaseMaintenanceLock?.().catch(() => {});
    throw new ProductionMaintenanceError("preflight", "quiescence_not_proven");
  }

  let stopAttempted = false;
  let operationValue: T | undefined;
  let operationSucceeded = false;
  let operationError: unknown;
  let restartError: unknown;
  try {
    stopAttempted = true;
    await dependencies.stopExact(original.id);
    const stopped = validateProductionContainer(
      await dependencies.inspectContainer(),
      cfg,
      pinnedImage,
      { requireHealthy: false, expectedId: original.id },
    );
    if (stopped.state?.Running !== false) throw new Error("production container did not stop");
    try {
      operationValue = await operation();
      operationSucceeded = true;
    } catch (error) {
      operationError = error;
    }
  } catch (error) {
    operationError = new ProductionMaintenanceError("stop", "exact_stop_not_proven");
  } finally {
    if (stopAttempted) {
      try {
        validateProductionContainer(
          await dependencies.inspectContainer(),
          cfg,
          pinnedImage,
          { requireHealthy: false, expectedId: original.id },
        );
        await dependencies.startExact(original.id, cfg);
        const restarted = await dependencies.waitUntilHealthy(original.id, cfg, pinnedImage);
        validateProductionContainer(restarted, cfg, pinnedImage, {
          requireHealthy: true,
          expectedId: original.id,
        });
        const after = await dependencies.captureBaseline(cfg);
        if (!exactBaselinesEqual(baseline, after)) {
          throw new ProductionMaintenanceError("baseline", "production_baseline_changed");
        }
        if (await dependencies.activeProductionClients() !== 0) {
          throw new ProductionMaintenanceError("restart", "post_restart_not_quiescent");
        }
      } catch (error) {
        restartError = error instanceof ProductionMaintenanceError
          ? error
          : new ProductionMaintenanceError("restart", "exact_restart_not_proven");
      }
    }
  }
  try {
    await releaseMaintenanceLock?.();
  } catch {
    if (!restartError) {
      restartError = new ProductionMaintenanceError("restart", "maintenance_lock_release_failed");
    }
  }
  if (restartError) throw restartError;
  if (!operationSucceeded) throw operationError;
  return operationValue as T;
}

function isolatedDataIdentitySha256(evidence: IsolatedTargetEvidence): string {
  return createHash("sha256")
    .update("ai-baka:isolated-restore-data:v1\0", "utf8")
    .update(evidence.identity.attemptToken, "utf8")
    .update("\0", "utf8")
    .update(evidence.storage.source, "utf8")
    .digest("hex");
}

/** Maps lifecycle evidence to the deliberately narrower strict v5 contract. */
export function restoreTargetEvidenceFromIsolated(
  evidence: IsolatedTargetEvidence,
  context: RestoreTargetFinalizationContext,
): RestoreTargetEvidence {
  const expectedImage =
    `surrealdb/surrealdb:v${PINNED_RESTORE_TARGET_VERSION}@${PINNED_RESTORE_TARGET_IMAGE_DIGEST}`;
  if (
    evidence.formatVersion !== 2 ||
    evidence.image !== expectedImage || evidence.version !== PINNED_RESTORE_TARGET_VERSION ||
    !evidence.runtimeVersion?.startsWith(PINNED_RESTORE_TARGET_VERSION) ||
    evidence.hostAddress !== "127.0.0.1" || evidence.hostPort === PRODUCTION_HOST_PORT ||
    evidence.storage.type !== "volume" || evidence.storage.target !== "/data" ||
    evidence.indexBuildResumeInterval !== "0" ||
    evidence.cleanup.failures.length !== 0 || evidence.cleanup.containerRemoved !== true ||
    evidence.cleanup.volumeRemoved !== true || context.verificationSucceeded !== true ||
    context.restoreCleanupComplete !== true
  ) {
    throw new Error("isolated restore target final evidence is incomplete");
  }
  return parseRestoreTargetEvidence({
    mode: "isolated_pinned_container",
    image: {
      version: PINNED_RESTORE_TARGET_VERSION,
      digest: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
    },
    dataIdentitySha256: isolatedDataIdentitySha256(evidence),
    resourceBounds: {
      memoryBytes: evidence.resources.memoryBytes,
      memorySwapBytes: evidence.resources.memorySwapBytes,
      nanoCpus: Math.round(evidence.resources.cpus * 1_000_000_000),
      pidsLimit: evidence.resources.pidsLimit,
      rocksDbBlockCacheBytes: evidence.resources.rocksDbBlockCacheBytes,
      rocksDbThreadCount: evidence.resources.rocksDbThreadCount,
      rocksDbJobsCount: evidence.resources.rocksDbJobsCount,
      rocksDbMaxConcurrentSubcompactions:
        evidence.resources.rocksDbMaxConcurrentSubcompactions,
      hnswCacheBytes: evidence.resources.hnswCacheBytes,
      memoryThresholdBytes: evidence.resources.memoryThresholdBytes,
      httpMaxImportBodyBytes: evidence.resources.httpMaxImportBodyBytes,
      indexBuildResumeIntervalSeconds: Number(evidence.indexBuildResumeInterval),
    },
    pinnedIndexingBehavior: evidence.pinnedIndexingBehavior,
    fulltextIndexes: context.fulltextIndexes,
    cleanup: {
      containerRemoved: true,
      dataVolumeRemoved: true,
    },
  });
}

export function isolatedRestoreConfig(
  productionCfg: AppConfig,
  target: IsolatedSurrealTarget,
): AppConfig {
  if (
    target.hostAddress !== "127.0.0.1" || target.hostPort === PRODUCTION_HOST_PORT ||
    target.surrealUrl !== `ws://127.0.0.1:${target.hostPort}/rpc` ||
    target.httpBaseUrl !== `http://127.0.0.1:${target.hostPort}`
  ) {
    throw new Error("isolated restore target endpoint is unsafe");
  }
  return { ...productionCfg, surrealUrl: target.surrealUrl };
}

export interface IsolatedRestoreTargetFailureEvidence {
  formatVersion: 2;
  ok: false;
  startedAt: string;
  finishedAt?: string;
  failure: { stage: string; code: string };
  target?: {
    image: { version: "3.2.3"; digest: typeof PINNED_RESTORE_TARGET_IMAGE_DIGEST };
    dataIdentitySha256: string;
    resourceBounds: RestoreTargetEvidence["resourceBounds"];
    pinnedIndexingBehavior: RestoreTargetEvidence["pinnedIndexingBehavior"];
    observation: IsolatedTargetEvidence["observation"];
    cleanup: {
      containerRemoved: boolean;
      dataVolumeRemoved: boolean;
      failures: IsolatedTargetEvidence["cleanup"]["failures"];
    };
  };
}

export function isolatedTargetFailureEvidence(
  error: IsolatedTargetLifecycleError,
  now: Date = new Date(),
): IsolatedRestoreTargetFailureEvidence {
  const evidence = error.evidence;
  const report: IsolatedRestoreTargetFailureEvidence = {
    formatVersion: 2,
    ok: false,
    startedAt: evidence?.startedAt ?? now.toISOString(),
    ...(evidence?.finishedAt ? { finishedAt: evidence.finishedAt } : {}),
    failure: { stage: error.stage, code: error.code },
  };
  const expectedImage =
    `surrealdb/surrealdb:v${PINNED_RESTORE_TARGET_VERSION}@${PINNED_RESTORE_TARGET_IMAGE_DIGEST}`;
  if (
    evidence?.formatVersion === 2 && evidence.image === expectedImage &&
    evidence.version === PINNED_RESTORE_TARGET_VERSION &&
    evidence.resources.rocksDbThreadCount === 4 && evidence.resources.rocksDbJobsCount === 4 &&
    evidence.resources.rocksDbMaxConcurrentSubcompactions === 2 &&
    evidence.pinnedIndexingBehavior.probeRecords ===
      PINNED_SURREAL_INDEXING_BEHAVIOR.probeRecords &&
    evidence.pinnedIndexingBehavior.targetBytes ===
      PINNED_SURREAL_INDEXING_BEHAVIOR.targetBytes &&
    evidence.pinnedIndexingBehavior.maxRecords ===
      PINNED_SURREAL_INDEXING_BEHAVIOR.maxRecords &&
    evidence.indexBuildResumeInterval === "0"
  ) {
    report.target = {
      image: {
        version: PINNED_RESTORE_TARGET_VERSION,
        digest: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
      },
      dataIdentitySha256: isolatedDataIdentitySha256(evidence),
      resourceBounds: {
        memoryBytes: evidence.resources.memoryBytes,
        memorySwapBytes: evidence.resources.memorySwapBytes,
        nanoCpus: Math.round(evidence.resources.cpus * 1_000_000_000),
        pidsLimit: evidence.resources.pidsLimit,
        rocksDbBlockCacheBytes: evidence.resources.rocksDbBlockCacheBytes,
        rocksDbThreadCount: 4,
        rocksDbJobsCount: 4,
        rocksDbMaxConcurrentSubcompactions: 2,
        hnswCacheBytes: evidence.resources.hnswCacheBytes,
        memoryThresholdBytes: evidence.resources.memoryThresholdBytes,
        httpMaxImportBodyBytes: evidence.resources.httpMaxImportBodyBytes,
        indexBuildResumeIntervalSeconds: 0,
      },
      pinnedIndexingBehavior: { ...PINNED_SURREAL_INDEXING_BEHAVIOR },
      observation: {
        statsSamples: evidence.observation.statsSamples,
        ...(evidence.observation.peakMemoryBytes !== undefined
          ? { peakMemoryBytes: evidence.observation.peakMemoryBytes }
          : {}),
        ...(evidence.observation.peakCpuPercent !== undefined
          ? { peakCpuPercent: evidence.observation.peakCpuPercent }
          : {}),
        ...(evidence.observation.peakPids !== undefined
          ? { peakPids: evidence.observation.peakPids }
          : {}),
        ...(evidence.observation.oomKilled !== undefined
          ? { oomKilled: evidence.observation.oomKilled }
          : {}),
        ...(evidence.observation.exitCode !== undefined
          ? { exitCode: evidence.observation.exitCode }
          : {}),
      },
      cleanup: {
        containerRemoved: evidence.cleanup.containerRemoved,
        dataVolumeRemoved: evidence.cleanup.volumeRemoved,
        failures: [...evidence.cleanup.failures],
      },
    };
  }
  return report;
}

export async function persistIsolatedRestoreTargetFailureReport(
  archiveRoot: string,
  report: IsolatedRestoreTargetFailureEvidence,
  options: { now?: Date; suffix?: string } = {},
): Promise<string> {
  if (report.ok !== false || report.formatVersion !== 2) {
    throw new Error("isolated target failure evidence invalid");
  }
  const now = options.now ?? new Date();
  const suffix = options.suffix ?? randomUUID().slice(0, 8);
  if (!/^[a-zA-Z0-9_-]{1,32}$/u.test(suffix)) throw new Error("target failure suffix invalid");
  const reportPath = path.join(
    archiveRoot,
    "backups",
    "manifests",
    `restore-test-target-failure-${backupTimestamp(now)}-${suffix}.json`,
  );
  await writePrivateJsonAtomic(reportPath, report);
  return reportPath;
}

export class ManagedRestoreTestError extends Error {
  constructor(
    readonly restoreFailure?: RestoreTestFailureEvidence,
    readonly targetFailure?: IsolatedRestoreTargetFailureEvidence,
  ) {
    super("managed isolated restore test failed");
    this.name = "ManagedRestoreTestError";
  }
}

export interface ManagedRestoreTestDependencies {
  withMaintenance<T>(cfg: AppConfig, operation: () => Promise<T>): Promise<T>;
  withTarget<T>(
    options: {
      credentials: { username: string; password: string };
    },
    operation: (target: IsolatedSurrealTarget) => Promise<T>,
  ): Promise<IsolatedTargetRunResult<T>>;
  restore: typeof runRestoreTest;
}

const DEFAULT_MANAGED_RESTORE_DEPENDENCIES: ManagedRestoreTestDependencies = {
  withMaintenance: (cfg, operation) =>
    withProductionMaintenanceForIsolatedRestore(cfg, operation),
  withTarget: (options, operation) => withIsolatedSurrealTarget(options, operation),
  restore: runRestoreTest,
};

/** Complete start -> restore cleanup -> target teardown -> production restart flow. */
export async function runManagedIsolatedRestoreTest(
  cfg: AppConfig,
  options: RestoreTestOptions = {},
  dependencyOverrides: Partial<ManagedRestoreTestDependencies> = {},
): Promise<RestoreTestReport> {
  const dependencies = { ...DEFAULT_MANAGED_RESTORE_DEPENDENCIES, ...dependencyOverrides };
  let restoreFailure: RestoreTestFailureEvidence | undefined;
  try {
    return await dependencies.withMaintenance(cfg, async () => {
      const isolated = await dependencies.withTarget(
        { credentials: { username: cfg.surrealUser, password: cfg.surrealPass } },
        async (target) => {
          const isolatedCfg = isolatedRestoreConfig(cfg, target);
          try {
            return await dependencies.restore(
              isolatedCfg,
              { ...options, targetEvidence: undefined },
              {
                resolveTargetEvidence: async (_provided, context) => {
                  const finalEvidence = await target.finalize();
                  if (!context.verificationSucceeded || !context.restoreCleanupComplete) {
                    return undefined;
                  }
                  return restoreTargetEvidenceFromIsolated(finalEvidence, context);
                },
              },
            );
          } catch (error) {
            if (error instanceof RestoreTestAttemptError) restoreFailure = error.report;
            throw error;
          }
        },
      );
      return isolated.value;
    });
  } catch (error) {
    const lifecycle = error instanceof IsolatedTargetLifecycleError
      ? isolatedTargetFailureEvidence(error)
      : undefined;
    const targetFailure = restoreFailure && lifecycle?.failure.code === "operation_failed" &&
        lifecycle.target?.cleanup.containerRemoved === true &&
        lifecycle.target.cleanup.dataVolumeRemoved === true &&
        lifecycle.target.observation.oomKilled !== true
      ? undefined
      : lifecycle;
    if (restoreFailure || targetFailure) {
      throw new ManagedRestoreTestError(restoreFailure, targetFailure);
    }
    throw error;
  }
}

program
  .command("archive:init")
  .description("Создать структуру каталогов архива и sentinel-файл")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      const sentinel = await initArchive(cfg.archiveRoot, {
        namespace: cfg.surrealNamespace,
        database: cfg.surrealDatabase,
      });
      console.log(`архив инициализирован: ${cfg.archiveRoot}`);
      console.log(`archiveId: ${sentinel.archiveId}`);
    }),
  );

program
  .command("discover")
  .description("Обнаружить harness installations и source roots на этой машине")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const report = await discoverSourceRoots({ overrides: cfg.sourceOverrides });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const rows = report.roots.map((r) => [
        r.harness,
        r.enabled ? "ok" : "нет",
        r.sourceKind,
        r.snapshotStrategy,
        r.origin === "override" ? "*" : "",
        r.path,
      ]);
      const header = ["harness", "статус", "kind", "strategy", "", "path"];
      const widths = header.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => r[i]!.length)),
      );
      const line = (cols: string[]) =>
        cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
      console.log(line(header));
      for (const row of rows) console.log(line(row));
      console.log(
        `\nнайдено: ${report.enabled.length}/${report.roots.length} roots (* — переопределено через BAKA_SOURCES__*)`,
      );
    }),
  );

const db = program.command("db").description("Управление SurrealDB");

db.command("preflight")
  .description("Проверить готовность архива к записи")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      const report = await runPreflight(cfg);
      for (const issue of report.issues) {
        console.error(`FAIL [${issue.check}] ${issue.detail}`);
      }
      if (!report.ok) {
        process.exitCode = 1;
        return;
      }
      console.log("preflight: ok");
    }),
  );

db.command("up")
  .description("Поднять SurrealDB (docker compose up)")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      await assertProductionDbStorageSafety(cfg);
      await composeUp();
      console.log("SurrealDB запущен: 127.0.0.1:8901");
    }),
  );

db.command("down")
  .description("Остановить SurrealDB (docker compose down)")
  .action(
    handle(async () => {
      await composeDown();
      console.log("SurrealDB остановлен");
    }),
  );

db.command("status")
  .description("Статус контейнера и подключения")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      const status = await composeStatus();
      if (!status) {
        console.log("контейнер: не создан");
        return;
      }
      console.log(`контейнер: ${status.state} (health: ${status.health})`);
      const version = await serverVersion(cfg);
      console.log(`версия сервера: ${version ?? "недоступна"}`);
      if (status.state === "running") {
        let liveDb: Surreal | undefined;
        try {
          liveDb = await connectDb(cfg);
          await liveDb.query("RETURN 1");
          const schemaVersion = await checkSchemaVersion(liveDb);
          console.log("подключение: ok");
          console.log(
            schemaVersion > 0
              ? `версия схемы: ${schemaVersion}`
              : "версия схемы: не инициализирована (baka db migrate)",
          );
        } catch (error) {
          console.error(`подключение: FAIL (${error instanceof Error ? error.message : error})`);
          process.exitCode = 1;
        } finally {
          if (liveDb) await liveDb.close();
        }
      }
    }),
  );

db.command("migrate")
  .description("Применить недостающие schema migrations (docs/plan.md §6)")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "db migrate");
      try {
        const sentinel = await readSentinel(cfg.archiveRoot);
        const db = await connectDb(cfg);
        try {
          const version = (await serverVersion(cfg)) ?? "unknown";
          const result = await applyMigrations(db, {
            sentinel,
            surrealdbVersion: version,
          });
          if (result.applied.length === 0) {
            console.log(`схема актуальна, версия: ${result.version}`);
          } else {
            console.log(`применены миграции: ${result.applied.join(", ")}`);
            console.log(`версия схемы: ${result.version}`);
          }
        } finally {
          await db.close();
        }
      } finally {
        await release();
      }
    }),
  );

db.command("logs")
  .description("Логи контейнера SurrealDB")
  .option("-n, --tail <lines>", "число строк", "100")
  .action(
    handle(async (options: { tail: string }) => {
      console.log(await composeLogs(Number(options.tail)));
    }),
  );

const disk = program.command("disk").description("Операции с диском архива");

disk
  .command("eject")
  .description("Остановить БД и размонтировать том архива")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      await ejectDisk(cfg.archiveRoot, (message) => console.log(message));
      console.log("диск извлечён");
    }),
  );

program
  .command("sync")
  .description("Structured sync: discovery → snapshot → parse → SurrealDB (docs/plan.md §10)")
  .option("--harness <slug>", `только один harness (${Object.keys(HARNESSES).join(", ")})`)
  .option("--full-rescan", "игнорировать fingerprint'ы и переснять все файлы")
  .option("--deletion-confirmations <n>", "complete-scan'ов до deleted_in_source", Number)
  .option("--no-enqueue-embeddings", "не создавать embedding jobs")
  .option("--dry-run", "только показать действия, без записи в БД и raw")
  .option("--json", "итоговая сводка в JSON (лог событий — в stderr)")
  .action(
    handle(
      async (options: {
        harness?: string;
        fullRescan?: boolean;
        deletionConfirmations?: number;
        enqueueEmbeddings?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        if (options.harness && !(options.harness in HARNESSES)) {
          throw new Error(`неизвестный harness: ${options.harness}`);
        }
        const cfg = loadConfig();
        const summary = await runSync(cfg, {
          harness: options.harness as HarnessSlug | undefined,
          fullRescan: options.fullRescan,
          deletionConfirmations:
            options.deletionConfirmations && options.deletionConfirmations > 0
              ? options.deletionConfirmations
              : undefined,
          enqueueEmbeddings: options.enqueueEmbeddings,
          dryRun: options.dryRun,
        });
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(`sync: ${summary.status}`);
          for (const [key, value] of Object.entries(summary.counters)) {
            console.log(`  ${key}: ${value}`);
          }
          for (const error of summary.errors) console.error(`  error: ${error}`);
        }
        if (summary.status === "failed") process.exitCode = 1;
      },
    ),
  );

export function formatHit(index: number, hit: SearchHit): string {
  const meta = [
    hit.documentType ?? hit.kind,
    hit.segmentNo !== undefined ? `seg ${hit.segmentNo}` : undefined,
    hit.role ? `role ${hit.role}` : undefined,
    hit.harness,
    hit.host,
    hit.user ? `user ${hit.user}` : undefined,
    hit.workspace,
    hit.vendor ? `vendor ${hit.vendor}` : undefined,
    hit.model,
    hit.reasoningEffort ? `reasoning ${hit.reasoningEffort}` : undefined,
    hit.timestamp,
  ]
    .filter(Boolean)
    .join(" | ");
  const title = hit.dialogueTitle ?? "(без названия)";
  return (
    `[${index + 1}] score ${hit.score.toFixed(3)} — ${title}\n` +
    `    ${meta}\n` +
    `    ${hit.snippet}\n` +
    (hit.sourcePath ? `    source: ${hit.sourcePath}\n` : "") +
    `    ${hit.dialogueId} ${hit.revisionId}`
  );
}

program
  .command("search <query>")
  .description("Full-text поиск по архиву (docs/plan.md §12, §14)")
  .option("--mode <mode>", "text|vector|hybrid", "text")
  .option("--harness <slug>", "только один harness")
  .option("--host <label|hostname>", "только одна машина")
  .option("--user <os-username>", "только один OS account")
  .option("--workspace <name>", "только один проект")
  .option("--vendor <slug>", "vendor модели")
  .option("--model <name>", "модель (raw или canonical name)")
  .option("--reasoning-effort <value>", "reasoning effort модели")
  .option("--role <role>", "роль message: user|assistant|system|developer|tool|unknown")
  .option("--document-type <type>", "user_prompt|assistant_final")
  .option("--from <date>", "не раньше (ISO date)")
  .option("--to <date>", "не позже (ISO date)")
  .option("--deleted-only", "только диалоги, удалённые из источника")
  .option("--include-reasoning", "недоступно: глобальный forensic index отключён")
  .option("--include-tools", "недоступно: глобальный forensic index отключён")
  .option("--include-system", "недоступно: глобальный forensic index отключён")
  .option("--all-revisions", "недоступно: глобальный forensic index отключён")
  .option("--limit <n>", "максимум результатов", Number)
  .option("--json", "вывести результат в JSON")
  .action(
    handle(
      async (
        query: string,
        options: {
          mode: string;
          harness?: string;
          host?: string;
          user?: string;
          workspace?: string;
          vendor?: string;
          model?: string;
          reasoningEffort?: string;
          role?: string;
          documentType?: string;
          from?: string;
          to?: string;
          deletedOnly?: boolean;
          includeReasoning?: boolean;
          includeTools?: boolean;
          includeSystem?: boolean;
          allRevisions?: boolean;
          limit?: number;
          json?: boolean;
        },
      ) => {
        if (!["text", "vector", "hybrid"].includes(options.mode)) {
          throw new Error(`неизвестный режим: ${options.mode} (text|vector|hybrid)`);
        }
        if (options.harness && !(options.harness in HARNESSES)) {
          throw new Error(`неизвестный harness: ${options.harness}`);
        }
        if (options.role && !["user", "assistant", "system", "developer", "tool", "unknown"].includes(options.role)) {
          throw new Error(`--role: неизвестная роль "${options.role}"`);
        }
        if (options.documentType && !["user_prompt", "assistant_final"].includes(options.documentType)) {
          throw new Error(`--document-type: ожидался user_prompt|assistant_final`);
        }
        if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
          throw new Error("--limit: ожидалось целое число > 0");
        }
        const from = parseDate(options.from, "--from");
        const to = parseDate(options.to, "--to");
        if (from && to && from > to) throw new Error("--from не может быть позже --to");
        const filters = {
          harness: options.harness,
          host: options.host,
          user: options.user,
          workspace: options.workspace,
          vendor: options.vendor,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          role: options.role,
          documentType: options.documentType,
          from,
          to,
          deletedOnly: options.deletedOnly ?? false,
          includeReasoning: options.includeReasoning ?? false,
          includeTools: options.includeTools ?? false,
          includeSystem: options.includeSystem ?? false,
          allRevisions: options.allRevisions ?? false,
          limit: options.limit ?? 20,
        };
        // Проверяем до loadConfig/connectDb: legacy forensic flags никогда не
        // должны запускать table scan после удаления chunk_content index.
        assertForensicSearchDisabled(filters);
        const cfg = loadConfig();
        const db = await connectDb(cfg);
        try {
          let mode = options.mode;
          let hits: SearchHit[];
          if (options.mode === "text") {
            hits = await searchText(db, query, filters);
          } else {
            // vector/hybrid: нужен active space + OPENAI_API_KEY (§14).
            let provider: EmbeddingProvider | undefined;
            try {
              provider = await vectorProvider(db, cfg);
            } catch (error) {
              if (options.mode === "vector") throw error;
              provider = undefined;
              // Hybrid деградирует в lexical с явным предупреждением (§14).
              console.error(
                `внимание: vector-ранжирование недоступно (${error instanceof Error ? error.message : error}); ` +
                  `hybrid деградировал в text search`,
              );
              mode = "hybrid→text";
            }
            hits = provider
              ? options.mode === "vector"
                ? await searchVector(db, provider, query, filters)
                : await searchHybrid(db, provider, query, filters)
              : await searchText(db, query, filters);
          }
          if (options.json) {
            console.log(JSON.stringify({ mode, query, hits }, null, 2));
            return;
          }
          if (hits.length === 0) {
            console.log("ничего не найдено");
            return;
          }
          for (const [index, hit] of hits.entries()) console.log(formatHit(index, hit));
        } finally {
          await db.close();
        }
      },
    ),
  );

const relevance = program
  .command("relevance")
  .description("Приватная relevance evaluation (docs/plan.md §21)");

relevance
  .command("evaluate")
  .description("Сравнить BM25/vector/hybrid с authenticated ordered hit identities")
  .requiredOption("--judgments <path>", "private judgment set JSON (50–100 queries)")
  .requiredOption("--report <path>", "private report с authenticated hit evidence")
  .requiredOption("--candidate-plan <path>", "private bounded candidate plan JSON")
  .requiredOption("--confirm <phrase>", "точная confirmation-фраза candidate plan")
  .requiredOption("--spaces <csv>", "три candidate spaces из §13.2")
  .requiredOption(
    "--resource-measurements <path>",
    "private JSON object keyed by space slug: vectorIndexBytes/peakRamBytes/indexBuildMs",
  )
  .requiredOption(
    "--documented-exclusions <path>",
    "private JSON keyed by exact spaces; rows only category/code/jobId/documentId/evidence, no count; exact normalized privacy is applied",
  )
  .option("--modes <csv>", "полная matrix: text,vector,hybrid", "text,vector,hybrid")
  .option("--allow-paid-api", "разрешить embedding query calls для vector/hybrid")
  .option("--include-query-text", "явно включить private query text в report")
  .option("--overwrite", "явно перезаписать существующий report")
  .option("--json", "вывести report в JSON")
  .action(
    handle(async (options: {
      judgments: string;
      report: string;
      candidatePlan: string;
      confirm: string;
      modes: string;
      spaces: string;
      resourceMeasurements: string;
      documentedExclusions: string;
      allowPaidApi?: boolean;
      includeQueryText?: boolean;
      overwrite?: boolean;
      json?: boolean;
    }) => {
      const modes = parseCsv(options.modes, "--modes") as EvaluationMode[];
      const allowedModes = new Set<EvaluationMode>(["text", "vector", "hybrid"]);
      for (const mode of modes) {
        if (!allowedModes.has(mode)) throw new Error(`--modes: неизвестный mode "${mode}"`);
      }
      if (modes.length !== allowedModes.size || modes.some((mode) => !allowedModes.has(mode))) {
        throw new Error("relevance evaluation требует полную matrix text,vector,hybrid");
      }
      const embeddingModes = modes.filter((mode) => mode !== "text");
      const spaces = parseCsv(options.spaces, "--spaces");
      if (spaces.length !== 3) throw new Error("--spaces: требуется ровно три candidate spaces из §13.2");
      if (!options.allowPaidApi) {
        throw new Error("vector/hybrid evaluation требует --allow-paid-api");
      }
      const resourceMeasurements = await loadEvaluationResources(options.resourceMeasurements);
      const documentedExclusions = await loadEvaluationExclusions(options.documentedExclusions);
      const candidateArtifact = await loadEvaluationCandidatePlanArtifact(options.candidatePlan);
      const candidatePlan = candidateArtifact.plan;
      if (candidatePlan.confirmation !== options.confirm) {
        throw new Error("relevance evaluation candidate confirmation mismatch");
      }
      const plannedSpaces = candidatePlan.spaces.map((item) => item.space.slug).sort();
      if (canonicalMigrationJson(plannedSpaces) !== canonicalMigrationJson([...spaces].sort())) {
        throw new Error("--spaces не совпадают с candidate plan");
      }
      const cfg = loadConfig();
      const privacy = normalizedEmbeddingPrivacy(cfg.embeddings);
      assertExactExclusionSpaces(documentedExclusions, spaces);
      if (canonicalMigrationJson(candidatePlan.privacy) !== canonicalMigrationJson(privacy)) {
        throw new Error("candidate plan privacy differs from exact normalized CLI privacy");
      }
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "relevance evaluate");
      let db: Surreal | undefined;
      const logger = createStructuredLogger({ runId: createRunId("relevance_evaluation") });
      try {
        db = await connectDb(cfg);
        const set = await loadJudgmentSet(options.judgments);
        const scenarios = await createEvaluationScenarios(db, {
          modes,
          spaceSlugs: spaces,
          providerFactory: embeddingModes.length > 0 ? workerProviderFactory(cfg) : undefined,
          allowEmbeddingQueries: options.allowPaidApi ?? false,
          resourceMeasurements,
          privacy,
          candidatePlan,
          candidateConfirmation: options.confirm,
          documentedExclusions,
        });
        logger.info("relevance_evaluation_started", {
          judgments: set.queries.length,
          scenarios: scenarios.map((scenario) => scenario.id),
        });
        const report = await runRelevanceEvaluation(set, scenarios, {
          includeQueryText: options.includeQueryText ?? false,
          candidatePlan,
          judgmentSetPath: options.judgments,
          candidatePlanPath: options.candidatePlan,
        });
        await writeEvaluationReport(options.report, report, {
          overwrite: options.overwrite ?? false,
        });
        logger.info("relevance_evaluation_finished", {
          judgments: set.queries.length,
          scenarios: report.scenarios.length,
        });
        if (options.json) {
          console.log(JSON.stringify({ reportPath: path.resolve(options.report), report }, null, 2));
        } else {
          console.log(`relevance: ${report.judgmentSet.name}, ${report.judgmentSet.queries} queries`);
          for (const scenario of report.scenarios) {
            const metric = scenario.aggregate;
            console.log(
              `${scenario.id}: Recall@5 ${metric.recallAt5.toFixed(4)}, ` +
                `Recall@10 ${metric.recallAt10.toFixed(4)}, MRR ${metric.mrr.toFixed(4)}, ` +
                `nDCG@10 ${metric.ndcgAt10.toFixed(4)}, p95 ${metric.latencyMs.p95.toFixed(1)} ms`,
            );
          }
          console.log(`report: ${path.resolve(options.report)}`);
        }
      } finally {
        if (db) await db.close();
        await release();
      }
    }),
  );

const fullCorpusRelevance = relevance
  .command("full-corpus")
  .description("Финальная post-backfill hybrid evaluation по всему privacy-eligible corpus");

fullCorpusRelevance
  .command("plan")
  .description("Показать literal confirmation, связанную с exact full-corpus fingerprint")
  .requiredOption("--space <slug>", "selected production embedding space")
  .requiredOption("--exact-report <path>", "private exact token report used by backfill")
  .option("--json", "вывести machine-readable confirmation plan")
  .action(handle(async (options: { space: string; exactReport: string; json?: boolean }) => {
    const exactReport = await loadExactReport(options.exactReport);
    const result = {
      space: options.space,
      corpus: {
        algorithm: "sha256" as const,
        sha256: exactReport.corpus.fingerprintSha256,
        documents: exactReport.corpus.documents,
      },
      tokenizer: exactReport.tokenizer,
      confirmation: fullCorpusEvaluationConfirmation(
        options.space,
        exactReport.corpus.fingerprintSha256,
      ),
    };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`space: ${result.space}`);
      console.log(`corpus: ${result.corpus.documents} documents, ${result.corpus.sha256}`);
      console.log(`confirmation: ${result.confirmation}`);
    }
  }));

fullCorpusRelevance
  .command("evaluate")
  .description("Запустить selected hybrid по всем distractors с authenticated hit identities")
  .requiredOption("--space <slug>", "selected, fully backfilled production space")
  .requiredOption("--exact-report <path>", "private exact token report used by backfill")
  .requiredOption("--judgments <path>", "exact private judgment set artifact")
  .requiredOption(
    "--resource-measurements <path>",
    "private JSON object keyed by selected space slug",
  )
  .requiredOption(
    "--documented-exclusions <path>",
    "private JSON for exact selected space; rows only category/code/jobId/documentId/evidence, no count; exact normalized privacy is applied",
  )
  .requiredOption("--confirm <phrase>", "literal EVALUATE FULL CORPUS confirmation from plan")
  .requiredOption("--report <path>", "private final report с authenticated hit evidence")
  .option("--allow-paid-api", "explicitly authorize selected-space query embeddings")
  .option("--include-query-text", "явно включить private query text в report")
  .option("--overwrite", "явно перезаписать существующий report")
  .option("--json", "вывести machine-readable report")
  .action(handle(async (options: {
    space: string;
    exactReport: string;
    judgments: string;
    resourceMeasurements: string;
    documentedExclusions: string;
    confirm: string;
    report: string;
    allowPaidApi?: boolean;
    includeQueryText?: boolean;
    overwrite?: boolean;
    json?: boolean;
  }) => {
    if (!options.allowPaidApi) {
      throw new Error("full-corpus relevance evaluate требует --allow-paid-api");
    }
    const [exactReport, set, resources, exclusions] = await Promise.all([
      loadExactReport(options.exactReport),
      loadJudgmentSet(options.judgments),
      loadEvaluationResources(options.resourceMeasurements),
      loadEvaluationExclusions(options.documentedExclusions),
    ]);
    const resourceMeasurements = resources[options.space];
    if (!resourceMeasurements) {
      throw new Error("--resource-measurements не содержит selected space");
    }
    const documentedExclusions = exclusions[options.space];
    if (!documentedExclusions) {
      throw new Error("--documented-exclusions не содержит selected space");
    }
    const cfg = loadConfig();
    const privacy = normalizedEmbeddingPrivacy(cfg.embeddings);
    assertExactExclusionSpaces(exclusions, [options.space]);
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "relevance full-corpus evaluate");
    let db: Surreal | undefined;
    const logger = createStructuredLogger({ runId: createRunId("full_corpus_relevance") });
    try {
      db = await connectDb(cfg);
      const scenario = await createFullCorpusHybridScenario(db, {
        spaceSlug: options.space,
        providerFactory: workerProviderFactory(cfg),
        allowEmbeddingQueries: true,
        confirmation: options.confirm,
        privacy,
        resourceMeasurements,
        documentedExclusions,
      });
      if (scenario.space?.model !== exactReport.tokenizer.model) {
        throw new Error("full-corpus selected space differs from exact tokenizer model");
      }
      const expectedCorpus = {
        algorithm: "sha256" as const,
        sha256: exactReport.corpus.fingerprintSha256,
        documents: exactReport.corpus.documents,
      };
      logger.info("full_corpus_relevance_started", {
        scenario: scenario.id,
        judgments: set.queries.length,
        documents: expectedCorpus.documents,
      });
      const report = await runFullCorpusHybridEvaluation(set, scenario, {
        judgmentSetPath: options.judgments,
        privacy,
        expectedCorpus,
        includeQueryText: options.includeQueryText ?? false,
      });
      await writeFullCorpusEvaluationReport(options.report, report, {
        overwrite: options.overwrite ?? false,
      });
      logger.info("full_corpus_relevance_finished", {
        scenario: report.scenario.id,
        judgments: report.judgmentSet.queries,
        documents: report.corpus.documents,
      });
      if (options.json) {
        console.log(JSON.stringify({ reportPath: path.resolve(options.report), report }, null, 2));
      } else {
        const metric = report.scenario.aggregate;
        console.log(
          `${report.scenario.id}: Recall@5 ${metric.recallAt5.toFixed(4)}, ` +
            `Recall@10 ${metric.recallAt10.toFixed(4)}, MRR ${metric.mrr.toFixed(4)}, ` +
            `nDCG@10 ${metric.ndcgAt10.toFixed(4)}, p95 ${metric.latencyMs.p95.toFixed(1)} ms`,
        );
        console.log(`report: ${path.resolve(options.report)}`);
      }
    } finally {
      if (db) await db.close();
      await release();
    }
  }));

fullCorpusRelevance
  .command("accept")
  .description("Construct the only Stage11Completion from explicit final full-corpus acceptance")
  .requiredOption("--evidence <path>", "private AcceptedFullCorpusRelevanceEvidence v1 JSON")
  .requiredOption("--exact-report <path>", "same exact token report used by production backfill")
  .requiredOption("--space <slug>", "selected production embedding space")
  .requiredOption("--judgments <path>", "independently reviewed private judgment artifact")
  .requiredOption(
    "--judgments-sha256 <sha256>",
    "independently pinned SHA-256 of exact judgment artifact bytes",
  )
  .requiredOption(
    "--judgments-size-bytes <n>",
    "independently pinned exact judgment artifact byte size",
    (value) => parsePositiveInteger(value, "--judgments-size-bytes"),
  )
  .option("--json", "вывести exact Stage11Completion")
  .action(handle(async (options: {
    evidence: string;
    exactReport: string;
    space: string;
    judgments: string;
    judgmentsSha256: string;
    judgmentsSizeBytes: number;
    json?: boolean;
  }) => {
    const [evidence, exactReport, expectedJudgmentArtifact] = await Promise.all([
      loadAcceptedFullCorpusRelevance(options.evidence),
      loadExactReport(options.exactReport),
      pinCliExpectedJudgmentArtifact(options),
    ]);
    const cfg = loadConfig();
    const privacy = normalizedEmbeddingPrivacy(cfg.embeddings);
    await assertPreflight(cfg);
    const db = await connectDb(cfg);
    try {
      const selectedSpace = (await listSpaces(db)).find((space) => space.slug === options.space);
      if (!selectedSpace) throw new Error(`embedding space "${options.space}" не найден`);
      if (selectedSpace.model !== exactReport.tokenizer.model) {
        throw new Error("full-corpus selected space differs from exact tokenizer model");
      }
      const result = await completeStage11(evidence, {
        db,
        privacy,
        expectedCorpus: {
          algorithm: "sha256",
          sha256: exactReport.corpus.fingerprintSha256,
          documents: exactReport.corpus.documents,
        },
        expectedSpace: selectedSpace,
        expectedJudgmentArtifact,
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Stage 11 completed: ${result.completionKind}`);
        console.log(`completion sha256: ${result.completionSha256}`);
      }
    } finally {
      await db.close();
    }
  }));

program
  .command("search:rebuild")
  .description("Пересоздать search projection для всех current revisions (docs/plan.md §8.1)")
  .option("--no-enqueue-embeddings", "не создавать embedding jobs")
  .option("--json", "итоговая сводка в JSON")
  .action(
    handle(async (options: { enqueueEmbeddings?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "search:rebuild");
      let db: Surreal | undefined;
      try {
        db = await connectDb(cfg);
        const schemaVersion = await checkSchemaVersion(db);
        if (schemaVersion === 0) {
          throw new Error("схема не инициализирована: сначала baka db migrate");
        }
        const identity = await localIdentity({});
        const hostId = await ensureHost(db, {
          hostUuid: identity.hostUuid,
          hostname: identity.hostname,
          platform: identity.platform,
          arch: identity.arch,
        });
        const summary = await rebuildSearchProjection(db, {
          host: hostId,
          schemaVersion,
          enqueueEmbeddings: options.enqueueEmbeddings ?? true,
          logger: (event) => console.error(JSON.stringify(event)),
        });
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(
            `search:rebuild готов: revisions ${summary.revisions}, search_documents ${summary.searchDocuments}` +
              `, embedding_jobs ${summary.embeddingJobs}, skipped ${summary.skipped}`,
          );
        }
      } finally {
        if (db) await db.close();
        await release();
      }
    }),
  );

program
  .command("status")
  .description("Сводка состояния архива (docs/plan.md §17.2)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const report = await collectStatus(cfg);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatStatus(report));
    }),
  );

program
  .command("validate")
  .description("Проверка инвариантов архива (docs/plan.md §17.3, §23)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const report = await runValidation(cfg);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.ok) {
        console.log("validate: ok — инварианты соблюдены");
      } else {
        console.log(`validate: ${report.issues.length} проблем(а)`);
        for (const issue of report.issues) {
          console.log(`  [${issue.check}] ${issue.detail}`);
        }
      }
      if (!report.ok) process.exitCode = 1;
    }),
  );

const backup = program
  .command("backup")
  .description("Logical backup: HTTP /export → backups/surreal + manifest (docs/plan.md §16.1)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "backup");
      try {
        const result = await runLogicalBackup(cfg);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`export: ${result.exportPath}`);
        console.log(`manifest: ${result.manifestPath}`);
        console.log(
          `schema ${result.manifest.schemaVersion}, surreal ${result.manifest.surrealdbVersion}, ` +
            `${result.manifest.exportBytes} bytes (${result.manifest.compression}), ` +
            `sha256 ${result.manifest.exportSha256.slice(0, 12)}…`,
        );
        const totals = Object.entries(result.manifest.recordCounts)
          .filter(([, n]) => n > 0)
          .map(([t, n]) => `${t} ${n}`)
          .join(", ");
        console.log(`recordCounts: ${totals}`);
      } finally {
        await release();
      }
    }),
  );

interface OffDeviceCliOptions {
  destination: string;
  export: string[];
  rawManifest?: string;
  migrationReport: string[];
  json?: boolean;
}

function offDeviceOptions(cfg: AppConfig, options: OffDeviceCliOptions): OffDeviceBackupOptions {
  return {
    archiveRoot: cfg.archiveRoot,
    destination: options.destination,
    exportPaths: options.export.length > 0 ? options.export : undefined,
    rawManifestPath: options.rawManifest,
    migrationReportPaths: options.migrationReport.length > 0
      ? options.migrationReport
      : undefined,
  };
}

function addOffDeviceSourceOptions(command: Command): Command {
  return command
    .requiredOption("--destination <path>", "корень off-device назначения")
    .option("--export <path>", "logical export; можно повторять", collectOption, [])
    .option("--raw-manifest <path>", "явный raw-manifest JSON")
    .option("--migration-report <path>", "migration/reconciliation report; можно повторять", collectOption, [])
    .option("--json", "вывести machine-readable result");
}

const offDevice = backup
  .command("off-device")
  .description("Переносимый backup на другое устройство (docs/plan.md §16.3)");

addOffDeviceSourceOptions(
  offDevice.command("plan").description("Полный read-only plan и checksum-проверка источников"),
).action(
  handle(async (options: OffDeviceCliOptions) => {
    const cfg = loadConfig();
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "backup off-device plan");
    try {
      const plan = await planOffDeviceBackup({ ...offDeviceOptions(cfg, options), dryRun: true });
      if (options.json) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log(`off-device plan: ${plan.manifest.backupId}`);
        console.log(`destination: ${plan.bundlePath}`);
        console.log(`files: ${plan.manifest.totals.files}, bytes: ${plan.manifest.totals.bytes}`);
        console.log(
          `raw: ${plan.manifest.totals.rawFiles}, orphan raw: ${plan.manifest.totals.rawOrphans}, ` +
            `logical backups: ${plan.manifest.logicalBackups.length}`,
        );
        console.log("physical device: требуется подтверждение оператора перед run");
      }
    } finally {
      await release();
    }
  }),
);

addOffDeviceSourceOptions(
  offDevice.command("run").description("Опубликовать и полностью проверить off-device bundle"),
)
  .option(
    "--confirm-physical-device",
    "подтверждаю, что destination — отдельное физическое устройство",
  )
  .action(
    handle(async (options: OffDeviceCliOptions & { confirmPhysicalDevice?: boolean }) => {
      if (!options.confirmPhysicalDevice) {
        throw new Error("backup off-device run требует --confirm-physical-device");
      }
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "backup off-device run");
      const logger = createStructuredLogger({ runId: createRunId("off_device_backup") });
      try {
        logger.info("off_device_backup_started");
        const result = await runOffDeviceBackup({
          ...offDeviceOptions(cfg, options),
          operatorConfirmedPhysicalDevice: true,
          physicalDeviceCheckedAt: new Date(),
        });
        logger.info("off_device_backup_finished", {
          backupId: result.report.backupId,
          status: result.report.status,
          files: result.report.files.total,
          bytes: result.report.bytes.total,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`off-device backup: ${result.report.status} (${result.report.backupId})`);
          console.log(`bundle: ${result.report.bundlePath}`);
          console.log(
            `files: copied ${result.report.files.copied}, reused ${result.report.files.reused}, ` +
              `verified ${result.report.files.verified}`,
          );
          console.log(`manifest: ${result.manifestPath ?? "—"}`);
          console.log(`report: ${result.reportPath ?? "—"}`);
        }
      } finally {
        await release();
      }
    }),
  );

offDevice
  .command("verify <bundle>")
  .description("Read-only checksum/metadata verification опубликованного bundle")
  .option("--json", "вывести machine-readable report")
  .action(
    handle(async (bundle: string, options: { json?: boolean }) => {
      const report = await verifyOffDeviceBackup(bundle);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          `off-device verify: ${report.ok ? "ok" : "FAIL"}, ` +
            `files ${report.checkedFiles}, bytes ${report.checkedBytes}`,
        );
        for (const issue of report.issues) {
          console.log(`  [${issue.reason}] ${issue.path}`);
        }
      }
      if (!report.ok) process.exitCode = 1;
    }),
  );

program
  .command("restore:test [export]")
  .description(
    "Restore drill в pinned disposable SurrealDB; production временно останавливается и проверяется после restart",
  )
  .option(
    "--raw-archive-root <path>",
    "archive root с raw/ (для off-device bundle: <bundle>/archive)",
  )
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (
      exportPath: string | undefined,
      options: { rawArchiveRoot?: string; json?: boolean },
    ) => {
      await withRestoreTestSignalHandlers(async (signal) => {
        const cfg = loadConfig();
        const runId = createRunId("restore_test");
        const logger = createStructuredLogger({ runId });
        logger.info("restore_test_started");
        let report: RestoreTestReport;
        try {
          report = await runManagedIsolatedRestoreTest(cfg, {
            exportPath,
            rawArchiveRoot: options.rawArchiveRoot,
            signal,
          });
        } catch (error) {
          if (!(error instanceof ManagedRestoreTestError)) throw error;
          let persistedFailure = false;
          try {
            if (error.restoreFailure) {
              await persistRestoreTestFailureReport(cfg.archiveRoot, error.restoreFailure);
              persistedFailure = true;
            }
            if (error.targetFailure) {
              await persistIsolatedRestoreTargetFailureReport(cfg.archiveRoot, error.targetFailure);
              persistedFailure = true;
            }
          } catch {
            throw new Error("restore:test failure evidence persistence failed");
          }
          if (!persistedFailure) throw new Error("restore:test has no persistable failure evidence");
          const failure = error.restoreFailure?.failure ?? error.targetFailure?.failure;
          logger.error("restore_test_failed", {
            ...(error.restoreFailure ? { attemptId: error.restoreFailure.attemptId } : {}),
            stage: failure?.stage ?? "managed_restore",
            code: failure?.code ?? "failed",
            cleanupFailures: error.restoreFailure?.cleanupFailures ?? [],
          });
          throw new Error(
            `restore:test failed: ${failure?.stage ?? "managed_restore"}/${failure?.code ?? "failed"}; private failure evidence persisted`,
          );
        }
        let persisted: PersistedRestoreTestReport;
        let reportPath: string;
        try {
          ({ persisted, reportPath } = await persistRestoreTestReport(cfg.archiveRoot, report, {
            runId,
          }));
        } catch {
          throw new Error("restore:test successful report persistence failed");
        }
        logger.info("restore_test_finished", {
          ok: report.ok,
          exportFile: report.exportFile,
          checks: report.checks.length,
        });
        if (options.json) {
          console.log(JSON.stringify({ ...persisted, reportPath }, null, 2));
        } else {
          console.log(`restore:test: ${report.exportFile} → ns ${report.namespace}`);
          for (const check of report.checks) {
            console.log(`  ${check.ok ? "ok" : "FAIL"} [${check.name}] ${check.detail}`);
          }
          console.log(report.ok ? "restore:test: ok" : "restore:test: FAIL");
          console.log(`report: ${reportPath}`);
        }
        if (!report.ok) process.exitCode = 1;
      });
    }),
  );

export function formatRecoveryRebuildSuccess(report: {
  exportFile: string;
  dbRoot: string;
  corruptDbRoot: string;
  sourceMode?: "archive-corrupt" | "current-internal";
  journalPath: string;
}): string[] {
  return [
    `recovery:rebuild: ok — ${report.exportFile}`,
    `new DB: ${report.dbRoot}`,
    report.sourceMode === "current-internal"
      ? `current production DB retained unchanged: ${report.corruptDbRoot}`
      : `corrupt DB retained: ${report.corruptDbRoot}`,
    "staging container removed; production not started",
    `journal: ${report.journalPath}`,
    `report: ${path.join(path.dirname(report.journalPath), "recovery-report.json")}`,
  ];
}

program
  .command("recovery:rebuild <export>")
  .description(
    "Fail-closed rebuild fresh APFS DB из authenticated internal schema-5 copy без cutover",
  )
  .requiredOption(
    "--export-sha256 <sha256>",
    "независимо записанный SHA-256 logical export",
  )
  .requiredOption(
    "--manifest-sha256 <sha256>",
    "независимо записанный SHA-256 manifest JSON",
  )
  .option("--db-root <path>", "новый финальный DB root (или BAKA_DB_ROOT)")
  .option(
    "--current-db-root <path>",
    "opt-in: exact stopped internal production bind source; never modified or removed",
  )
  .option(
    "--work-root <path>",
    "internal APFS/POSIX staging base; BAKA_ARCHIVE_ROOT/archive volume запрещён",
  )
  .option("--confirm-rebuild", "разрешить создание и проверку нового DB tree")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (
      exportPath: string,
      options: {
        exportSha256: string;
        manifestSha256: string;
        dbRoot?: string;
        currentDbRoot?: string;
        workRoot?: string;
        confirmRebuild?: boolean;
        json?: boolean;
      },
    ) => {
      await withRestoreTestSignalHandlers(async (signal) => {
        const cfg = loadConfig();
        if (options.currentDbRoot !== undefined && options.dbRoot === undefined) {
          throw new Error("--current-db-root requires an explicit fresh --db-root destination");
        }
        const dbRoot = options.currentDbRoot === undefined
          ? configuredRecoveryDbRoot(cfg.dbRoot, options.dbRoot)
          : options.dbRoot;
        await assertProductionDbStorageSafety(cfg);
        const report = await runRecoveryRebuild(cfg, {
          exportPath,
          expectedExportSha256: options.exportSha256,
          expectedManifestSha256: options.manifestSha256,
          dbRoot,
          currentDbRoot: options.currentDbRoot,
          workRoot: options.workRoot,
          confirmRebuild: options.confirmRebuild ?? false,
          signal,
        });
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const line of formatRecoveryRebuildSuccess(report)) console.log(line);
        }
      });
    }),
  );

program
  .command("recovery:promote <report>")
  .description(
    "Atomic promotion verified recovery tree; сохраняет прежний DB в quarantine и не запускает production",
  )
  .requiredOption(
    "--report-sha256 <sha256>",
    "независимо записанный SHA-256 successful recovery report",
  )
  .requiredOption("--current-db-root <path>", "exact текущий production DB root")
  .requiredOption("--fresh-db-root <path>", "exact проверенный fresh recovery DB root")
  .requiredOption(
    "--quarantine-db-root <path>",
    "exact отсутствующий путь для сохранения прежнего production DB",
  )
  .requiredOption(
    "--stopped-container-id <id>",
    "exact 64-hex ID остановленного baka-surrealdb",
  )
  .option("--confirm-promote", "разрешить два atomic rename с rollback второго")
  .option("--json", "вывести machine-readable promotion report")
  .action(
    handle(async (
      reportPath: string,
      options: {
        reportSha256: string;
        currentDbRoot: string;
        freshDbRoot: string;
        quarantineDbRoot: string;
        stoppedContainerId: string;
        confirmPromote?: boolean;
        json?: boolean;
      },
    ) => {
      const cfg = loadConfig();
      await assertProductionDbStorageSafety(cfg);
      const report = await runRecoveryPromotion(cfg, {
        reportPath,
        expectedReportSha256: options.reportSha256,
        currentDbRoot: options.currentDbRoot,
        freshDbRoot: options.freshDbRoot,
        quarantineDbRoot: options.quarantineDbRoot,
        stoppedContainerId: options.stoppedContainerId,
        confirmPromote: options.confirmPromote ?? false,
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`recovery:promote: ok — ${report.currentDbRoot}`);
        console.log(`previous DB retained: ${report.quarantineDbRoot}`);
        console.log("production remains stopped; database was not opened");
      }
    }),
  );

program
  .command("raw:verify")
  .description("Raw manifest по БД и сверка файлов: существование, size, SHA-256 (docs/plan.md §16.2)")
  .option("--manifest", "сохранить manifest в backups/manifests/raw-manifest-<timestamp>.json")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { manifest?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      const report = await runRawVerify(cfg, { writeManifest: options.manifest ?? false });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`raw:verify: проверено ${report.checked} файлов`);
        for (const item of report.missing) console.log(`  MISSING ${item}`);
        for (const item of report.sizeMismatch) console.log(`  SIZE ${item}`);
        for (const item of report.hashMismatch) console.log(`  HASH ${item}`);
        if (report.orphans.length > 0) {
          console.log(`  внимание: ${report.orphans.length} orphan-файлов (raw без source_revision):`);
          for (const item of report.orphans.slice(0, 20)) console.log(`    ${item}`);
          if (report.orphans.length > 20) console.log(`    … и ещё ${report.orphans.length - 20}`);
        }
        if (report.manifestPath) console.log(`manifest: ${report.manifestPath}`);
        console.log(report.ok ? "raw:verify: ok" : "raw:verify: FAIL");
      }
      if (!report.ok) process.exitCode = 1;
    }),
  );

program
  .command("doctor")
  .description("Inspect по умолчанию; repair только через явные gates (docs/plan.md §17.4)")
  .option("--apply", "применить выбранные repair actions вместо dry-run")
  .option("--allow-destructive", "отдельно разрешить rm/rebuild/manifest overwrite")
  .option("--import-orphan-raw", "импортировать orphan raw только при надёжной provenance")
  .option("--remove-stale-staging", "удалить stale staging")
  .option("--requeue-stuck-embeddings", "вернуть stale processing jobs в pending")
  .option("--rebuild-search-projection", "полностью пересоздать search projection")
  .option("--recalculate-primary-models", "пересчитать dialogue.primary_model")
  .option("--repair-manifest", "пересоздать raw manifest")
  .option("--manifest-path <path>", "manifest внутри archive root")
  .option("--no-enqueue-embeddings", "при projection rebuild не создавать embedding jobs")
  .option("--json", "вывести machine-readable report")
  .action(
    handle(async (options: {
      apply?: boolean;
      allowDestructive?: boolean;
      importOrphanRaw?: boolean;
      removeStaleStaging?: boolean;
      requeueStuckEmbeddings?: boolean;
      rebuildSearchProjection?: boolean;
      recalculatePrimaryModels?: boolean;
      repairManifest?: boolean;
      manifestPath?: string;
      enqueueEmbeddings?: boolean;
      json?: boolean;
    }) => {
      if (options.manifestPath && !options.repairManifest) {
        throw new Error("--manifest-path требует --repair-manifest");
      }
      assertDoctorCliSafety(options);
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const logger = createStructuredLogger({ runId: createRunId("doctor") });
      const doctorOptions: DoctorOptions = {
        dryRun: !options.apply,
        allowDestructive: options.allowDestructive ?? false,
        manifestPath: options.manifestPath,
        importOrphanRaw: options.importOrphanRaw,
        removeStaleStaging: options.removeStaleStaging,
        requeueStuckEmbeddings: options.requeueStuckEmbeddings,
        rebuildSearchProjection: options.rebuildSearchProjection,
        recalculatePrimaryModels: options.recalculatePrimaryModels,
        repairManifest: options.repairManifest,
        logger: operationLogger(logger),
      };
      const connectForDoctor = options.apply && options.rebuildSearchProjection
        ? async (doctorCfg: AppConfig): Promise<Surreal> => {
            const db = await connectDb(doctorCfg);
            try {
              // runDoctor acquires its apply lock before invoking this seam.
              const schemaVersion = await checkSchemaVersion(db);
              if (schemaVersion === 0) {
                throw new Error("схема не инициализирована: сначала baka db migrate");
              }
              const identity = await localIdentity({});
              const host = await ensureHost(db, {
                hostUuid: identity.hostUuid,
                hostname: identity.hostname,
                platform: identity.platform,
                arch: identity.arch,
              });
              doctorOptions.rebuildOptions = {
                host,
                schemaVersion,
                enqueueEmbeddings: options.enqueueEmbeddings ?? true,
                logger: operationLogger(logger),
              };
              return db;
            } catch (error) {
              await db.close().catch(() => {});
              throw error;
            }
          }
        : undefined;
      logger.info("doctor_started", { dryRun: !options.apply });
      const report = await runDoctor(
        cfg,
        doctorOptions,
        connectForDoctor ? { connect: connectForDoctor } : {},
      );
      logger.info("doctor_finished", {
        ok: report.ok,
        findings: report.findings.length,
        actions: report.actions.length,
        manual: report.manual.length,
      });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printDoctorReport(report);
      if (!report.ok) process.exitCode = 1;
    }),
  );

function printDoctorReport(report: DoctorReport): void {
  console.log(`doctor: ${report.ok ? "ok" : "needs attention"} (${report.dryRun ? "dry-run" : "apply"})`);
  for (const issue of report.validation.issues) {
    console.log(`  VALIDATE [${issue.check}] ${issue.detail}`);
  }
  for (const finding of report.findings) {
    console.log(
      `  FINDING [${finding.check}] ${finding.detail}` +
        (finding.repair ? ` → ${finding.repair}` : " → manual"),
    );
  }
  for (const action of report.actions) {
    console.log(`  ACTION ${action.action}: ${action.status}, affected ${action.affected}`);
  }
  for (const manual of report.manual) console.log(`  MANUAL ${manual}`);
}

program
  .command("export-thread <dialogue-id>")
  .description("Экспорт одного dialogue в privacy-safe canonical JSON")
  .option("-o, --output <path>", "файл назначения или - для stdout", "-")
  .option(
    "--include-relative-source-paths",
    "явно включить archive-relative source paths; абсолютные пути всё равно исключены",
  )
  .option("--force", "явно разрешить overwrite существующего regular output file")
  .option("--json", "при file output вывести machine-readable summary")
  .action(
    handle(async (
      dialogueId: string,
      options: {
        output: string;
        includeRelativeSourcePaths?: boolean;
        force?: boolean;
        json?: boolean;
      },
    ) => {
      if (!dialogueId.trim()) throw new Error("dialogue-id не может быть пустым");
      if (options.force && options.output === "-") {
        throw new Error("--force допустим только с file --output");
      }
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      const logger = createStructuredLogger({ runId: createRunId("export_thread") });
      try {
        logger.info("thread_export_started", { dialogueId });
        const result = await exportThread(db, dialogueId, {
          outputPath: options.output,
          includeRelativeSourcePaths: options.includeRelativeSourcePaths ?? false,
          force: options.force ?? false,
        });
        logger.info("thread_export_finished", {
          dialogueId: result.document.dialogue.id,
          revisions: result.document.revisions.length,
          outputMode: result.outputPath ? "file" : "stdout",
        });
        if (!result.outputPath) {
          process.stdout.write(result.json);
        } else if (options.json) {
          console.log(JSON.stringify({
            dialogueId: result.document.dialogue.id,
            revisions: result.document.revisions.length,
            outputPath: result.outputPath,
          }, null, 2));
        } else {
          console.log(`export-thread: ${result.document.dialogue.id}`);
          console.log(`revisions: ${result.document.revisions.length}`);
          console.log(`output: ${result.outputPath}`);
        }
      } finally {
        await db.close();
      }
    }),
  );

export interface ReparseCliSelectionOptions {
  sourceRevision?: string | string[];
  sourceLocation?: string | string[];
  harness?: string;
  all?: boolean;
}

function reparseIds(value: string | string[] | undefined, option: string): string[] | undefined {
  if (value === undefined) return undefined;
  const values = (Array.isArray(value) ? value : [value]).map((item) => item.trim());
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    throw new Error(`${option} не может быть пустым`);
  }
  return [...new Set(values)];
}

export function parseReparseSelection(options: ReparseCliSelectionOptions): ReparseSelection {
  const sourceRevisions = reparseIds(options.sourceRevision, "--source-revision");
  const sourceLocations = reparseIds(options.sourceLocation, "--source-location");
  const selected = [
    sourceRevisions !== undefined,
    sourceLocations !== undefined,
    options.harness !== undefined,
    options.all === true,
  ].filter(Boolean).length;
  if (selected !== 1) {
    throw new Error(
      "reparse требует ровно один selector: --source-revision, --source-location, --harness или --all",
    );
  }
  if (sourceRevisions !== undefined) {
    return { sourceRevisions };
  }
  if (sourceLocations !== undefined) {
    return { sourceLocations };
  }
  if (options.harness !== undefined) {
    const harness = options.harness.trim();
    if (!(harness in HARNESSES)) throw new Error(`неизвестный harness: ${harness}`);
    return { harness: harness as HarnessSlug };
  }
  return { all: true };
}

program
  .command("reparse")
  .description("Повторно разобрать immutable raw с ровно одним selector")
  .option("--source-revision <ids...>", "одна или несколько точных source_revision")
  .option("--source-location <ids...>", "current revisions точных source_location")
  .option("--harness <slug>", "все current revisions harness")
  .option("--all", "все current revisions")
  .option(
    "--parser-version <latest|n>",
    "registered parser version",
    parseParserVersion,
    "latest",
  )
  .option("--only-outdated", "пропустить уже обработанные текущей parser version")
  .option("--dry-run", "только selection/plan, без sync_run/parser/DB writes")
  .option("--no-enqueue-embeddings", "не создавать embedding jobs")
  .option("--no-verify-raw", "не перепроверять SHA-256 raw перед parse")
  .option("--json", "вывести machine-readable summary")
  .action(
    handle(async (options: ReparseCliSelectionOptions & {
      parserVersion: "latest" | number;
      onlyOutdated?: boolean;
      dryRun?: boolean;
      enqueueEmbeddings?: boolean;
      verifyRaw?: boolean;
      json?: boolean;
    }) => {
      const selection = parseReparseSelection(options);
      const cfg = loadConfig();
      const logger = createStructuredLogger({ runId: createRunId("reparse") });
      logger.info("reparse_started", {
        selector: Object.keys(selection)[0],
        dryRun: options.dryRun ?? false,
      });
      const summary = await runReparse(cfg, {
        selection,
        parserVersion: options.parserVersion,
        onlyOutdated: options.onlyOutdated ?? false,
        dryRun: options.dryRun ?? false,
        enqueueEmbeddings: options.enqueueEmbeddings,
        verifyRaw: options.verifyRaw,
        logger: operationLogger(logger),
      });
      logger.info("reparse_finished", {
        syncRunId: summary.syncRunId,
        status: summary.status,
        counters: summary.counters,
      });
      if (options.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`reparse: ${summary.status}${summary.syncRunId ? ` (${summary.syncRunId})` : ""}`);
        for (const [name, count] of Object.entries(summary.counters)) {
          console.log(`  ${name}: ${count}`);
        }
        for (const skipped of summary.skipped) {
          console.log(`  SKIP ${skipped.id}: ${skipped.reason}${skipped.detail ? ` (${skipped.detail})` : ""}`);
        }
        for (const error of summary.errors) console.log(`  ERROR ${error}`);
      }
      if (summary.status === "completed_with_errors") process.exitCode = 1;
    }),
  );

/** Provider для vector/hybrid search по ACTIVE space; деградация §14. */
async function vectorProvider(db: Surreal, cfg: AppConfig): Promise<EmbeddingProvider> {
  const space = await getActiveSpace(db);
  if (!space) {
    throw new VectorSearchUnavailable(
      "нет active embedding_space (baka embeddings space:create + space:activate)",
    );
  }
  if (!cfg.openaiApiKey) {
    throw new VectorSearchUnavailable("OPENAI_API_KEY не задан");
  }
  return new OpenAIEmbeddingProvider({
    apiKey: cfg.openaiApiKey,
    model: space.model,
    dimensions: space.dimensions,
  });
}

/** ProviderFactory worker'а: provider выбирается по space.provider (§13.5). */
function workerProviderFactory(cfg: AppConfig) {
  return defaultProviderFactory({ openaiApiKey: cfg.openaiApiKey });
}

const embeddings = program
  .command("embeddings")
  .description("Embedding pipeline: spaces, jobs worker, backfill (docs/plan.md §13)");

embeddings
  .command("plan")
  .description("Оценка backfill: документы, токены, storage, цена (read-only, §13.6)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const plan = await embeddingsPlan(db, cfg.embeddings);
        if (options.json) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }
        const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
        console.log(`документов (извлечённых): ${plan.documents}`);
        console.log(`сегментов (search_documents): ${plan.segments}`);
        console.log(`оценка токенов: ${plan.estimatedTokens}`);
        console.log(`сегментов свыше target ${TARGET_TOKENS}: ${plan.overTarget}`);
        console.log(`pending jobs: ${plan.pendingJobs}`);
        for (const space of plan.spaces) {
          console.log(
            `space ${space.slug}${space.active ? " (active)" : ""}: ${space.dimensions}d, ` +
              `оценка vector storage ${mib(space.estimatedVectorBytes)} (F32, без overhead HNSW)`,
          );
        }
        if (plan.spaces.length === 0) console.log("spaces: нет (baka embeddings space:create)");
        console.log(
          plan.estimatedPriceUsd !== undefined
            ? `цена: $${plan.pricePer1MTokens}/1M токенов → оценка $${plan.estimatedPriceUsd.toFixed(4)}`
            : "цена: не настроена (OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS в .env)",
        );
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("exact-tokens")
  .description("Exact token count через pinned uv script; private report 0600")
  .requiredOption("--model <name>", "embedding model для tokenizer")
  .requiredOption("--report <path>", "явный путь private JSON report")
  .option(
    "--batch-size <n>",
    "документов на один tokenizer process",
    (value) => parsePositiveInteger(value, "--batch-size"),
    64,
  )
  .option("--overwrite", "явно перезаписать существующий report")
  .option("--json", "вывести report в JSON")
  .action(
    handle(async (options: {
      model: string;
      report: string;
      batchSize: number;
      overwrite?: boolean;
      json?: boolean;
    }) => {
      if (!options.model.trim()) throw new Error("--model не может быть пустым");
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "embeddings exact-tokens");
      let db: Surreal | undefined;
      const logger = createStructuredLogger({ runId: createRunId("exact_token_count") });
      try {
        db = await connectDb(cfg);
        const counter = createCommandTokenCounter(exactTokenizerCommandOptions(options.model));
        logger.info("exact_token_count_started", { model: options.model });
        const report = await exactEmbeddingsPlan(db, counter, {
          batchSize: options.batchSize,
          privacy: normalizedEmbeddingPrivacy(cfg.embeddings),
          pricePer1MTokens: cfg.embeddings.pricePer1MTokens,
          onProgress: (progress) => logger.info("exact_token_count_progress", progress),
        });
        await writeExactTokenCountReport(options.report, report, {
          overwrite: options.overwrite ?? false,
        });
        logger.info("exact_token_count_finished", {
          documents: report.corpus.documents,
          totalTokens: report.counts.totalTokens,
          atOrOverModelLimit: report.counts.atOrOverModelLimit,
        });
        if (options.json) {
          console.log(JSON.stringify({ reportPath: path.resolve(options.report), report }, null, 2));
        } else {
          console.log(`exact tokens: ${report.counts.totalTokens} (${report.corpus.documents} documents)`);
          console.log(`maximum document: ${report.counts.maximumDocumentTokens}`);
          console.log(`at/over model limit: ${report.counts.atOrOverModelLimit}`);
          console.log(
            report.price
              ? `price from env: $${report.price.configuredPricePer1MTokens}/1M → $${report.price.exactPriceUsd.toFixed(4)}`
              : "price: не задана (OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS)",
          );
          console.log(`report: ${path.resolve(options.report)}`);
        }
      } finally {
        if (db) await db.close();
        await release();
      }
    }),
  );

const candidates = embeddings
  .command("candidates")
  .description("Bounded Stage 11 candidate embedding workflow; не authorizes full backfill");

candidates
  .command("plan")
  .description("Read-only cryptographic plan for exactly three candidate spaces")
  .requiredOption("--judgments <path>", "private judgment set used to bind required dialogues")
  .requiredOption("--spaces <csv>", "exactly three §13.2 candidate spaces")
  .requiredOption(
    "--max-documents <n>",
    `bounded subset size (1..${MAX_EVALUATION_CANDIDATE_DOCUMENTS})`,
    (value) => parsePositiveInteger(value, "--max-documents"),
  )
  .requiredOption(
    "--max-jobs-per-space <n>",
    `paid jobs per candidate (1..${MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE})`,
    (value) => parsePositiveInteger(value, "--max-jobs-per-space"),
  )
  .requiredOption("--selection-seed-sha256 <sha256>", "auditable deterministic selection seed")
  .requiredOption("--report <path>", "private candidate plan JSON")
  .option("--overwrite", "explicitly replace an existing candidate plan")
  .option("--json", "print machine-readable plan")
  .action(handle(async (options: {
    judgments: string;
    spaces: string;
    maxDocuments: number;
    maxJobsPerSpace: number;
    selectionSeedSha256: string;
    report: string;
    overwrite?: boolean;
    json?: boolean;
  }) => {
    const set = await loadJudgmentSet(options.judgments);
    const cfg = loadConfig();
    const candidateOptions = boundedCandidateOptions({
      privacy: cfg.embeddings,
      spaces: parseCsv(options.spaces, "--spaces"),
      maxDocuments: options.maxDocuments,
      maxJobsPerSpace: options.maxJobsPerSpace,
      selectionSeedSha256: options.selectionSeedSha256,
      judgmentSet: set,
    });
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "embeddings candidates plan");
    let db: Surreal | undefined;
    try {
      db = await connectDb(cfg);
      const plan = await prepareEvaluationCandidatePlan(db, candidateOptions);
      await writeEvaluationCandidatePlan(options.report, plan, {
        overwrite: options.overwrite ?? false,
      });
      if (options.json) {
        console.log(JSON.stringify({ reportPath: path.resolve(options.report), plan }, null, 2));
      } else {
        console.log(
          `candidate plan: ${plan.subset.documents.length}/${plan.fullEligibleCorpus.documents} documents, ` +
          `${plan.spaces.length} spaces`,
        );
        console.log(`plan sha256: ${plan.planSha256}`);
        for (const blocker of plan.blockers) console.log(`  BLOCKER ${blocker}`);
        console.log(`confirmation: ${plan.confirmation}`);
        console.log(`report: ${path.resolve(options.report)}`);
      }
      if (plan.blockers.length > 0) process.exitCode = 1;
    } finally {
      if (db) await db.close();
      await release();
    }
  }));

candidates
  .command("run")
  .description("Run only jobs cryptographically bound by a bounded candidate plan")
  .requiredOption("--plan <path>", "private candidate plan JSON from candidates plan")
  .requiredOption("--judgments <path>", "same private judgment set used by the plan")
  .requiredOption("--confirm <phrase>", "exact confirmation phrase from candidate plan")
  .option(
    "--batch-size <n>",
    "provider batch size",
    (value) => parsePositiveInteger(value, "--batch-size"),
  )
  .option("--allow-paid-api", "explicitly authorize bounded external provider calls")
  .option("--json", "print machine-readable plan and summaries")
  .action(handle(async (options: {
    plan: string;
    judgments: string;
    confirm: string;
    batchSize?: number;
    allowPaidApi?: boolean;
    json?: boolean;
  }) => {
    if (!options.allowPaidApi) {
      throw new Error("embeddings candidates run требует --allow-paid-api");
    }
    if (options.batchSize !== undefined && options.batchSize > BATCH_SIZE) {
      throw new Error(`--batch-size должен быть <= ${BATCH_SIZE}`);
    }
    const [planArtifact, set] = await Promise.all([
      loadEvaluationCandidatePlanArtifact(options.plan),
      loadJudgmentSet(options.judgments),
    ]);
    const plan = planArtifact.plan;
    if (options.confirm !== plan.confirmation) {
      throw new Error("evaluation candidate confirmation mismatch");
    }
    const cfg = loadConfig();
    const candidateOptions = boundedCandidateOptions({
      privacy: cfg.embeddings,
      spaces: plan.spaces.map((item) => item.space.slug),
      maxDocuments: plan.subset.limit,
      maxJobsPerSpace: plan.maxJobsPerSpace,
      selectionSeedSha256: plan.subset.selectionSeedSha256,
      judgmentSet: set,
    });
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "embeddings candidates run");
    let db: Surreal | undefined;
    const logger = createStructuredLogger({ runId: createRunId("embedding_candidates") });
    try {
      db = await connectDb(cfg);
      const current = await prepareEvaluationCandidatePlan(db, candidateOptions);
      if (current.planSha256 !== plan.planSha256 || current.confirmation !== options.confirm) {
        throw new Error("evaluation candidate plan drifted before paid operation");
      }
      logger.info("embedding_candidates_started", {
        spaces: plan.spaces.map((item) => item.space.slug),
        documents: plan.subset.documents.length,
        maxJobsPerSpace: plan.maxJobsPerSpace,
      });
      const result = await runConfirmedEvaluationCandidateBackfill(
        db,
        workerProviderFactory(cfg),
        {
          ...candidateOptions,
          confirmation: options.confirm,
          allowExternalProviderCalls: true,
          batchSize: options.batchSize,
          logger: operationLogger(logger),
        },
      );
      logger.info("embedding_candidates_finished", {
        spaces: Object.keys(result.summaries).sort(),
        completed: Object.values(result.summaries)
          .reduce((sum, summary) => sum + summary.completed, 0),
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`candidate plan sha256: ${result.plan.planSha256}`);
        for (const [space, summary] of Object.entries(result.summaries).sort(([a], [b]) => a.localeCompare(b))) {
          console.log(
            `${space}: completed ${summary.completed}, retryable ${summary.failed}, ` +
            `permanent ${summary.permanentErrors}, prompt tokens ${summary.promptTokens}`,
          );
        }
      }
    } finally {
      if (db) await db.close();
      await release();
    }
  }));

export function formatProductionBackfillPlan(plan: ProductionBackfillPlan): string[] {
  const lines = [
    `space: ${plan.space.slug} (${plan.space.model}, ${plan.space.dimensions}d)`,
    `corpus: ${plan.corpusDocuments}, eligible ${plan.eligibleDocuments}, ` +
      `privacy-excluded ${plan.privacyExcludedDocuments}`,
    `eligible exact tokens: ${plan.eligibleTokens}`,
    `exact eligible price from env: $${plan.exactPriceUsd.toFixed(4)}`,
    `max jobs bound into plan: ${plan.maxJobs}`,
    `accepted relevance scenario: ${plan.relevanceEvidence.scenarioId}`,
    `jobs: ${Object.entries(plan.jobs).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status} ${count}`).join(", ") || "—"}`,
    `progress: vectors ${plan.vectors}, runnable jobs ${plan.runnableJobs.length}`,
  ];
  for (const blocker of plan.blockers) lines.push(`  BLOCKER ${blocker}`);
  for (const item of plan.permanentErrors) {
    lines.push(`  PERMANENT ${item.jobId} (${item.documentId}): ${item.error}`);
  }
  lines.push(`confirmation: ${plan.confirmation}`);
  return lines;
}

function printProductionBackfillPlan(plan: ProductionBackfillPlan): void {
  for (const line of formatProductionBackfillPlan(plan)) console.log(line);
}

const backfill = embeddings
  .command("backfill")
  .description("Production backfill с exact-report и paid-call gates");

backfill
  .command("plan")
  .description("Read-only production backfill plan; provider не вызывается")
  .requiredOption("--space <slug>", "embedding space")
  .requiredOption("--exact-report <path>", "exact token report")
  .requiredOption("--accepted-relevance <path>", "явный accepted relevance evidence JSON")
  .requiredOption(
    "--max-jobs <n>",
    "жёсткий лимит, включаемый в confirmation plan",
    (value) => parsePositiveInteger(value, "--max-jobs"),
  )
  .option("--json", "вывести machine-readable plan")
  .action(
    handle(async (options: {
      space: string;
      exactReport: string;
      acceptedRelevance: string;
      maxJobs: number;
      json?: boolean;
    }) => {
      const cfg = loadConfig();
      const exactReport = await loadExactReport(options.exactReport);
      const acceptedRelevance = await loadAcceptedRelevance(options.acceptedRelevance);
      const pricePer1MTokens = requireEmbeddingPrice(cfg.embeddings.pricePer1MTokens);
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "embeddings backfill plan");
      let db: Surreal | undefined;
      try {
        db = await connectDb(cfg);
        const plan = await prepareProductionBackfill(db, options.space, exactReport, {
          privacy: normalizedEmbeddingPrivacy(cfg.embeddings),
          pricePer1MTokens,
          maxJobs: options.maxJobs,
          acceptedRelevance,
        });
        if (options.json) console.log(JSON.stringify(plan, null, 2));
        else printProductionBackfillPlan(plan);
        if (plan.blockers.length > 0) process.exitCode = 1;
      } finally {
        if (db) await db.close();
        await release();
      }
    }),
  );

backfill
  .command("run")
  .description("Один ограниченный paid batch; требует два явных подтверждения")
  .requiredOption("--space <slug>", "embedding space")
  .requiredOption("--exact-report <path>", "exact token report")
  .requiredOption("--accepted-relevance <path>", "тот же accepted relevance evidence JSON, что в plan")
  .requiredOption("--confirm <phrase>", "точная confirmation-фраза из backfill plan")
  .requiredOption(
    "--max-jobs <n>",
    "жёсткий лимит jobs этого запуска",
    (value) => parsePositiveInteger(value, "--max-jobs"),
  )
  .option(
    "--batch-size <n>",
    "provider batch size",
    (value) => parsePositiveInteger(value, "--batch-size"),
  )
  .option("--allow-paid-api", "явно разрешить внешний/платный embedding provider")
  .option("--json", "вывести plan и summary в JSON")
  .action(
    handle(async (options: {
      space: string;
      exactReport: string;
      acceptedRelevance: string;
      confirm: string;
      maxJobs: number;
      batchSize?: number;
      allowPaidApi?: boolean;
      json?: boolean;
    }) => {
      if (!options.allowPaidApi) {
        throw new Error("embeddings backfill run требует --allow-paid-api");
      }
      if (options.batchSize !== undefined && options.batchSize > BATCH_SIZE) {
        throw new Error(`--batch-size должен быть <= ${BATCH_SIZE}`);
      }
      const cfg = loadConfig();
      const exactReport = await loadExactReport(options.exactReport);
      const acceptedRelevance = await loadAcceptedRelevance(options.acceptedRelevance);
      const pricePer1MTokens = requireEmbeddingPrice(cfg.embeddings.pricePer1MTokens);
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "embeddings backfill run");
      let db: Surreal | undefined;
      const logger = createStructuredLogger({ runId: createRunId("embedding_backfill") });
      try {
        db = await connectDb(cfg);
        logger.info("embedding_backfill_started", {
          space: options.space,
          maxJobs: options.maxJobs,
        });
        const result = await runConfirmedProductionBackfill(
          db,
          workerProviderFactory(cfg),
          options.space,
          {
            exactReport,
            confirmation: options.confirm,
            allowExternalProviderCalls: true,
            maxJobs: options.maxJobs,
            batchSize: options.batchSize,
            privacy: normalizedEmbeddingPrivacy(cfg.embeddings),
            pricePer1MTokens,
            acceptedRelevance,
            logger: operationLogger(logger),
          },
        );
        logger.info("embedding_backfill_finished", { ...result.summary });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          printProductionBackfillPlan(result.plan);
          console.log(
            `run: completed ${result.summary.completed}, retryable ${result.summary.failed}, ` +
              `permanent ${result.summary.permanentErrors}, prompt tokens ${result.summary.promptTokens}`,
          );
        }
      } finally {
        if (db) await db.close();
        await release();
      }
    }),
  );

const embeddingPrivacy = embeddings
  .command("privacy")
  .description("Provider-free reconciliation of embedding jobs/vectors with current privacy policy");

embeddingPrivacy
  .command("plan")
  .description("Read-only exact privacy transition plan; provider is never constructed or called")
  .requiredOption("--space <slug>", "embedding space")
  .requiredOption("--report <path>", "private exact reconciliation plan JSON")
  .option("--overwrite", "explicitly replace an existing plan")
  .option("--json", "print machine-readable plan")
  .action(handle(async (options: {
    space: string;
    report: string;
    overwrite?: boolean;
    json?: boolean;
  }) => {
    const cfg = loadConfig();
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "embeddings privacy plan");
    let db: Surreal | undefined;
    try {
      db = await connectDb(cfg);
      const plan = await preparePrivacyReconciliation(
        db,
        options.space,
        normalizedEmbeddingPrivacy(cfg.embeddings),
      );
      await writePrivacyReconciliationPlan(options.report, plan, {
        overwrite: options.overwrite ?? false,
      });
      if (options.json) {
        console.log(JSON.stringify({ reportPath: path.resolve(options.report), plan }, null, 2));
      } else {
        console.log(
          `privacy plan ${plan.space.slug}: actions ${plan.actions.length}, ` +
            `jobs ${plan.jobs}, vectors ${plan.vectors}`,
        );
        for (const blocker of plan.blockers) console.log(`  BLOCKER ${blocker}`);
        console.log(`confirmation: ${plan.confirmation}`);
        console.log(`report: ${path.resolve(options.report)}`);
      }
      if (plan.blockers.length > 0) process.exitCode = 1;
    } finally {
      if (db) await db.close();
      await release();
    }
  }));

embeddingPrivacy
  .command("apply")
  .description("Apply an unchanged provider-free privacy plan and immediately re-audit")
  .requiredOption("--plan <path>", "private exact plan from embeddings privacy plan")
  .requiredOption("--confirm <phrase>", "exact confirmation phrase from the plan")
  .option("--json", "print machine-readable result")
  .action(handle(async (options: { plan: string; confirm: string; json?: boolean }) => {
    const [approvedPlan, cfg] = await Promise.all([
      loadPrivacyReconciliationPlan(options.plan),
      Promise.resolve(loadConfig()),
    ]);
    const currentPrivacy = normalizedEmbeddingPrivacy(cfg.embeddings);
    if (
      JSON.stringify(normalizedEmbeddingPrivacy(approvedPlan.privacy)) !==
        JSON.stringify(currentPrivacy)
    ) {
      throw new Error("embedding privacy plan differs from current normalized privacy policy");
    }
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "embeddings privacy apply");
    let db: Surreal | undefined;
    try {
      db = await connectDb(cfg);
      const result = await applyPrivacyReconciliation(db, approvedPlan, options.confirm);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `privacy applied: cancelled ${result.cancelled}, requeued ${result.requeued}, ` +
            `vectors deleted ${result.vectorsDeleted}; immediate audit ok`,
        );
      }
    } finally {
      if (db) await db.close();
      await release();
    }
  }));

embeddings
  .command("audit")
  .description("Strict read-only terminal jobs/vectors/hashes/dimensions/orphans + HNSW KnnScan audit")
  .requiredOption("--space <slug>", "embedding space")
  .option(
    "--page-size <n>",
    "dimension audit page size (1..1000)",
    (value) => parsePositiveInteger(value, "--page-size"),
    100,
  )
  .option("--json", "вывести audit reports в JSON")
  .action(
    handle(async (options: { space: string; pageSize: number; json?: boolean }) => {
      if (options.pageSize > 1000) throw new Error("--page-size должен быть <= 1000");
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const [audit, dimensions, hnsw] = await Promise.all([
          auditProductionEmbeddingSpace(
            db,
            options.space,
            normalizedEmbeddingPrivacy(cfg.embeddings),
          ),
          auditVectorDimensions(db, options.space, options.pageSize),
          auditHnswIndex(db, options.space),
        ]);
        const ok = audit.ok && dimensions.wrongDimensions.length === 0 && hnsw.usesKnnScan;
        if (options.json) {
          console.log(JSON.stringify({ ok, audit, dimensions, hnsw }, null, 2));
        } else {
          console.log(
            `terminal coverage: ${audit.eligibleDocuments} eligible, ` +
              `${audit.privacyExcludedDocuments} privacy-excluded, ` +
              `${audit.jobs} jobs, ${audit.vectors} vectors`,
          );
          console.log(
            `dimensions: ${dimensions.wrongDimensions.length === 0 ? "ok" : "FAIL"}, ` +
              `vectors ${dimensions.vectors}, wrong ${dimensions.wrongDimensions.length}`,
          );
          for (const wrong of dimensions.wrongDimensions) {
            console.log(`  ${wrong.vectorId}: ${wrong.actual}, expected ${wrong.expected}`);
          }
          console.log(
            `HNSW EXPLAIN FULL: ${hnsw.usesKnnScan ? "KnnScan/vector_hnsw" : "FAIL"}`,
          );
          for (const blocker of audit.blockers) console.log(`  BLOCKER ${blocker}`);
        }
        if (!ok) process.exitCode = 1;
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("run")
  .description("Disabled compatibility stub; generic mock-only worker is not exposed by CLI")
  .requiredOption(
    "--limit <n>",
    `positive bounded compatibility limit (max ${MAX_GENERIC_EMBEDDING_LIMIT})`,
    (value) => parsePositiveInteger(value, "--limit"),
  )
  .requiredOption("--space <slug>", "explicit embedding space")
  .option("--allow-paid-api", "explicit paid API intent; workflow authorization still required")
  .action(
    handle(async (options: { limit: number; space: string; allowPaidApi?: boolean }) => {
      assertGenericEmbeddingRunDisabled(options);
    }),
  );

embeddings
  .command("status")
  .description("Jobs по статусам и vectors по каждому space")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const statuses = await embeddingsStatus(db);
        if (options.json) {
          console.log(JSON.stringify(statuses, null, 2));
          return;
        }
        if (statuses.length === 0) {
          console.log("embedding spaces: нет");
          return;
        }
        for (const s of statuses) {
          console.log(
            `${s.slug}${s.active ? " (active)" : ""}: ${s.provider}/${s.model} ${s.dimensions}d, ` +
              `vectors ${s.vectors}, jobs: ` +
              (Object.entries(s.jobs).map(([k, v]) => `${k} ${v}`).join(", ") || "—"),
          );
        }
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("retry")
  .description("Вернуть retryable/permanent error jobs в pending (§13.6)")
  .option("--space <slug>", "только один embedding space")
  .action(
    handle(async (options: { space?: string }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const n = await retryFailedJobs(db, options.space);
        console.log(`возвращено в pending: ${n} jobs`);
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("cancel")
  .description("Отменить pending/retryable jobs (status = cancelled)")
  .option("--space <slug>", "только один embedding space")
  .action(
    handle(async (options: { space?: string }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const n = await cancelPendingJobs(db, options.space);
        console.log(`отменено: ${n} jobs`);
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("space:create")
  .description("Создать embedding space + vector-таблицу с HNSW + backfill jobs (§13.1)")
  .option("--slug <slug>", "slug space (по умолчанию <provider>_<model>_<dims>_v1)")
  .option("--provider <name>", "provider", "openai")
  .option("--model <name>", "модель", "text-embedding-3-large")
  .option("--dimensions <n>", "размерность", Number, 1024)
  .option("--activate", "сразу сделать active (прежний active снимается)")
  .action(
    handle(
      async (options: {
        slug?: string;
        provider: string;
        model: string;
        dimensions: number;
        activate?: boolean;
      }) => {
        const cfg = loadConfig();
        await assertPreflight(cfg);
        const release = await acquireLock(cfg.archiveRoot, "embeddings space:create");
        let db: Surreal | undefined;
        try {
          db = await connectDb(cfg);
          const result = await createSpace(db, {
            slug: options.slug,
            provider: options.provider,
            model: options.model,
            dimensions: options.dimensions,
            activate: options.activate ?? false,
          });
          console.log(
            `space ${result.space.slug}: таблица ${result.space.physical_table} ` +
              `(HNSW ${result.space.dimensions}d F32 COSINE), backfill jobs: ${result.backfilledJobs}` +
              (result.existingJobs > 0 ? ` (уже было ${result.existingJobs})` : "") +
              (result.space.active ? ", active" : ""),
          );
        } finally {
          if (db) await db.close();
          await release();
        }
      },
    ),
  );

embeddings
  .command("space:activate <slug>")
  .description("Сделать space активным (старый space не уничтожается, §13.1)")
  .action(
    handle(async (slug: string) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const space = await activateSpace(db, slug);
        console.log(`active space: ${space.slug}`);
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("space:list")
  .description("Список embedding spaces")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const spaces = await listSpaces(db);
        if (options.json) {
          console.log(JSON.stringify(spaces, null, 2));
          return;
        }
        if (spaces.length === 0) {
          console.log("embedding spaces: нет");
          return;
        }
        for (const s of spaces) {
          console.log(
            `${s.slug}${s.active ? " (active)" : ""}: ${s.provider}/${s.model} ${s.dimensions}d ` +
              `${s.distance}/${s.vector_type}, таблица ${s.physical_table}, segmentation v${s.segmentation_version}`,
          );
        }
      } finally {
        await db.close();
      }
    }),
  );

const retireEmbeddingSpace = embeddings
  .command("space:retire")
  .description("Safely retire one rejected inactive candidate while preserving active/accepted spaces");

retireEmbeddingSpace
  .command("plan")
  .description("Read-only exact target and protected-space retirement plan")
  .requiredOption("--space <slug>", "rejected inactive candidate space")
  .requiredOption("--accepted-space <slug>", "operator-selected accepted space to protect")
  .requiredOption("--report <path>", "private exact retirement plan JSON")
  .option("--overwrite", "explicitly replace an existing plan")
  .option("--json", "print machine-readable plan")
  .action(handle(async (options: {
    space: string;
    acceptedSpace: string;
    report: string;
    overwrite?: boolean;
    json?: boolean;
  }) => {
    const cfg = loadConfig();
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "embeddings space:retire plan");
    let db: Surreal | undefined;
    try {
      db = await connectDb(cfg);
      const plan = await prepareRetireSpace(db, options.space, options.acceptedSpace);
      await writeRetireSpacePlan(options.report, plan, {
        overwrite: options.overwrite ?? false,
      });
      if (options.json) {
        console.log(JSON.stringify({ reportPath: path.resolve(options.report), plan }, null, 2));
      } else {
        console.log(
          `retire plan ${plan.space.slug}: jobs ${plan.jobs.count}, vectors ${plan.vectors.count}; ` +
            `protected ${plan.protectedSpaces.map((space) => space.slug).join(", ")}`,
        );
        for (const blocker of plan.blockers) console.log(`  BLOCKER ${blocker}`);
        console.log(`confirmation: ${plan.confirmation}`);
        console.log(`report: ${path.resolve(options.report)}`);
      }
      if (plan.blockers.length > 0) process.exitCode = 1;
    } finally {
      if (db) await db.close();
      await release();
    }
  }));

retireEmbeddingSpace
  .command("run")
  .description("Retire only the unchanged rejected target and verify protected spaces immediately")
  .requiredOption("--plan <path>", "private exact plan from embeddings space:retire plan")
  .requiredOption("--accepted-space <slug>", "same independently selected accepted space")
  .requiredOption("--confirm <phrase>", "exact confirmation phrase from the plan")
  .option("--json", "print machine-readable result")
  .action(handle(async (options: {
    plan: string;
    acceptedSpace: string;
    confirm: string;
    json?: boolean;
  }) => {
    const approvedPlan = await loadRetireSpacePlan(options.plan);
    if (options.acceptedSpace !== approvedPlan.acceptedSpaceSlug) {
      throw new Error("embedding space retire accepted-space mismatch");
    }
    const cfg = loadConfig();
    await assertPreflight(cfg);
    const release = await acquireLock(cfg.archiveRoot, "embeddings space:retire run");
    let db: Surreal | undefined;
    try {
      db = await connectDb(cfg);
      const result = await retireSpace(db, approvedPlan, options.confirm);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `retired ${result.slug}: jobs ${result.jobsDeleted}, vectors ${result.vectorsDeleted}; ` +
            "canonical corpus and protected active/accepted spaces verified unchanged",
        );
      }
    } finally {
      if (db) await db.close();
      await release();
    }
  }));

embeddings
  .command("rebuild")
  .description("Stale jobs (смена extraction/segmentation) обратно в pending + удалить их vectors (§13.5)")
  .requiredOption("--space <slug>", "embedding space")
  .action(
    handle(async (options: { space: string }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const summary = await rebuildStaleJobs(db, options.space);
        console.log(
          `rebuild: stale jobs → pending ${summary.resetToPending}, ` +
            `orphan jobs удалено ${summary.orphansDeleted}, stale vectors удалено ${summary.vectorsDeleted}`,
        );
      } finally {
        await db.close();
      }
    }),
  );

const DEFAULT_LEGACY_DB =
  process.env.BAKA_LEGACY_DB?.trim() ||
  "/Volumes/Archive/Legacy Conversations/index.sqlite";

const migration = program
  .command("migration")
  .description("Миграция legacy SQLite-архива (docs/plan.md §15)");

interface MigrationExecutionCliOptions {
  legacyDb: string;
  approval: string;
  attestation: string;
  hostMappingApproval: string;
  restoreReport: string;
  approvalPublicKey: string;
  approvalKeySha256: string;
  report: string;
  apply?: boolean;
  json?: boolean;
}

function addMigrationExecutionOptions(command: Command): Command {
  return command
    .option(
      "--legacy-db <path>",
      "read-only legacy index.sqlite; importer работает только со snapshot",
      DEFAULT_LEGACY_DB,
    )
    .requiredOption("--approval <path>", "exact operator-approved preflight artifact JSON")
    .requiredOption("--attestation <path>", "detached canonical Ed25519 attestation JSON")
    .requiredOption(
      "--host-mapping-approval <path>",
      "exact approved §15.6 host-mapping artifact JSON",
    )
    .requiredOption("--restore-report <path>", "strict persisted RestoreTestReport v5 JSON")
    .requiredOption(
      "--approval-public-key <path>",
      "independently configured Ed25519 SPKI public-key PEM (never from attestation)",
    )
    .requiredOption(
      "--approval-key-sha256 <sha256>",
      "independently pinned SHA-256 of public key SPKI DER",
    )
    .requiredOption("--report <path>", "exclusive durable reconciliation report JSON target")
    .option("--apply", "явно разрешить запись только в новый архив/SurrealDB")
    .option("--json", "вывести один machine-readable JSON result");
}

function printMigrationRunReport(operation: "run" | "retry", report: MigrationRunReport): void {
  const reconciliation = report.reconciliation;
  console.log(`migration ${operation}: ${report.status}`);
  console.log(`snapshot sha256: ${report.snapshotSha256}`);
  console.log(`migration: ${report.migrationId ?? "—"}, sync: ${report.syncRunId ?? "—"}`);
  console.log(
    `rows: total ${reconciliation.legacyTotal}, matched ${reconciliation.matched}, ` +
      `inserted ${reconciliation.inserted}, quarantined ${reconciliation.quarantined}, ` +
      `lost ${reconciliation.lost}`,
  );
  console.log(
    `recovery: raw ${report.recovery.raw}, payload ${report.recovery.payload}, ` +
      `normalized ${report.recovery.normalized}`,
  );
  console.log(
    `host attribution: approved ${report.hostAttribution.approvedMappings.length}, ` +
      `uncertain ${report.hostAttribution.uncertainty.length}`,
  );
  console.log(`report: ${report.reportPath ?? "—"}`);
}

/** Final CLI-side production assertion over the durable runner result. */
export function assertMigrationProductionOutcome(
  report: MigrationRunReport,
  hostMapping: LegacyHostMappingApproval,
): void {
  const reconciliation = report.reconciliation;
  if (
    report.status !== "completed" || !reconciliation.ok || reconciliation.lost !== 0 ||
    reconciliation.quarantined !== 0 || reconciliation.accounted !== reconciliation.legacyTotal ||
    report.assignmentCoverageOk !== true
  ) throw new Error("migration production reconciliation is not complete");
  for (const [table, counts] of Object.entries(reconciliation.tables)) {
    if (counts.lost !== 0 || counts.accounted !== counts.total) {
      throw new Error(`migration production reconciliation table mismatch: ${table}`);
    }
  }
  if (report.hostAttribution.uncertainty.length !== 0) {
    throw new Error("migration production host attribution contains uncertainty");
  }
  if (
    canonicalMigrationJson(report.hostAttribution.actualAssignments) !==
    canonicalMigrationJson(hostMapping.assignments)
  ) throw new Error("migration production host assignments differ from approval");
  const assignmentCounts = new Map<string, number>();
  for (const assignment of hostMapping.assignments) {
    assignmentCounts.set(
      assignment.mappingId,
      (assignmentCounts.get(assignment.mappingId) ?? 0) + 1,
    );
  }
  const expectedMappings = hostMapping.mappings.map((mapping) => ({
    mappingId: mapping.mappingId,
    hostUuid: mapping.host.hostUuid,
    attributedRows: assignmentCounts.get(mapping.mappingId) ?? 0,
  })).sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  const actualMappings = [...report.hostAttribution.approvedMappings]
    .sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  if (canonicalMigrationJson(actualMappings) !== canonicalMigrationJson(expectedMappings)) {
    throw new Error("migration production host attribution counts differ from approval");
  }
}

async function executeMigration(
  operation: "run" | "retry",
  options: MigrationExecutionCliOptions,
): Promise<void> {
  assertMigrationApply(options);
  let release: (() => Promise<void>) | undefined;
  const logger = createStructuredLogger({ runId: createRunId(`migration_${operation}`) });
  try {
    if (!options.legacyDb.trim()) throw new Error("legacy DB path is empty");
    const cfg = loadConfig();
    const artifacts = await loadStrictMigrationCliArtifacts({
      approvalPath: options.approval,
      attestationPath: options.attestation,
      hostMappingApprovalPath: options.hostMappingApproval,
      restoreReportPath: options.restoreReport,
      approvalPublicKeyPath: options.approvalPublicKey,
      approvalKeySha256: options.approvalKeySha256,
    });
    await assertPreflight(cfg);
    release = await acquireLock(cfg.archiveRoot, `migration ${operation} --apply`);
    const snapshot = await ensureLegacySnapshot(options.legacyDb, cfg.archiveRoot);
    const reportPath = path.resolve(options.report);
    const prepared = await runMigrationPreBackupGate({
      emit: operationLogger(logger),
      loadApproval: async () => artifacts,
      verifySnapshot: async ({ approval }) => {
        const verified = await verifyMigrationSnapshot(
          snapshot.snapshotPath,
          snapshot.sha256,
          snapshot.sizeBytes,
        );
        if (
          approval.evidence.snapshotSha256 !== verified.sha256 ||
          approval.evidence.snapshotSizeBytes !== verified.sizeBytes
        ) throw new Error("operator approval is bound to a different snapshot");
        return verified;
      },
      verifyHostMapping: async ({ approval, hostMapping }, verified) => {
        const rebuilt = buildLegacyHostMappingApproval(
          snapshot.snapshotPath,
          verified.sha256,
          hostMapping.mappings,
        );
        if (
          canonicalMigrationJson(rebuilt) !== canonicalMigrationJson(hostMapping) ||
          hostMapping.artifactSha256 !== approval.evidence.hostMappingArtifactSha256
        ) throw new Error("host mapping approval artifact SHA mismatch");
        return hostMapping;
      },
      verifyLiveEvidence: async ({ approval }, verified) => {
        let schemaDb: Surreal | undefined;
        let schemaVersion: number;
        let currentLiveProbe: LiveCorpusProbe;
        try {
          schemaDb = await connectDb(cfg);
          schemaVersion = await checkSchemaVersion(schemaDb);
          if (schemaVersion < 5) {
            throw new Error(`migration requires schema >= 5; current ${schemaVersion}`);
          }
          currentLiveProbe = await probeLiveCorpusFromDb(schemaDb);
        } finally {
          if (schemaDb) await schemaDb.close();
        }
        await verifyFreshMigrationApprovalEvidence(
          snapshot.snapshotPath,
          verified.sha256,
          approval,
          currentLiveProbe,
        );
        return { currentLiveProbe, schemaVersion };
      },
      verifyReportTarget: () => assertMigrationReportTargetAvailable(reportPath),
    });
    const { approval, approvalFile, attestation, trustAnchor, restoreReport } = prepared.approval;
    const hostMapping = prepared.mapping;
    const approvedHostMappings = hostMapping.mappings;
    const { currentLiveProbe, schemaVersion } = prepared.live;
    const { safety, context: safetyContext } = await loadConfiguredMigrationSafetyEvidence({
      cfg,
      schemaVersion,
      restoreReport,
      restoreReportPath: artifacts.restoreReportFile.path,
    });
    const authorization: MigrationRunAuthorization = {
      approval,
      approvalFile,
      attestation,
      currentLiveProbe,
      hostMapping,
      safety,
    };
    // Reject forged/copied trust inputs before opening the Surreal writer.
    await validateMigrationRunAttestation(authorization, trustAnchor);
    const identity = await localIdentity();
    const base = {
      snapshotPath: snapshot.snapshotPath,
      snapshotSha256: snapshot.sha256,
      snapshotSizeBytes: snapshot.sizeBytes,
      bakaCommit: gitHead(),
      schemaVersion,
      reportPath,
      onThreadSpeedCheckpoint: (checkpoint: {
        processedThreads: 100;
        elapsedMs: number;
        maxElapsedMs: number;
        withinLimit: boolean;
      }) => {
        logger.info("migration_thread_speed_checkpoint", checkpoint);
      },
    };
    logger.info("migration_started", {
      operation,
      snapshotSha256: snapshot.sha256,
      approvalArtifactSha256: approval.artifactSha256,
      hostMappingArtifactSha256: hostMapping.artifactSha256,
      approvedMappingsCount: approvedHostMappings.length,
    });
    // No writer exists until every strict artifact, signature, safety binding,
    // and report no-clobber precondition above has passed.
    const db = await connectDb(cfg);
    let report: MigrationRunReport;
    try {
      report = operation === "run"
        ? await runLegacyMigrationWithSurreal({
            ...base,
            db,
            archiveRoot: cfg.archiveRoot,
            identity,
            approvedHostMappings,
            authorization,
            approvalTrustAnchor: trustAnchor,
            safetyContext,
          })
        : await retryLegacyMigration({
            ...base,
            backend: new SurrealLegacyMigrationBackend(
              db,
              cfg.archiveRoot,
              identity,
              approvedHostMappings,
            ),
            approvedHostMappings,
            authorization,
            approvalTrustAnchor: trustAnchor,
            safetyContext,
          });
    } finally {
      await db.close();
    }
    assertMigrationProductionOutcome(report, hostMapping);
    logger.info("migration_finished", {
      operation,
      status: report.status,
      migrationId: report.migrationId,
      syncRunId: report.syncRunId,
      matchedCount: report.reconciliation.matched,
      insertedCount: report.reconciliation.inserted,
      quarantinedCount: report.reconciliation.quarantined,
      lostCount: report.reconciliation.lost,
    });
    if (options.json) {
      console.log(JSON.stringify({
        operation,
        reportPath,
        safetyBackup: {
          exportPath: restoreReport.exportPath,
          manifestPath: restoreReport.manifestPath,
          restoreReportPath: artifacts.restoreReportFile.path,
          exportSha256: restoreReport.exportSha256,
          manifestSha256: restoreReport.manifestSha256,
          restoreReportSha256: artifacts.restoreReportFile.sha256,
        },
        report,
      }, null, 2));
    } else {
      console.log(`safety backup: ${path.basename(restoreReport.exportPath)}`);
      console.log(`safety restore report: ${path.basename(artifacts.restoreReportFile.path)}`);
      printMigrationRunReport(operation, report);
    }
  } catch (error) {
    const safe = error instanceof MigrationSafetyGateError
      ? error
      : new MigrationSafetyGateError("preconditions", error);
    logger.error("migration_aborted", { stage: safe.stage, errorCode: safe.stage });
    throw safe;
  } finally {
    if (release) {
      try {
        await release();
      } catch (error) {
        throw new MigrationSafetyGateError("preconditions", error);
      }
    }
  }
}

migration
  .command("plan")
  .description(
    "Preflight migration report по snapshot-копии legacy index.sqlite (§15.2/§15.3); ничего не изменяет",
  )
  .option("--legacy-db <path>", "путь к legacy index.sqlite (источник snapshot'а)", DEFAULT_LEGACY_DB)
  .option("--report <path>", "куда писать JSON-отчёт (default: <archive>/backups/manifests/)")
  .option("--skip-live", "не сверять дубликаты с живым корпусом SurrealDB")
  .option("--json", "вывести отчёт в JSON")
  .action(
    handle(
      async (options: {
        legacyDb: string;
        report?: string;
        skipLive?: boolean;
        json?: boolean;
      }) => {
        const cfg = loadConfig();
        if (!options.legacyDb.trim()) throw new Error("--legacy-db не может быть пустым");
        await withMigrationPlanArchiveSafety(cfg, async () => {
          if (!options.json) console.log(`snapshot legacy SQLite: ${options.legacyDb}`);
          const snapshot = await ensureLegacySnapshot(options.legacyDb, cfg.archiveRoot);
          if (!options.json) {
            console.log(
              `snapshot: ${snapshot.snapshotPath} (${snapshot.sizeBytes} bytes, sha256 ${snapshot.sha256.slice(0, 12)}…${snapshot.reused ? ", переиспользован" : ""})`,
            );
          }
          const identity = await localIdentity();
          // Тяжёлый анализ snapshot'а кэшируется checkpoint'ом (ключ — sha256
          // snapshot'а); live probe дешёвый и всегда выполняется заново.
          const checkpointPath = analysisCheckpointPath(
            migrationInputDir(cfg.archiveRoot),
            snapshot.sha256,
          );
          let analysis = await loadAnalysisCheckpoint(checkpointPath, snapshot.sha256, true);
          if (analysis) {
            if (!options.json) console.log(`анализ: checkpoint переиспользован (${checkpointPath})`);
          } else {
            if (!options.json) {
              console.log("анализ snapshot'а (первый прогон по этому snapshot'у — может занять десятки минут)…");
            }
            analysis = await analyzeLegacySnapshot(snapshot.snapshotPath, identity, {
              snapshotSha256: snapshot.sha256,
            });
            await saveAnalysisCheckpoint(checkpointPath, analysis);
            if (!options.json) console.log(`анализ: checkpoint сохранён (${checkpointPath})`);
          }
          const live = await probeMigrationPlanLiveCorpus(cfg, options.skipLive);
          if (live && !live.available && !options.json) {
            console.log(`внимание: live corpus probe: ${live.note}`);
          }
          const report = await buildPreflightReport({
            snapshotPath: snapshot.snapshotPath,
            snapshotSha256: snapshot.sha256,
            identity,
            live,
            analysis,
          });
          const reportPath =
            options.report ??
            path.join(
              cfg.archiveRoot,
              "backups",
              "manifests",
              `migration-preflight-${backupTimestamp()}.json`,
            );
          await writePrivateJsonAtomic(reportPath, report);
          if (options.json) {
            console.log(JSON.stringify({
              reportPath: path.resolve(reportPath),
              snapshot,
              report,
              authorization: null,
            }, null, 2));
          } else {
            console.log(formatPreflightSummary(report));
            console.log(`отчёт: ${reportPath}`);
            console.log("plan does not create or imply migration authorization or signatures");
          }
          if (!report.reconciliation.ok) process.exitCode = 1;
        });
      },
    ),
  );

addMigrationExecutionOptions(
  migration.command("run").description("Идемпотентный import snapshot в новый архив (§15.4–§15.10)"),
).action(handle(async (options: MigrationExecutionCliOptions) => executeMigration("run", options)));

addMigrationExecutionOptions(
  migration.command("retry").description("Новый durable run; resolved quarantine сохраняет audit trail"),
).action(handle(async (options: MigrationExecutionCliOptions) => executeMigration("retry", options)));

migration
  .command("status")
  .description("Последний persisted migration reconciliation из enhanced status")
  .option("--json", "вывести machine-readable result")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const status = await collectStatus(cfg);
      const reconciliation = status.migrationReconciliation;
      if (options.json) {
        console.log(JSON.stringify({ migrationReconciliation: reconciliation ?? null }, null, 2));
      } else if (!reconciliation) {
        console.log("migration status: durable reconciliation отсутствует");
      } else {
        console.log(
          `migration status: ${reconciliation.status}, ` +
            `total ${reconciliation.legacyTotal}, matched ${reconciliation.matched}, ` +
            `inserted ${reconciliation.inserted}, quarantined ${reconciliation.quarantined}, ` +
            `lost ${reconciliation.lost}, ok ${reconciliation.ok ? "yes" : "no"}`,
        );
        console.log(`migration: ${reconciliation.id}`);
      }
    }),
  );

export { program };

if (import.meta.main) {
  await program.parseAsync(process.argv);
}
