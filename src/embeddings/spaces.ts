/**
 * Embedding spaces (docs/plan.md §13.1–§13.3, этап 7).
 *
 * Каждое space — metadata-запись embedding_space (schema/0003) + отдельная
 * физическая vector-таблица search_embedding_<slug> с HNSW-индексом
 * (DEFINE TABLE/INDEX выполняются рантаймом, schema-файлы не меняются).
 * В одной vector-таблице — только одно space (инвариант §23.13).
 *
 * Рабочий синтаксис SurrealDB 3.2.3 (проверено на живой базе):
 *   DEFINE INDEX ... FIELDS vector HNSW DIMENSION <n> TYPE F32 DIST COSINE
 *   WHERE vector <|K, EF|> $q            — ANN через HNSW (KnnScan в EXPLAIN FULL)
 *   vector::distance::knn()              — distance выбранной строки
 *
 * space:create также ставит embedding jobs для уже существующих
 * search_documents (это и есть старт backfill, §13.5); активный space
 * получает jobs из sync автоматически (src/db/repositories/corpus.ts).
 * Переключение active не уничтожает старый space (§13.1).
 */

import { RecordId, type Surreal } from "surrealdb";
import { selectAll, selectOne } from "../db/repositories/helpers.ts";
import { embeddingJobRecordId } from "../sync/canonical-hash.ts";
import { SEGMENTATION_VERSION } from "../search/segmenter.ts";

/** slug используется в имени физической таблицы — строгая валидация. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

export interface EmbeddingSpace {
  id: RecordId;
  slug: string;
  provider: string;
  model: string;
  dimensions: number;
  distance: string;
  vector_type: string;
  segmentation_version: string;
  active: boolean;
  physical_table: string;
  created_at: Date;
}

export function physicalTableName(slug: string): string {
  return `search_embedding_${slug}`;
}

/**
 * Slug по умолчанию из конвенции §13.1 (openai_te3l_1024_v1 — сокращение
 * модели вручную): <provider>_<model>_<dimensions>_v1, санитизированный
 * под SLUG_RE (text-embedding-3-large → openai_text_embedding_3_large_1024_v1).
 */
export function defaultSlug(provider: string, model: string, dimensions: number): string {
  const raw = `${provider}_${model}_${dimensions}_v1`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^_|_$/g, "");
  return raw;
}

export interface CreateSpaceOptions {
  slug?: string;
  provider: string;
  model: string;
  dimensions: number;
  /** План §13.2 фиксирует COSINE; другие метрики — осознанное расширение. */
  distance?: string;
  vectorType?: string;
  /** Сразу сделать space активным (предыдущий active снимается, §13.1). */
  activate?: boolean;
}

export interface CreateSpaceResult {
  space: EmbeddingSpace;
  /** Jobs, поставленные для существующих search_documents (backfill). */
  backfilledJobs: number;
  /** Существующие jobs этого space (при повторном запуске не дублируются). */
  existingJobs: number;
}

/** Создать embedding space + физическую таблицу + HNSW-индекс + backfill jobs. */
export async function createSpace(
  db: Surreal,
  options: CreateSpaceOptions,
): Promise<CreateSpaceResult> {
  const slug = options.slug ?? defaultSlug(options.provider, options.model, options.dimensions);
  if (!SLUG_RE.test(slug)) {
    throw new Error(`некорректный slug "${slug}" (разрешены [a-z0-9_], начало с буквы/цифры)`);
  }
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
    throw new Error(`некорректная dimensions: ${options.dimensions}`);
  }
  const distance = (options.distance ?? "cosine").toUpperCase();
  if (distance !== "COSINE") throw new Error(`distance ${distance} не поддержан (план §13.2: COSINE)`);
  const vectorType = (options.vectorType ?? "F32").toUpperCase();
  if (vectorType !== "F32") throw new Error(`vector type ${vectorType} не поддержан (план §13.3: F32)`);

  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM embedding_space WHERE slug = $slug",
    { slug },
  );
  if (existing) throw new Error(`embedding space "${slug}" уже существует`);

  const table = physicalTableName(slug);
  const spaceRid = new RecordId("embedding_space", slug);

  // Физическая таблица + HNSW (динамический DDL, не schema-миграция).
  await db.query(
    `DEFINE TABLE ${table} SCHEMAFULL;\n` +
      `DEFINE FIELD search_document ON TABLE ${table} TYPE record<search_document>;\n` +
      `DEFINE FIELD embedding_space ON TABLE ${table} TYPE record<embedding_space>;\n` +
      `DEFINE FIELD input_sha256 ON TABLE ${table} TYPE string;\n` +
      `DEFINE FIELD vector ON TABLE ${table} TYPE array<float>;\n` +
      `DEFINE FIELD prompt_tokens ON TABLE ${table} TYPE int;\n` +
      `DEFINE FIELD created_at ON TABLE ${table} TYPE datetime;\n` +
      `DEFINE INDEX vector_hnsw ON TABLE ${table} FIELDS vector ` +
      `HNSW DIMENSION ${options.dimensions} TYPE ${vectorType} DIST ${distance};`,
  );

  const space = await selectOne<EmbeddingSpace>(
    db,
    `CREATE ONLY $rid SET slug = $slug, provider = $provider, model = $model, ` +
      `dimensions = $dimensions, distance = $distance, vector_type = $vectorType, ` +
      `segmentation_version = $segVersion, active = false, physical_table = $table, ` +
      `created_at = $now`,
    {
      rid: spaceRid,
      slug,
      provider: options.provider,
      model: options.model,
      dimensions: options.dimensions,
      distance,
      vectorType,
      segVersion: SEGMENTATION_VERSION,
      table,
      now: new Date(),
    },
  );
  if (!space) throw new Error(`не удалось создать embedding_space "${slug}"`);

  // activateSpace сам догоняет backfill — повторный enqueue не нужен.
  let created: number;
  let existingJobs: number;
  if (options.activate) {
    const activated = await activateSpace(db, slug);
    created = activated.enqueuedJobs;
    existingJobs = activated.existingJobs;
  } else {
    ({ created, existing: existingJobs } = await enqueueBackfillJobs(db, space));
  }
  return {
    space: { ...space, active: options.activate ?? false },
    backfilledJobs: created,
    existingJobs,
  };
}

