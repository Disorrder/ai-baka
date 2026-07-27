/**
 * Safe production backfill gates for Stage 11 (docs/plan.md §20 этап 11).
 *
 * Nothing in this module calls a provider unless runConfirmedProductionBackfill
 * receives both allowExternalProviderCalls=true and the exact confirmation
 * phrase derived from a fresh exact-token/corpus plan. Planning/audit/index
 * checks are read-only.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import { writePrivateFileAtomic } from "../backup/safety.ts";
import { selectAll } from "../db/repositories/helpers.ts";
import { EXTRACTOR_VERSION } from "../search/extractors/types.ts";
import { SEGMENTATION_VERSION } from "../search/segmenter.ts";
import {
  assertCurrentLeasedBatch,
  backoffMs,
  completeBatch,
  failJob,
  failJobs,
  leaseJobs,
  packEmbeddingRequestBatches,
  privacyExclusionCode,
  releaseStaleLeases,
  BATCH_SIZE,
  MAX_ATTEMPTS,
  type EmbeddingDocumentRow,
  type EmbeddingJobRow,
  type ProviderFactory,
  type WorkerSummary,
} from "./jobs.ts";
import { EmbeddingProviderError } from "./provider.ts";
import { privacyExclusion, type PrivacyPolicy } from "./privacy.ts";
import { getSpaceBySlug, SLUG_RE, type EmbeddingSpace } from "./spaces.ts";
import {
  EMBEDDING_MODEL_TOKEN_LIMIT,
  EXACT_TOKENIZER_ID,
  eligibleCorpusFingerprint,
  validateExactTokenCountReport,
  type ExactTokenCountReport,
} from "./token-count.ts";

interface PlanDocumentRow {
  id: RecordId;
  content: string;
  content_sha256: string;
  document_type: string;
  extraction_version: string;
  segmentation_version: string;
  harness?: string;
  workspace?: string;
  dialogue_id?: RecordId;
  revision_id?: RecordId;
}

interface PlanJobRow {
  id: RecordId;
  search_document: RecordId;
  input_sha256: string;
  status: string;
  last_error?: string;
  created_at: Date;
}

interface PlanVectorRow {
  id: RecordId;
  search_document: RecordId;
  embedding_space: RecordId;
  input_sha256: string;
  dimensions: number;
}

export interface AcceptedRelevanceEvidence {
  formatVersion: 2;
  /** Explicit private artifact; prepare/run read and hash these exact bytes. */
  evaluationReportPath: string;
  evaluationReportSha256: string;
  /** Exact private judgment artifact used by the candidate evaluation. */
  judgmentSetPath: string;
  judgmentSetArtifactSha256: string;
  judgmentSetSha256: string;
  corpusFingerprintSha256: string;
  /** Exact serialized candidate-plan artifact, not only its inner plan hash. */
  candidatePlanPath: string;
  candidatePlanArtifactSha256: string;
  candidatePlanSha256: string;
  privacySha256: string;
  /** Only the chosen hybrid scenario can authorize a full backfill. */
  scenarioId: string;
  space: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  thresholds: RelevanceAcceptanceThresholds;
  humanAcceptance: {
    accepted: true;
    acceptedBy: string;
    acceptedAt: string;
    rationale: string;
  };
}

export interface RelevanceAcceptanceThresholds {
  minimumRecallAt5: number;
  minimumRecallAt10: number;
  minimumMrr: number;
  minimumNdcgAt10: number;
  minimumExpectedSnippetRecall: number;
  maximumIrrelevantTop5Share: number;
  maximumMustNotMatchViolations: number;
  maximumRetrievalFailures: number;
}

/** Final acceptance; candidate evidence above may authorize backfill, not Stage 11 completion. */
export interface AcceptedFullCorpusRelevanceEvidence {
  formatVersion: 1;
  evaluationReportPath: string;
  evaluationReportSha256: string;
  judgmentSetPath: string;
  judgmentSetArtifactSha256: string;
  judgmentSetSha256: string;
  corpusFingerprintSha256: string;
  privacySha256: string;
  scenarioId: string;
  space: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  thresholds: RelevanceAcceptanceThresholds;
  humanAcceptance: AcceptedRelevanceEvidence["humanAcceptance"];
}

export interface ValidateFullCorpusAcceptanceOptions {
  /** Live DB is mandatory: the validator derives authority, never accepts it as data. */
  db: Surreal;
  privacy: PrivacyPolicy;
  expectedCorpus: { algorithm: "sha256"; sha256: string; documents: number };
  expectedSpace: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  /** Independently pinned by the trusted CLI/operator, never copied from evidence. */
  expectedJudgmentArtifact: ExpectedJudgmentArtifactIdentity;
  /** Deterministic race seam for isolated tests; production callers omit it. */
  testOnlyJudgmentReadDelayMs?: number;
}

export interface ExpectedJudgmentArtifactIdentity {
  /** Absolute normalized operator-supplied path of the reviewed private JSON artifact. */
  resolvedPath: string;
  /** Canonical realpath separately detects symlink/parent redirection. */
  realPath: string;
  sha256: string;
  sizeBytes: number;
  /** Decimal strings preserve platform stat identities without precision loss. */
  device: string;
  inode: string;
}

export interface EvaluationCorpusDocumentBinding {
  documentId: string;
  dialogueId: string;
  revisionId: string;
  contentSha256: string;
}

async function collectFreshEvaluationCorpusDocumentBindings(
  db: Surreal,
  privacy: PrivacyPolicy,
): Promise<EvaluationCorpusDocumentBinding[]> {
  const documents: EvaluationCorpusDocumentBinding[] = [];
  let start = 0;
  for (;;) {
    const page = await selectAll<PlanDocumentRow>(
      db,
      `SELECT id, content, content_sha256, document_type,
         dialogue.id AS dialogue_id, dialogue_revision.id AS revision_id,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document ORDER BY id LIMIT 250 START $start`,
      { start },
    );
    for (const document of page) {
      if (!document.dialogue_id || !document.revision_id) {
        throw new Error("final relevance DB document ownership missing");
      }
      if (sha256(document.content) !== document.content_sha256) {
        throw new Error("final relevance DB content SHA-256 mismatch");
      }
      if (privacyExclusion({
        harness: document.harness,
        workspace: document.workspace,
        documentType: document.document_type,
        contentBytes: utf8Bytes(document.content),
      }, privacy)) continue;
      documents.push({
        documentId: String(document.id),
        dialogueId: String(document.dialogue_id),
        revisionId: String(document.revision_id),
        contentSha256: document.content_sha256,
      });
    }
    if (page.length < 250) break;
    start += page.length;
  }
  if (documents.length === 0) throw new Error("final relevance DB eligible corpus empty");
  return documents;
}

export interface ProductionJobBinding {
  jobId: string;
  documentId: string;
  inputSha256: string;
  status: string;
  createdAt: string;
}

export interface ProductionVectorBinding {
  vectorId: string;
  documentId: string;
  inputSha256: string;
  dimensions: number;
}

export interface ProductionDocumentBinding {
  documentId: string;
  /** Preserved so the serialized candidate plan proves judgment coverage. */
  dialogueId: string;
  /** Exact current revision owning the search document. */
  revisionId: string;
  contentSha256: string;
  extractionVersion: string;
  segmentationVersion: string;
}

export interface ProductionBackfillPlan {
  space: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions" | "physical_table">;
  exactTokenReport: {
    tokenizerId: string;
    model: string;
    corpusFingerprintSha256: string;
  };
  corpusDocuments: number;
  eligibleDocuments: number;
  privacyExcludedDocuments: number;
  eligibleTokens: number;
  pricePer1MTokens: number;
  exactPriceUsd: number;
  maxJobs: number;
  relevanceEvidence: AcceptedRelevanceEvidence & { acceptanceSha256: string };
  eligibleDocumentBindings: ProductionDocumentBinding[];
  jobBindings: ProductionJobBinding[];
  vectorBindings: ProductionVectorBinding[];
  runnableJobs: ProductionJobBinding[];
  jobs: Record<string, number>;
  vectors: number;
  permanentErrors: Array<{ jobId: string; documentId: string; error: string }>;
  blockers: string[];
  /** Full deterministic SHA-256 over every paid-call relevant input. */
  planSha256: string;
  /** Must be copied literally to the production run command. */
  confirmation: string;
}

export interface PrepareProductionBackfillOptions {
  privacy: PrivacyPolicy;
  pricePer1MTokens: number;
  maxJobs: number;
  acceptedRelevance: AcceptedRelevanceEvidence;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function normalizedPrivacy(policy: PrivacyPolicy): PrivacyPolicy {
  return {
    excludeHarnesses: [...policy.excludeHarnesses].sort(),
    excludeWorkspaces: [...policy.excludeWorkspaces].sort(),
    excludeDocumentTypes: [...policy.excludeDocumentTypes].sort(),
    maxDocumentBytes: policy.maxDocumentBytes,
  };
}

const PRIVACY_CANCELLATION_RE =
  /^privacy_excluded_(?:harness|workspace|document_type|document_size|policy)$/;

interface PrivacyStateDocumentRow extends PlanDocumentRow {}

interface PrivacyStateJobRow extends PlanJobRow {
  embedding_space: RecordId;
  attempts?: number;
  locked_by?: string;
  locked_at?: Date;
  completed_at?: Date;
}

export interface PrivacyReconciliationVectorBinding extends ProductionVectorBinding {
  embeddingSpaceId: string;
}

export interface PrivacyReconciliationJobBinding extends ProductionJobBinding {
  lastError?: string;
}

export interface PrivacyReconciliationAction {
  kind: "cancel_privacy_excluded" | "requeue_privacy_allowed";
  documentId: string;
  contentSha256: string;
  job: PrivacyReconciliationJobBinding;
  exclusionReason?: string;
  vectors: PrivacyReconciliationVectorBinding[];
}

export interface PrivacyReconciliationPlan {
  formatVersion: 1;
  space: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions" | "physical_table"> & {
    id: string;
  };
  privacy: PrivacyPolicy;
  documents: number;
  jobs: number;
  vectors: number;
  actions: PrivacyReconciliationAction[];
  blockers: string[];
  planSha256: string;
  confirmation: string;
}

function privacyPlanConfirmation(space: string, planSha256: string): string {
  return `APPLY EMBEDDING PRIVACY ${space} ${planSha256}`;
}

function validatePrivacyReconciliationPlan(plan: PrivacyReconciliationPlan): void {
  if (plan.formatVersion !== 1 || !plan.space?.slug || !SLUG_RE.test(plan.space.slug)) {
    throw new Error("embedding privacy plan format invalid");
  }
  const { planSha256, confirmation, ...binding } = plan;
  assertSha256(planSha256, "embedding privacy plan");
  if (sha256Canonical(binding) !== planSha256) {
    throw new Error("embedding privacy plan SHA-256 mismatch");
  }
  if (confirmation !== privacyPlanConfirmation(plan.space.slug, planSha256)) {
    throw new Error("embedding privacy plan confirmation invalid");
  }
}

/**
 * Read-only, content/hash-bound privacy transition plan. It deliberately does
 * not accept or construct a provider: policy changes are local DB lifecycle
 * operations and must be complete before any external call is authorized.
 */
export async function preparePrivacyReconciliation(
  db: Surreal,
  spaceSlug: string,
  policy: PrivacyPolicy,
): Promise<PrivacyReconciliationPlan> {
  const space = await getSpaceBySlug(db, spaceSlug);
  if (!space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  const [documents, jobs, vectors] = await Promise.all([
    selectAll<PrivacyStateDocumentRow>(
      db,
      `SELECT id, content, content_sha256, document_type, extraction_version,
         segmentation_version, dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document ORDER BY id`,
    ),
    selectAll<PrivacyStateJobRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256, status,
         last_error, created_at, attempts, locked_by, locked_at, completed_at
       FROM embedding_job WHERE embedding_space = $space ORDER BY id`,
      { space: space.id },
    ),
    selectAll<PlanVectorRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256,
         array::len(vector) AS dimensions FROM ${space.physical_table} ORDER BY id`,
    ),
  ]);
  const blockers: string[] = [];
  const actions: PrivacyReconciliationAction[] = [];
  const documentIds = new Set(documents.map((row) => String(row.id)));
  const jobsByDocument = new Map<string, PrivacyStateJobRow[]>();
  for (const job of jobs) {
    const id = String(job.search_document);
    jobsByDocument.set(id, [...(jobsByDocument.get(id) ?? []), job]);
    if (!documentIds.has(id)) blockers.push(`${String(job.id)}: orphan embedding_job`);
  }
  const vectorsByDocument = new Map<string, PlanVectorRow[]>();
  for (const vector of vectors) {
    const id = String(vector.search_document);
    vectorsByDocument.set(id, [...(vectorsByDocument.get(id) ?? []), vector]);
    if (!documentIds.has(id)) blockers.push(`${String(vector.id)}: orphan embedding vector`);
  }
  for (const document of documents) {
    const documentId = String(document.id);
    const actualHash = sha256(document.content);
    if (actualHash !== document.content_sha256) {
      blockers.push(`${documentId}: stored content SHA-256 mismatch`);
      continue;
    }
    const documentJobs = jobsByDocument.get(documentId) ?? [];
    if (documentJobs.length !== 1) {
      blockers.push(`${documentId}: expected exactly one job, got ${documentJobs.length}`);
      continue;
    }
    const job = documentJobs[0]!;
    if (job.input_sha256 !== document.content_sha256) {
      blockers.push(`${String(job.id)}: job input SHA-256 mismatch`);
      continue;
    }
    const documentVectors = (vectorsByDocument.get(documentId) ?? []).sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    );
    for (const vector of documentVectors) {
      if (
        String(vector.embedding_space) !== String(space.id) ||
        vector.input_sha256 !== document.content_sha256
      ) blockers.push(`${String(vector.id)}: stale or cross-space vector`);
    }
    const exclusion = privacyExclusion({
      harness: document.harness,
      workspace: document.workspace,
      documentType: document.document_type,
      contentBytes: utf8Bytes(document.content),
    }, policy);
    const reason = exclusion ? privacyExclusionCode(exclusion) : undefined;
    const lastError = job.last_error?.trim() || undefined;
    const jobBinding: PrivacyReconciliationJobBinding = {
      jobId: String(job.id),
      documentId,
      inputSha256: job.input_sha256,
      status: job.status,
      createdAt: new Date(job.created_at).toISOString(),
      lastError,
    };
    const vectorBindings = documentVectors.map((vector) => ({
      vectorId: String(vector.id),
      documentId,
      embeddingSpaceId: String(vector.embedding_space),
      inputSha256: vector.input_sha256,
      dimensions: vector.dimensions,
    }));
    if (reason) {
      if (job.status === "processing") {
        blockers.push(`${String(job.id)}: processing job cannot be privacy-reconciled`);
      } else if (
        job.status !== "cancelled" || lastError !== reason || documentVectors.length > 0
      ) {
        if (job.status === "cancelled" && lastError && !PRIVACY_CANCELLATION_RE.test(lastError)) {
          blockers.push(`${String(job.id)}: cancelled with non-privacy reason ${lastError}`);
        } else {
          actions.push({
            kind: "cancel_privacy_excluded",
            documentId,
            contentSha256: document.content_sha256,
            job: jobBinding,
            exclusionReason: reason,
            vectors: vectorBindings,
          });
        }
      }
    } else if (job.status === "cancelled") {
      if (!lastError || !PRIVACY_CANCELLATION_RE.test(lastError)) {
        blockers.push(`${String(job.id)}: cancelled with unknown/operator reason ${lastError ?? "NONE"}`);
      } else {
        actions.push({
          kind: "requeue_privacy_allowed",
          documentId,
          contentSha256: document.content_sha256,
          job: jobBinding,
          vectors: vectorBindings,
        });
      }
    }
  }
  actions.sort((a, b) => a.job.jobId.localeCompare(b.job.jobId));
  blockers.sort();
  const binding = {
    formatVersion: 1 as const,
    space: {
      id: String(space.id),
      slug: space.slug,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
      physical_table: space.physical_table,
    },
    privacy: normalizedPrivacy(policy),
    documents: documents.length,
    jobs: jobs.length,
    vectors: vectors.length,
    actions,
    blockers,
  };
  const planSha256 = sha256Canonical(binding);
  return {
    ...binding,
    planSha256,
    confirmation: privacyPlanConfirmation(space.slug, planSha256),
  };
}

export function serializePrivacyReconciliationPlan(plan: PrivacyReconciliationPlan): string {
  validatePrivacyReconciliationPlan(plan);
  return `${JSON.stringify(canonicalize(plan), null, 2)}\n`;
}

export async function writePrivacyReconciliationPlan(
  filePath: string,
  plan: PrivacyReconciliationPlan,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await writePrivateFileAtomic(filePath, serializePrivacyReconciliationPlan(plan), options);
}

export async function loadPrivacyReconciliationPlan(
  filePath: string,
): Promise<PrivacyReconciliationPlan> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new Error("embedding_privacy_plan_read_error");
  }
  let plan: PrivacyReconciliationPlan;
  try {
    plan = JSON.parse(source) as PrivacyReconciliationPlan;
  } catch {
    throw new Error("embedding_privacy_plan_invalid_json");
  }
  validatePrivacyReconciliationPlan(plan);
  return plan;
}

export interface AppliedPrivacyReconciliation {
  planSha256: string;
  cancelled: number;
  requeued: number;
  vectorsDeleted: number;
  verified: true;
}

