/** SurrealDB persistence adapter для Stage 10 legacy migration. */

import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import type {
  ParsedChunk,
  ParsedDialogue,
  ParsedMessage,
} from "../domain/canonical-types.ts";
import type { LocalIdentity } from "../sync/host-identity.ts";
import { deterministicId, sha256hex } from "../db/transactions.ts";
import {
  ensureHarness,
  ensureHarnessInstallation,
  ensureHost,
  ensureOsAccount,
} from "../db/repositories/identity.ts";
import { clean, selectOne } from "../db/repositories/helpers.ts";
import { snapshotRegularFile } from "../sources/snapshot/raw-snapshot.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import { HARNESS_TOOLS } from "../sync/harness-tools.ts";
import type { HarnessSlug } from "../sources/adapters/harnesses.ts";
import {
  modelKeyOf,
  prepareSearchDocuments,
  primaryModelKey,
} from "../db/repositories/corpus.ts";
import { normalizeUsageEvents } from "../parsers/shared/usage-normalization.ts";
import { SEGMENTATION_VERSION } from "../search/segmenter.ts";
import {
  canonicalDialogueHash,
  chunkRecordId,
  dialogueRevisionId,
  messageRecordId,
} from "../sync/canonical-hash.ts";
import type {
  LegacyAgentRow,
  LegacyChunkRow,
  LegacyMessageRow,
  LegacyProjectRow,
  LegacyRawBackupRow,
  LegacySourceFileRow,
  LegacySqlRow,
  LegacyTable,
  LegacyThreadRecordRow,
  LegacyThreadBundle,
  LegacyThreadRow,
} from "./legacy-reader.ts";
import { LEGACY_TABLES, numberColumn, stringColumn } from "./legacy-reader.ts";
import type {
  MigrationCategory,
  MigrationReconciliation,
  MigrationRunReport,
} from "./reconciliation.ts";
import type {
  LegacyHostAssignment,
  LegacyHostMappingApproval,
} from "./authorization.ts";

export interface MigrationRunInput {
  legacyDbPath: string;
  legacyDbSha256: string;
  bakaCommit: string;
  schemaVersion: number;
  approvalArtifactSha256: string;
  approvalFileSha256: string;
  approvalAttestationSha256: string;
  approvalKeyFingerprint: string;
  hostMappingArtifactSha256: string;
  hostMappingAssignmentsJson: string;
  backupArtifactPath: string;
  backupArtifactSha256: string;
  restoreArtifactPath: string;
  restoreArtifactSha256: string;
  backupManifestPath: string;
  backupManifestSha256: string;
  rawManifestSha256: string;
  restoreNamespace: string;
  reportPath: string;
}

export interface MigrationRunHandle {
  syncRunId: RecordId;
  migrationId: RecordId;
}

export interface MigrationReportPublication {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface EnsureTarget<T> {
  target: RecordId;
  created: boolean;
  value: T;
}

export interface MigrationIdentityCommit {
  table: LegacyTable;
  legacyId: string;
  target: RecordId;
  category: MigrationCategory;
  previousState?: Record<string, unknown>;
  writtenState?: Record<string, unknown>;
}

export interface LegacyIdentityRequest {
  table: LegacyTable;
  legacyId: string;
}

export interface PrefetchedLegacyIdentity {
  mapping?: RecordId;
  target: RecordId;
}

export interface LegacyIdentityPrefetch {
  requestedKeys: ReadonlySet<string>;
  existing: ReadonlyMap<string, PrefetchedLegacyIdentity>;
  unresolvedQuarantines: ReadonlyMap<string, readonly RecordId[]>;
}

export const LEGACY_IDENTITY_PREFETCH_BATCH_SIZE = 500;

export function legacyIdentityPrefetchKey(
  table: LegacyTable,
  legacyId: string,
): string {
  return JSON.stringify([table, legacyId]);
}

export function legacyDialogueIdentityRequests(
  bundle: LegacyThreadBundle,
): LegacyIdentityRequest[] {
  return [
    { table: "threads", legacyId: String(bundle.thread.id) },
    ...bundle.records.map((row) => ({
      table: "thread_records" as const,
      legacyId: String(row.id),
    })),
    ...bundle.messages.map((row) => ({
      table: "messages" as const,
      legacyId: String(row.id),
    })),
    ...bundle.chunks.map((row) => ({
      table: "message_chunks" as const,
      legacyId: String(row.id),
    })),
  ];
}

function assertExactDialogueIdentityPrefetch(
  bundle: LegacyThreadBundle,
  prefetch: LegacyIdentityPrefetch,
): void {
  const expected = new Set(
    legacyDialogueIdentityRequests(bundle).map((request) =>
      legacyIdentityPrefetchKey(request.table, request.legacyId)
    ),
  );
  if (expected.size !== prefetch.requestedKeys.size ||
      [...expected].some((key) => !prefetch.requestedKeys.has(key)) ||
      prefetch.existing.size > expected.size ||
      [...prefetch.existing].some(([key, row]) =>
        !expected.has(key) || !(row.target instanceof RecordId) ||
        (row.mapping !== undefined && !(row.mapping instanceof RecordId))) ||
      [...prefetch.unresolvedQuarantines].some(([key, ids]) =>
        !expected.has(key) || !Array.isArray(ids) ||
        ids.some((id) => !(id instanceof RecordId) ||
          !String(id).startsWith("migration_quarantine:")))) {
    throw new Error("legacy dialogue identity prefetch is incomplete or malformed");
  }
}

export function prefetchedLegacyIdentity(
  prefetch: LegacyIdentityPrefetch,
  table: LegacyTable,
  legacyId: string,
): PrefetchedLegacyIdentity | undefined {
  const key = legacyIdentityPrefetchKey(table, legacyId);
  if (!prefetch.requestedKeys.has(key)) {
    throw new Error(`legacy identity prefetch does not cover ${table}:${legacyId}`);
  }
  return prefetch.existing.get(key);
}

export interface AgentTarget {
  harnessId: RecordId;
  slug: HarnessSlug;
}

export interface ProjectTarget {
  workspaceId: RecordId;
}

export interface SourceTarget {
  row: LegacySourceFileRow;
  locationId: RecordId;
  sourceRootId: RecordId;
  hostId: RecordId;
  osAccountId?: RecordId;
  installationId: RecordId;
  agentSlug: HarnessSlug;
  created: boolean;
  previousPresence?: string;
  selectedRevision?: RevisionTarget;
  hostMappingId: string;
  /** Dedicated disabled legacy source_root proves this location is migration-only. */
  legacyOnlyLocation?: boolean;
}

export interface RevisionTarget {
  revisionId: RecordId;
  sha256: string;
  rawPath?: string;
  created: boolean;
  provisionalReplay?: {
    rootId: RecordId;
    rootExists: boolean;
    locationId: RecordId;
    locationExists: boolean;
    previousCurrentRevision?: RecordId;
    previousLastSuccessfulRevision?: RecordId;
    revisionExists: boolean;
    installationId: RecordId;
    mappingId: string;
    agentSlug: HarnessSlug;
    rootPath: string;
    relativePath: string;
    originalPath: string;
    sizeBytes: number;
    mtimeMs: number;
    headHash?: string;
    rawArchivePath: string;
    parserName: string;
    parserVersion: number;
  };
}

export interface DialogueTarget {
  dialogueId: RecordId;
  revisionId: RecordId;
  createdDialogue: boolean;
  createdRevision: boolean;
  createdModelIds?: RecordId[];
  createdVendorIds?: RecordId[];
  createdWorkspaceId?: RecordId;
}

export type LegacyRecoverySource = "raw" | "payload" | "normalized";

export interface LegacyCanonicalMessageBinding {
  legacyId: string;
  canonicalSequence: number;
}

export interface LegacyCanonicalChunkBinding {
  legacyId: string;
  legacyMessageId: string;
  canonicalMessageSequence: number;
  canonicalChunkSequence: number;
}

/**
 * Exact ownership established while selecting a recovery candidate.
 *
 * Legacy sequence numbers are not canonical identities: newer parsers may
 * materialize reasoning/tool events which did not exist in the legacy
 * projection. Keeping the resolved canonical sequences beside the parsed DTO
 * prevents the persistence adapters from silently rebinding a legacy row to a
 * different canonical child.
 */
export interface LegacyCanonicalBindings {
  source: LegacyRecoverySource;
  messages: LegacyCanonicalMessageBinding[];
  chunks: LegacyCanonicalChunkBinding[];
}

export interface DialogueWriteInput {
  thread: LegacyThreadRow;
  agent: AgentTarget;
  installationId: RecordId;
  hostId: RecordId;
  osAccountId?: RecordId;
  sourceRevision: RevisionTarget;
  project?: ProjectTarget;
  parsed: ParsedDialogue;
  parserName: string;
  parserVersion: number;
  legacyBindings: LegacyCanonicalBindings;
  legacyIdentityPrefetch: LegacyIdentityPrefetch;
  /**
   * Live corpus admission decided from the exact approved probe. A live match
   * may only acquire legacy ownership; it must never create a historical
   * canonical revision. A missing dialogue is writable only for a thread
   * whose linked legacy sources are all proven deleted.
   */
  canonicalImportPolicy: "match_existing" | "import_deleted";
  /** Durable legacy mapping has precedence over all derived identities. */
  authoritativeDialogueId?: RecordId;
}

function legacyMessageRole(row: LegacyMessageRow): ParsedMessage["role"] {
  switch (stringColumn(row, "role")) {
    case "user":
      return "user";
    case "assistant":
    case "model":
      return "assistant";
    case "system":
      return "system";
    case "developer":
      return "developer";
    case "tool":
      return "tool";
    default:
      return "unknown";
  }
}

function legacySourceRecordId(
  row: LegacySqlRow,
  fallback?: number,
): number | undefined {
  const value = row.source_record_id;
  if (value === null || value === undefined) return fallback;
  const result = numberColumn(row, "source_record_id", Number.NaN);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function finalSourceLine(chunk: ParsedChunk): number | undefined {
  const match = chunk.sourceLocator?.match(/#L([1-9][0-9]*)$/u);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isSafeInteger(line) ? line : undefined;
}

function assertLegacyChunkSemantics(
  row: LegacyChunkRow,
  chunk: ParsedChunk,
  expectedLine?: number,
): boolean {
  if (expectedLine !== undefined && finalSourceLine(chunk) !== expectedLine) return false;
  const expectedSha = stringColumn(row, "content_sha256")?.toLowerCase();
  const rawBytes = row.content_bytes;
  const expectedBytes = rawBytes === null || rawBytes === undefined
    ? Number.NaN
    : numberColumn(row, "content_bytes", Number.NaN);
  const expectedRawKind = stringColumn(row, "kind");
  if (!expectedSha || !/^[a-f0-9]{64}$/u.test(expectedSha) ||
      !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !expectedRawKind) {
    return false;
  }
  const content = chunk.content ?? "";
  return sha256hex(content) === expectedSha &&
    Buffer.byteLength(content, "utf8") === expectedBytes &&
    (chunk.rawKind ?? chunk.kind) === expectedRawKind;
}

function uniqueBySequence<T extends { sequence: number }>(
  rows: T[],
  label: string,
): Map<number, T> {
  const result = new Map<number, T>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 0 || result.has(row.sequence)) {
      throw new Error(`legacy binding: invalid or duplicate ${label} sequence ${row.sequence}`);
    }
    result.set(row.sequence, row);
  }
  return result;
}

function exactlyOne<T>(rows: T[], reason: string): T {
  if (rows.length !== 1) {
    throw new Error(`legacy binding: ${reason}; candidates=${rows.length}`);
  }
  return rows[0]!;
}

/**
 * Resolves all legacy message/chunk rows to canonical children without DB IO.
 *
 * Codex raw and payload replay use source_record_id -> JSONL line ownership,
 * because newly materialized reasoning/tool messages can shift canonical
 * sequences. Other recoveries may use legacy sequence only after role and
 * every chunk's hash/byte/raw-kind identity have been proven. Any missing or
 * ambiguous evidence rejects the recovery candidate as a whole.
 */
export function resolveLegacyCanonicalBindings(
  bundle: LegacyThreadBundle,
  parsed: ParsedDialogue,
  harness: HarnessSlug,
  source: LegacyRecoverySource,
): LegacyCanonicalBindings {
  const parsedMessages = uniqueBySequence(parsed.messages, "canonical message");
  const legacyMessages = new Map(bundle.messages.map((row) => [row.id, row]));
  const records = new Map(bundle.records.map((row) => [row.id, row]));
  const chunksByLegacyMessage = new Map<number, LegacyChunkRow[]>();
  for (const row of bundle.chunks) {
    const list = chunksByLegacyMessage.get(row.message_id) ?? [];
    list.push(row);
    chunksByLegacyMessage.set(row.message_id, list);
  }

  const codexLocatorBinding = harness === "codex" && source !== "normalized";
  const codexMessagesByRoleLine = new Map<string, ParsedMessage[]>();
  if (codexLocatorBinding) {
    for (const message of parsed.messages) {
      const lines = new Set(message.chunks.map(finalSourceLine).filter(
        (line): line is number => line !== undefined,
      ));
      for (const line of lines) {
        const key = `${message.role}:${line}`;
        const candidates = codexMessagesByRoleLine.get(key) ?? [];
        candidates.push(message);
        codexMessagesByRoleLine.set(key, candidates);
      }
    }
  }
  const messageBindings: LegacyCanonicalMessageBinding[] = [];
  const boundCanonicalMessages = new Set<number>();

  for (const row of bundle.messages) {
    const expectedRole = legacyMessageRole(row);
    let candidate: ParsedMessage;
    if (codexLocatorBinding) {
      const sourceRecordId = legacySourceRecordId(row);
      const record = sourceRecordId === undefined ? undefined : records.get(sourceRecordId);
      if (!record) {
        throw new Error(`legacy binding: messages:${row.id} has no owned thread_record`);
      }
      const expectedLine = record.sequence + 1;
      candidate = exactlyOne(
        codexMessagesByRoleLine.get(`${expectedRole}:${expectedLine}`) ?? [],
        `messages:${row.id} has no unique Codex role/line target`,
      );
    } else {
      const bySequence = parsedMessages.get(row.sequence);
      if (!bySequence || bySequence.role !== expectedRole) {
        throw new Error(
          `legacy binding: messages:${row.id} sequence/role does not match canonical message`,
        );
      }
      candidate = bySequence;
    }
    if (boundCanonicalMessages.has(candidate.sequence)) {
      throw new Error(
        `legacy binding: canonical message sequence ${candidate.sequence} has multiple legacy owners`,
      );
    }
    boundCanonicalMessages.add(candidate.sequence);
    messageBindings.push({ legacyId: String(row.id), canonicalSequence: candidate.sequence });
  }

  const messageBindingById = new Map(
    messageBindings.map((binding) => [binding.legacyId, binding]),
  );
  const chunkBindings: LegacyCanonicalChunkBinding[] = [];
  const boundCanonicalChunks = new Set<string>();
  for (const row of bundle.chunks) {
    const legacyMessage = legacyMessages.get(row.message_id);
    const messageBinding = messageBindingById.get(String(row.message_id));
    const canonicalMessage = messageBinding
      ? parsedMessages.get(messageBinding.canonicalSequence)
      : undefined;
    if (!legacyMessage || !messageBinding || !canonicalMessage) {
      throw new Error(`legacy binding: message_chunks:${row.id} has no canonical parent`);
    }
    const sourceRecordId = legacySourceRecordId(
      row,
      legacySourceRecordId(legacyMessage),
    );
    const record = sourceRecordId === undefined ? undefined : records.get(sourceRecordId);
    const expectedLine = codexLocatorBinding
      ? (record ? record.sequence + 1 : undefined)
      : undefined;
    if (codexLocatorBinding && expectedLine === undefined) {
      throw new Error(`legacy binding: message_chunks:${row.id} has no owned thread_record`);
    }
    const candidates = canonicalMessage.chunks.filter((chunk) =>
      (codexLocatorBinding || chunk.sequence === row.sequence) &&
      assertLegacyChunkSemantics(row, chunk, expectedLine)
    );
    const chunk = exactlyOne(
      candidates,
      `message_chunks:${row.id} has no unique semantic target`,
    );
    const canonicalKey = `${canonicalMessage.sequence}:${chunk.sequence}`;
    if (boundCanonicalChunks.has(canonicalKey)) {
      throw new Error(`legacy binding: canonical chunk ${canonicalKey} has multiple legacy owners`);
    }
    boundCanonicalChunks.add(canonicalKey);
    chunkBindings.push({
      legacyId: String(row.id),
      legacyMessageId: String(row.message_id),
      canonicalMessageSequence: canonicalMessage.sequence,
      canonicalChunkSequence: chunk.sequence,
    });
  }

  // A message with no legacy chunks cannot be semantically authenticated by
  // sequence alone. Codex still has a role+line proof from its canonical
  // chunks; other harnesses must fail closed and let recovery fall through.
  if (!codexLocatorBinding && source !== "normalized") {
    for (const row of bundle.messages) {
      if ((chunksByLegacyMessage.get(row.id) ?? []).length === 0) {
        throw new Error(`legacy binding: messages:${row.id} has no chunk identity evidence`);
      }
    }
  }

  return {
    source,
    messages: messageBindings,
    chunks: chunkBindings,
  };
}

function sameLegacyCanonicalBindings(
  left: LegacyCanonicalBindings,
  right: LegacyCanonicalBindings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface AtomicSourceCommitResult {
  source: SourceTarget;
  revisions: RevisionTarget[];
  commits: MigrationIdentityCommit[];
  rejectedBackups: Array<{ row: LegacyRawBackupRow; reason: string }>;
}

export interface AtomicDialogueCommitResult {
  dialogue: DialogueTarget;
  commits: MigrationIdentityCommit[];
}

export interface DialogueDedupInput {
  thread: LegacyThreadRow;
  installationId: RecordId;
  sourceSha256: string;
  authoritativeDialogueId?: RecordId;
}

export interface ApprovedLegacyHostMapping {
  /** Stable, operator-approved mapping name persisted in the report. */
  mappingId: string;
  host: LocalIdentity;
  sourceFileIds?: Array<string | number>;
  projectIds?: Array<string | number>;
  threadIds?: Array<string | number>;
  /** Optional path attribution. Ambiguous equal-length matches fail closed. */
  pathPrefixes?: string[];
}

export interface LegacyHostAttributionIssue {
  legacyTable: "projects" | "source_files" | "threads";
  legacyId: string;
  path?: string;
  reason: string;
}

export interface LegacyHostAttributionReport {
  approvedMappings: Array<{ mappingId: string; hostUuid: string; attributedRows: number }>;
  /** Exact approved assignments actually consumed by runtime code. */
  actualAssignments: LegacyHostAssignment[];
  uncertainty: LegacyHostAttributionIssue[];
}

export interface MigrationFaultHooks {
  /** Kill-boundary seam around the single visible per-row transaction. */
  beforeAtomicRowQuery?(kind: "project" | "source" | "dialogue", run: MigrationRunHandle): void | Promise<void>;
  /** Simulates lost acknowledgement/process death after COMMIT. */
  afterAtomicRowQuery?(kind: "project" | "source" | "dialogue", run: MigrationRunHandle): void | Promise<void>;
  beforeIdentityBind?(table: LegacyTable, legacyId: string, target: RecordId): void | Promise<void>;
  beforeMarkRevisionParsed?(revision: RevisionTarget): void | Promise<void>;
  beforeLifecycleFinishCommit?(
    run: MigrationRunHandle,
    publication: MigrationReportPublication | undefined,
  ): void | Promise<void>;
  /** Last lifecycle boundary; even a thrown/lost acknowledgement is followed by authentication. */
  afterLifecycleCommitBeforeFinalAuthentication?(
    run: MigrationRunHandle,
    publication: MigrationReportPublication | undefined,
  ): void | Promise<void>;
}

export const LEGACY_MIGRATION_ADAPTER_NAME = "legacy-migration-adapter";
export const LEGACY_MIGRATION_ADAPTER_VERSION = 1;

/** Reliable dedup keys disagree or point at damaged corpus state. */
export class LegacyDialogueDedupConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyDialogueDedupConflictError";
  }
}

