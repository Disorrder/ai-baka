/**
 * Stage 10 legacy history migration orchestrator (docs/plan.md §15).
 *
 * API не привязан к CLI: coordinator передаёт snapshot path и backend.
 * Legacy source открывается только read-only; live DB mutation скрыта за
 * LegacyMigrationBackend и легко заменяется synthetic backend в тестах.
 */

import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import type { ParsedDialogue } from "../domain/canonical-types.ts";
import { collectDialogues } from "../parsers/shared/parser.ts";
import { HARNESS_TOOLS } from "../sync/harness-tools.ts";
import type { LocalIdentity } from "../sync/host-identity.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import { writePrivateFileAtomicNoClobber } from "../backup/safety.ts";
import { chunkRecordId, messageRecordId } from "../sync/canonical-hash.ts";
import { sha256hex } from "../db/transactions.ts";
import type { HarnessSlug } from "../sources/adapters/harnesses.ts";
import {
  dialogueFromNormalized,
  LegacySnapshotReader,
  isLegacySourceDeleted,
  legacyRowPayload,
  numberColumn,
  validateLegacyDialogue,
  type LegacyChunkRow,
  type LegacyMessageRow,
  type LegacyRawBackupRow,
  type LegacySqlRow,
  type LegacyTable,
  type LegacyThreadBundle,
  type LegacyThreadRecordRow,
  type LegacySourceFileRow,
} from "./legacy-reader.ts";
import {
  RowReconciler,
  type MigrationCategory,
  type MigrationRunReport,
} from "./reconciliation.ts";
import {
  SurrealLegacyMigrationBackend,
  LegacyDialogueDedupConflictError,
  LEGACY_MIGRATION_ADAPTER_NAME,
  LEGACY_MIGRATION_ADAPTER_VERSION,
  legacyDialogueIdentityRequests,
  legacyIdentityPrefetchKey,
  prefetchedLegacyIdentity,
  resolveLegacyCanonicalBindings,
  type ApprovedLegacyHostMapping,
  type AuthenticatedPreflightScope,
  type AgentTarget,
  type DialogueTarget,
  type DialogueWriteInput,
  type ExistingDialogueWriteInput,
  type EnsureTarget,
  type LegacyMigrationBackend,
  type LegacyCanonicalBindings,
  type LegacyIdentityPrefetch,
  type MigrationRunHandle,
  type MigrationIdentityCommit,
  type ProjectTarget,
  type RevisionTarget,
  type SourceTarget,
} from "./store.ts";
import {
  analyzeLegacySnapshot,
  type LiveCorpusProbe,
} from "./preflight.ts";
import {
  APPROVAL_ANALYSIS_IDENTITY,
  buildLegacyHostMappingApproval,
  canonicalLiveProbe,
  canonicalMigrationJson,
  canonicalProblems,
  migrationArtifactSha256,
  validateMigrationRunAttestation,
  validateMigrationSafetyEvidence,
  validateMigrationPreflightApproval,
  type MigrationApprovalTrustAnchor,
  type MigrationRunAuthorization,
  type MigrationSafetyRuntimeContext,
  type ValidatedMigrationSafetyEvidence,
} from "./authorization.ts";

export const LEGACY_NORMALIZED_PARSER_NAME = "legacy-normalized";
export const LEGACY_NORMALIZED_PARSER_VERSION = 1;
export const LEGACY_THREAD_SPEED_SAMPLE_SIZE = 100;
export const LEGACY_THREAD_SPEED_MAX_ELAPSED_MS = 10 * 60 * 1000;

export interface LegacyThreadSpeedCheckpoint {
  processedThreads: 100;
  elapsedMs: number;
  maxElapsedMs: number;
  withinLimit: boolean;
}

export function legacyThreadSpeedCheckpoint(elapsedMs: number): LegacyThreadSpeedCheckpoint {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("legacy thread speed checkpoint elapsed time is invalid");
  }
  return {
    processedThreads: LEGACY_THREAD_SPEED_SAMPLE_SIZE,
    elapsedMs,
    maxElapsedMs: LEGACY_THREAD_SPEED_MAX_ELAPSED_MS,
    withinLimit: elapsedMs <= LEGACY_THREAD_SPEED_MAX_ELAPSED_MS,
  };
}

export interface SnapshotRecoveryInput {
  path: string;
  threadExternalId: string;
  harness: HarnessSlug;
  source: "raw" | "payload";
}

/** Test seam для проверки recovery priority без реальных parser fixtures. */
export type SnapshotRecoverer = (
  input: SnapshotRecoveryInput,
) => Promise<ParsedDialogue | undefined>;

export async function recoverDialogueWithParser(
  input: SnapshotRecoveryInput,
): Promise<ParsedDialogue | undefined> {
  const tools = HARNESS_TOOLS[input.harness];
  let snapshot;
  try {
    snapshot = await tools.parser.parse(input.path);
  } catch {
    return undefined;
  }
  if (snapshot.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return undefined;
  }
  const dialogues = await collectDialogues(snapshot);
  const exact = dialogues.find((dialogue) => dialogue.externalId === input.threadExternalId);
  const selected = exact ?? (dialogues.length === 1 ? dialogues[0] : undefined);
  if (!selected || validateLegacyDialogue(selected).length > 0) return undefined;
  return selected;
}

export interface RunLegacyMigrationOptions {
  snapshotPath: string;
  /** Expected metadata from ensureLegacySnapshot; runner verifies both. */
  snapshotSha256: string;
  snapshotSizeBytes: number;
  bakaCommit: string;
  schemaVersion: number;
  backend: LegacyMigrationBackend;
  recoverSnapshot?: SnapshotRecoverer;
  /** Mandatory runtime gate; optional in the type until CLI wiring lands. */
  authorization?: MigrationRunAuthorization;
  /** Independently configured Ed25519 trust anchor; never comes from attestation. */
  approvalTrustAnchor?: MigrationApprovalTrustAnchor;
  /** Independent runtime binding for the strict persisted restore report. */
  safetyContext?: MigrationSafetyRuntimeContext;
  /** Exact operator mapping input used to independently rebuild approval. */
  approvedHostMappings?: ApprovedLegacyHostMapping[];
  /** Durable JSON reconciliation report; written atomically when provided. */
  reportPath?: string;
  /** Stable, non-sensitive progress event emitted after the first 100 threads. */
  onThreadSpeedCheckpoint?: (
    checkpoint: LegacyThreadSpeedCheckpoint,
  ) => void | Promise<void>;
  /** Test seam; production uses performance.now(). */
  monotonicNow?: () => number;
}

export interface RunLegacyMigrationWithSurrealOptions
  extends Omit<RunLegacyMigrationOptions, "backend"> {
  db: Surreal;
  archiveRoot: string;
  identity: LocalIdentity;
  approvedHostMappings: ApprovedLegacyHostMapping[];
}

/**
 * Approval drift excludes only records written by a prior legacy migration.
 * Ordinary/live records have created_by_run = NONE and therefore remain in
 * the signed baseline, so external or sync drift still fails authentication.
 */
export async function probeMigrationApprovalBaselineFromDb(
  db: Surreal,
): Promise<LiveCorpusProbe> {
  const [revisions, dialogues] = await Promise.all([
    db.query<[Array<{ sha256: string }>]>(
      "SELECT sha256 FROM source_revision WHERE created_by_run IS NONE",
    ).then(([rows]) => rows ?? []),
    db.query<[Array<{ external_id: string; harness: string | null }>]>(
      `SELECT external_id, harness_installation.harness.slug AS harness
       FROM dialogue WHERE external_id IS NOT NONE AND created_by_run IS NONE`,
    ).then(([rows]) => rows ?? []),
  ]);
  return {
    available: true,
    note: `live corpus: ${revisions.length} source_revision, ${dialogues.length} dialogue с external_id`,
    revisionSha256: new Set(revisions.map((row) => row.sha256)),
    dialogueKeys: new Set(
      dialogues.map((row) => `${row.harness ?? "?"}:${row.external_id}`),
    ),
  };
}

interface SourceState {
  target: SourceTarget;
  revisions: RevisionTarget[];
}