/** Apply only an unchanged signed-by-hash plan, then immediately re-audit. */
export async function applyPrivacyReconciliation(
  db: Surreal,
  approvedPlan: PrivacyReconciliationPlan,
  confirmation: string,
): Promise<AppliedPrivacyReconciliation> {
  validatePrivacyReconciliationPlan(approvedPlan);
  if (approvedPlan.blockers.length > 0) {
    throw new Error(`embedding privacy reconciliation blocked: ${approvedPlan.blockers.join("; ")}`);
  }
  if (confirmation !== approvedPlan.confirmation) {
    throw new Error("embedding privacy confirmation mismatch");
  }
  const current = await preparePrivacyReconciliation(
    db,
    approvedPlan.space.slug,
    approvedPlan.privacy,
  );
  if (current.planSha256 !== approvedPlan.planSha256) {
    throw new Error("embedding privacy plan drifted before mutation");
  }
  if (current.actions.length === 0) {
    return { planSha256: approvedPlan.planSha256, cancelled: 0, requeued: 0, vectorsDeleted: 0, verified: true };
  }
  const jobRows = await selectAll<{ id: RecordId }>(
    db,
    "SELECT id FROM embedding_job WHERE embedding_space = $space",
    { space: new RecordId("embedding_space", approvedPlan.space.slug) },
  );
  const jobIds = new Map(jobRows.map((row) => [String(row.id), row.id]));
  const vectorRows = await selectAll<{ id: RecordId }>(
    db,
    `SELECT id FROM ${approvedPlan.space.physical_table}`,
  );
  const vectorIds = new Map(vectorRows.map((row) => [String(row.id), row.id]));
  const statements = ["BEGIN;"];
  const vars: Record<string, unknown> = { now: new Date() };
  let vectorsDeleted = 0;
  current.actions.forEach((action, index) => {
    const jobId = jobIds.get(action.job.jobId);
    if (!jobId) throw new Error("embedding privacy job identity disappeared");
    vars[`job${index}`] = jobId;
    if (action.kind === "cancel_privacy_excluded") {
      vars[`reason${index}`] = action.exclusionReason;
      statements.push(
        `UPDATE ONLY $job${index} SET status = "cancelled", last_error = $reason${index}, ` +
          `attempts = 0, next_attempt_at = NONE, locked_by = NONE, locked_at = NONE, completed_at = $now;`,
      );
    } else {
      statements.push(
        `UPDATE ONLY $job${index} SET status = "pending", last_error = NONE, attempts = 0, ` +
          `next_attempt_at = NONE, locked_by = NONE, locked_at = NONE, completed_at = NONE;`,
      );
    }
    for (const vector of action.vectors) {
      const vectorId = vectorIds.get(vector.vectorId);
      if (!vectorId) throw new Error("embedding privacy vector identity disappeared");
      vars[`vector${vectorsDeleted}`] = vectorId;
      statements.push(`DELETE ONLY $vector${vectorsDeleted};`);
      vectorsDeleted += 1;
    }
  });
  statements.push("COMMIT;");
  await db.query(statements.join("\n"), vars);
  const verified = await preparePrivacyReconciliation(
    db,
    approvedPlan.space.slug,
    approvedPlan.privacy,
  );
  if (verified.blockers.length > 0 || verified.actions.length > 0) {
    throw new Error("embedding privacy immediate recheck failed");
  }
  return {
    planSha256: approvedPlan.planSha256,
    cancelled: current.actions.filter((item) => item.kind === "cancel_privacy_excluded").length,
    requeued: current.actions.filter((item) => item.kind === "requeue_privacy_allowed").length,
    vectorsDeleted,
    verified: true,
  };
}

function sanitizedPermanentError(raw: string): string {
  if (/^provider_(?:permanent_error|retry_exhausted|unexpected_error)$/.test(raw)) {
    return raw;
  }
  if (/^(?:vector_dimension_mismatch|provider_vector_count_mismatch) expected=\d+ actual=\d+$/.test(raw)) {
    return raw;
  }
  if (raw === "search_document_missing") return raw;
  return "permanent_error_detail_redacted";
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label}: ожидался SHA-256`);
}

const STORED_QUERY_LANGUAGES = ["ru", "en", "mixed"] as const;
const STORED_QUERY_TYPES = [
  "exact phrase", "russian morphology", "english technical", "function name", "model",
  "path", "semantic paraphrase", "mixed ru/en", "code error", "deleted dialogue",
] as const;

interface StrictExpectedDialogue {
  dialogueId: string;
  relevance: number;
}

interface StrictMustNotMatch {
  dialogueId?: string;
  snippet?: string;
}

interface StrictJudgmentQuery {
  id: string;
  query: string;
  expectedDialogues: StrictExpectedDialogue[];
  expectedSnippets: Array<{ text: string; dialogueId?: string }>;
  mustNotMatchExamples: StrictMustNotMatch[];
  queryLanguage: string;
  queryType: string;
  filters?: Record<string, string | boolean>;
}

interface StrictJudgmentSet {
  formatVersion: 1;
  name: string;
  queries: StrictJudgmentQuery[];
}

function strictObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function strictString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: expected string`);
  return value;
}

function strictArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
  return value;
}

/** Strict duplicate of the public judgment contract, kept cycle-free. */
function parseStrictJudgmentArtifact(source: string): {
  set: StrictJudgmentSet;
  canonicalSha256: string;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("relevance_judgment_set_invalid_json");
  }
  const root = strictObject(raw, "judgment set");
  if (root.formatVersion !== 1) throw new Error("judgment set formatVersion invalid");
  const rows = strictArray(root.queries, "judgment set queries");
  if (rows.length < 50 || rows.length > 100) {
    throw new Error("judgment set requires 50..100 queries");
  }
  const ids = new Set<string>();
  const allowedFilterKeys = new Set([
    "harness", "host", "user", "workspace", "vendor", "model", "reasoningEffort",
    "role", "documentType", "from", "to", "deletedOnly", "includeReasoning",
    "includeTools", "includeSystem", "allRevisions",
  ]);
  const booleanFilters = new Set([
    "deletedOnly", "includeReasoning", "includeTools", "includeSystem", "allRevisions",
  ]);
  const queries = rows.map((rawQuery, index): StrictJudgmentQuery => {
    const row = strictObject(rawQuery, `judgment query ${index}`);
    const id = strictString(row.id, `judgment query ${index}.id`);
    if (ids.has(id)) throw new Error("judgment set duplicate query id");
    ids.add(id);
    const expectedDialogues = strictArray(row.expectedDialogues, `${id}.expectedDialogues`)
      .map((item, itemIndex): StrictExpectedDialogue => {
        if (typeof item === "string") {
          return { dialogueId: strictString(item, `${id}.expectedDialogues.${itemIndex}`), relevance: 1 };
        }
        const expected = strictObject(item, `${id}.expectedDialogues.${itemIndex}`);
        if (!Number.isSafeInteger(expected.relevance ?? 1) || Number(expected.relevance ?? 1) < 1) {
          throw new Error(`${id}: expected dialogue relevance invalid`);
        }
        return {
          dialogueId: strictString(expected.dialogueId, `${id}.expected dialogue id`),
          relevance: Number(expected.relevance ?? 1),
        };
      });
    if (
      expectedDialogues.length === 0 ||
      new Set(expectedDialogues.map(({ dialogueId }) => dialogueId)).size !== expectedDialogues.length
    ) throw new Error(`${id}: expected dialogues invalid`);
    const expectedSnippets = strictArray(row.expectedSnippets, `${id}.expectedSnippets`)
      .map((item, itemIndex) => {
        if (typeof item === "string") {
          return { text: strictString(item, `${id}.expectedSnippets.${itemIndex}`) };
        }
        const expected = strictObject(item, `${id}.expectedSnippets.${itemIndex}`);
        return {
          text: strictString(expected.text, `${id}.expected snippet text`),
          dialogueId: expected.dialogueId === undefined
            ? undefined
            : strictString(expected.dialogueId, `${id}.expected snippet dialogue`),
        };
      });
    if (expectedSnippets.length === 0) throw new Error(`${id}: expected snippets missing`);
    const mustNotMatchExamples = strictArray(row.mustNotMatchExamples, `${id}.mustNotMatchExamples`)
      .map((item, itemIndex): StrictMustNotMatch => {
        if (typeof item === "string") {
          return { snippet: strictString(item, `${id}.mustNotMatchExamples.${itemIndex}`) };
        }
        const example = strictObject(item, `${id}.mustNotMatchExamples.${itemIndex}`);
        const parsed = {
          dialogueId: example.dialogueId === undefined
            ? undefined
            : strictString(example.dialogueId, `${id}.must-not dialogue`),
          snippet: example.snippet === undefined
            ? undefined
            : strictString(example.snippet, `${id}.must-not snippet`),
        };
        if (!parsed.dialogueId && !parsed.snippet) throw new Error(`${id}: empty must-not example`);
        return parsed;
      });
    if (mustNotMatchExamples.length === 0) throw new Error(`${id}: must-not examples missing`);
    const queryLanguage = strictString(row.queryLanguage, `${id}.queryLanguage`);
    const queryType = strictString(row.queryType, `${id}.queryType`);
    if (!STORED_QUERY_LANGUAGES.includes(queryLanguage as never)) {
      throw new Error(`${id}: query language invalid`);
    }
    if (!STORED_QUERY_TYPES.includes(queryType as never)) {
      throw new Error(`${id}: query type invalid`);
    }
    let filters: Record<string, string | boolean> | undefined;
    if (row.filters !== undefined) {
      const input = strictObject(row.filters, `${id}.filters`);
      filters = {};
      for (const [key, value] of Object.entries(input)) {
        if (!allowedFilterKeys.has(key)) throw new Error(`${id}: unknown filter ${key}`);
        if (booleanFilters.has(key)) {
          if (typeof value !== "boolean") throw new Error(`${id}: boolean filter invalid`);
          filters[key] = value;
        } else {
          const parsed = strictString(value, `${id}.filter.${key}`);
          if ((key === "from" || key === "to") && Number.isNaN(Date.parse(parsed))) {
            throw new Error(`${id}: date filter invalid`);
          }
          filters[key] = parsed;
        }
      }
    }
    return {
      id,
      query: strictString(row.query, `${id}.query`),
      expectedDialogues,
      expectedSnippets,
      mustNotMatchExamples,
      queryLanguage,
      queryType,
      filters,
    };
  });
  const set: StrictJudgmentSet = {
    formatVersion: 1,
    name: strictString(root.name, "judgment set name"),
    queries,
  };
  return { set, canonicalSha256: sha256Canonical(set) };
}

function normalizeExpectedJudgmentArtifactIdentity(
  value: ExpectedJudgmentArtifactIdentity | undefined,
): ExpectedJudgmentArtifactIdentity {
  if (!value || typeof value !== "object") {
    throw new Error("final relevance expected judgment artifact identity required");
  }
  const normalized = {
    resolvedPath: strictString(value.resolvedPath, "expected judgment resolvedPath"),
    realPath: strictString(value.realPath, "expected judgment realPath"),
    sha256: strictString(value.sha256, "expected judgment SHA-256"),
    sizeBytes: value.sizeBytes,
    device: strictString(value.device, "expected judgment device"),
    inode: strictString(value.inode, "expected judgment inode"),
  };
  if (
    !path.isAbsolute(normalized.resolvedPath) ||
    path.resolve(normalized.resolvedPath) !== normalized.resolvedPath ||
    !path.isAbsolute(normalized.realPath) || path.resolve(normalized.realPath) !== normalized.realPath ||
    !/^[0-9a-f]{64}$/.test(normalized.sha256) ||
    !Number.isSafeInteger(normalized.sizeBytes) || normalized.sizeBytes < 1 ||
    !/^\d+$/.test(normalized.device) || !/^\d+$/.test(normalized.inode)
  ) throw new Error("final relevance expected judgment artifact identity invalid");
  return normalized;
}

function sameOpenFileStat(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  return (
    before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mode === after.mode && before.nlink === after.nlink &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
  );
}

async function pinExpectedJudgmentArtifactWithSource(
  filePath: string,
  expectedSha256: string,
  expectedSizeBytes: number,
  delayMs = 0,
): Promise<{
  identity: ExpectedJudgmentArtifactIdentity;
  source: string;
}> {
  if (
    !filePath?.trim() || !/^[0-9a-f]{64}$/.test(expectedSha256) ||
    !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1 ||
    !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1_000
  ) throw new Error("expected judgment artifact path, SHA-256, or size invalid");
  const resolvedPath = path.resolve(filePath);
  let resolvedRealPath: string;
  try {
    resolvedRealPath = await realpath(resolvedPath);
  } catch {
    throw new Error("final_relevance_judgment_identity_path_error");
  }
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error("final_relevance_judgment_stable_open_error");
  }
  let sourceBytes: Buffer;
  let before: BigIntStats;
  let after: BigIntStats;
  try {
    before = await file.stat({ bigint: true });
    if (
      !before.isFile() || before.size !== BigInt(expectedSizeBytes)
    ) throw new Error("final relevance judgment artifact pinned size mismatch");
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    sourceBytes = await file.readFile();
    after = await file.stat({ bigint: true });
  } finally {
    await file.close();
  }
  if (!sameOpenFileStat(before!, after!)) {
    throw new Error("final relevance judgment artifact changed during read");
  }
  let pathStat: BigIntStats;
  let afterRealPath: string;
  try {
    [pathStat, afterRealPath] = await Promise.all([
      lstat(resolvedPath, { bigint: true }),
      realpath(resolvedPath),
    ]);
  } catch {
    throw new Error("final relevance judgment artifact path changed during read");
  }
  if (
    pathStat.isSymbolicLink() || !pathStat.isFile() ||
    pathStat.dev !== before!.dev || pathStat.ino !== before!.ino ||
    pathStat.size !== BigInt(expectedSizeBytes) || afterRealPath !== resolvedRealPath ||
    sourceBytes!.byteLength !== expectedSizeBytes ||
    createHash("sha256").update(sourceBytes!).digest("hex") !== expectedSha256
  ) throw new Error("final relevance judgment artifact identity mismatch");
  const source = sourceBytes!.toString("utf8");
  return {
    identity: {
      resolvedPath,
      realPath: resolvedRealPath,
      sha256: expectedSha256,
      sizeBytes: expectedSizeBytes,
      device: String(before!.dev),
      inode: String(before!.ino),
    },
    source,
  };
}

/**
 * Build the full stable identity from independently operator-pinned SHA/size.
 * Neither pin is ever derived from evidence, report, or the file itself.
 */
export async function pinExpectedJudgmentArtifact(
  filePath: string,
  expectedSha256: string,
  expectedSizeBytes: number,
): Promise<ExpectedJudgmentArtifactIdentity> {
  return (await pinExpectedJudgmentArtifactWithSource(
    filePath,
    expectedSha256,
    expectedSizeBytes,
  )).identity;
}

async function loadExternallyPinnedJudgmentArtifact(
  evidencePath: string,
  expectedInput: ExpectedJudgmentArtifactIdentity | undefined,
  delayMs = 0,
): Promise<{
  identity: ExpectedJudgmentArtifactIdentity;
  source: string;
  set: StrictJudgmentSet;
  canonicalSha256: string;
}> {
  const expected = normalizeExpectedJudgmentArtifactIdentity(expectedInput);
  if (path.resolve(evidencePath) !== expected.resolvedPath) {
    throw new Error("final relevance judgment artifact path mismatch");
  }
  const loaded = await pinExpectedJudgmentArtifactWithSource(
    expected.resolvedPath,
    expected.sha256,
    expected.sizeBytes,
    delayMs,
  );
  if (sha256Canonical(loaded.identity) !== sha256Canonical(expected)) {
    throw new Error("final relevance judgment artifact external identity mismatch");
  }
  const parsed = parseStrictJudgmentArtifact(loaded.source);
  return {
    identity: loaded.identity,
    source: loaded.source,
    set: parsed.set,
    canonicalSha256: parsed.canonicalSha256,
  };
}

interface StoredEvaluationScenario {
  id: string;
  mode: string;
  space?: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  resourceMeasurements?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  contentEvidence?: unknown[];
  aggregate: Record<string, unknown>;
  queries: Array<Record<string, unknown>>;
}

interface StoredEvaluationReport {
  formatVersion: number;
  generatedAt: string;
  judgmentSet: { artifactSha256: string; sha256: string; queries: number };
  corpus: { algorithm: string; sha256: string; documents: number };
  candidatePlan?: {
    artifactSha256: string;
    planSha256: string;
    corpusSha256: string;
    subsetSha256: string;
    privacySha256: string;
  };
  scenarios: StoredEvaluationScenario[];
}

interface StoredFullCorpusEvaluationReport {
  formatVersion: number;
  evaluationKind: string;
  generatedAt: string;
  judgmentSet: {
    artifactSha256: string;
    sha256: string;
    queries: number;
  };
  corpus: { algorithm: string; sha256: string; documents: number };
  corpusDocuments?: unknown[];
  privacySha256: string;
  selectedSpace: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  scenario: StoredEvaluationScenario & {
    corpusChecks?: {
      before?: { algorithm: string; sha256: string; documents: number };
      after?: { algorithm: string; sha256: string; documents: number };
    };
  };
}

function finiteRatio(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`relevance acceptance ${label}: expected finite ratio 0..1`);
  }
  return value;
}

function finiteCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`relevance acceptance ${label}: expected count >= 0`);
  }
  return Number(value);
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`relevance acceptance ${label}: expected finite number >= 0`);
  }
  return value;
}

function roundedMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sameMetric(actual: number, expected: number): boolean {
  // Report fields are rounded independently to six decimals.
  return Math.abs(actual - expected) <= 0.000001;
}

function normalizeStoredSnippet(value: string): string {
  return value
    .replaceAll(/<\/?em>/gi, "")
    .replaceAll("…", "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface StrictContentEvidence extends EvaluationCorpusDocumentBinding {
  content: string;
}

function parseDocumentBinding(
  value: unknown,
  label: string,
): EvaluationCorpusDocumentBinding {
  const item = strictObject(value, label);
  if (
    Object.keys(item).sort().join("\0") !==
      ["contentSha256", "dialogueId", "documentId", "revisionId"].join("\0")
  ) throw new Error(`${label}: document binding fields invalid`);
  const parsed = {
    documentId: strictString(item.documentId, `${label}.documentId`),
    dialogueId: strictString(item.dialogueId, `${label}.dialogueId`),
    revisionId: strictString(item.revisionId, `${label}.revisionId`),
    contentSha256: strictString(item.contentSha256, `${label}.contentSha256`),
  };
  if (!/^[0-9a-f]{64}$/.test(parsed.contentSha256)) {
    throw new Error(`${label}: content SHA-256 invalid`);
  }
  return parsed;
}

function parseAuthoritativeDocumentBindings(
  values: unknown,
  label: string,
): EvaluationCorpusDocumentBinding[] {
  const parsed = strictArray(values, label).map((value, index) =>
    parseDocumentBinding(value, `${label}.${index}`));
  const sorted = [...parsed].sort((a, b) => a.documentId.localeCompare(b.documentId));
  if (
    new Set(parsed.map((item) => item.documentId)).size !== parsed.length ||
    sha256Canonical(parsed) !== sha256Canonical(sorted)
  ) throw new Error(`${label}: document bindings must be unique and sorted`);
  return parsed;
}

function parseScenarioContentEvidence(
  scenario: StoredEvaluationScenario,
  authoritative: ReadonlyMap<string, EvaluationCorpusDocumentBinding>,
): ReadonlyMap<string, StrictContentEvidence> {
  const label = `relevance scenario ${scenario.id}`;
  const proof = strictArray(scenario.contentEvidence, `${label}.contentEvidence`).map(
    (value, index): StrictContentEvidence => {
      const item = strictObject(value, `${label}.contentEvidence.${index}`);
      if (
        Object.keys(item).sort().join("\0") !==
          ["content", "contentSha256", "dialogueId", "documentId", "revisionId"].join("\0")
      ) throw new Error(`${label}: content evidence fields invalid`);
      const binding = parseDocumentBinding({
        documentId: item.documentId,
        dialogueId: item.dialogueId,
        revisionId: item.revisionId,
        contentSha256: item.contentSha256,
      }, `${label}.contentEvidence.${index}.binding`);
      if (typeof item.content !== "string" || sha256(item.content) !== binding.contentSha256) {
        throw new Error(`${label}: authoritative content bytes mismatch`);
      }
      const expected = authoritative.get(binding.documentId);
      if (!expected || sha256Canonical(expected) !== sha256Canonical(binding)) {
        throw new Error(`${label}: content evidence differs from authoritative corpus`);
      }
      return { ...binding, content: item.content };
    },
  );
  const byDocument = new Map(proof.map((item) => [item.documentId, item]));
  const referenced = new Set<string>();
  for (const [queryIndex, query] of scenario.queries.entries()) {
    for (const [hitIndex, raw] of strictArray(
      query.hitEvidence,
      `${label}.queries.${queryIndex}.hitEvidence`,
    ).entries()) {
      const hit = parseDocumentBinding(raw, `${label}.queries.${queryIndex}.hitEvidence.${hitIndex}`);
      const exact = byDocument.get(hit.documentId);
      if (!exact || sha256Canonical(hit) !== sha256Canonical({
        documentId: exact.documentId,
        dialogueId: exact.dialogueId,
        revisionId: exact.revisionId,
        contentSha256: exact.contentSha256,
      })) throw new Error(`${label}: hit content evidence missing or inconsistent`);
      referenced.add(hit.documentId);
    }
  }
  if (
    byDocument.size !== proof.length || referenced.size !== byDocument.size ||
    [...byDocument.keys()].some((documentId) => !referenced.has(documentId))
  ) throw new Error(`${label}: unrelated, duplicate, or missing content evidence`);
  return byDocument;
}

function reportPercentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? sorted.at(-1) ?? 0;
}

