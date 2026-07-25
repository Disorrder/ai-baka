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
import { privacyExclusion, type PrivacyPolicy } from "./privacy.ts";
import { getSpaceBySlug, listSpaces, type EmbeddingSpace } from "./spaces.ts";

/** Lease timeout: processing-job старше этого срока считается зависшим (№22). */
export const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
/** После стольких неуспешных попыток retryable-ошибка становится permanent. */
export const MAX_ATTEMPTS = 8;
/** Размер батча одного вызова provider. */
export const BATCH_SIZE = 64;
/** База exponential backoff (мс). */
export const BACKOFF_BASE_MS = 10_000;
/** Потолок backoff (мс) — 1 час. */
export const BACKOFF_MAX_MS = 3_600_000;

/** Exponential backoff: base * 2^(attempt-1), ограниченный потолком. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
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

interface DocRow {
  id: RecordId;
  content: string;
  document_type: string;
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
  opts: { spaceId?: RecordId; limit: number; workerId: string; now?: Date },
): Promise<EmbeddingJobRow[]> {
  const now = opts.now ?? new Date();
  const spaceClause = opts.spaceId ? "AND embedding_space = $space" : "";
  const rows = await db.query<[unknown, unknown, EmbeddingJobRow[]]>(
    `BEGIN;
     LET $ids = (SELECT VALUE id FROM embedding_job
       WHERE ${DUE_JOBS_WHERE}
       ${spaceClause} ORDER BY created_at LIMIT $limit);
     UPDATE embedding_job SET status = "processing", locked_by = $worker, locked_at = $now
       WHERE id INSIDE $ids AND status INSIDE ["pending", "retryable_error"];
     COMMIT;`,
    { now, limit: opts.limit, worker: opts.workerId, space: opts.spaceId },
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

export interface WorkerOptions {
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
export async function runEmbeddingWorker(
  db: Surreal,
  providerFactory: ProviderFactory,
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

    const docs = new Map<string, DocRow>();
    for (const doc of await selectAll<DocRow>(
      db,
      `SELECT id, content, document_type,
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
      const runnable: Array<{ job: EmbeddingJobRow; doc: DocRow }> = [];
      for (const job of spaceJobs) {
        const doc = docs.get(String(job.search_document));
        if (!doc) {
          // Документ удалён сменой projection, а job остался (не должно
          // случаться — §8.1 каскад; подстраховка): job бессмыслен.
          await failJobs(db, [job], "permanent_error", "search_document отсутствует");
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
          await cancelJob(db, job, `privacy_excluded: ${reason}`, now());
          summary.privacyExcluded += 1;
          log({ event: "embedding_job_privacy_excluded", job: String(job.id), reason });
          continue;
        }
        runnable.push({ job, doc });
      }
      if (runnable.length === 0) continue;
      summary.batches += 1;
      try {
        const result = await provider.embed(runnable.map((r) => r.doc.content));
        // Проверка dimension каждого вектора (сценарий №23, инвариант §23.11).
        const wrongDimension = result.vectors.findIndex((v) => v.length !== space.dimensions);
        if (wrongDimension >= 0 || result.vectors.length !== runnable.length) {
          const detail =
            result.vectors.length !== runnable.length
              ? `provider вернул ${result.vectors.length} векторов на ${runnable.length} входов`
              : `dimension mismatch: ожидалось ${space.dimensions}, получено ${result.vectors[wrongDimension]!.length}`;
          await failJobs(db, runnable.map((r) => r.job), "permanent_error", detail);
          summary.permanentErrors += runnable.length;
          log({ event: "embedding_batch_dimension_rejected", space: space.slug, detail });
          continue;
        }
        await completeBatch(db, space, runnable, result.vectors, result.usage.promptTokens, now());
        summary.completed += runnable.length;
        summary.promptTokens += result.usage.promptTokens;
        log({
          event: "embedding_batch_completed",
          space: space.slug,
          jobs: runnable.length,
          promptTokens: result.usage.promptTokens,
        });
      } catch (error) {
        const retryable = error instanceof EmbeddingProviderError ? error.retryable : true;
        const message = error instanceof Error ? error.message : String(error);
        const failedJobs = runnable.map((r) => r.job);
        for (const job of failedJobs) {
          const attempts = job.attempts + 1;
          const permanent = !retryable || attempts >= MAX_ATTEMPTS;
          await failJob(
            db,
            job,
            permanent ? "permanent_error" : "retryable_error",
            message,
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
          error: message.slice(0, 300),
        });
      }
    }
  }
  return summary;
}

/** Детерминированный id vector-записи: повторный run идемпотентен. */
export function vectorRecordKey(searchDocumentId: string, spaceId: string): string {
  return `vec_${sha256hex(`${searchDocumentId}:${spaceId}`)}`;
}

/** Транзакция успешного батча (§13.6 п.5): vectors + usage + jobs completed. */
async function completeBatch(
  db: Surreal,
  space: EmbeddingSpace,
  runnable: Array<{ job: EmbeddingJobRow; doc: DocRow }>,
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

async function failJob(
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
async function failJobs(
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
async function cancelJob(db: Surreal, job: EmbeddingJobRow, reason: string, now: Date): Promise<void> {
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
    `UPDATE embedding_job SET status = "cancelled", locked_by = NONE, locked_at = NONE
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