export interface QuarantineInput {
  table: LegacyTable;
  row: LegacySqlRow;
  rawPayload: Record<string, unknown>;
  reason: string;
  parserName?: string;
  parserVersion?: number;
  retryable: boolean;
}

export interface LegacyMigrationBackend {
  readonly durableAttribution?: boolean;
  configureHostMappingApproval?(approval: LegacyHostMappingApproval): void | Promise<void>;
  startRun(input: MigrationRunInput): Promise<MigrationRunHandle>;
  finishRun(
    run: MigrationRunHandle,
    status: "completed" | "completed_with_errors" | "failed",
    report: MigrationRunReport,
    error?: string,
    publication?: MigrationReportPublication,
  ): Promise<void>;
  lookupIdentity(table: LegacyTable, legacyId: string): Promise<RecordId | undefined>;
  lookupIdentities(table: LegacyTable, legacyIds: string[]): Promise<Map<string, RecordId>>;
  prefetchIdentities?(
    requests: LegacyIdentityRequest[],
    run?: MigrationRunHandle,
  ): Promise<LegacyIdentityPrefetch>;
  bindIdentity(table: LegacyTable, legacyId: string, target: RecordId): Promise<void>;
  bindIdentities(
    table: LegacyTable,
    rows: Array<{ legacyId: string; target: RecordId }>,
  ): Promise<void>;
  commitIdentity?(
    run: MigrationRunHandle,
    table: LegacyTable,
    legacyId: string,
    target: RecordId,
    category: MigrationCategory,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<void>;
  commitIdentityBatch?(
    run: MigrationRunHandle,
    rows: MigrationIdentityCommit[],
    revisionToMark?: RevisionTarget,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<void>;
  completeIdentity(
    table: LegacyTable,
    legacyId: string,
    target: RecordId,
    run?: MigrationRunHandle,
    category?: MigrationCategory,
  ): Promise<void>;
  rollbackImportAttempt?(table: LegacyTable, result: EnsureTarget<unknown>): Promise<void>;
  quarantine(run: MigrationRunHandle, input: QuarantineInput): Promise<void>;
  hostAttributionReport(
    run?: MigrationRunHandle,
  ): LegacyHostAttributionReport | Promise<LegacyHostAttributionReport>;
  reconciliationForRun?(
    run: MigrationRunHandle,
    totals: Record<LegacyTable, number>,
  ): Promise<MigrationReconciliation>;
  ensureAgent(row: LegacyAgentRow, authoritativeTarget?: RecordId): Promise<EnsureTarget<AgentTarget>>;
  ensureProject(
    row: LegacyProjectRow,
    agent: AgentTarget,
    authoritativeTarget?: RecordId,
  ): Promise<EnsureTarget<ProjectTarget>>;
  commitProjectRow?(
    run: MigrationRunHandle,
    row: LegacyProjectRow,
    agent: AgentTarget,
    authoritativeTarget?: RecordId,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<{ result: EnsureTarget<ProjectTarget>; commit: MigrationIdentityCommit }>;
  ensureSourceFile(
    row: LegacySourceFileRow,
    agent: AgentTarget,
    authoritativeTarget?: RecordId,
  ): Promise<EnsureTarget<SourceTarget>>;
  importRawBackup(
    run: MigrationRunHandle,
    row: LegacyRawBackupRow,
    source: SourceTarget,
    authoritativeTarget?: RecordId,
  ): Promise<EnsureTarget<RevisionTarget>>;
  ensureMissingRawRevision(
    run: MigrationRunHandle,
    source: SourceTarget,
  ): Promise<RevisionTarget>;
  finalizeSourceFile(source: SourceTarget, revision: RevisionTarget): Promise<void>;
  commitSourceRows?(
    run: MigrationRunHandle,
    row: LegacySourceFileRow,
    backups: LegacyRawBackupRow[],
    agent: AgentTarget,
    authoritativeTarget?: RecordId,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<AtomicSourceCommitResult>;
  rollbackSourceAttempt?(source: SourceTarget, revisions: RevisionTarget[]): Promise<void>;
  createReplayRevision(
    run: MigrationRunHandle,
    thread: LegacyThreadRow,
    records: LegacyThreadRecordRow[],
    agent: AgentTarget,
    contextSource: SourceTarget | undefined,
    content: string,
  ): Promise<RevisionTarget>;
  threadIdentityContext(
    agent: AgentTarget,
    preferredSource: SourceTarget | undefined,
    thread: LegacyThreadRow,
  ): Promise<{ installationId: RecordId; hostId: RecordId; osAccountId?: RecordId }>;
  preflightDialogueDedup(input: DialogueDedupInput): Promise<RecordId | undefined>;
  writeDialogue(input: DialogueWriteInput): Promise<DialogueTarget>;
  commitDialogueRow?(
    run: MigrationRunHandle,
    input: DialogueWriteInput,
    bundle: LegacyThreadBundle,
  ): Promise<AtomicDialogueCommitResult>;
  rollbackDialogueAttempt(
    thread: LegacyThreadRow,
    dialogue: DialogueTarget | undefined,
    sourceRevision: RevisionTarget,
    removeThreadMapping: boolean,
  ): Promise<void>;
  markRevisionParsed(revision: RevisionTarget): Promise<void>;
}

interface HostContext {
  hostId: RecordId;
  osAccountId?: RecordId;
  mappingId: string;
}

function normalizedPath(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : value;
}

function isDeleted(row: LegacySourceFileRow): boolean {
  return row.status === "deleted_in_source" || stringColumn(row, "deleted_at") !== undefined;
}

/** Legacy history никогда не понижает существующий live active/missing. */
export function shouldApplyLegacyDeleted(
  locationCreated: boolean,
  previousPresence?: string,
  provenLegacyOnly = false,
): boolean {
  return locationCreated || provenLegacyOnly || previousPresence === "deleted_in_source";
}

/** Repair может только заполнить ранее отсутствовавшую raw-ссылку. */
export function shouldAttachRepairedRaw(
  existingRawArchivePath: string | undefined,
  repairedRawArchivePath: string | undefined,
): boolean {
  return existingRawArchivePath === undefined && repairedRawArchivePath !== undefined;
}

export interface KimiLegacyRecoveryView {
  /** Путь, который безопасно передать kimi parser'у. */
  parsePath: string;
  /** Временный wire.jsonl, ссылающийся на immutable raw. */
  materializedPath: string;
  /** Корень, который владелец обязан удалить после migration run. */
  viewRoot: string;
}

interface KimiWireLayout {
  sessionId?: string;
  agentId?: string;
}

function safeKimiPathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." &&
    !value.includes("\0") && !value.includes("/") && !value.includes("\\") &&
    Buffer.byteLength(value, "utf8") <= 255;
}

function kimiWireLayout(semanticPaths: string[]): KimiWireLayout | undefined {
  let flatWire: KimiWireLayout | undefined;
  for (const semanticPath of semanticPaths) {
    const parts = semanticPath.replaceAll("\\", "/").split("/");
    if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) continue;
    const nonEmpty = parts.filter((part) => part.length > 0);
    if (nonEmpty.length >= 4 && nonEmpty.at(-1) === "wire.jsonl" &&
      nonEmpty.at(-3) === "agents") {
      const sessionId = nonEmpty.at(-4)!;
      const agentId = nonEmpty.at(-2)!;
      if (safeKimiPathSegment(sessionId) && safeKimiPathSegment(agentId)) {
        return { sessionId, agentId };
      }
    }
    if (nonEmpty.length === 1 && nonEmpty[0] === "wire.jsonl") flatWire = {};
  }
  return flatWire;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

/**
 * Возвращает parser-compatible view для content-addressed Kimi raw.
 *
 * Сам raw остаётся на месте и не переименовывается: hardlink (или copy на
 * томах без hardlink) получает исходное имя wire.jsonl и, когда возможно,
 * безопасно восстановленную структуру <session>/agents/<agent>/wire.jsonl.
 * Неоднозначные/state-only/traversal пути не угадываются — recovery
 * пропускается, а immutable raw остаётся доступен для fallback/retry.
 */
export async function materializeKimiLegacyRecoveryView(input: {
  archiveRoot: string;
  immutableRawPath: string;
  semanticPaths: string[];
}): Promise<KimiLegacyRecoveryView | undefined> {
  const layout = kimiWireLayout(input.semanticPaths);
  if (!layout) return undefined;

  const rawInfo = await lstat(input.immutableRawPath);
  if (!rawInfo.isFile() || rawInfo.isSymbolicLink()) {
    throw new Error("immutable Kimi raw must be a regular non-symlink file");
  }
  const [rawRoot, immutableRaw] = await Promise.all([
    realpath(path.join(input.archiveRoot, "raw", "kimi-code")),
    realpath(input.immutableRawPath),
  ]);
  if (!pathIsInside(rawRoot, immutableRaw)) {
    throw new Error("immutable Kimi raw escapes archive raw/kimi-code");
  }

  const temporaryParent = path.join(input.archiveRoot, "staging");
  await mkdir(temporaryParent, { recursive: true });
  const viewRoot = await mkdtemp(path.join(temporaryParent, "migration-kimi-recovery-"));
  const materializedPath = layout.sessionId && layout.agentId
    ? path.join(viewRoot, layout.sessionId, "agents", layout.agentId, "wire.jsonl")
    : path.join(viewRoot, "wire.jsonl");
  try {
    await mkdir(path.dirname(materializedPath), { recursive: true });
    try {
      await link(immutableRaw, materializedPath);
    } catch {
      await copyFile(immutableRaw, materializedPath, fsConstants.COPYFILE_EXCL);
    }
    return {
      parsePath: layout.sessionId ? path.join(viewRoot, layout.sessionId) : materializedPath,
      materializedPath,
      viewRoot,
    };
  } catch (error) {
    await rm(viewRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Kimi payload replay получает стабильную сессионную wire-семантику. */
export function kimiLegacyReplaySemanticPath(externalId: string): string | undefined {
  if (!safeKimiPathSegment(externalId)) return undefined;
  return `${externalId}/agents/main/wire.jsonl`;
}

function optionalInt(row: LegacySqlRow, name: string): number | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  const number = numberColumn(row, name, Number.NaN);
  return Number.isFinite(number) ? Math.round(number) : undefined;
}

function recordKey(id: RecordId): string {
  return typeof id.id === "string" ? id.id : String(id.id);
}

class MigrationTxBuilder {
  readonly sql: string[] = ["BEGIN;"];
  readonly vars: Record<string, unknown> = {};
  private counter = 0;

  param(value: unknown): string {
    const name = `p${this.counter++}`;
    this.vars[name] = value;
    return `$${name}`;
  }

  assignments(fields: Array<[string, unknown]>): string[] {
    return fields
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => `${field} = ${this.param(value)}`);
  }
}

function containsLegacyId(values: Array<string | number> | undefined, id: string): boolean {
  return values?.some((value) => String(value) === id) ?? false;
}

function matchesPrefix(value: string, prefix: string): boolean {
  const normalized = normalizedPath(prefix);
  return value === normalized || value.startsWith(`${normalized}${path.sep}`);
}

function mappingSelectorIds(
  mapping: ApprovedLegacyHostMapping,
  table: LegacyHostAttributionIssue["legacyTable"],
): Array<string | number> | undefined {
  if (table === "source_files") return mapping.sourceFileIds;
  if (table === "projects") return mapping.projectIds;
  return mapping.threadIds;
}

export function resolveApprovedHostMapping(
  mappings: ApprovedLegacyHostMapping[],
  table: LegacyHostAttributionIssue["legacyTable"],
  legacyId: string | number,
  sourcePath?: string,
): ApprovedLegacyHostMapping {
  const id = String(legacyId);
  const explicit = mappings.filter((mapping) =>
    containsLegacyId(mappingSelectorIds(mapping, table), id)
  );
  if (explicit.length === 1) return explicit[0]!;
  if (explicit.length > 1) {
    throw new Error(
      `host mapping ambiguous: ${table}:${id} explicitly assigned to ${explicit.map((m) => m.mappingId).join(", ")}`,
    );
  }
  if (!sourcePath) {
    throw new Error(`host mapping missing: ${table}:${id} has no explicit approved assignment`);
  }
  const candidates = mappings.flatMap((mapping) =>
    (mapping.pathPrefixes ?? [])
      .filter((prefix) => matchesPrefix(sourcePath, prefix))
      .map((prefix) => ({ mapping, length: normalizedPath(prefix).length })),
  );
  const longest = Math.max(-1, ...candidates.map((candidate) => candidate.length));
  const winners = candidates.filter((candidate) => candidate.length === longest);
  const unique = new Map(winners.map((winner) => [winner.mapping.mappingId, winner.mapping]));
  if (unique.size === 1) return [...unique.values()][0]!;
  if (unique.size === 0) {
    throw new Error(`host mapping missing: ${table}:${id} path ${sourcePath} is not approved`);
  }
  throw new Error(
    `host mapping ambiguous: ${table}:${id} path ${sourcePath} matches ${[...unique.keys()].join(", ")}`,
  );
}

export class LegacyIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyIdentityConflictError";
  }
}

function assertAuthoritativeTarget(
  table: LegacyTable,
  legacyId: string | number,
  authoritative: RecordId | undefined,
  candidate: RecordId,
): void {
  if (authoritative && String(authoritative) !== String(candidate)) {
    throw new LegacyIdentityConflictError(
      `legacy identity conflict ${table}:${String(legacyId)}: ${String(authoritative)} != ${String(candidate)}`,
    );
  }
}

interface MigrationLifecycleRow {
  id: RecordId;
  status: string;
  sync_run: RecordId;
  legacy_db_sha256: string;
  approval_artifact_sha256?: string;
  approval_file_sha256?: string;
  approval_attestation_sha256?: string;
  approval_key_fingerprint?: string;
  host_mapping_artifact_sha256?: string;
  backup_artifact_sha256?: string;
  restore_artifact_sha256?: string;
  report_path?: string;
  report_sha256?: string;
  report_size_bytes?: number;
}

interface AuthenticatedMigrationReport {
  report: MigrationRunReport;
  sha256: string;
  sizeBytes: number;
  device: number;
  inode: number;
}

function reportRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is not object`);
  }
  return value as Record<string, unknown>;
}

function exactReportKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  name = "migration report",
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (actual.some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new Error(`${name} has missing or unknown fields`);
  }
}

function reportNonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} is not a non-negative safe integer`);
  }
  return value as number;
}

function reportString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is not a string`);
  return value;
}

function reportSha(value: unknown, name: string): string {
  const result = reportString(value, name);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${name} is not lowercase SHA-256`);
  return result;
}

function canonicalReportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReportValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalReportValue(item)]));
  }
  return value;
}

function canonicalReportJson(value: unknown): string {
  return JSON.stringify(canonicalReportValue(value));
}