function reportLatencySummary(values: readonly number[]): Record<string, number> {
  return {
    mean: roundedMetric(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: roundedMetric(reportPercentile(values, 0.5)),
    p95: roundedMetric(reportPercentile(values, 0.95)),
    max: roundedMetric(Math.max(...values)),
  };
}

function assertQueryMetricIdentities(
  scenarioId: string,
  query: Record<string, unknown>,
): void {
  const queryId = String(query.queryId ?? "");
  const label = `${scenarioId}.${queryId}`;
  if (
    ![
      "exact phrase", "russian morphology", "english technical", "function name", "model",
      "path", "semantic paraphrase", "mixed ru/en", "code error", "deleted dialogue",
    ].includes(String(query.queryType)) ||
    !["ru", "en", "mixed"].includes(String(query.queryLanguage))
  ) throw new Error(`relevance evaluation query ${label}: class/language invalid`);
  const recallAt5 = finiteRatio(query.recallAt5, `${label}.recallAt5`);
  const recallAt10 = finiteRatio(query.recallAt10, `${label}.recallAt10`);
  const mrr = finiteRatio(query.mrr, `${label}.mrr`);
  const ndcgAt10 = finiteRatio(query.ndcgAt10, `${label}.ndcgAt10`);
  const irrelevantTop5Share = finiteRatio(
    query.irrelevantTop5Share,
    `${label}.irrelevantTop5Share`,
  );
  const relevantFoundAt5 = finiteCount(query.relevantFoundAt5, `${label}.relevantFoundAt5`);
  const relevantFoundAt10 = finiteCount(query.relevantFoundAt10, `${label}.relevantFoundAt10`);
  const relevantTotal = finiteCount(query.relevantTotal, `${label}.relevantTotal`);
  const returnedDialogues = finiteCount(query.returnedDialogues, `${label}.returnedDialogues`);
  const distinctDialoguesRanked = finiteCount(
    query.distinctDialoguesRanked,
    `${label}.distinctDialoguesRanked`,
  );
  const dialogueCandidateShortfall = finiteCount(
    query.dialogueCandidateShortfall,
    `${label}.dialogueCandidateShortfall`,
  );
  const matchedExpectedSnippets = finiteCount(
    query.matchedExpectedSnippets,
    `${label}.matchedExpectedSnippets`,
  );
  const expectedSnippetsTotal = finiteCount(
    query.expectedSnippetsTotal,
    `${label}.expectedSnippetsTotal`,
  );
  const mustNotMatchViolations = finiteCount(
    query.mustNotMatchViolations,
    `${label}.mustNotMatchViolations`,
  );
  const mustNotExamplesTotal = finiteCount(
    query.mustNotExamplesTotal,
    `${label}.mustNotExamplesTotal`,
  );
  const latencyMs = finiteNonNegative(query.latencyMs, `${label}.latencyMs`);
  const providerLatencyMs = finiteNonNegative(
    query.providerLatencyMs,
    `${label}.providerLatencyMs`,
  );
  const retrievalLatencyMs = finiteNonNegative(
    query.retrievalLatencyMs,
    `${label}.retrievalLatencyMs`,
  );
  const dcgAt10 = finiteNonNegative(query.dcgAt10, `${label}.dcgAt10`);
  const idealDcgAt10 = finiteNonNegative(query.idealDcgAt10, `${label}.idealDcgAt10`);
  const firstRelevantRank = query.firstRelevantRank;
  if (
    firstRelevantRank !== null &&
    (!Number.isSafeInteger(firstRelevantRank) || Number(firstRelevantRank) < 1 ||
      Number(firstRelevantRank) > returnedDialogues)
  ) throw new Error(`relevance acceptance ${label}.firstRelevantRank invalid`);
  if (typeof query.retrievalFailed !== "boolean") {
    throw new Error(`relevance acceptance ${label}.retrievalFailed invalid`);
  }
  if (
    relevantTotal < 1 || relevantFoundAt5 > Math.min(5, relevantTotal) ||
    relevantFoundAt10 < relevantFoundAt5 || relevantFoundAt10 > Math.min(10, relevantTotal) ||
    !sameMetric(recallAt5, relevantFoundAt5 / relevantTotal) ||
    !sameMetric(recallAt10, relevantFoundAt10 / relevantTotal) || recallAt10 < recallAt5
  ) throw new Error(`relevance evaluation query ${label}: recall identity mismatch`);
  if (
    distinctDialoguesRanked !== Math.min(10, returnedDialogues) ||
    dialogueCandidateShortfall !== Math.max(0, 10 - returnedDialogues) ||
    query.retrievalFailed !== (returnedDialogues === 0)
  ) throw new Error(`relevance evaluation query ${label}: retrieval identity mismatch`);
  const topDialogueIds = query.topDialogueIds;
  if (
    !Array.isArray(topDialogueIds) || topDialogueIds.length !== distinctDialoguesRanked ||
    topDialogueIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(topDialogueIds).size !== topDialogueIds.length
  ) throw new Error(`relevance evaluation query ${label}: top dialogue ids invalid`);
  const expectedMrr = firstRelevantRank === null ? 0 : 1 / Number(firstRelevantRank);
  if (
    !sameMetric(mrr, expectedMrr) ||
    (relevantFoundAt5 > 0) !== (firstRelevantRank !== null && Number(firstRelevantRank) <= 5) ||
    (relevantFoundAt10 > 0) !== (firstRelevantRank !== null && Number(firstRelevantRank) <= 10)
  ) throw new Error(`relevance evaluation query ${label}: MRR identity mismatch`);
  if (
    idealDcgAt10 <= 0 || dcgAt10 > idealDcgAt10 + 1e-9 ||
    !sameMetric(ndcgAt10, dcgAt10 / idealDcgAt10)
  ) throw new Error(`relevance evaluation query ${label}: nDCG identity mismatch`);
  const top5Returned = Math.min(5, returnedDialogues);
  const expectedIrrelevantShare = top5Returned === 0
    ? 1
    : (top5Returned - relevantFoundAt5) / top5Returned;
  if (!sameMetric(irrelevantTop5Share, expectedIrrelevantShare)) {
    throw new Error(`relevance evaluation query ${label}: irrelevant share identity mismatch`);
  }
  if (
    expectedSnippetsTotal < 1 || matchedExpectedSnippets > expectedSnippetsTotal ||
    mustNotExamplesTotal < 1 || mustNotMatchViolations > mustNotExamplesTotal
  ) throw new Error(`relevance evaluation query ${label}: example count relation invalid`);
  if (!sameMetric(latencyMs, roundedMetric(providerLatencyMs + retrievalLatencyMs))) {
    throw new Error(`relevance evaluation query ${label}: latency identity mismatch`);
  }
}

function assertQueryMatchesJudgment(
  scenarioId: string,
  query: Record<string, unknown>,
  judgment: StrictJudgmentQuery,
  contentByDocument: ReadonlyMap<string, StrictContentEvidence>,
): void {
  assertQueryMetricIdentities(scenarioId, query);
  const label = `${scenarioId}.${judgment.id}`;
  if (
    query.queryId !== judgment.id || query.queryType !== judgment.queryType ||
    query.queryLanguage !== judgment.queryLanguage ||
    query.querySha256 !== sha256(judgment.query) ||
    query.filtersSha256 !== sha256Canonical(judgment.filters ?? {})
  ) throw new Error(`relevance evaluation query ${label}: judgment binding mismatch`);

  const topDialogueIds = query.topDialogueIds as string[];
  const hitEvidence = strictArray(query.hitEvidence, `${label}.hitEvidence`).map((raw, index) =>
    parseDocumentBinding(raw, `${label}.hitEvidence.${index}`));
  const evidenceDialogueIds = [...new Set(hitEvidence.map((item) => item.dialogueId))];
  if (
    query.returnedDialogues !== evidenceDialogueIds.length ||
    sha256Canonical(topDialogueIds) !== sha256Canonical(evidenceDialogueIds.slice(0, 10))
  ) throw new Error(`relevance evaluation query ${label}: hit ranking evidence mismatch`);
  const relevance = new Map(
    judgment.expectedDialogues.map((item) => [item.dialogueId, item.relevance]),
  );
  const relevantFoundAt5 = topDialogueIds.slice(0, 5)
    .filter((id) => relevance.has(id)).length;
  const relevantFoundAt10 = topDialogueIds.slice(0, 10)
    .filter((id) => relevance.has(id)).length;
  const firstRelevantIndex = topDialogueIds.slice(0, 10)
    .findIndex((id) => relevance.has(id));
  const firstRelevantRank = firstRelevantIndex < 0 ? null : firstRelevantIndex + 1;
  const dcgAt10 = topDialogueIds.slice(0, 10).reduce((sum, id, index) => {
    const grade = relevance.get(id) ?? 0;
    return sum + (2 ** grade - 1) / Math.log2(index + 2);
  }, 0);
  const idealDcgAt10 = [...relevance.values()]
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const top5 = topDialogueIds.slice(0, 5);
  const irrelevantTop5Share = top5.length === 0
    ? 1
    : top5.filter((id) => !relevance.has(id)).length / top5.length;
  const exactMetrics: Array<[string, number]> = [
    ["relevantFoundAt5", relevantFoundAt5],
    ["relevantFoundAt10", relevantFoundAt10],
    ["relevantTotal", relevance.size],
  ];
  if (exactMetrics.some(([name, value]) => query[name] !== value)) {
    throw new Error(`relevance evaluation query ${label}: judgment count mismatch`);
  }
  if (query.firstRelevantRank !== firstRelevantRank) {
    throw new Error(`relevance evaluation query ${label}: judgment rank mismatch`);
  }
  const derivedMetrics: Array<[string, number]> = [
    ["recallAt5", relevantFoundAt5 / relevance.size],
    ["recallAt10", relevantFoundAt10 / relevance.size],
    ["mrr", firstRelevantRank === null ? 0 : 1 / firstRelevantRank],
    ["dcgAt10", dcgAt10],
    ["idealDcgAt10", idealDcgAt10],
    ["ndcgAt10", idealDcgAt10 === 0 ? 0 : dcgAt10 / idealDcgAt10],
    ["irrelevantTop5Share", irrelevantTop5Share],
  ];
  if (derivedMetrics.some(([name, value]) => !sameMetric(Number(query[name]), value))) {
    throw new Error(`relevance evaluation query ${label}: judgment metric mismatch`);
  }
  if (
    query.expectedSnippetsTotal !== judgment.expectedSnippets.length ||
    query.mustNotExamplesTotal !== judgment.mustNotMatchExamples.length
  ) throw new Error(`relevance evaluation query ${label}: judgment example count mismatch`);
  const expectedSnippetMatches = judgment.expectedSnippets.filter((expected) => {
    const needle = normalizeStoredSnippet(expected.text);
    return hitEvidence.some((hit) =>
      (!expected.dialogueId || expected.dialogueId === hit.dialogueId) &&
      normalizeStoredSnippet(contentByDocument.get(hit.documentId)?.content ?? "")
        .includes(needle));
  }).length;
  if (query.matchedExpectedSnippets !== expectedSnippetMatches) {
    throw new Error(`relevance evaluation query ${label}: expected snippet evidence mismatch`);
  }

  const outcomes = query.mustNotMatchOutcomes;
  if (
    !Array.isArray(outcomes) || outcomes.length !== judgment.mustNotMatchExamples.length ||
    outcomes.some((value) => typeof value !== "boolean") ||
    outcomes.filter(Boolean).length !== query.mustNotMatchViolations
  ) throw new Error(`relevance evaluation query ${label}: must-not outcomes invalid`);
  for (let index = 0; index < judgment.mustNotMatchExamples.length; index += 1) {
    const example = judgment.mustNotMatchExamples[index]!;
    const outcome = outcomes[index];
    const expectedOutcome = hitEvidence
      .filter((hit) => topDialogueIds.includes(hit.dialogueId))
      .some((hit) =>
        (!example.dialogueId || example.dialogueId === hit.dialogueId) &&
        (!example.snippet ||
          normalizeStoredSnippet(contentByDocument.get(hit.documentId)?.content ?? "")
            .includes(normalizeStoredSnippet(example.snippet))));
    if (outcome !== expectedOutcome) {
      throw new Error(`relevance evaluation query ${label}: must-not outcome mismatch`);
    }
  }
}

function recomputeStoredAggregate(
  queries: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const sum = (field: string) => queries.reduce((total, query) => total + Number(query[field]), 0);
  const mean = (field: string) => roundedMetric(sum(field) / queries.length);
  const expectedSnippetsTotal = sum("expectedSnippetsTotal");
  return {
    queries: queries.length,
    recallAt5: mean("recallAt5"),
    recallAt10: mean("recallAt10"),
    mrr: mean("mrr"),
    ndcgAt10: mean("ndcgAt10"),
    irrelevantTop5Share: mean("irrelevantTop5Share"),
    relevantFoundAt5: sum("relevantFoundAt5"),
    relevantFoundAt10: sum("relevantFoundAt10"),
    relevantTotal: sum("relevantTotal"),
    latencyMs: reportLatencySummary(queries.map((query) => Number(query.latencyMs))),
    providerLatencyMs: reportLatencySummary(
      queries.map((query) => Number(query.providerLatencyMs)),
    ),
    retrievalLatencyMs: reportLatencySummary(
      queries.map((query) => Number(query.retrievalLatencyMs)),
    ),
    expectedSnippetRecall: expectedSnippetsTotal === 0
      ? 1
      : roundedMetric(sum("matchedExpectedSnippets") / expectedSnippetsTotal),
    mustNotMatchViolations: sum("mustNotMatchViolations"),
    retrievalFailures: queries.filter((query) => query.retrievalFailed === true).length,
    dialogueCandidateShortfallQueries: queries.filter(
      (query) => Number(query.dialogueCandidateShortfall) > 0,
    ).length,
  };
}

function assertCompleteEvaluationReport(report: StoredEvaluationReport): void {
  if (
    report.formatVersion !== 1 || Number.isNaN(Date.parse(report.generatedAt)) ||
    !/^[0-9a-f]{64}$/.test(report.judgmentSet?.artifactSha256) ||
    !/^[0-9a-f]{64}$/.test(report.judgmentSet?.sha256) ||
    !Number.isSafeInteger(report.judgmentSet?.queries) ||
    report.judgmentSet.queries < 50 || report.judgmentSet.queries > 100 ||
    report.corpus?.algorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(report.corpus?.sha256) ||
    !Number.isSafeInteger(report.corpus?.documents) || report.corpus.documents < 1 ||
    !Array.isArray(report.scenarios)
  ) {
    throw new Error("relevance evaluation report metadata invalid");
  }
  if (
    !report.candidatePlan || !/^[0-9a-f]{64}$/.test(report.candidatePlan.artifactSha256) ||
    !/^[0-9a-f]{64}$/.test(report.candidatePlan.planSha256) ||
    report.candidatePlan.corpusSha256 !== report.corpus.sha256 ||
    !/^[0-9a-f]{64}$/.test(report.candidatePlan.subsetSha256) ||
    !/^[0-9a-f]{64}$/.test(report.candidatePlan.privacySha256)
  ) {
    throw new Error("relevance evaluation report is not bound to a candidate plan");
  }
  const expectedSpaces = new Set([
    "text-embedding-3-small@1536",
    "text-embedding-3-large@1024",
    "text-embedding-3-large@3072",
  ]);
  if (report.scenarios.length !== 7 || report.scenarios.filter((row) => row.mode === "text").length !== 1) {
    throw new Error("relevance evaluation report matrix incomplete");
  }
  const scenarioIds = new Set<string>();
  let queryIds: string[] | undefined;
  for (const scenario of report.scenarios) {
    if (!scenario.id?.trim() || scenarioIds.has(scenario.id)) {
      throw new Error("relevance evaluation report scenario ids invalid");
    }
    scenarioIds.add(scenario.id);
    if (!Array.isArray(scenario.queries) || scenario.queries.length !== report.judgmentSet.queries) {
      throw new Error(`relevance evaluation scenario ${scenario.id}: incomplete queries`);
    }
    const ids = scenario.queries.map((query) => String(query.queryId ?? ""));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new Error(`relevance evaluation scenario ${scenario.id}: query ids invalid`);
    }
    if (queryIds && JSON.stringify(ids) !== JSON.stringify(queryIds)) {
      throw new Error("relevance evaluation scenario query matrix differs");
    }
    queryIds ??= ids;
    const types = new Set(scenario.queries.map((query) => query.queryType));
    const languages = new Set(scenario.queries.map((query) => query.queryLanguage));
    for (const type of [
      "exact phrase", "russian morphology", "english technical", "function name", "model",
      "path", "semantic paraphrase", "mixed ru/en", "code error", "deleted dialogue",
    ]) if (!types.has(type)) throw new Error(`relevance evaluation missing query type ${type}`);
    for (const language of ["ru", "en", "mixed"]) {
      if (!languages.has(language)) throw new Error(`relevance evaluation missing language ${language}`);
    }
    for (const query of scenario.queries) {
      for (const name of ["recallAt5", "recallAt10", "mrr", "ndcgAt10", "irrelevantTop5Share"]) {
        finiteRatio(query[name], `${scenario.id}.${String(query.queryId)}.${name}`);
      }
      assertQueryMetricIdentities(scenario.id, query);
    }
    for (const name of [
      "recallAt5", "recallAt10", "mrr", "ndcgAt10", "irrelevantTop5Share",
      "expectedSnippetRecall",
    ]) finiteRatio(scenario.aggregate?.[name], `${scenario.id}.${name}`);
    for (const name of ["queries", "mustNotMatchViolations", "retrievalFailures"]) {
      finiteCount(scenario.aggregate?.[name], `${scenario.id}.${name}`);
    }
    for (const name of [
      "relevantFoundAt5", "relevantFoundAt10", "relevantTotal",
      "dialogueCandidateShortfallQueries",
    ]) finiteCount(scenario.aggregate?.[name], `${scenario.id}.${name}`);
    for (const group of ["latencyMs", "providerLatencyMs", "retrievalLatencyMs"]) {
      const values = scenario.aggregate?.[group] as Record<string, unknown> | undefined;
      for (const name of ["mean", "p50", "p95", "max"]) {
        const value = values?.[name];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new Error(`relevance acceptance ${scenario.id}.${group}.${name} invalid`);
        }
      }
    }
    if (scenario.aggregate.queries !== report.judgmentSet.queries) {
      throw new Error(`relevance evaluation scenario ${scenario.id}: aggregate query count mismatch`);
    }
    if (sha256Canonical(scenario.aggregate) !== sha256Canonical(recomputeStoredAggregate(scenario.queries))) {
      throw new Error(`relevance evaluation scenario ${scenario.id}: aggregate mismatch`);
    }
    if (scenario.mode === "text") continue;
    const key = `${scenario.space?.model}@${scenario.space?.dimensions}`;
    if (!expectedSpaces.has(key)) throw new Error(`relevance evaluation unexpected space ${key}`);
    for (const name of ["vectorIndexBytes", "peakRamBytes", "indexBuildMs"]) {
      const value = scenario.resourceMeasurements?.[name];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`relevance evaluation ${scenario.id}: invalid resource metric`);
      }
    }
    if (!scenario.resourceMeasurements || !scenario.readiness) {
      throw new Error(`relevance evaluation ${scenario.id}: readiness/resources missing`);
    }
    if (typeof scenario.resourceMeasurements.source !== "string" ||
        !scenario.resourceMeasurements.source.trim()) {
      throw new Error(`relevance evaluation ${scenario.id}: resource source missing`);
    }
    const readiness = scenario.readiness;
    for (const name of [
      "documents", "jobs", "completedJobs", "vectors", "jobCoverageErrors",
      "vectorCoverageErrors", "inputHashErrors", "expectedDimensions",
      "wrongDimensionVectors", "privacyNormalizedDocuments",
      "privacyExcludedDocuments", "permanentExcludedDocuments", "eligibleDocuments",
    ]) finiteCount(readiness[name], `${scenario.id}.readiness.${name}`);
    if (
      readiness.jobs !== readiness.documents ||
      readiness.completedJobs !== readiness.eligibleDocuments ||
      readiness.vectors !== readiness.eligibleDocuments ||
      readiness.jobCoverageErrors !== 0 || readiness.vectorCoverageErrors !== 0 ||
      readiness.inputHashErrors !== 0 || readiness.wrongDimensionVectors !== 0 ||
      readiness.expectedDimensions !== scenario.space?.dimensions ||
      readiness.hnswUsesKnnScan !== true || typeof readiness.hnswIndexName !== "string" ||
      !readiness.hnswIndexName.trim() || !Array.isArray(readiness.exclusions)
    ) throw new Error(`relevance evaluation ${scenario.id}: readiness invalid`);
    let privacyExcluded = 0;
    let permanentExcluded = 0;
    const exclusionIdentities = new Set<string>();
    for (const raw of readiness.exclusions as unknown[]) {
      const exclusion = raw as Record<string, unknown>;
      if (
        !exclusion || !["privacy", "permanent"].includes(String(exclusion.category)) ||
        typeof exclusion.code !== "string" || !exclusion.code.trim() ||
        typeof exclusion.jobId !== "string" || !exclusion.jobId.trim() ||
        typeof exclusion.documentId !== "string" || !exclusion.documentId.trim() ||
        typeof exclusion.evidence !== "string" || !exclusion.evidence.trim()
      ) throw new Error(`relevance evaluation ${scenario.id}: exclusion invalid`);
      const stable = exclusion.category === "privacy"
        ? /^privacy_excluded_(?:harness|workspace|document_type|document_size|policy)$/.test(exclusion.code)
        : /^provider_(?:permanent_error|retry_exhausted|unexpected_error)$|^(?:vector_dimension_mismatch|provider_vector_count_mismatch)(?: expected=\d+ actual=\d+)?$|^(?:search_document_missing|permanent_error_detail_redacted)$/.test(exclusion.code);
      if (!stable) throw new Error(`relevance evaluation ${scenario.id}: exclusion code unstable`);
      const identity = `${exclusion.jobId}\0${exclusion.documentId}`;
      if (exclusionIdentities.has(identity)) {
        throw new Error(`relevance evaluation ${scenario.id}: duplicate exclusion identity`);
      }
      exclusionIdentities.add(identity);
      if (exclusion.category === "privacy") privacyExcluded += 1;
      else permanentExcluded += 1;
    }
    if (
      Number(readiness.privacyExcludedDocuments) !== privacyExcluded ||
      Number(readiness.permanentExcludedDocuments) !== permanentExcluded ||
      Number(readiness.privacyNormalizedDocuments) + privacyExcluded !==
        Number(readiness.documents) ||
      Number(readiness.eligibleDocuments) + permanentExcluded !==
        Number(readiness.privacyNormalizedDocuments)
    ) {
      throw new Error(`relevance evaluation ${scenario.id}: exclusions do not reconcile`);
    }
  }
  for (const key of expectedSpaces) {
    const vectors = report.scenarios.filter((row) =>
      `${row.space?.model}@${row.space?.dimensions}` === key && row.mode === "vector");
    const hybrids = report.scenarios.filter((row) =>
      `${row.space?.model}@${row.space?.dimensions}` === key && row.mode === "hybrid");
    if (vectors.length !== 1 || hybrids.length !== 1) {
      throw new Error(`relevance evaluation matrix missing ${key}`);
    }
    if (
      vectors[0]!.space?.slug !== hybrids[0]!.space?.slug ||
      sha256Canonical(vectors[0]!.readiness) !== sha256Canonical(hybrids[0]!.readiness) ||
      sha256Canonical(vectors[0]!.resourceMeasurements) !==
        sha256Canonical(hybrids[0]!.resourceMeasurements)
    ) throw new Error(`relevance evaluation matrix evidence differs for ${key}`);
  }
}