interface RecoveredThread {
  parsed: ParsedDialogue;
  sourceRevision: RevisionTarget;
  source: "raw" | "payload" | "normalized";
  parserName: string;
  parserVersion: number;
  bindings: LegacyCanonicalBindings;
  preferredSource?: SourceTarget;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function authenticatedPreflightScope(
  authorization: MigrationRunAuthorization,
): AuthenticatedPreflightScope {
  const missingRawBackups = new Map<string, string>();
  const sourceFilesWithoutRawBackups = new Map<string, string>();
  for (const problem of authorization.approval.evidence.problems) {
    if (problem.table === "source_files" &&
        problem.reason === "нет записи raw_backups (missing raw backup)") {
      if (sourceFilesWithoutRawBackups.has(problem.recordId)) {
        throw new Error(
          `duplicate authenticated source-without-raw evidence: source_files:${problem.recordId}`,
        );
      }
      sourceFilesWithoutRawBackups.set(problem.recordId, problem.reason);
      continue;
    }
    if (problem.table !== "raw_backups" ||
        !problem.reason.startsWith("raw backup файл отсутствует на диске: ")) {
      continue;
    }
    const prior = missingRawBackups.get(problem.recordId);
    if (prior && prior !== problem.reason) {
      throw new Error(`conflicting authenticated missing-raw evidence: raw_backups:${problem.recordId}`);
    }
    missingRawBackups.set(problem.recordId, problem.reason);
  }
  return {
    snapshotSha256: authorization.approval.evidence.snapshotSha256,
    missingRawBackups,
    sourceFilesWithoutRawBackups,
  };
}

async function assertReportDoesNotExist(reportPath: string | undefined): Promise<void> {
  if (!reportPath) throw new Error("migration reportPath обязателен");
  try {
    await lstat(reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`migration report already exists (no-clobber): ${reportPath}`);
}

async function validateRunAuthorization(
  options: RunLegacyMigrationOptions,
  verified: VerifiedSnapshot,
): Promise<{
  authorization: MigrationRunAuthorization;
  safety: ValidatedMigrationSafetyEvidence;
  attestation: { attestationSha256: string; keyFingerprint: string; issuedAt: string };
}> {
  const authorization = options.authorization;
  if (!authorization) throw new Error("operator-approved migration authorization artifact обязателен");
  if (!options.approvalTrustAnchor) {
    throw new Error("independently configured migration approval trust anchor обязателен");
  }
  if (!options.safetyContext) {
    throw new Error("migration restore safety runtime context обязателен");
  }
  if (options.safetyContext.schemaVersion !== options.schemaVersion) {
    throw new Error("restore safety schemaVersion does not match migration runner schemaVersion");
  }
  validateMigrationPreflightApproval(authorization.approval);
  const attestation = await validateMigrationRunAttestation(
    authorization,
    options.approvalTrustAnchor,
  );
  const evidence = authorization.approval.evidence;
  if (evidence.snapshotSha256 !== verified.sha256 || evidence.snapshotSizeBytes !== verified.sizeBytes) {
    throw new Error("migration approval не привязан к выбранному snapshot SHA/size");
  }
  const approvedAt = Date.parse(authorization.approval.approvedAt);
  const attestedAt = Date.parse(attestation.issuedAt);
  const safety = await validateMigrationSafetyEvidence(
    authorization.safety,
    options.safetyContext,
  );
  const backupAt = Date.parse(authorization.safety.backup.createdAt);
  const restoreAt = Date.parse(safety.restoreStartedAt);
  const now = Date.now();
  if (![approvedAt, attestedAt, backupAt, restoreAt].every(Number.isFinite) ||
      attestedAt < approvedAt || backupAt < attestedAt || restoreAt < backupAt ||
      restoreAt > now + 5 * 60_000 ||
      now - restoreAt > 24 * 60 * 60_000) {
    throw new Error("attestation/backup/restore evidence не является свежим и упорядоченным");
  }
  const mappings = options.approvedHostMappings ?? authorization.hostMapping.mappings;
  const rebuiltMapping = buildLegacyHostMappingApproval(
    options.snapshotPath,
    verified.sha256,
    mappings,
  );
  if (rebuiltMapping.artifactSha256 !== authorization.hostMapping.artifactSha256 ||
      rebuiltMapping.artifactSha256 !== evidence.hostMappingArtifactSha256 ||
      canonicalMigrationJson(rebuiltMapping) !== canonicalMigrationJson(authorization.hostMapping)) {
    throw new Error("host mapping approval stale, conflicting, or truncated");
  }

  const analysis = await analyzeLegacySnapshot(
    options.snapshotPath,
    APPROVAL_ANALYSIS_IDENTITY,
    { snapshotSha256: verified.sha256, checkRawFiles: evidence.checkRawFiles },
  );
  if (!analysis.reconciliation.ok || analysis.reconciliation.lost !== 0) {
    throw new Error("fresh preflight reconciliation has lost legacy rows");
  }
  for (const [table, total] of Object.entries(evidence.tableTotals)) {
    if (analysis.reconciliation.tables[table]?.total !== total) {
      throw new Error(`preflight table total mismatch: ${table}`);
    }
  }
  if (analysis.deletedInSource !== evidence.expectedDeletedCount) {
    throw new Error("preflight expected deleted count mismatch");
  }
  if (migrationArtifactSha256(canonicalProblems(analysis.problems)) !==
      migrationArtifactSha256(canonicalProblems(evidence.problems))) {
    throw new Error("preflight problem set stale or truncated");
  }
  if (canonicalMigrationJson(canonicalLiveProbe(authorization.currentLiveProbe)) !==
      canonicalMigrationJson(evidence.liveProbe)) {
    throw new Error("live-probe evidence stale or does not match approval");
  }
  await assertReportDoesNotExist(options.reportPath);
  return { authorization, safety, attestation };
}

interface VerifiedSnapshot {
  sha256: string;
  sizeBytes: number;
}

/**
 * Caller metadata is only an expectation. The runner independently hashes
 * the immutable content-addressed SQLite snapshot before opening it.
 */
export async function verifyMigrationSnapshot(
  snapshotPath: string,
  expectedSha256: string,
  expectedSizeBytes: number,
): Promise<VerifiedSnapshot> {
  const before = await lstat(snapshotPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`legacy snapshot не является regular non-symlink file: ${snapshotPath}`);
  }
  const hashes = await hashFile(snapshotPath);
  const after = await lstat(snapshotPath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`legacy snapshot изменился во время независимой hash verification`);
  }
  const expectedName = `index__${hashes.sha256}.sqlite`;
  if (path.basename(snapshotPath) !== expectedName) {
    throw new Error(
      `legacy snapshot не content-addressed: expected filename ${expectedName}`,
    );
  }
  if (hashes.sha256 !== expectedSha256) {
    throw new Error(
      `legacy snapshot SHA mismatch: expected ${expectedSha256}, got ${hashes.sha256}`,
    );
  }
  if (hashes.sizeBytes !== expectedSizeBytes || after.size !== expectedSizeBytes) {
    throw new Error(
      `legacy snapshot size mismatch: expected ${expectedSizeBytes}, got ${hashes.sizeBytes}`,
    );
  }
  return { sha256: hashes.sha256, sizeBytes: hashes.sizeBytes };
}

/** Атомарный durable JSON report рядом с backup manifests. */
export async function writeMigrationRunReport(
  reportPath: string,
  report: MigrationRunReport,
): Promise<{ sha256: string; sizeBytes: number }> {
  const resolved = path.resolve(reportPath);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const bytes = Buffer.from(content, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writePrivateFileAtomicNoClobber(resolved, content);
  return { sha256: digest, sizeBytes: bytes.byteLength };
}

function isValidPayload(row: LegacyThreadRecordRow): boolean {
  if (typeof row.payload !== "string" || row.payload.length === 0) return false;
  try {
    JSON.parse(row.payload);
    return true;
  } catch {
    return false;
  }
}

function recordIdPart(id: RecordId): string {
  return typeof id.id === "string" ? id.id : String(id.id);
}

function uniqueSourceIds(records: LegacyThreadRecordRow[]): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const row of [...records].sort((a, b) => b.sequence - a.sequence || b.id - a.id)) {
    if (row.source_file_id === null || seen.has(row.source_file_id)) continue;
    seen.add(row.source_file_id);
    ids.push(row.source_file_id);
  }
  return ids;
}

function canonicalImportPolicyForThread(
  bundle: LegacyThreadBundle,
  harness: HarnessSlug,
  liveDialogueKeys: ReadonlySet<string>,
  sourceById: ReadonlyMap<number, LegacySourceFileRow>,
): DialogueWriteInput["canonicalImportPolicy"] | undefined {
  const liveKey = `${harness}:${bundle.thread.external_id}`;
  if (liveDialogueKeys.has(liveKey)) return "match_existing";
  if (bundle.records.length > 0 && bundle.records.every((record) => {
    if (record.source_file_id === null) return false;
    const source = sourceById.get(record.source_file_id);
    return source !== undefined && isLegacySourceDeleted(source);
  })) {
    return "import_deleted";
  }
  return undefined;
}

