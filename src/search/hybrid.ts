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
  workspace?: string;
  model?: string;
  ts?: Date;
}

/** Есть ли активные фильтры §14 (для over-fetch в searchVector). */
function hasFilters(filters: SearchFilters): boolean {
  return Boolean(
    filters.harness ||
      filters.host ||
      filters.workspace ||
      filters.model ||
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
  if (
    provider.provider !== space.provider ||
    provider.model !== space.model ||
    provider.dimensions !== space.dimensions
  ) {
    throw new VectorSearchUnavailable(
      `provider ${provider.provider}/${provider.model}@${provider.dimensions} не совпадает с active space ${space.provider}/${space.model}@${space.dimensions}`,
    );
  }
  const { vectors } = await provider.embed([query]);
  const queryVector = vectors[0];
  if (!queryVector) throw new VectorSearchUnavailable("provider вернул пустой результат на query");

  const k = hasFilters(filters)
    ? Math.min(Math.max(VECTOR_TOP_K * VECTOR_OVERFETCH_FACTOR, 200), VECTOR_MAX_CANDIDATES)
    : VECTOR_TOP_K;
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
       dialogue.workspace.name AS workspace,
       (message.raw_model_name ?? dialogue.primary_model.canonical_name) AS model,
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
      model: doc.model,
      timestamp: doc.ts?.toISOString(),
    }))
    .sort((a, b) => b.score - a.score)
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
    .sort((a, b) => b[1] - a[1])
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
  const [textHits, vectorHits] = await Promise.all([
    searchText(db, query, { ...filters, limit: VECTOR_TOP_K }),
    searchVector(db, provider, query, { ...filters, limit: VECTOR_TOP_K }),
  ]);
  return diversifyByDialogue(dedupByMessage(rrfFuse([textHits, vectorHits]))).slice(
    0,
    filters.limit,
  );
}
