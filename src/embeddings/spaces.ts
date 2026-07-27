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

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { RecordId, type Surreal } from "surrealdb";
import { writePrivateFileAtomic } from "../backup/safety.ts";
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

interface RetireJobRow {
  id: RecordId;
  search_document: RecordId;
  input_sha256: string;
  status: string;
  last_error?: string;
}

interface RetireVectorRow {
  id: RecordId;
  search_document: RecordId;
  embedding_space: RecordId;
  input_sha256: string;
  dimensions: number;
}

export interface ProtectedEmbeddingSpaceBinding {
  id: string;
  slug: string;
  roles: Array<"accepted" | "active">;
  provider: string;
  model: string;
  dimensions: number;
  distance: string;
  vectorType: string;
  segmentationVersion: string;
  physicalTable: string;
  active: boolean;
  createdAt: string;
  jobs: { count: number; sha256: string };
  vectors: { count: number; sha256: string };
}

export interface RetireSpacePlan {
  formatVersion: 1;
  space: {
    id: string;
    slug: string;
    provider: string;
    model: string;
    dimensions: number;
    distance: string;
    vectorType: string;
    segmentationVersion: string;
    physicalTable: string;
    active: boolean;
    createdAt: string;
  };
  jobs: { count: number; sha256: string };
  vectors: { count: number; sha256: string };
  acceptedSpaceSlug: string;
  protectedSpaces: ProtectedEmbeddingSpaceBinding[];
  canonicalCorpus: { documents: number; sha256: string };
  candidateEvidencePreserved: true;
  blockers: string[];
  planSha256: string;
  confirmation: string;
}

function canonicalizeRetire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeRetire);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalizeRetire(item)]));
  }
  return value;
}

function retireHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeRetire(value))).digest("hex");
}

function retireConfirmation(slug: string, jobs: number, vectors: number, hash: string): string {
  return `RETIRE EMBEDDING SPACE ${slug} JOBS ${jobs} VECTORS ${vectors} ${hash}`;
}