async function validateAcceptedRelevance(
  evidence: AcceptedRelevanceEvidence,
  exactReport: ExactTokenCountReport,
  space: EmbeddingSpace,
  privacy: PrivacyPolicy,
): Promise<string> {
  if (!evidence || evidence.formatVersion !== 2) {
    throw new Error("production backfill requires accepted relevance evidence");
  }
  assertSha256(evidence.evaluationReportSha256, "relevance evaluationReportSha256");
  assertSha256(evidence.judgmentSetArtifactSha256, "relevance judgmentSetArtifactSha256");
  assertSha256(evidence.judgmentSetSha256, "relevance judgmentSetSha256");
  assertSha256(evidence.corpusFingerprintSha256, "relevance corpusFingerprintSha256");
  assertSha256(evidence.candidatePlanArtifactSha256, "relevance candidatePlanArtifactSha256");
  assertSha256(evidence.candidatePlanSha256, "relevance candidatePlanSha256");
  assertSha256(evidence.privacySha256, "relevance privacySha256");
  if (
    !evidence.evaluationReportPath?.trim() || !evidence.judgmentSetPath?.trim() ||
    !evidence.candidatePlanPath?.trim()
  ) {
    throw new Error("relevance evidence: artifact paths incomplete");
  }
  if (evidence.scenarioId !== `hybrid:${space.slug}`) {
    throw new Error("relevance evidence requires selected hybrid candidate space");
  }
  if (evidence.corpusFingerprintSha256 !== exactReport.corpus.fingerprintSha256) {
    throw new Error("relevance evidence corpus не совпадает с exact token corpus");
  }
  for (const key of ["slug", "provider", "model", "dimensions"] as const) {
    if (evidence.space?.[key] !== space[key]) {
      throw new Error(`relevance evidence space.${key} не совпадает с selected space`);
    }
  }
  const human = evidence.humanAcceptance;
  if (
    human?.accepted !== true || !human.acceptedBy?.trim() || !human.rationale?.trim() ||
    Number.isNaN(Date.parse(human.acceptedAt))
  ) {
    throw new Error("relevance evidence: explicit human acceptance incomplete");
  }
  const thresholds = evidence.thresholds;
  if (!thresholds) throw new Error("relevance evidence: metric thresholds missing");
  for (const name of [
    "minimumRecallAt5", "minimumRecallAt10", "minimumMrr", "minimumNdcgAt10",
    "minimumExpectedSnippetRecall", "maximumIrrelevantTop5Share",
  ] as const) finiteRatio(thresholds[name], name);
  for (const name of ["maximumMustNotMatchViolations", "maximumRetrievalFailures"] as const) {
    finiteCount(thresholds[name], name);
  }
  let source: string;
  try {
    source = await readFile(evidence.evaluationReportPath, "utf8");
  } catch {
    throw new Error("relevance_evaluation_report_read_error");
  }
  if (sha256(source) !== evidence.evaluationReportSha256) {
    throw new Error("relevance evaluation report SHA-256 mismatch");
  }
  let judgmentSource: string;
  try {
    judgmentSource = await readFile(evidence.judgmentSetPath, "utf8");
  } catch {
    throw new Error("relevance_judgment_set_read_error");
  }
  if (sha256(judgmentSource) !== evidence.judgmentSetArtifactSha256) {
    throw new Error("relevance judgment set artifact SHA-256 mismatch");
  }
  const parsedJudgment = parseStrictJudgmentArtifact(judgmentSource);
  if (parsedJudgment.canonicalSha256 !== evidence.judgmentSetSha256) {
    throw new Error("relevance judgment set canonical SHA-256 mismatch");
  }
  const judgmentQueries = parsedJudgment.set.queries;
  const expectedDialogueIds = new Set<string>();
  const judgmentBindings = new Map<string, StrictJudgmentQuery>();
  for (const query of judgmentQueries) {
    judgmentBindings.set(query.id, query);
    for (const item of query.expectedDialogues) expectedDialogueIds.add(item.dialogueId);
  }
  const candidateArtifact = await loadEvaluationCandidatePlanArtifact(
    evidence.candidatePlanPath,
  );
  if (
    candidateArtifact.artifactSha256 !== evidence.candidatePlanArtifactSha256 ||
    candidateArtifact.plan.planSha256 !== evidence.candidatePlanSha256 ||
    candidateArtifact.plan.blockers.length > 0 ||
    candidateArtifact.plan.requiredDialogueIdsSha256 !==
      sha256Canonical([...expectedDialogueIds].sort()) ||
    candidateArtifact.plan.fullEligibleCorpus.sha256 !== evidence.corpusFingerprintSha256 ||
    sha256Canonical(candidateArtifact.plan.privacy) !== sha256Canonical(normalizedPrivacy(privacy))
  ) {
    throw new Error("relevance candidate plan artifact or judgment coverage mismatch");
  }
  const candidateDialogueIds = new Set(
    candidateArtifact.plan.subset.documents.map((document) => document.dialogueId),
  );
  if ([...expectedDialogueIds].some((id) => !candidateDialogueIds.has(id))) {
    throw new Error("relevance candidate plan omits required judgment dialogue");
  }
  const exactDocuments = new Map(exactReport.documents.map((document) => [document.id, document]));
  if (candidateArtifact.plan.subset.documents.some((document) =>
    exactDocuments.get(document.documentId)?.contentSha256 !== document.contentSha256)) {
    throw new Error("relevance candidate plan content differs from exact corpus report");
  }
  const candidateDocuments = new Map(
    candidateArtifact.plan.subset.documents.map((document) => [
      document.documentId,
      {
        documentId: document.documentId,
        dialogueId: document.dialogueId,
        revisionId: document.revisionId,
        contentSha256: document.contentSha256,
      },
    ] as const),
  );
  let report: StoredEvaluationReport;
  try {
    report = JSON.parse(source) as StoredEvaluationReport;
  } catch {
    throw new Error("relevance_evaluation_report_invalid_json");
  }
  assertCompleteEvaluationReport(report);
  for (const scenario of report.scenarios) {
    const contentByDocument = parseScenarioContentEvidence(scenario, candidateDocuments);
    for (const query of scenario.queries) {
      const binding = judgmentBindings.get(String(query.queryId));
      if (!binding) throw new Error("relevance report query absent from judgment artifact");
      assertQueryMatchesJudgment(scenario.id, query, binding, contentByDocument);
    }
  }
  if (
    report.judgmentSet.sha256 !== evidence.judgmentSetSha256 ||
    report.judgmentSet.artifactSha256 !== evidence.judgmentSetArtifactSha256 ||
    report.judgmentSet.queries !== judgmentQueries.length ||
    report.corpus.sha256 !== evidence.corpusFingerprintSha256 ||
    report.candidatePlan?.artifactSha256 !== evidence.candidatePlanArtifactSha256 ||
    report.candidatePlan?.planSha256 !== evidence.candidatePlanSha256 ||
    report.candidatePlan?.privacySha256 !== evidence.privacySha256 ||
    evidence.privacySha256 !== sha256Canonical(normalizedPrivacy(privacy))
  ) {
    throw new Error("relevance evidence digest does not match evaluation report");
  }
  const selected = report.scenarios.find((scenario) => scenario.id === evidence.scenarioId);
  if (!selected || selected.mode !== "hybrid") {
    throw new Error("selected hybrid relevance scenario missing from report");
  }
  for (const key of ["slug", "provider", "model", "dimensions"] as const) {
    if (selected.space?.[key] !== space[key]) {
      throw new Error(`selected evaluation space.${key} mismatch`);
    }
  }
  const metric = (name: string) => Number(selected.aggregate[name]);
  if (
    metric("recallAt5") < thresholds.minimumRecallAt5 ||
    metric("recallAt10") < thresholds.minimumRecallAt10 ||
    metric("mrr") < thresholds.minimumMrr ||
    metric("ndcgAt10") < thresholds.minimumNdcgAt10 ||
    metric("expectedSnippetRecall") < thresholds.minimumExpectedSnippetRecall ||
    metric("irrelevantTop5Share") > thresholds.maximumIrrelevantTop5Share ||
    metric("mustNotMatchViolations") > thresholds.maximumMustNotMatchViolations ||
    metric("retrievalFailures") > thresholds.maximumRetrievalFailures
  ) {
    throw new Error("selected relevance scenario does not meet accepted thresholds");
  }
  return sha256Canonical(evidence);
}

function assertAcceptanceThresholds(thresholds: RelevanceAcceptanceThresholds | undefined): void {
  if (!thresholds) throw new Error("relevance evidence: metric thresholds missing");
  for (const name of [
    "minimumRecallAt5", "minimumRecallAt10", "minimumMrr", "minimumNdcgAt10",
    "minimumExpectedSnippetRecall", "maximumIrrelevantTop5Share",
  ] as const) finiteRatio(thresholds[name], name);
  for (const name of ["maximumMustNotMatchViolations", "maximumRetrievalFailures"] as const) {
    finiteCount(thresholds[name], name);
  }
}

function assertScenarioMeetsThresholds(
  aggregate: Record<string, unknown>,
  thresholds: RelevanceAcceptanceThresholds,
): void {
  const metric = (name: string) => Number(aggregate[name]);
  if (
    metric("recallAt5") < thresholds.minimumRecallAt5 ||
    metric("recallAt10") < thresholds.minimumRecallAt10 ||
    metric("mrr") < thresholds.minimumMrr ||
    metric("ndcgAt10") < thresholds.minimumNdcgAt10 ||
    metric("expectedSnippetRecall") < thresholds.minimumExpectedSnippetRecall ||
    metric("irrelevantTop5Share") > thresholds.maximumIrrelevantTop5Share ||
    metric("mustNotMatchViolations") > thresholds.maximumMustNotMatchViolations ||
    metric("retrievalFailures") > thresholds.maximumRetrievalFailures
  ) throw new Error("selected relevance scenario does not meet accepted thresholds");
}

/**
 * The final Stage 11 gate. It accepts only the distinct post-backfill report
 * with one selected hybrid scenario over the complete eligible corpus.
 */
