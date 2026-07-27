/**
 * Embedding jobs worker (docs/plan.md §13.5–§13.6, этап 7).
 *
 * Worker:
 * 1. возвращает stuck jobs в pending (lease timeout, план §19.2 сценарий 22);
 * 2. создаёт provider'ы spaces с доступными jobs (ProviderFactory выбирает
 *    реализацию по space.provider) — строго ДО lease: ошибка конфигурации
 *    (нет API key, неизвестный provider) прерывает worker, а jobs остаются
 *    pending, а не висят в processing до lease timeout;
 * 3. получает lease на pending/retryable jobs (locked_by/locked_at);
 * 4. фильтрует по политике приватности (§13.7, src/embeddings/privacy.ts) —
 *    исключённые jobs → cancelled, в provider не уходят;
 * 5. батчит inputs одного space → provider.embed;
 * 6. проверяет dimension каждого вектора (сценарий 23) — mismatch =
 *    permanent_error, vector не пишется (инварианты §23.11–13);
 * 7. в одной транзакции на батч: UPSERT vector в физическую таблицу space
 *    (детерминированный id → повторный run идемпотентен) + фактический
 *    token usage + job → completed;
 * 8. временная ошибка → retryable_error с exponential backoff
 *    (next_attempt_at), после MAX_ATTEMPTS → permanent_error;
 *    постоянная ошибка → permanent_error сразу;
 * 9. canonical corpus не затрагивается — только embedding_job и
 *    физические vector-таблицы (search projection).
 *
 * Логи — только id/hash/счётчики, без полного текста документов (§13.7).
 */

import { RecordId, type Surreal } from "surrealdb";
import { selectAll, selectOne } from "../db/repositories/helpers.ts";
import { sha256hex } from "../db/transactions.ts";
import { SEGMENTATION_VERSION, TARGET_TOKENS } from "../search/segmenter.ts";
import { EXTRACTOR_VERSION } from "../search/extractors/types.ts";
import type { EmbeddingsConfig } from "../config.ts";
import type { EmbeddingProvider } from "./provider.ts";
import { EmbeddingProviderError } from "./provider.ts";
import { OpenAIEmbeddingProvider } from "./openai-provider.ts";
import { mockVector } from "./mock-provider.ts";
import { privacyExclusion, type PrivacyPolicy } from "./privacy.ts";
import { getSpaceBySlug, listSpaces, type EmbeddingSpace } from "./spaces.ts";

/** Lease timeout: processing-job старше этого срока считается зависшим (№22). */
export const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
/** После стольких неуспешных попыток retryable-ошибка становится permanent. */
export const MAX_ATTEMPTS = 8;
/** Размер батча одного вызова provider. */
export const BATCH_SIZE = 64;
/** Официальный предел суммы input tokens одного /v1/embeddings request. */
export const EMBEDDING_REQUEST_TOKEN_LIMIT = 300_000;
/** Официальный предел одного input для поддерживаемых text-embedding моделей. */
export const EMBEDDING_INPUT_TOKEN_LIMIT = 8_192;
/** База exponential backoff (мс). */
export const BACKOFF_BASE_MS = 10_000;
/** Потолок backoff (мс) — 1 час. */
export const BACKOFF_MAX_MS = 3_600_000;

/** Exponential backoff: base * 2^(attempt-1), ограниченный потолком. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
}

export interface EmbeddingBatchTokenEvidence {
  /** Ровно тот текст, который будет передан provider'у. */
  content: string;
  /** Exact count либо сохранённая search_document.token_count оценка. */
  tokenCount?: number;
  /** true разрешён только для проверенного exact-token report. */
  exact?: boolean;
}

/**
 * Верхняя граница tokens для безопасной упаковки одного input.
 *
 * Exact evidence используется как есть. Для сохранённой эвристики берётся
 * максимум с UTF-8 byte length: text-embedding-3-* использует byte-level BPE,
 * поэтому валидный token не может покрывать меньше одного байта. Если evidence
 * отсутствует/повреждён или byte-bound достигает per-input limit, резервируем
 * полные 8192 tokens — это fail-closed, но всё ещё позволяет запросы ≤ 36 docs.
 */
export function embeddingInputTokenUpperBound(
  evidence: EmbeddingBatchTokenEvidence,
): number {
  if (typeof evidence.content !== "string") {
    throw new Error("embedding_batch_content_invalid");
  }
  const tokens = evidence.tokenCount;
  if (evidence.exact) {
    if (
      !Number.isSafeInteger(tokens) || Number(tokens) < 0 ||
      Number(tokens) > EMBEDDING_INPUT_TOKEN_LIMIT
    ) {
      throw new Error("embedding_batch_exact_token_evidence_invalid");
    }
    return Number(tokens);
  }

  const utf8Bytes = Buffer.byteLength(evidence.content, "utf8");
  if (
    tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0 ||
    tokens >= EMBEDDING_INPUT_TOKEN_LIMIT || utf8Bytes >= EMBEDDING_INPUT_TOKEN_LIMIT
  ) {
    return EMBEDDING_INPUT_TOKEN_LIMIT;
  }
  return Math.max(utf8Bytes, tokens);
}