async function prefetchDialogueIdentities(
  backend: LegacyMigrationBackend,
  bundle: LegacyThreadBundle,
  run: MigrationRunHandle,
): Promise<LegacyIdentityPrefetch> {
  const requests = legacyDialogueIdentityRequests(bundle);
  if (backend.prefetchIdentities) return backend.prefetchIdentities(requests, run);

  // Compatibility path for synthetic/custom backends. It remains bounded by
  // the four child tables and still removes every per-row lookup.
  const byTable = new Map<LegacyTable, string[]>();
  for (const request of requests) {
    const ids = byTable.get(request.table) ?? [];
    ids.push(request.legacyId);
    byTable.set(request.table, ids);
  }
  const groups = await Promise.all(
    [...byTable].map(async ([table, legacyIds]) => ({
      table,
      rows: await backend.lookupIdentities(table, legacyIds),
    })),
  );
  const requestedKeys = new Set(
    requests.map((request) => legacyIdentityPrefetchKey(request.table, request.legacyId)),
  );
  const existing = new Map<string, { target: RecordId }>();
  for (const { table, rows } of groups) {
    for (const [legacyId, target] of rows) {
      const key = legacyIdentityPrefetchKey(table, legacyId);
      if (!requestedKeys.has(key) || existing.has(key) || !(target instanceof RecordId)) {
        throw new Error(`legacy identity compatibility prefetch returned malformed rows`);
      }
      existing.set(key, { target });
    }
  }
  return { requestedKeys, existing, unresolvedQuarantines: new Map() };
}

async function commitRowIdentity(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  table: LegacyTable,
  legacyId: string,
  target: RecordId,
  category: MigrationCategory,
  prefetched?: LegacyIdentityPrefetch,
): Promise<void> {
  if (backend.commitIdentity) {
    await backend.commitIdentity(run, table, legacyId, target, category, prefetched);
    return;
  }
  await backend.bindIdentity(table, legacyId, target);
  await backend.completeIdentity(table, legacyId, target, run, category);
}

async function classifyImport<T>(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  table: LegacyTable,
  row: LegacySqlRow,
  operation: (mapped: RecordId | undefined) => Promise<EnsureTarget<T>>,
  parser?: { name: string; version: number },
): Promise<EnsureTarget<T> | undefined> {
  const legacyId = String(row.id);
  const prefetched = backend.prefetchIdentities
    ? await backend.prefetchIdentities([{ table, legacyId }], run)
    : undefined;
  const mapped = prefetched
    ? prefetchedLegacyIdentity(prefetched, table, legacyId)?.target
    : await backend.lookupIdentity(table, legacyId);
  let result: EnsureTarget<T> | undefined;
  try {
    result = await operation(mapped);
    const category: MigrationCategory = mapped || !result.created ? "matched" : "inserted";
    await commitRowIdentity(backend, run, table, legacyId, result.target, category, prefetched);
    reconciler.classify(table, legacyId, category);
    return result;
  } catch (error) {
    if (result) await backend.rollbackImportAttempt?.(table, result);
    await backend.quarantine(run, {
      table,
      row,
      rawPayload: legacyRowPayload(row),
      reason: errorMessage(error),
      parserName: parser?.name ?? LEGACY_MIGRATION_ADAPTER_NAME,
      parserVersion: parser?.version ?? LEGACY_MIGRATION_ADAPTER_VERSION,
      retryable: true,
    });
    reconciler.classify(table, legacyId, "quarantined");
    return undefined;
  }
}

async function quarantineRow(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  table: LegacyTable,
  row: LegacySqlRow,
  reason: string,
  parser?: { name: string; version: number },
  hostAssignmentConsumed = false,
): Promise<void> {
  await backend.quarantine(run, {
    table,
    row,
    rawPayload: legacyRowPayload(row),
    reason,
    parserName: parser?.name ?? LEGACY_MIGRATION_ADAPTER_NAME,
    parserVersion: parser?.version ?? LEGACY_MIGRATION_ADAPTER_VERSION,
    retryable: true,
    hostAssignmentConsumed,
  });
  reconciler.classify(table, row.id, "quarantined");
}

async function bindProducedRow(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  table: LegacyTable,
  row: LegacySqlRow,
  target: RecordId,
  created: boolean,
  parser?: { name: string; version: number },
): Promise<void> {
  const mapped = await backend.lookupIdentity(table, String(row.id));
  try {
    const category: MigrationCategory = mapped || !created ? "matched" : "inserted";
    await commitRowIdentity(backend, run, table, String(row.id), target, category);
    reconciler.classify(table, row.id, category);
  } catch (error) {
    await quarantineRow(
      backend,
      run,
      reconciler,
      table,
      row,
      `identity mapping failed: ${errorMessage(error)}`,
      parser,
    );
  }
}

async function bindProducedRows(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  table: LegacyTable,
  rows: Array<{ row: LegacySqlRow; target: RecordId; created: boolean }>,
  parser?: { name: string; version: number },
): Promise<void> {
  if (rows.length === 0) return;
  // Каждая mapping/classification коммитится своей транзакцией: конфликт
  // одной legacy row не откатывает уже подтверждённое владение соседней.
  for (const item of rows) {
    await bindProducedRow(
      backend,
      run,
      reconciler,
      table,
      item.row,
      item.target,
      item.created,
      parser,
    );
  }
}

async function quarantineBundleChildren(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  bundle: LegacyThreadBundle,
  reason: string,
  parser?: { name: string; version: number },
): Promise<void> {
  for (const row of bundle.records) {
    await quarantineRow(backend, run, reconciler, "thread_records", row, reason, parser);
  }
  for (const row of bundle.messages) {
    await quarantineRow(backend, run, reconciler, "messages", row, reason, parser);
  }
  for (const row of bundle.chunks) {
    await quarantineRow(backend, run, reconciler, "message_chunks", row, reason, parser);
  }
}

async function quarantineCanonicalBundleChildren(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  bundle: LegacyThreadBundle,
  reason: string,
  parser?: { name: string; version: number },
): Promise<void> {
  for (const row of bundle.messages) {
    await quarantineRow(backend, run, reconciler, "messages", row, reason, parser);
  }
  for (const row of bundle.chunks) {
    await quarantineRow(backend, run, reconciler, "message_chunks", row, reason, parser);
  }
}

async function accountSourceOwnedThreadRecords(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  bundle: LegacyThreadBundle,
  targets: ReadonlyMap<string, RevisionTarget>,
  prefetch: LegacyIdentityPrefetch,
  failureReason: string,
  parser?: { name: string; version: number },
): Promise<void> {
  const commits: MigrationIdentityCommit[] = [];
  const unprovable: LegacyThreadRecordRow[] = [];
  for (const row of bundle.records) {
    const target = targets.get(String(row.id));
    if (row.source_file_id === null || !target) {
      unprovable.push(row);
      continue;
    }
    const mapped = prefetchedLegacyIdentity(prefetch, "thread_records", String(row.id));
    commits.push({
      table: "thread_records",
      legacyId: String(row.id),
      target: target.revisionId,
      category: mapped || !target.created ? "matched" : "inserted",
    });
  }
  try {
    if (backend.commitIdentityBatch) {
      await backend.commitIdentityBatch(run, commits, undefined, prefetch);
    } else {
      for (const commit of commits) {
        await commitRowIdentity(
          backend,
          run,
          commit.table,
          commit.legacyId,
          commit.target,
          commit.category,
        );
      }
    }
    for (const commit of commits) {
      reconciler.classify("thread_records", commit.legacyId, commit.category);
    }
  } catch (error) {
    for (const row of bundle.records.filter((item) =>
      commits.some((commit) => commit.legacyId === String(item.id))
    )) {
      await quarantineRow(
        backend,
        run,
        reconciler,
        "thread_records",
        row,
        `${failureReason}: ${errorMessage(error)}`,
        parser,
      );
    }
  }
  for (const row of unprovable) {
    await quarantineRow(
      backend,
      run,
      reconciler,
      "thread_records",
      row,
      `${failureReason}: no exact source_revision ownership evidence`,
      parser,
    );
  }
}

interface BundleProvenanceViolation {
  table: "thread_records" | "messages" | "message_chunks";
  id: string;
  reason: string;
}

