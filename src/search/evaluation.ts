/**
 * Relevance evaluation (docs/plan.md §21, этап 11).
 *
 * Judgment set передаётся явным путём во время запуска и не является
 * fixture'ой проекта. По умолчанию принимаются только полноценные наборы
 * из 50–100 запросов. JSON-report не содержит тексты запросов/ожидаемых
 * snippets: private report вместо этого содержит deduplicated exact content
 * только hit-документов, нужный для независимой перепроверки outcomes.
 * Report создаётся с mode 0600 и публикуется атомарно.
 *
 * Candidate embedding spaces ищутся явно через searchVectorInSpace /
 * searchHybridInSpace. Active space при evaluation не переключается.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { RecordId, type Surreal } from "surrealdb";
import { writePrivateFileAtomic } from "../backup/safety.ts";
import { selectAll } from "../db/repositories/helpers.ts";
import {
  auditHnswIndex,
  auditVectorDimensions,
  loadEvaluationCandidatePlanArtifact,
  validateEvaluationCandidatePlan,
  type EvaluationCandidatePlan,
} from "../embeddings/backfill.ts";
import {
  eligibleCorpusFingerprint,
  type EligibleCorpusFingerprint,
} from "../embeddings/token-count.ts";
import type { EmbeddingProvider } from "../embeddings/provider.ts";
import { EMPTY_PRIVACY_POLICY, privacyExclusion, type PrivacyPolicy } from "../embeddings/privacy.ts";
import { getSpaceBySlug, type EmbeddingSpace } from "../embeddings/spaces.ts";
import { privacyExclusionCode } from "../embeddings/jobs.ts";
import {
  searchHybridInSpace,
  searchVectorInSpace,
} from "./hybrid.ts";
import { searchText, type SearchFilters, type SearchHit } from "./fulltext.ts";

export const JUDGMENT_SET_FORMAT_VERSION = 1;
export const EVALUATION_REPORT_FORMAT_VERSION = 1;
export const MIN_JUDGMENT_QUERIES = 50;
export const MAX_JUDGMENT_QUERIES = 100;
/** Wide document pool; metrics still rank the first ten distinct dialogues. */
export const EVALUATION_CANDIDATE_LIMIT = 200;

export const ALLOWED_QUERY_LANGUAGES = ["ru", "en", "mixed"] as const;
export const ALLOWED_QUERY_TYPES = [
  "exact phrase",
  "russian morphology",
  "english technical",
  "function name",
  "model",
  "path",
  "semantic paraphrase",
  "mixed ru/en",
  "code error",
  "deleted dialogue",
] as const;

const REQUIRED_SPACE_MATRIX = [
  { model: "text-embedding-3-small", dimensions: 1536 },
  { model: "text-embedding-3-large", dimensions: 1024 },
  { model: "text-embedding-3-large", dimensions: 3072 },
] as const;

export interface ExpectedDialogue {
  dialogueId: string;
  /** Graded relevance for nDCG; positive integer, default 1. */
  relevance: number;
}

export interface ExpectedSnippet {
  text: string;
  dialogueId?: string;
}

export interface MustNotMatchExample {
  dialogueId?: string;
  snippet?: string;
}

export interface JudgmentFilters {
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
}

export interface RelevanceJudgment {
  id: string;
  query: string;
  expectedDialogues: ExpectedDialogue[];
  expectedSnippets: ExpectedSnippet[];
  mustNotMatchExamples: MustNotMatchExample[];
  queryLanguage: string;
  queryType: string;
  filters?: JudgmentFilters;
}

export interface RelevanceJudgmentSet {
  formatVersion: 1;
  name: string;
  queries: RelevanceJudgment[];
}

export interface ParseJudgmentSetOptions {
  minQueries?: number;
  maxQueries?: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: ожидался JSON object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}: ожидалась непустая строка`);
  }
  return value;
}

function allowedString<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  const parsed = nonEmptyString(value, label);
  if (!allowed.includes(parsed as T[number])) {
    throw new Error(`${label}: недопустимое значение; разрешено ${allowed.join(", ")}`);
  }
  return parsed as T[number];
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: ожидался массив`);
  return value;
}

function parseExpectedDialogue(value: unknown, label: string): ExpectedDialogue {
  if (typeof value === "string") return { dialogueId: nonEmptyString(value, label), relevance: 1 };
  const row = record(value, label);
  const dialogueId = nonEmptyString(row.dialogueId, `${label}.dialogueId`);
  const relevance = row.relevance ?? 1;
  if (!Number.isInteger(relevance) || Number(relevance) <= 0) {
    throw new Error(`${label}.relevance: ожидалось целое число > 0`);
  }
  return { dialogueId, relevance: Number(relevance) };
}

function parseExpectedSnippet(value: unknown, label: string): ExpectedSnippet {
  if (typeof value === "string") return { text: nonEmptyString(value, label) };
  const row = record(value, label);
  return {
    text: nonEmptyString(row.text, `${label}.text`),
    dialogueId:
      row.dialogueId === undefined
        ? undefined
        : nonEmptyString(row.dialogueId, `${label}.dialogueId`),
  };
}

function parseMustNotMatch(value: unknown, label: string): MustNotMatchExample {
  if (typeof value === "string") return { snippet: nonEmptyString(value, label) };
  const row = record(value, label);
  const out: MustNotMatchExample = {
    dialogueId:
      row.dialogueId === undefined
        ? undefined
        : nonEmptyString(row.dialogueId, `${label}.dialogueId`),
    snippet:
      row.snippet === undefined ? undefined : nonEmptyString(row.snippet, `${label}.snippet`),
  };
  if (!out.dialogueId && !out.snippet) {
    throw new Error(`${label}: нужен dialogueId и/или snippet`);
  }
  return out;
}

const STRING_FILTERS = [
  "harness",
  "host",
  "user",
  "workspace",
  "vendor",
  "model",
  "reasoningEffort",
  "role",
  "documentType",
] as const;
const BOOLEAN_FILTERS = ["deletedOnly"] as const;