/**
 * Stable greedy packing for one provider/model. Every returned request has at
 * most `maxInputs` (and never more than BATCH_SIZE) and at most 300k tokens.
 * Input order is preserved, so retry ordering and deterministic job identity
 * remain unchanged.
 */
export function packEmbeddingRequestBatches<T>(
  inputs: readonly T[],
  evidenceOf: (input: T) => EmbeddingBatchTokenEvidence,
  maxInputs = BATCH_SIZE,
): T[][] {
  if (!Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > BATCH_SIZE) {
    throw new Error(`embedding batch maxInputs must be 1..${BATCH_SIZE}`);
  }
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchTokens = 0;
  for (const input of inputs) {
    const tokens = embeddingInputTokenUpperBound(evidenceOf(input));
    if (tokens > EMBEDDING_REQUEST_TOKEN_LIMIT) {
      throw new Error("embedding_input_exceeds_request_token_limit");
    }
    if (
      batch.length > 0 &&
      (batch.length >= maxInputs || batchTokens + tokens > EMBEDDING_REQUEST_TOKEN_LIMIT)
    ) {
      batches.push(batch);
      batch = [];
      batchTokens = 0;
    }
    batch.push(input);
    batchTokens += tokens;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Факторы свежести embedding job (§13.5): job становится устаревшим и
 * возвращается в pending при изменении любого из них.
 */
export interface JobStaleFactors {
  /** Content hash входа (job.input_sha256 / search_document.content_sha256). */
  contentSha256: string;
  /** search_document.extraction_version / актуальный EXTRACTOR_VERSION. */
  extractionVersion: string;
  /** search_document.segmentation_version / актуальный SEGMENTATION_VERSION. */
  segmentationVersion: string;
  /** embedding_space.provider. */
  provider: string;
  /** embedding_space.model. */
  model: string;
  /** embedding_space.dimensions. */
  dimensions: number;
}

/**
 * Stale job (§13.5): актуальные факторы отличаются от зафиксированных job'ом.
 * recorded === undefined — документ удалён сменой projection (job-сирота).
 */
export function isJobStale(
  recorded: JobStaleFactors | undefined,
  current: JobStaleFactors,
): boolean {
  if (recorded === undefined) return true;
  return (
    recorded.contentSha256 !== current.contentSha256 ||
    recorded.extractionVersion !== current.extractionVersion ||
    recorded.segmentationVersion !== current.segmentationVersion ||
    recorded.provider !== current.provider ||
    recorded.model !== current.model ||
    recorded.dimensions !== current.dimensions
  );
}

/**
 * Распределение фактического token usage батча по документам (§13.6 п.5):
 * пропорционально весам (эвристическая оценка токенов документа), остаток
 * округления — последнему элементу. Инварианты: сумма распределённого строго
 * равна totalTokens (фактический usage API), значения ≥ 0.
 */
export function distributePromptTokens(totalTokens: number, weights: number[]): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  let distributed = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return totalTokens - distributed;
    const proportional = weightSum > 0 ? Math.round((totalTokens * weight) / weightSum) : 0;
    // round-half-up суммарно может превысить totalTokens — обрезаем,
    // недостача уйдёт в остаток последнего элемента.
    const share = Math.min(proportional, totalTokens - distributed);
    distributed += share;
    return share;
  });
}

export interface EmbeddingJobRow {
  id: RecordId;
  search_document: RecordId;
  embedding_space: RecordId;
  input_sha256: string;
  status: string;
  attempts: number;
  next_attempt_at?: Date;
  locked_by?: string;
  locked_at?: Date;
  last_error?: string;
  created_at: Date;
  completed_at?: Date;
}

export interface EmbeddingDocumentRow {
  id: RecordId;
  content: string;
  content_sha256: string;
  token_count: number;
  document_type: string;
  extraction_version: string;
  segmentation_version: string;
  harness?: string;
  workspace?: string;
}

/** Вернуть зависшие processing-jobs в pending (сценарий №22). */
export async function releaseStaleLeases(db: Surreal, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LEASE_TIMEOUT_MS);
  const rows = await selectAll<{ id: RecordId }>(
    db,
    `UPDATE embedding_job SET status = "pending", locked_by = NONE, locked_at = NONE
     WHERE status = "processing" AND locked_at < $cutoff RETURN id`,
    { cutoff },
  );
  return rows.length;
}

/** WHERE-условие доступных для lease jobs (pending или подошедший retry). */
const DUE_JOBS_WHERE = `(status = "pending" OR (status = "retryable_error" AND (next_attempt_at IS NONE OR next_attempt_at <= $now)))`;

/**
 * Lease pending/retryable jobs одному worker'у. Выборка и UPDATE — в одной
 * транзакции; локально workers не конкурируют, но lease-поля оставляют
 * корректность при ручном параллельном запуске.
 */
