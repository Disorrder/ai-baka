/**
 * Vector и hybrid search (docs/plan.md §13.3, §14, этап 7).
 *
 * Vector mode: query → provider.embed → ANN top 50 по физической таблице
 * ACTIVE embedding space. Рабочий синтаксис SurrealDB 3.2.3 (проверено на
 * живой базе): `WHERE vector <|K, EF|> $q` — при наличии HNSW-индекса даёт
 * operator "KnnScan" в EXPLAIN FULL (сценарий №24); distance выбранной
 * строки — `vector::distance::knn()`. `<|K|>` без EF в 3.2.3 отвергается
 * (legacy KTree/M-Tree).
 *
 * Hybrid mode: BM25 top 50 + vector top 50 → Reciprocal Rank Fusion
 * (клиентский RRF k=60 — search::rrf() в 3.2.3 требует переписывания
 * запросов на subquery-форму, клиентский вариант проще и детерминирован)
 * → dedup по message → diversification по dialogue (не более
 * MAX_HITS_PER_DIALOGUE hits) → top N. Вывод совпадает с text mode
 * (SearchHit).
 *
 * Деградация (§14): нет active space или API key — vector mode бросает
 * VectorSearchUnavailable с причиной; hybrid на уровне CLI деградирует
 * в lexical search с явным предупреждением.
 */

import type { RecordId, Surreal } from "surrealdb";
import { selectAll } from "../db/repositories/helpers.ts";
import type { EmbeddingProvider } from "../embeddings/provider.ts";
import { getActiveSpace, type EmbeddingSpace } from "../embeddings/spaces.ts";
import {
  buildFilterClauses,
  formatSnippet,
  searchText,
  type SearchFilters,
  type SearchHit,
} from "./fulltext.ts";

/** Размеры выборок pipeline §14: top 50 из каждого ранжирования. */
export const VECTOR_TOP_K = 50;
/** EF HNSW-поиска (>= K): чем больше, тем точнее ANN и медленнее. */
export const HNSW_EF = 200;
/** Множитель over-fetch ANN при активных фильтрах §14 (см. searchVector). */
export const VECTOR_OVERFETCH_FACTOR = 4;
/** Потолок кандидатов ANN при over-fetch. */
export const VECTOR_MAX_CANDIDATES = 1000;
/** Diversification (§14 шаг 5): не более стольких hits на один dialogue. */
export const MAX_HITS_PER_DIALOGUE = 3;
/** RRF constant (план §14: k = 60). */
export const RRF_K = 60;

export class VectorSearchUnavailable extends Error {}

function compareStableId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable ordering used before all later dedup/diversification stages. */
export function compareSearchHitsByScore(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || compareStableId(a.id, b.id);
}

/** Причина недоступности vector mode или готовый контекст (§14). */
export async function resolveActiveSpace(db: Surreal): Promise<EmbeddingSpace> {
  const space = await getActiveSpace(db);
  if (!space) {
    throw new VectorSearchUnavailable(
      "нет active embedding_space (baka embeddings space:create + space:activate)",
    );
  }
  return space;
}

interface AnnRow {
  search_document: RecordId;
  dist: number;
}

interface HydratedRow {
  id: RecordId;
  content: string;
  document_type?: string;
  segment_no?: number;
  message_id?: RecordId;
  dialogue_id: RecordId;
  dialogue_title?: string;
  revision_id: RecordId;
  harness?: string;
  host?: string;
  os_user?: string;
  workspace?: string;
  model_vendor?: string;
  model?: string;
  reasoning_effort?: string;
  role?: string;
  source_path?: string;
  ts?: Date;
}

/** Есть ли активные фильтры §14 (для over-fetch в searchVector). */
export function hasSearchFilters(filters: SearchFilters): boolean {
  return Boolean(
    filters.harness ||
      filters.host ||
      filters.user ||
      filters.workspace ||
      filters.vendor ||
      filters.model ||
      filters.reasoningEffort ||
      filters.role ||
      filters.documentType ||
      filters.from ||
      filters.to ||
      filters.deletedOnly,
  );
}

