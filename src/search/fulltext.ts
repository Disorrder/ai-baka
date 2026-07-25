/**
 * Full-text search (docs/plan.md §12, §14, этап 6).
 *
 * Обычный режим — BM25 по search_document (только текущие revisions:
 * projection и так содержит только current, §8.1) с highlights
 * (FULLTEXT-индекс с HIGHLIGHTS, schema/0002).
 *
 * Forensic режим (§12.1) — BM25 по chunk.content; включается явными
 * флагами: --include-reasoning (kind=thought), --include-tools
 * (tool_call/tool_result), --all-revisions (не только current revision).
 *
 * Проверенный на SurrealDB 3.2.3 синтаксис BM25:
 *   WHERE content @0@ $q            — matches operator, 0 = номер предиката
 *   search::score(0) AS score       — BM25 score по предикату 0
 *   search::highlight('<em>', '</em>', 0) — контент с подсветкой матчей
 *
 * Деградация (§14): vector/hybrid режимы — этап 7, здесь не реализованы.
 */

import type { Surreal } from "surrealdb";
import { selectAll } from "../db/repositories/helpers.ts";

export interface SearchFilters {
  harness?: string;
  host?: string;
  workspace?: string;
  model?: string;
  documentType?: string;
  from?: Date;
  to?: Date;
  deletedOnly?: boolean;
  includeReasoning?: boolean;
  includeTools?: boolean;
  allRevisions?: boolean;
  limit: number;
}

export interface SearchHit {
  id: string;
  score: number;
  /** Snippet с <em>подсветкой</em> матчей, усечён вокруг первого матча. */
  snippet: string;
  documentType?: string;
  segmentNo?: number;
  /** Forensic: kind/role чанка. */
  kind?: string;
  role?: string;
  dialogueId: string;
  dialogueTitle?: string;
  revisionId: string;
  harness?: string;
  host?: string;
  workspace?: string;
  model?: string;
  timestamp?: string;
}

/** Forensic mode включается любым из явных флагов §12.1. */
export function isForensic(filters: Pick<SearchFilters, "includeReasoning" | "includeTools" | "allRevisions">): boolean {
  return Boolean(filters.includeReasoning || filters.includeTools || filters.allRevisions);
}

/** Усечь highlight-контент вокруг первого матча (highlight возвращает ВЕСЬ текст). */
export function formatSnippet(highlighted: string, maxLen = 400): string {
  const compact = highlighted.replaceAll(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  const firstMark = compact.indexOf("<em>");
  const anchor = firstMark >= 0 ? firstMark : 0;
  let start = Math.max(0, anchor - Math.floor(maxLen / 3));
  // не рвать слово
  if (start > 0) {
    const space = compact.indexOf(" ", start);
    start = space >= 0 && space < anchor ? space + 1 : start;
  }
  const end = Math.min(compact.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

interface FilterClause {
  clause: string;
  vars: Record<string, unknown>;
}

/** Общие фильтры §14 (пути полей одинаковы для search_document и chunk). */
function buildFilterClauses(filters: SearchFilters): FilterClause {
  const clauses: string[] = [];
  const vars: Record<string, unknown> = {};
  if (filters.harness) {
    clauses.push("dialogue.harness_installation.harness.slug = $f_harness");
    vars.f_harness = filters.harness;
  }
  if (filters.host) {
    clauses.push(
      "(dialogue.harness_installation.host.label = $f_host OR dialogue.harness_installation.host.hostname = $f_host)",
    );
    vars.f_host = filters.host;
  }
  if (filters.workspace) {
    clauses.push("dialogue.workspace.name = $f_workspace");
    vars.f_workspace = filters.workspace;
  }
  if (filters.model) {
    clauses.push(
      "(message.raw_model_name = $f_model OR message.model.canonical_name = $f_model OR dialogue.primary_model.canonical_name = $f_model)",
    );
    vars.f_model = filters.model;
  }
  if (filters.from) {
    clauses.push("(message.timestamp ?? dialogue.updated_at) >= $f_from");
    vars.f_from = filters.from;
  }
  if (filters.to) {
    clauses.push("(message.timestamp ?? dialogue.updated_at) <= $f_to");
    vars.f_to = filters.to;
  }
  if (filters.deletedOnly) {
    clauses.push(
      "dialogue.current_revision.source_revision.source_location.presence_status = 'deleted_in_source'",
    );
  }
  return { clause: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "", vars };
}

interface HitRow {
  id: unknown;
  score: number;
  hl: string;
  document_type?: string;
  segment_no?: number;
  kind?: string;
  role?: string;
  dialogue_id: unknown;
  dialogue_title?: string;
  revision_id: unknown;
  harness?: string;
  host?: string;
  workspace?: string;
  model?: string;
  ts?: Date;
}

function toHit(row: HitRow): SearchHit {
  return {
    id: String(row.id),
    score: row.score,
    snippet: formatSnippet(row.hl),
    documentType: row.document_type,
    segmentNo: row.segment_no,
    kind: row.kind,
    role: row.role,
    dialogueId: String(row.dialogue_id),
    dialogueTitle: row.dialogue_title,
    revisionId: String(row.revision_id),
    harness: row.harness,
    host: row.host,
    workspace: row.workspace,
    model: row.model,
    timestamp: row.ts?.toISOString(),
  };
}

const CONTEXT_SELECT = `
  dialogue.id AS dialogue_id,
  dialogue.title AS dialogue_title,
  dialogue_revision.id AS revision_id,
  dialogue.harness_installation.harness.slug AS harness,
  (dialogue.harness_installation.host.label ?? dialogue.harness_installation.host.hostname) AS host,
  dialogue.workspace.name AS workspace,
  (message.raw_model_name ?? dialogue.primary_model.canonical_name) AS model,
  (message.timestamp ?? dialogue.updated_at) AS ts`;

/** Обычный поиск: BM25 по search_document (только current revisions, §8.1). */
export async function searchText(
  db: Surreal,
  query: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  const { clause, vars } = buildFilterClauses(filters);
  let typeClause = "";
  if (filters.documentType) {
    typeClause = " AND document_type = $f_doctype";
    vars.f_doctype = filters.documentType;
  }
  const rows = await selectAll<HitRow>(
    db,
    `SELECT id, document_type, segment_no,
       search::score(0) AS score,
       search::highlight('<em>', '</em>', 0) AS hl,
       ${CONTEXT_SELECT}
     FROM search_document
     WHERE content @0@ $q${typeClause}${clause}
     ORDER BY score DESC
     LIMIT $limit`,
    { q: query, limit: filters.limit, ...vars },
  );
  return rows.map(toHit);
}

/** Forensic search (§12.1): BM25 по chunk.content с фильтрами по kind. */
export async function searchForensic(
  db: Surreal,
  query: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  const kinds = ["text"];
  if (filters.includeReasoning) kinds.push("thought");
  if (filters.includeTools) kinds.push("tool_call", "tool_result");
  const { clause, vars } = buildFilterClauses(filters);
  const revisionClause = filters.allRevisions
    ? ""
    : " AND dialogue_revision = dialogue.current_revision";
  const rows = await selectAll<HitRow>(
    db,
    `SELECT id, kind, role,
       search::score(0) AS score,
       search::highlight('<em>', '</em>', 0) AS hl,
       ${CONTEXT_SELECT}
     FROM chunk
     WHERE content @0@ $q AND kind INSIDE $kinds${revisionClause}${clause}
     ORDER BY score DESC
     LIMIT $limit`,
    { q: query, kinds, limit: filters.limit, ...vars },
  );
  return rows.map(toHit);
}