export async function leaseJobs(
  db: Surreal,
  opts: {
    spaceId?: RecordId;
    limit: number;
    workerId: string;
    now?: Date;
    jobIds?: readonly RecordId[];
  },
): Promise<EmbeddingJobRow[]> {
  const now = opts.now ?? new Date();
  const spaceClause = opts.spaceId ? "AND embedding_space = $space" : "";
  const jobsClause = opts.jobIds ? "AND id INSIDE $jobIds" : "";
  const rows = await db.query<[unknown, unknown, EmbeddingJobRow[]]>(
    `BEGIN;
     LET $ids = (SELECT VALUE id FROM embedding_job
       WHERE ${DUE_JOBS_WHERE}
       ${spaceClause} ${jobsClause} ORDER BY created_at LIMIT $limit);
     UPDATE embedding_job SET status = "processing", locked_by = $worker, locked_at = $now
       WHERE id INSIDE $ids AND status INSIDE ["pending", "retryable_error"];
     COMMIT;`,
    {
      now,
      limit: opts.limit,
      worker: opts.workerId,
      space: opts.spaceId,
      jobIds: opts.jobIds,
    },
  );
  // Результаты statements: BEGIN, LET, UPDATE, COMMIT — нужен UPDATE (индекс 2).
  return rows[2] ?? [];
}

export interface WorkerSummary {
  completed: number;
  failed: number;
  permanentErrors: number;
  privacyExcluded: number;
  releasedStale: number;
  promptTokens: number;
  batches: number;
}

interface WorkerOptions {
  /** Только один space (slug). По умолчанию — все spaces. */
  spaceSlug?: string;
  /** Максимум jobs за запуск. */
  limit?: number;
  batchSize?: number;
  privacy: PrivacyPolicy;
  workerId?: string;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
}

/**
 * Provider конкретного space: фабрика выбирает реализацию по space.provider,
 * model/dimensions берутся из space record. Неизвестный provider или
 * отсутствующая конфигурация (API key) → понятная ошибка.
 */
export type ProviderFactory = (space: EmbeddingSpace) => EmbeddingProvider;

/**
 * Data-only fault script for the library-owned offline provider. Functions,
 * provider objects and delegates are deliberately not part of this contract.
 */
export interface OfflineMockWorkerOptions {
  spaceSlug?: string;
  limit?: number;
  batchSize?: number;
  privacy: PrivacyPolicy;
  workerId?: string;
  dimensionOverride?: number;
  failures?: readonly ("retryable" | "permanent")[];
}

const offlineMockCapabilities = new WeakSet<EmbeddingProvider>();

function offlineMockProvider(
  space: EmbeddingSpace,
  options: Pick<OfflineMockWorkerOptions, "dimensionOverride" | "failures">,
): EmbeddingProvider {
  const failures = [...(options.failures ?? [])];
  const dimensions = options.dimensionOverride ?? space.dimensions;
  const provider = Object.freeze<EmbeddingProvider>({
    provider: "library-owned-offline-mock",
    model: space.model,
    dimensions: space.dimensions,
    async embed(texts) {
      const failure = failures.shift();
      if (failure) {
        throw new EmbeddingProviderError(
          `offline_mock_${failure}_failure`,
          failure === "retryable",
        );
      }
      const promptTokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      return {
        vectors: texts.map((text) => mockVector(text, dimensions)),
        usage: { promptTokens, totalTokens: promptTokens },
      };
    },
  });
  offlineMockCapabilities.add(provider);
  return provider;
}

function validateOfflineMockOptions(value: unknown): asserts value is OfflineMockWorkerOptions {
  const plainDataObject = (item: unknown): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(item)) &&
    Object.values(Object.getOwnPropertyDescriptors(item)).every(
      (descriptor) => descriptor.get === undefined && descriptor.set === undefined,
    );
  const stringArray = (item: unknown): item is string[] => {
    if (!Array.isArray(item) || Object.getPrototypeOf(item) !== Array.prototype) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const numericKeys = Object.keys(descriptors).filter((key) => key !== "length");
    return numericKeys.length === item.length && Object.entries(descriptors).every(([key, descriptor]) =>
      key === "length" ||
      (/^(?:0|[1-9]\d*)$/.test(key) && descriptor.get === undefined &&
        descriptor.set === undefined && typeof descriptor.value === "string"));
  };
  if (
    !plainDataObject(value)
  ) {
    throw new Error("offline_mock_worker_options_invalid");
  }
  const options = value as Record<string, unknown>;
  const allowed = new Set([
    "spaceSlug", "limit", "batchSize", "privacy", "workerId", "dimensionOverride", "failures",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw new Error("offline_mock_worker_options_invalid");
  }
  const privacy = options.privacy;
  const privacyKeys = new Set([
    "excludeHarnesses", "excludeWorkspaces", "excludeDocumentTypes", "maxDocumentBytes",
  ]);
  if (
    !plainDataObject(privacy) ||
    Object.keys(privacy).some((key) => !privacyKeys.has(key)) ||
    !stringArray(privacy.excludeHarnesses) || !stringArray(privacy.excludeWorkspaces) ||
    !stringArray(privacy.excludeDocumentTypes) ||
    (privacy.maxDocumentBytes !== undefined &&
      (!Number.isSafeInteger(privacy.maxDocumentBytes) || Number(privacy.maxDocumentBytes) < 0)) ||
    (options.spaceSlug !== undefined && typeof options.spaceSlug !== "string") ||
    (options.workerId !== undefined && typeof options.workerId !== "string") ||
    (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || Number(options.limit) < 1)) ||
    (options.batchSize !== undefined &&
      (!Number.isSafeInteger(options.batchSize) || Number(options.batchSize) < 1 ||
        Number(options.batchSize) > BATCH_SIZE)) ||
    (options.dimensionOverride !== undefined &&
      (!Number.isSafeInteger(options.dimensionOverride) || Number(options.dimensionOverride) < 1)) ||
    (options.failures !== undefined &&
      (!stringArray(options.failures) ||
        options.failures.some((item) => item !== "retryable" && item !== "permanent"))) ||
    Object.values(options).some((item) => typeof item === "function")
  ) throw new Error("offline_mock_worker_options_invalid");
}