/**
 * Backfill: jobs для всех существующих search_documents (§13.5).
 * Детерминированные id (те же, что у sync) — повторный запуск не дублирует.
 */
export async function enqueueBackfillJobs(
  db: Surreal,
  space: EmbeddingSpace,
): Promise<{ created: number; existing: number }> {
  const docs = await selectAll<{ id: RecordId; content_sha256: string }>(
    db,
    "SELECT id, content_sha256 FROM search_document",
  );
  const haveJobs = new Set(
    (
      await selectAll<{ search_document: RecordId }>(
        db,
        "SELECT search_document FROM embedding_job WHERE embedding_space = $space",
        { space: space.id },
      )
    ).map((row) => String(row.search_document)),
  );
  const pending = docs.filter((doc) => !haveJobs.has(String(doc.id)));
  // Пачками, чтобы не собирать гигантский query на большом архиве.
  const CHUNK = 500;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const statements: string[] = [];
    const vars: Record<string, unknown> = {};
    slice.forEach((doc, j) => {
      const docKey = doc.id.id as string;
      const jobKey = embeddingJobRecordId(docKey, String(space.id));
      statements.push(
        `CREATE ONLY type::record("embedding_job", $k${j}) SET ` +
          `search_document = $d${j}, embedding_space = $s, input_sha256 = $h${j}, ` +
          `status = "pending", attempts = 0, created_at = $now;`,
      );
      vars[`k${j}`] = jobKey;
      vars[`d${j}`] = doc.id;
      vars[`h${j}`] = doc.content_sha256;
    });
    vars.s = space.id;
    vars.now = new Date();
    await db.query(statements.join("\n"), vars);
  }
  return { created: pending.length, existing: docs.length - pending.length };
}

/** Результат активации: активный space + счётчики догоняющего backfill. */
export type ActivateSpaceResult = EmbeddingSpace & {
  /** Jobs, созданные для search_documents без job в этом space. */
  enqueuedJobs: number;
  /** Документы, у которых job в этом space уже был. */
  existingJobs: number;
};

/**
 * Один active space на момент; старый space не уничтожается (§13.1).
 * (Ре)активация догоняет backfill: документы, появившиеся пока space был
 * inactive, jobs не получали (sync ставит jobs только active spaces, §13.5).
 * Идемпотентно: детерминированные id + UNIQUE (search_document,
 * embedding_space) — повторная активация не дублирует jobs.
 */
export async function activateSpace(db: Surreal, slug: string): Promise<ActivateSpaceResult> {
  const space = await selectOne<EmbeddingSpace>(
    db,
    "SELECT * FROM embedding_space WHERE slug = $slug",
    { slug },
  );
  if (!space) throw new Error(`embedding space "${slug}" не найден`);
  await db.query(
    "BEGIN;\n" +
      "UPDATE embedding_space SET active = false WHERE active = true;\n" +
      "UPDATE $rid SET active = true;\n" +
      "COMMIT;",
    { rid: space.id },
  );
  const { created, existing } = await enqueueBackfillJobs(db, space);
  return { ...space, active: true, enqueuedJobs: created, existingJobs: existing };
}

export async function getActiveSpace(db: Surreal): Promise<EmbeddingSpace | undefined> {
  return selectOne<EmbeddingSpace>(
    db,
    "SELECT * FROM embedding_space WHERE active = true LIMIT 1",
  );
}

export async function getSpaceBySlug(
  db: Surreal,
  slug: string,
): Promise<EmbeddingSpace | undefined> {
  return selectOne<EmbeddingSpace>(
    db,
    "SELECT * FROM embedding_space WHERE slug = $slug",
    { slug },
  );
}

export async function listSpaces(db: Surreal): Promise<EmbeddingSpace[]> {
  return selectAll<EmbeddingSpace>(db, "SELECT * FROM embedding_space ORDER BY created_at");
}

/** Физические таблицы всех spaces — для каскадного удаления vectors (§8.1). */
export async function listEmbeddingTables(db: Surreal): Promise<string[]> {
  const rows = await selectAll<{ physical_table: string }>(
    db,
    "SELECT physical_table FROM embedding_space",
  );
  return rows.map((row) => row.physical_table);
}
