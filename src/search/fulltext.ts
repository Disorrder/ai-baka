/**
 * Full-text search (docs/plan.md §12, §14, этап 6).
 *
 * Обычный режим — BM25 по search_document (только текущие revisions:
 * projection и так содержит только current, §8.1) с highlights
 * (FULLTEXT-индекс с HIGHLIGHTS, schema/0002).
 *
 * Глобальный forensic BM25 по chunk.content отключён в schema 5: canonical
 * chunks и historical revisions сохранены, но индекс всех физических chunks
 * слишком дорог для обязательного backup/restore path. Legacy forensic-флаги
 * fail closed до появления отдельной ограниченной derived projection; ни один
 * из них не должен деградировать в table scan.
 *
 * Проверенный на SurrealDB 3.2.3 синтаксис BM25:
 *   WHERE content @0@ $q            — matches operator, 0 = номер предиката
 *   search::score(0) AS score       — BM25 score по предикату 0
 *   search::highlight('<em>', '</em>', 0) — контент с подсветкой матчей
 *
 * Общий result/filter contract переиспользуется vector/hybrid поиском
 * (src/search/hybrid.ts), чтобы CLI-поля не расходились между режимами.
 */

import type { Surreal } from "surrealdb";
import { selectAll } from "../db/repositories/helpers.ts";

export interface SearchFilters {
  harness?: string;
  host?: string;
  user?: string;
  workspace?: string;
  vendor?: string;
  model?: string;
  reasoningEffort?: string;
  role?: string;
  documentType?: string;
  from?: Date;
  to?: Date;
  deletedOnly?: boolean;
  includeReasoning?: boolean;
  includeTools?: boolean;
  includeSystem?: boolean;
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
  /** Forensic: kind чанка. */
  kind?: string;
  /** Нормализованная role сообщения; в forensic совпадает с chunk.role. */
  role?: string;
  /** Исходное сообщение (dedup в hybrid mode, §14). */
  messageId?: string;
  dialogueId: string;
  dialogueTitle?: string;
  revisionId: string;
  harness?: string;
  host?: string;
  workspace?: string;
  user?: string;
  vendor?: string;
  model?: string;
  reasoningEffort?: string;
  /** Оригинальный путь source_location, не raw archive path. */
  sourcePath?: string;
  timestamp?: string;
}

export const FORENSIC_SEARCH_DISABLED_MESSAGE =
  "forensic search отключён: глобальный индекс chunk.content удалён; " +
  "canonical chunks и historical revisions сохранены, используйте обычный поиск по " +
  "user_prompt/assistant_final или отдельный export диалога";

export class ForensicSearchDisabledError extends Error {
  constructor() {
    super(FORENSIC_SEARCH_DISABLED_MESSAGE);
    this.name = "ForensicSearchDisabledError";
  }
}

/** Legacy forensic mode запрашивается любым из прежних явных флагов. */
export function isForensic(filters: Pick<SearchFilters, "includeReasoning" | "includeTools" | "includeSystem" | "allRevisions">): boolean {
  return Boolean(filters.includeReasoning || filters.includeTools || filters.includeSystem || filters.allRevisions);
}

/**
 * Fail closed до подключения к БД/выполнения query. Это не fallback: без
 * chunk_content запрос `content @...@` не должен превращаться в полный scan.
 */
export function assertForensicSearchDisabled(
  filters: Pick<
    SearchFilters,
    "includeReasoning" | "includeTools" | "includeSystem" | "allRevisions"
  >,
): void {
  if (isForensic(filters)) throw new ForensicSearchDisabledError();
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

/** Общие фильтры normal BM25/vector/hybrid search (§14). */
export function buildFilterClauses(filters: SearchFilters): FilterClause {
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
  if (filters.user) {
    clauses.push("dialogue.os_account.os_username = $f_user");
    vars.f_user = filters.user;
  }
  if (filters.workspace) {
    clauses.push("dialogue.workspace.name = $f_workspace");
    vars.f_workspace = filters.workspace;
  }
  if (filters.vendor) {
    clauses.push(
      "(message.model.vendor.slug ?? dialogue.primary_model.vendor.slug) = $f_vendor",
    );
    vars.f_vendor = filters.vendor;
  }
  if (filters.model) {
    clauses.push(
      "(message.raw_model_name = $f_model OR message.model.canonical_name = $f_model OR dialogue.primary_model.canonical_name = $f_model)",
    );
    vars.f_model = filters.model;
  }
  if (filters.reasoningEffort) {
    clauses.push("message.reasoning_effort = $f_reasoning_effort");
    vars.f_reasoning_effort = filters.reasoningEffort;
  }
  if (filters.role) {
    clauses.push("message.role = $f_role");
    vars.f_role = filters.role;
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
  message_role?: string;
  message_id?: unknown;
  dialogue_id: unknown;
  dialogue_title?: string;
  revision_id: unknown;
  harness?: string;
  host?: string;
  workspace?: string;
  os_user?: string;
  model_vendor?: string;
  model?: string;
  reasoning_effort?: string;
  source_path?: string;
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
    role: row.role ?? row.message_role,
    messageId: row.message_id ? String(row.message_id) : undefined,
    dialogueId: String(row.dialogue_id),
    dialogueTitle: row.dialogue_title,
    revisionId: String(row.revision_id),
    harness: row.harness,
    host: row.host,
    workspace: row.workspace,
    user: row.os_user,
    vendor: row.model_vendor,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sourcePath: row.source_path,
    timestamp: row.ts?.toISOString(),
  };
}

const CONTEXT_SELECT = `
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
  message.role AS message_role,
  dialogue_revision.source_revision.source_location.original_path AS source_path,
  (message.timestamp ?? dialogue.updated_at) AS ts`;

/** Обычный поиск: BM25 по search_document (только current revisions, §8.1). */
export async function searchText(
  db: Surreal,
  query: string,
  filters: SearchFilters,
): Promise<SearchHit[]> {
  assertForensicSearchDisabled(filters);
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
     ORDER BY score DESC, id ASC
     LIMIT $limit`,
    { q: query, limit: filters.limit, ...vars },
  );
  return rows.map(toHit);
}

/**
 * Compatibility seam для старых library callers. Всегда отказывает до
 * обращения к БД: schema 5 не имеет глобального chunk_content index.
 */
export async function searchForensic(
  _db: Surreal,
  _query: string,
  _filters: SearchFilters,
): Promise<SearchHit[]> {
  throw new ForensicSearchDisabledError();
}