/**
 * Последняя fail-closed проверка непосредственно перед provider I/O.
 *
 * Плановый gate проверяет всю криптографически связанную invocation, но этого
 * недостаточно после lease: другой worker мог успеть завершить именно текущий
 * батч. Поэтому здесь повторно читаются только фактически leased rows и
 * проверяется их точное состояние/владелец, актуальные hash/version/config и
 * отсутствие vector. После этой функции до provider.embed нет await.
 */
export async function assertCurrentLeasedBatch(
  db: Surreal,
  space: EmbeddingSpace,
  workerId: string,
  runnable: readonly { job: EmbeddingJobRow; doc: EmbeddingDocumentRow }[],
): Promise<void> {
  const ids = runnable.map(({ job }) => String(job.id));
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("external provider current batch ids invalid");
  }
  const jobRecords = runnable.map(({ job }) => job.id);
  const documentRecords = runnable.map(({ doc }) => doc.id);
  const snapshot = await db.query<[
    unknown,
    EmbeddingSpace[],
    EmbeddingJobRow[],
    Array<Pick<
      EmbeddingDocumentRow,
      "id" | "content" | "content_sha256" | "extraction_version" | "segmentation_version"
    >>,
    Array<{ search_document: RecordId }>,
    unknown,
  ]>(
    `BEGIN;
     SELECT * FROM embedding_space WHERE id = $space;
     SELECT * FROM embedding_job WHERE id INSIDE $jobs ORDER BY id;
     SELECT id, content, content_sha256, extraction_version, segmentation_version
       FROM search_document WHERE id INSIDE $documents ORDER BY id;
     SELECT search_document FROM ${space.physical_table}
       WHERE search_document INSIDE $documents;
     COMMIT;`,
    { space: space.id, jobs: jobRecords, documents: documentRecords },
  );
  const currentSpace = snapshot[1]?.[0];
  if (
    !currentSpace || currentSpace.slug !== space.slug ||
    currentSpace.provider !== space.provider || currentSpace.model !== space.model ||
    currentSpace.dimensions !== space.dimensions ||
    currentSpace.physical_table !== space.physical_table ||
    currentSpace.segmentation_version !== space.segmentation_version ||
    currentSpace.segmentation_version !== SEGMENTATION_VERSION
  ) {
    throw new Error("external provider current batch space config drift");
  }
  const currentJobs = snapshot[2] ?? [];
  const byId = new Map(currentJobs.map((job) => [String(job.id), job]));
  if (currentJobs.length !== runnable.length || byId.size !== runnable.length) {
    throw new Error("external provider current leased batch changed");
  }
  const currentDocs = snapshot[3] ?? [];
  const docsById = new Map(currentDocs.map((doc) => [String(doc.id), doc]));
  if (currentDocs.length !== runnable.length || docsById.size !== runnable.length) {
    throw new Error("external provider current batch document set changed");
  }
  const vectors = snapshot[4] ?? [];
  if (vectors.length > 0) {
    throw new Error("external provider current batch vector already exists");
  }
  for (const { job: leased, doc } of runnable) {
    const current = byId.get(String(leased.id));
    const currentDoc = docsById.get(String(doc.id));
    if (
      !current || current.status !== "processing" || current.locked_by !== workerId ||
      !current.locked_at || String(current.embedding_space) !== String(space.id) ||
      String(current.search_document) !== String(doc.id) ||
      current.input_sha256 !== leased.input_sha256 ||
      new Date(current.locked_at).getTime() !== new Date(leased.locked_at!).getTime()
    ) {
      throw new Error(`external provider current leased job drift: ${String(leased.id)}`);
    }
    if (
      !currentDoc || currentDoc.content_sha256 !== leased.input_sha256 ||
      currentDoc.content_sha256 !== doc.content_sha256 ||
      sha256hex(currentDoc.content) !== currentDoc.content_sha256 ||
      String(currentDoc.extraction_version) !== String(EXTRACTOR_VERSION) ||
      String(currentDoc.segmentation_version) !== SEGMENTATION_VERSION
    ) {
      throw new Error(`external provider current job hash/config drift: ${String(leased.id)}`);
    }
  }
}