export async function validateFullCorpusRelevanceAcceptance(
  evidence: AcceptedFullCorpusRelevanceEvidence,
  options: ValidateFullCorpusAcceptanceOptions,
): Promise<{
  acceptanceSha256: string;
  judgmentArtifactIdentity: ExpectedJudgmentArtifactIdentity;
}> {
  if (!evidence || evidence.formatVersion !== 1) {
    throw new Error("final full-corpus relevance evidence required");
  }
  if (Object.prototype.hasOwnProperty.call(evidence, "expectedJudgmentArtifact")) {
    throw new Error("final relevance judgment artifact identity must be supplied only in options");
  }
  const expectedJudgmentIdentity = normalizeExpectedJudgmentArtifactIdentity(
    options?.expectedJudgmentArtifact,
  );
  for (const [label, value] of Object.entries({
    evaluationReportSha256: evidence.evaluationReportSha256,
    judgmentSetArtifactSha256: evidence.judgmentSetArtifactSha256,
    judgmentSetSha256: evidence.judgmentSetSha256,
    corpusFingerprintSha256: evidence.corpusFingerprintSha256,
    privacySha256: evidence.privacySha256,
  })) assertSha256(value, `final relevance ${label}`);
  if (!evidence.evaluationReportPath?.trim() || !evidence.judgmentSetPath?.trim()) {
    throw new Error("final relevance artifact paths incomplete");
  }
  const human = evidence.humanAcceptance;
  if (
    human?.accepted !== true || !human.acceptedBy?.trim() || !human.rationale?.trim() ||
    Number.isNaN(Date.parse(human.acceptedAt))
  ) throw new Error("final relevance explicit human acceptance incomplete");
  assertAcceptanceThresholds(evidence.thresholds);
  const expectedDocuments = parseAuthoritativeDocumentBindings(
    await collectFreshEvaluationCorpusDocumentBindings(options.db, options.privacy),
    "final relevance expected DB documents",
  );
  const expectedFingerprint = eligibleCorpusFingerprint(expectedDocuments.map((document) => ({
    id: document.documentId,
    contentSha256: document.contentSha256,
  })));
  if (sha256Canonical(expectedFingerprint) !== sha256Canonical(options.expectedCorpus)) {
    throw new Error("final relevance expected DB documents differ from corpus fingerprint");
  }
  const [reportSource, judgmentArtifact] = await Promise.all([
    readFile(evidence.evaluationReportPath, "utf8").catch(() => {
      throw new Error("final_relevance_report_read_error");
    }),
    loadExternallyPinnedJudgmentArtifact(
      evidence.judgmentSetPath,
      expectedJudgmentIdentity,
      options.testOnlyJudgmentReadDelayMs,
    ),
  ]);
  if (sha256(reportSource) !== evidence.evaluationReportSha256) {
    throw new Error("final relevance report SHA-256 mismatch");
  }
  if (judgmentArtifact.identity.sha256 !== evidence.judgmentSetArtifactSha256) {
    throw new Error("final relevance judgment artifact differs from external identity");
  }
  let report: StoredFullCorpusEvaluationReport;
  try {
    report = JSON.parse(reportSource) as StoredFullCorpusEvaluationReport;
  } catch {
    throw new Error("final_relevance_artifact_invalid_json");
  }
  if (Object.prototype.hasOwnProperty.call(report, "expectedJudgmentArtifact")) {
    throw new Error("final relevance report must not assert expected judgment identity");
  }
  if (judgmentArtifact.canonicalSha256 !== evidence.judgmentSetSha256) {
    throw new Error("final relevance judgment canonical SHA-256 mismatch");
  }
  if (
    report.formatVersion !== 1 || report.evaluationKind !== "final_full_corpus_hybrid" ||
    Number.isNaN(Date.parse(report.generatedAt)) || report.corpus?.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/.test(report.corpus?.sha256) ||
    !Number.isSafeInteger(report.corpus?.documents) || report.corpus.documents < 1 ||
    !/^[0-9a-f]{64}$/.test(report.judgmentSet?.artifactSha256) ||
    !/^[0-9a-f]{64}$/.test(report.judgmentSet?.sha256) ||
    !Number.isSafeInteger(report.judgmentSet?.queries) ||
    !/^[0-9a-f]{64}$/.test(report.privacySha256)
  ) throw new Error("final relevance report metadata invalid");
  const reportDocuments = parseAuthoritativeDocumentBindings(
    report.corpusDocuments,
    "final relevance report corpusDocuments",
  );
  if (sha256Canonical(reportDocuments) !== sha256Canonical(expectedDocuments)) {
    throw new Error("final relevance report document bindings differ from fresh DB snapshot");
  }
  const authoritativeDocuments = new Map(
    expectedDocuments.map((document) => [document.documentId, document]),
  );
  const judgmentQueries = judgmentArtifact.set.queries;
  if (judgmentQueries.length !== report.judgmentSet.queries) {
    throw new Error("final relevance judgment coverage mismatch");
  }
  const judgmentBindings = new Map(
    judgmentQueries.map((query) => [query.id, query] as const),
  );
  if (
    report.judgmentSet.artifactSha256 !== evidence.judgmentSetArtifactSha256 ||
    report.judgmentSet.sha256 !== evidence.judgmentSetSha256 ||
    report.corpus.sha256 !== evidence.corpusFingerprintSha256 ||
    report.privacySha256 !== evidence.privacySha256 ||
    evidence.privacySha256 !== sha256Canonical(normalizedPrivacy(options.privacy))
  ) throw new Error("final relevance evidence digest mismatch");
  if (
    report.corpus.algorithm !== options.expectedCorpus.algorithm ||
    report.corpus.sha256 !== options.expectedCorpus.sha256 ||
    report.corpus.documents !== options.expectedCorpus.documents
  ) throw new Error("final relevance corpus differs from production backfill corpus");
  const scenario = report.scenario;
  if (
    !scenario || scenario.mode !== "hybrid" ||
    scenario.id !== `full-corpus-hybrid:${report.selectedSpace?.slug}` ||
    evidence.scenarioId !== scenario.id
  ) throw new Error("final relevance selected hybrid scenario invalid");
  for (const key of ["slug", "provider", "model", "dimensions"] as const) {
    if (
      scenario.space?.[key] !== report.selectedSpace?.[key] ||
      evidence.space?.[key] !== report.selectedSpace?.[key] ||
      options.expectedSpace[key] !== report.selectedSpace?.[key]
    ) throw new Error(`final relevance selected space.${key} mismatch`);
  }
  const checks = scenario.corpusChecks;
  for (const value of [checks?.before, checks?.after]) {
    if (
      value?.algorithm !== report.corpus.algorithm || value.sha256 !== report.corpus.sha256 ||
      value.documents !== report.corpus.documents
    ) throw new Error("final relevance corpus checks mismatch");
  }
  if (!Array.isArray(scenario.queries) || scenario.queries.length !== report.judgmentSet.queries) {
    throw new Error("final relevance queries incomplete");
  }
  const ids = scenario.queries.map((query) => String(query.queryId ?? ""));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("final relevance query ids invalid");
  }
  const types = new Set(scenario.queries.map((query) => query.queryType));
  const languages = new Set(scenario.queries.map((query) => query.queryLanguage));
  for (const type of [
    "exact phrase", "russian morphology", "english technical", "function name", "model",
    "path", "semantic paraphrase", "mixed ru/en", "code error", "deleted dialogue",
  ]) if (!types.has(type)) throw new Error(`final relevance missing query type ${type}`);
  for (const language of ["ru", "en", "mixed"]) {
    if (!languages.has(language)) throw new Error(`final relevance missing language ${language}`);
  }
  const contentByDocument = parseScenarioContentEvidence(scenario, authoritativeDocuments);
  for (const query of scenario.queries) {
    const binding = judgmentBindings.get(String(query.queryId));
    if (!binding) throw new Error("final relevance query absent from judgment artifact");
    assertQueryMatchesJudgment(scenario.id, query, binding, contentByDocument);
  }
  if (sha256Canonical(scenario.aggregate) !== sha256Canonical(recomputeStoredAggregate(scenario.queries))) {
    throw new Error("final relevance aggregate mismatch");
  }
  const resources = scenario.resourceMeasurements;
  if (
    !resources || typeof resources.source !== "string" || !resources.source.trim() ||
    ["vectorIndexBytes", "peakRamBytes", "indexBuildMs"].some((name) =>
      typeof resources[name] !== "number" || !Number.isFinite(resources[name]) ||
      Number(resources[name]) < 0)
  ) throw new Error("final relevance resource measurements invalid");
  const readiness = scenario.readiness;
  if (!readiness || !Array.isArray(readiness.exclusions)) {
    throw new Error("final relevance readiness missing");
  }
  for (const name of [
    "documents", "jobs", "completedJobs", "vectors", "jobCoverageErrors",
    "vectorCoverageErrors", "inputHashErrors", "expectedDimensions",
    "wrongDimensionVectors", "privacyNormalizedDocuments",
    "privacyExcludedDocuments", "permanentExcludedDocuments", "eligibleDocuments",
  ]) finiteCount(readiness[name], `final.readiness.${name}`);
  let privacyExcluded = 0;
  let permanentExcluded = 0;
  const exclusionIdentities = new Set<string>();
  for (const raw of readiness.exclusions as unknown[]) {
    const exclusion = raw as Record<string, unknown>;
    const stable = exclusion.category === "privacy"
      ? /^privacy_excluded_(?:harness|workspace|document_type|document_size|policy)$/.test(String(exclusion.code))
      : /^provider_(?:permanent_error|retry_exhausted|unexpected_error)$|^(?:vector_dimension_mismatch|provider_vector_count_mismatch)(?: expected=\d+ actual=\d+)?$|^(?:search_document_missing|permanent_error_detail_redacted)$/.test(String(exclusion.code));
    const identity = `${String(exclusion.jobId)}\0${String(exclusion.documentId)}`;
    if (
      !stable || typeof exclusion.jobId !== "string" || !exclusion.jobId.trim() ||
      typeof exclusion.documentId !== "string" || !exclusion.documentId.trim() ||
      exclusionIdentities.has(identity) ||
      typeof exclusion.evidence !== "string" || !exclusion.evidence.trim()
    ) {
      throw new Error("final relevance readiness exclusion invalid");
    }
    exclusionIdentities.add(identity);
    if (exclusion.category === "privacy") privacyExcluded += 1;
    else permanentExcluded += 1;
  }
  if (
    readiness.jobs !== readiness.documents ||
    Number(readiness.completedJobs) !== Number(readiness.eligibleDocuments) ||
    Number(readiness.vectors) !== Number(readiness.eligibleDocuments) ||
    Number(readiness.privacyExcludedDocuments) !== privacyExcluded ||
    Number(readiness.permanentExcludedDocuments) !== permanentExcluded ||
    Number(readiness.privacyNormalizedDocuments) !== report.corpus.documents ||
    Number(readiness.privacyNormalizedDocuments) + privacyExcluded !==
      Number(readiness.documents) ||
    Number(readiness.eligibleDocuments) + permanentExcluded !== report.corpus.documents ||
    readiness.jobCoverageErrors !== 0 || readiness.vectorCoverageErrors !== 0 ||
    readiness.inputHashErrors !== 0 || readiness.wrongDimensionVectors !== 0 ||
    readiness.expectedDimensions !== report.selectedSpace.dimensions ||
    readiness.hnswUsesKnnScan !== true || typeof readiness.hnswIndexName !== "string" ||
    !readiness.hnswIndexName.trim()
  ) throw new Error("final relevance readiness invalid");
  assertScenarioMeetsThresholds(scenario.aggregate, evidence.thresholds);
  const afterDocuments = await collectFreshEvaluationCorpusDocumentBindings(
    options.db,
    options.privacy,
  );
  if (sha256Canonical(afterDocuments) !== sha256Canonical(expectedDocuments)) {
    throw new Error("final relevance DB document snapshot drift during validation");
  }
  return {
    acceptanceSha256: sha256Canonical({
      evidence,
      expectedJudgmentArtifact: judgmentArtifact.identity,
      privacy: normalizedPrivacy(options.privacy),
      expectedCorpus: options.expectedCorpus,
      expectedSpace: options.expectedSpace,
      expectedDocuments,
    }),
    judgmentArtifactIdentity: judgmentArtifact.identity,
  };
}

export interface Stage11Completion {
  formatVersion: 1;
  completionKind: "stage11_full_corpus_relevance";
  completedAt: string;
  corpus: { algorithm: "sha256"; sha256: string; documents: number };
  space: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  finalReportSha256: string;
  finalAcceptanceSha256: string;
  expectedJudgmentArtifact: ExpectedJudgmentArtifactIdentity;
  completionSha256: string;
}

export interface CompleteStage11Options {
  db: Surreal;
  privacy: PrivacyPolicy;
  expectedCorpus: { algorithm: "sha256"; sha256: string; documents: number };
  expectedSpace: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  expectedJudgmentArtifact: ExpectedJudgmentArtifactIdentity;
  testOnlyJudgmentReadDelayMs?: number;
  now?: () => Date;
}

/**
 * The only Stage 11 completion constructor. Candidate evidence can authorize a
 * selected backfill, but this API accepts only exact post-backfill full-corpus evidence.
 */
export async function completeStage11(
  evidence: AcceptedFullCorpusRelevanceEvidence,
  options: CompleteStage11Options,
): Promise<Stage11Completion> {
  const { acceptanceSha256, judgmentArtifactIdentity } =
    await validateFullCorpusRelevanceAcceptance(evidence, options);
  const completedAt = (options.now ?? (() => new Date()))().toISOString();
  if (Number.isNaN(Date.parse(completedAt))) throw new Error("stage11 completion time invalid");
  const binding = {
    formatVersion: 1 as const,
    completionKind: "stage11_full_corpus_relevance" as const,
    completedAt,
    corpus: options.expectedCorpus,
    space: options.expectedSpace,
    finalReportSha256: evidence.evaluationReportSha256,
    finalAcceptanceSha256: acceptanceSha256,
    expectedJudgmentArtifact: judgmentArtifactIdentity,
  };
  return { ...binding, completionSha256: sha256Canonical(binding) };
}

/** Pure confirmation phrase with full corpus and plan hashes (no prefixes). */
export function productionBackfillConfirmation(
  spaceSlug: string,
  fingerprintSha256: string,
  planSha256: string,
): string {
  assertSha256(fingerprintSha256, "corpus fingerprint");
  assertSha256(planSha256, "production plan");
  return `RUN EMBEDDINGS ${spaceSlug} ${fingerprintSha256} ${planSha256}`;
}

export interface EvaluationCandidatePlanOptions {
  privacy: PrivacyPolicy;
  /** Exactly the three §13.2 candidate spaces. */
  spaceSlugs: readonly string[];
  maxDocuments: number;
  maxJobsPerSpace: number;
  /** Public/random SHA-256 seed makes deterministic fill selection auditable. */
  selectionSeedSha256: string;
  /** Dialogues referenced by the private judgment set; all their docs lead. */
  requiredDialogueIds: readonly string[];
}

/** Library ceilings are part of the paid-call safety boundary, not CLI UX. */
export const MAX_EVALUATION_CANDIDATE_DOCUMENTS = 1_000;
export const MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE = 200;

export interface EvaluationCandidateSpacePlan {
  space: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  jobs: ProductionJobBinding[];
  runnableJobs: ProductionJobBinding[];
  vectors: ProductionVectorBinding[];
}

export interface EvaluationCandidatePlan {
  formatVersion: 1;
  fullEligibleCorpus: { algorithm: "sha256"; sha256: string; documents: number };
  subset: {
    limit: number;
    selectionSeedSha256: string;
    fingerprint: { algorithm: "sha256"; sha256: string; documents: number };
    documents: ProductionDocumentBinding[];
  };
  privacy: PrivacyPolicy;
  requiredDialogueIdsSha256: string;
  maxJobsPerSpace: number;
  spaces: EvaluationCandidateSpacePlan[];
  blockers: string[];
  planSha256: string;
  confirmation: string;
}

export function evaluationCandidateConfirmation(
  corpusSha256: string,
  planSha256: string,
): string {
  assertSha256(corpusSha256, "candidate corpus");
  assertSha256(planSha256, "candidate plan");
  return `RUN EVALUATION CANDIDATES ${corpusSha256} ${planSha256}`;
}

export function validateEvaluationCandidatePlan(plan: EvaluationCandidatePlan): void {
  if (!plan || plan.formatVersion !== 1 || !Array.isArray(plan.spaces)) {
    throw new Error("evaluation candidate plan invalid");
  }
  if (
    plan.fullEligibleCorpus?.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/.test(plan.fullEligibleCorpus?.sha256) ||
    !Number.isSafeInteger(plan.fullEligibleCorpus?.documents) ||
    plan.fullEligibleCorpus.documents < 1 ||
    plan.subset?.fingerprint?.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/.test(plan.subset?.fingerprint?.sha256) ||
    !/^[0-9a-f]{64}$/.test(plan.subset?.selectionSeedSha256) ||
    !/^[0-9a-f]{64}$/.test(plan.requiredDialogueIdsSha256) ||
    !Number.isSafeInteger(plan.subset?.limit) || plan.subset.limit < 1 ||
    plan.subset.limit > MAX_EVALUATION_CANDIDATE_DOCUMENTS ||
    !Number.isSafeInteger(plan.maxJobsPerSpace) || plan.maxJobsPerSpace < 1 ||
    plan.maxJobsPerSpace > MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE ||
    !Array.isArray(plan.subset?.documents) || plan.subset.documents.length < 1 ||
    plan.subset.documents.length > plan.subset.limit ||
    plan.subset.fingerprint.documents !== plan.subset.documents.length ||
    plan.fullEligibleCorpus.documents < plan.subset.documents.length ||
    !Array.isArray(plan.privacy?.excludeHarnesses) ||
    !Array.isArray(plan.privacy?.excludeWorkspaces) ||
    !Array.isArray(plan.privacy?.excludeDocumentTypes) ||
    (plan.privacy.maxDocumentBytes !== undefined &&
      (!Number.isSafeInteger(plan.privacy.maxDocumentBytes) || plan.privacy.maxDocumentBytes < 0)) ||
    !Array.isArray(plan.blockers) ||
    plan.blockers.some((item) => typeof item !== "string" || !item.trim()) ||
    sha256Canonical(plan.blockers) !== sha256Canonical([...new Set(plan.blockers)].sort())
  ) throw new Error("evaluation candidate plan structure invalid");
  const documents = new Map<string, ProductionDocumentBinding>();
  for (const document of plan.subset.documents) {
    if (
      !document.documentId?.trim() || !document.dialogueId?.trim() ||
      !document.revisionId?.trim() ||
      !/^[0-9a-f]{64}$/.test(document.contentSha256) ||
      !document.extractionVersion?.trim() || !document.segmentationVersion?.trim() ||
      documents.has(document.documentId)
    ) throw new Error("evaluation candidate plan document binding invalid");
    documents.set(document.documentId, document);
  }
  if (
    eligibleCorpusFingerprint([...documents.values()].map((document) => ({
      id: document.documentId,
      contentSha256: document.contentSha256,
    }))).sha256 !== plan.subset.fingerprint.sha256
  ) throw new Error("evaluation candidate subset fingerprint mismatch");
  const expectedSpaces = new Set([
    "text-embedding-3-small@1536",
    "text-embedding-3-large@1024",
    "text-embedding-3-large@3072",
  ]);
  const slugs = new Set<string>();
  if (plan.spaces.length !== 3) throw new Error("evaluation candidate plan space matrix invalid");
  for (const space of plan.spaces) {
    const key = `${space.space?.model}@${space.space?.dimensions}`;
    if (
      !space.space?.slug?.trim() || slugs.has(space.space.slug) ||
      !space.space.provider?.trim() || !expectedSpaces.delete(key) ||
      !Array.isArray(space.jobs) || !Array.isArray(space.runnableJobs) ||
      !Array.isArray(space.vectors)
    ) throw new Error("evaluation candidate plan space binding invalid");
    slugs.add(space.space.slug);
    const jobs = new Map<string, ProductionJobBinding>();
    const jobDocuments = new Set<string>();
    for (const job of space.jobs) {
      if (
        !job.jobId?.trim() || jobs.has(job.jobId) || !documents.has(job.documentId) ||
        jobDocuments.has(job.documentId) ||
        job.inputSha256 !== documents.get(job.documentId)!.contentSha256 ||
        !job.status?.trim() || Number.isNaN(Date.parse(job.createdAt))
      ) throw new Error("evaluation candidate plan job binding invalid");
      jobs.set(job.jobId, job);
      jobDocuments.add(job.documentId);
    }
    if (jobs.size !== documents.size) {
      throw new Error("evaluation candidate plan job coverage incomplete");
    }
    for (const runnable of space.runnableJobs) {
      if (
        !jobs.has(runnable.jobId) ||
        sha256Canonical(jobs.get(runnable.jobId)) !== sha256Canonical(runnable) ||
        !["pending", "retryable_error"].includes(runnable.status)
      ) throw new Error("evaluation candidate runnable binding invalid");
    }
    const vectorIds = new Set<string>();
    const vectorDocuments = new Set<string>();
    for (const vector of space.vectors) {
      if (
        !vector.vectorId?.trim() || vectorIds.has(vector.vectorId) ||
        vectorDocuments.has(vector.documentId) || !documents.has(vector.documentId) ||
        vector.inputSha256 !== documents.get(vector.documentId)!.contentSha256 ||
        vector.dimensions !== space.space.dimensions
      ) throw new Error("evaluation candidate vector binding invalid");
      vectorIds.add(vector.vectorId);
      vectorDocuments.add(vector.documentId);
    }
  }
  if (expectedSpaces.size > 0) throw new Error("evaluation candidate plan space matrix incomplete");
  const { planSha256, confirmation, ...binding } = plan;
  assertSha256(planSha256, "evaluation candidate plan");
  if (sha256Canonical(binding) !== planSha256) {
    throw new Error("evaluation candidate plan SHA-256 mismatch");
  }
  if (
    confirmation !==
      evaluationCandidateConfirmation(plan.fullEligibleCorpus.sha256, plan.planSha256)
  ) throw new Error("evaluation candidate confirmation invalid");
}