function validateBundleProvenance(
  bundle: LegacyThreadBundle,
  sourceIds: Set<number>,
  projectIds: Set<number>,
  harness?: HarnessSlug,
): { threadReason?: string; rows: BundleProvenanceViolation[] } {
  const rows: BundleProvenanceViolation[] = [];
  const projectId = numberColumn(bundle.thread, "project_id", Number.NaN);
  let threadReason: string | undefined;
  if (Number.isFinite(projectId) && !projectIds.has(projectId)) {
    threadReason = `project_id=${projectId} отсутствует в projects`;
  }
  const recordIds = new Set(bundle.records.map((row) => row.id));
  for (const row of bundle.records) {
    if (row.source_file_id !== null && !sourceIds.has(row.source_file_id)) {
      rows.push({
        table: "thread_records",
        id: String(row.id),
        reason: `source_file_id=${row.source_file_id} отсутствует в source_files`,
      });
    }
  }
  for (const row of bundle.messages) {
    const sourceRecordId = numberColumn(row, "source_record_id", Number.NaN);
    if (harness === "codex" && !Number.isFinite(sourceRecordId)) {
      rows.push({
        table: "messages",
        id: String(row.id),
        reason: "source_record_id отсутствует; невозможно доказать Codex source locator line",
      });
    } else if (Number.isFinite(sourceRecordId) && !recordIds.has(sourceRecordId)) {
      rows.push({
        table: "messages",
        id: String(row.id),
        reason: `source_record_id=${sourceRecordId} не принадлежит thread_records этого thread`,
      });
    }
  }
  const messages = new Map(bundle.messages.map((row) => [row.id, row]));
  for (const row of bundle.chunks) {
    let sourceRecordId = numberColumn(row, "source_record_id", Number.NaN);
    if (harness === "codex" && !Number.isFinite(sourceRecordId)) {
      const parent = messages.get(row.message_id);
      sourceRecordId = parent
        ? numberColumn(parent, "source_record_id", Number.NaN)
        : Number.NaN;
    }
    if (harness === "codex" && !Number.isFinite(sourceRecordId)) {
      rows.push({
        table: "message_chunks",
        id: String(row.id),
        reason: "source_record_id отсутствует; невозможно доказать Codex source locator line",
      });
    } else if (Number.isFinite(sourceRecordId) && !recordIds.has(sourceRecordId)) {
      rows.push({
        table: "message_chunks",
        id: String(row.id),
        reason: `source_record_id=${sourceRecordId} не принадлежит thread_records этого thread`,
      });
    }
  }
  return { ...(threadReason ? { threadReason } : {}), rows };
}

async function quarantineInvalidBundleProvenance(
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  bundle: LegacyThreadBundle,
  validation: ReturnType<typeof validateBundleProvenance>,
): Promise<void> {
  const exact = new Map(validation.rows.map((item) => [`${item.table}:${item.id}`, item.reason]));
  const summary = [validation.threadReason, ...validation.rows.map((item) => `${item.table}:${item.id} ${item.reason}`)]
    .filter(Boolean).join("; ");
  await quarantineRow(
    backend,
    run,
    reconciler,
    "threads",
    bundle.thread,
    `invalid legacy provenance: ${summary}`,
  );
  for (const row of bundle.records) {
    await quarantineRow(
      backend,
      run,
      reconciler,
      "thread_records",
      row,
      exact.get(`thread_records:${row.id}`) ?? `parent threads:${bundle.thread.id} invalid provenance`,
    );
  }
  for (const row of bundle.messages) {
    await quarantineRow(
      backend,
      run,
      reconciler,
      "messages",
      row,
      exact.get(`messages:${row.id}`) ?? `parent threads:${bundle.thread.id} invalid provenance`,
    );
  }
  for (const row of bundle.chunks) {
    await quarantineRow(
      backend,
      run,
      reconciler,
      "message_chunks",
      row,
      exact.get(`message_chunks:${row.id}`) ?? `parent threads:${bundle.thread.id} invalid provenance`,
    );
  }
}

async function recoverThread(
  bundle: LegacyThreadBundle,
  agent: AgentTarget,
  sourceStates: Map<number, SourceState>,
  backend: LegacyMigrationBackend,
  run: MigrationRunHandle,
  recoverSnapshot: SnapshotRecoverer,
  beforeReplay: (sourceSha256: string, preferredSource?: SourceTarget) => Promise<void>,
  onReplayCreated: (revision: RevisionTarget) => void,
): Promise<RecoveredThread> {
  const sourceIds = uniqueSourceIds(bundle.records);
  const preferredSource = sourceIds.map((id) => sourceStates.get(id)?.target).find(Boolean);
  const rawRecoveryAllowed = bundle.records.every((row) => row.source_file_id !== null);
  const bindCandidate = (
    parsed: ParsedDialogue,
    source: "raw" | "payload" | "normalized",
    sourceRevision: RevisionTarget,
    candidatePreferredSource: SourceTarget | undefined,
    parserName: string,
    parserVersion: number,
  ): RecoveredThread => ({
    parsed,
    sourceRevision,
    source,
    parserName,
    parserVersion,
    bindings: resolveLegacyCanonicalBindings(bundle, parsed, agent.slug, source),
    preferredSource: candidatePreferredSource,
  });

  // Любая null link делает raw-набор неполным для всего thread (M1):
  // нельзя частично восстановить диалог из связанного файла.
  if (rawRecoveryAllowed) {
    // §15.4 priority 1: каждый доступный immutable raw пробуется до payload.
    for (const sourceId of sourceIds) {
      const state = sourceStates.get(sourceId);
      if (!state) continue;
      for (const revision of [...state.revisions].reverse()) {
        if (!revision.rawPath) continue;
        const parsed = await recoverSnapshot({
          path: revision.rawPath,
          threadExternalId: bundle.thread.external_id,
          harness: agent.slug,
          source: "raw",
        });
        if (parsed) {
          try {
            return bindCandidate(
              parsed,
              "raw",
              revision,
              state.target,
              HARNESS_TOOLS[agent.slug].parser.parserName,
              HARNESS_TOOLS[agent.slug].parser.parserVersion,
            );
          } catch {
            // A parse result without exact legacy child ownership is not a
            // usable recovery. Continue to the next immutable revision.
          }
        }
      }
    }
  }

  const payloadContent = bundle.records.length > 0
    ? `${bundle.records.map((row) => row.payload).join("\n")}\n`
    : "";
  let replayRevision: RevisionTarget | undefined;
  if (bundle.records.length > 0) {
    await beforeReplay(sha256hex(payloadContent), preferredSource);
    // Raw payload сохраняется immutable даже если JSON битый и recovery
    // в итоге пойдёт через normalized rows.
    replayRevision = await backend.createReplayRevision(
      run,
      bundle.thread,
      bundle.records,
      agent,
      preferredSource,
      payloadContent,
    );
    onReplayCreated(replayRevision);
  }

  // §15.4 priority 2: parser получает replay только при полном valid JSON.
  if (replayRevision?.rawPath && bundle.records.every(isValidPayload)) {
    const parsed = await recoverSnapshot({
      path: replayRevision.rawPath,
      threadExternalId: bundle.thread.external_id,
      harness: agent.slug,
      source: "payload",
    });
    if (parsed) {
      try {
        return bindCandidate(
          parsed,
          "payload",
          replayRevision,
          preferredSource,
          HARNESS_TOOLS[agent.slug].parser.parserName,
          HARNESS_TOOLS[agent.slug].parser.parserVersion,
        );
      } catch {
        // Sequence drift or semantic mismatch falls through to the
        // independently verified normalized projection.
      }
    }
  }

  // §15.4 priority 3: legacy normalized message/chunk structure.
  const parsed = dialogueFromNormalized(bundle);
  const validation = validateLegacyDialogue(parsed);
  if (validation.length > 0) {
    throw new Error(`normalized recovery invalid: ${validation.join("; ")}`);
  }
  if (!replayRevision) {
    const normalizedContent = `${JSON.stringify(parsed)}\n`;
    await beforeReplay(sha256hex(normalizedContent), preferredSource);
    replayRevision = await backend.createReplayRevision(
      run,
      bundle.thread,
      bundle.records,
      agent,
      preferredSource,
      normalizedContent,
    );
    onReplayCreated(replayRevision);
  }
  return bindCandidate(
    parsed,
    "normalized",
    replayRevision,
    preferredSource,
    LEGACY_NORMALIZED_PARSER_NAME,
    LEGACY_NORMALIZED_PARSER_VERSION,
  );
}

function childMessageTarget(
  dialogue: DialogueTarget,
  canonicalSequence: number,
): RecordId {
  return new RecordId(
    "message",
    messageRecordId(recordIdPart(dialogue.revisionId), canonicalSequence),
  );
}

function childChunkTarget(
  dialogue: DialogueTarget,
  canonicalMessageSequence: number,
  canonicalChunkSequence: number,
): RecordId {
  return new RecordId(
    "chunk",
    chunkRecordId(
      recordIdPart(dialogue.revisionId),
      canonicalMessageSequence,
      canonicalChunkSequence,
    ),
  );
}

interface PreparedDialogueChildCommit {
  commit: MigrationIdentityCommit;
  row: LegacySqlRow;
}