export function privacyExclusionCode(reason: string): string {
  if (reason.startsWith("harness ")) return "privacy_excluded_harness";
  if (reason.startsWith("workspace ")) return "privacy_excluded_workspace";
  if (reason.startsWith("document_type ")) return "privacy_excluded_document_type";
  if (reason.startsWith("document ")) return "privacy_excluded_document_size";
  return "privacy_excluded_policy";
}

/**
 * Production-фабрика worker'а (подключается в CLI): provider по
 * space.provider (§13.1). Тесты используют MockEmbeddingProvider
 * (mock-provider.ts) — живой OpenAI здесь не вызывается.
 */
export function defaultProviderFactory(opts: { openaiApiKey?: string }): ProviderFactory {
  return (space) => {
    if (space.provider === "openai") {
      if (!opts.openaiApiKey) {
        throw new Error("OPENAI_API_KEY не задан — worker не может вызвать provider");
      }
      return new OpenAIEmbeddingProvider({
        apiKey: opts.openaiApiKey,
        model: space.model,
        dimensions: space.dimensions,
      });
    }
    throw new Error(`неизвестный embedding provider "${space.provider}" (space "${space.slug}")`);
  };
}

/**
 * Прогон worker'а (§13.6): пока есть доступные jobs — lease батч, embed,
 * запись. Возвращает сводку счётчиков.
 */