/**
 * Vector ANN search по active space. Возвращает не более filters.limit hits.
 *
 * HNSW в SurrealDB не поддерживает partial WHERE, поэтому фильтры §14
 * нельзя применить внутри ANN-запроса. Без фильтров — top 50 ANN, как
 * раньше. При активных фильтрах — over-fetch: запрашиваем
 * max(50 × VECTOR_OVERFETCH_FACTOR, 200) (потолок VECTOR_MAX_CANDIDATES)
 * кандидатов, фильтруем при гидратации search_document и режем до limit;
 * иначе подходящие документы вне глобального top-50 никогда не
 * рассматривались (ложные пустые результаты редких фильтров).
 */
export async function searchVector(
  db: Surreal,
  provider: EmbeddingProvider,
  query: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  const space = await resolveActiveSpace(db);
  return searchVectorInSpace(db, provider, space, query, filters);
}

/**
 * Vector ANN search по явно выбранному space.
 *
 * В отличие от searchVector не читает и не меняет active space. Этот seam
 * нужен relevance evaluation (§21): candidate spaces сравниваются на одном
 * корпусе без опасного переключения production-конфигурации между запросами.
 */
export async function searchVectorInSpace(
  db: Surreal,
  provider: EmbeddingProvider,
  space: EmbeddingSpace,
  query: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  if (
    provider.provider !== space.provider ||
    provider.model !== space.model ||
    provider.dimensions !== space.dimensions
  ) {
    throw new VectorSearchUnavailable(
      `provider ${provider.provider}/${provider.model}@${provider.dimensions} не совпадает со space ${space.provider}/${space.model}@${space.dimensions}`,
    );
  }
  const { vectors } = await provider.embed([query]);
  const queryVector = vectors[0];
  if (!queryVector) throw new VectorSearchUnavailable("provider вернул пустой результат на query");

  // Normal CLI queries keep the historical top-50 floor. Evaluation may ask
  // for a wider document pool so ten *distinct dialogues* can be ranked even
  // when several segments from one dialogue are near-neighbours.
  const requested = Math.min(
    Math.max(VECTOR_TOP_K, Math.ceil(filters.limit)),
    VECTOR_MAX_CANDIDATES,
  );
  const k = hasSearchFilters(filters)
    ? Math.min(
        Math.max(requested * VECTOR_OVERFETCH_FACTOR, 200),
        VECTOR_MAX_CANDIDATES,
      )
    : requested;
  const ef = Math.max(HNSW_EF, k);
  const ann = await selectAll<AnnRow>(
    db,
    `SELECT search_document, vector::distance::knn() AS dist FROM ${space.physical_table}
     WHERE vector <|${k}, ${ef}|> $q`,
    { q: queryVector },
  );
  if (ann.length === 0) return [];

  const { clause, vars } = buildFilterClauses(filters);
  let typeClause = "";
  if (filters.documentType) {
    typeClause = " AND document_type = $f_doctype";
    vars.f_doctype = filters.documentType;
  }
  const docs = await selectAll<HydratedRow>(
    db,
    `SELECT id, content, document_type, segment_no,
       message.id AS message_id,
       dialogue.id AS dialogue_id,
       dialogue.title AS dialogue_title,
       dialogue_revision.id AS revision_id,
       dialogue.harness_installation.harness.slug AS harness,
       (dialogue.harness_installation.host.label ?? dialogue.harness_installation.host.hostname) AS host,
       dialogue.os_account.os_username AS os_user,
       dialogue.workspace.name AS workspace,
       (message.model.vendor.slug ?? dialogue.primary_model.vendor.slug) AS model_vendor,
       (message.raw_model_name ?? dialogue.primary_model.canonical_name) AS model,
       message.reasoning_effort AS reasoning_effort,
       message.role AS role,
       dialogue_revision.source_revision.source_location.original_path AS source_path,
       (message.timestamp ?? dialogue.updated_at) AS ts
     FROM search_document WHERE id INSIDE $ids${typeClause}${clause}`,
    { ids: ann.map((row) => row.search_document), ...vars },
  );
  const distByDoc = new Map(ann.map((row) => [String(row.search_document), row.dist]));
  return docs
    .map((doc) => ({
      id: String(doc.id),
      // Cosine distance → similarity score (0..1), для единообразия с BM25 score.
      score: 1 - (distByDoc.get(String(doc.id)) ?? 1),
      snippet: formatSnippet(doc.content),
      documentType: doc.document_type,
      segmentNo: doc.segment_no,
      messageId: doc.message_id ? String(doc.message_id) : undefined,
      dialogueId: String(doc.dialogue_id),
      dialogueTitle: doc.dialogue_title,
      revisionId: String(doc.revision_id),
      harness: doc.harness,
      host: doc.host,
      workspace: doc.workspace,
      user: doc.os_user,
      vendor: doc.model_vendor,
      model: doc.model,
      reasoningEffort: doc.reasoning_effort,
      role: doc.role,
      sourcePath: doc.source_path,
      timestamp: doc.ts?.toISOString(),
    }))
    .sort(compareSearchHitsByScore)
    .slice(0, filters.limit);
}