async function prepareDialogueChildren(
  run: MigrationRunHandle,
  reconciler: RowReconciler,
  bundle: LegacyThreadBundle,
  recovered: RecoveredThread,
  dialogue: DialogueTarget,
  identityPrefetch: LegacyIdentityPrefetch,
  threadRecordTargets: ReadonlyMap<string, RevisionTarget>,
): Promise<PreparedDialogueChildCommit[]> {
  const parser = { name: recovered.parserName, version: recovered.parserVersion };
  const prepared: PreparedDialogueChildCommit[] = [];
  const add = async (
    table: LegacyTable,
    rows: Array<{ row: LegacySqlRow; target: RecordId; created: boolean }>,
  ): Promise<void> => {
    for (const item of rows) {
      const mapped = prefetchedLegacyIdentity(
        identityPrefetch,
        table,
        String(item.row.id),
      );
      prepared.push({
        row: item.row,
        commit: {
          table,
          legacyId: String(item.row.id),
          target: item.target,
          category: mapped || !item.created ? "matched" : "inserted",
        },
      });
    }
  };
  const recordBindings = bundle.records.map((row) => {
    if (row.source_file_id === null) {
      return {
        row,
        target: dialogue.revisionId,
        created: dialogue.createdRevision,
      };
    }
    const exactSourceTarget = threadRecordTargets.get(String(row.id));
    if (!exactSourceTarget) {
      throw new Error(
        `thread_records:${row.id} has no exact source_revision ownership evidence`,
      );
    }
    return {
      row,
      target: exactSourceTarget.revisionId,
      created: exactSourceTarget.created,
    };
  });
  await add("thread_records", recordBindings);

  const legacyMessages = new Map(bundle.messages.map((message) => [String(message.id), message]));
  const messageBindings: Array<{ row: LegacyMessageRow; target: RecordId; created: boolean }> = [];
  for (const binding of recovered.bindings.messages) {
    const row = legacyMessages.get(binding.legacyId);
    if (!row) throw new Error(`legacy message row missing for binding ${binding.legacyId}`);
    messageBindings.push({
      row,
      target: childMessageTarget(dialogue, binding.canonicalSequence),
      created: dialogue.createdRevision,
    });
  }
  await add("messages", messageBindings);
  const legacyChunks = new Map(bundle.chunks.map((chunk) => [String(chunk.id), chunk]));
  const chunkBindings: Array<{ row: LegacyChunkRow; target: RecordId; created: boolean }> = [];
  for (const binding of recovered.bindings.chunks) {
    const row = legacyChunks.get(binding.legacyId);
    if (!row) throw new Error(`legacy chunk row missing for binding ${binding.legacyId}`);
    chunkBindings.push({
      row,
      target: childChunkTarget(
        dialogue,
        binding.canonicalMessageSequence,
        binding.canonicalChunkSequence,
      ),
      created: dialogue.createdRevision,
    });
  }
  await add("message_chunks", chunkBindings);
  return prepared;
}