export function serializeEvaluationCandidatePlan(plan: EvaluationCandidatePlan): string {
  validateEvaluationCandidatePlan(plan);
  return `${JSON.stringify(canonicalize(plan), null, 2)}\n`;
}

export async function writeEvaluationCandidatePlan(
  filePath: string,
  plan: EvaluationCandidatePlan,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const source = serializeEvaluationCandidatePlan(plan);
  await writePrivateFileAtomic(filePath, source, options);
}

export async function loadEvaluationCandidatePlan(
  filePath: string,
): Promise<EvaluationCandidatePlan> {
  return (await loadEvaluationCandidatePlanArtifact(filePath)).plan;
}

export interface LoadedEvaluationCandidatePlanArtifact {
  plan: EvaluationCandidatePlan;
  artifactSha256: string;
}

/** Load, validate and hash the exact candidate-plan bytes used for acceptance. */
export async function loadEvaluationCandidatePlanArtifact(
  filePath: string,
): Promise<LoadedEvaluationCandidatePlanArtifact> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new Error("evaluation_candidate_plan_read_error");
  }
  let plan: EvaluationCandidatePlan;
  try {
    plan = JSON.parse(source) as EvaluationCandidatePlan;
  } catch {
    throw new Error("evaluation_candidate_plan_invalid_json");
  }
  validateEvaluationCandidatePlan(plan);
  return { plan, artifactSha256: sha256(source) };
}

/**
 * Read-only bounded bootstrap plan. It does not require accepted relevance:
 * only this subset may be embedded for comparing all three candidate spaces.
 */