function migrationReportObject(value: unknown): MigrationRunReport {
  const root = reportRecord(value, "migration report root");
  exactReportKeys(root, [
    "formatVersion", "createdAt", "status", "snapshotPath", "snapshotSha256",
    "syncRunId", "migrationId", "reportPath", "approvalArtifactSha256",
    "approvalFileSha256", "approvalAttestationSha256", "approvalKeyFingerprint",
    "hostMappingArtifactSha256", "backupArtifactSha256", "restoreArtifactSha256",
    "reconciliation", "recovery", "hostAttribution", "assignmentCoverageOk",
  ], ["error"]);
  if (root.formatVersion !== 1) throw new Error("migration report formatVersion unsupported");
  const status = root.status;
  if (!(["completed", "completed_with_errors", "failed"] as unknown[]).includes(status)) {
    throw new Error("migration report status invalid");
  }
  const createdAt = reportString(root.createdAt, "migration report createdAt");
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error("migration report createdAt invalid");
  }
  for (const field of ["snapshotPath", "syncRunId", "migrationId", "reportPath"] as const) {
    reportString(root[field], `migration report ${field}`);
  }
  for (const field of [
    "snapshotSha256", "approvalArtifactSha256", "approvalFileSha256",
    "approvalAttestationSha256", "approvalKeyFingerprint", "hostMappingArtifactSha256",
    "backupArtifactSha256", "restoreArtifactSha256",
  ] as const) reportSha(root[field], `migration report ${field}`);
  if (typeof root.assignmentCoverageOk !== "boolean") {
    throw new Error("migration report assignmentCoverageOk invalid");
  }
  if (status === "completed" && root.assignmentCoverageOk !== true) {
    throw new Error("completed migration report must have exact assignment coverage");
  }
  if (root.error !== undefined && (status !== "failed" || typeof root.error !== "string")) {
    throw new Error("migration report error/status invalid");
  }

  const recovery = reportRecord(root.recovery, "migration report recovery");
  exactReportKeys(recovery, ["raw", "payload", "normalized"], [], "migration report recovery");
  for (const field of ["raw", "payload", "normalized"] as const) {
    reportNonnegativeInteger(recovery[field], `migration report recovery.${field}`);
  }

  const reconciliation = reportRecord(root.reconciliation, "migration report reconciliation");
  exactReportKeys(reconciliation, [
    "legacyTotal", "matched", "inserted", "quarantined", "accounted", "lost", "ok", "tables",
  ], [], "migration report reconciliation");
  const totals = Object.fromEntries(
    ["legacyTotal", "matched", "inserted", "quarantined", "accounted", "lost"]
      .map((field) => [field, reportNonnegativeInteger(reconciliation[field], `reconciliation.${field}`)]),
  ) as Record<string, number>;
  if (typeof reconciliation.ok !== "boolean") throw new Error("reconciliation.ok invalid");
  const tables = reportRecord(reconciliation.tables, "migration report reconciliation.tables");
  exactReportKeys(tables, LEGACY_TABLES, [], "migration report reconciliation.tables");
  const sums = { total: 0, matched: 0, inserted: 0, quarantined: 0, accounted: 0, lost: 0 };
  for (const table of LEGACY_TABLES) {
    const counters = reportRecord(tables[table], `reconciliation.tables.${table}`);
    exactReportKeys(counters, ["total", "matched", "inserted", "quarantined", "accounted", "lost"], [], `reconciliation.tables.${table}`);
    const parsed = Object.fromEntries(Object.keys(sums).map((field) => [
      field, reportNonnegativeInteger(counters[field], `reconciliation.tables.${table}.${field}`),
    ])) as typeof sums;
    if (parsed.accounted !== parsed.matched + parsed.inserted + parsed.quarantined ||
        parsed.lost !== parsed.total - parsed.accounted) {
      throw new Error(`reconciliation table arithmetic invalid: ${table}`);
    }
    for (const field of Object.keys(sums) as Array<keyof typeof sums>) sums[field] += parsed[field];
  }
  if (
    totals.legacyTotal !== sums.total || totals.matched !== sums.matched ||
    totals.inserted !== sums.inserted || totals.quarantined !== sums.quarantined ||
    totals.accounted !== sums.accounted || totals.lost !== sums.lost ||
    totals.accounted !== totals.matched + totals.inserted + totals.quarantined ||
    totals.lost !== totals.legacyTotal - totals.accounted ||
    reconciliation.ok !== (totals.lost === 0) ||
    (status !== "failed" && reconciliation.ok !== true) ||
    (status === "completed" && totals.quarantined !== 0) ||
    (status === "completed_with_errors" && totals.quarantined < 1)
  ) throw new Error("migration report reconciliation/status semantics invalid");

  const attribution = reportRecord(root.hostAttribution, "migration report hostAttribution");
  exactReportKeys(attribution, ["approvedMappings", "actualAssignments", "uncertainty"], [], "migration report hostAttribution");
  if (!Array.isArray(attribution.approvedMappings) || !Array.isArray(attribution.actualAssignments) ||
      !Array.isArray(attribution.uncertainty)) throw new Error("migration report hostAttribution arrays invalid");
  const mappingCounts = new Map<string, number>();
  for (const item of attribution.approvedMappings) {
    const mapping = reportRecord(item, "hostAttribution.approvedMappings item");
    exactReportKeys(mapping, ["mappingId", "hostUuid", "attributedRows"], [], "hostAttribution.approvedMappings item");
    const mappingId = reportString(mapping.mappingId, "host mappingId");
    reportString(mapping.hostUuid, "host hostUuid");
    if (mappingCounts.has(mappingId)) throw new Error("duplicate host mapping in migration report");
    mappingCounts.set(mappingId, reportNonnegativeInteger(mapping.attributedRows, "host attributedRows"));
  }
  const assignmentKeys = new Set<string>();
  const actualCounts = new Map<string, number>();
  for (const item of attribution.actualAssignments) {
    const assignment = reportRecord(item, "hostAttribution.actualAssignments item");
    exactReportKeys(assignment, ["table", "legacyId", "mappingId", "basis"], [], "hostAttribution.actualAssignments item");
    if (!["projects", "source_files", "threads"].includes(String(assignment.table)) ||
        !["explicit", "path", "source_relation", "project_relation"].includes(String(assignment.basis))) {
      throw new Error("host attribution assignment enum invalid");
    }
    const legacyId = reportString(assignment.legacyId, "host assignment legacyId");
    const mappingId = reportString(assignment.mappingId, "host assignment mappingId");
    if (!mappingCounts.has(mappingId)) throw new Error("host assignment references unknown mapping");
    const key = `${assignment.table}:${legacyId}`;
    if (assignmentKeys.has(key)) throw new Error("duplicate host assignment in migration report");
    assignmentKeys.add(key);
    actualCounts.set(mappingId, (actualCounts.get(mappingId) ?? 0) + 1);
  }
  for (const [mappingId, count] of mappingCounts) {
    if ((actualCounts.get(mappingId) ?? 0) !== count) throw new Error("host attributedRows mismatch");
  }
  for (const item of attribution.uncertainty) {
    const issue = reportRecord(item, "hostAttribution.uncertainty item");
    exactReportKeys(issue, ["legacyTable", "legacyId", "reason"], ["path"], "hostAttribution.uncertainty item");
    if (!["projects", "source_files", "threads"].includes(String(issue.legacyTable))) {
      throw new Error("host attribution uncertainty table invalid");
    }
    reportString(issue.legacyId, "host attribution uncertainty legacyId");
    reportString(issue.reason, "host attribution uncertainty reason");
    if (issue.path !== undefined) reportString(issue.path, "host attribution uncertainty path");
  }
  if (root.assignmentCoverageOk === true && attribution.uncertainty.length !== 0) {
    throw new Error("exact assignment coverage cannot contain uncertainty");
  }
  return root as unknown as MigrationRunReport;
}

async function authenticatePublishedMigrationReport(
  filePath: string,
  expectedSha256: string | undefined,
  expectedSizeBytes: number | undefined,
  expected: {
    migrationId: RecordId;
    syncRunId: RecordId;
    snapshotSha256: string;
    approvalArtifactSha256?: string;
    approvalFileSha256?: string;
    approvalAttestationSha256?: string;
    approvalKeyFingerprint?: string;
    hostMappingArtifactSha256?: string;
    backupArtifactSha256?: string;
    restoreArtifactSha256?: string;
  },
): Promise<AuthenticatedMigrationReport> {
  const resolved = path.resolve(filePath);
  const descriptor = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let content: Buffer;
  let device = 0;
  let inode = 0;
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) throw new Error("migration report is not regular file");
    device = before.dev;
    inode = before.ino;
    content = await descriptor.readFile();
    const after = await descriptor.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || content.byteLength !== after.size) {
      throw new Error("migration report changed during authentication");
    }
    const linked = await lstat(resolved);
    if (
      linked.isSymbolicLink() || !linked.isFile() || linked.dev !== after.dev ||
      linked.ino !== after.ino || linked.size !== after.size || linked.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("migration report pathname changed during authentication");
    }
  } finally {
    await descriptor.close();
  }
  const report = migrationReportObject(JSON.parse(content.toString("utf8")));
  const sha256 = createHash("sha256").update(content).digest("hex");
  const sizeBytes = content.byteLength;
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new Error("migration report SHA mismatch");
  }
  if (expectedSizeBytes !== undefined && sizeBytes !== expectedSizeBytes) {
    throw new Error("migration report size mismatch");
  }
  if (
    path.resolve(report.reportPath!) !== resolved ||
    report.migrationId !== String(expected.migrationId) ||
    report.syncRunId !== String(expected.syncRunId) ||
    report.snapshotSha256 !== expected.snapshotSha256 ||
    report.approvalArtifactSha256 !== expected.approvalArtifactSha256 ||
    report.approvalFileSha256 !== expected.approvalFileSha256 ||
    report.approvalAttestationSha256 !== expected.approvalAttestationSha256 ||
    report.approvalKeyFingerprint !== expected.approvalKeyFingerprint ||
    report.hostMappingArtifactSha256 !== expected.hostMappingArtifactSha256 ||
    report.backupArtifactSha256 !== expected.backupArtifactSha256 ||
    report.restoreArtifactSha256 !== expected.restoreArtifactSha256
  ) {
    throw new Error("migration report metadata binding mismatch");
  }
  return { report, sha256, sizeBytes, device, inode };
}

function assertSamePublishedReportIdentity(
  before: AuthenticatedMigrationReport,
  after: AuthenticatedMigrationReport,
): void {
  if (
    before.sha256 !== after.sha256 || before.sizeBytes !== after.sizeBytes ||
    before.device !== after.device || before.inode !== after.inode ||
    canonicalReportJson(before.report) !== canonicalReportJson(after.report)
  ) {
    throw new Error("migration report path/inode/bytes changed across lifecycle transition");
  }
}

export class SurrealLegacyMigrationBackend implements LegacyMigrationBackend {
  readonly durableAttribution = true;
  private currentRun?: MigrationRunHandle;
  private readonly hostCache = new Map<string, HostContext>();
  private readonly installationCache = new Map<string, RecordId>();
  private readonly attributionIssues: LegacyHostAttributionIssue[] = [];
  private readonly approvedAssignmentByRow = new Map<string, LegacyHostAssignment>();
  private readonly kimiRecoveryViewRoots = new Set<string>();

  constructor(
    private readonly db: Surreal,
    private readonly archiveRoot: string,
    private readonly identity: LocalIdentity,
    private readonly approvedHostMappings: ApprovedLegacyHostMapping[] = [],
    private readonly faultHooks: MigrationFaultHooks = {},
  ) {
    const ids = new Set<string>();
    for (const mapping of approvedHostMappings) {
      if (!mapping.mappingId.trim() || !mapping.host.hostUuid.trim()) {
        throw new Error("approved host mapping requires non-empty mappingId and hostUuid");
      }
      if (ids.has(mapping.mappingId)) {
        throw new Error(`duplicate approved host mapping id: ${mapping.mappingId}`);
      }
      ids.add(mapping.mappingId);
    }
  }

  private rememberKimiRecoveryView(
    view: KimiLegacyRecoveryView | undefined,
  ): string | undefined {
    if (!view) return undefined;
    this.kimiRecoveryViewRoots.add(view.viewRoot);
    return view.parsePath;
  }