export async function runLegacyMigration(
  options: RunLegacyMigrationOptions,
): Promise<MigrationRunReport> {
  options.reportPath ??= path.join(
    path.dirname(options.snapshotPath),
    `migration-run-${crypto.randomUUID()}.json`,
  );
  const verifiedSnapshot = await verifyMigrationSnapshot(
    options.snapshotPath,
    options.snapshotSha256,
    options.snapshotSizeBytes,
  );
  // Every approval/snapshot/live/backup/report-path check happens before the
  // backend can create a run or execute any canonical writer action.
  const validatedAuthorization = await validateRunAuthorization(options, verifiedSnapshot);
  const { authorization, safety: validatedSafety, attestation } = validatedAuthorization;
  await options.backend.configureHostMappingApproval?.(authorization.hostMapping);
  await options.backend.configureAuthenticatedPreflightScope?.(
    authenticatedPreflightScope(authorization),
  );
  const reader = new LegacySnapshotReader(options.snapshotPath);
  const reconciler = new RowReconciler(reader.totals);
  const recovery = { raw: 0, payload: 0, normalized: 0 };
  const recoverSnapshot = options.recoverSnapshot ?? recoverDialogueWithParser;
  let run: MigrationRunHandle | undefined;
  let published: { path: string; sha256: string; sizeBytes: number } | undefined;
  try {
    run = await options.backend.startRun({
      legacyDbPath: options.snapshotPath,
      legacyDbSha256: verifiedSnapshot.sha256,
      bakaCommit: options.bakaCommit,
      schemaVersion: options.schemaVersion,
      approvalArtifactSha256: authorization.approval.artifactSha256,
      approvalFileSha256: authorization.approvalFile!.sha256,
      approvalAttestationSha256: attestation.attestationSha256,
      approvalKeyFingerprint: attestation.keyFingerprint,
      hostMappingArtifactSha256: authorization.hostMapping.artifactSha256,
      hostMappingAssignmentsJson: canonicalMigrationJson(authorization.hostMapping.assignments),
      backupArtifactPath: authorization.safety.backup.path,
      backupArtifactSha256: authorization.safety.backup.sha256,
      restoreArtifactPath: authorization.safety.restore.path,
      restoreArtifactSha256: authorization.safety.restore.sha256,
      backupManifestPath: validatedSafety.manifestPath,
      backupManifestSha256: validatedSafety.manifestSha256,
      rawManifestSha256: validatedSafety.rawManifestSha256,
      restoreNamespace: validatedSafety.restoreNamespace,
      reportPath: options.reportPath!,
    });

    const agents = new Map<number, AgentTarget>();
    for (const row of reader.agents()) {
      const result = await classifyImport(
        options.backend,
        run,
        reconciler,
        "agent_systems",
        row,
        (mapped) => options.backend.ensureAgent(row, mapped),
      );
      if (result) agents.set(row.id, result.value);
    }

    const projects = new Map<number, ProjectTarget>();
    for (const row of reader.projects()) {
      const agent = agents.get(row.agent_id);
      if (!agent) {
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "projects",
          row,
          `agent_systems:${row.agent_id} не импортирован`,
        );
        continue;
      }
      let result: EnsureTarget<ProjectTarget> | undefined;
      if (options.backend.commitProjectRow) {
        try {
          const legacyId = String(row.id);
          const prefetched = options.backend.prefetchIdentities
            ? await options.backend.prefetchIdentities([{ table: "projects", legacyId }], run)
            : undefined;
          const mapped = prefetched
            ? prefetchedLegacyIdentity(prefetched, "projects", legacyId)?.target
            : await options.backend.lookupIdentity("projects", legacyId);
          const committed = await options.backend.commitProjectRow(
            run,
            row,
            agent,
            mapped,
            prefetched,
          );
          reconciler.classify("projects", row.id, committed.commit.category);
          result = committed.result;
        } catch (error) {
          await quarantineRow(
            options.backend,
            run,
            reconciler,
            "projects",
            row,
            errorMessage(error),
          );
        }
      } else {
        result = await classifyImport(
          options.backend,
          run,
          reconciler,
          "projects",
          row,
          (mapped) => options.backend.ensureProject(row, agent, mapped),
        );
      }
      if (result) projects.set(row.id, result.value);
    }

    const sourceBundles = reader.sourceBundles();
    const sourceRows = sourceBundles.map((bundle) => bundle.source);
    const sourceIds = new Set(sourceRows.map((row) => row.id));
    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
    const rawRows = reader.rawBackups();
    const sources = new Map<number, SourceState>();
    for (const sourceBundle of sourceBundles) {
      const row = sourceBundle.source;
      const agent = agents.get(row.agent_id);
      const backups = sourceBundle.rawBackups;
      if (!agent) {
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "source_files",
          row,
          `agent_systems:${row.agent_id} не импортирован`,
        );
        for (const backup of backups) {
          await quarantineRow(
            options.backend,
            run,
            reconciler,
            "raw_backups",
            backup,
            `parent source_files:${row.id} не импортирован`,
          );
        }
        continue;
      }

      if (options.backend.commitSourceRows) {
        try {
          const sourceLegacyId = String(row.id);
          const prefetched = options.backend.prefetchIdentities
            ? await options.backend.prefetchIdentities([
                { table: "source_files", legacyId: sourceLegacyId },
                ...backups.map((backup) => ({
                  table: "raw_backups" as const,
                  legacyId: String(backup.id),
                })),
              ], run)
            : undefined;
          const mapped = prefetched
            ? prefetchedLegacyIdentity(prefetched, "source_files", sourceLegacyId)?.target
            : await options.backend.lookupIdentity("source_files", sourceLegacyId);
          const committed = await options.backend.commitSourceRows(
            run,
            row,
            backups,
            agent,
            mapped,
            prefetched,
          );
          for (const commit of committed.commits) {
            reconciler.classify(commit.table, commit.legacyId, commit.category);
          }
          for (const rejected of committed.rejectedBackups) {
            await quarantineRow(
              options.backend,
              run,
              reconciler,
              "raw_backups",
              rejected.row,
              rejected.reason,
            );
          }
          sources.set(row.id, {
            target: committed.source,
            revisions: committed.revisions,
          });
        } catch (error) {
          await quarantineRow(
            options.backend,
            run,
            reconciler,
            "source_files",
            row,
            errorMessage(error),
          );
          for (const backup of backups) {
            await quarantineRow(
              options.backend,
              run,
              reconciler,
              "raw_backups",
              backup,
              `parent source_files:${row.id} atomic commit failed`,
            );
          }
        }
        continue;
      }

      const sourceLegacyId = String(row.id);
      const fallbackPrefetch = options.backend.prefetchIdentities
        ? await options.backend.prefetchIdentities([
            { table: "source_files", legacyId: sourceLegacyId },
            ...backups.map((backup) => ({
              table: "raw_backups" as const,
              legacyId: String(backup.id),
            })),
          ], run)
        : undefined;
      const mapped = fallbackPrefetch
        ? prefetchedLegacyIdentity(fallbackPrefetch, "source_files", sourceLegacyId)?.target
        : await options.backend.lookupIdentity("source_files", sourceLegacyId);
      let ensured: EnsureTarget<SourceTarget>;
      try {
        ensured = await options.backend.ensureSourceFile(row, agent, mapped);
      } catch (error) {
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "source_files",
          row,
          errorMessage(error),
        );
        for (const backup of backups) {
          await quarantineRow(
            options.backend,
            run,
            reconciler,
            "raw_backups",
            backup,
            `parent source_files:${row.id} не импортирован`,
          );
        }
        continue;
      }

      const revisions: RevisionTarget[] = [];
      const importedBackups: Array<{
        row: LegacyRawBackupRow;
        result: EnsureTarget<RevisionTarget>;
        mapped?: RecordId;
      }> = [];
      for (const backup of backups) {
        const rawLegacyId = String(backup.id);
        const rawMapped = fallbackPrefetch
          ? prefetchedLegacyIdentity(fallbackPrefetch, "raw_backups", rawLegacyId)?.target
          : await options.backend.lookupIdentity("raw_backups", rawLegacyId);
        try {
          const result = await options.backend.importRawBackup(
            run,
            backup,
            ensured.value,
            rawMapped,
          );
          revisions.push(result.value);
          importedBackups.push({ row: backup, result, mapped: rawMapped });
        } catch (error) {
          await quarantineRow(
            options.backend,
            run,
            reconciler,
            "raw_backups",
            backup,
            errorMessage(error),
          );
        }
      }
      try {
        const selected = revisions.at(-1) ?? await options.backend.ensureMissingRawRevision(run, ensured.value);
        if (revisions.length === 0) revisions.push(selected);
        await options.backend.finalizeSourceFile(ensured.value, selected);
        const category: MigrationCategory = mapped || !ensured.created ? "matched" : "inserted";
        const sourceCommit: MigrationIdentityCommit = {
          table: "source_files",
          legacyId: String(row.id),
          target: ensured.target,
          category,
        };
        const rawCommits: MigrationIdentityCommit[] = importedBackups.map((item) => ({
          table: "raw_backups",
          legacyId: String(item.row.id),
          target: item.result.target,
          category: item.mapped || !item.result.created ? "matched" : "inserted",
        }));
        if (options.backend.commitIdentityBatch) {
          await options.backend.commitIdentityBatch(
            run,
            [sourceCommit, ...rawCommits],
            undefined,
            fallbackPrefetch,
          );
        } else {
          for (const commit of [sourceCommit, ...rawCommits]) {
            await commitRowIdentity(
              options.backend,
              run,
              commit.table,
              commit.legacyId,
              commit.target,
              commit.category,
              fallbackPrefetch,
            );
          }
        }
        reconciler.classify("source_files", row.id, category);
        for (const [index, item] of importedBackups.entries()) {
          reconciler.classify("raw_backups", item.row.id, rawCommits[index]!.category);
        }
        sources.set(row.id, { target: ensured.value, revisions });
      } catch (error) {
        await options.backend.rollbackSourceAttempt?.(ensured.value, revisions);
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "source_files",
          row,
          `provenance finalize failed: ${errorMessage(error)}`,
        );
        for (const item of importedBackups) {
          await quarantineRow(
            options.backend,
            run,
            reconciler,
            "raw_backups",
            item.row,
            `parent source_files:${row.id} finalize/ownership failed`,
          );
        }
      }
    }

    for (const row of rawRows) {
      if (sourceIds.has(row.source_file_id)) continue;
      await quarantineRow(
        options.backend,
        run,
        reconciler,
        "raw_backups",
        row,
        `orphan: source_files:${row.source_file_id} отсутствует`,
      );
    }

    const projectIds = new Set(reader.projects().map((row) => row.id));
    const monotonicNow = options.monotonicNow ?? (() => performance.now());
    const threadPhaseStartedAt = monotonicNow();
    const threadRows = reader.threads();
    const enforceThreadSpeedCheckpoint = async (): Promise<void> => {
      const checkpoint = legacyThreadSpeedCheckpoint(
        Math.max(0, monotonicNow() - threadPhaseStartedAt),
      );
      await options.onThreadSpeedCheckpoint?.(checkpoint);
      if (!checkpoint.withinLimit) {
        throw new Error(
          `legacy thread speed gate exceeded: ${checkpoint.elapsedMs}ms > ` +
            `${checkpoint.maxElapsedMs}ms after ${checkpoint.processedThreads} threads`,
        );
      }
    };
    for (const [threadIndex, thread] of threadRows.entries()) {
      // Reaching index 100 proves that the preceding 100 bundles each reached
      // a terminal matched/inserted/quarantined outcome. Abort in-process
      // before thread 101 so the normal catch path persists an honest failed
      // report instead of relying on an unsafe external process kill.
      if (threadIndex === LEGACY_THREAD_SPEED_SAMPLE_SIZE) {
        await enforceThreadSpeedCheckpoint();
      }
      const bundle = reader.threadBundle(thread);
      const agent = agents.get(thread.agent_id);
      const provenance = validateBundleProvenance(
        bundle,
        sourceIds,
        projectIds,
        agent?.slug,
      );
      if (provenance.threadReason || provenance.rows.length > 0) {
        await quarantineInvalidBundleProvenance(
          options.backend,
          run,
          reconciler,
          bundle,
          provenance,
        );
        continue;
      }
      if (!agent) {
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "threads",
          thread,
          `agent_systems:${thread.agent_id} не импортирован`,
        );
        await quarantineBundleChildren(
          options.backend,
          run,
          reconciler,
          bundle,
          `parent threads:${thread.id} не импортирован`,
        );
        continue;
      }
      const approvedImportPolicy = canonicalImportPolicyForThread(
        bundle,
        agent.slug,
        authorization.currentLiveProbe.dialogueKeys,
        sourceById,
      );
      const identityPrefetch = await prefetchDialogueIdentities(options.backend, bundle, run);
      const mapped = prefetchedLegacyIdentity(
        identityPrefetch,
        "threads",
        String(thread.id),
      )?.target;
      const preferredSource = uniqueSourceIds(bundle.records)
        .map((id) => sources.get(id)?.target)
        .find((source): source is SourceTarget => source !== undefined);
      const linkedSources = uniqueSourceIds(bundle.records)
        .map((id) => sources.get(id)?.target)
        .filter((source): source is SourceTarget => source !== undefined);
      const threadRecordRevisionTargets = new Map<string, RevisionTarget>();
      for (const record of bundle.records) {
        if (record.source_file_id === null) continue;
        const state = sources.get(record.source_file_id);
        const revision = state?.target.selectedRevision ?? state?.revisions.at(-1);
        if (revision) threadRecordRevisionTargets.set(String(record.id), revision);
      }
      const exactSourceShaCandidates = [...new Set([
        ...uniqueSourceIds(bundle.records).flatMap((id) =>
          sources.get(id)?.revisions.map((revision) => revision.sha256) ?? []
        ),
        ...(bundle.records.length > 0
          ? [sha256hex(`${bundle.records.map((row) => row.payload).join("\n")}\n`)]
          : []),
      ])];
      let exactIdentity: Awaited<ReturnType<LegacyMigrationBackend["threadIdentityContext"]>>;
      let exactDialogueId: RecordId | undefined;
      let threadHostAssignmentConsumed = false;
      try {
        const identityContexts = linkedSources.length > 0
          ? await Promise.all(linkedSources.map((source) =>
              options.backend.threadIdentityContext(agent, source, thread)
            ))
          : [await options.backend.threadIdentityContext(agent, undefined, thread)];
        exactIdentity = identityContexts[0]!;
        if (identityContexts.some((identity) =>
          String(identity.installationId) !== String(exactIdentity.installationId) ||
          String(identity.hostId) !== String(exactIdentity.hostId) ||
          String(identity.osAccountId) !== String(exactIdentity.osAccountId)
        )) {
          throw new Error(`multi-source thread identity mismatch: threads:${thread.id}`);
        }
        threadHostAssignmentConsumed = true;
        exactDialogueId = await options.backend.preflightDialogueDedup({
          thread,
          installationId: exactIdentity.installationId,
          sourceSha256Candidates: exactSourceShaCandidates,
          authoritativeDialogueId: mapped,
        });
      } catch (error) {
        const parser = {
          name: LEGACY_MIGRATION_ADAPTER_NAME,
          version: LEGACY_MIGRATION_ADAPTER_VERSION,
        };
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "threads",
          thread,
          `exact dialogue identity failed: ${errorMessage(error)}`,
          parser,
          threadHostAssignmentConsumed,
        );
        await accountSourceOwnedThreadRecords(
          options.backend,
          run,
          reconciler,
          bundle,
          threadRecordRevisionTargets,
          identityPrefetch,
          `parent threads:${thread.id} exact dialogue identity failed`,
          parser,
        );
        await quarantineCanonicalBundleChildren(
          options.backend,
          run,
          reconciler,
          bundle,
          `parent threads:${thread.id} exact dialogue identity failed`,
          parser,
        );
        continue;
      }
      if (exactDialogueId && options.backend.commitExistingDialogueRow) {
        try {
          const threadRecordTargets = new Map<string, RecordId>();
          for (const [legacyId, revision] of threadRecordRevisionTargets) {
            threadRecordTargets.set(legacyId, revision.revisionId);
          }
          const existingInput: ExistingDialogueWriteInput = {
            thread,
            agent,
            installationId: exactIdentity.installationId,
            dialogueId: exactDialogueId,
            sourceSha256Candidates: exactSourceShaCandidates,
            authoritativeDialogueId: mapped,
            legacyIdentityPrefetch: identityPrefetch,
            threadRecordTargets,
          };
          const committed = await options.backend.commitExistingDialogueRow(
            run,
            existingInput,
            bundle,
          );
          for (const commit of committed.commits) {
            reconciler.classify(commit.table, commit.legacyId, commit.category);
          }
          continue;
        } catch (error) {
          const parser = {
            name: LEGACY_MIGRATION_ADAPTER_NAME,
            version: LEGACY_MIGRATION_ADAPTER_VERSION,
          };
          await quarantineRow(
            options.backend,
            run,
            reconciler,
            "threads",
            thread,
            `existing dialogue ownership failed: ${errorMessage(error)}`,
            parser,
            true,
          );
          await accountSourceOwnedThreadRecords(
            options.backend,
            run,
            reconciler,
            bundle,
            threadRecordRevisionTargets,
            identityPrefetch,
            `parent threads:${thread.id} existing dialogue ownership failed`,
            parser,
          );
          await quarantineCanonicalBundleChildren(
            options.backend,
            run,
            reconciler,
            bundle,
            `parent threads:${thread.id} existing dialogue ownership failed`,
            parser,
          );
          continue;
        }
      }
      const canonicalImportPolicy: DialogueWriteInput["canonicalImportPolicy"] | undefined =
        exactDialogueId
          ? "match_existing"
          : approvedImportPolicy === "import_deleted"
            ? "import_deleted"
            // Compatibility for synthetic backends which cannot provide the
            // ownership-only transaction. The concrete writer never admits a
            // merely probe-listed dialogue without an exact DB identity.
            : !options.backend.commitExistingDialogueRow
              ? approvedImportPolicy
              : undefined;
      if (!canonicalImportPolicy) {
        const parser = {
          name: HARNESS_TOOLS[agent.slug].parser.parserName,
          version: HARNESS_TOOLS[agent.slug].parser.parserVersion,
        };
        const reason =
          `canonical import denied: ${agent.slug}:${thread.external_id} has no exact live ` +
          `dialogue identity and its linked legacy sources are not all deleted_in_source`;
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "threads",
          thread,
          reason,
          parser,
          true,
        );
        await accountSourceOwnedThreadRecords(
          options.backend,
          run,
          reconciler,
          bundle,
          threadRecordRevisionTargets,
          identityPrefetch,
          `parent threads:${thread.id} canonical import denied`,
          parser,
        );
        await quarantineCanonicalBundleChildren(
          options.backend,
          run,
          reconciler,
          bundle,
          `parent threads:${thread.id} canonical import denied`,
          parser,
        );
        continue;
      }
      let preflightIdentity = exactIdentity;
      let provisionalReplay: RevisionTarget | undefined;
      let recovered: RecoveredThread;
      try {
        recovered = await recoverThread(
          bundle,
          agent,
          sources,
          options.backend,
          run,
          recoverSnapshot,
          async (sourceSha256, preferredSource) => {
            preflightIdentity = await options.backend.threadIdentityContext(
              agent,
              preferredSource,
              thread,
            );
            await options.backend.preflightDialogueDedup({
              thread,
              installationId: preflightIdentity.installationId,
              sourceSha256,
              authoritativeDialogueId: mapped,
            });
          },
          (revision) => {
            provisionalReplay = revision;
          },
        );
      } catch (error) {
        if (provisionalReplay && !provisionalReplay.provisionalReplay) {
          try {
            await options.backend.rollbackDialogueAttempt(
              thread,
              undefined,
              provisionalReplay,
              false,
            );
          } catch (rollbackError) {
            throw new Error(
              `recovery provenance cleanup failed for threads:${thread.id}: ${errorMessage(rollbackError)}; original: ${errorMessage(error)}`,
            );
          }
        }
        const parser = error instanceof LegacyDialogueDedupConflictError
          ? { parserName: LEGACY_MIGRATION_ADAPTER_NAME, parserVersion: LEGACY_MIGRATION_ADAPTER_VERSION }
          : HARNESS_TOOLS[agent.slug].parser;
        const quarantineParser = { name: parser.parserName, version: parser.parserVersion };
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "threads",
          thread,
          `recovery failed: ${errorMessage(error)}`,
          quarantineParser,
          true,
        );
        await accountSourceOwnedThreadRecords(
          options.backend,
          run,
          reconciler,
          bundle,
          threadRecordRevisionTargets,
          identityPrefetch,
          `parent threads:${thread.id} recovery failed`,
          quarantineParser,
        );
        await quarantineCanonicalBundleChildren(
          options.backend,
          run,
          reconciler,
          bundle,
          `parent threads:${thread.id} recovery failed`,
          quarantineParser,
        );
        continue;
      }

      let dialogue: DialogueTarget | undefined;
      let atomicDialogueAttempt = false;
      try {
        const identity = preflightIdentity ?? await options.backend.threadIdentityContext(
          agent,
          recovered.preferredSource,
          thread,
        );
        await options.backend.preflightDialogueDedup({
          thread,
          installationId: identity.installationId,
          sourceSha256: recovered.sourceRevision.sha256,
          authoritativeDialogueId: mapped,
        });
        if (options.backend.commitDialogueRow) {
          atomicDialogueAttempt = true;
          const committed = await options.backend.commitDialogueRow(
            run,
            {
              thread,
              agent,
              installationId: identity.installationId,
              hostId: identity.hostId,
              osAccountId: identity.osAccountId,
              sourceRevision: recovered.sourceRevision,
              project: projects.get(numberColumn(thread, "project_id", -1)),
              parsed: recovered.parsed,
              parserName: recovered.parserName,
              parserVersion: recovered.parserVersion,
              legacyBindings: recovered.bindings,
              legacyIdentityPrefetch: identityPrefetch,
              canonicalImportPolicy,
              authoritativeDialogueId: mapped,
              threadRecordTargets: threadRecordRevisionTargets,
            },
            bundle,
          );
          dialogue = committed.dialogue;
          for (const commit of committed.commits) {
            reconciler.classify(commit.table, commit.legacyId, commit.category);
          }
          recovery[recovered.source] += 1;
          continue;
        }
        dialogue = await options.backend.writeDialogue({
          thread,
          agent,
          installationId: identity.installationId,
          hostId: identity.hostId,
          osAccountId: identity.osAccountId,
          sourceRevision: recovered.sourceRevision,
          project: projects.get(numberColumn(thread, "project_id", -1)),
          parsed: recovered.parsed,
          parserName: recovered.parserName,
          parserVersion: recovered.parserVersion,
          legacyBindings: recovered.bindings,
          legacyIdentityPrefetch: identityPrefetch,
          canonicalImportPolicy,
          authoritativeDialogueId: mapped,
          threadRecordTargets: threadRecordRevisionTargets,
        });
        const childCommits = await prepareDialogueChildren(
          run,
          reconciler,
          bundle,
          recovered,
          dialogue,
          identityPrefetch,
          threadRecordRevisionTargets,
        );
        const category: MigrationCategory = mapped || !dialogue.createdDialogue ? "matched" : "inserted";
        const commits: MigrationIdentityCommit[] = [{
          table: "threads",
          legacyId: String(thread.id),
          target: dialogue.dialogueId,
          category,
        }, ...childCommits.map((item) => item.commit)];
        if (options.backend.commitIdentityBatch) {
          await options.backend.commitIdentityBatch(
            run,
            commits,
            recovered.sourceRevision,
            identityPrefetch,
          );
        } else {
          // Test/custom backend fallback cannot provide a DB transaction. Mark
          // first so failed parse finalization cannot resolve quarantine rows.
          await options.backend.markRevisionParsed(recovered.sourceRevision);
          for (const commit of commits) {
            await commitRowIdentity(
              options.backend,
              run,
              commit.table,
              commit.legacyId,
              commit.target,
              commit.category,
            );
          }
        }
        reconciler.classify("threads", thread.id, category);
        for (const child of childCommits) {
          reconciler.classify(child.commit.table, child.row.id, child.commit.category);
        }
        recovery[recovered.source] += 1;
      } catch (error) {
        if (!atomicDialogueAttempt) {
          try {
            await options.backend.rollbackDialogueAttempt(
              thread,
              dialogue,
              recovered.sourceRevision,
              mapped === undefined,
            );
          } catch (rollbackError) {
            throw new Error(
              `post-corpus cleanup failed for threads:${thread.id}: ${errorMessage(rollbackError)}; original: ${errorMessage(error)}`,
            );
          }
        }
        const quarantineParser = error instanceof LegacyDialogueDedupConflictError
          ? {
              name: LEGACY_MIGRATION_ADAPTER_NAME,
              version: LEGACY_MIGRATION_ADAPTER_VERSION,
            }
          : { name: recovered.parserName, version: recovered.parserVersion };
        await quarantineRow(
          options.backend,
          run,
          reconciler,
          "threads",
          thread,
          `write failed: ${errorMessage(error)}`,
          quarantineParser,
          true,
        );
        await accountSourceOwnedThreadRecords(
          options.backend,
          run,
          reconciler,
          bundle,
          threadRecordRevisionTargets,
          identityPrefetch,
          `parent threads:${thread.id} write failed`,
          quarantineParser,
        );
        await quarantineCanonicalBundleChildren(
          options.backend,
          run,
          reconciler,
          bundle,
          `parent threads:${thread.id} write failed`,
          quarantineParser,
        );
        continue;
      }
    }

    // A corpus containing exactly 100 threads has no index-100 iteration, so
    // emit the same checkpoint only after its final bundle has terminated.
    if (threadRows.length === LEGACY_THREAD_SPEED_SAMPLE_SIZE) {
      await enforceThreadSpeedCheckpoint();
    }

    for (const row of reader.orphanThreadRecords()) {
      await quarantineRow(
        options.backend,
        run,
        reconciler,
        "thread_records",
        row,
        `orphan: threads:${row.thread_id} отсутствует`,
      );
    }
    for (const row of reader.orphanMessages()) {
      await quarantineRow(
        options.backend,
        run,
        reconciler,
        "messages",
        row,
        `orphan: threads:${row.thread_id} отсутствует`,
      );
    }
    for (const row of reader.orphanChunks()) {
      await quarantineRow(
        options.backend,
        run,
        reconciler,
        "message_chunks",
        row,
        `orphan: message parent отсутствует`,
      );
    }

    const committedReconciliation = options.backend.reconciliationForRun
      ? await options.backend.reconciliationForRun(run, reader.totals)
      : reconciler.report();
    const hostAttribution = await options.backend.hostAttributionReport(run);
    const attributedHostRows = (["projects", "source_files", "threads"] as const)
      .reduce((sum, table) => {
        const counters = committedReconciliation.tables[table];
        return sum + counters.matched + counters.inserted + counters.quarantined;
      }, 0);
    const assignmentCoverageExact = !options.backend.durableAttribution || (
      hostAttribution.uncertainty.length === 0 &&
      hostAttribution.actualAssignments.length === attributedHostRows &&
      hostAttribution.actualAssignments.length === authorization.hostMapping.assignments.length &&
      hostAttribution.actualAssignments.every((actual) => {
        const approved = authorization.hostMapping.assignments.find((candidate) =>
          candidate.table === actual.table && candidate.legacyId === actual.legacyId
        );
        return approved !== undefined &&
          canonicalMigrationJson(actual) === canonicalMigrationJson(approved);
      })
    );
    if (committedReconciliation.quarantined === 0 && !assignmentCoverageExact) {
      throw new Error("durable committed host assignments do not exactly match approval");
    }
    const report: MigrationRunReport = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      status: committedReconciliation.quarantined > 0 ? "completed_with_errors" : "completed",
      snapshotPath: options.snapshotPath,
      snapshotSha256: verifiedSnapshot.sha256,
      syncRunId: String(run.syncRunId),
      migrationId: String(run.migrationId),
      reportPath: options.reportPath,
      approvalArtifactSha256: authorization.approval.artifactSha256,
      approvalFileSha256: authorization.approvalFile!.sha256,
      approvalAttestationSha256: attestation.attestationSha256,
      approvalKeyFingerprint: attestation.keyFingerprint,
      hostMappingArtifactSha256: authorization.hostMapping.artifactSha256,
      backupArtifactSha256: authorization.safety.backup.sha256,
      restoreArtifactSha256: authorization.safety.restore.sha256,
      reconciliation: committedReconciliation,
      recovery,
      hostAttribution,
      assignmentCoverageOk: assignmentCoverageExact,
    };
    if (!report.reconciliation.ok) {
      throw new Error(`migration reconciliation lost=${report.reconciliation.lost}`);
    }
    const reportHash = await writeMigrationRunReport(options.reportPath!, report);
    published = { path: options.reportPath!, ...reportHash };
    await options.backend.finishRun(run, report.status, report, undefined, published);
    return report;
  } catch (error) {
    if (run && !published) {
      const failedReconciliation = options.backend.reconciliationForRun
        ? await options.backend.reconciliationForRun(run, reader.totals).catch(() => reconciler.report())
        : reconciler.report();
      const failedReport: MigrationRunReport = {
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        status: "failed",
        snapshotPath: options.snapshotPath,
        snapshotSha256: verifiedSnapshot.sha256,
        syncRunId: String(run.syncRunId),
        migrationId: String(run.migrationId),
        reportPath: options.reportPath,
        approvalArtifactSha256: authorization.approval.artifactSha256,
        approvalFileSha256: authorization.approvalFile!.sha256,
        approvalAttestationSha256: attestation.attestationSha256,
        approvalKeyFingerprint: attestation.keyFingerprint,
        hostMappingArtifactSha256: authorization.hostMapping.artifactSha256,
        backupArtifactSha256: authorization.safety.backup.sha256,
        restoreArtifactSha256: authorization.safety.restore.sha256,
        reconciliation: failedReconciliation,
        recovery,
        hostAttribution: await options.backend.hostAttributionReport(run),
        assignmentCoverageOk: false,
        error: errorMessage(error),
      };
      const failedPublication = options.reportPath
        ? await writeMigrationRunReport(options.reportPath, failedReport)
          .then((hash) => ({ path: options.reportPath!, ...hash }))
          .catch(() => undefined)
        : undefined;
      await options.backend.finishRun(
        run,
        "failed",
        failedReport,
        errorMessage(error),
        failedPublication,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    reader.close();
  }
}

export async function runLegacyMigrationWithSurreal(
  options: RunLegacyMigrationWithSurrealOptions,
): Promise<MigrationRunReport> {
  if (!options.safetyContext ||
      path.resolve(options.safetyContext.archiveRoot) !== path.resolve(options.archiveRoot)) {
    throw new Error("restore safety archiveRoot does not match Surreal migration runner archiveRoot");
  }
  const live = await probeMigrationApprovalBaselineFromDb(options.db);
  return runLegacyMigration({
    ...options,
    authorization: options.authorization
      ? { ...options.authorization, currentLiveProbe: live }
      : undefined,
    reportPath: options.reportPath ?? path.join(
      options.archiveRoot,
      "backups",
      "manifests",
      `migration-run-${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}.json`,
    ),
    backend: new SurrealLegacyMigrationBackend(
      options.db,
      options.archiveRoot,
      options.identity,
      options.approvedHostMappings,
    ),
  });
}

/** Retry = новый durable run; успешные rows matched, старый quarantine resolved. */
export const retryLegacyMigration = runLegacyMigration;