export async function prepareEvaluationCandidatePlan(
  db: Surreal,
  options: EvaluationCandidatePlanOptions,
): Promise<EvaluationCandidatePlan> {
  if (
    !Number.isSafeInteger(options.maxDocuments) || options.maxDocuments < 1 ||
    options.maxDocuments > MAX_EVALUATION_CANDIDATE_DOCUMENTS
  ) {
    throw new Error(
      `evaluation candidate maxDocuments must be 1..${MAX_EVALUATION_CANDIDATE_DOCUMENTS}`,
    );
  }
  if (
    !Number.isSafeInteger(options.maxJobsPerSpace) || options.maxJobsPerSpace < 1 ||
    options.maxJobsPerSpace > MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE
  ) {
    throw new Error(
      `evaluation candidate maxJobsPerSpace must be 1..${MAX_EVALUATION_CANDIDATE_JOBS_PER_SPACE}`,
    );
  }
  assertSha256(options.selectionSeedSha256, "evaluation candidate selection seed");
  if (new Set(options.spaceSlugs).size !== 3) {
    throw new Error("evaluation candidate plan requires exactly three distinct spaces");
  }
  const spaces = await Promise.all(options.spaceSlugs.map((slug) => getSpaceBySlug(db, slug)));
  if (spaces.some((space) => !space)) throw new Error("evaluation candidate space not found");
  const expected = new Set([
    "text-embedding-3-small@1536",
    "text-embedding-3-large@1024",
    "text-embedding-3-large@3072",
  ]);
  for (const space of spaces as EmbeddingSpace[]) {
    if (!expected.delete(`${space.model}@${space.dimensions}`)) {
      throw new Error("evaluation candidate spaces do not match §13.2 matrix");
    }
  }
  const all: ProductionDocumentBinding[] = [];
  const blockers: string[] = [];
  let start = 0;
  for (;;) {
    const page = await selectAll<PlanDocumentRow>(
      db,
      `SELECT id, content, content_sha256, document_type, extraction_version,
         segmentation_version, dialogue.id AS dialogue_id,
         dialogue_revision.id AS revision_id,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document ORDER BY id LIMIT 250 START $start`,
      { start },
    );
    for (const doc of page) {
      if (!doc.dialogue_id || !doc.revision_id) {
        throw new Error("evaluation candidate document ownership missing");
      }
      const actual = sha256(doc.content);
      if (actual !== doc.content_sha256) throw new Error("evaluation candidate content hash drift");
      if (privacyExclusion({
        harness: doc.harness,
        workspace: doc.workspace,
        documentType: doc.document_type,
        contentBytes: utf8Bytes(doc.content),
      }, options.privacy)) continue;
      all.push({
        documentId: String(doc.id),
        dialogueId: String(doc.dialogue_id),
        revisionId: String(doc.revision_id),
        contentSha256: doc.content_sha256,
        extractionVersion: String(doc.extraction_version),
        segmentationVersion: String(doc.segmentation_version),
      });
      if (String(doc.extraction_version) !== String(EXTRACTOR_VERSION)) {
        blockers.push(`${String(doc.id)}: candidate extraction_version stale`);
      }
      if (String(doc.segmentation_version) !== SEGMENTATION_VERSION) {
        blockers.push(`${String(doc.id)}: candidate segmentation_version stale`);
      }
    }
    if (page.length < 250) break;
    start += page.length;
  }
  if (all.length === 0) throw new Error("evaluation candidate eligible corpus empty");
  const required = new Set(options.requiredDialogueIds.map((id) => id.trim()).filter(Boolean));
  if (required.size !== options.requiredDialogueIds.length || required.size === 0) {
    throw new Error("evaluation candidate requires unique nonempty judgment dialogue ids");
  }
  const requiredDocuments = all
    .filter((doc) => required.has(doc.dialogueId))
    .sort((a, b) => a.documentId.localeCompare(b.documentId));
  const covered = new Set(requiredDocuments.map((doc) => doc.dialogueId));
  if ([...required].some((id) => !covered.has(id))) {
    throw new Error("evaluation candidate required dialogue absent from eligible corpus");
  }
  if (requiredDocuments.length > options.maxDocuments) {
    throw new Error("evaluation candidate required dialogues exceed bounded subset");
  }
  const selectedIds = new Set(requiredDocuments.map((doc) => doc.documentId));
  const fill = all
    .filter((doc) => !selectedIds.has(doc.documentId))
    .sort((a, b) => {
      const ah = sha256(`${options.selectionSeedSha256}\0${a.documentId}\0${a.contentSha256}`);
      const bh = sha256(`${options.selectionSeedSha256}\0${b.documentId}\0${b.contentSha256}`);
      return ah.localeCompare(bh) || a.documentId.localeCompare(b.documentId);
    })
    .slice(0, options.maxDocuments - requiredDocuments.length);
  const selected = [...requiredDocuments, ...fill].sort((a, b) =>
    a.documentId.localeCompare(b.documentId),
  );
  const spacePlans: EvaluationCandidateSpacePlan[] = [];
  for (const space of spaces as EmbeddingSpace[]) {
    if (space.segmentation_version !== SEGMENTATION_VERSION) {
      blockers.push(`${space.slug}: candidate space segmentation_version stale`);
    }
    const rows = await selectAll<PlanJobRow>(
      db,
      `SELECT id, search_document, input_sha256, status, created_at
       FROM embedding_job WHERE embedding_space = $space ORDER BY id`,
      { space: space.id },
    );
    const vectorRows = await selectAll<PlanVectorRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256,
         array::len(vector) AS dimensions FROM ${space.physical_table} ORDER BY id`,
    );
    const byDocument = new Map<string, PlanJobRow[]>();
    for (const row of rows) {
      const id = String(row.search_document);
      byDocument.set(id, [...(byDocument.get(id) ?? []), row]);
    }
    const jobs: ProductionJobBinding[] = [];
    const selectedDocumentIds = new Set(selected.map((document) => document.documentId));
    const vectors = vectorRows
      .filter((vector) => selectedDocumentIds.has(String(vector.search_document)))
      .map((vector) => ({
        vectorId: String(vector.id),
        documentId: String(vector.search_document),
        inputSha256: vector.input_sha256,
        dimensions: vector.dimensions,
      }))
      .sort((a, b) => a.vectorId.localeCompare(b.vectorId));
    const outsideVectors = vectorRows.filter(
      (vector) => !selectedDocumentIds.has(String(vector.search_document)),
    );
    if (outsideVectors.length > 0) {
      blockers.push(`${space.slug}: ${outsideVectors.length} vectors outside bounded subset`);
    }
    for (const document of selected) {
      const found = byDocument.get(document.documentId) ?? [];
      if (found.length !== 1) {
        blockers.push(`${space.slug}/${document.documentId}: candidate job count ${found.length}`);
        continue;
      }
      const job = found[0]!;
      if (job.input_sha256 !== document.contentSha256) {
        blockers.push(`${space.slug}/${document.documentId}: stale candidate job hash`);
      }
      if (!["pending", "retryable_error", "processing", "completed", "permanent_error"].includes(job.status)) {
        blockers.push(`${space.slug}/${document.documentId}: candidate job status ${job.status}`);
      }
      jobs.push({
        jobId: String(job.id),
        documentId: document.documentId,
        inputSha256: job.input_sha256,
        status: job.status,
        createdAt: new Date(job.created_at).toISOString(),
      });
      const documentVectors = vectors.filter(
        (vector) => vector.documentId === document.documentId,
      );
      if (job.status === "completed") {
        if (
          documentVectors.length !== 1 ||
          documentVectors[0]!.inputSha256 !== document.contentSha256 ||
          documentVectors[0]!.dimensions !== space.dimensions
        ) blockers.push(`${space.slug}/${document.documentId}: completed candidate vector invalid`);
      } else if (documentVectors.length > 0) {
        blockers.push(`${space.slug}/${document.documentId}: vector exists for ${job.status} job`);
      }
    }
    jobs.sort((a, b) => a.jobId.localeCompare(b.jobId));
    spacePlans.push({
      space,
      jobs,
      runnableJobs: jobs.filter((job) => ["pending", "retryable_error"].includes(job.status)),
      vectors,
    });
  }
  spacePlans.sort((a, b) => a.space.slug.localeCompare(b.space.slug));
  const fullEligibleCorpus = eligibleCorpusFingerprint(
    all.map((doc) => ({ id: doc.documentId, contentSha256: doc.contentSha256 })),
  );
  const subsetFingerprint = eligibleCorpusFingerprint(
    selected.map((doc) => ({ id: doc.documentId, contentSha256: doc.contentSha256 })),
  );
  const binding = {
    formatVersion: 1 as const,
    fullEligibleCorpus,
    subset: {
      limit: options.maxDocuments,
      selectionSeedSha256: options.selectionSeedSha256,
      fingerprint: subsetFingerprint,
      documents: selected,
    },
    privacy: normalizedPrivacy(options.privacy),
    requiredDialogueIdsSha256: sha256Canonical([...required].sort()),
    maxJobsPerSpace: options.maxJobsPerSpace,
    spaces: spacePlans,
    blockers: [...new Set(blockers)].sort(),
  };
  const planSha256 = sha256Canonical(binding);
  return {
    ...binding,
    planSha256,
    confirmation: evaluationCandidateConfirmation(fullEligibleCorpus.sha256, planSha256),
  };
}

export interface ConfirmedEvaluationCandidateOptions extends EvaluationCandidatePlanOptions {
  confirmation: string;
  allowExternalProviderCalls: boolean;
  batchSize?: number;
  workerId?: string;
  logger?: (event: Record<string, unknown>) => void;
}

function assertEvaluationCandidateCallGate(
  expected: EvaluationCandidatePlan,
  current: EvaluationCandidatePlan,
  invocationAuthorizedIds: ReadonlySet<string>,
  currentBatchIds: ReadonlySet<string>,
): void {
  if (
    current.blockers.length > 0 ||
    current.fullEligibleCorpus.sha256 !== expected.fullEligibleCorpus.sha256 ||
    current.subset.fingerprint.sha256 !== expected.subset.fingerprint.sha256 ||
    sha256Canonical(current.subset.documents) !== sha256Canonical(expected.subset.documents) ||
    sha256Canonical(current.privacy) !== sha256Canonical(expected.privacy)
  ) {
    throw new Error("evaluation candidate plan drift before provider call");
  }
  const expectedJobs = new Map(
    expected.spaces.flatMap((space) => space.jobs).map((job) => [job.jobId, job]),
  );
  const expectedVectors = new Map(
    expected.spaces.flatMap((space) => space.vectors).map((vector) => [vector.vectorId, vector]),
  );
  const authorizedDocuments = new Set(
    expected.spaces.flatMap((space) => space.jobs)
      .filter((job) => invocationAuthorizedIds.has(job.jobId))
      .map((job) => job.documentId),
  );
  const currentBatchDocuments = new Set(
    expected.spaces.flatMap((space) => space.jobs)
      .filter((job) => currentBatchIds.has(job.jobId))
      .map((job) => job.documentId),
  );
  const currentBatchSpaces = expected.spaces.filter((space) =>
    space.jobs.some((job) => currentBatchIds.has(job.jobId)),
  );
  if (currentBatchSpaces.length !== 1) {
    throw new Error("evaluation candidate current batch space binding invalid");
  }
  const currentBatchSpaceSlug = currentBatchSpaces[0]!.space.slug;
  for (const currentSpace of current.spaces) {
    for (const vector of currentSpace.vectors) {
      if (
        currentSpace.space.slug === currentBatchSpaceSlug &&
        currentBatchDocuments.has(vector.documentId)
      ) {
        throw new Error("evaluation candidate current batch vector already exists");
      }
      const before = expectedVectors.get(vector.vectorId);
      if (before) {
        if (sha256Canonical(before) !== sha256Canonical(vector)) {
          throw new Error("evaluation candidate vector changed before provider call");
        }
        expectedVectors.delete(vector.vectorId);
      } else if (!authorizedDocuments.has(vector.documentId)) {
        throw new Error("evaluation candidate unbound vector appeared before provider call");
      }
    }
  }
  if (expectedVectors.size > 0) {
    throw new Error("evaluation candidate vector disappeared before provider call");
  }
  const currentJobs = new Map(
    current.spaces.flatMap((space) => space.jobs).map((job) => [job.jobId, job]),
  );
  if (expectedJobs.size !== currentJobs.size) {
    throw new Error("evaluation candidate job set drift before provider call");
  }
  for (const [id, job] of expectedJobs) {
    const now = currentJobs.get(id);
    if (
      !now || now.documentId !== job.documentId || now.inputSha256 !== job.inputSha256 ||
      now.createdAt !== job.createdAt
    ) throw new Error("evaluation candidate job binding drift before provider call");
    if (currentBatchIds.has(id)) {
      if (now.status !== "processing") {
        throw new Error("evaluation candidate current batch is not processing");
      }
    } else if (invocationAuthorizedIds.has(id)) {
      if (!["pending", "retryable_error", "processing", "completed"].includes(now.status)) {
        throw new Error("evaluation candidate authorized job status drift");
      }
    } else if (now.status !== job.status) {
      throw new Error("evaluation candidate unbound job status drift");
    }
  }
}

interface AuthorizedSpaceWorkerOptions {
  authorizedJobIds: readonly RecordId[];
  limit: number;
  batchSize?: number;
  /** Production exact-report counts; candidate flow uses conservative DB evidence. */
  exactTokenCounts?: ReadonlyMap<string, number>;
  privacy: PrivacyPolicy;
  workerId?: string;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
}

async function cancelPrivacyJob(
  db: Surreal,
  job: EmbeddingJobRow,
  reasonCode: string,
  now: Date,
): Promise<void> {
  if (!/^privacy_excluded_(?:harness|workspace|document_type|document_size|policy)$/.test(reasonCode)) {
    throw new Error("privacy cancellation reason invalid");
  }
  await db.query(
    `UPDATE ONLY $id SET status = "cancelled", last_error = $reason,
       locked_by = NONE, locked_at = NONE, completed_at = $now`,
    { id: job.id, reason: reasonCode, now },
  );
}

/**
 * Paid-capable worker core is deliberately private to this authorization
 * module. Its authorization callback is constructed only by the two exported
 * confirmed entrypoints below; callers cannot replace it with a no-op gate.
 */
async function runAuthorizedSpaceWorker(
  db: Surreal,
  providerFactory: ProviderFactory,
  space: EmbeddingSpace,
  options: AuthorizedSpaceWorkerOptions,
  revalidateAuthorizedBatch: (jobs: readonly EmbeddingJobRow[]) => Promise<void>,
): Promise<WorkerSummary> {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? (() => {});
  const workerId = options.workerId ?? `stage11-worker-${process.pid}`;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > BATCH_SIZE) {
    throw new Error(`authorized embedding batchSize must be 1..${BATCH_SIZE}`);
  }
  if (
    !Number.isSafeInteger(options.limit) || options.limit < 1 ||
    options.limit > options.authorizedJobIds.length
  ) throw new Error("authorized embedding limit invalid");
  if (
    options.authorizedJobIds.length === 0 ||
    new Set(options.authorizedJobIds.map(String)).size !== options.authorizedJobIds.length
  ) throw new Error("authorized embedding job ids invalid");

  // Factory/config failure remains strictly before the first lease.
  const provider = providerFactory(space);
  if (
    provider.provider !== space.provider || provider.model !== space.model ||
    provider.dimensions !== space.dimensions
  ) throw new Error("authorized embedding provider config mismatch");

  const summary: WorkerSummary = {
    completed: 0,
    failed: 0,
    permanentErrors: 0,
    privacyExcluded: 0,
    releasedStale: 0,
    promptTokens: 0,
    batches: 0,
  };
  let processed = 0;
  while (processed < options.limit) {
    summary.releasedStale += await releaseStaleLeases(db, now());
    const jobs = await leaseJobs(db, {
      spaceId: space.id,
      limit: Math.min(batchSize, options.limit - processed),
      workerId,
      now: now(),
      jobIds: options.authorizedJobIds,
    });
    if (jobs.length === 0) break;
    processed += jobs.length;
    const docs = new Map<string, EmbeddingDocumentRow>();
    for (const doc of await selectAll<EmbeddingDocumentRow>(
      db,
      `SELECT id, content, content_sha256, token_count, document_type,
         extraction_version, segmentation_version,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document WHERE id INSIDE $ids`,
      { ids: jobs.map((job) => job.search_document) },
    )) docs.set(String(doc.id), doc);

    const runnable: Array<{ job: EmbeddingJobRow; doc: EmbeddingDocumentRow }> = [];
    for (const job of jobs) {
      const doc = docs.get(String(job.search_document));
      if (!doc) {
        await failJobs(db, [job], "permanent_error", "search_document_missing");
        summary.permanentErrors += 1;
        continue;
      }
      const exclusion = privacyExclusion({
        harness: doc.harness,
        workspace: doc.workspace,
        documentType: doc.document_type,
        contentBytes: utf8Bytes(doc.content),
      }, options.privacy);
      if (exclusion) {
        const reasonCode = privacyExclusionCode(exclusion);
        await cancelPrivacyJob(db, job, reasonCode, now());
        summary.privacyExcluded += 1;
        log({ event: "embedding_job_privacy_excluded", job: String(job.id), reasonCode });
        continue;
      }
      runnable.push({ job, doc });
    }
    if (runnable.length === 0) continue;
    const requestBatches = packEmbeddingRequestBatches(
      runnable,
      ({ doc }) => {
        const exact = options.exactTokenCounts?.get(String(doc.id));
        return exact === undefined
          ? { content: doc.content, tokenCount: doc.token_count }
          : { content: doc.content, tokenCount: exact, exact: true };
      },
      batchSize,
    );
    for (const requestBatch of requestBatches) {
      summary.batches += 1;
      await revalidateAuthorizedBatch(requestBatch.map(({ job }) => job));
      await assertCurrentLeasedBatch(db, space, workerId, requestBatch);
      try {
        const result = await provider.embed(requestBatch.map(({ doc }) => doc.content));
        const wrongDimension = result.vectors.findIndex(
          (vector) => vector.length !== space.dimensions,
        );
        if (wrongDimension >= 0 || result.vectors.length !== requestBatch.length) {
          const detail = result.vectors.length !== requestBatch.length
            ? `provider_vector_count_mismatch expected=${requestBatch.length} actual=${result.vectors.length}`
            : `vector_dimension_mismatch expected=${space.dimensions} actual=${result.vectors[wrongDimension]!.length}`;
          await failJobs(db, requestBatch.map(({ job }) => job), "permanent_error", detail);
          summary.permanentErrors += requestBatch.length;
          log({ event: "embedding_batch_dimension_rejected", space: space.slug, detail });
          continue;
        }
        await completeBatch(
          db,
          space,
          requestBatch,
          result.vectors,
          result.usage.promptTokens,
          now(),
        );
        summary.completed += requestBatch.length;
        summary.promptTokens += result.usage.promptTokens;
        log({
          event: "embedding_batch_completed",
          space: space.slug,
          jobs: requestBatch.length,
          promptTokens: result.usage.promptTokens,
        });
      } catch (error) {
        const retryable = error instanceof EmbeddingProviderError ? error.retryable : true;
        const errorCode = error instanceof EmbeddingProviderError
          ? retryable ? "provider_retryable_error" : "provider_permanent_error"
          : "provider_unexpected_error";
        for (const { job } of requestBatch) {
          const attempts = job.attempts + 1;
          const permanent = !retryable || attempts >= MAX_ATTEMPTS;
          await failJob(
            db,
            job,
            permanent ? "permanent_error" : "retryable_error",
            permanent && retryable ? "provider_retry_exhausted" : errorCode,
            attempts,
            permanent ? undefined : new Date(now().getTime() + backoffMs(attempts)),
          );
          if (permanent) summary.permanentErrors += 1;
          else summary.failed += 1;
        }
        log({
          event: "embedding_batch_failed",
          space: space.slug,
          retryable,
          jobs: requestBatch.length,
          errorCode,
        });
      }
    }
  }
  return summary;
}

/**
 * Explicit bounded paid bootstrap for relevance evaluation. This cannot run
 * jobs outside the cryptographic candidate subset and cannot authorize the
 * later full-corpus backfill.
 */
export async function runConfirmedEvaluationCandidateBackfill(
  db: Surreal,
  providerFactory: ProviderFactory,
  options: ConfirmedEvaluationCandidateOptions,
): Promise<{ plan: EvaluationCandidatePlan; summaries: Record<string, WorkerSummary> }> {
  if (!options.allowExternalProviderCalls) {
    throw new Error("evaluation candidate backfill requires explicit external-call approval");
  }
  const plan = await prepareEvaluationCandidatePlan(db, options);
  validateEvaluationCandidatePlan(plan);
  if (plan.blockers.length > 0) {
    throw new Error(`evaluation candidate backfill blocked: ${plan.blockers.join("; ")}`);
  }
  if (options.confirmation !== plan.confirmation) {
    throw new Error(`evaluation candidate confirmation mismatch; expected ${plan.confirmation}`);
  }
  const revalidated = await prepareEvaluationCandidatePlan(db, options);
  if (revalidated.planSha256 !== plan.planSha256 || revalidated.blockers.length > 0) {
    throw new Error("evaluation candidate plan drifted after confirmation");
  }
  const summaries: Record<string, WorkerSummary> = {};
  const invocationAuthorizedIds = new Set(
    plan.spaces.flatMap((space) =>
      space.runnableJobs.slice(0, options.maxJobsPerSpace).map((job) => job.jobId),
    ),
  );
  for (const spacePlan of plan.spaces) {
    const authorized = spacePlan.runnableJobs.slice(0, options.maxJobsPerSpace);
    if (authorized.length === 0) continue;
    const authorizedIds = new Set(authorized.map((job) => job.jobId));
    const space = await getSpaceBySlug(db, spacePlan.space.slug);
    if (!space) throw new Error("evaluation candidate selected space disappeared");
    const records = (
      await selectAll<{ id: RecordId }>(
        db,
        "SELECT id FROM embedding_job WHERE embedding_space = $space",
        { space: space.id },
      )
    ).filter((row) => authorizedIds.has(String(row.id))).map((row) => row.id);
    if (records.length !== authorizedIds.size) {
      throw new Error("evaluation candidate authorized job binding disappeared");
    }
    const guardedFactory: ProviderFactory = (selectedSpace) => {
      const provider = providerFactory(selectedSpace);
      if (
        provider.provider !== selectedSpace.provider || provider.model !== selectedSpace.model ||
        provider.dimensions !== selectedSpace.dimensions
      ) throw new Error("evaluation candidate provider config mismatch");
      return provider;
    };
    summaries[space.slug] = await runAuthorizedSpaceWorker(
      db,
      guardedFactory,
      space,
      {
        authorizedJobIds: records,
        limit: authorized.length,
        batchSize: options.batchSize,
        privacy: options.privacy,
        workerId: options.workerId,
        logger: options.logger,
      },
      async (jobs) => {
        const currentBatchIds = new Set(jobs.map((job) => String(job.id)));
        if (
          currentBatchIds.size !== jobs.length ||
          jobs.some((job) => !authorizedIds.has(String(job.id)))
        ) {
          throw new Error("evaluation candidate worker selected an unbound job");
        }
        const current = await prepareEvaluationCandidatePlan(db, options);
        assertEvaluationCandidateCallGate(
          plan,
          current,
          invocationAuthorizedIds,
          currentBatchIds,
        );
      },
    );
  }
  return { plan, summaries };
}

/**
 * Read-only production plan. It refuses drift between the exact report and
 * current corpus and documents every permanent error by record id.
 */
export async function prepareProductionBackfill(
  db: Surreal,
  spaceSlug: string,
  exactReport: ExactTokenCountReport,
  options: PrepareProductionBackfillOptions,
): Promise<ProductionBackfillPlan> {
  validateExactTokenCountReport(exactReport);
  const space = await getSpaceBySlug(db, spaceSlug);
  if (!space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  if (
    (!Number.isFinite(options.pricePer1MTokens) || options.pricePer1MTokens < 0)
  ) {
    throw new Error("production backfill requires finite pricePer1MTokens >= 0");
  }
  if (!Number.isSafeInteger(options.maxJobs) || options.maxJobs < 1) {
    throw new Error("production backfill requires maxJobs > 0");
  }
  const acceptanceSha256 = await validateAcceptedRelevance(
    options.acceptedRelevance,
    exactReport,
    space,
    options.privacy,
  );
  const blockers: string[] = [];
  if (exactReport.tokenizer.id !== EXACT_TOKENIZER_ID) {
    blockers.push(`untrusted exact tokenizer ${exactReport.tokenizer.id}`);
  }
  if (exactReport.price?.configuredPricePer1MTokens !== options.pricePer1MTokens) {
    blockers.push("exact token report price differs from current configured price");
  }
  if (exactReport.tokenizer.model !== space.model) {
    blockers.push(
      `tokenizer report model ${exactReport.tokenizer.model} != space model ${space.model}`,
    );
  }
  if (space.segmentation_version !== SEGMENTATION_VERSION) {
    blockers.push(
      `space segmentation_version ${space.segmentation_version} != current ${SEGMENTATION_VERSION}`,
    );
  }

  const [jobs, vectors] = await Promise.all([
    selectAll<PlanJobRow>(
      db,
      `SELECT id, search_document, input_sha256, status, last_error, created_at
       FROM embedding_job WHERE embedding_space = $space`,
      { space: space.id },
    ),
    selectAll<PlanVectorRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256,
         array::len(vector) AS dimensions
       FROM ${space.physical_table}`,
    ),
  ]);

  const exactByDocument = new Map(exactReport.documents.map((doc) => [doc.id, doc]));
  const currentDocumentIds = new Set<string>();
  const eligible = new Map<string, ProductionDocumentBinding>();
  const privacyExcluded = new Map<string, { contentSha256: string; reason: string }>();
  let eligibleTokens = 0;
  let privacyExcludedDocuments = 0;
  // Content нужен только для privacy maxDocumentBytes; читаем его страницами,
  // чтобы production preflight не собирал весь приватный корпус в RAM.
  const DOCUMENT_PAGE_SIZE = 250;
  let start = 0;
  for (;;) {
    const page = await selectAll<PlanDocumentRow>(
      db,
      `SELECT id, content, content_sha256, document_type, extraction_version,
         segmentation_version, dialogue.id AS dialogue_id,
         dialogue_revision.id AS revision_id,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document ORDER BY id LIMIT $limit START $start`,
      { limit: DOCUMENT_PAGE_SIZE, start },
    );
    for (const doc of page) {
      const id = String(doc.id);
      currentDocumentIds.add(id);
      if (!doc.dialogue_id || !doc.revision_id) {
        blockers.push(`corpus drift: ownership binding отсутствует для ${id}`);
        continue;
      }
      const actualContentSha256 = sha256(doc.content);
      if (actualContentSha256 !== doc.content_sha256) {
        blockers.push(`corpus drift: stored content hash не совпадает с content для ${id}`);
        continue;
      }
      const exclusion = privacyExclusion(
        {
          harness: doc.harness,
          workspace: doc.workspace,
          documentType: doc.document_type,
          contentBytes: utf8Bytes(doc.content),
        },
        options.privacy,
      );
      if (exclusion) {
        privacyExcludedDocuments += 1;
        privacyExcluded.set(id, {
          contentSha256: doc.content_sha256,
          reason: privacyExclusionCode(exclusion),
        });
        continue;
      }
      const exact = exactByDocument.get(id);
      if (!exact) {
        blockers.push(`corpus drift: eligible ${id} отсутствует в exact report`);
        continue;
      }
      if (exact.contentSha256 !== doc.content_sha256) {
        blockers.push(`corpus drift: content hash изменился для ${id}`);
        continue;
      }
      const binding: ProductionDocumentBinding = {
        documentId: id,
        dialogueId: String(doc.dialogue_id),
        revisionId: String(doc.revision_id),
        contentSha256: doc.content_sha256,
        extractionVersion: String(doc.extraction_version),
        segmentationVersion: String(doc.segmentation_version),
      };
      eligible.set(id, binding);
      eligibleTokens += exact.tokens;
      if (binding.extractionVersion !== String(EXTRACTOR_VERSION)) {
        blockers.push(
          `${id}: extraction_version ${binding.extractionVersion} != current ${EXTRACTOR_VERSION}`,
        );
      }
      if (
        binding.segmentationVersion !== SEGMENTATION_VERSION ||
        binding.segmentationVersion !== space.segmentation_version
      ) {
        blockers.push(
          `${id}: segmentation_version ${binding.segmentationVersion} не совпадает с current/space`,
        );
      }
      if (exact.tokens >= EMBEDDING_MODEL_TOKEN_LIMIT) {
        blockers.push(
          `${id}: exact tokens ${exact.tokens} >= model limit ${EMBEDDING_MODEL_TOKEN_LIMIT}`,
        );
      }
    }
    if (page.length < DOCUMENT_PAGE_SIZE) break;
    start += page.length;
  }
  if (eligible.size !== exactReport.corpus.documents) {
    blockers.push(
      `eligible corpus drift: exact report documents=${exactReport.corpus.documents}, current=${eligible.size}`,
    );
  }
  for (const exact of exactReport.documents) {
    if (!eligible.has(exact.id)) {
      blockers.push(`eligible corpus drift: ${exact.id} отсутствует в current eligible corpus`);
    }
  }
  const currentEligibleFingerprint = eligibleCorpusFingerprint(
    [...eligible.values()].map((document) => ({
      id: document.documentId,
      contentSha256: document.contentSha256,
    })),
  );
  if (currentEligibleFingerprint.sha256 !== exactReport.corpus.fingerprintSha256) {
    blockers.push("eligible corpus fingerprint differs from exact token report");
  }

  const jobBindings: ProductionJobBinding[] = jobs
    .map((job) => ({
      jobId: String(job.id),
      documentId: String(job.search_document),
      inputSha256: job.input_sha256,
      status: job.status,
      createdAt: new Date(job.created_at).toISOString(),
    }))
    .sort((a, b) => a.jobId.localeCompare(b.jobId));
  const vectorBindings: ProductionVectorBinding[] = vectors
    .map((vector) => ({
      vectorId: String(vector.id),
      documentId: String(vector.search_document),
      inputSha256: vector.input_sha256,
      dimensions: vector.dimensions,
    }))
    .sort((a, b) => a.vectorId.localeCompare(b.vectorId));
  const jobsByDocument = new Map<string, PlanJobRow[]>();
  for (const job of jobs) {
    const id = String(job.search_document);
    jobsByDocument.set(id, [...(jobsByDocument.get(id) ?? []), job]);
  }
  const vectorsByDocument = new Map<string, PlanVectorRow[]>();
  for (const vector of vectors) {
    const id = String(vector.search_document);
    vectorsByDocument.set(id, [...(vectorsByDocument.get(id) ?? []), vector]);
  }
  const statusCounts: Record<string, number> = {};
  const permanentErrors: ProductionBackfillPlan["permanentErrors"] = [];
  for (const job of jobs) {
    if (!currentDocumentIds.has(String(job.search_document))) {
      blockers.push(`${String(job.id)}: orphan embedding_job`);
    }
  }
  for (const [id, exclusion] of privacyExcluded) {
    const documentJobs = jobsByDocument.get(id) ?? [];
    if (documentJobs.length !== 1) {
      blockers.push(`${id}: privacy-excluded document has ${documentJobs.length} jobs instead of one`);
      continue;
    }
    const job = documentJobs[0]!;
    if (job.input_sha256 !== exclusion.contentSha256) {
      blockers.push(`${id}: privacy-excluded job input hash mismatch`);
    }
    if (job.status !== "cancelled" || job.last_error !== exclusion.reason) {
      blockers.push(`${id}: privacy-excluded job is not cancelled with ${exclusion.reason}`);
    }
    if ((vectorsByDocument.get(id)?.length ?? 0) > 0) {
      blockers.push(`${id}: privacy-excluded document has vector`);
    }
  }
  for (const [id, document] of eligible) {
    const documentJobs = jobsByDocument.get(id) ?? [];
    if (documentJobs.length === 0) {
      blockers.push(`${id}: отсутствует embedding_job для space ${space.slug}`);
      continue;
    }
    if (documentJobs.length !== 1) {
      blockers.push(`${id}: найдено ${documentJobs.length} embedding_job вместо одного`);
      continue;
    }
    const job = documentJobs[0]!;
    if (job.input_sha256 !== document.contentSha256) {
      blockers.push(`${id}: job input hash не совпадает с current document`);
    }
    statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
    if (job.status === "cancelled") {
      blockers.push(`${id}: eligible job ошибочно cancelled`);
    }
    if (job.status === "permanent_error") {
      const rawError = job.last_error?.trim() ?? "";
      if (!rawError) blockers.push(`${String(job.id)}: permanent_error не документирована`);
      permanentErrors.push({
        jobId: String(job.id),
        documentId: id,
        error: rawError ? sanitizedPermanentError(rawError) : "permanent_error_undocumented",
      });
    }
    if (job.status === "completed") {
      const documentVectors = vectorsByDocument.get(id) ?? [];
      if (documentVectors.length === 0) blockers.push(`${id}: completed job без vector`);
      else if (documentVectors.length !== 1) {
        blockers.push(`${id}: найдено ${documentVectors.length} vectors вместо одного`);
      } else if (
        documentVectors[0]!.input_sha256 !== job.input_sha256 ||
        documentVectors[0]!.input_sha256 !== document.contentSha256
      ) {
        blockers.push(`${id}: vector input hash не совпадает с job/current document`);
      }
    } else if ((vectorsByDocument.get(id)?.length ?? 0) > 0) {
      blockers.push(`${id}: vector существует для job status=${job.status}`);
    }
  }
  for (const vector of vectors) {
    const id = String(vector.search_document);
    if (privacyExcluded.has(id)) continue;
    const document = eligible.get(id);
    if (!document) {
      blockers.push(`${String(vector.id)}: extra/orphan vector для ineligible/missing ${id}`);
      continue;
    }
    if (String(vector.embedding_space) !== String(space.id)) {
      blockers.push(`${String(vector.id)}: vector embedding_space не совпадает`);
    }
    if (vector.input_sha256 !== document.contentSha256) {
      blockers.push(`${String(vector.id)}: stale vector input hash`);
    }
    if (vector.dimensions !== space.dimensions) {
      blockers.push(`${String(vector.id)}: vector dimension не совпадает с space`);
    }
  }
  const runnableJobs = jobBindings
    .filter(
      (job) =>
        eligible.has(job.documentId) &&
        (job.status === "pending" || job.status === "retryable_error"),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
  const eligibleDocumentBindings = [...eligible.values()].sort((a, b) =>
    a.documentId.localeCompare(b.documentId),
  );
  const relevanceEvidence = { ...options.acceptedRelevance, acceptanceSha256 };
  const binding = {
    formatVersion: 1,
    space: {
      id: String(space.id),
      slug: space.slug,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
      physicalTable: space.physical_table,
      segmentationVersion: space.segmentation_version,
    },
    exactTokenReport: {
      tokenizerId: exactReport.tokenizer.id,
      model: exactReport.tokenizer.model,
      corpusFingerprintSha256: exactReport.corpus.fingerprintSha256,
    },
    relevanceEvidence,
    privacy: normalizedPrivacy(options.privacy),
    pricePer1MTokens: options.pricePer1MTokens,
    maxJobs: options.maxJobs,
    eligibleTokens,
    eligibleDocumentBindings,
    jobBindings,
    vectorBindings,
    runnableJobs,
  };
  const planSha256 = sha256Canonical(binding);
  const plan: ProductionBackfillPlan = {
    space,
    exactTokenReport: {
      tokenizerId: exactReport.tokenizer.id,
      model: exactReport.tokenizer.model,
      corpusFingerprintSha256: exactReport.corpus.fingerprintSha256,
    },
    corpusDocuments: currentDocumentIds.size,
    eligibleDocuments: eligible.size,
    privacyExcludedDocuments,
    eligibleTokens,
    pricePer1MTokens: options.pricePer1MTokens,
    exactPriceUsd: (eligibleTokens / 1_000_000) * options.pricePer1MTokens,
    maxJobs: options.maxJobs,
    relevanceEvidence,
    eligibleDocumentBindings,
    jobBindings,
    vectorBindings,
    runnableJobs,
    jobs: statusCounts,
    vectors: vectors.length,
    permanentErrors,
    blockers,
    planSha256,
    confirmation: productionBackfillConfirmation(
      space.slug,
      exactReport.corpus.fingerprintSha256,
      planSha256,
    ),
  };
  return plan;
}