  private async cleanupKimiRecoveryViews(): Promise<void> {
    const roots = [...this.kimiRecoveryViewRoots];
    this.kimiRecoveryViewRoots.clear();
    await Promise.allSettled(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  configureHostMappingApproval(approval: LegacyHostMappingApproval): void {
    const configured = new Map(this.approvedHostMappings.map((mapping) => [mapping.mappingId, mapping]));
    if (approval.mappings.length !== configured.size) {
      throw new Error("runtime host mappings differ from approved mapping artifact");
    }
    for (const mapping of approval.mappings) {
      const current = configured.get(mapping.mappingId);
      if (
        !current ||
        current.host.hostUuid !== mapping.host.hostUuid ||
        current.host.hostname !== mapping.host.hostname ||
        current.host.platform !== mapping.host.platform ||
        current.host.arch !== mapping.host.arch ||
        current.host.osUsername !== mapping.host.osUsername ||
        current.host.homePath !== mapping.host.homePath
      ) {
        throw new Error(`runtime host mapping differs from approval: ${mapping.mappingId}`);
      }
    }
    this.approvedAssignmentByRow.clear();
    for (const assignment of approval.assignments) {
      const key = `${assignment.table}:${assignment.legacyId}`;
      if (!configured.has(assignment.mappingId)) {
        throw new Error(`approved assignment ${key} references missing mapping ${assignment.mappingId}`);
      }
      if (this.approvedAssignmentByRow.has(key)) {
        throw new Error(`duplicate approved assignment: ${key}`);
      }
      if (!assignment.legacyId || !["projects", "source_files", "threads"].includes(assignment.table)) {
        throw new Error(`invalid approved assignment: ${key}`);
      }
      this.approvedAssignmentByRow.set(key, { ...assignment });
    }
  }

  private async cleanupUncommittedMigrationEffects(
    migration: RecordId,
    _syncRun: RecordId,
  ): Promise<void> {
    // Successful row transactions create migration_row_commit in the same
    // BEGIN/COMMIT as every visible mutation. Recovery may therefore remove
    // only records both proven created_by_run and absent from that ledger.
    // It never clears a pointer, deletes a legacy mapping, or relabels shared
    // live state; preexisting records never receive created_by_run.
    const result = await this.db.query<unknown[]>(
      `BEGIN;
       LET $committedDialogues = (SELECT VALUE target FROM migration_row_commit
         WHERE migration = $migration AND legacy_table = "threads"
           AND category IN ["matched", "inserted"]);
       LET $uncommittedRevisions = (SELECT VALUE id FROM dialogue_revision
         WHERE created_by_run = $migration AND dialogue NOT IN $committedDialogues);
       DELETE search_document WHERE created_by_run = $migration
         AND dialogue_revision INSIDE $uncommittedRevisions;
       DELETE chunk WHERE created_by_run = $migration
         AND dialogue_revision INSIDE $uncommittedRevisions;
       DELETE message WHERE created_by_run = $migration
         AND dialogue_revision INSIDE $uncommittedRevisions;
       DELETE dialogue_revision WHERE id INSIDE $uncommittedRevisions;
       DELETE dialogue WHERE created_by_run = $migration AND id NOT IN $committedDialogues
         AND count((SELECT VALUE id FROM dialogue_revision WHERE dialogue = $parent.id)) = 0;
       LET $committedLocations = (SELECT VALUE target FROM migration_row_commit
         WHERE migration = $migration AND legacy_table = "source_files"
           AND category IN ["matched", "inserted"]);
       DELETE source_revision WHERE created_by_run = $migration
         AND source_location NOT IN $committedLocations
         AND count((SELECT VALUE id FROM dialogue_revision WHERE source_revision = $parent.id)) = 0;
       DELETE source_location WHERE created_by_run = $migration AND id NOT IN $committedLocations
         AND count((SELECT VALUE id FROM source_revision WHERE source_location = $parent.id)) = 0;
       DELETE source_root WHERE created_by_run = $migration AND enabled = false
         AND count((SELECT VALUE id FROM source_location WHERE source_root = $parent.id)) = 0;
       LET $committedWorkspaces = (SELECT VALUE target FROM migration_row_commit
         WHERE migration = $migration AND legacy_table = "projects"
           AND category IN ["matched", "inserted"]);
       DELETE workspace_location WHERE created_by_run = $migration
         AND workspace NOT IN $committedWorkspaces
         AND count((SELECT VALUE id FROM dialogue WHERE workspace = $parent.workspace)) = 0;
       DELETE workspace WHERE created_by_run = $migration AND id NOT IN $committedWorkspaces
         AND count((SELECT VALUE id FROM dialogue WHERE workspace = $parent.id)) = 0
         AND count((SELECT VALUE id FROM workspace_location WHERE workspace = $parent.id)) = 0;
       DELETE model WHERE created_by_run = $migration
         AND count((SELECT VALUE id FROM message WHERE model = $parent.id)) = 0;
       DELETE vendor WHERE created_by_run = $migration
         AND count((SELECT VALUE id FROM model WHERE vendor = $parent.id)) = 0;
       COMMIT;
       RETURN true;`,
      { migration },
    );
    if (result.at(-1) !== true) throw new Error("stale migration cleanup transaction failed");
  }

  private async downgradeLifecycleIntegrity(
    run: MigrationRunHandle,
    report: MigrationRunReport | undefined,
    reason: string,
  ): Promise<void> {
    const failure = `migration_report_integrity:${reason}`.slice(0, 4000);
    const failedCounters = report ? clean({
      ...report,
      status: "failed",
      assignmentCoverageOk: false,
      error: failure,
    }) : undefined;
    const result = await this.db.query<unknown[]>(
      `BEGIN;
       UPDATE $sync SET status = "failed", finished_at = $now,
         counters = $counters, error_summary = $failure;
       UPDATE $migration SET status = "failed", finished_at = $now,
         counters = $counters, notes = $failure,
         report_sha256 = NONE, report_size_bytes = NONE;
       COMMIT;
       RETURN true;`,
      {
        sync: run.syncRunId,
        migration: run.migrationId,
        now: new Date(),
        counters: failedCounters,
        failure,
      },
    );
    if (result.at(-1) !== true) throw new Error("migration lifecycle integrity downgrade failed");
    await this.cleanupUncommittedMigrationEffects(run.migrationId, run.syncRunId);
  }

  /**
   * Startup recovery authenticates the published report against durable run
   * metadata. A report published before finishRun crashed is authoritative;
   * completed metadata with a missing/tampered report is downgraded.
   */
  async reconcileMigrationLifecycle(): Promise<void> {
    const [rows] = await this.db.query<[MigrationLifecycleRow[]]>(
      `SELECT id, status, sync_run, legacy_db_sha256,
         approval_artifact_sha256, approval_file_sha256,
         approval_attestation_sha256, approval_key_fingerprint,
         host_mapping_artifact_sha256,
         backup_artifact_sha256, restore_artifact_sha256,
         report_path, report_sha256, report_size_bytes
       FROM migration_meta
       WHERE status IN ["running", "failed", "completed", "completed_with_errors"]`,
    );
    for (const row of rows ?? []) {
      let authenticated: Awaited<ReturnType<typeof authenticatePublishedMigrationReport>> | undefined;
      let failure = "recovered_missing_or_invalid_report";
      const binding = {
        migrationId: row.id,
        syncRunId: row.sync_run,
        snapshotSha256: row.legacy_db_sha256,
        approvalArtifactSha256: row.approval_artifact_sha256,
        approvalFileSha256: row.approval_file_sha256,
        approvalAttestationSha256: row.approval_attestation_sha256,
        approvalKeyFingerprint: row.approval_key_fingerprint,
        hostMappingArtifactSha256: row.host_mapping_artifact_sha256,
        backupArtifactSha256: row.backup_artifact_sha256,
        restoreArtifactSha256: row.restore_artifact_sha256,
      };
      if (row.report_path) {
        try {
          authenticated = await authenticatePublishedMigrationReport(
            row.report_path,
            row.report_sha256,
            row.report_size_bytes,
            binding,
          );
        } catch (error) {
          failure = `recovered_invalid_report:${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const status = authenticated?.report.status ?? "failed";
      const reportSha = authenticated?.sha256;
      const reportSize = authenticated?.sizeBytes;
      const counters = authenticated ? clean(authenticated.report) : undefined;
      const notes = authenticated?.report.error ?? (authenticated ? undefined : failure.slice(0, 4000));
      if (!authenticated || authenticated.report.status === "failed") {
        await this.cleanupUncommittedMigrationEffects(row.id, row.sync_run);
      }
      const result = await this.db.query<unknown[]>(
        `BEGIN;
         UPDATE $sync SET status = $status, finished_at = $now,
           counters = $counters, error_summary = $notes;
         UPDATE $migration SET status = $status, finished_at = $now,
           counters = $counters, notes = $notes, report_sha256 = $reportSha,
           report_size_bytes = $reportSize;
         COMMIT;
         RETURN true;`,
        {
          sync: row.sync_run,
          migration: row.id,
          status,
          now: new Date(),
          counters,
          notes,
          reportSha,
          reportSize,
        },
      );
      if (result.at(-1) !== true) throw new Error("migration lifecycle recovery transaction failed");
      if (authenticated && authenticated.report.status !== "failed" && row.report_path) {
        try {
          const finalAuthentication = await authenticatePublishedMigrationReport(
            row.report_path,
            authenticated.sha256,
            authenticated.sizeBytes,
            binding,
          );
          assertSamePublishedReportIdentity(authenticated, finalAuthentication);
        } catch (error) {
          await this.downgradeLifecycleIntegrity(
            { migrationId: row.id, syncRunId: row.sync_run },
            authenticated.report,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  async startRun(input: MigrationRunInput): Promise<MigrationRunHandle> {
    await this.reconcileMigrationLifecycle();
    const hostId = await ensureHost(this.db, {
      hostUuid: this.identity.hostUuid,
      hostname: this.identity.hostname,
      platform: this.identity.platform,
      arch: this.identity.arch,
    });
    await ensureOsAccount(this.db, {
      host: hostId,
      osUsername: this.identity.osUsername,
      homePath: this.identity.homePath,
    });
    const syncRunId = new RecordId("sync_run", `migration_${crypto.randomUUID()}`);
    const migrationId = new RecordId("migration_meta", `migration_${crypto.randomUUID()}`);
    const now = new Date();
    const result = await this.db.query<unknown[]>(
      `BEGIN;
       CREATE ONLY $sync SET kind = "migration", status = "running", started_at = $now,
         host = $host, baka_commit = $commit, schema_version = $schema,
         configuration_fingerprint = $snapshotSha;
       CREATE ONLY $migration SET status = "running", started_at = $now,
         legacy_db_path = $path, legacy_db_sha256 = $snapshotSha, sync_run = $sync,
         approval_artifact_sha256 = $approvalSha,
         approval_file_sha256 = $approvalFileSha,
         approval_attestation_sha256 = $attestationSha,
         approval_key_fingerprint = $approvalKeyFingerprint,
         host_mapping_artifact_sha256 = $mappingSha,
         host_mapping_assignments_json = $assignments,
         backup_artifact_path = $backupPath, backup_artifact_sha256 = $backupSha,
         backup_manifest_path = $manifestPath, backup_manifest_sha256 = $manifestSha,
         raw_manifest_sha256 = $rawManifestSha,
         restore_artifact_path = $restorePath, restore_artifact_sha256 = $restoreSha,
         restore_namespace = $restoreNamespace, report_path = $reportPath;
       COMMIT;
       RETURN true;`,
      {
        now,
        sync: syncRunId,
        migration: migrationId,
        host: hostId,
        commit: input.bakaCommit,
        schema: input.schemaVersion,
        snapshotSha: input.legacyDbSha256,
        path: input.legacyDbPath,
        approvalSha: input.approvalArtifactSha256,
        approvalFileSha: input.approvalFileSha256,
        attestationSha: input.approvalAttestationSha256,
        approvalKeyFingerprint: input.approvalKeyFingerprint,
        mappingSha: input.hostMappingArtifactSha256,
        assignments: input.hostMappingAssignmentsJson,
        backupPath: input.backupArtifactPath,
        backupSha: input.backupArtifactSha256,
        restorePath: input.restoreArtifactPath,
        restoreSha: input.restoreArtifactSha256,
        manifestPath: input.backupManifestPath,
        manifestSha: input.backupManifestSha256,
        rawManifestSha: input.rawManifestSha256,
        restoreNamespace: input.restoreNamespace,
        reportPath: input.reportPath,
      },
    );
    if (result.at(-1) !== true) throw new Error("migration lifecycle start transaction failed");
    this.currentRun = { syncRunId, migrationId };
    return this.currentRun;
  }

  async finishRun(
    run: MigrationRunHandle,
    status: "completed" | "completed_with_errors" | "failed",
    report: MigrationRunReport,
    error?: string,
    publication?: MigrationReportPublication,
  ): Promise<void> {
    try {
      await this.finishRunLifecycle(run, status, report, error, publication);
    } finally {
      // Parse-view временный; immutable raw остаётся единственным durable
      // источником независимо от результата lifecycle commit.
      await this.cleanupKimiRecoveryViews();
    }
  }

  private async finishRunLifecycle(
    run: MigrationRunHandle,
    status: "completed" | "completed_with_errors" | "failed",
    report: MigrationRunReport,
    error?: string,
    publication?: MigrationReportPublication,
  ): Promise<void> {
    if (status !== "failed" && !publication) {
      throw new Error("completed migration cannot be persisted without durable report publication");
    }
    const binding = {
      migrationId: run.migrationId,
      syncRunId: run.syncRunId,
      snapshotSha256: report.snapshotSha256,
      approvalArtifactSha256: report.approvalArtifactSha256,
      approvalFileSha256: report.approvalFileSha256,
      approvalAttestationSha256: report.approvalAttestationSha256,
      approvalKeyFingerprint: report.approvalKeyFingerprint,
      hostMappingArtifactSha256: report.hostMappingArtifactSha256,
      backupArtifactSha256: report.backupArtifactSha256,
      restoreArtifactSha256: report.restoreArtifactSha256,
    };
    let initialAuthentication: AuthenticatedMigrationReport | undefined;
    if (publication) {
      initialAuthentication = await authenticatePublishedMigrationReport(
        publication.path,
        publication.sha256,
        publication.sizeBytes,
        binding,
      );
      if (initialAuthentication.report.status !== status) {
        throw new Error("migration report/lifecycle status mismatch");
      }
      if (canonicalReportJson(initialAuthentication.report) !== canonicalReportJson(report)) {
        throw new Error("migration report object differs from lifecycle commit object");
      }
    }
    if (status === "failed") {
      await this.cleanupUncommittedMigrationEffects(run.migrationId, run.syncRunId);
    }
    let preCommitHookError: unknown;
    try {
      await this.faultHooks.beforeLifecycleFinishCommit?.(run, publication);
    } catch (caught) {
      preCommitHookError = caught;
    }
    let finalAuthentication: AuthenticatedMigrationReport | undefined;
    if (publication && initialAuthentication) {
      try {
        finalAuthentication = await authenticatePublishedMigrationReport(
          publication.path,
          publication.sha256,
          publication.sizeBytes,
          binding,
        );
        assertSamePublishedReportIdentity(initialAuthentication, finalAuthentication);
        if (
          finalAuthentication.report.status !== status ||
          canonicalReportJson(finalAuthentication.report) !== canonicalReportJson(report)
        ) throw new Error("migration report changed before lifecycle commit");
      } catch (authenticationError) {
        await this.downgradeLifecycleIntegrity(
          run,
          report,
          authenticationError instanceof Error ? authenticationError.message : String(authenticationError),
        );
        throw authenticationError;
      }
    }
    if (preCommitHookError) throw preCommitHookError;

    const persistLifecycle = async (): Promise<void> => {
      const authoritativeReport = finalAuthentication?.report ?? report;
      const result = await this.db.query<unknown[]>(
        `BEGIN;
         UPDATE $sync SET status = $status, finished_at = $now,
           counters = $counters, error_summary = $notes;
         UPDATE $migration SET status = $status, finished_at = $now, counters = $counters,
           notes = $notes, report_path = $reportPath, report_sha256 = $reportSha,
           report_size_bytes = $reportSize;
         COMMIT;
         RETURN true;`,
        {
          sync: run.syncRunId,
          migration: run.migrationId,
          status,
          now: new Date(),
          counters: clean(authoritativeReport),
          notes: error?.slice(0, 4000) ?? undefined,
          reportPath: publication?.path,
          reportSha: finalAuthentication?.sha256,
          reportSize: finalAuthentication?.sizeBytes,
        },
      );
      if (result.at(-1) !== true) throw new Error("migration lifecycle finish transaction failed");
    };

    let commitError: unknown;
    try {
      await persistLifecycle();
    } catch (caught) {
      commitError = caught;
    }
    try {
      await this.faultHooks.afterLifecycleCommitBeforeFinalAuthentication?.(run, publication);
    } catch (caught) {
      commitError ??= caught;
    }
    if (publication && finalAuthentication) {
      try {
        const postCommitAuthentication = await authenticatePublishedMigrationReport(
          publication.path,
          finalAuthentication.sha256,
          finalAuthentication.sizeBytes,
          binding,
        );
        assertSamePublishedReportIdentity(finalAuthentication, postCommitAuthentication);
      } catch (authenticationError) {
        await this.downgradeLifecycleIntegrity(
          run,
          finalAuthentication.report,
          authenticationError instanceof Error ? authenticationError.message : String(authenticationError),
        );
        throw authenticationError;
      }
    }
    if (commitError) throw commitError;
  }

  async lookupIdentity(table: LegacyTable, legacyId: string): Promise<RecordId | undefined> {
    return (await this.lookupIdentities(table, [legacyId])).get(legacyId);
  }

  async prefetchIdentities(
    requests: LegacyIdentityRequest[],
    run?: MigrationRunHandle,
  ): Promise<LegacyIdentityPrefetch> {
    const requestedKeys = new Set<string>();
    for (const request of requests) {
      if (!LEGACY_TABLES.includes(request.table) || request.legacyId.length === 0) {
        throw new Error("legacy identity prefetch request is malformed");
      }
      const key = legacyIdentityPrefetchKey(request.table, request.legacyId);
      if (requestedKeys.has(key)) {
        throw new Error(`legacy identity prefetch request is duplicate: ${request.table}:${request.legacyId}`);
      }
      requestedKeys.add(key);
    }
    const existing = new Map<string, PrefetchedLegacyIdentity>();
    const unresolvedQuarantines = new Map<string, RecordId[]>();
    for (let offset = 0; offset < requests.length; offset += LEGACY_IDENTITY_PREFETCH_BATCH_SIZE) {
      const batch = requests.slice(offset, offset + LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
      const mappingIds: RecordId[] = [];
      const requestByMapping = new Map<string, LegacyIdentityRequest>();
      for (const request of batch) {
        const mapping = new RecordId(
          "legacy_identity_map",
          deterministicId("lmap", `${request.table}:${request.legacyId}`),
        );
        mappingIds.push(mapping);
        requestByMapping.set(String(mapping), request);
      }
      const vars: Record<string, unknown> = {
        mappingIds,
        ...(run ? {
          migration: run.migrationId,
          lineages: batch.map((request) => `${request.table}:${request.legacyId}`),
        } : {}),
      };
      const result = await this.db.query<unknown[]>(
        `SELECT id, legacy_table, legacy_id, target FROM $mappingIds;
         ${run ? `SELECT id, legacy_table, legacy_id FROM migration_quarantine
           WHERE lineage_key IN $lineages AND migration != $migration
             AND resolved_at IS NONE;` : ""}`,
        vars,
      );
      const rows = result[0];
      if (!Array.isArray(rows) || rows.length > batch.length) {
        throw new Error("legacy identity prefetch result has invalid cardinality");
      }
      for (const value of rows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("legacy identity prefetch result row is malformed");
        }
        const row = value as Record<string, unknown>;
        if (typeof row.legacy_table !== "string" ||
            !LEGACY_TABLES.includes(row.legacy_table as LegacyTable) ||
            typeof row.legacy_id !== "string" ||
            !(row.id instanceof RecordId) ||
            !(row.target instanceof RecordId) ||
            !String(row.id).startsWith("legacy_identity_map:")) {
          throw new Error("legacy identity prefetch result row has invalid fields");
        }
        const key = legacyIdentityPrefetchKey(
          row.legacy_table as LegacyTable,
          row.legacy_id,
        );
        const directRequest = requestByMapping.get(String(row.id));
        if (!directRequest ||
            directRequest.table !== row.legacy_table ||
            directRequest.legacyId !== row.legacy_id ||
            !requestedKeys.has(key)) {
          throw new Error(
            `legacy identity prefetch returned an unrequested or mismatched row: ` +
            `${row.legacy_table}:${row.legacy_id}`,
          );
        }
        if (existing.has(key)) {
          throw new Error(
            `legacy identity prefetch returned duplicate ownership: ` +
            `${row.legacy_table}:${row.legacy_id}`,
          );
        }
        existing.set(key, { mapping: row.id, target: row.target });
      }
      const quarantineRows = run ? result[1] : [];
      if (!Array.isArray(quarantineRows)) {
        throw new Error("legacy quarantine prefetch result has invalid cardinality");
      }
      for (const value of quarantineRows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("legacy quarantine prefetch result row is malformed");
        }
        const row = value as Record<string, unknown>;
        if (!(row.id instanceof RecordId) ||
            !String(row.id).startsWith("migration_quarantine:") ||
            typeof row.legacy_table !== "string" ||
            !LEGACY_TABLES.includes(row.legacy_table as LegacyTable) ||
            typeof row.legacy_id !== "string") {
          throw new Error("legacy quarantine prefetch result row has invalid fields");
        }
        const key = legacyIdentityPrefetchKey(
          row.legacy_table as LegacyTable,
          row.legacy_id,
        );
        if (!requestedKeys.has(key)) {
          throw new Error("legacy quarantine prefetch returned an unrequested row");
        }
        const ids = unresolvedQuarantines.get(key) ?? [];
        if (ids.some((id) => String(id) === String(row.id))) {
          throw new Error("legacy quarantine prefetch returned a duplicate row");
        }
        ids.push(row.id);
        unresolvedQuarantines.set(key, ids);
      }
    }
    return { requestedKeys, existing, unresolvedQuarantines };
  }

  async lookupIdentities(
    table: LegacyTable,
    legacyIds: string[],
  ): Promise<Map<string, RecordId>> {
    if (legacyIds.length === 0) return new Map();
    const uniqueIds = [...new Set(legacyIds)];
    const prefetched = await this.prefetchIdentities(
      uniqueIds.map((legacyId) => ({ table, legacyId })),
    );
    return new Map(uniqueIds.flatMap((legacyId) => {
      const found = prefetchedLegacyIdentity(prefetched, table, legacyId);
      return found ? [[legacyId, found.target] as const] : [];
    }));
  }

  async bindIdentity(table: LegacyTable, legacyId: string, target: RecordId): Promise<void> {
    await this.bindIdentities(table, [{ legacyId, target }]);
  }

  async bindIdentities(
    table: LegacyTable,
    rows: Array<{ legacyId: string; target: RecordId }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      await this.faultHooks.beforeIdentityBind?.(table, row.legacyId, row.target);
    }
    const existing = await this.lookupIdentities(table, rows.map((row) => row.legacyId));
    for (const row of rows) {
      const target = existing.get(row.legacyId);
      if (target && String(target) !== String(row.target)) {
        throw new Error(
          `legacy identity conflict ${table}:${row.legacyId}: ${String(target)} != ${String(row.target)}`,
        );
      }
    }
    const missing = rows.filter((row) => !existing.has(row.legacyId));
    for (let offset = 0; offset < missing.length; offset += 500) {
      const chunk = missing.slice(offset, offset + 500);
      const vars: Record<string, unknown> = { table, now: new Date() };
      const statements = ["BEGIN;"];
      for (const [index, row] of chunk.entries()) {
        const id = new RecordId(
          "legacy_identity_map",
          deterministicId("lmap", `${table}:${row.legacyId}`),
        );
        vars[`id${index}`] = id;
        vars[`legacyId${index}`] = row.legacyId;
        vars[`target${index}`] = row.target;
        statements.push(
          `CREATE ONLY $id${index} SET legacy_table = $table, legacy_id = $legacyId${index}, ` +
          `target = $target${index}, created_at = $now;`,
        );
      }
      statements.push("COMMIT;");
      statements.push("RETURN true;");
      const result = await this.db.query<unknown[]>(statements.join("\n"), vars);
      if (result.at(-1) !== true) {
        throw new Error(
          `legacy identity mapping transaction оборвалась: ` +
          `получено ${result.length} результатов из ${statements.length} statements`,
        );
      }
    }
  }

  async commitIdentity(
    run: MigrationRunHandle,
    table: LegacyTable,
    legacyId: string,
    target: RecordId,
    category: MigrationCategory,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<void> {
    const identityPrefetch = prefetched ?? await this.prefetchIdentities(
      [{ table, legacyId }],
      run,
    );
    await this.commitIdentityBatch(run, [{ table, legacyId, target, category }], undefined, identityPrefetch);
  }

  async commitIdentityBatch(
    run: MigrationRunHandle,
    rows: MigrationIdentityCommit[],
    revisionToMark?: RevisionTarget,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<void> {
    if (rows.length === 0 && !revisionToMark) return;
    const preparedRows = await Promise.all(
      rows.map((row) => this.prepareRowCommit(run, row, prefetched)),
    );
    if (revisionToMark) await this.faultHooks.beforeMarkRevisionParsed?.(revisionToMark);
    const vars: Record<string, unknown> = {
      migration: run.migrationId,
      now: new Date(),
    };
    const sql = ["BEGIN;"];
    this.appendRowCommitBatchSql(sql, vars, rows, preparedRows, prefetched);
    if (revisionToMark) {
      vars.revision = revisionToMark.revisionId;
      sql.push(
        `LET $dialogueCount = count((SELECT VALUE id FROM dialogue_revision ` +
        `WHERE source_revision = $revision AND status = "ready"));`,
        `UPDATE $revision SET parse_status = "parsed", dialogues_discovered = $dialogueCount;`,
        `UPDATE source_location SET last_successful_revision = $revision ` +
        `WHERE current_revision = $revision;`,
      );
    }
    sql.push("COMMIT;", "RETURN true;");
    const result = await this.db.query<unknown[]>(sql.join("\n"), vars);
    if (result.at(-1) !== true) throw new Error("legacy batch ownership transaction failed");
  }

  async completeIdentity(
    table: LegacyTable,
    legacyId: string,
    target: RecordId,
    run?: MigrationRunHandle,
    category?: MigrationCategory,
  ): Promise<void> {
    if (run && category) {
      await this.commitIdentity(run, table, legacyId, target, category);
      return;
    }
    const prefetched = await this.prefetchIdentities(
      [{ table, legacyId }],
      this.currentRun,
    );
    const mapped = prefetchedLegacyIdentity(prefetched, table, legacyId);
    if (!mapped || String(mapped.target) !== String(target)) {
      throw new Error(`legacy identity ${table}:${legacyId} не закреплена за ${String(target)}`);
    }
    await this.resolvePreviousQuarantine(table, legacyId, target, prefetched);
  }

  async rollbackImportAttempt(table: LegacyTable, result: EnsureTarget<unknown>): Promise<void> {
    void table;
    void result;
    if (!this.currentRun) return;
    await this.cleanupUncommittedMigrationEffects(
      this.currentRun.migrationId,
      this.currentRun.syncRunId,
    );
  }

  private async resolvePreviousQuarantine(
    table: LegacyTable,
    legacyId: string,
    target: RecordId,
    prefetched: LegacyIdentityPrefetch,
  ): Promise<void> {
    if (!this.currentRun) return;
    const ids = prefetched.unresolvedQuarantines.get(
      legacyIdentityPrefetchKey(table, legacyId),
    ) ?? [];
    for (let offset = 0; offset < ids.length; offset += LEGACY_IDENTITY_PREFETCH_BATCH_SIZE) {
      const result = await this.db.query<unknown[]>(
        `BEGIN;
         UPDATE $ids SET resolved_at = $now, resolution = $resolution;
         COMMIT;
         RETURN true;`,
        {
          ids: ids.slice(offset, offset + LEGACY_IDENTITY_PREFETCH_BATCH_SIZE),
          now: new Date(),
          resolution: `retry_mapped:${String(target)}`,
        },
      );
      if (result.at(-1) !== true) throw new Error("legacy quarantine resolution failed");
    }
  }

  async quarantine(run: MigrationRunHandle, input: QuarantineInput): Promise<void> {
    const lineageKey = `${input.table}:${String(input.row.id)}`;
    const key = deterministicId(
      "mq",
      `${recordKey(run.migrationId)}:${input.table}:${String(input.row.id)}`,
    );
    const id = new RecordId("migration_quarantine", key);
    const existing = await selectOne<{ id: RecordId; attempts: number }>(
      this.db,
      "SELECT id, attempts FROM ONLY $id",
      { id },
    );
    if (existing) {
      const result = await this.db.query<unknown[]>(
        `BEGIN;
         UPDATE $id SET raw_payload = $payload, reason = $reason,
         parser_name = $parser, parser_version = $version, retryable = $retryable,
         attempts = $attempts, last_failed_at = $now, resolved_at = NONE, resolution = NONE;
         COMMIT;
         RETURN true;`,
        {
          id,
          payload: clean({ row: input.rawPayload }),
          reason: input.reason.slice(0, 4000),
          parser: input.parserName ?? LEGACY_MIGRATION_ADAPTER_NAME,
          version: String(input.parserVersion ?? LEGACY_MIGRATION_ADAPTER_VERSION),
          retryable: input.retryable,
          attempts: existing.attempts + 1,
          now: new Date(),
        },
      );
      if (result.at(-1) !== true) throw new Error("migration quarantine retry transaction failed");
      return;
    }
    const previous = await selectOne<{
      id: RecordId;
      attempts: number;
      first_failed_at: Date;
      last_failed_at: Date;
    }>(
      this.db,
      `SELECT id, attempts, first_failed_at, last_failed_at FROM migration_quarantine
       WHERE lineage_key = $lineage AND migration != $migration
       ORDER BY last_failed_at DESC LIMIT 1`,
      { lineage: lineageKey, migration: run.migrationId },
    );
    const now = new Date();
    const ledger = new RecordId(
      "migration_row_commit",
      deterministicId(
        "mrc",
        `${recordKey(run.migrationId)}:${input.table}:${String(input.row.id)}`,
      ),
    );
    const result = await this.db.query<unknown[]>(
      `BEGIN;
       CREATE ONLY $id SET migration = $migration, legacy_table = $table, legacy_id = $legacyId,
         raw_payload = $payload, reason = $reason, parser_name = $parser,
         parser_version = $version, retryable = $retryable, attempts = $attempts,
         lineage_key = $lineage, previous_attempt = $previous,
         first_failed_at = $first, last_failed_at = $now;
       CREATE ONLY $ledger SET migration = $migration, legacy_table = $table,
         legacy_id = $legacyId, category = "quarantined", target = $id,
         committed_at = $now;
       COMMIT;
       RETURN true;`,
      {
        id,
        ledger,
        migration: run.migrationId,
        table: input.table,
        legacyId: String(input.row.id),
        payload: clean({ row: input.rawPayload }),
        reason: input.reason.slice(0, 4000),
        parser: input.parserName ?? LEGACY_MIGRATION_ADAPTER_NAME,
        version: String(input.parserVersion ?? LEGACY_MIGRATION_ADAPTER_VERSION),
        retryable: input.retryable,
        attempts: (previous?.attempts ?? 0) + 1,
        lineage: lineageKey,
        previous: previous?.id ?? undefined,
        first: previous?.first_failed_at ?? now,
        now,
      },
    );
    if (result.at(-1) !== true) throw new Error("migration quarantine transaction failed");
  }

  async ensureAgent(
    row: LegacyAgentRow,
    authoritativeTarget?: RecordId,
  ): Promise<EnsureTarget<AgentTarget>> {
    if (!(row.slug in HARNESS_TOOLS)) throw new Error(`неизвестный legacy harness: ${row.slug}`);
    const existing = await selectOne<{ id: RecordId }>(
      this.db,
      "SELECT id FROM harness WHERE slug = $slug LIMIT 1",
      { slug: row.slug },
    );
    if (authoritativeTarget) {
      if (!existing) {
        throw new Error(`legacy identity agent_systems:${row.id} points to missing harness`);
      }
      assertAuthoritativeTarget("agent_systems", row.id, authoritativeTarget, existing.id);
    }
    const harnessId = await ensureHarness(this.db, {
      slug: row.slug,
      displayName: stringColumn(row, "display_name") ?? row.slug,
      kind: stringColumn(row, "kind") ?? "legacy",
    });
    return {
      target: harnessId,
      created: existing === undefined,
      value: { harnessId, slug: row.slug as HarnessSlug },
    };
  }

  private approvedMapping(
    table: LegacyHostAttributionIssue["legacyTable"],
    legacyId: string | number,
    sourcePath?: string,
  ): ApprovedLegacyHostMapping {
    try {
      const key = `${table}:${String(legacyId)}`;
      const assignment = this.approvedAssignmentByRow.get(key);
      if (!assignment) {
        throw new Error(`${key} has no exact approved runtime assignment`);
      }
      const mapping = this.approvedHostMappings.find(
        (candidate) => candidate.mappingId === assignment.mappingId,
      );
      if (!mapping) throw new Error(`${key} references unknown approved mapping ${assignment.mappingId}`);
      return mapping;
    } catch (error) {
      this.attributionIssues.push({
        legacyTable: table,
        legacyId: String(legacyId),
        ...(sourcePath ? { path: sourcePath } : {}),
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async hostForMapping(mapping: ApprovedLegacyHostMapping): Promise<HostContext> {
    const cached = this.hostCache.get(mapping.mappingId);
    if (cached) return cached;
    const hostId = await ensureHost(this.db, {
      hostUuid: mapping.host.hostUuid,
      hostname: mapping.host.hostname,
      platform: mapping.host.platform,
      arch: mapping.host.arch,
      label: `Legacy import (${mapping.mappingId})`,
    });
    const osAccountId = await ensureOsAccount(this.db, {
      host: hostId,
      osUsername: mapping.host.osUsername,
      homePath: mapping.host.homePath,
    });
    const context = { hostId, osAccountId, mappingId: mapping.mappingId };
    this.hostCache.set(mapping.mappingId, context);
    return context;
  }

  private assignmentForCommit(
    table: LegacyTable,
    legacyId: string,
  ): LegacyHostAssignment | undefined {
    if (!(["projects", "source_files", "threads"] as string[]).includes(table)) return undefined;
    const key = `${table}:${legacyId}`;
    const assignment = this.approvedAssignmentByRow.get(key);
    if (!assignment) throw new Error(`${key} has no exact approved runtime assignment`);
    return { ...assignment };
  }

  async hostAttributionReport(run = this.currentRun): Promise<LegacyHostAttributionReport> {
    if (!run) {
      return {
        approvedMappings: this.approvedHostMappings.map((mapping) => ({
          mappingId: mapping.mappingId,
          hostUuid: mapping.host.hostUuid,
          attributedRows: 0,
        })),
        actualAssignments: [],
        uncertainty: [...this.attributionIssues],
      };
    }
    const [rows] = await this.db.query<[
      Array<{
        legacy_table: LegacyTable;
        legacy_id: string;
        host_mapping_id: string;
        host_assignment_json: string;
      }>,
    ]>(
      `SELECT legacy_table, legacy_id, host_mapping_id, host_assignment_json
       FROM migration_row_commit
       WHERE migration = $migration AND category IN ["matched", "inserted"]
         AND host_assignment_json != NONE`,
      { migration: run.migrationId },
    );
    const actualAssignments = (rows ?? []).map((row) => {
      const parsed = JSON.parse(row.host_assignment_json) as LegacyHostAssignment;
      const approved = this.approvedAssignmentByRow.get(`${parsed.table}:${parsed.legacyId}`);
      if (
        !approved || row.legacy_table !== parsed.table || row.legacy_id !== parsed.legacyId ||
        row.host_mapping_id !== parsed.mappingId ||
        canonicalReportJson(parsed) !== canonicalReportJson(approved)
      ) {
        throw new Error(`durable committed host assignment is not exactly approved: ${parsed.table}:${parsed.legacyId}`);
      }
      return parsed;
    }).sort((a, b) => a.table.localeCompare(b.table) || a.legacyId.localeCompare(b.legacyId));
    const counts = new Map<string, number>();
    for (const assignment of actualAssignments) {
      counts.set(assignment.mappingId, (counts.get(assignment.mappingId) ?? 0) + 1);
    }
    return {
      approvedMappings: this.approvedHostMappings.map((mapping) => ({
        mappingId: mapping.mappingId,
        hostUuid: mapping.host.hostUuid,
        attributedRows: counts.get(mapping.mappingId) ?? 0,
      })),
      actualAssignments,
      uncertainty: [...this.attributionIssues],
    };
  }

  async reconciliationForRun(
    run: MigrationRunHandle,
    totals: Record<LegacyTable, number>,
  ): Promise<MigrationReconciliation> {
    const [mappedRows, quarantinedRows] = await Promise.all([
      this.db.query<[Array<{ legacy_table: LegacyTable; category: MigrationCategory; n: number }>]>(
        `SELECT legacy_table, category, count() AS n FROM migration_row_commit
         WHERE migration = $migration AND category IN ["matched", "inserted"]
         GROUP BY legacy_table, category`,
        { migration: run.migrationId },
      ).then(([rows]) => rows ?? []),
      this.db.query<[Array<{ legacy_table: LegacyTable; n: number }>]>(
        `SELECT legacy_table, count() AS n FROM migration_row_commit
         WHERE migration = $migration AND category = "quarantined" GROUP BY legacy_table`,
        { migration: run.migrationId },
      ).then(([rows]) => rows ?? []),
    ]);
    const tables = {} as MigrationReconciliation["tables"];
    let legacyTotal = 0;
    let matched = 0;
    let inserted = 0;
    let quarantined = 0;
    for (const [table, total] of Object.entries(totals) as Array<[LegacyTable, number]>) {
      const tableMatched = mappedRows
        .filter((row) => row.legacy_table === table && row.category === "matched")
        .reduce((sum, row) => sum + row.n, 0);
      const tableInserted = mappedRows
        .filter((row) => row.legacy_table === table && row.category === "inserted")
        .reduce((sum, row) => sum + row.n, 0);
      const tableQuarantined = quarantinedRows
        .filter((row) => row.legacy_table === table)
        .reduce((sum, row) => sum + row.n, 0);
      const accounted = tableMatched + tableInserted + tableQuarantined;
      tables[table] = {
        total,
        matched: tableMatched,
        inserted: tableInserted,
        quarantined: tableQuarantined,
        accounted,
        lost: total - accounted,
      };
      legacyTotal += total;
      matched += tableMatched;
      inserted += tableInserted;
      quarantined += tableQuarantined;
    }
    const accounted = matched + inserted + quarantined;
    const lost = legacyTotal - accounted;
    return {
      legacyTotal,
      matched,
      inserted,
      quarantined,
      accounted,
      lost,
      ok: lost === 0,
      tables,
    };
  }

  private async installation(agent: AgentTarget, hostId: RecordId): Promise<RecordId> {
    const key = `${String(agent.harnessId)}@${String(hostId)}`;
    const cached = this.installationCache.get(key);
    if (cached) return cached;
    const installationId = await ensureHarnessInstallation(this.db, {
      host: hostId,
      harness: agent.harnessId,
      installed: false,
      detectedVersion: "legacy",
    });
    this.installationCache.set(key, installationId);
    return installationId;
  }

  private async prepareRowCommit(
    run: MigrationRunHandle,
    row: MigrationIdentityCommit,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<{
    mapping: RecordId;
    ledger: RecordId;
    existing: boolean;
    assignment?: LegacyHostAssignment;
  }> {
    await this.faultHooks.beforeIdentityBind?.(row.table, row.legacyId, row.target);
    const directMapping = new RecordId(
      "legacy_identity_map",
      deterministicId("lmap", `${row.table}:${row.legacyId}`),
    );
    const cached = prefetched
      ? prefetchedLegacyIdentity(prefetched, row.table, row.legacyId)
      : undefined;
    const queried = prefetched ? undefined : await selectOne<{
      id: RecordId;
      legacy_table: string;
      legacy_id: string;
      target: RecordId;
    }>(
      this.db,
      `SELECT id, legacy_table, legacy_id, target FROM ONLY $id`,
      { id: directMapping },
    );
    if (cached && !cached.mapping) {
      throw new Error("legacy identity prefetch omitted mapping record id");
    }
    const existing = cached
      ? { id: cached.mapping!, target: cached.target }
      : queried;
    if (queried && (queried.legacy_table !== row.table || queried.legacy_id !== row.legacyId)) {
      throw new Error(`legacy identity direct mapping metadata mismatch`);
    }
    if (existing && String(existing.target) !== String(row.target)) {
      throw new Error(
        `legacy identity conflict ${row.table}:${row.legacyId}: ` +
        `${String(existing.target)} != ${String(row.target)}`,
      );
    }
    return {
      mapping: existing?.id ?? directMapping,
      ledger: new RecordId(
        "migration_row_commit",
        deterministicId(
          "mrc",
          `${recordKey(run.migrationId)}:${row.table}:${row.legacyId}`,
        ),
      ),
      existing: existing !== undefined,
      assignment: this.assignmentForCommit(row.table, row.legacyId),
    };
  }

  private appendRowCommitBatchSql(
    sql: string[],
    vars: Record<string, unknown>,
    rows: MigrationIdentityCommit[],
    preparedRows: Array<Awaited<ReturnType<SurrealLegacyMigrationBackend["prepareRowCommit"]>>>,
    prefetched?: LegacyIdentityPrefetch,
  ): void {
    if (rows.length !== preparedRows.length) {
      throw new Error("legacy row batch preparation cardinality mismatch");
    }
    for (let offset = 0; offset < rows.length; offset += LEGACY_IDENTITY_PREFETCH_BATCH_SIZE) {
      const batchNo = Math.floor(offset / LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
      const batch = rows.slice(offset, offset + LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
      const prepared = preparedRows.slice(offset, offset + LEGACY_IDENTITY_PREFETCH_BATCH_SIZE);
      const mappingRows = batch.flatMap((row, index) => {
        const item = prepared[index]!;
        return item.existing ? [] : [{
          id: item.mapping,
          legacy_table: row.table,
          legacy_id: row.legacyId,
          target: row.target,
          created_at: vars.now,
        }];
      });
      const existingChecks = batch.flatMap((row, index) => {
        const item = prepared[index]!;
        return item.existing ? [{
          id: item.mapping,
          legacy_table: row.table,
          legacy_id: row.legacyId,
          target: row.target,
        }] : [];
      });
      const ledgerRows = batch.map((row, index) => {
        const item = prepared[index]!;
        return {
          id: item.ledger,
          migration: vars.migration,
          legacy_table: row.table,
          legacy_id: row.legacyId,
          category: row.category,
          target: row.target,
          ...(item.assignment ? {
            host_mapping_id: item.assignment.mappingId,
            host_assignment_json: JSON.stringify(item.assignment),
          } : {}),
          ...(row.previousState ? { previous_state: clean(row.previousState) } : {}),
          ...(row.writtenState ? { written_state: clean(row.writtenState) } : {}),
          committed_at: vars.now,
        };
      });
      vars[`targetChecks${batchNo}`] = batch.map((row) => row.target);
      sql.push(
        `IF !$targetChecks${batchNo}.all(|$target| record::exists($target)) { ` +
        `THROW "legacy identity target missing during atomic commit" };`,
      );
      if (existingChecks.length > 0) {
        vars[`existingChecks${batchNo}`] = existingChecks;
        sql.push(
          `IF !$existingChecks${batchNo}.all(|$item| ` +
          `$item.id.legacy_table = $item.legacy_table AND ` +
          `$item.id.legacy_id = $item.legacy_id AND ` +
          `$item.id.target = $item.target) { ` +
          `THROW "legacy identity mapping changed during atomic commit" };`,
        );
      }
      if (mappingRows.length > 0) {
        vars[`mappingRows${batchNo}`] = mappingRows;
        sql.push(
          `IF $mappingRows${batchNo}.any(|$item| record::exists($item.id)) { ` +
          `THROW "legacy identity mapping appeared during atomic commit" };`,
        );
        sql.push(`INSERT INTO legacy_identity_map $mappingRows${batchNo} RETURN NONE;`);
      }
      vars[`ledgerRows${batchNo}`] = ledgerRows;
      sql.push(`INSERT INTO migration_row_commit $ledgerRows${batchNo} RETURN NONE;`);

      if (prefetched) {
        const quarantineUpdates = batch.flatMap((row) => {
          const key = legacyIdentityPrefetchKey(row.table, row.legacyId);
          return (prefetched.unresolvedQuarantines.get(key) ?? []).map((id) => ({
            id,
            resolution: `retry_mapped:${String(row.target)}`,
          }));
        });
        for (let quarantineOffset = 0;
          quarantineOffset < quarantineUpdates.length;
          quarantineOffset += LEGACY_IDENTITY_PREFETCH_BATCH_SIZE) {
          const quarantineBatchNo = Math.floor(
            quarantineOffset / LEGACY_IDENTITY_PREFETCH_BATCH_SIZE,
          );
          const variable = `quarantineUpdates${batchNo}_${quarantineBatchNo}`;
          vars[variable] = quarantineUpdates.slice(
            quarantineOffset,
            quarantineOffset + LEGACY_IDENTITY_PREFETCH_BATCH_SIZE,
          );
          sql.push(
            `FOR $item IN $${variable} { ` +
            `UPDATE $item.id SET resolved_at = $now, resolution = $item.resolution; };`,
          );
        }
      }
    }
  }

  async commitProjectRow(
    run: MigrationRunHandle,
    row: LegacyProjectRow,
    agent: AgentTarget,
    authoritativeTarget?: RecordId,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<{ result: EnsureTarget<ProjectTarget>; commit: MigrationIdentityCommit }> {
    const legacyId = String(row.id);
    const identityPrefetch = prefetched ?? await this.prefetchIdentities(
      [{ table: "projects", legacyId }],
      run,
    );
    const prefetchedTarget = prefetchedLegacyIdentity(
      identityPrefetch,
      "projects",
      legacyId,
    )?.target;
    if (authoritativeTarget && prefetchedTarget &&
        String(authoritativeTarget) !== String(prefetchedTarget)) {
      throw new Error(`legacy identity conflict projects:${legacyId}`);
    }
    authoritativeTarget ??= prefetchedTarget;
    const projectPath = stringColumn(row, "path");
    const mapping = this.approvedMapping("projects", row.id, projectPath);
    const host = await this.hostForMapping(mapping);
    const repositoryIdentity = projectPath ? undefined : `legacy:${agent.slug}:project:${row.external_id}`;
    const normalized = projectPath ? normalizedPath(projectPath) : undefined;
    const existing = projectPath
      ? await selectOne<{ workspace: RecordId }>(
          this.db,
          `SELECT workspace FROM workspace_location
           WHERE host = $host AND normalized_path = $path LIMIT 1`,
          { host: host.hostId, path: normalized },
        )
      : await selectOne<{ id: RecordId }>(
          this.db,
          "SELECT id FROM workspace WHERE repository_identity = $repo LIMIT 1",
          { repo: repositoryIdentity },
        );
    const workspaceId = existing
      ? ("workspace" in existing ? existing.workspace : existing.id)
      : new RecordId(
          "workspace",
          deterministicId(
            "ws",
            `legacy-project:${mapping.mappingId}:${repositoryIdentity ?? normalized}`,
          ),
        );
    assertAuthoritativeTarget("projects", row.id, authoritativeTarget, workspaceId);
    const category: MigrationCategory = authoritativeTarget || existing ? "matched" : "inserted";
    const commit: MigrationIdentityCommit = {
      table: "projects",
      legacyId,
      target: workspaceId,
      category,
    };
    const prepared = await this.prepareRowCommit(run, commit, identityPrefetch);
    const vars: Record<string, unknown> = {
      migration: run.migrationId,
      now: new Date(),
      workspace: workspaceId,
      host: host.hostId,
      name: stringColumn(row, "name") ?? row.external_id,
      repo: repositoryIdentity,
      originalPath: projectPath,
      normalized,
    };
    const sql = ["BEGIN;"];
    if (!existing) {
      sql.push(
        `CREATE ONLY $workspace SET name = $name, repository_identity = $repo,
         first_seen_at = $now, last_seen_at = $now, created_by_run = $migration;`,
      );
      if (projectPath && normalized) {
        const location = new RecordId(
          "workspace_location",
          deterministicId("wloc", `${String(host.hostId)}:${normalized}`),
        );
        vars.workspaceLocation = location;
        sql.push(
          `CREATE ONLY $workspaceLocation SET workspace = $workspace, host = $host,
           path = $originalPath, normalized_path = $normalized, git_remote = $repo,
           first_seen_at = $now, last_seen_at = $now, created_by_run = $migration;`,
        );
      }
    }
    this.appendRowCommitBatchSql(sql, vars, [commit], [prepared], identityPrefetch);
    sql.push("COMMIT;", "RETURN true;");
    await this.faultHooks.beforeAtomicRowQuery?.("project", run);
    const result = await this.db.query<unknown[]>(sql.join("\n"), vars);
    if (result.at(-1) !== true) throw new Error("atomic project row commit failed");
    await this.faultHooks.afterAtomicRowQuery?.("project", run);
    return {
      result: {
        target: workspaceId,
        created: !existing,
        value: { workspaceId },
      },
      commit,
    };
  }

  async ensureProject(
    _row: LegacyProjectRow,
    _agent: AgentTarget,
    _authoritativeTarget?: RecordId,
  ): Promise<EnsureTarget<ProjectTarget>> {
    throw new Error("Surreal legacy project writes require commitProjectRow atomic transaction");
  }

  async ensureSourceFile(
    _row: LegacySourceFileRow,
    _agent: AgentTarget,
    _authoritativeTarget?: RecordId,
  ): Promise<EnsureTarget<SourceTarget>> {
    throw new Error("Surreal legacy source writes require commitSourceRows atomic transaction");
  }

  async commitSourceRows(
    run: MigrationRunHandle,
    row: LegacySourceFileRow,
    backups: LegacyRawBackupRow[],
    agent: AgentTarget,
    authoritativeTarget?: RecordId,
    prefetched?: LegacyIdentityPrefetch,
  ): Promise<AtomicSourceCommitResult> {
    const sourceLegacyId = String(row.id);
    const identityPrefetch = prefetched ?? await this.prefetchIdentities([
      { table: "source_files", legacyId: sourceLegacyId },
      ...backups.map((backup) => ({
        table: "raw_backups" as const,
        legacyId: String(backup.id),
      })),
    ], run);
    const prefetchedSourceTarget = prefetchedLegacyIdentity(
      identityPrefetch,
      "source_files",
      sourceLegacyId,
    )?.target;
    if (authoritativeTarget && prefetchedSourceTarget &&
        String(authoritativeTarget) !== String(prefetchedSourceTarget)) {
      throw new Error(`legacy identity conflict source_files:${sourceLegacyId}`);
    }
    authoritativeTarget ??= prefetchedSourceTarget;
    const mapping = this.approvedMapping("source_files", row.id, row.original_path);
    const host = await this.hostForMapping(mapping);
    const installationId = await this.installation(agent, host.hostId);
    const rootPath = stringColumn(row, "root_path") ?? path.dirname(row.original_path);
    const provenancePath =
      `legacy-import://${encodeURIComponent(mapping.mappingId)}/${agent.slug}/${sha256hex(rootPath)}`;
    const parser = HARNESS_TOOLS[agent.slug].parser;
    const sourceRootId = new RecordId(
      "source_root",
      deterministicId("sroot", `${String(installationId)}:${provenancePath}`),
    );
    const existingRoot = await selectOne<{
      id: RecordId;
      harness_installation: RecordId;
      path: string;
      source_kind: string;
      parser_name: string;
      snapshot_strategy: string;
      enabled: boolean;
    }>(this.db, "SELECT * FROM ONLY $id", { id: sourceRootId });
    if (existingRoot && (
      String(existingRoot.harness_installation) !== String(installationId) ||
      existingRoot.path !== provenancePath || existingRoot.source_kind !== "legacy" ||
      existingRoot.parser_name !== parser.parserName ||
      existingRoot.snapshot_strategy !== "legacy_import" || existingRoot.enabled !== false
    )) {
      throw new Error(`legacy source_root collision: ${String(sourceRootId)}`);
    }
    const relativePath = stringColumn(row, "relative_path") ?? path.basename(row.original_path);
    const deterministicLocation = new RecordId(
      "source_location",
      deterministicId("sloc", `${String(sourceRootId)}:${relativePath}`),
    );
    const existingLocation = await selectOne<{
      id: RecordId;
      presence_status: string;
      current_revision?: RecordId;
      last_successful_revision?: RecordId;
      missing_complete_scans: number;
      missing_since_at?: Date;
      deleted_at?: Date;
    }>(
      this.db,
      `SELECT id, presence_status, current_revision, last_successful_revision,
         missing_complete_scans, missing_since_at, deleted_at
       FROM source_location WHERE source_root = $root AND relative_path = $relative LIMIT 1`,
      { root: sourceRootId, relative: relativePath },
    );
    const locationId = existingLocation?.id ?? deterministicLocation;
    assertAuthoritativeTarget("source_files", row.id, authoritativeTarget, locationId);

    type RevisionPlan = {
      row?: LegacyRawBackupRow;
      mapped?: RecordId;
      revision: RevisionTarget;
      exists: boolean;
      existingRawPath?: string;
      sizeBytes: number;
      mtimeMs: number;
      headHash?: string;
      rawArchivePath?: string;
      snapshotKind: string;
      parserName: string;
      parserVersion: number;
      parseStatus: string;
    };
    const plans: RevisionPlan[] = [];
    const rejectedBackups: AtomicSourceCommitResult["rejectedBackups"] = [];
    for (const backup of backups) {
      try {
        const expected = stringColumn(backup, "sha256") ?? row.sha256;
        const snapshot = await snapshotRegularFile(backup.archive_path, {
          archiveRoot: this.archiveRoot,
          harness: agent.slug,
          runId: `migration-${recordKey(run.migrationId)}`,
        });
        if (expected && snapshot.sha256 !== expected) {
          throw new Error(`raw backup hash mismatch: expected ${expected}, got ${snapshot.sha256}`);
        }
        const revisionId = new RecordId(
          "source_revision",
          deterministicId("srev", `${String(locationId)}:${snapshot.sha256}`),
        );
        const mapped = prefetchedLegacyIdentity(
          identityPrefetch,
          "raw_backups",
          String(backup.id),
        )?.target;
        assertAuthoritativeTarget("raw_backups", backup.id, mapped, revisionId);
        const existing = await selectOne<{ id: RecordId; raw_archive_path?: string }>(
          this.db,
          "SELECT id, raw_archive_path FROM ONLY $id",
          { id: revisionId },
        );
        const immutableRawPath = path.join(this.archiveRoot, snapshot.relativeRawPath);
        const kimiView = agent.slug === "kimi-code"
          ? await materializeKimiLegacyRecoveryView({
              archiveRoot: this.archiveRoot,
              immutableRawPath,
              semanticPaths: [relativePath, row.original_path],
            })
          : undefined;
        plans.push({
          row: backup,
          mapped,
          revision: {
            revisionId,
            sha256: snapshot.sha256,
            rawPath: agent.slug === "kimi-code"
              ? this.rememberKimiRecoveryView(kimiView)
              : immutableRawPath,
            created: !existing,
          },
          exists: !!existing,
          existingRawPath: existing?.raw_archive_path,
          sizeBytes: snapshot.sizeBytes,
          mtimeMs: snapshot.mtimeMs,
          headHash: snapshot.headHash,
          rawArchivePath: snapshot.relativeRawPath,
          snapshotKind: "legacy_raw",
          parserName: parser.parserName,
          parserVersion: parser.parserVersion,
          parseStatus: "pending",
        });
      } catch (error) {
        // A durable mapping conflict is a bundle-level invariant failure, not
        // a recoverable raw-file defect. Let the outer source handler
        // quarantine the source and every child without committing a partial
        // source/raw ownership bundle.
        if (error instanceof LegacyIdentityConflictError) throw error;
        rejectedBackups.push({ row: backup, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (plans.length === 0) {
      const revisionId = new RecordId(
        "source_revision",
        deterministicId("srev", `${String(locationId)}:${row.sha256}`),
      );
      const existing = await selectOne<{ id: RecordId; raw_archive_path?: string }>(
        this.db,
        "SELECT id, raw_archive_path FROM ONLY $id",
        { id: revisionId },
      );
      plans.push({
        revision: { revisionId, sha256: row.sha256, created: !existing },
        exists: !!existing,
        existingRawPath: existing?.raw_archive_path,
        sizeBytes: optionalInt(row, "size") ?? 0,
        mtimeMs: optionalInt(row, "mtime_ms") ?? 0,
        headHash: stringColumn(row, "head_hash"),
        snapshotKind: "legacy_missing_raw",
        parserName: "legacy",
        parserVersion: 1,
        parseStatus: "unsupported",
      });
    }
    const selected = plans.at(-1)!;
    const deletedAt = new Date(stringColumn(row, "deleted_at") ?? Date.now());
    const writtenPresence = isDeleted(row) ? "deleted_in_source" : "active";
    const sourceCommit: MigrationIdentityCommit = {
      table: "source_files",
      legacyId: sourceLegacyId,
      target: locationId,
      category: authoritativeTarget || existingLocation ? "matched" : "inserted",
      previousState: {
        currentRevision: existingLocation?.current_revision,
        lastSuccessfulRevision: existingLocation?.last_successful_revision,
        presenceStatus: existingLocation?.presence_status,
        missingCompleteScans: existingLocation?.missing_complete_scans,
        missingSinceAt: existingLocation?.missing_since_at,
        deletedAt: existingLocation?.deleted_at,
      },
      writtenState: {
        currentRevision: selected.revision.revisionId,
        lastSuccessfulRevision: existingLocation?.last_successful_revision,
        presenceStatus: writtenPresence,
        missingCompleteScans: isDeleted(row) ? 2 : 0,
        missingSinceAt: isDeleted(row) ? deletedAt : undefined,
        deletedAt: isDeleted(row) ? deletedAt : undefined,
      },
    };
    const rawCommits = plans.flatMap((plan): MigrationIdentityCommit[] => plan.row ? [{
      table: "raw_backups",
      legacyId: String(plan.row.id),
      target: plan.revision.revisionId,
      category: plan.mapped || plan.exists ? "matched" : "inserted",
      previousState: { rawArchivePath: plan.existingRawPath },
      writtenState: { rawArchivePath: plan.existingRawPath ?? plan.rawArchivePath },
    }] : []);
    const commits = [sourceCommit, ...rawCommits];
    const preparedCommits = await Promise.all(
      commits.map((commit) => this.prepareRowCommit(run, commit, identityPrefetch)),
    );
    const vars: Record<string, unknown> = {
      migration: run.migrationId,
      sync: run.syncRunId,
      now: new Date(),
      root: sourceRootId,
      installation: installationId,
      rootPath: provenancePath,
      parser: parser.parserName,
      location: locationId,
      relative: relativePath,
      original: row.original_path,
      basename: path.basename(relativePath),
      selectedRevision: selected.revision.revisionId,
      presence: writtenPresence,
      missingScans: isDeleted(row) ? 2 : 0,
      missingSince: isDeleted(row) ? deletedAt : undefined,
      deletedAt: isDeleted(row) ? deletedAt : undefined,
    };
    const sql = ["BEGIN;"];
    if (!existingRoot) {
      sql.push(
        `CREATE ONLY $root SET harness_installation = $installation, path = $rootPath,
         source_kind = "legacy", parser_name = $parser, snapshot_strategy = "legacy_import",
         enabled = false, first_seen_at = $now, last_seen_at = $now,
         created_by_run = $migration;`,
      );
    }
    if (!existingLocation) {
      sql.push(
        `CREATE ONLY $location SET source_root = $root, relative_path = $relative,
         original_path = $original, basename = $basename, presence_status = "active",
         missing_complete_scans = 0, first_seen_at = $now, last_seen_at = $now,
         created_by_run = $migration;`,
      );
    }
    for (const [index, plan] of plans.entries()) {
      const suffix = String(index);
      vars[`revision${suffix}`] = plan.revision.revisionId;
      vars[`sha${suffix}`] = plan.revision.sha256;
      vars[`size${suffix}`] = Math.round(plan.sizeBytes);
      vars[`mtime${suffix}`] = Math.round(plan.mtimeMs);
      vars[`head${suffix}`] = plan.headHash;
      vars[`raw${suffix}`] = plan.rawArchivePath;
      vars[`kind${suffix}`] = plan.snapshotKind;
      vars[`parserName${suffix}`] = plan.parserName;
      vars[`parserVersion${suffix}`] = String(plan.parserVersion);
      vars[`parseStatus${suffix}`] = plan.parseStatus;
      if (!plan.exists) {
        sql.push(
          `CREATE ONLY $revision${suffix} SET source_location = $location, sha256 = $sha${suffix},
           size_bytes = $size${suffix}, mtime_ms = $mtime${suffix}, head_hash = $head${suffix},
           raw_archive_path = $raw${suffix}, snapshot_kind = $kind${suffix}, captured_at = $now,
           parser_name = $parserName${suffix}, parser_version = $parserVersion${suffix},
           parse_status = $parseStatus${suffix}, sync_run = $sync, created_by_run = $migration;`,
        );
      } else if (shouldAttachRepairedRaw(plan.existingRawPath, plan.rawArchivePath)) {
        sql.push(
          `UPDATE ONLY $revision${suffix} SET raw_archive_path = $raw${suffix},
           snapshot_kind = $kind${suffix}, size_bytes = $size${suffix}, mtime_ms = $mtime${suffix},
           head_hash = $head${suffix}, parser_name = $parserName${suffix},
           parser_version = $parserVersion${suffix};`,
        );
      }
    }
    sql.push(
      `UPDATE ONLY $location SET current_revision = $selectedRevision,
       presence_status = $presence, missing_complete_scans = $missingScans,
       missing_since_at = $missingSince, deleted_at = $deletedAt,
       last_seen_at = $now;`,
    );
    this.appendRowCommitBatchSql(sql, vars, commits, preparedCommits, identityPrefetch);
    sql.push("COMMIT;", "RETURN true;");
    await this.faultHooks.beforeAtomicRowQuery?.("source", run);
    const queryResult = await this.db.query<unknown[]>(sql.join("\n"), vars);
    if (queryResult.at(-1) !== true) throw new Error("atomic source row commit failed");
    await this.faultHooks.afterAtomicRowQuery?.("source", run);
    const source: SourceTarget = {
      row,
      locationId,
      sourceRootId,
      hostId: host.hostId,
      osAccountId: host.osAccountId,
      installationId,
      agentSlug: agent.slug,
      created: !existingLocation,
      previousPresence: existingLocation?.presence_status,
      selectedRevision: selected.revision,
      hostMappingId: mapping.mappingId,
      legacyOnlyLocation: true,
    };
    return {
      source,
      revisions: plans.map((plan) => plan.revision),
      commits,
      rejectedBackups,
    };
  }

  async importRawBackup(
    _run: MigrationRunHandle,
    _row: LegacyRawBackupRow,
    _source: SourceTarget,
    _authoritativeTarget?: RecordId,
  ): Promise<EnsureTarget<RevisionTarget>> {
    throw new Error("Surreal legacy raw writes require commitSourceRows atomic transaction");
  }

  async ensureMissingRawRevision(
    _run: MigrationRunHandle,
    _source: SourceTarget,
  ): Promise<RevisionTarget> {
    throw new Error("Surreal legacy missing-raw writes require commitSourceRows atomic transaction");
  }

  async finalizeSourceFile(_source: SourceTarget, _revision: RevisionTarget): Promise<void> {
    throw new Error("Surreal legacy source finalization is part of commitSourceRows atomic transaction");
  }

  async rollbackSourceAttempt(source: SourceTarget, revisions: RevisionTarget[]): Promise<void> {
    void source;
    void revisions;
    if (!this.currentRun) return;
    await this.cleanupUncommittedMigrationEffects(
      this.currentRun.migrationId,
      this.currentRun.syncRunId,
    );
  }

  async createReplayRevision(
    run: MigrationRunHandle,
    thread: LegacyThreadRow,
    _records: LegacyThreadRecordRow[],
    agent: AgentTarget,
    contextSource: SourceTarget | undefined,
    content: string,
  ): Promise<RevisionTarget> {
    // Payload/normalized replay всегда получает отдельную synthetic
    // provenance. Даже одинаковый SHA не может заполнить raw_archive_path
    // исходной legacy_missing_raw revision или переключить её current.
    const mapping = this.approvedMapping("threads", thread.id);
    if (contextSource && contextSource.hostMappingId !== mapping.mappingId) {
      throw new Error(
        `approved thread/source host assignment mismatch: threads:${thread.id}=` +
        `${mapping.mappingId}, source=${contextSource.hostMappingId}`,
      );
    }
    const host = await this.hostForMapping(mapping);
    const installationId = await this.installation(agent, host.hostId);
    const rootPath =
      `legacy-import://${encodeURIComponent(host.mappingId)}/${agent.slug}/` +
      `${sha256hex(`synthetic-replay:${agent.slug}`)}`;
    const rootId = new RecordId(
      "source_root",
      deterministicId("sroot", `${String(installationId)}:${rootPath}`),
    );
    const rootExists = !!await selectOne<{ id: RecordId }>(
      this.db,
      "SELECT id FROM ONLY $id",
      { id: rootId },
    );
    const relativePath = `thread_${thread.id}.jsonl`;
    const originalPath = `legacy-replay://${host.mappingId}/${agent.slug}/${relativePath}`;
    const deterministicLocation = new RecordId(
      "source_location",
      deterministicId("sloc", `${String(rootId)}:${relativePath}`),
    );
    const existingLocation = await selectOne<{
      id: RecordId;
      current_revision?: RecordId;
      last_successful_revision?: RecordId;
    }>(
      this.db,
      `SELECT id, current_revision, last_successful_revision FROM source_location
       WHERE source_root = $root AND relative_path = $relative LIMIT 1`,
      { root: rootId, relative: relativePath },
    );
    const locationId = existingLocation?.id ?? deterministicLocation;
    const tempDir = await mkdtemp(path.join(tmpdir(), "baka-legacy-replay-"));
    const replayPath = path.join(tempDir, `thread_${thread.id}.jsonl`);
    try {
      await writeFile(replayPath, content);
      const snapshot = await snapshotRegularFile(replayPath, {
        archiveRoot: this.archiveRoot,
        harness: agent.slug,
        runId: `migration-${recordKey(run.migrationId)}`,
      });
      const revisionId = new RecordId(
        "source_revision",
        deterministicId("srev", `${String(locationId)}:${snapshot.sha256}`),
      );
      const revisionExists = !!await selectOne<{ id: RecordId }>(
        this.db,
        "SELECT id FROM ONLY $id",
        { id: revisionId },
      );
      const immutableRawPath = path.join(this.archiveRoot, snapshot.relativeRawPath);
      const kimiSemanticPath = agent.slug === "kimi-code"
        ? kimiLegacyReplaySemanticPath(thread.external_id)
        : undefined;
      const kimiView = agent.slug === "kimi-code" && kimiSemanticPath
        ? await materializeKimiLegacyRecoveryView({
            archiveRoot: this.archiveRoot,
            immutableRawPath,
            semanticPaths: [kimiSemanticPath],
          })
        : undefined;
      return {
        revisionId,
        sha256: snapshot.sha256,
        rawPath: agent.slug === "kimi-code"
          ? this.rememberKimiRecoveryView(kimiView)
          : immutableRawPath,
        created: !revisionExists,
        provisionalReplay: {
          rootId,
          rootExists,
          locationId,
          locationExists: !!existingLocation,
          previousCurrentRevision: existingLocation?.current_revision,
          previousLastSuccessfulRevision: existingLocation?.last_successful_revision,
          revisionExists,
          installationId,
          mappingId: host.mappingId,
          agentSlug: agent.slug,
          rootPath,
          relativePath,
          originalPath,
          sizeBytes: snapshot.sizeBytes,
          mtimeMs: snapshot.mtimeMs,
          headHash: snapshot.headHash,
          rawArchivePath: snapshot.relativeRawPath,
          parserName: HARNESS_TOOLS[agent.slug].parser.parserName,
          parserVersion: HARNESS_TOOLS[agent.slug].parser.parserVersion,
        },
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async threadIdentityContext(
    agent: AgentTarget,
    preferredSource: SourceTarget | undefined,
    thread: LegacyThreadRow,
  ): Promise<{ installationId: RecordId; hostId: RecordId; osAccountId?: RecordId }> {
    const mapping = this.approvedMapping("threads", thread.id);
    if (preferredSource && preferredSource.hostMappingId !== mapping.mappingId) {
      throw new Error(
        `approved thread/source host assignment mismatch: threads:${thread.id}=` +
        `${mapping.mappingId}, source=${preferredSource.hostMappingId}`,
      );
    }
    const host = await this.hostForMapping(mapping);
    return {
      installationId: await this.installation(agent, host.hostId),
      hostId: host.hostId,
      osAccountId: host.osAccountId,
    };
  }

  async commitDialogueRow(
    run: MigrationRunHandle,
    input: DialogueWriteInput,
    bundle: LegacyThreadBundle,
  ): Promise<AtomicDialogueCommitResult> {
    // Pure verification is intentionally the first operation: a stale or
    // forged child binding must fail before any canonical write is assembled.
    const verifiedBindings = resolveLegacyCanonicalBindings(
      bundle,
      input.parsed,
      input.agent.slug,
      input.legacyBindings.source,
    );
    if (!sameLegacyCanonicalBindings(verifiedBindings, input.legacyBindings)) {
      throw new Error("legacy binding changed between recovery and atomic persistence");
    }
    assertExactDialogueIdentityPrefetch(bundle, input.legacyIdentityPrefetch);
    const sourceSha = input.sourceRevision.sha256;
    const sourceBefore = await selectOne<{
      sha256: string;
      parse_status: string;
      dialogues_discovered: number;
      source_location: RecordId;
    }>(
      this.db,
      "SELECT sha256, parse_status, dialogues_discovered, source_location FROM ONLY $id",
      { id: input.sourceRevision.revisionId },
    );
    if (!input.sourceRevision.provisionalReplay) {
      if (!sourceBefore || sourceBefore.sha256 !== sourceSha) {
        throw new Error(`source revision отсутствует/изменилась: ${String(input.sourceRevision.revisionId)}`);
      }
    }
    const sourceLocationId = sourceBefore?.source_location ??
      input.sourceRevision.provisionalReplay?.locationId;
    const sourceLocationBefore = sourceLocationId
      ? await selectOne<{
          current_revision?: RecordId;
          last_successful_revision?: RecordId;
          presence_status: string;
        }>(
          this.db,
          `SELECT current_revision, last_successful_revision, presence_status FROM ONLY $id`,
          { id: sourceLocationId },
        )
      : undefined;
    const [readyDialogueCountBefore] = await this.db.query<[number]>(
      `RETURN count((SELECT VALUE id FROM dialogue_revision
        WHERE source_revision = $revision AND status = "ready"));`,
      { revision: input.sourceRevision.revisionId },
    );
    const existingDialogueId = await this.preflightDialogueDedup({
      thread: input.thread,
      installationId: input.installationId,
      sourceSha256: sourceSha,
      authoritativeDialogueId: input.authoritativeDialogueId,
    });
    const identityKey = `${String(input.installationId)}:${input.thread.external_id}`;
    const existingDialogue = existingDialogueId
      ? await selectOne<{ id: RecordId; current_revision?: RecordId; identity_key: string }>(
          this.db,
          "SELECT id, current_revision, identity_key FROM ONLY $id",
          { id: existingDialogueId },
        )
      : await selectOne<{ id: RecordId; current_revision?: RecordId; identity_key: string }>(
          this.db,
          "SELECT id, current_revision, identity_key FROM dialogue WHERE identity_key = $key LIMIT 1",
          { key: identityKey },
        );
    if (existingDialogueId && !existingDialogue) {
      throw new Error(`authoritative dialogue отсутствует: ${String(existingDialogueId)}`);
    }
    const effectiveIdentityKey = existingDialogue?.identity_key ?? identityKey;
    const dialogueId = existingDialogue?.id ?? new RecordId(
      "dialogue",
      deterministicId("dlg", effectiveIdentityKey),
    );
    const canonicalHash = canonicalDialogueHash(input.parsed);
    const revisionKey = dialogueRevisionId(
      effectiveIdentityKey,
      input.parserName,
      input.parserVersion,
      canonicalHash,
    );
    const revisionId = new RecordId("dialogue_revision", revisionKey);
    const existingRevision = await selectOne<{
      id: RecordId;
      dialogue: RecordId;
      status: string;
    }>(
      this.db,
      "SELECT id, dialogue, status FROM ONLY $id",
      { id: revisionId },
    );
    if (existingRevision && (
      String(existingRevision.dialogue) !== String(dialogueId) ||
      existingRevision.status !== "ready"
    )) {
      throw new LegacyDialogueDedupConflictError(
        `canonical revision identity conflict for threads:${input.thread.id}: ${String(revisionId)}`,
      );
    }
    const createdDialogue = !existingDialogue;
    const createdRevision = !existingRevision;
    if (input.canonicalImportPolicy === "match_existing" &&
        (createdDialogue || createdRevision)) {
      throw new LegacyDialogueDedupConflictError(
        `approved live dialogue ${input.agent.slug}:${input.thread.external_id} ` +
        `does not have the exact canonical revision required by legacy ownership`,
      );
    }
    const becomesCurrent = createdRevision && !existingDialogue?.current_revision;

    const modelIds = new Map<string, RecordId>();
    const vendorIds = new Map<string, { id: RecordId; create: boolean }>();
    const modelPlans = new Map<string, {
      id: RecordId;
      create: boolean;
      vendor: RecordId;
      canonicalName: string;
      rawName: string;
    }>();
    for (const message of input.parsed.messages) {
      if (!message.model) continue;
      const key = modelKeyOf(message)!;
      if (modelIds.has(key)) continue;
      let vendorPlan = vendorIds.get(message.model.vendor);
      if (!vendorPlan) {
        const existingVendor = await selectOne<{ id: RecordId }>(
          this.db,
          "SELECT id FROM vendor WHERE slug = $slug LIMIT 1",
          { slug: message.model.vendor },
        );
        vendorPlan = {
          id: existingVendor?.id ?? new RecordId(
            "vendor",
            deterministicId("vendor", message.model.vendor),
          ),
          create: !existingVendor,
        };
        vendorIds.set(message.model.vendor, vendorPlan);
      }
      const existingModel = await selectOne<{ id: RecordId }>(
        this.db,
        "SELECT id FROM model WHERE vendor = $vendor AND canonical_name = $name LIMIT 1",
        { vendor: vendorPlan.id, name: message.model.canonicalName },
      );
      const modelId = existingModel?.id ?? new RecordId(
        "model",
        deterministicId("model", `${String(vendorPlan.id)}:${message.model.canonicalName}`),
      );
      modelPlans.set(key, {
        id: modelId,
        create: !existingModel,
        vendor: vendorPlan.id,
        canonicalName: message.model.canonicalName,
        rawName: message.model.rawModelName ?? message.model.canonicalName,
      });
      modelIds.set(key, modelId);
    }

    let workspaceId = input.project?.workspaceId;
    let workspacePlan: {
      create: boolean;
      locationId?: RecordId;
      path?: string;
      normalizedPath?: string;
      name: string;
      repositoryIdentity?: string;
    } | undefined;
    if (input.parsed.workspace) {
      const parsed = input.parsed.workspace;
      const normalized = parsed.path ? normalizedPath(parsed.path) : undefined;
      const existing = parsed.repositoryIdentity
        ? await selectOne<{ id: RecordId }>(
            this.db,
            "SELECT id FROM workspace WHERE repository_identity = $repo LIMIT 1",
            { repo: parsed.repositoryIdentity },
          )
        : normalized
          ? await selectOne<{ workspace: RecordId }>(
              this.db,
              `SELECT workspace FROM workspace_location
               WHERE host = $host AND normalized_path = $path LIMIT 1`,
              { host: input.hostId, path: normalized },
            )
          : undefined;
      workspaceId = existing
        ? ("workspace" in existing ? existing.workspace : existing.id)
        : new RecordId(
            "workspace",
            deterministicId(
              "ws",
              `dialogue:${String(input.hostId)}:${parsed.repositoryIdentity ?? normalized}`,
            ),
          );
      workspacePlan = {
        create: !existing,
        ...(normalized ? {
          locationId: new RecordId(
            "workspace_location",
            deterministicId("wloc", `${String(input.hostId)}:${normalized}`),
          ),
          path: parsed.path,
          normalizedPath: normalized,
        } : {}),
        name: parsed.name ?? normalized?.split("/").pop() ?? parsed.repositoryIdentity ?? "unknown",
        repositoryIdentity: parsed.repositoryIdentity,
      };
    }
    if (input.canonicalImportPolicy === "match_existing" && (
      [...vendorIds.values()].some((vendor) => vendor.create) ||
      [...modelPlans.values()].some((model) => model.create) ||
      workspacePlan?.create === true
    )) {
      throw new LegacyDialogueDedupConflictError(
        `approved live dialogue ${input.agent.slug}:${input.thread.external_id} ` +
        `requires forbidden canonical identity repair during legacy ownership binding`,
      );
    }

    const commitRows: MigrationIdentityCommit[] = [];
    const addCommit = (
      table: LegacyTable,
      legacyId: string,
      target: RecordId,
      created: boolean,
      state?: Pick<MigrationIdentityCommit, "previousState" | "writtenState">,
    ) => {
      const mapped = prefetchedLegacyIdentity(input.legacyIdentityPrefetch, table, legacyId);
      commitRows.push({
        table,
        legacyId,
        target,
        category: mapped || !created ? "matched" : "inserted",
        ...state,
      });
    };
    const replayState = input.sourceRevision.provisionalReplay;
    const sourceBecomesCurrent = replayState !== undefined ||
      String(sourceLocationBefore?.current_revision) === String(input.sourceRevision.revisionId);
    addCommit(
      "threads",
      String(input.thread.id),
      dialogueId,
      createdDialogue,
      {
        previousState: {
          sourceParseStatus: sourceBefore?.parse_status,
          sourceDialoguesDiscovered: sourceBefore?.dialogues_discovered,
          sourceCurrentRevision: sourceLocationBefore?.current_revision ?? replayState?.previousCurrentRevision,
          sourceLastSuccessfulRevision:
            sourceLocationBefore?.last_successful_revision ?? replayState?.previousLastSuccessfulRevision,
          sourcePresenceStatus: sourceLocationBefore?.presence_status,
        },
        writtenState: {
          sourceParseStatus: "parsed",
          sourceDialoguesDiscovered: (readyDialogueCountBefore ?? 0) +
            (createdRevision ? 1 : 0),
          sourceCurrentRevision: replayState
            ? input.sourceRevision.revisionId
            : sourceLocationBefore?.current_revision,
          sourceLastSuccessfulRevision: sourceBecomesCurrent
            ? input.sourceRevision.revisionId
            : sourceLocationBefore?.last_successful_revision,
          sourcePresenceStatus: replayState ? "active" : sourceLocationBefore?.presence_status,
        },
      },
    );
    for (const row of bundle.records) {
      addCommit(
        "thread_records",
        String(row.id),
        row.source_file_id !== null ? input.sourceRevision.revisionId : revisionId,
        input.sourceRevision.created || createdRevision,
      );
    }
    for (const binding of verifiedBindings.messages) {
      addCommit(
        "messages",
        binding.legacyId,
        new RecordId("message", messageRecordId(revisionKey, binding.canonicalSequence)),
        createdRevision,
      );
    }
    for (const binding of verifiedBindings.chunks) {
      addCommit(
        "message_chunks",
        binding.legacyId,
        new RecordId(
          "chunk",
          chunkRecordId(
            revisionKey,
            binding.canonicalMessageSequence,
            binding.canonicalChunkSequence,
          ),
        ),
        createdRevision,
      );
    }
    const preparedCommits = await Promise.all(
      commitRows.map((row) => this.prepareRowCommit(
        run,
        row,
        input.legacyIdentityPrefetch,
      )),
    );

    const tx = new MigrationTxBuilder();
    tx.vars.migration = run.migrationId;
    tx.vars.sync = run.syncRunId;
    tx.vars.now = new Date();
    const replay = input.sourceRevision.provisionalReplay;
    if (replay) {
      tx.vars.replayRoot = replay.rootId;
      tx.vars.replayLocation = replay.locationId;
      tx.vars.replayRevision = input.sourceRevision.revisionId;
      if (!replay.rootExists) {
        tx.sql.push(
          `CREATE ONLY $replayRoot SET harness_installation = ${tx.param(replay.installationId)}, ` +
          `path = ${tx.param(replay.rootPath)}, source_kind = "legacy_replay", ` +
          `parser_name = ${tx.param(replay.parserName)}, ` +
          `snapshot_strategy = "legacy_payload_or_normalized_replay", enabled = false, ` +
          `first_seen_at = $now, last_seen_at = $now, created_by_run = $migration;`,
        );
      }
      if (!replay.locationExists) {
        tx.sql.push(
          `CREATE ONLY $replayLocation SET source_root = $replayRoot, ` +
          `relative_path = ${tx.param(replay.relativePath)}, ` +
          `original_path = ${tx.param(replay.originalPath)}, ` +
          `basename = ${tx.param(path.basename(replay.relativePath))}, presence_status = "active", ` +
          `missing_complete_scans = 0, first_seen_at = $now, last_seen_at = $now, ` +
          `created_by_run = $migration;`,
        );
      }
      if (!replay.revisionExists) {
        tx.sql.push(
          `CREATE ONLY $replayRevision SET source_location = $replayLocation, ` +
          `sha256 = ${tx.param(input.sourceRevision.sha256)}, size_bytes = ${tx.param(Math.round(replay.sizeBytes))}, ` +
          `mtime_ms = ${tx.param(Math.round(replay.mtimeMs))}, head_hash = ${tx.param(replay.headHash)}, ` +
          `raw_archive_path = ${tx.param(replay.rawArchivePath)}, snapshot_kind = "legacy_migration_replay", ` +
          `captured_at = $now, parser_name = ${tx.param(replay.parserName)}, ` +
          `parser_version = ${tx.param(String(replay.parserVersion))}, parse_status = "pending", ` +
          `sync_run = $sync, created_by_run = $migration;`,
        );
      }
      tx.sql.push(
        `UPDATE ONLY $replayLocation SET current_revision = $replayRevision, ` +
        `presence_status = "active", missing_complete_scans = 0, missing_since_at = NONE, ` +
        `deleted_at = NONE, last_seen_at = $now;`,
      );
    }
    for (const [slug, vendor] of vendorIds) {
      if (!vendor.create) continue;
      tx.sql.push(
        `CREATE ONLY ${tx.param(vendor.id)} SET slug = ${tx.param(slug)}, ` +
        `display_name = ${tx.param(slug)}, first_seen_at = $now, last_seen_at = $now, ` +
        `created_by_run = $migration;`,
      );
    }
    for (const model of modelPlans.values()) {
      if (!model.create) continue;
      tx.sql.push(
        `CREATE ONLY ${tx.param(model.id)} SET vendor = ${tx.param(model.vendor)}, ` +
        `canonical_name = ${tx.param(model.canonicalName)}, aliases = [${tx.param(model.rawName)}], ` +
        `first_seen_at = $now, last_seen_at = $now, created_by_run = $migration;`,
      );
    }
    if (workspacePlan?.create && workspaceId) {
      tx.sql.push(
        `CREATE ONLY ${tx.param(workspaceId)} SET name = ${tx.param(workspacePlan.name)}, ` +
        `repository_identity = ${tx.param(workspacePlan.repositoryIdentity)}, ` +
        `first_seen_at = $now, last_seen_at = $now, created_by_run = $migration;`,
      );
      if (workspacePlan.locationId && workspacePlan.path && workspacePlan.normalizedPath) {
        tx.sql.push(
          `CREATE ONLY ${tx.param(workspacePlan.locationId)} SET workspace = ${tx.param(workspaceId)}, ` +
          `host = ${tx.param(input.hostId)}, path = ${tx.param(workspacePlan.path)}, ` +
          `normalized_path = ${tx.param(workspacePlan.normalizedPath)}, ` +
          `git_remote = ${tx.param(workspacePlan.repositoryIdentity)}, first_seen_at = $now, ` +
          `last_seen_at = $now, created_by_run = $migration;`,
        );
      }
    }
    tx.vars.dialogue = dialogueId;
    tx.vars.revision = revisionId;
    if (createdDialogue) {
      tx.sql.push(
        `CREATE ONLY $dialogue SET identity_key = ${tx.param(effectiveIdentityKey)}, ` +
        `harness_installation = ${tx.param(input.installationId)}, ` +
        `os_account = ${tx.param(input.osAccountId)}, workspace = ${tx.param(workspaceId)}, ` +
        `external_id = ${tx.param(input.parsed.externalId)}, title = ${tx.param(input.parsed.title)}, ` +
        `started_at = ${tx.param(input.parsed.startedAt)}, updated_at = ${tx.param(input.parsed.updatedAt)}, ` +
        `first_seen_at = $now, last_seen_at = $now, created_by_run = $migration;`,
      );
    }
    if (createdRevision) {
      const messageCount = input.parsed.messages.length;
      const chunkCount = input.parsed.messages.reduce((sum, message) => sum + message.chunks.length, 0);
      tx.sql.push(
        `CREATE ONLY $revision SET dialogue = $dialogue, source_revision = ${tx.param(input.sourceRevision.revisionId)}, ` +
        `source_dialogue_id = ${tx.param(input.thread.external_id)}, parser_name = ${tx.param(input.parserName)}, ` +
        `parser_version = ${tx.param(String(input.parserVersion))}, canonical_hash = ${tx.param(canonicalHash)}, ` +
        `status = "ready", message_count = ${tx.param(messageCount)}, chunk_count = ${tx.param(chunkCount)}, ` +
        `started_at = ${tx.param(input.parsed.startedAt)}, updated_at = ${tx.param(input.parsed.updatedAt)}, ` +
        `created_at = $now, created_by_run = $migration;`,
      );
      for (const message of input.parsed.messages) {
        const usage = normalizeUsageEvents(message.usageEvents);
        const messageId = new RecordId("message", messageRecordId(revisionKey, message.sequence));
        tx.sql.push(
          `LET $m${message.sequence} = (CREATE ONLY ${tx.param(messageId)} SET dialogue = $dialogue, ` +
          `dialogue_revision = $revision, ` +
          tx.assignments([
            ["external_id", message.externalId],
            ["sequence", message.sequence],
            ["role", message.role],
            ["raw_role", message.rawRole],
            ["human_authored", message.humanAuthored === true],
            ["visible_to_user", message.visibleToUser === true],
            ["timestamp", message.timestamp],
            ["model", message.model ? modelIds.get(modelKeyOf(message)!) : undefined],
            ["raw_model_name", message.model?.rawModelName],
            ["reasoning_effort", message.model?.reasoningEffort],
            ["service_provider", message.model?.serviceProvider],
            ["usage", usage ? clean(usage) : undefined],
            ["raw_usage_events", message.usageEvents.length > 0 ? clean(message.usageEvents) : undefined],
            ["metadata", Object.keys(message.metadata).length > 0 ? clean(message.metadata) : undefined],
            ["created_by_run", run.migrationId],
          ]).join(", ") + `).id;`,
        );
        for (const chunk of message.chunks) {
          const content = chunk.content ?? "";
          const chunkId = new RecordId(
            "chunk",
            chunkRecordId(revisionKey, message.sequence, chunk.sequence),
          );
          tx.sql.push(
            `CREATE ONLY ${tx.param(chunkId)} SET dialogue = $dialogue, dialogue_revision = $revision, ` +
            `message = $m${message.sequence}, ` +
            tx.assignments([
              ["sequence", chunk.sequence],
              ["kind", chunk.kind],
              ["raw_kind", chunk.rawKind],
              ["role", message.role],
              ["content", content],
              ["content_sha256", sha256hex(content)],
              ["content_bytes", Buffer.byteLength(content, "utf8")],
              ["source_locator", chunk.sourceLocator],
              ["tool_call_id", chunk.toolCallId],
              ["tool_name", chunk.toolName],
              ["raw_event_type", chunk.rawEventType],
              ["metadata", Object.keys(chunk.metadata).length > 0 ? clean(chunk.metadata) : undefined],
              ["created_by_run", run.migrationId],
            ]).join(", ") + `;`,
          );
        }
      }
      if (becomesCurrent) {
        const docs = prepareSearchDocuments(input.parsed, revisionKey, HARNESS_TOOLS[input.agent.slug].extractors);
        for (const [index, doc] of docs.entries()) {
          const messageLink = doc.messageSequence !== undefined
            ? `message = $m${doc.messageSequence}, `
            : "";
          tx.sql.push(
            `CREATE ONLY ${tx.param(new RecordId("search_document", doc.recordKey))} SET ` +
            `dialogue = $dialogue, dialogue_revision = $revision, ${messageLink}` +
            tx.assignments([
              ["document_type", doc.documentType],
              ["segment_no", doc.segmentNo],
              ["content", doc.content],
              ["content_sha256", doc.contentSha256],
              ["token_count", doc.tokenCount],
              ["source_chunks", doc.chunkIds],
              ["extraction_method", doc.method],
              ["extraction_version", String(HARNESS_TOOLS[input.agent.slug].extractors.extractorVersion)],
              ["segmentation_version", SEGMENTATION_VERSION],
              ["created_at", new Date()],
              ["created_by_run", run.migrationId],
            ]).join(", ") + `;`,
          );
          void index;
        }
        const primaryKey = primaryModelKey(input.parsed);
        const primaryModel = primaryKey ? modelIds.get(primaryKey) : undefined;
        tx.sql.push(
          `UPDATE ONLY $dialogue SET current_revision = $revision, ` +
          `updated_at = ${tx.param(input.parsed.updatedAt)}, last_seen_at = $now, ` +
          `primary_model = ${primaryModel ? tx.param(primaryModel) : "NONE"};`,
        );
      }
    }
    tx.sql.push(
      `LET $dialogueCount = count((SELECT VALUE id FROM dialogue_revision ` +
      `WHERE source_revision = ${tx.param(input.sourceRevision.revisionId)} AND status = "ready"));`,
      `UPDATE ${tx.param(input.sourceRevision.revisionId)} SET parse_status = "parsed", ` +
      `dialogues_discovered = $dialogueCount;`,
      `UPDATE source_location SET last_successful_revision = ${tx.param(input.sourceRevision.revisionId)} ` +
      `WHERE current_revision = ${tx.param(input.sourceRevision.revisionId)};`,
    );
    this.appendRowCommitBatchSql(
      tx.sql,
      tx.vars,
      commitRows,
      preparedCommits,
      input.legacyIdentityPrefetch,
    );
    tx.sql.push("COMMIT;", "RETURN true;");
    await this.faultHooks.beforeAtomicRowQuery?.("dialogue", run);
    const result = await this.db.query<unknown[]>(tx.sql.join("\n"), tx.vars);
    if (result.at(-1) !== true) throw new Error("atomic dialogue row commit failed");
    await this.faultHooks.afterAtomicRowQuery?.("dialogue", run);
    return {
      dialogue: {
        dialogueId,
        revisionId,
        createdDialogue,
        createdRevision,
      },
      commits: commitRows,
    };
  }

  async writeDialogue(_input: DialogueWriteInput): Promise<DialogueTarget> {
    throw new Error("Surreal legacy dialogue writes require commitDialogueRow atomic transaction");
  }

  async preflightDialogueDedup(input: DialogueDedupInput): Promise<RecordId | undefined> {
    const identityKey = `${String(input.installationId)}:${input.thread.external_id}`;
    const [bySourceRows] = await this.db.query<[
      Array<{ dialogue: RecordId }>,
    ]>(
      `SELECT dialogue FROM dialogue_revision
       WHERE source_dialogue_id = $sourceDialogueId AND source_revision.sha256 = $sha`,
      { sourceDialogueId: input.thread.external_id, sha: input.sourceSha256 },
    );
    const bySource = [...new Map(
      (bySourceRows ?? []).map((row) => [String(row.dialogue), row.dialogue]),
    ).values()];
    if (bySource.length > 1) {
      throw new LegacyDialogueDedupConflictError(
        `ambiguous source revision SHA + dialogue id: ${input.sourceSha256}:${input.thread.external_id}`,
      );
    }
    const [byIdentityRows] = await this.db.query<[
      Array<{ id: RecordId }>,
    ]>(
      "SELECT id FROM dialogue WHERE identity_key = $key",
      { key: identityKey },
    );
    const byIdentity = [...new Map(
      (byIdentityRows ?? []).map((row) => [String(row.id), row.id]),
    ).values()];
    if (byIdentity.length > 1) {
      throw new LegacyDialogueDedupConflictError(
        `ambiguous harness installation + external id: ${identityKey}`,
      );
    }

    const resolved: Array<{ key: string; id: RecordId }> = [];
    if (input.authoritativeDialogueId) {
      if (String(input.authoritativeDialogueId.table) !== "dialogue") {
        throw new LegacyDialogueDedupConflictError(
          `legacy threads:${input.thread.id} mapping target is not dialogue: ${String(input.authoritativeDialogueId)}`,
        );
      }
      const authoritative = await selectOne<{ id: RecordId }>(
        this.db,
        "SELECT id FROM ONLY $id",
        { id: input.authoritativeDialogueId },
      );
      if (!authoritative) {
        throw new LegacyDialogueDedupConflictError(
          `legacy threads:${input.thread.id} mapping points to missing dialogue`,
        );
      }
      resolved.push({ key: "legacy_identity_map", id: authoritative.id });
    }
    if (bySource[0]) {
      const sourceDialogue = await selectOne<{ id: RecordId }>(
        this.db,
        "SELECT id FROM ONLY $id",
        { id: bySource[0] },
      );
      if (!sourceDialogue) {
        throw new LegacyDialogueDedupConflictError(
          `source SHA/dialogue id points to missing dialogue: ${String(bySource[0])}`,
        );
      }
      resolved.push({ key: "source_revision_sha+source_dialogue_id", id: sourceDialogue.id });
    }
    if (byIdentity[0]) {
      resolved.push({ key: "harness_installation+external_id", id: byIdentity[0] });
    }
    const distinct = new Set(resolved.map((item) => String(item.id)));
    if (distinct.size > 1) {
      throw new LegacyDialogueDedupConflictError(
        `legacy dialogue dedup key conflict for threads:${input.thread.id}: ` +
        resolved.map((item) => `${item.key}=${String(item.id)}`).join(", "),
      );
    }
    return resolved[0]?.id;
  }

  async rollbackDialogueAttempt(
    _thread: LegacyThreadRow,
    _dialogue: DialogueTarget | undefined,
    _sourceRevision: RevisionTarget,
    _removeThreadMapping: boolean,
  ): Promise<void> {
    if (!this.currentRun) return;
    await this.cleanupUncommittedMigrationEffects(
      this.currentRun.migrationId,
      this.currentRun.syncRunId,
    );
  }

  async markRevisionParsed(_revision: RevisionTarget): Promise<void> {
    throw new Error("Surreal legacy revision marking is part of commitDialogueRow atomic transaction");
  }
}