/**
 * Reciprocal Rank Fusion (§14, k=60): score(d) = Σ 1/(k + rank) по каждому
 * ранжированию. Списки уже отсортированы по убыванию score. Для отображения
 * берётся hit из первого списка, где документ встретился (BM25-первый —
 * у него snippet с подсветкой). Чистая функция — unit-тестируется.
 */
export function rrfFuse(lists: SearchHit[][], k = RRF_K): SearchHit[] {
  const scores = new Map<string, number>();
  const hits = new Map<string, SearchHit>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank + 1));
      if (!hits.has(hit.id)) hits.set(hit.id, hit);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || compareStableId(a[0], b[0]))
    .map(([id, score]) => ({ ...hits.get(id)!, score }));
}

/** Dedup по message (§14): один документ-сегмент на сообщение, лучший по score. */
export function dedupByMessage(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = hit.messageId ?? hit.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/**
 * Diversification по dialogue (§14 шаг 5): не более maxPerDialogue hits
 * на один диалог, порядок и score остальных не меняются. Чистая функция.
 */
export function diversifyByDialogue(
  hits: SearchHit[],
  maxPerDialogue = MAX_HITS_PER_DIALOGUE,
): SearchHit[] {
  const counts = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const count = counts.get(hit.dialogueId) ?? 0;
    if (count >= maxPerDialogue) continue;
    counts.set(hit.dialogueId, count + 1);
    out.push(hit);
  }
  return out;
}

/**
 * Hybrid pipeline §14: BM25 top 50 + vector top 50 → RRF → dedup по
 * message → diversification по dialogue → top N.
 */
export async function searchHybrid(
  db: Surreal,
  provider: EmbeddingProvider,
  query: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  const space = await resolveActiveSpace(db);
  return searchHybridInSpace(db, provider, space, query, filters);
}

/** Hybrid pipeline для candidate space без изменения active metadata (§21). */
export async function searchHybridInSpace(
  db: Surreal,
  provider: EmbeddingProvider,
  space: EmbeddingSpace,
  query: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  const candidateLimit = Math.min(
    Math.max(VECTOR_TOP_K, filters.limit * MAX_HITS_PER_DIALOGUE),
    VECTOR_MAX_CANDIDATES,
  );
  const [textHits, vectorHits] = await Promise.all([
    searchText(db, query, { ...filters, limit: candidateLimit }),
    searchVectorInSpace(db, provider, space, query, { ...filters, limit: candidateLimit }),
  ]);
  return diversifyByDialogue(dedupByMessage(rrfFuse([textHits, vectorHits]))).slice(
    0,
    filters.limit,
  );
}