export interface ConfirmedProductionBackfillOptions extends PrepareProductionBackfillOptions {
  exactReport: ExactTokenCountReport;
  confirmation: string;
  /** Separate boolean prevents an accidentally forwarded string from running. */
  allowExternalProviderCalls: boolean;
  /** Required finite cap per invocation; repeat explicitly for later batches. */
  maxJobs: number;
  batchSize?: number;
  workerId?: string;
  logger?: (event: Record<string, unknown>) => void;
}

function assertProviderCallGate(
  expected: ProductionBackfillPlan,
  current: ProductionBackfillPlan,
  invocationAuthorizedIds: ReadonlySet<string>,
  currentBatchIds: ReadonlySet<string>,
): void {
  if (current.blockers.length > 0) {
    throw new Error(`production backfill drift before provider call: ${current.blockers.join("; ")}`);
  }
  if (
    sha256Canonical(current.eligibleDocumentBindings) !==
      sha256Canonical(expected.eligibleDocumentBindings)
  ) {
    throw new Error("production backfill drift before provider call: corpus bindings changed");
  }
  const expectedVectors = new Map(expected.vectorBindings.map((vector) => [vector.vectorId, vector]));
  const documents = new Map(
    expected.eligibleDocumentBindings.map((document) => [document.documentId, document]),
  );
  for (const vector of current.vectorBindings) {
    const currentBatchDocument = expected.runnableJobs.some(
      (job) => currentBatchIds.has(job.jobId) && job.documentId === vector.documentId,
    );
    if (currentBatchDocument) {
      throw new Error("production backfill drift before provider call: current batch vector exists");
    }
    const before = expectedVectors.get(vector.vectorId);
    if (before) {
      if (sha256Canonical(before) !== sha256Canonical(vector)) {
        throw new Error("production backfill drift before provider call: vector changed");
      }
      expectedVectors.delete(vector.vectorId);
      continue;
    }
    const document = documents.get(vector.documentId);
    const authorizedDocument = expected.runnableJobs.some(
      (job) => invocationAuthorizedIds.has(job.jobId) && job.documentId === vector.documentId,
    );
    if (
      !authorizedDocument || !document || vector.inputSha256 !== document.contentSha256 ||
      vector.dimensions !== expected.space.dimensions
    ) throw new Error("production backfill drift before provider call: unbound vector appeared");
  }
  if (expectedVectors.size > 0) {
    throw new Error("production backfill drift before provider call: vector disappeared");
  }
  const currentJobs = new Map(current.jobBindings.map((job) => [job.jobId, job]));
  if (currentJobs.size !== expected.jobBindings.length) {
    throw new Error("production backfill drift before provider call: job set changed");
  }
  const eligible = new Set(expected.eligibleDocumentBindings.map((doc) => doc.documentId));
  const runnable = new Set(expected.runnableJobs.map((job) => job.jobId));
  for (const job of expected.jobBindings) {
    const now = currentJobs.get(job.jobId);
    if (
      !now ||
      now.documentId !== job.documentId ||
      now.inputSha256 !== job.inputSha256 ||
      now.createdAt !== job.createdAt
    ) {
      throw new Error(`production backfill drift before provider call: job ${job.jobId} changed`);
    }
    if (!eligible.has(job.documentId)) continue;
    if (currentBatchIds.has(job.jobId)) {
      if (now.status !== "processing") {
        throw new Error(
          `production backfill drift before provider call: current job ${job.jobId} is ${now.status}`,
        );
      }
    } else if (runnable.has(job.jobId)) {
      if (!["pending", "retryable_error", "processing", "completed"].includes(now.status)) {
        throw new Error(`production backfill drift before provider call: job ${job.jobId} is ${now.status}`);
      }
    } else if (now.status !== job.status) {
      throw new Error(`production backfill drift before provider call: job ${job.jobId} status changed`);
    }
  }
}

/**
 * The only production-call entrypoint in Stage 11 tooling. No implicit loop,
 * no automatic retry of permanent errors, and a required maxJobs cap.
 */
export async function runConfirmedProductionBackfill(
  db: Surreal,
  providerFactory: ProviderFactory,
  spaceSlug: string,
  options: ConfirmedProductionBackfillOptions,
): Promise<{ plan: ProductionBackfillPlan; summary: WorkerSummary }> {
  if (!options.allowExternalProviderCalls) {
    throw new Error("production backfill requires allowExternalProviderCalls=true");
  }
  const plan = await prepareProductionBackfill(db, spaceSlug, options.exactReport, options);
  if (plan.blockers.length > 0) {
    throw new Error(`production backfill blocked:\n- ${plan.blockers.join("\n- ")}`);
  }
  if (options.confirmation !== plan.confirmation) {
    throw new Error(`confirmation mismatch; expected exactly: ${plan.confirmation}`);
  }
  // Re-read the complete bound plan after validating the caller's phrase.
  // Any drift between display/confirmation and execution fails before a
  // provider object is even created.
  const revalidated = await prepareProductionBackfill(
    db,
    spaceSlug,
    options.exactReport,
    options,
  );
  if (revalidated.planSha256 !== plan.planSha256 || revalidated.blockers.length > 0) {
    throw new Error("production backfill plan drifted after confirmation");
  }
  if (plan.runnableJobs.length === 0) {
    const audit = await auditProductionEmbeddingSpace(db, spaceSlug, options.privacy);
    if (!audit.ok) {
      throw new Error(`production backfill zero-work audit failed:\n- ${audit.blockers.join("\n- ")}`);
    }
    return {
      plan,
      summary: {
        completed: 0,
        failed: 0,
        permanentErrors: 0,
        privacyExcluded: audit.privacyExcludedDocuments,
        releasedStale: 0,
        promptTokens: 0,
        batches: 0,
      },
    };
  }

  // leaseJobs legitimately changes selected jobs to processing. Revalidate
  // all immutable bindings one final time inside the first embed call, after
  // the lease but immediately before any external/provider I/O.
  const guardedProviderFactory: ProviderFactory = (space) => {
    const provider = providerFactory(space);
    if (
      provider.provider !== space.provider ||
      provider.model !== space.model ||
      provider.dimensions !== space.dimensions
    ) {
      throw new Error("production backfill provider config не совпадает с selected space");
    }
    return provider;
  };
  const authorized = plan.runnableJobs.slice(0, options.maxJobs);
  const authorizedIds = new Set(authorized.map((job) => job.jobId));
  const authorizedSpace = await getSpaceBySlug(db, spaceSlug);
  if (!authorizedSpace) throw new Error("production backfill selected space disappeared");
  const jobRecords = (
    await selectAll<{ id: RecordId }>(
      db,
      "SELECT id FROM embedding_job WHERE embedding_space = $space",
      { space: authorizedSpace.id },
    )
  ).filter((row) => authorizedIds.has(String(row.id))).map((row) => row.id);
  if (jobRecords.length !== authorizedIds.size) {
    throw new Error("production backfill authorized job binding disappeared");
  }
  const summary = await runAuthorizedSpaceWorker(db, guardedProviderFactory, authorizedSpace, {
    authorizedJobIds: jobRecords,
    limit: authorized.length,
    batchSize: options.batchSize,
    exactTokenCounts: new Map(
      options.exactReport.documents.map((document) => [document.id, document.tokens]),
    ),
    privacy: options.privacy,
    workerId: options.workerId,
    logger: options.logger,
  }, async (jobs) => {
    const currentBatchIds = new Set(jobs.map((job) => String(job.id)));
    if (
      currentBatchIds.size !== jobs.length ||
      jobs.some((job) => !authorizedIds.has(String(job.id)))
    ) {
      throw new Error("production backfill worker selected an unbound job");
    }
    const current = await prepareProductionBackfill(
      db,
      spaceSlug,
      options.exactReport,
      options,
    );
    assertProviderCallGate(plan, current, authorizedIds, currentBatchIds);
  });
  return { plan, summary };
}

export interface VectorDimensionAudit {
  spaceSlug: string;
  vectors: number;
  wrongDimensions: Array<{ vectorId: string; actual: number; expected: number }>;
}

/** Paged read-only dimension audit; avoids loading the whole vector index. */
export async function auditVectorDimensions(
  db: Surreal,
  spaceSlug: string,
  pageSize = 100,
): Promise<VectorDimensionAudit> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error("vector audit pageSize должен быть 1..1000");
  }
  const space = await getSpaceBySlug(db, spaceSlug);
  if (!space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  const wrongDimensions: VectorDimensionAudit["wrongDimensions"] = [];
  let start = 0;
  let total = 0;
  for (;;) {
    const rows = await selectAll<{ id: RecordId; vector: number[] }>(
      db,
      `SELECT id, vector FROM ${space.physical_table} ORDER BY id LIMIT $limit START $start`,
      { limit: pageSize, start },
    );
    total += rows.length;
    for (const row of rows) {
      if (row.vector.length !== space.dimensions) {
        wrongDimensions.push({
          vectorId: String(row.id),
          actual: row.vector.length,
          expected: space.dimensions,
        });
      }
    }
    if (rows.length < pageSize) break;
    start += rows.length;
  }
  return { spaceSlug, vectors: total, wrongDimensions };
}

export interface HnswIndexAudit {
  spaceSlug: string;
  usesKnnScan: boolean;
  expectedIndexName: "vector_hnsw";
  observedIndexNames: string[];
  plan: unknown;
}

function collectExplainFields(
  value: unknown,
  operators: Set<string>,
  indexes: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectExplainFields(item, operators, indexes);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      if (key === "operator") operators.add(item);
      if (["index", "index_name", "indexName"].includes(key)) indexes.add(item);
    }
    collectExplainFields(item, operators, indexes);
  }
}

/** EXPLAIN FULL verification required by Stage 11 / scenario №24. */
export async function auditHnswIndex(db: Surreal, spaceSlug: string): Promise<HnswIndexAudit> {
  const space = await getSpaceBySlug(db, spaceSlug);
  if (!space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  const plan = await db.query(
    `SELECT id FROM ${space.physical_table}
     WHERE vector <|1, 200|> $q EXPLAIN FULL`,
    { q: Array.from({ length: space.dimensions }, () => 0) },
  );
  const operators = new Set<string>();
  const indexes = new Set<string>();
  collectExplainFields(plan, operators, indexes);
  return {
    spaceSlug,
    usesKnnScan: operators.has("KnnScan") && indexes.has("vector_hnsw"),
    expectedIndexName: "vector_hnsw",
    observedIndexNames: [...indexes].sort(),
    plan,
  };
}

export interface ProductionEmbeddingAudit {
  spaceSlug: string;
  ok: boolean;
  documents: number;
  eligibleDocuments: number;
  privacyExcludedDocuments: number;
  jobs: number;
  vectors: number;
  wrongDimensionVectors: VectorDimensionAudit["wrongDimensions"];
  hnswUsesKnnScan: boolean;
  hnswIndexName: "vector_hnsw";
  blockers: string[];
}

/**
 * Strict terminal-state audit for the selected production space. Unlike a
 * progress plan, this accepts no pending/processing/error/operator-cancelled
 * state: every allowed document has one fresh vector and every excluded
 * document has one exact privacy cancellation and no vector.
 */
export async function auditProductionEmbeddingSpace(
  db: Surreal,
  spaceSlug: string,
  policy: PrivacyPolicy,
): Promise<ProductionEmbeddingAudit> {
  const space = await getSpaceBySlug(db, spaceSlug);
  if (!space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  const [documents, jobs, vectors, dimensions, hnsw] = await Promise.all([
    selectAll<PrivacyStateDocumentRow>(
      db,
      `SELECT id, content, content_sha256, document_type, extraction_version,
         segmentation_version, dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document ORDER BY id`,
    ),
    selectAll<PrivacyStateJobRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256, status,
         last_error, created_at, attempts, locked_by, locked_at, completed_at FROM embedding_job
       WHERE embedding_space = $space ORDER BY id`,
      { space: space.id },
    ),
    selectAll<PlanVectorRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256,
         array::len(vector) AS dimensions FROM ${space.physical_table} ORDER BY id`,
    ),
    auditVectorDimensions(db, spaceSlug),
    auditHnswIndex(db, spaceSlug),
  ]);
  const blockers: string[] = [];
  if (space.physical_table !== `search_embedding_${space.slug}`) {
    blockers.push("space physical table identity mismatch");
  }
  if (space.segmentation_version !== SEGMENTATION_VERSION) {
    blockers.push(`space segmentation_version=${space.segmentation_version}`);
  }
  const documentsById = new Map(documents.map((row) => [String(row.id), row]));
  const jobsByDocument = new Map<string, PrivacyStateJobRow[]>();
  for (const job of jobs) {
    const documentId = String(job.search_document);
    jobsByDocument.set(documentId, [...(jobsByDocument.get(documentId) ?? []), job]);
    if (!documentsById.has(documentId)) blockers.push(`${String(job.id)}: orphan job`);
    if (String(job.embedding_space) !== String(space.id)) {
      blockers.push(`${String(job.id)}: cross-space job`);
    }
    if (job.locked_by || job.locked_at) blockers.push(`${String(job.id)}: terminal job remains locked`);
    if (!job.completed_at && ["completed", "cancelled"].includes(job.status)) {
      blockers.push(`${String(job.id)}: terminal job missing completed_at`);
    }
  }
  const vectorsByDocument = new Map<string, PlanVectorRow[]>();
  for (const vector of vectors) {
    const documentId = String(vector.search_document);
    vectorsByDocument.set(documentId, [...(vectorsByDocument.get(documentId) ?? []), vector]);
    if (!documentsById.has(documentId)) blockers.push(`${String(vector.id)}: orphan vector`);
  }
  let eligibleDocuments = 0;
  let privacyExcludedDocuments = 0;
  for (const document of documents) {
    const documentId = String(document.id);
    const documentJobs = jobsByDocument.get(documentId) ?? [];
    const documentVectors = vectorsByDocument.get(documentId) ?? [];
    if (sha256(document.content) !== document.content_sha256) {
      blockers.push(`${documentId}: content SHA-256 mismatch`);
    }
    if (documentJobs.length !== 1) {
      blockers.push(`${documentId}: expected one job, got ${documentJobs.length}`);
      continue;
    }
    const job = documentJobs[0]!;
    if (job.input_sha256 !== document.content_sha256) {
      blockers.push(`${String(job.id)}: stale job input hash`);
    }
    const exclusion = privacyExclusion({
      harness: document.harness,
      workspace: document.workspace,
      documentType: document.document_type,
      contentBytes: utf8Bytes(document.content),
    }, policy);
    if (exclusion) {
      privacyExcludedDocuments += 1;
      const reason = privacyExclusionCode(exclusion);
      if (job.status !== "cancelled" || job.last_error !== reason) {
        blockers.push(`${String(job.id)}: excluded job must be cancelled with ${reason}`);
      }
      if (documentVectors.length !== 0) {
        blockers.push(`${documentId}: privacy-excluded document has vector`);
      }
      continue;
    }
    eligibleDocuments += 1;
    if (job.status !== "completed") {
      blockers.push(`${String(job.id)}: eligible job status=${job.status}`);
    }
    if (job.last_error?.trim()) {
      blockers.push(`${String(job.id)}: completed job retains last_error`);
    }
    if (documentVectors.length !== 1) {
      blockers.push(`${documentId}: eligible document vectors=${documentVectors.length}`);
      continue;
    }
    const vector = documentVectors[0]!;
    const expectedVectorId = `${space.physical_table}:vec_${sha256(
      `${String(document.id.id)}:${String(space.id)}`,
    )}`;
    if (String(vector.id) !== expectedVectorId) {
      blockers.push(`${String(vector.id)}: non-deterministic vector identity`);
    }
    if (String(vector.embedding_space) !== String(space.id)) {
      blockers.push(`${String(vector.id)}: cross-space vector`);
    }
    if (vector.input_sha256 !== document.content_sha256) {
      blockers.push(`${String(vector.id)}: stale vector input hash`);
    }
    if (vector.dimensions !== space.dimensions) {
      blockers.push(`${String(vector.id)}: dimension ${vector.dimensions} != ${space.dimensions}`);
    }
  }
  if (vectors.length !== eligibleDocuments) {
    blockers.push(`physical vector count ${vectors.length} != eligible documents ${eligibleDocuments}`);
  }
  for (const wrong of dimensions.wrongDimensions) {
    blockers.push(`${wrong.vectorId}: dimension ${wrong.actual} != ${wrong.expected}`);
  }
  if (!hnsw.usesKnnScan) blockers.push("HNSW EXPLAIN does not use KnnScan");
  blockers.sort();
  return {
    spaceSlug,
    ok: blockers.length === 0,
    documents: documents.length,
    eligibleDocuments,
    privacyExcludedDocuments,
    jobs: jobs.length,
    vectors: vectors.length,
    wrongDimensionVectors: dimensions.wrongDimensions,
    hnswUsesKnnScan: hnsw.usesKnnScan,
    hnswIndexName: hnsw.expectedIndexName,
    blockers,
  };
}