async function runEmbeddingWorkerInternal(
  db: Surreal,
  providerFactory: (space: EmbeddingSpace) => EmbeddingProvider,
  opts: WorkerOptions,
): Promise<WorkerSummary> {
  const log = opts.logger ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const summary: WorkerSummary = {
    completed: 0,
    failed: 0,
    permanentErrors: 0,
    privacyExcluded: 0,
    releasedStale: 0,
    promptTokens: 0,
    batches: 0,
  };

  const spaces = new Map<string, EmbeddingSpace>();
  const spaceOf = async (id: RecordId): Promise<EmbeddingSpace> => {
    const cached = spaces.get(String(id));
    if (cached) return cached;
    const space = await selectOne<EmbeddingSpace>(db, "SELECT * FROM ONLY $id", { id });
    if (!space) throw new Error(`embedding_space ${String(id)} не найден`);
    spaces.set(String(id), space);
    return space;
  };
  // Provider создаётся лениво по space, но строго ДО lease (см. цикл ниже):
  // фабрика может кинуть (нет API key, неизвестный provider), и тогда worker
  // должен упасть, оставив jobs в pending, а не в processing.
  const providers = new Map<string, EmbeddingProvider>();
  const providerFor = async (spaceId: RecordId): Promise<EmbeddingProvider> => {
    const cached = providers.get(String(spaceId));
    if (cached) return cached;
    const provider = providerFactory(await spaceOf(spaceId));
    if (!offlineMockCapabilities.has(provider) || !Object.isFrozen(provider)) {
      throw new Error("generic_embedding_worker_is_mock_only");
    }
    providers.set(String(spaceId), provider);
    return provider;
  };
  const filterSpace = opts.spaceSlug ? await getSpaceBySlug(db, opts.spaceSlug) : undefined;
  if (opts.spaceSlug && !filterSpace) throw new Error(`embedding space "${opts.spaceSlug}" не найден`);

  let processed = 0;
  for (;;) {
    summary.releasedStale += await releaseStaleLeases(db, now());
    const remaining = opts.limit === undefined ? batchSize : Math.min(batchSize, opts.limit - processed);
    if (remaining <= 0) break;
    // Spaces с доступными jobs: провайдеры создаются ДО lease.
    for (const row of await selectAll<{ embedding_space: RecordId }>(
      db,
      `SELECT embedding_space FROM embedding_job
       WHERE ${DUE_JOBS_WHERE} ${filterSpace ? "AND embedding_space = $space" : ""}
       GROUP BY embedding_space`,
      { now: now(), space: filterSpace?.id },
    )) {
      await providerFor(row.embedding_space);
    }
    const jobs = await leaseJobs(db, {
      spaceId: filterSpace?.id,
      limit: remaining,
      workerId,
      now: now(),
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
      { ids: jobs.map((j) => j.search_document) },
    )) {
      docs.set(String(doc.id), doc);
    }

    // Jobs группируются по space: один вызов provider = один model/dimensions.
    const bySpace = new Map<string, EmbeddingJobRow[]>();
    for (const job of jobs) {
      const key = String(job.embedding_space);
      bySpace.set(key, [...(bySpace.get(key) ?? []), job]);
    }

    for (const spaceJobs of bySpace.values()) {
      const space = await spaceOf(spaceJobs[0]!.embedding_space);
      const provider = await providerFor(spaceJobs[0]!.embedding_space);
      const runnable: Array<{ job: EmbeddingJobRow; doc: EmbeddingDocumentRow }> = [];
      for (const job of spaceJobs) {
        const doc = docs.get(String(job.search_document));
        if (!doc) {
          // Документ удалён сменой projection, а job остался (не должно
          // случаться — §8.1 каскад; подстраховка): job бессмыслен.
          await failJobs(db, [job], "permanent_error", "search_document_missing");
          summary.permanentErrors += 1;
          continue;
        }
        const reason = privacyExclusion(
          {
            harness: doc.harness,
            workspace: doc.workspace,
            documentType: doc.document_type,
            contentBytes: Buffer.byteLength(doc.content, "utf8"),
          },
          opts.privacy,
        );
        if (reason) {
          const reasonCode = privacyExclusionCode(reason);
          await cancelJob(db, job, reasonCode, now());
          summary.privacyExcluded += 1;
          log({ event: "embedding_job_privacy_excluded", job: String(job.id), reasonCode });
          continue;
        }
        runnable.push({ job, doc });
      }
      if (runnable.length === 0) continue;
      const requestBatches = packEmbeddingRequestBatches(
        runnable,
        ({ doc }) => ({ content: doc.content, tokenCount: doc.token_count }),
        batchSize,
      );
      for (const requestBatch of requestBatches) {
        summary.batches += 1;
        try {
          await assertCurrentLeasedBatch(db, space, workerId, requestBatch);
          // No await may be inserted between this capability check and embed:
          // the generic path can drive only the provider constructed above.
          if (!offlineMockCapabilities.has(provider) || !Object.isFrozen(provider)) {
            throw new Error("generic_embedding_worker_is_mock_only");
          }
          const result = await provider.embed(requestBatch.map((r) => r.doc.content));
          // Проверка dimension каждого вектора (сценарий №23, инвариант §23.11).
          const wrongDimension = result.vectors.findIndex((v) => v.length !== space.dimensions);
          if (wrongDimension >= 0 || result.vectors.length !== requestBatch.length) {
            const detail = result.vectors.length !== requestBatch.length
              ? `provider_vector_count_mismatch expected=${requestBatch.length} actual=${result.vectors.length}`
              : `vector_dimension_mismatch expected=${space.dimensions} actual=${result.vectors[wrongDimension]!.length}`;
            await failJobs(db, requestBatch.map((r) => r.job), "permanent_error", detail);
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
          // Provider/API messages are an untrusted privacy boundary: an HTTP
          // response may echo rejected input. Persist and log stable codes only,
          // while retaining the provider's retry classification.
          const providerErrorCode =
            error instanceof EmbeddingProviderError
              ? retryable
                ? "provider_retryable_error"
                : "provider_permanent_error"
              : "provider_unexpected_error";
          const failedJobs = requestBatch.map((r) => r.job);
          for (const job of failedJobs) {
            const attempts = job.attempts + 1;
            const permanent = !retryable || attempts >= MAX_ATTEMPTS;
            await failJob(
              db,
              job,
              permanent ? "permanent_error" : "retryable_error",
              permanent && retryable ? "provider_retry_exhausted" : providerErrorCode,
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
            jobs: failedJobs.length,
            errorCode: providerErrorCode,
          });
        }
      }
    }
  }
  return summary;
}

/**
 * Safe generic worker used by tests/local mock providers. Any external
 * provider is rejected before lease; production CLI must use a Stage 11
 * candidate or accepted-full wrapper that supplies an immediate drift gate.
 */
export async function runEmbeddingWorker(
  db: Surreal,
  options: OfflineMockWorkerOptions,
): Promise<WorkerSummary> {
  validateOfflineMockOptions(options);
  const frozenOptions = Object.freeze({
    ...options,
    privacy: Object.freeze({
      excludeHarnesses: [...options.privacy.excludeHarnesses],
      excludeWorkspaces: [...options.privacy.excludeWorkspaces],
      excludeDocumentTypes: [...options.privacy.excludeDocumentTypes],
      maxDocumentBytes: options.privacy.maxDocumentBytes,
    }),
    failures: Object.freeze([...(options.failures ?? [])]),
  });
  return runEmbeddingWorkerInternal(
    db,
    (space) => offlineMockProvider(space, frozenOptions),
    frozenOptions,
  );
}

/** Детерминированный id vector-записи: повторный run идемпотентен. */
export function vectorRecordKey(searchDocumentId: string, spaceId: string): string {
  return `vec_${sha256hex(`${searchDocumentId}:${spaceId}`)}`;
}

/** Транзакция успешного батча (§13.6 п.5): vectors + usage + jobs completed. */
export async function completeBatch(
  db: Surreal,
  space: EmbeddingSpace,
  runnable: Array<{ job: EmbeddingJobRow; doc: EmbeddingDocumentRow }>,
  vectors: number[][],
  promptTokens: number,
  now: Date,
): Promise<void> {
  const table = space.physical_table;
  const statements: string[] = ["BEGIN;"];
  const vars: Record<string, unknown> = { now, spaceId: space.id };
  // Фактический usage батча распределяется по документам так, чтобы сумма
  // строго сошлась с ответом API (эвристика chars/3.5 — только веса).
  const shares = distributePromptTokens(
    promptTokens,
    runnable.map((r) => Math.ceil(r.doc.content.length / 3.5)),
  );
  runnable.forEach(({ job, doc }, i) => {
    statements.push(
      `UPSERT ONLY type::record("${table}", $vk${i}) SET ` +
        `search_document = $d${i}, embedding_space = $spaceId, input_sha256 = $h${i}, ` +
        `vector = $v${i}, prompt_tokens = $t${i}, created_at = $now;`,
      `UPDATE ONLY $j${i} SET status = "completed", completed_at = $now, ` +
        `locked_by = NONE, locked_at = NONE, last_error = NONE;`,
    );
    vars[`vk${i}`] = vectorRecordKey(doc.id.id as string, String(space.id));
    vars[`d${i}`] = doc.id;
    vars[`h${i}`] = job.input_sha256;
    vars[`v${i}`] = vectors[i];
    vars[`t${i}`] = shares[i];
    vars[`j${i}`] = job.id;
  });
  statements.push("COMMIT;");
  await db.query(statements.join("\n"), vars);
}

export async function failJob(
  db: Surreal,
  job: EmbeddingJobRow,
  status: "retryable_error" | "permanent_error",
  message: string,
  attempts: number,
  nextAttemptAt: Date | undefined,
): Promise<void> {
  await db.query(
    `UPDATE ONLY $id SET status = $status, attempts = $attempts, last_error = $error, ` +
      `next_attempt_at = $next, locked_by = NONE, locked_at = NONE`,
    {
      id: job.id,
      status,
      attempts,
      error: message.slice(0, 500),
      next: nextAttemptAt,
    },
  );
}

/** Отметить сразу несколько jobs (batch dimension rejection и пр.). */
export async function failJobs(
  db: Surreal,
  jobs: EmbeddingJobRow[],
  status: "retryable_error" | "permanent_error",
  message: string,
): Promise<void> {
  for (const job of jobs) {
    await failJob(db, job, status, message, job.attempts + 1, undefined);
  }
}

/** Job отменяется политикой приватности (§13.7): vector не создаётся. */
async function cancelJob(
  db: Surreal,
  job: EmbeddingJobRow,
  reason: string,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE ONLY $id SET status = "cancelled", last_error = $reason, ` +
      `locked_by = NONE, locked_at = NONE, completed_at = $now`,
    { id: job.id, reason, now },
  );
}

/** `baka embeddings retry`: error-jobs обратно в pending (§13.6). */
export async function retryFailedJobs(db: Surreal, spaceSlug?: string): Promise<number> {
  const space = spaceSlug ? await getSpaceBySlug(db, spaceSlug) : undefined;
  if (spaceSlug && !space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  const rows = await selectAll<{ id: RecordId }>(
    db,
    `UPDATE embedding_job SET status = "pending", attempts = 0, next_attempt_at = NONE,
       locked_by = NONE, locked_at = NONE, last_error = NONE
     WHERE status INSIDE ["retryable_error", "permanent_error"] ${space ? "AND embedding_space = $space" : ""}
     RETURN id`,
    { space: space?.id },
  );
  return rows.length;
}

/** `baka embeddings cancel`: pending/retryable jobs → cancelled. */
export async function cancelPendingJobs(db: Surreal, spaceSlug?: string): Promise<number> {
  const space = spaceSlug ? await getSpaceBySlug(db, spaceSlug) : undefined;
  if (spaceSlug && !space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  const rows = await selectAll<{ id: RecordId }>(
    db,
    `UPDATE embedding_job SET status = "cancelled", last_error = "operator_cancelled",
       locked_by = NONE, locked_at = NONE
     WHERE status INSIDE ["pending", "retryable_error"] ${space ? "AND embedding_space = $space" : ""}
     RETURN id`,
    { space: space?.id },
  );
  return rows.length;
}

export interface RebuildJobsSummary {
  /** Jobs, возвращённые в pending (факторы §13.5 изменились). */
  resetToPending: number;
  /** Jobs без документа (projection удалена) — удалены. */
  orphansDeleted: number;
  /** Stale vector-записи, удалённые из физической таблицы (инвариант §23.11). */
  vectorsDeleted: number;
}

/**
 * `baka embeddings rebuild` (§13.5): stale jobs возвращаются в pending
 * с актуальным hash, их vectors удаляются.
 *
 * Stale-факторы (isJobStale): content hash (job.input_sha256 vs
 * search_document.content_sha256), extraction/segmentation versions
 * (версии, записанные в search_document, vs актуальные EXTRACTOR_VERSION /
 * SEGMENTATION_VERSION кода — версии читаются из документа, не хардкодятся),
 * provider/model/dimensions embedding_space. Snapshot'а space-параметров у
 * job нет: по конвенции §13.1 они неизменны в рамках space (смена модели =
 * новое space), поэтому recorded-сторона для них — текущие поля space.
 *
 * Stale по versions снимается пересозданием projection (`baka search:rebuild`):
 * документы получают актуальные versions (и новый hash при смене content).
 */
export async function rebuildStaleJobs(db: Surreal, spaceSlug: string): Promise<RebuildJobsSummary> {
  const space = await getSpaceBySlug(db, spaceSlug);
  if (!space) throw new Error(`embedding space "${spaceSlug}" не найден`);
  const jobs = await selectAll<
    EmbeddingJobRow & {
      doc_hash?: string;
      doc_extraction_version?: string;
      doc_segmentation_version?: string;
    }
  >(
    db,
    `SELECT *,
       search_document.content_sha256 AS doc_hash,
       search_document.extraction_version AS doc_extraction_version,
       search_document.segmentation_version AS doc_segmentation_version
     FROM embedding_job
     WHERE embedding_space = $space AND status != "cancelled"`,
    { space: space.id },
  );
  const summary: RebuildJobsSummary = { resetToPending: 0, orphansDeleted: 0, vectorsDeleted: 0 };
  for (const job of jobs) {
    const recorded: JobStaleFactors | undefined =
      job.doc_hash === undefined
        ? undefined
        : {
            contentSha256: job.input_sha256,
            extractionVersion: job.doc_extraction_version ?? "",
            segmentationVersion: job.doc_segmentation_version ?? "",
            provider: space.provider,
            model: space.model,
            dimensions: space.dimensions,
          };
    const current: JobStaleFactors = {
      contentSha256: job.doc_hash ?? "",
      extractionVersion: String(EXTRACTOR_VERSION),
      segmentationVersion: SEGMENTATION_VERSION,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
    };
    if (!isJobStale(recorded, current)) continue;
    if (job.doc_hash === undefined) {
      await db.query("DELETE ONLY $id", { id: job.id });
      summary.orphansDeleted += 1;
      continue;
    }
    const deleted = await selectAll<{ id: RecordId }>(
      db,
      `DELETE FROM ${space.physical_table} WHERE search_document = $doc RETURN id`,
      { doc: job.search_document },
    );
    summary.vectorsDeleted += deleted.length;
    await db.query(
      `UPDATE ONLY $id SET status = "pending", attempts = 0, input_sha256 = $hash, ` +
        `next_attempt_at = NONE, locked_by = NONE, locked_at = NONE, last_error = NONE, completed_at = NONE`,
      { id: job.id, hash: job.doc_hash },
    );
    summary.resetToPending += 1;
  }
  return summary;
}

export interface EmbeddingsPlan {
  documents: number;
  segments: number;
  estimatedTokens: number;
  overTarget: number;
  pendingJobs: number;
  spaces: Array<{
    slug: string;
    active: boolean;
    dimensions: number;
    estimatedVectorBytes: number;
  }>;
  pricePer1MTokens?: number;
  estimatedPriceUsd?: number;
}

/**
 * `baka embeddings plan` (§13.6): read-only оценка backfill.
 * Токены — эвристика segmenter'а (token_count уже записан в search_document);
 * цена — только из конфига (OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS), не хардкод.
 * Приватность-исключения применяются worker'ом в момент run — plan показывает
 * верхнюю границу.
 */
export async function embeddingsPlan(db: Surreal, cfg: EmbeddingsConfig): Promise<EmbeddingsPlan> {
  const aggregate = await selectOne<{
    segments: number;
    tokens: number;
    over_target: number;
  }>(
    db,
    `SELECT count() AS segments, math::sum(token_count) AS tokens,
       count(token_count > $target) AS over_target
     FROM search_document GROUP ALL`,
    { target: TARGET_TOKENS },
  );
  const documents = await selectOne<{ n: number }>(
    db,
    "SELECT count() AS n FROM search_document WHERE segment_no = 0 GROUP ALL",
  );
  const pending = await selectOne<{ n: number }>(
    db,
    `SELECT count() AS n FROM embedding_job WHERE status = "pending" GROUP ALL`,
  );
  const spaces = await listSpaces(db);
  const segments = aggregate?.segments ?? 0;
  const tokens = aggregate?.tokens ?? 0;
  const price = cfg.pricePer1MTokens;
  return {
    documents: documents?.n ?? 0,
    segments,
    estimatedTokens: tokens,
    overTarget: aggregate?.over_target ?? 0,
    pendingJobs: pending?.n ?? 0,
    spaces: spaces.map((space) => ({
      slug: space.slug,
      active: space.active,
      dimensions: space.dimensions,
      // F32 = 4 байта на dimension; без учёта overhead графа HNSW.
      estimatedVectorBytes: segments * space.dimensions * 4,
    })),
    pricePer1MTokens: price,
    estimatedPriceUsd: price !== undefined ? (tokens / 1_000_000) * price : undefined,
  };
}

export interface SpaceStatus {
  slug: string;
  active: boolean;
  provider: string;
  model: string;
  dimensions: number;
  jobs: Record<string, number>;
  vectors: number;
}

/** `baka embeddings status`: jobs по статусам + vectors по каждому space. */
export async function embeddingsStatus(db: Surreal): Promise<SpaceStatus[]> {
  const spaces = await listSpaces(db);
  const result: SpaceStatus[] = [];
  for (const space of spaces) {
    const counts = await selectAll<{ status: string; n: number }>(
      db,
      "SELECT status, count() AS n FROM embedding_job WHERE embedding_space = $space GROUP BY status",
      { space: space.id },
    );
    const vectors = await selectOne<{ n: number }>(
      db,
      `SELECT count() AS n FROM ${space.physical_table} GROUP ALL`,
    );
    result.push({
      slug: space.slug,
      active: space.active,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
      jobs: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      vectors: vectors?.n ?? 0,
    });
  }
  return result;
}