function validateRetireSpacePlan(plan: RetireSpacePlan): void {
  if (
    plan.formatVersion !== 1 || !SLUG_RE.test(plan.space?.slug ?? "") ||
    plan.space.physicalTable !== physicalTableName(plan.space.slug) ||
    plan.space.id !== `embedding_space:${plan.space.slug}` ||
    typeof plan.space.provider !== "string" || !plan.space.provider.trim() ||
    typeof plan.space.model !== "string" || !plan.space.model.trim() ||
    !Number.isSafeInteger(plan.space.dimensions) || plan.space.dimensions < 1 ||
    plan.space.distance !== "COSINE" || plan.space.vectorType !== "F32" ||
    typeof plan.space.segmentationVersion !== "string" ||
    !Number.isFinite(Date.parse(plan.space.createdAt)) ||
    !SLUG_RE.test(plan.acceptedSpaceSlug ?? "") ||
    plan.acceptedSpaceSlug === plan.space.slug ||
    !Array.isArray(plan.protectedSpaces) || plan.protectedSpaces.length === 0 ||
    plan.candidateEvidencePreserved !== true ||
    !Number.isSafeInteger(plan.jobs?.count) || plan.jobs.count < 0 ||
    !Number.isSafeInteger(plan.vectors?.count) || plan.vectors.count < 0 ||
    !Number.isSafeInteger(plan.canonicalCorpus?.documents) || plan.canonicalCorpus.documents < 0 ||
    !/^[0-9a-f]{64}$/.test(plan.jobs?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(plan.vectors?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(plan.canonicalCorpus?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/.test(plan.planSha256)
  ) throw new Error("embedding space retire plan invalid");
  const protectedSlugs = new Set<string>();
  let acceptedBindings = 0;
  let activeBindings = 0;
  for (const protectedSpace of plan.protectedSpaces) {
    if (
      !SLUG_RE.test(protectedSpace?.slug ?? "") ||
      protectedSpace.slug === plan.space.slug || protectedSlugs.has(protectedSpace.slug) ||
      protectedSpace.id !== `embedding_space:${protectedSpace.slug}` ||
      protectedSpace.physicalTable !== physicalTableName(protectedSpace.slug) ||
      !Array.isArray(protectedSpace.roles) || protectedSpace.roles.length === 0 ||
      new Set(protectedSpace.roles).size !== protectedSpace.roles.length ||
      protectedSpace.roles.some((role) => role !== "accepted" && role !== "active") ||
      protectedSpace.active !== protectedSpace.roles.includes("active") ||
      typeof protectedSpace.provider !== "string" || !protectedSpace.provider.trim() ||
      typeof protectedSpace.model !== "string" || !protectedSpace.model.trim() ||
      !Number.isSafeInteger(protectedSpace.dimensions) || protectedSpace.dimensions < 1 ||
      protectedSpace.distance !== "COSINE" || protectedSpace.vectorType !== "F32" ||
      typeof protectedSpace.segmentationVersion !== "string" ||
      !Number.isFinite(Date.parse(protectedSpace.createdAt)) ||
      !Number.isSafeInteger(protectedSpace.jobs?.count) || protectedSpace.jobs.count < 0 ||
      !Number.isSafeInteger(protectedSpace.vectors?.count) || protectedSpace.vectors.count < 0 ||
      !/^[0-9a-f]{64}$/.test(protectedSpace.jobs?.sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(protectedSpace.vectors?.sha256 ?? "")
    ) throw new Error("embedding space retire protected binding invalid");
    protectedSlugs.add(protectedSpace.slug);
    if (protectedSpace.roles.includes("accepted")) {
      acceptedBindings += 1;
      if (protectedSpace.slug !== plan.acceptedSpaceSlug) {
        throw new Error("embedding space retire accepted binding mismatch");
      }
    }
    if (protectedSpace.roles.includes("active")) activeBindings += 1;
  }
  if (acceptedBindings !== 1 || activeBindings > 1) {
    throw new Error("embedding space retire protected roles invalid");
  }
  const { planSha256, confirmation, ...binding } = plan;
  if (retireHash(binding) !== planSha256) {
    throw new Error("embedding space retire plan SHA-256 mismatch");
  }
  if (
    confirmation !== retireConfirmation(
      plan.space.slug,
      plan.jobs.count,
      plan.vectors.count,
      planSha256,
    )
  ) throw new Error("embedding space retire confirmation invalid");
}

async function canonicalCorpusIdentity(db: Surreal): Promise<{ documents: number; sha256: string }> {
  const rows = await selectAll<{ id: RecordId; content_sha256: string }>(
    db,
    "SELECT id, content_sha256 FROM search_document ORDER BY id",
  );
  return {
    documents: rows.length,
    sha256: retireHash(rows.map((row) => ({
      id: String(row.id),
      contentSha256: row.content_sha256,
    }))),
  };
}

async function collectSpaceDerivedBinding(
  db: Surreal,
  space: EmbeddingSpace,
  roles: Array<"accepted" | "active">,
): Promise<ProtectedEmbeddingSpaceBinding> {
  const [jobs, vectors] = await Promise.all([
    selectAll<RetireJobRow>(
      db,
      `SELECT id, search_document, input_sha256, status, last_error
       FROM embedding_job WHERE embedding_space = $space ORDER BY id`,
      { space: space.id },
    ),
    selectAll<RetireVectorRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256,
         array::len(vector) AS dimensions FROM ${space.physical_table} ORDER BY id`,
    ),
  ]);
  return {
    id: String(space.id),
    slug: space.slug,
    roles: [...roles].sort(),
    provider: space.provider,
    model: space.model,
    dimensions: space.dimensions,
    distance: space.distance,
    vectorType: space.vector_type,
    segmentationVersion: space.segmentation_version,
    physicalTable: space.physical_table,
    active: space.active,
    createdAt: new Date(space.created_at).toISOString(),
    jobs: {
      count: jobs.length,
      sha256: retireHash(jobs.map((job) => ({
        id: String(job.id),
        documentId: String(job.search_document),
        inputSha256: job.input_sha256,
        status: job.status,
        lastError: job.last_error?.trim() || undefined,
      }))),
    },
    vectors: {
      count: vectors.length,
      sha256: retireHash(vectors.map((vector) => ({
        id: String(vector.id),
        documentId: String(vector.search_document),
        embeddingSpaceId: String(vector.embedding_space),
        inputSha256: vector.input_sha256,
        dimensions: vector.dimensions,
      }))),
    },
  };
}

/** Read-only exact target plan for retiring a rejected inactive candidate. */
export async function prepareRetireSpace(
  db: Surreal,
  slug: string,
  acceptedSpaceSlug: string,
): Promise<RetireSpacePlan> {
  if (!SLUG_RE.test(acceptedSpaceSlug) || acceptedSpaceSlug === slug) {
    throw new Error("embedding space retire requires a distinct accepted space slug");
  }
  const space = await getSpaceBySlug(db, slug);
  if (!space) throw new Error(`embedding space "${slug}" не найден`);
  if (space.physical_table !== physicalTableName(slug)) {
    throw new Error("embedding space physical table identity mismatch");
  }
  const spaces = await listSpaces(db);
  const acceptedSpace = spaces.find((item) => item.slug === acceptedSpaceSlug);
  if (!acceptedSpace) throw new Error(`accepted embedding space "${acceptedSpaceSlug}" не найден`);
  const activeSpaces = spaces.filter((item) => item.active);
  const protectedBySlug = new Map<string, { space: EmbeddingSpace; roles: Set<"accepted" | "active"> }>();
  protectedBySlug.set(acceptedSpace.slug, { space: acceptedSpace, roles: new Set(["accepted"]) });
  for (const activeSpace of activeSpaces) {
    if (activeSpace.slug === slug) continue;
    const protectedSpace = protectedBySlug.get(activeSpace.slug) ?? {
      space: activeSpace,
      roles: new Set<"accepted" | "active">(),
    };
    protectedSpace.roles.add("active");
    protectedBySlug.set(activeSpace.slug, protectedSpace);
  }
  const [jobs, vectors, corpus] = await Promise.all([
    selectAll<RetireJobRow>(
      db,
      `SELECT id, search_document, input_sha256, status, last_error
       FROM embedding_job WHERE embedding_space = $space ORDER BY id`,
      { space: space.id },
    ),
    selectAll<RetireVectorRow>(
      db,
      `SELECT id, search_document, embedding_space, input_sha256,
         array::len(vector) AS dimensions FROM ${space.physical_table} ORDER BY id`,
    ),
    canonicalCorpusIdentity(db),
  ]);
  const protectedSpaces = await Promise.all(
    [...protectedBySlug.values()]
      .sort((a, b) => a.space.slug.localeCompare(b.space.slug))
      .map(({ space: protectedSpace, roles }) =>
        collectSpaceDerivedBinding(db, protectedSpace, [...roles])
      ),
  );
  const blockers: string[] = [];
  if (space.active) blockers.push("space is active");
  if (activeSpaces.length > 1) blockers.push(`multiple active spaces=${activeSpaces.length}`);
  const processing = jobs.filter((job) => job.status === "processing");
  if (processing.length > 0) blockers.push(`processing jobs=${processing.length}`);
  const jobBinding = jobs.map((job) => ({
    id: String(job.id),
    documentId: String(job.search_document),
    inputSha256: job.input_sha256,
    status: job.status,
    lastError: job.last_error?.trim() || undefined,
  }));
  const vectorBinding = vectors.map((vector) => ({
    id: String(vector.id),
    documentId: String(vector.search_document),
    embeddingSpaceId: String(vector.embedding_space),
    inputSha256: vector.input_sha256,
    dimensions: vector.dimensions,
  }));
  const binding = {
    formatVersion: 1 as const,
    space: {
      id: String(space.id),
      slug: space.slug,
      provider: space.provider,
      model: space.model,
      dimensions: space.dimensions,
      distance: space.distance,
      vectorType: space.vector_type,
      segmentationVersion: space.segmentation_version,
      physicalTable: space.physical_table,
      active: space.active,
      createdAt: new Date(space.created_at).toISOString(),
    },
    jobs: { count: jobs.length, sha256: retireHash(jobBinding) },
    vectors: { count: vectors.length, sha256: retireHash(vectorBinding) },
    acceptedSpaceSlug,
    protectedSpaces,
    canonicalCorpus: corpus,
    candidateEvidencePreserved: true as const,
    blockers: blockers.sort(),
  };
  const planSha256 = retireHash(binding);
  return {
    ...binding,
    planSha256,
    confirmation: retireConfirmation(slug, jobs.length, vectors.length, planSha256),
  };
}

export interface RetireSpaceResult {
  slug: string;
  jobsDeleted: number;
  vectorsDeleted: number;
  canonicalCorpusUnchanged: true;
  protectedSpacesVerified: true;
  candidateEvidencePreserved: true;
}

export function serializeRetireSpacePlan(plan: RetireSpacePlan): string {
  validateRetireSpacePlan(plan);
  return `${JSON.stringify(canonicalizeRetire(plan), null, 2)}\n`;
}

export async function writeRetireSpacePlan(
  filePath: string,
  plan: RetireSpacePlan,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await writePrivateFileAtomic(filePath, serializeRetireSpacePlan(plan), options);
}

export async function loadRetireSpacePlan(filePath: string): Promise<RetireSpacePlan> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new Error("embedding_space_retire_plan_read_error");
  }
  let plan: RetireSpacePlan;
  try {
    plan = JSON.parse(source) as RetireSpacePlan;
  } catch {
    throw new Error("embedding_space_retire_plan_invalid_json");
  }
  validateRetireSpacePlan(plan);
  return plan;
}

/**
 * Delete only one rejected inactive space and its derived rows/table. Candidate
 * evaluation artifacts live outside these tables and are deliberately untouched.
 */
export async function retireSpace(
  db: Surreal,
  approvedPlan: RetireSpacePlan,
  confirmation: string,
): Promise<RetireSpaceResult> {
  validateRetireSpacePlan(approvedPlan);
  if (approvedPlan.blockers.length > 0) {
    throw new Error(`embedding space retire blocked: ${approvedPlan.blockers.join("; ")}`);
  }
  if (confirmation !== approvedPlan.confirmation) {
    throw new Error("embedding space retire confirmation mismatch");
  }
  const current = await prepareRetireSpace(
    db,
    approvedPlan.space.slug,
    approvedPlan.acceptedSpaceSlug,
  );
  if (current.planSha256 !== approvedPlan.planSha256 || current.blockers.length > 0) {
    throw new Error("embedding space retire plan drifted before mutation");
  }
  // SurrealDB 3.2.3 can deadlock when HNSW DDL is mixed into a data
  // transaction. Remove only the rejected derived table first, then delete
  // its metadata/jobs atomically. A failure between the two leaves the
  // rejected space record discoverable for repair and never mutates a
  // protected active/accepted table.
  await db.query(`REMOVE TABLE IF EXISTS ${approvedPlan.space.physicalTable}`);
  await db.query(
    `BEGIN;
     DELETE embedding_job WHERE embedding_space = $space;
     DELETE ONLY $space;
     COMMIT;`,
    { space: new RecordId("embedding_space", approvedPlan.space.slug) },
  );
  const [remainingSpace, remainingJobs, corpus, spaces] = await Promise.all([
    getSpaceBySlug(db, approvedPlan.space.slug),
    selectAll<{ id: RecordId }>(
      db,
      "SELECT id FROM embedding_job WHERE embedding_space = $space",
      { space: new RecordId("embedding_space", approvedPlan.space.slug) },
    ),
    canonicalCorpusIdentity(db),
    listSpaces(db),
  ]);
  const protectedSpaces = await Promise.all(approvedPlan.protectedSpaces.map((expected) => {
    const protectedSpace = spaces.find((space) => space.slug === expected.slug);
    if (!protectedSpace) throw new Error("embedding space retire removed a protected space");
    return collectSpaceDerivedBinding(db, protectedSpace, expected.roles);
  }));
  if (
    remainingSpace || remainingJobs.length > 0 ||
    corpus.documents !== approvedPlan.canonicalCorpus.documents ||
    corpus.sha256 !== approvedPlan.canonicalCorpus.sha256 ||
    retireHash(protectedSpaces) !== retireHash(approvedPlan.protectedSpaces)
  ) throw new Error("embedding space retire immediate verification failed");
  return {
    slug: approvedPlan.space.slug,
    jobsDeleted: approvedPlan.jobs.count,
    vectorsDeleted: approvedPlan.vectors.count,
    canonicalCorpusUnchanged: true,
    protectedSpacesVerified: true,
    candidateEvidencePreserved: true,
  };
}