function parseFilters(value: unknown, label: string): JudgmentFilters | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  const allowed = new Set<string>([...STRING_FILTERS, ...BOOLEAN_FILTERS, "from", "to"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${label}: неизвестный filter "${key}"`);
  }
  const out: JudgmentFilters = {};
  for (const key of STRING_FILTERS) {
    if (input[key] !== undefined) out[key] = nonEmptyString(input[key], `${label}.${key}`);
  }
  for (const key of BOOLEAN_FILTERS) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new Error(`${label}.${key}: ожидался boolean`);
      out[key] = input[key];
    }
  }
  for (const key of ["from", "to"] as const) {
    if (input[key] === undefined) continue;
    const raw = nonEmptyString(input[key], `${label}.${key}`);
    if (Number.isNaN(Date.parse(raw))) throw new Error(`${label}.${key}: некорректная дата`);
    out[key] = raw;
  }
  return out;
}

/** Строгий parser приватного JSON judgment set. */
export function parseJudgmentSet(
  value: unknown,
  options: ParseJudgmentSetOptions = {},
): RelevanceJudgmentSet {
  const root = record(value, "judgment set");
  if (root.formatVersion !== JUDGMENT_SET_FORMAT_VERSION) {
    throw new Error(
      `judgment set: formatVersion должен быть ${JUDGMENT_SET_FORMAT_VERSION}`,
    );
  }
  const name = nonEmptyString(root.name, "judgment set.name");
  const rawQueries = array(root.queries, "judgment set.queries");
  const min = options.minQueries ?? MIN_JUDGMENT_QUERIES;
  const max = options.maxQueries ?? MAX_JUDGMENT_QUERIES;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error("некорректные границы размера judgment set");
  }
  if (rawQueries.length < min || rawQueries.length > max) {
    throw new Error(`judgment set: нужно ${min}–${max} запросов, получено ${rawQueries.length}`);
  }
  const ids = new Set<string>();
  const queries = rawQueries.map((value, index): RelevanceJudgment => {
    const label = `judgment set.queries[${index}]`;
    const row = record(value, label);
    const id = nonEmptyString(row.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`${label}.id: дубликат "${id}"`);
    ids.add(id);
    const expectedDialogues = array(row.expectedDialogues, `${label}.expectedDialogues`).map(
      (item, i) => parseExpectedDialogue(item, `${label}.expectedDialogues[${i}]`),
    );
    if (expectedDialogues.length === 0) {
      throw new Error(`${label}.expectedDialogues: нужен хотя бы один релевантный диалог`);
    }
    if (new Set(expectedDialogues.map((item) => item.dialogueId)).size !== expectedDialogues.length) {
      throw new Error(`${label}.expectedDialogues: dialogueId не должны повторяться`);
    }
    const expectedSnippets = array(row.expectedSnippets, `${label}.expectedSnippets`).map(
      (item, i) => parseExpectedSnippet(item, `${label}.expectedSnippets[${i}]`),
    );
    if (expectedSnippets.length === 0) {
      throw new Error(`${label}.expectedSnippets: нужен хотя бы один ожидаемый snippet`);
    }
    const mustNotMatchExamples = array(
      row.mustNotMatchExamples,
      `${label}.mustNotMatchExamples`,
    ).map((item, i) => parseMustNotMatch(item, `${label}.mustNotMatchExamples[${i}]`));
    if (mustNotMatchExamples.length === 0) {
      throw new Error(`${label}.mustNotMatchExamples: нужен хотя бы один отрицательный пример`);
    }
    return {
      id,
      query: nonEmptyString(row.query, `${label}.query`),
      expectedDialogues,
      expectedSnippets,
      mustNotMatchExamples,
      queryLanguage: allowedString(
        row.queryLanguage,
        `${label}.queryLanguage`,
        ALLOWED_QUERY_LANGUAGES,
      ),
      queryType: allowedString(row.queryType, `${label}.queryType`, ALLOWED_QUERY_TYPES),
      filters: parseFilters(row.filters, `${label}.filters`),
    };
  });
  return { formatVersion: JUDGMENT_SET_FORMAT_VERSION, name, queries };
}

/** Загружает private JSON по явному пути; содержимое не логируется. */
export async function loadJudgmentSet(
  filePath: string,
  options: ParseJudgmentSetOptions = {},
): Promise<RelevanceJudgmentSet> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    // Не включаем filesystem path или системный error: они могут раскрывать
    // приватное имя judgment set или домашний каталог.
    throw new Error("judgment_set_read_error");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    // Bun/Node могут включить фрагмент JSON в SyntaxError.message. Извлекаем
    // только позицию/строку и возвращаем стабильный машинный code без echo.
    const message = error instanceof Error ? error.message : "";
    const explicitLine = /line\s+(\d+)/i.exec(message)?.[1];
    const position = /position\s+(\d+)/i.exec(message)?.[1];
    const privateToken = /(?:identifier|token|character)\s+["']([^"']+)["']/i
      .exec(message)?.[1];
    const tokenPosition = privateToken ? source.indexOf(privateToken) : -1;
    const line = explicitLine
      ? Number(explicitLine)
      : position
        ? source.slice(0, Number(position)).split("\n").length
        : tokenPosition >= 0
          ? source.slice(0, tokenPosition).split("\n").length
          : source.split("\n").length;
    throw new Error(`judgment_set_invalid_json${line ? ` line=${line}` : ""}`);
  }
  return parseJudgmentSet(parsed, options);
}

async function loadExactJudgmentArtifact(filePath: string): Promise<{
  set: RelevanceJudgmentSet;
  source: string;
  artifactSha256: string;
}> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new Error("judgment_set_read_error");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("judgment_set_invalid_json");
  }
  return {
    set: parseJudgmentSet(parsed),
    source,
    artifactSha256: createHash("sha256").update(source).digest("hex"),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown, pretty = false): string {
  return JSON.stringify(canonicalize(value), null, pretty ? 2 : undefined);
}

function normalizedEvaluationPrivacy(policy: PrivacyPolicy): PrivacyPolicy {
  return {
    excludeHarnesses: [...policy.excludeHarnesses].sort(),
    excludeWorkspaces: [...policy.excludeWorkspaces].sort(),
    excludeDocumentTypes: [...policy.excludeDocumentTypes].sort(),
    maxDocumentBytes: policy.maxDocumentBytes,
  };
}

export function judgmentSetSha256(set: RelevanceJudgmentSet): string {
  return createHash("sha256").update(stableJson(set)).digest("hex");
}

interface CorpusFingerprintRow {
  id: RecordId;
  content: string;
  content_sha256: string;
  document_type: string;
  harness?: string;
  workspace?: string;
}

export interface SearchCorpusFingerprintOptions {
  pageSize?: number;
  privacy?: PrivacyPolicy;
}

/**
 * Deterministic fingerprint of everything that can affect ranking/filtering.
 * Content itself never leaves the DB; only its stored SHA enters the digest.
 */
export async function computeSearchCorpusFingerprint(
  db: Surreal,
  options: number | SearchCorpusFingerprintOptions = {},
): Promise<SearchCorpusFingerprint> {
  const pageSize = typeof options === "number" ? options : (options.pageSize ?? 500);
  const privacy = typeof options === "number" ? EMPTY_PRIVACY_POLICY :
    (options.privacy ?? EMPTY_PRIVACY_POLICY);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5_000) {
    throw new Error("corpus fingerprint pageSize должен быть 1..5000");
  }
  const documents: Array<{ id: string; contentSha256: string }> = [];
  let start = 0;
  for (;;) {
    const rows = await selectAll<CorpusFingerprintRow>(
      db,
      `SELECT id, content, content_sha256, document_type,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document ORDER BY id LIMIT $limit START $start`,
      { limit: pageSize, start },
    );
    for (const row of rows) {
      const actualSha256 = createHash("sha256").update(row.content).digest("hex");
      if (actualSha256 !== row.content_sha256) {
        throw new Error(`eligible corpus: stored content hash mismatch for ${String(row.id)}`);
      }
      if (privacyExclusion({
        harness: row.harness,
        workspace: row.workspace,
        documentType: row.document_type,
        contentBytes: Buffer.byteLength(row.content, "utf8"),
      }, privacy)) continue;
      documents.push({ id: String(row.id), contentSha256: row.content_sha256 });
    }
    if (rows.length < pageSize) break;
    start += rows.length;
  }
  const fingerprint = eligibleCorpusFingerprint(documents);
  if (fingerprint.documents === 0) throw new Error("eligible corpus пуст");
  return fingerprint;
}

function normalizeSnippet(value: string): string {
  return value
    .replaceAll(/<\/?em>/gi, "")
    .replaceAll("…", "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function searchDocumentRecord(id: string): RecordId {
  const prefix = "search_document:";
  if (!id.startsWith(prefix) || id.length === prefix.length) {
    throw new Error(`evaluation hit is not a search_document: ${id}`);
  }
  return new RecordId("search_document", id.slice(prefix.length));
}

async function collectHitEvidence(
  db: Surreal,
  hits: readonly SearchHit[],
): Promise<{
  hitEvidence: EvaluationHitEvidence[];
  contentEvidence: EvaluationDocumentContentEvidence[];
}> {
  const recordById = new Map<string, RecordId>();
  for (const hit of hits) recordById.set(hit.id, searchDocumentRecord(hit.id));
  const rows = recordById.size === 0
    ? []
    : await selectAll<{
      id: RecordId;
      content: string;
      content_sha256: string;
      dialogue_id: RecordId;
      revision_id: RecordId;
    }>(
      db,
      `SELECT id, content, content_sha256, dialogue.id AS dialogue_id,
         dialogue_revision.id AS revision_id
       FROM search_document WHERE id INSIDE $ids`,
      { ids: [...recordById.values()] },
    );
  const bindings = new Map(rows.map((row) => [String(row.id), row]));
  if (bindings.size !== recordById.size) {
    throw new Error("evaluation hit evidence document set changed");
  }
  const contentEvidence = [...bindings.values()].map((binding) => {
    if (createHash("sha256").update(binding.content).digest("hex") !== binding.content_sha256) {
      throw new Error(`evaluation hit content hash mismatch: ${String(binding.id)}`);
    }
    return {
      documentId: String(binding.id),
      dialogueId: String(binding.dialogue_id),
      revisionId: String(binding.revision_id),
      contentSha256: binding.content_sha256,
      content: binding.content,
    };
  }).sort((a, b) => a.documentId.localeCompare(b.documentId));
  const hitEvidence = hits.map((hit) => {
    const binding = bindings.get(hit.id);
    const contentSha256 = binding?.content_sha256;
    if (
      !contentSha256 || !/^[0-9a-f]{64}$/.test(contentSha256) ||
      String(binding?.dialogue_id) !== hit.dialogueId ||
      String(binding?.revision_id) !== hit.revisionId
    ) {
      throw new Error(`evaluation hit content hash missing: ${hit.id}`);
    }
    return {
      documentId: hit.id,
      dialogueId: hit.dialogueId,
      revisionId: hit.revisionId,
      contentSha256,
    };
  });
  return { hitEvidence, contentEvidence };
}

function validateHitEvidence(
  hits: readonly SearchHit[],
  evidence: readonly EvaluationHitEvidence[],
  contentEvidence: readonly EvaluationDocumentContentEvidence[],
  label: string,
): Map<string, EvaluationDocumentContentEvidence> {
  if (hits.length !== evidence.length) throw new Error(`${label}: hit evidence length mismatch`);
  const contentByDocument = new Map<string, EvaluationDocumentContentEvidence>();
  for (const item of contentEvidence) {
    if (
      !item.documentId?.trim() || !item.dialogueId?.trim() || !item.revisionId?.trim() ||
      !/^[0-9a-f]{64}$/.test(item.contentSha256) || typeof item.content !== "string" ||
      createHash("sha256").update(item.content).digest("hex") !== item.contentSha256 ||
      contentByDocument.has(item.documentId)
    ) throw new Error(`${label}: content evidence invalid`);
    contentByDocument.set(item.documentId, item);
  }
  const referenced = new Set<string>();
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]!;
    const item = evidence[index]!;
    const content = contentByDocument.get(item.documentId);
    if (
      item.documentId !== hit.id || item.dialogueId !== hit.dialogueId ||
      item.revisionId !== hit.revisionId || !/^[0-9a-f]{64}$/.test(item.contentSha256) ||
      !content || content.dialogueId !== item.dialogueId ||
      content.revisionId !== item.revisionId || content.contentSha256 !== item.contentSha256
    ) throw new Error(`${label}: hit evidence mismatch at ${index}`);
    referenced.add(item.documentId);
  }
  if (
    referenced.size !== contentByDocument.size ||
    [...contentByDocument].some(([documentId]) => !referenced.has(documentId))
  ) throw new Error(`${label}: unrelated or missing content evidence`);
  return contentByDocument;
}

/** Метрики считаются по уникальным dialogue, первый hit задаёт rank. */
export function distinctDialogueHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.dialogueId)) return false;
    seen.add(hit.dialogueId);
    return true;
  });
}

export interface QueryMetrics {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  irrelevantTop5Share: number;
  relevantFoundAt5: number;
  relevantFoundAt10: number;
  relevantTotal: number;
  /** 1-based rank; null when no relevant dialogue was retrieved. */
  firstRelevantRank: number | null;
  dcgAt10: number;
  idealDcgAt10: number;
  retrievalFailed: boolean;
  distinctDialoguesRanked: number;
  dialogueCandidateShortfall: number;
}

/** Чистый расчёт обязательных метрик §21 по ranked dialogue hits. */
export function calculateQueryMetrics(
  judgment: Pick<RelevanceJudgment, "expectedDialogues">,
  hits: readonly SearchHit[],
): QueryMetrics {
  const ranked = distinctDialogueHits(hits);
  const relevance = new Map(judgment.expectedDialogues.map((item) => [item.dialogueId, item.relevance]));
  const found = (k: number) =>
    new Set(ranked.slice(0, k).map((hit) => hit.dialogueId).filter((id) => relevance.has(id))).size;
  const relevantFoundAt5 = found(5);
  const relevantFoundAt10 = found(10);
  // The persisted evidence contains the top ten dialogue ids; MRR is bounded
  // to the same auditable ranking window as Recall@10 and nDCG@10.
  const firstRelevant = ranked.slice(0, 10).findIndex((hit) => relevance.has(hit.dialogueId));
  const dcg = ranked.slice(0, 10).reduce((sum, hit, index) => {
    const grade = relevance.get(hit.dialogueId) ?? 0;
    return sum + (2 ** grade - 1) / Math.log2(index + 2);
  }, 0);
  const idealDcg = [...relevance.values()]
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const top5 = ranked.slice(0, 5);
  const irrelevant = top5.filter((hit) => !relevance.has(hit.dialogueId)).length;
  return {
    recallAt5: relevantFoundAt5 / relevance.size,
    recallAt10: relevantFoundAt10 / relevance.size,
    mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    ndcgAt10: idealDcg === 0 ? 0 : dcg / idealDcg,
    // Empty retrieval is a complete failure, not an apparently optimal 0%.
    irrelevantTop5Share: top5.length === 0 ? 1 : irrelevant / top5.length,
    relevantFoundAt5,
    relevantFoundAt10,
    relevantTotal: relevance.size,
    firstRelevantRank: firstRelevant < 0 ? null : firstRelevant + 1,
    dcgAt10: dcg,
    idealDcgAt10: idealDcg,
    retrievalFailed: ranked.length === 0,
    distinctDialoguesRanked: Math.min(10, ranked.length),
    dialogueCandidateShortfall: Math.max(0, 10 - ranked.length),
  };
}

function exampleMatchesEvidence(
  example: MustNotMatchExample,
  hit: EvaluationHitEvidence,
  contentByDocument: ReadonlyMap<string, EvaluationDocumentContentEvidence>,
): boolean {
  if (example.dialogueId && example.dialogueId !== hit.dialogueId) return false;
  const content = contentByDocument.get(hit.documentId);
  if (!content) throw new Error(`evaluation content evidence missing: ${hit.documentId}`);
  if (example.snippet && !normalizeSnippet(content.content).includes(normalizeSnippet(example.snippet))) {
    return false;
  }
  return true;
}

function expectedSnippetMatchesEvidence(
  expected: ExpectedSnippet,
  hit: EvaluationHitEvidence,
  contentByDocument: ReadonlyMap<string, EvaluationDocumentContentEvidence>,
): boolean {
  if (expected.dialogueId && expected.dialogueId !== hit.dialogueId) return false;
  const content = contentByDocument.get(hit.documentId);
  if (!content) throw new Error(`evaluation content evidence missing: ${hit.documentId}`);
  return normalizeSnippet(content.content).includes(normalizeSnippet(expected.text));
}

export type EvaluationMode = "text" | "vector" | "hybrid";

/** §21 resource metrics are measured by the CLI/container observer. */
export interface EvaluationResourceMeasurements {
  source: string;
  vectorIndexBytes: number;
  peakRamBytes: number;
  indexBuildMs: number;
}

export interface EvaluationReadinessEvidence {
  source: string;
  documents: number;
  jobs: number;
  completedJobs: number;
  vectors: number;
  jobCoverageErrors: number;
  vectorCoverageErrors: number;
  inputHashErrors: number;
  expectedDimensions: number;
  wrongDimensionVectors: number;
  hnswIndexName: string;
  hnswUsesKnnScan: boolean;
  /** Documents remaining after privacy normalization, including documented permanent errors. */
  privacyNormalizedDocuments: number;
  privacyExcludedDocuments: number;
  permanentExcludedDocuments: number;
  /** Documents that must have a completed job and vector. */
  eligibleDocuments: number;
  exclusions: EvaluationReadinessExclusion[];
}

export interface EvaluationReadinessExclusion {
  category: "privacy" | "permanent";
  code: string;
  /** Exact row identities; aggregate-only declarations are not accepted. */
  jobId: string;
  documentId: string;
  /** Human-readable external ticket/report id; never a content excerpt. */
  evidence: string;
}

export interface SearchCorpusFingerprint extends EligibleCorpusFingerprint {}

/** Minimal private retrieval evidence needed to rederive judgments. */
export interface EvaluationHitEvidence {
  documentId: string;
  dialogueId: string;
  revisionId: string;
  contentSha256: string;
}

/** Exact private bytes, deduplicated by hit document within a scenario. */
export interface EvaluationDocumentContentEvidence extends EvaluationHitEvidence {
  content: string;
}

/** Exact DB-derived identity used to authenticate full-corpus hit evidence. */
export interface EvaluationCorpusDocumentBinding extends EvaluationHitEvidence {}

export interface EvaluationSearchResponse {
  hits: SearchHit[];
  /** One exact, ordered entry per hit. */
  hitEvidence: EvaluationHitEvidence[];
  /** Exact bytes for each distinct hit document; never a self-hashed snippet. */
  contentEvidence: EvaluationDocumentContentEvidence[];
  /** Provider request only, excluding ANN/BM25 retrieval. */
  providerLatencyMs: number;
  /** DB/search work excluding the provider request. */
  retrievalLatencyMs: number;
}

export interface EvaluationScenario {
  id: string;
  mode: EvaluationMode;
  space?: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  resourceMeasurements?: EvaluationResourceMeasurements;
  readiness?: EvaluationReadinessEvidence;
  /** Runtime scope marker prevents candidate/full-corpus paths from mixing. */
  evaluationScope?: "candidate_subset" | "full_corpus";
  candidatePlanSha256?: string;
  /** Created scenarios carry a read-only fingerprint seam for drift gates. */
  corpusFingerprint?: () => Promise<SearchCorpusFingerprint>;
  search(
    query: string,
    filters: SearchFilters,
  ): Promise<EvaluationSearchResponse>;
}

export interface EvaluationQueryResult extends QueryMetrics {
  queryId: string;
  query?: string;
  /** Binds the private query without storing it in the report. */
  querySha256: string;
  /** Binds the exact normalized filter object without exposing query text. */
  filtersSha256: string;
  queryLanguage: string;
  queryType: string;
  latencyMs: number;
  providerLatencyMs: number;
  retrievalLatencyMs: number;
  returnedDialogues: number;
  topDialogueIds: string[];
  matchedExpectedSnippets: number;
  expectedSnippetsTotal: number;
  mustNotMatchViolations: number;
  mustNotExamplesTotal: number;
  /** One boolean per exact judgment negative. */
  mustNotMatchOutcomes: boolean[];
  /** Private, minimum per-hit evidence authenticated by the report bytes. */
  hitEvidence: EvaluationHitEvidence[];
}

export interface EvaluationAggregate
  extends Omit<
    QueryMetrics,
    | "retrievalFailed"
    | "distinctDialoguesRanked"
    | "dialogueCandidateShortfall"
    | "firstRelevantRank"
    | "dcgAt10"
    | "idealDcgAt10"
  > {
  queries: number;
  latencyMs: {
    mean: number;
    p50: number;
    p95: number;
    max: number;
  };
  providerLatencyMs: {
    mean: number;
    p50: number;
    p95: number;
    max: number;
  };
  retrievalLatencyMs: {
    mean: number;
    p50: number;
    p95: number;
    max: number;
  };
  expectedSnippetRecall: number;
  mustNotMatchViolations: number;
  retrievalFailures: number;
  dialogueCandidateShortfallQueries: number;
}

export interface EvaluationScenarioReport {
  id: string;
  mode: EvaluationMode;
  space?: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  resourceMeasurements?: EvaluationResourceMeasurements;
  readiness?: EvaluationReadinessEvidence;
  corpusChecks: {
    before: SearchCorpusFingerprint;
    after: SearchCorpusFingerprint;
  };
  /** Private exact bytes for the scenario hit documents, deduplicated by id. */
  contentEvidence: EvaluationDocumentContentEvidence[];
  aggregate: EvaluationAggregate;
  queries: EvaluationQueryResult[];
}

export interface RelevanceEvaluationReport {
  formatVersion: 1;
  generatedAt: string;
  judgmentSet: {
    name: string;
    artifactSha256: string;
    sha256: string;
    queries: number;
  };
  corpus: SearchCorpusFingerprint;
  candidatePlan: {
    artifactSha256: string;
    planSha256: string;
    corpusSha256: string;
    subsetSha256: string;
    privacySha256: string;
  };
  metricDefinitions: {
    rankingUnit: "dialogue";
    relevance: "expectedDialogues (unlisted dialogues are irrelevant)";
    irrelevantTop5Denominator: "returned distinct dialogues, up to 5; empty retrieval = 1";
    latency: "uncached provider and retrieval measured separately; scenarios and queries run sequentially";
  };
  scenarios: EvaluationScenarioReport[];
}

/**
 * Final Stage 11 evidence is intentionally a different artifact from the
 * bounded candidate matrix. It is produced only for the selected, fully
 * backfilled space and ranks against every privacy-eligible distractor.
 */
export interface FullCorpusHybridEvaluationReport {
  formatVersion: 1;
  evaluationKind: "final_full_corpus_hybrid";
  generatedAt: string;
  judgmentSet: {
    name: string;
    artifactSha256: string;
    sha256: string;
    queries: number;
  };
  corpus: SearchCorpusFingerprint;
  /** Exact eligible DB snapshot; content bytes remain limited to hit evidence. */
  corpusDocuments: EvaluationCorpusDocumentBinding[];
  privacySha256: string;
  selectedSpace: Pick<EmbeddingSpace, "slug" | "provider" | "model" | "dimensions">;
  metricDefinitions: RelevanceEvaluationReport["metricDefinitions"];
  scenario: EvaluationScenarioReport;
}

export interface RunEvaluationOptions {
  now?: () => Date;
  nowMs?: () => number;
  /** Приватный query text исключён из report по умолчанию. */
  includeQueryText?: boolean;
  /** Required for hand-built scenarios; createEvaluationScenarios provides it. */
  corpusFingerprint?: () => Promise<SearchCorpusFingerprint>;
  /** Exact private artifacts used for this run; both are loaded and hashed. */
  judgmentSetPath?: string;
  candidatePlanPath?: string;
  candidatePlan?: Pick<
    EvaluationCandidatePlan,
    "planSha256" | "fullEligibleCorpus" | "subset" | "privacy"
  >;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? sorted.at(-1)!;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function latencySummary(values: readonly number[]): EvaluationAggregate["latencyMs"] {
  return {
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: rounded(percentile(values, 0.5)),
    p95: rounded(percentile(values, 0.95)),
    max: rounded(Math.max(...values)),
  };
}

function aggregate(results: readonly EvaluationQueryResult[]): EvaluationAggregate {
  const mean = (
    field: "recallAt5" | "recallAt10" | "mrr" | "ndcgAt10" | "irrelevantTop5Share",
  ) =>
    results.reduce((sum, row) => sum + Number(row[field]), 0) / results.length;
  const latencies = results.map((row) => row.latencyMs);
  const providerLatencies = results.map((row) => row.providerLatencyMs);
  const retrievalLatencies = results.map((row) => row.retrievalLatencyMs);
  const expectedSnippetsTotal = results.reduce((sum, row) => sum + row.expectedSnippetsTotal, 0);
  const matchedSnippets = results.reduce((sum, row) => sum + row.matchedExpectedSnippets, 0);
  return {
    queries: results.length,
    recallAt5: rounded(mean("recallAt5")),
    recallAt10: rounded(mean("recallAt10")),
    mrr: rounded(mean("mrr")),
    ndcgAt10: rounded(mean("ndcgAt10")),
    irrelevantTop5Share: rounded(mean("irrelevantTop5Share")),
    relevantFoundAt5: results.reduce((sum, row) => sum + row.relevantFoundAt5, 0),
    relevantFoundAt10: results.reduce((sum, row) => sum + row.relevantFoundAt10, 0),
    relevantTotal: results.reduce((sum, row) => sum + row.relevantTotal, 0),
    latencyMs: latencySummary(latencies),
    providerLatencyMs: latencySummary(providerLatencies),
    retrievalLatencyMs: latencySummary(retrievalLatencies),
    expectedSnippetRecall:
      expectedSnippetsTotal === 0 ? 1 : rounded(matchedSnippets / expectedSnippetsTotal),
    mustNotMatchViolations: results.reduce((sum, row) => sum + row.mustNotMatchViolations, 0),
    retrievalFailures: results.filter((row) => row.retrievalFailed).length,
    dialogueCandidateShortfallQueries: results.filter(
      (row) => row.dialogueCandidateShortfall > 0,
    ).length,
  };
}

function validateResourceMeasurements(
  scenarioId: string,
  measurements: EvaluationResourceMeasurements | undefined,
  required: boolean,
): void {
  if (!measurements) {
    if (required) {
      throw new Error(`evaluation scenario ${scenarioId}: resourceMeasurements обязательны`);
    }
    return;
  }
  if (typeof measurements.source !== "string" || !measurements.source.trim()) {
    throw new Error(`evaluation scenario ${scenarioId}: resource measurement source не задан`);
  }
  for (const name of ["vectorIndexBytes", "peakRamBytes", "indexBuildMs"] as const) {
    const value = measurements[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`evaluation scenario ${scenarioId}: ${name} должен быть числом >= 0`);
    }
  }
}

function validateReadiness(
  scenario: EvaluationScenario,
): asserts scenario is EvaluationScenario & { readiness: EvaluationReadinessEvidence } {
  const readiness = scenario.readiness;
  if (!readiness) {
    throw new Error(`evaluation scenario ${scenario.id}: readiness evidence обязательна`);
  }
  if (typeof readiness.source !== "string" || !readiness.source.trim()) {
    throw new Error(`evaluation scenario ${scenario.id}: readiness source не задан`);
  }
  for (const field of [
    "documents",
    "jobs",
    "completedJobs",
    "vectors",
    "jobCoverageErrors",
    "vectorCoverageErrors",
    "inputHashErrors",
    "expectedDimensions",
    "wrongDimensionVectors",
    "privacyNormalizedDocuments",
    "privacyExcludedDocuments",
    "permanentExcludedDocuments",
    "eligibleDocuments",
  ] as const) {
    const value = readiness[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`evaluation scenario ${scenario.id}: readiness.${field} invalid`);
    }
  }
  if (readiness.documents === 0) {
    throw new Error(`evaluation scenario ${scenario.id}: search corpus пуст`);
  }
  if (!Array.isArray(readiness.exclusions)) {
    throw new Error(`evaluation scenario ${scenario.id}: readiness exclusions обязательны`);
  }
  let privacyExclusions = 0;
  let permanentExclusions = 0;
  const exclusionIdentities = new Set<string>();
  for (const exclusion of readiness.exclusions) {
    const stableCode = exclusion.category === "privacy"
      ? /^privacy_excluded_(?:harness|workspace|document_type|document_size|policy)$/.test(exclusion.code)
      : /^provider_(?:permanent_error|retry_exhausted|unexpected_error)$|^(?:vector_dimension_mismatch|provider_vector_count_mismatch)(?: expected=\d+ actual=\d+)?$|^(?:search_document_missing|permanent_error_detail_redacted)$/.test(exclusion.code);
    if (
      !stableCode || !exclusion.jobId?.trim() || !exclusion.documentId?.trim() ||
      !exclusion.evidence?.trim()
    ) {
      throw new Error(`evaluation scenario ${scenario.id}: недокументированное exclusion`);
    }
    const identity = `${exclusion.jobId}\0${exclusion.documentId}`;
    if (exclusionIdentities.has(identity)) {
      throw new Error(`evaluation scenario ${scenario.id}: duplicate exclusion identity`);
    }
    exclusionIdentities.add(identity);
    if (exclusion.category === "privacy") privacyExclusions += 1;
    else permanentExclusions += 1;
  }
  if (
    readiness.jobs !== readiness.documents ||
    readiness.completedJobs !== readiness.eligibleDocuments ||
    readiness.privacyExcludedDocuments !== privacyExclusions ||
    readiness.permanentExcludedDocuments !== permanentExclusions ||
    readiness.privacyNormalizedDocuments + readiness.privacyExcludedDocuments !==
      readiness.documents ||
    readiness.eligibleDocuments + readiness.permanentExcludedDocuments !==
      readiness.privacyNormalizedDocuments
  ) {
    throw new Error(
      `evaluation scenario ${scenario.id}: jobs not ready ` +
        `${readiness.completedJobs}/${readiness.jobs}/${readiness.documents}`,
    );
  }
  if (readiness.vectors !== readiness.eligibleDocuments) {
    throw new Error(
      `evaluation scenario ${scenario.id}: vectors ${readiness.vectors}/${readiness.eligibleDocuments}`,
    );
  }
  if (
    readiness.jobCoverageErrors !== 0 ||
    readiness.vectorCoverageErrors !== 0 ||
    readiness.inputHashErrors !== 0
  ) {
    throw new Error(
      `evaluation scenario ${scenario.id}: job/vector coverage or input hash mismatch`,
    );
  }
  if (readiness.wrongDimensionVectors !== 0) {
    throw new Error(
      `evaluation scenario ${scenario.id}: wrong dimension vectors=${readiness.wrongDimensionVectors}`,
    );
  }
  if (readiness.expectedDimensions !== scenario.space?.dimensions) {
    throw new Error(`evaluation scenario ${scenario.id}: readiness dimension mismatch`);
  }
  if (
    typeof readiness.hnswIndexName !== "string" ||
    !readiness.hnswIndexName.trim() || !readiness.hnswUsesKnnScan
  ) {
    throw new Error(`evaluation scenario ${scenario.id}: HNSW KnnScan не подтверждён`);
  }
}

function spaceMatrixKey(space: EvaluationScenario["space"]): string | undefined {
  return space ? `${space.model.toLowerCase()}@${space.dimensions}` : undefined;
}

function validateEvaluationMatrix(scenarios: readonly EvaluationScenario[]): void {
  const text = scenarios.filter((scenario) => scenario.mode === "text");
  if (text.length !== 1) throw new Error("evaluation matrix: нужен ровно один BM25 scenario");
  validateResourceMeasurements(text[0]!.id, text[0]!.resourceMeasurements, false);
  const expectedKeys = new Set(
    REQUIRED_SPACE_MATRIX.map(({ model, dimensions }) => `${model}@${dimensions}`),
  );
  for (const scenario of scenarios.filter((item) => item.mode !== "text")) {
    if (!scenario.space) throw new Error(`evaluation scenario ${scenario.id}: space обязателен`);
    const key = spaceMatrixKey(scenario.space)!;
    if (!expectedKeys.has(key)) {
      throw new Error(`evaluation matrix: неожиданный candidate ${key}`);
    }
    validateResourceMeasurements(scenario.id, scenario.resourceMeasurements, true);
    validateReadiness(scenario);
  }
  for (const key of expectedKeys) {
    const vector = scenarios.filter(
      (scenario) => scenario.mode === "vector" && spaceMatrixKey(scenario.space) === key,
    );
    const hybrid = scenarios.filter(
      (scenario) => scenario.mode === "hybrid" && spaceMatrixKey(scenario.space) === key,
    );
    if (vector.length !== 1 || hybrid.length !== 1) {
      throw new Error(
        `evaluation matrix: ${key} требует ровно vector + hybrid scenario`,
      );
    }
    if (vector[0]!.space!.slug !== hybrid[0]!.space!.slug) {
      throw new Error(`evaluation matrix: ${key} vector/hybrid используют разные spaces`);
    }
    if (stableJson(vector[0]!.readiness) !== stableJson(hybrid[0]!.readiness)) {
      throw new Error(`evaluation matrix: ${key} readiness evidence расходится`);
    }
    if (
      stableJson(vector[0]!.resourceMeasurements) !==
      stableJson(hybrid[0]!.resourceMeasurements)
    ) {
      throw new Error(`evaluation matrix: ${key} resource measurements расходятся`);
    }
  }
  if (scenarios.length !== 1 + expectedKeys.size * 2) {
    throw new Error("evaluation matrix: ожидается BM25 + 3 vector + 3 hybrid scenarios");
  }
}

function validateCorpusFingerprint(value: SearchCorpusFingerprint, label: string): void {
  if (
    value.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.documents) ||
    value.documents < 1
  ) {
    throw new Error(`${label}: invalid search corpus fingerprint`);
  }
}

function sameCorpus(a: SearchCorpusFingerprint, b: SearchCorpusFingerprint): boolean {
  return a.algorithm === b.algorithm && a.sha256 === b.sha256 && a.documents === b.documents;
}

function toSearchFilters(filters: JudgmentFilters | undefined): SearchFilters {
  return {
    limit: EVALUATION_CANDIDATE_LIMIT,
    ...filters,
    from: filters?.from ? new Date(filters.from) : undefined,
    to: filters?.to ? new Date(filters.to) : undefined,
  };
}

function validateProductionJudgmentCoverage(
  set: RelevanceJudgmentSet,
): RelevanceJudgmentSet {
  const validatedSet = parseJudgmentSet(set);
  const queryTypes = new Set(validatedSet.queries.map((query) => query.queryType));
  const languages = new Set(validatedSet.queries.map((query) => query.queryLanguage));
  for (const queryType of ALLOWED_QUERY_TYPES) {
    if (!queryTypes.has(queryType)) {
      throw new Error(`judgment set coverage: отсутствует query type ${queryType}`);
    }
  }
  for (const language of ALLOWED_QUERY_LANGUAGES) {
    if (!languages.has(language)) {
      throw new Error(`judgment set coverage: отсутствует language ${language}`);
    }
  }
  return validatedSet;
}

/**
 * Все scenario/query выполняются последовательно: latency сопоставима,
 * provider не получает неожиданный burst, порядок report детерминирован.
 */
export async function runRelevanceEvaluation(
  set: RelevanceJudgmentSet,
  scenarios: readonly EvaluationScenario[],
  options: RunEvaluationOptions = {},
): Promise<RelevanceEvaluationReport> {
  // Typed callers can bypass loadJudgmentSet, so production cardinality and
  // every judgment invariant are revalidated at the execution boundary.
  const validatedSet = validateProductionJudgmentCoverage(set);
  if (!options.judgmentSetPath?.trim() || !options.candidatePlanPath?.trim()) {
    throw new Error("evaluation requires exact judgment-set and candidate-plan artifacts");
  }
  const [judgmentArtifact, candidateArtifact] = await Promise.all([
    loadExactJudgmentArtifact(options.judgmentSetPath),
    loadEvaluationCandidatePlanArtifact(options.candidatePlanPath),
  ]);
  if (stableJson(judgmentArtifact.set) !== stableJson(validatedSet)) {
    throw new Error("evaluation judgment set differs from exact artifact");
  }
  const boundCandidatePlan = candidateArtifact.plan;
  if (boundCandidatePlan.blockers.length > 0) {
    throw new Error("evaluation candidate plan artifact has blockers");
  }
  const expectedDialogueIds = [...new Set(
    validatedSet.queries.flatMap((query) =>
      query.expectedDialogues.map((dialogue) => dialogue.dialogueId),
    ),
  )].sort();
  if (
    boundCandidatePlan.requiredDialogueIdsSha256 !==
      createHash("sha256").update(stableJson(expectedDialogueIds)).digest("hex")
  ) {
    throw new Error("evaluation candidate plan does not cover judgment dialogues");
  }
  if (
    !options.candidatePlan ||
    options.candidatePlan.planSha256 !== boundCandidatePlan.planSha256 ||
      stableJson(options.candidatePlan.fullEligibleCorpus) !==
        stableJson(boundCandidatePlan.fullEligibleCorpus) ||
      stableJson(options.candidatePlan.subset) !== stableJson(boundCandidatePlan.subset) ||
      stableJson(options.candidatePlan.privacy) !== stableJson(boundCandidatePlan.privacy)
  ) throw new Error("evaluation candidate plan argument differs from exact artifact");
  if (scenarios.length === 0) throw new Error("evaluation: нужен хотя бы один scenario");
  if (new Set(scenarios.map((item) => item.id)).size !== scenarios.length) {
    throw new Error("evaluation: scenario id не должны повторяться");
  }
  validateEvaluationMatrix(scenarios);
  if (scenarios.some((scenario) =>
    scenario.evaluationScope !== "candidate_subset" ||
    scenario.candidatePlanSha256 !== boundCandidatePlan.planSha256)) {
    throw new Error("evaluation scenarios are not bound to the exact candidate plan");
  }
  const nowMs = options.nowMs ?? (() => performance.now());
  const candidateDocuments = new Map(
    boundCandidatePlan.subset.documents.map((document) => [document.documentId, document]),
  );
  const scenarioReports: EvaluationScenarioReport[] = [];
  let corpus: SearchCorpusFingerprint | undefined;
  for (const scenario of scenarios) {
    const fingerprint = options.corpusFingerprint ?? scenario.corpusFingerprint;
    if (!fingerprint) {
      throw new Error(`evaluation scenario ${scenario.id}: corpus fingerprint seam обязателен`);
    }
    const before = await fingerprint();
    validateCorpusFingerprint(before, `evaluation scenario ${scenario.id} before`);
    if (!sameCorpus(before, boundCandidatePlan.fullEligibleCorpus)) {
      throw new Error("evaluation full eligible corpus differs from candidate plan");
    }
    if (corpus && !sameCorpus(corpus, before)) {
      throw new Error(`evaluation corpus drift before scenario ${scenario.id}`);
    }
    corpus ??= before;
    const results: EvaluationQueryResult[] = [];
    const scenarioContent = new Map<string, EvaluationDocumentContentEvidence>();
    for (const judgment of validatedSet.queries) {
      const started = nowMs();
      const response = await scenario.search(judgment.query, toSearchFilters(judgment.filters));
      const wallLatencyMs = Math.max(0, nowMs() - started);
      const rawHits = response.hits;
      const providerLatencyMs = response.providerLatencyMs;
      const retrievalLatencyMs = response.retrievalLatencyMs;
      const contentByDocument = validateHitEvidence(
        rawHits,
        response.hitEvidence,
        response.contentEvidence,
        `evaluation scenario ${scenario.id}`,
      );
      for (const [documentId, content] of contentByDocument) {
        const candidate = candidateDocuments.get(documentId);
        if (
          !candidate || candidate.dialogueId !== content.dialogueId ||
          candidate.revisionId !== content.revisionId ||
          candidate.contentSha256 !== content.contentSha256
        ) throw new Error(`evaluation scenario ${scenario.id}: hit outside candidate binding`);
        const existing = scenarioContent.get(documentId);
        if (existing && stableJson(existing) !== stableJson(content)) {
          throw new Error(`evaluation scenario ${scenario.id}: content evidence drift`);
        }
        scenarioContent.set(documentId, content);
      }
      for (const [name, value] of Object.entries({
        providerLatencyMs,
        retrievalLatencyMs,
      })) {
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`evaluation scenario ${scenario.id}: ${name} invalid`);
        }
      }
      const latencyMs = providerLatencyMs + retrievalLatencyMs;
      const hits = distinctDialogueHits(rawHits);
      const metrics = calculateQueryMetrics(judgment, hits);
      const matchedExpectedSnippets = judgment.expectedSnippets.filter((expected) =>
        response.hitEvidence.some((hit) =>
          expectedSnippetMatchesEvidence(expected, hit, contentByDocument)),
      ).length;
      const topDialogueIds = hits.slice(0, 10).map((hit) => hit.dialogueId);
      const mustNotMatchOutcomes = judgment.mustNotMatchExamples.map((example) =>
        response.hitEvidence
          .filter((hit) => topDialogueIds.includes(hit.dialogueId))
          .some((hit) => exampleMatchesEvidence(example, hit, contentByDocument)),
      );
      const mustNotMatchViolations = mustNotMatchOutcomes.filter(Boolean).length;
      results.push({
        queryId: judgment.id,
        query: options.includeQueryText ? judgment.query : undefined,
        querySha256: createHash("sha256").update(judgment.query).digest("hex"),
        filtersSha256: createHash("sha256")
          .update(stableJson(judgment.filters ?? {})).digest("hex"),
        queryLanguage: judgment.queryLanguage,
        queryType: judgment.queryType,
        latencyMs: rounded(latencyMs),
        providerLatencyMs: rounded(providerLatencyMs),
        retrievalLatencyMs: rounded(retrievalLatencyMs),
        returnedDialogues: hits.length,
        topDialogueIds,
        matchedExpectedSnippets,
        expectedSnippetsTotal: judgment.expectedSnippets.length,
        mustNotMatchViolations,
        mustNotExamplesTotal: judgment.mustNotMatchExamples.length,
        mustNotMatchOutcomes,
        hitEvidence: response.hitEvidence,
        ...metrics,
      });
    }
    const after = await fingerprint();
    validateCorpusFingerprint(after, `evaluation scenario ${scenario.id} after`);
    if (!sameCorpus(before, after) || !sameCorpus(corpus, after)) {
      throw new Error(`evaluation corpus drift after scenario ${scenario.id}`);
    }
    scenarioReports.push({
      id: scenario.id,
      mode: scenario.mode,
      space: scenario.space
        ? {
            slug: scenario.space.slug,
            provider: scenario.space.provider,
            model: scenario.space.model,
            dimensions: scenario.space.dimensions,
          }
        : undefined,
      resourceMeasurements: scenario.resourceMeasurements,
      readiness: scenario.readiness,
      corpusChecks: { before, after },
      contentEvidence: [...scenarioContent.values()].sort((a, b) =>
        a.documentId.localeCompare(b.documentId)
      ),
      aggregate: aggregate(results),
      queries: results,
    });
  }
  if (!sameCorpus(corpus!, boundCandidatePlan.fullEligibleCorpus)) {
    throw new Error("evaluation full eligible corpus differs from candidate plan");
  }
  return {
    formatVersion: EVALUATION_REPORT_FORMAT_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    judgmentSet: {
      name: validatedSet.name,
      artifactSha256: judgmentArtifact.artifactSha256,
      sha256: judgmentSetSha256(validatedSet),
      queries: validatedSet.queries.length,
    },
    corpus: corpus!,
    candidatePlan: {
      artifactSha256: candidateArtifact.artifactSha256,
      planSha256: boundCandidatePlan.planSha256,
      corpusSha256: boundCandidatePlan.fullEligibleCorpus.sha256,
      subsetSha256: boundCandidatePlan.subset.fingerprint.sha256,
      privacySha256: createHash("sha256")
        .update(stableJson(boundCandidatePlan.privacy))
        .digest("hex"),
    },
    metricDefinitions: {
      rankingUnit: "dialogue",
      relevance: "expectedDialogues (unlisted dialogues are irrelevant)",
      irrelevantTop5Denominator: "returned distinct dialogues, up to 5; empty retrieval = 1",
      latency: "uncached provider and retrieval measured separately; scenarios and queries run sequentially",
    },
    scenarios: scenarioReports,
  };
}

export interface CreateEvaluationScenariosOptions {
  modes?: readonly EvaluationMode[];
  spaceSlugs?: readonly string[];
  providerFactory?: (space: EmbeddingSpace) => EmbeddingProvider;
  /** External measurements from the index-build run, keyed by space slug. */
  resourceMeasurements?: Readonly<Record<string, EvaluationResourceMeasurements>>;
  /**
   * Обязательный production gate для vector/hybrid: embedding query может
   * вызвать внешний/платный provider. Без true создаётся только BM25.
   */
  allowEmbeddingQueries?: boolean;
  /** Must match the privacy-filtered candidate plan / exact-token corpus. */
  privacy?: PrivacyPolicy;
  candidatePlan?: EvaluationCandidatePlan;
  candidateConfirmation?: string;
  documentedExclusions?: Readonly<Record<string, readonly EvaluationReadinessExclusion[]>>;
}

export interface CreateFullCorpusHybridScenarioOptions {
  spaceSlug: string;
  providerFactory: (space: EmbeddingSpace) => EmbeddingProvider;
  allowEmbeddingQueries: boolean;
  /** Literal confirmation bound to the selected space and full eligible corpus. */
  confirmation: string;
  privacy: PrivacyPolicy;
  resourceMeasurements: EvaluationResourceMeasurements;
  documentedExclusions?: readonly EvaluationReadinessExclusion[];
}

export function fullCorpusEvaluationConfirmation(
  spaceSlug: string,
  corpusSha256: string,
): string {
  if (!spaceSlug.trim() || !/^[0-9a-f]{64}$/.test(corpusSha256)) {
    throw new Error("full-corpus evaluation confirmation inputs invalid");
  }
  return `EVALUATE FULL CORPUS ${spaceSlug} ${corpusSha256}`;
}

export interface RunFullCorpusHybridEvaluationOptions {
  judgmentSetPath: string;
  privacy: PrivacyPolicy;
  /** Exact full eligible corpus from the selected-space production plan. */
  expectedCorpus: SearchCorpusFingerprint;
  now?: () => Date;
  nowMs?: () => number;
  includeQueryText?: boolean;
  corpusFingerprint?: () => Promise<SearchCorpusFingerprint>;
}

interface FullCorpusScenarioBinding {
  readinessProbe: () => Promise<EvaluationReadinessEvidence>;
  corpusDocuments: EvaluationCorpusDocumentBinding[];
  corpusDocumentsProbe: () => Promise<EvaluationCorpusDocumentBinding[]>;
}

const fullCorpusScenarioBindings = new WeakMap<EvaluationScenario, FullCorpusScenarioBinding>();

function timedEvaluationProvider(
  provider: EmbeddingProvider,
  addLatency: (milliseconds: number) => void,
): EmbeddingProvider {
  return {
    provider: provider.provider,
    model: provider.model,
    dimensions: provider.dimensions,
    async embed(texts) {
      const started = performance.now();
      try {
        return await provider.embed(texts);
      } finally {
        addLatency(Math.max(0, performance.now() - started));
      }
    },
  };
}

/** Read-only completion evidence captured immediately before evaluation. */
export interface CollectEvaluationReadinessOptions {
  /** Candidate subset; omitted means the whole search corpus. */
  documentIds?: readonly RecordId[];
  /** Exact normalized policy used to classify every document row. */
  privacy: PrivacyPolicy;
  /** Exact row declarations approved outside the application. */
  documentedExclusions?: readonly EvaluationReadinessExclusion[];
}

function isStablePermanentExclusionCode(code: string): boolean {
  return /^provider_(?:permanent_error|retry_exhausted|unexpected_error)$/.test(code) ||
    /^(?:vector_dimension_mismatch|provider_vector_count_mismatch) expected=\d+ actual=\d+$/.test(code) ||
    code === "search_document_missing" || code === "permanent_error_detail_redacted";
}

export async function collectEvaluationReadiness(
  db: Surreal,
  space: EmbeddingSpace,
  options: CollectEvaluationReadinessOptions,
): Promise<EvaluationReadinessEvidence> {
  const documentClause = options.documentIds ? " WHERE id INSIDE $documents" : "";
  const relationClause = options.documentIds ? " AND search_document INSIDE $documents" : "";
  const variables = { space: space.id, documents: options.documentIds };
  const [documentsRows, jobRows, vectorRows, dimensionAudit, hnswAudit] = await Promise.all([
    selectAll<{
      id: RecordId;
      content: string;
      content_sha256: string;
      document_type: string;
      harness?: string;
      workspace?: string;
    }>(
      db,
      `SELECT id, content, content_sha256, document_type,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document${documentClause} ORDER BY id`,
      variables,
    ),
    selectAll<{
      id: RecordId;
      search_document: RecordId;
      input_sha256: string;
      status: string;
      last_error?: string;
    }>(
      db,
      `SELECT id, search_document, input_sha256, status, last_error FROM embedding_job
       WHERE embedding_space = $space${relationClause} ORDER BY search_document`,
      variables,
    ),
    selectAll<{ search_document: RecordId; input_sha256: string }>(
      db,
      `SELECT search_document, input_sha256 FROM ${space.physical_table}
       ${options.documentIds ? "WHERE search_document INSIDE $documents" : ""}
       ORDER BY search_document`,
      variables,
    ),
    auditVectorDimensions(db, space.slug),
    auditHnswIndex(db, space.slug),
  ]);
  const documents = documentsRows.length;
  const documentsById = new Map(documentsRows.map((row) => [String(row.id), row]));
  const jobsById = new Map(jobRows.map((row) => [String(row.search_document), row]));
  const vectorsById = new Map(vectorRows.map((row) => [String(row.search_document), row]));
  const jobCoverageErrors =
    documentsRows.filter((row) => !jobsById.has(String(row.id))).length +
    jobRows.filter((row) => !documentsById.has(String(row.search_document))).length +
    (jobRows.length - jobsById.size);
  let vectorCoverageErrors =
    vectorRows.filter((row) => !documentsById.has(String(row.search_document))).length +
    (vectorRows.length - vectorsById.size);
  let inputHashErrors = 0;
  const observedExclusions: EvaluationReadinessExclusion[] = [];
  let completedJobs = 0;
  let privacyExcludedDocuments = 0;
  let permanentExcludedDocuments = 0;
  for (const [id, document] of documentsById) {
    const job = jobsById.get(id);
    const vector = vectorsById.get(id);
    if (createHash("sha256").update(document.content).digest("hex") !== document.content_sha256) {
      inputHashErrors += 1;
    }
    if (job && job.input_sha256 !== document.content_sha256) inputHashErrors += 1;
    if (vector && vector.input_sha256 !== document.content_sha256) inputHashErrors += 1;
    if (job && vector && job.input_sha256 !== vector.input_sha256) inputHashErrors += 1;
    if (!job) {
      if (vector) vectorCoverageErrors += 1;
      continue;
    }
    const privacyReason = privacyExclusion({
      harness: document.harness,
      workspace: document.workspace,
      documentType: document.document_type,
      contentBytes: Buffer.byteLength(document.content, "utf8"),
    }, normalizedEvaluationPrivacy(options.privacy));
    if (privacyReason) {
      const code = privacyExclusionCode(privacyReason);
      if (job.status !== "cancelled" || job.last_error !== code || vector) {
        vectorCoverageErrors += 1;
      }
      privacyExcludedDocuments += 1;
      observedExclusions.push({
        category: "privacy",
        code,
        jobId: String(job.id),
        documentId: id,
        evidence: "",
      });
      continue;
    }
    if (job.status === "permanent_error") {
      const code = job.last_error?.trim() ?? "";
      if (!isStablePermanentExclusionCode(code) || vector) vectorCoverageErrors += 1;
      permanentExcludedDocuments += 1;
      observedExclusions.push({
        category: "permanent",
        code,
        jobId: String(job.id),
        documentId: id,
        evidence: "",
      });
      continue;
    }
    if (job.status !== "completed" || !vector) vectorCoverageErrors += 1;
    if (job.status === "completed") completedJobs += 1;
  }
  const documentedExclusions = [...(options.documentedExclusions ?? [])]
    .map((item) => ({ ...item }))
    .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.jobId.localeCompare(b.jobId));
  const exclusionKey = (item: EvaluationReadinessExclusion) =>
    `${item.category}\0${item.code}\0${item.jobId}\0${item.documentId}`;
  const declarations = new Map(documentedExclusions.map((item) => [exclusionKey(item), item]));
  if (
    declarations.size !== documentedExclusions.length ||
    observedExclusions.length !== documentedExclusions.length ||
    observedExclusions.some((item) => !declarations.get(exclusionKey(item))?.evidence.trim())
  ) {
    throw new Error(`evaluation readiness ${space.slug}: exclusion identities не совпадают`);
  }
  const privacyNormalizedDocuments = documents - privacyExcludedDocuments;
  return {
    source: "row-level jobs/vectors + paged dimension audit + EXPLAIN FULL",
    documents,
    jobs: jobRows.length,
    completedJobs,
    vectors: vectorRows.length,
    jobCoverageErrors,
    vectorCoverageErrors,
    inputHashErrors,
    expectedDimensions: space.dimensions,
    wrongDimensionVectors: dimensionAudit.wrongDimensions.length,
    hnswIndexName: "vector_hnsw",
    hnswUsesKnnScan: hnswAudit.usesKnnScan,
    privacyNormalizedDocuments,
    privacyExcludedDocuments,
    permanentExcludedDocuments,
    eligibleDocuments: privacyNormalizedDocuments - permanentExcludedDocuments,
    exclusions: documentedExclusions,
  };
}

function measuredEmbeddingSearch(
  db: Surreal,
  provider: EmbeddingProvider,
  search: (
    provider: EmbeddingProvider,
    query: string,
    filters: SearchFilters,
  ) => Promise<SearchHit[]>,
): (query: string, filters: SearchFilters) => Promise<EvaluationSearchResponse> {
  let providerLatencyMs = 0;
  const measuredProvider = timedEvaluationProvider(
    provider,
    (latency) => (providerLatencyMs += latency),
  );
  return async (query, filters) => {
    providerLatencyMs = 0;
    const started = performance.now();
    const hits = await search(measuredProvider, query, filters);
    const total = Math.max(0, performance.now() - started);
    const evidence = await collectHitEvidence(db, hits);
    return {
      hits,
      ...evidence,
      providerLatencyMs,
      retrievalLatencyMs: Math.max(0, total - providerLatencyMs),
    };
  };
}

/** Собрать BM25/vector/hybrid scenarios, не меняя active space. */
export async function createEvaluationScenarios(
  db: Surreal,
  options: CreateEvaluationScenariosOptions = {},
): Promise<EvaluationScenario[]> {
  const modes = options.modes ?? ["text", "vector", "hybrid"];
  const scenarios: EvaluationScenario[] = [];
  const corpusFingerprint = () => computeSearchCorpusFingerprint(db, {
    privacy: options.privacy ?? EMPTY_PRIVACY_POLICY,
  });
  if (!options.candidatePlan || options.candidatePlan.blockers.length > 0) {
    throw new Error("evaluation scenarios require a ready bounded candidate plan");
  }
  validateEvaluationCandidatePlan(options.candidatePlan);
  if (
    stableJson(normalizedEvaluationPrivacy(options.privacy ?? EMPTY_PRIVACY_POLICY)) !==
      stableJson(options.candidatePlan.privacy)
  ) throw new Error("evaluation privacy policy differs from candidate plan");
  const subsetIds = new Set(
    options.candidatePlan.subset.documents.map((document) => document.documentId),
  );
  const subsetRecords = (
    await selectAll<{ id: RecordId }>(db, "SELECT id FROM search_document ORDER BY id")
  ).filter((row) => subsetIds.has(String(row.id))).map((row) => row.id);
  if (subsetRecords.length !== subsetIds.size) {
    throw new Error("evaluation candidate subset drifted before scenario creation");
  }
  const subsetHits = (hits: SearchHit[]): SearchHit[] =>
    hits.filter((hit) => subsetIds.has(hit.id));
  if (modes.includes("text")) {
    scenarios.push({
      id: "bm25",
      mode: "text",
      corpusFingerprint,
      evaluationScope: "candidate_subset",
      candidatePlanSha256: options.candidatePlan.planSha256,
      search: async (query, filters) => {
        const started = performance.now();
        const hits = subsetHits(await searchText(db, query, filters));
        const evidence = await collectHitEvidence(db, hits);
        return {
          hits,
          ...evidence,
          providerLatencyMs: 0,
          retrievalLatencyMs: Math.max(0, performance.now() - started),
        };
      },
    });
  }
  const embeddingModes = modes.filter((mode) => mode !== "text");
  if (embeddingModes.length === 0) return scenarios;
  if (!options.allowEmbeddingQueries) {
    throw new Error(
      "vector/hybrid evaluation может вызвать embedding provider; требуется явное allowEmbeddingQueries=true",
    );
  }
  if (options.candidateConfirmation !== options.candidatePlan.confirmation) {
    throw new Error("vector/hybrid evaluation candidate confirmation mismatch");
  }
  if (!options.providerFactory) throw new Error("для vector/hybrid нужен providerFactory");
  if (!options.spaceSlugs || options.spaceSlugs.length === 0) {
    throw new Error("для vector/hybrid нужен хотя бы один candidate space slug");
  }
  for (const slug of options.spaceSlugs) {
    const space = await getSpaceBySlug(db, slug);
    if (!space) throw new Error(`embedding space "${slug}" не найден`);
    const readiness = await collectEvaluationReadiness(db, space, {
      documentIds: subsetRecords,
      privacy: options.privacy ?? EMPTY_PRIVACY_POLICY,
      documentedExclusions: options.documentedExclusions?.[slug],
    });
    const descriptor = {
      slug: space.slug,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
    };
    if (modes.includes("vector")) {
      const search = measuredEmbeddingSearch(
        db,
        options.providerFactory(space),
        async (provider, query, filters) =>
          subsetHits(await searchVectorInSpace(db, provider, space, query, filters)),
      );
      scenarios.push({
        id: `vector:${slug}`,
        mode: "vector",
        space: descriptor,
        resourceMeasurements: options.resourceMeasurements?.[slug],
        readiness,
        corpusFingerprint,
        evaluationScope: "candidate_subset",
        candidatePlanSha256: options.candidatePlan.planSha256,
        search,
      });
    }
    if (modes.includes("hybrid")) {
      const search = measuredEmbeddingSearch(
        db,
        options.providerFactory(space),
        async (provider, query, filters) =>
          subsetHits(await searchHybridInSpace(db, provider, space, query, filters)),
      );
      scenarios.push({
        id: `hybrid:${slug}`,
        mode: "hybrid",
        space: descriptor,
        resourceMeasurements: options.resourceMeasurements?.[slug],
        readiness,
        corpusFingerprint,
        evaluationScope: "candidate_subset",
        candidatePlanSha256: options.candidatePlan.planSha256,
        search,
      });
    }
  }
  return scenarios;
}

export async function collectEvaluationCorpusDocumentBindings(
  db: Surreal,
  privacy: PrivacyPolicy,
): Promise<EvaluationCorpusDocumentBinding[]> {
  const documents: EvaluationCorpusDocumentBinding[] = [];
  let start = 0;
  for (;;) {
    const rows = await selectAll<CorpusFingerprintRow & {
      dialogue_id: RecordId;
      revision_id: RecordId;
    }>(
      db,
      `SELECT id, content, content_sha256, document_type, dialogue.id AS dialogue_id,
         dialogue_revision.id AS revision_id,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document ORDER BY id LIMIT 500 START $start`,
      { start },
    );
    for (const row of rows) {
      const actualSha256 = createHash("sha256").update(row.content).digest("hex");
      if (actualSha256 !== row.content_sha256) {
        throw new Error(`full-corpus evaluation: stored content hash mismatch for ${String(row.id)}`);
      }
      if (!privacyExclusion({
        harness: row.harness,
        workspace: row.workspace,
        documentType: row.document_type,
        contentBytes: Buffer.byteLength(row.content, "utf8"),
      }, privacy)) {
        documents.push({
          documentId: String(row.id),
          dialogueId: String(row.dialogue_id),
          revisionId: String(row.revision_id),
          contentSha256: row.content_sha256,
        });
      }
    }
    if (rows.length < 500) break;
    start += rows.length;
  }
  if (documents.length === 0) throw new Error("full-corpus evaluation: eligible corpus пуст");
  return documents.sort((a, b) => a.documentId.localeCompare(b.documentId));
}

/**
 * Build the one final scenario after the selected space has a full backfill.
 * Unlike createEvaluationScenarios, no bounded candidate-subset predicate is
 * applied: every privacy-eligible search document remains a distractor.
 */
export async function createFullCorpusHybridScenario(
  db: Surreal,
  options: CreateFullCorpusHybridScenarioOptions,
): Promise<EvaluationScenario> {
  if (!options.allowEmbeddingQueries) {
    throw new Error("full-corpus hybrid evaluation requires allowEmbeddingQueries=true");
  }
  const space = await getSpaceBySlug(db, options.spaceSlug);
  if (!space) throw new Error(`embedding space "${options.spaceSlug}" не найден`);
  const boundCorpus = await computeSearchCorpusFingerprint(db, { privacy: options.privacy });
  const expectedConfirmation = fullCorpusEvaluationConfirmation(space.slug, boundCorpus.sha256);
  if (options.confirmation !== expectedConfirmation) {
    throw new Error(`full-corpus evaluation confirmation mismatch; expected ${expectedConfirmation}`);
  }
  const provider = options.providerFactory(space);
  if (
    provider.provider !== space.provider || provider.model !== space.model ||
    provider.dimensions !== space.dimensions
  ) throw new Error("full-corpus evaluation provider config mismatch");
  validateResourceMeasurements(
    `full-corpus-hybrid:${space.slug}`,
    options.resourceMeasurements,
    true,
  );
  const readinessProbe = () => collectEvaluationReadiness(db, space, {
    privacy: options.privacy,
    documentedExclusions: options.documentedExclusions,
  });
  const [corpusDocuments, readiness] = await Promise.all([
    collectEvaluationCorpusDocumentBindings(db, options.privacy),
    readinessProbe(),
  ]);
  const eligibleIds = new Set(corpusDocuments.map((document) => document.documentId));
  const corpusFingerprint = () => computeSearchCorpusFingerprint(db, {
    privacy: options.privacy,
  });
  const search = measuredEmbeddingSearch(
    db,
    provider,
    async (measuredProvider, query, filters) =>
      (await searchHybridInSpace(db, measuredProvider, space, query, filters))
        .filter((hit) => eligibleIds.has(hit.id)),
  );
  const scenario: EvaluationScenario = {
    id: `full-corpus-hybrid:${space.slug}`,
    mode: "hybrid",
    space: {
      slug: space.slug,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
    },
    resourceMeasurements: options.resourceMeasurements,
    readiness,
    evaluationScope: "full_corpus",
    corpusFingerprint,
    search,
  };
  fullCorpusScenarioBindings.set(scenario, {
    readinessProbe,
    corpusDocuments,
    corpusDocumentsProbe: () => collectEvaluationCorpusDocumentBindings(db, options.privacy),
  });
  return scenario;
}

/** Execute the mandatory post-backfill, full-distractor hybrid acceptance run. */
export async function runFullCorpusHybridEvaluation(
  set: RelevanceJudgmentSet,
  scenario: EvaluationScenario,
  options: RunFullCorpusHybridEvaluationOptions,
): Promise<FullCorpusHybridEvaluationReport> {
  const validatedSet = validateProductionJudgmentCoverage(set);
  if (!options.judgmentSetPath?.trim()) {
    throw new Error("full-corpus evaluation requires exact judgment-set artifact");
  }
  const judgmentArtifact = await loadExactJudgmentArtifact(options.judgmentSetPath);
  if (stableJson(judgmentArtifact.set) !== stableJson(validatedSet)) {
    throw new Error("full-corpus evaluation judgment set differs from exact artifact");
  }
  if (
    scenario.mode !== "hybrid" || scenario.evaluationScope !== "full_corpus" || !scenario.space ||
    scenario.id !== `full-corpus-hybrid:${scenario.space.slug}`
  ) throw new Error("full-corpus evaluation requires the selected hybrid scenario");
  const scenarioBinding = fullCorpusScenarioBindings.get(scenario);
  if (!scenarioBinding) throw new Error("full-corpus scenario is not library-created");
  const { readinessProbe, corpusDocuments, corpusDocumentsProbe } = scenarioBinding;
  if (stableJson(await corpusDocumentsProbe()) !== stableJson(corpusDocuments)) {
    throw new Error("full-corpus evaluation document binding drift");
  }
  const corpusDocumentMap = new Map(
    corpusDocuments.map((document) => [document.documentId, document]),
  );
  const freshReadiness = await readinessProbe();
  if (stableJson(freshReadiness) !== stableJson(scenario.readiness)) {
    throw new Error("full-corpus evaluation readiness drift");
  }
  validateResourceMeasurements(scenario.id, scenario.resourceMeasurements, true);
  validateReadiness(scenario);
  validateCorpusFingerprint(options.expectedCorpus, "full-corpus expected corpus");
  const fingerprint = options.corpusFingerprint ?? scenario.corpusFingerprint;
  if (!fingerprint) throw new Error("full-corpus evaluation requires corpus fingerprint seam");
  const before = await fingerprint();
  validateCorpusFingerprint(before, "full-corpus evaluation before");
  if (!sameCorpus(before, options.expectedCorpus)) {
    throw new Error("full-corpus evaluation corpus differs from production backfill corpus");
  }
  if (scenario.readiness!.privacyNormalizedDocuments !== before.documents) {
    throw new Error("full-corpus evaluation readiness does not cover the full eligible corpus");
  }
  const nowMs = options.nowMs ?? (() => performance.now());
  const results: EvaluationQueryResult[] = [];
  const scenarioContent = new Map<string, EvaluationDocumentContentEvidence>();
  for (const judgment of validatedSet.queries) {
    const started = nowMs();
    const response = await scenario.search(judgment.query, toSearchFilters(judgment.filters));
    const contentByDocument = validateHitEvidence(
      response.hits,
      response.hitEvidence,
      response.contentEvidence,
      "full-corpus evaluation",
    );
    for (const [documentId, content] of contentByDocument) {
      const authoritative = corpusDocumentMap.get(documentId);
      if (!authoritative || stableJson(authoritative) !== stableJson({
        documentId: content.documentId,
        dialogueId: content.dialogueId,
        revisionId: content.revisionId,
        contentSha256: content.contentSha256,
      })) throw new Error("full-corpus evaluation hit differs from DB corpus binding");
      const existing = scenarioContent.get(documentId);
      if (existing && stableJson(existing) !== stableJson(content)) {
        throw new Error("full-corpus evaluation content evidence drift");
      }
      scenarioContent.set(documentId, content);
    }
    const wallLatencyMs = Math.max(0, nowMs() - started);
    if (
      !Number.isFinite(response.providerLatencyMs) || response.providerLatencyMs < 0 ||
      !Number.isFinite(response.retrievalLatencyMs) || response.retrievalLatencyMs < 0
    ) throw new Error("full-corpus evaluation timing breakdown invalid");
    const latencyMs = response.providerLatencyMs + response.retrievalLatencyMs;
    if (latencyMs > wallLatencyMs + 60_000) {
      throw new Error("full-corpus evaluation timing breakdown implausible");
    }
    const hits = distinctDialogueHits(response.hits);
    const metrics = calculateQueryMetrics(judgment, hits);
    const topDialogueIds = hits.slice(0, 10).map((hit) => hit.dialogueId);
    const mustNotMatchOutcomes = judgment.mustNotMatchExamples.map((example) =>
      response.hitEvidence
        .filter((hit) => topDialogueIds.includes(hit.dialogueId))
        .some((hit) => exampleMatchesEvidence(example, hit, contentByDocument)),
    );
    results.push({
      queryId: judgment.id,
      query: options.includeQueryText ? judgment.query : undefined,
      querySha256: createHash("sha256").update(judgment.query).digest("hex"),
      filtersSha256: createHash("sha256")
        .update(stableJson(judgment.filters ?? {})).digest("hex"),
      queryLanguage: judgment.queryLanguage,
      queryType: judgment.queryType,
      latencyMs: rounded(latencyMs),
      providerLatencyMs: rounded(response.providerLatencyMs),
      retrievalLatencyMs: rounded(response.retrievalLatencyMs),
      returnedDialogues: hits.length,
      topDialogueIds,
      matchedExpectedSnippets: judgment.expectedSnippets.filter((expected) =>
        response.hitEvidence.some((hit) =>
          expectedSnippetMatchesEvidence(expected, hit, contentByDocument)),
      ).length,
      expectedSnippetsTotal: judgment.expectedSnippets.length,
      mustNotMatchViolations: mustNotMatchOutcomes.filter(Boolean).length,
      mustNotExamplesTotal: judgment.mustNotMatchExamples.length,
      mustNotMatchOutcomes,
      hitEvidence: response.hitEvidence,
      ...metrics,
    });
  }
  const after = await fingerprint();
  validateCorpusFingerprint(after, "full-corpus evaluation after");
  if (!sameCorpus(before, after) || !sameCorpus(after, options.expectedCorpus)) {
    throw new Error("full-corpus evaluation corpus drift");
  }
  if (stableJson(await readinessProbe()) !== stableJson(freshReadiness)) {
    throw new Error("full-corpus evaluation readiness drift after queries");
  }
  if (stableJson(await corpusDocumentsProbe()) !== stableJson(corpusDocuments)) {
    throw new Error("full-corpus evaluation document binding drift after queries");
  }
  const scenarioReport: EvaluationScenarioReport = {
    id: scenario.id,
    mode: "hybrid",
    space: scenario.space,
    resourceMeasurements: scenario.resourceMeasurements,
    readiness: scenario.readiness,
    corpusChecks: { before, after },
    contentEvidence: [...scenarioContent.values()].sort((a, b) =>
      a.documentId.localeCompare(b.documentId)
    ),
    aggregate: aggregate(results),
    queries: results,
  };
  return {
    formatVersion: 1,
    evaluationKind: "final_full_corpus_hybrid",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    judgmentSet: {
      name: validatedSet.name,
      artifactSha256: judgmentArtifact.artifactSha256,
      sha256: judgmentSetSha256(validatedSet),
      queries: validatedSet.queries.length,
    },
    corpus: before,
    corpusDocuments,
    privacySha256: createHash("sha256")
      .update(stableJson(normalizedEvaluationPrivacy(options.privacy)))
      .digest("hex"),
    selectedSpace: scenario.space,
    metricDefinitions: {
      rankingUnit: "dialogue",
      relevance: "expectedDialogues (unlisted dialogues are irrelevant)",
      irrelevantTop5Denominator: "returned distinct dialogues, up to 5; empty retrieval = 1",
      latency: "uncached provider and retrieval measured separately; scenarios and queries run sequentially",
    },
    scenario: scenarioReport,
  };
}

export function serializeFullCorpusEvaluationReport(
  report: FullCorpusHybridEvaluationReport,
): string {
  return `${stableJson(report, true)}\n`;
}

export async function writeFullCorpusEvaluationReport(
  filePath: string,
  report: FullCorpusHybridEvaluationReport,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await writePrivateFileAtomic(
    filePath,
    serializeFullCorpusEvaluationReport(report),
    options,
  );
}

/** Стабильный JSON (ключи отсортированы) для diff между runs. */
export function serializeEvaluationReport(report: RelevanceEvaluationReport): string {
  return `${stableJson(report, true)}\n`;
}

/**
 * Пишет private report с mode 0600 и без overwrite по умолчанию. Путь
 * выбирается вызывающим кодом вне Git; библиотека не пишет в repo сама.
 */
export async function writeEvaluationReport(
  filePath: string,
  report: RelevanceEvaluationReport,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await writePrivateFileAtomic(filePath, serializeEvaluationReport(report), options);
}
