#!/usr/bin/env bun
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";

interface DialogueRow {
  id: unknown;
  external_id?: string;
  current_revision: unknown;
  source_revision?: unknown;
  parser_version?: string | number;
  raw_archive_path?: string;
  started_at?: Date | string;
  updated_at?: Date | string;
}

interface SourceRow {
  raw_archive_path?: string;
  captured_at?: Date | string;
}

interface UsageMessageRow {
  id: unknown;
  dialogue_revision: unknown;
  sequence: number;
  raw_usage_events?: Array<Record<string, unknown>>;
}

interface SessionMeta {
  id?: string;
  parentId?: string;
  depth?: number;
  nickname?: string;
  role?: string;
  source?: unknown;
}

export interface UsageVector {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalTokensReported: number;
}

interface Session extends DialogueRow {
  rawPath: string;
  meta: SessionMeta;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function archivedRegularFile(archiveRoot: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`raw_archive_path must be relative: ${relativePath}`);
  }
  const root = path.resolve(archiveRoot);
  const candidate = path.resolve(root, relativePath);
  if (!containedBy(root, candidate) || candidate === root) {
    throw new Error(`raw_archive_path escapes archive root: ${relativePath}`);
  }
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`raw snapshot is not a regular non-symlink file: ${relativePath}`);
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!containedBy(realRoot, realFile)) {
    throw new Error(`raw snapshot realpath escapes archive root: ${relativePath}`);
  }
  return realFile;
}

async function firstSessionMeta(file: string): Promise<SessionMeta> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== "session_meta") continue;
      const payload = object(event.payload) ?? {};
      const source = object(payload.source);
      const subagent = object(source?.subagent);
      const spawn = object(subagent?.thread_spawn);
      return {
        id: string(payload.id) ?? string(payload.session_id),
        parentId: string(payload.forked_from_id) ?? string(spawn?.parent_thread_id),
        depth: number(spawn?.depth) || undefined,
        nickname: string(spawn?.agent_nickname),
        role: string(spawn?.agent_role),
        source: payload.source,
      };
    }
  } finally {
    lines.close();
  }
  return {};
}

async function requestUsage(file: string): Promise<UsageVector[]> {
  const result: UsageVector[] = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let previousKey: string | undefined;
  for await (const line of lines) {
    if (!line.includes('"token_count"') || !line.includes('"last_token_usage"')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "event_msg") continue;
    const payload = object(event.payload);
    if (payload?.type !== "token_count") continue;
    const last = object(object(payload.info)?.last_token_usage);
    if (!last) continue;
    const vector: UsageVector = {
      inputTokens: number(last.input_tokens),
      cachedInputTokens: number(last.cached_input_tokens),
      outputTokens: number(last.output_tokens),
      reasoningOutputTokens: number(last.reasoning_output_tokens),
      totalTokens: number(last.input_tokens) + number(last.output_tokens),
      totalTokensReported: number(last.total_tokens),
    };
    // Codex пишет один вызов по разу на каждый rate-limit bucket с идентичным
    // info (см. CODEX_PARSER_VERSION 8) — схлопываем подряд идущие копии, чтобы
    // replay-матчинг и вычитание работали на реальных вызовах.
    const total = object(object(payload.info)?.total_token_usage);
    const dedupeKey = `${usageKey(vector)}|${usageKey({
      inputTokens: number(total?.input_tokens),
      cachedInputTokens: number(total?.cached_input_tokens),
      outputTokens: number(total?.output_tokens),
      reasoningOutputTokens: number(total?.reasoning_output_tokens),
      totalTokens: 0,
      totalTokensReported: number(total?.total_tokens),
    })}`;
    if (dedupeKey === previousKey) continue;
    previousKey = dedupeKey;
    result.push(vector);
  }
  return result;
}

function usageKey(u: UsageVector): string {
  return [
    u.inputTokens,
    u.cachedInputTokens,
    u.outputTokens,
    u.reasoningOutputTokens,
    u.totalTokensReported,
  ].join(":");
}

function sameUsage(a: UsageVector, b: UsageVector): boolean {
  return a.inputTokens === b.inputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.totalTokensReported === b.totalTokensReported;
}

/**
 * Минимальная длина совпадения для признания replay: 5-числовые usage-векторы
 * делают случайный матч подряд идущих 3 событий практически невозможным.
 */
const MIN_REPLAY_EVENTS = 3;

interface ReplayMatch {
  events: number;
  parentOffset: number;
}

/**
 * Унаследованный контекст в child rollout — это префикс child-потока, но не
 * обязательно префикс parent'а: при позднем spawn codex пишет в child текущий
 * хвост контекста (после compaction'ов), а не всю историю с нуля. Ищем
 * максимальный префикс child, совпадающий с непрерывным участком parent
 * с любого offset; offset 0 — частный случай (полная история).
 */
function replayMatch(child: readonly UsageVector[], parent: readonly UsageVector[]): ReplayMatch {
  if (child.length === 0 || parent.length === 0) return { events: 0, parentOffset: -1 };
  const offsetsByKey = new Map<string, number[]>();
  for (let index = 0; index < parent.length; index += 1) {
    const key = usageKey(parent[index]!);
    const list = offsetsByKey.get(key);
    if (list) list.push(index);
    else offsetsByKey.set(key, [index]);
  }
  let best: ReplayMatch = { events: 0, parentOffset: -1 };
  for (const offset of offsetsByKey.get(usageKey(child[0]!)) ?? []) {
    let length = 1;
    while (
      length < child.length &&
      offset + length < parent.length &&
      sameUsage(child[length]!, parent[offset + length]!)
    ) {
      length += 1;
    }
    if (length > best.events) best = { events: length, parentOffset: offset };
    if (best.events >= child.length) break;
  }
  if (best.events < MIN_REPLAY_EVENTS) return { events: 0, parentOffset: -1 };
  return best;
}

function sumUsage(rows: readonly UsageVector[]): UsageVector {
  return rows.reduce<UsageVector>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + row.cachedInputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      reasoningOutputTokens: sum.reasoningOutputTokens + row.reasoningOutputTokens,
      totalTokens: sum.totalTokens + row.totalTokens,
      totalTokensReported: sum.totalTokensReported + row.totalTokensReported,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      totalTokensReported: 0,
    },
  );
}

async function loadCurrentCodex(db: Surreal, archiveRoot: string): Promise<Session[]> {
  const rows = await selectAll<DialogueRow>(
    db,
    `SELECT id, external_id, current_revision,
       current_revision.source_revision AS source_revision,
       current_revision.parser_version AS parser_version,
       current_revision.source_revision.raw_archive_path AS raw_archive_path,
       started_at, updated_at
     FROM dialogue
     WHERE current_revision.parser_name = "codex"
       AND current_revision.source_revision.raw_archive_path IS NOT NONE
     ORDER BY id`,
  );
  const candidates: Session[] = [];
  for (const row of rows) {
    if (!row.raw_archive_path) continue;
    const rawPath = await archivedRegularFile(archiveRoot, row.raw_archive_path);
    candidates.push({ ...row, rawPath, meta: await firstSessionMeta(rawPath) });
  }
  const bySource = new Map<string, Session>();
  for (const session of candidates) {
    const key = String(session.source_revision ?? session.raw_archive_path);
    const previous = bySource.get(key);
    if (!previous || Number(session.parser_version ?? 0) > Number(previous.parser_version ?? 0)) {
      bySource.set(key, session);
    }
  }
  return [...bySource.values()];
}

async function loadCurrentCodexSources(db: Surreal, archiveRoot: string): Promise<Session[]> {
  const rows = await selectAll<SourceRow>(
    db,
    `SELECT id, raw_archive_path, captured_at
     FROM source_revision
     WHERE source_location.source_root.harness_installation.harness.slug = "codex"
       AND raw_archive_path IS NOT NONE
     ORDER BY captured_at DESC, id DESC`,
  );
  const seen = new Set<string>();
  const sessions: Session[] = [];
  for (const row of rows) {
    if (!row.raw_archive_path || seen.has(row.raw_archive_path)) continue;
    seen.add(row.raw_archive_path);
    const rawPath = await archivedRegularFile(archiveRoot, row.raw_archive_path);
    sessions.push({
      id: "",
      current_revision: "",
      raw_archive_path: row.raw_archive_path,
      rawPath,
      meta: await firstSessionMeta(rawPath),
    });
  }
  return sessions;
}

export async function analyzeCodexLineage(
  db: Surreal,
  archiveRoot: string,
  allowedRevisions?: ReadonlySet<string>,
) {
    const [allSessions, sourceSessions] = await Promise.all([
      loadCurrentCodex(db, archiveRoot),
      loadCurrentCodexSources(db, archiveRoot),
    ]);
    const sessions = allowedRevisions
      ? allSessions.filter((session) => allowedRevisions.has(String(session.current_revision)))
      : allSessions;
    const byExternalId = new Map<string, Session>();
    for (const session of sourceSessions) {
      const externalId = session.meta.id ?? session.external_id;
      if (externalId && !byExternalId.has(externalId)) {
        byExternalId.set(externalId, session);
      }
    }
    const children = sessions.filter((session) => session.meta.parentId);
    const usageCache = new Map<string, Promise<UsageVector[]>>();
    const usage = (session: Session): Promise<UsageVector[]> => {
      let pending = usageCache.get(session.rawPath);
      if (!pending) {
        pending = requestUsage(session.rawPath);
        usageCache.set(session.rawPath, pending);
      }
      return pending;
    };

    const totals = {
      currentCodexSessions: sessions.length,
      currentCodexSourceFiles: sourceSessions.length,
      subagentSessions: children.length,
      linkedParents: 0,
      missingParents: 0,
      exactReplaySessions: 0,
      noReplaySessions: 0,
      replayEvents: 0,
      childEvents: 0,
      replay: sumUsage([]),
      childRaw: sumUsage([]),
    };
    const details: Array<Record<string, unknown>> = [];
    const replayUsageByRevision = new Map<string, UsageVector[]>();
    for (const [index, child] of children.entries()) {
      const parent = byExternalId.get(child.meta.parentId!);
      const childUsage = await usage(child);
      totals.childEvents += childUsage.length;
      const childTotal = sumUsage(childUsage);
      totals.childRaw = sumUsage([totals.childRaw, childTotal]);
      if (!parent) {
        totals.missingParents += 1;
        details.push({
          revision: String(child.current_revision),
          childId: child.meta.id,
          parentId: child.meta.parentId,
          depth: child.meta.depth,
          nickname: child.meta.nickname,
          role: child.meta.role,
          status: "parent_missing",
        });
        continue;
      }
      totals.linkedParents += 1;
      const parentUsage = await usage(parent);
      const match = replayMatch(childUsage, parentUsage);
      const replayEvents = match.events;
      const replay = sumUsage(childUsage.slice(0, replayEvents));
      totals.replayEvents += replayEvents;
      totals.replay = sumUsage([totals.replay, replay]);
      if (replayEvents > 0) {
        replayUsageByRevision.set(String(child.current_revision), childUsage.slice(0, replayEvents));
      }
      if (replayEvents > 0) totals.exactReplaySessions += 1;
      else totals.noReplaySessions += 1;
      details.push({
        revision: String(child.current_revision),
        childId: child.meta.id,
        parentId: child.meta.parentId,
        depth: child.meta.depth,
        nickname: child.meta.nickname,
        role: child.meta.role,
        status: replayEvents > 0 ? "exact_prefix_replay" : "no_replay",
        childEvents: childUsage.length,
        parentEvents: parentUsage.length,
        replayEvents,
        replayParentOffset: replayEvents > 0 ? match.parentOffset : undefined,
        replayShare: childUsage.length > 0 ? replayEvents / childUsage.length : 0,
        replayTokens: replay.totalTokens,
        childRawTokens: childTotal.totalTokens,
      });
      if ((index + 1) % 25 === 0) console.error(`analysed ${index + 1}/${children.length} subagents`);
    }
    details.sort((a, b) => number(b.replayTokens) - number(a.replayTokens));
    return { generatedAt: new Date().toISOString(), totals, details, replayUsageByRevision };
}

function usageVectorFromEvent(event: Record<string, unknown>): UsageVector {
  return {
    inputTokens: number(event.inputTokens),
    cachedInputTokens: number(event.cachedInputTokens),
    outputTokens: number(event.outputTokens),
    reasoningOutputTokens: number(event.reasoningOutputTokens),
    totalTokens: number(event.inputTokens) + number(event.outputTokens),
    totalTokensReported: number(event.totalTokensReported),
  };
}

export async function mapCodexReplayToMessages(
  db: Surreal,
  replayUsageByRevision: ReadonlyMap<string, readonly UsageVector[]>,
): Promise<{
  deductions: Map<string, UsageVector>;
  mappedReplay: UsageVector;
  mappedEvents: number;
  mappedRevisions: number;
}> {
  const deductions = new Map<string, UsageVector>();
  let mappedReplay = sumUsage([]);
  let mappedEvents = 0;
  const mappedRevisions = new Set<string>();
  const revisions = [...replayUsageByRevision.keys()];
  for (let offset = 0; offset < revisions.length; offset += 50) {
    const batch = revisions.slice(offset, offset + 50);
    const rows = await selectAll<UsageMessageRow>(
      db,
      `SELECT id, dialogue_revision, sequence, raw_usage_events
       FROM message
       WHERE string::concat(dialogue_revision) INSIDE $revisions
         AND raw_usage_events IS NOT NONE
       ORDER BY dialogue_revision, sequence`,
      { revisions: batch },
    );
    const positions = new Map<string, number>();
    const lastMatchedKey = new Map<string, string>();
    for (const row of rows) {
      const revision = String(row.dialogue_revision);
      const expected = replayUsageByRevision.get(revision);
      if (!expected) continue;
      let position = positions.get(revision) ?? 0;
      let deduction = sumUsage([]);
      for (const event of row.raw_usage_events ?? []) {
        if (position >= expected.length || event.scope !== "request") continue;
        const actual = usageVectorFromEvent(event);
        const actualKey = usageKey(actual);
        // Stale canonical (до parser_version 8) хранит rate-limit bucket-копии:
        // копия идёт сразу за оригиналом и идентична ему. Вычитаем её тоже,
        // но позицию матчинга НЕ двигаем — иначе копия может ложно
        // сматчиться с более поздним expected-событием. После репарса
        // этот fallback становится no-op.
        if (actualKey === lastMatchedKey.get(revision)) {
          deduction = sumUsage([deduction, actual]);
          mappedReplay = sumUsage([mappedReplay, actual]);
          mappedEvents += 1;
          continue;
        }
        let match = position;
        while (match < expected.length && !sameUsage(actual, expected[match]!)) match += 1;
        if (match >= expected.length) {
          // Первый canonical request после raw replay prefix — собственная работа child.
          position = expected.length;
          continue;
        }
        deduction = sumUsage([deduction, actual]);
        mappedReplay = sumUsage([mappedReplay, actual]);
        mappedEvents += 1;
        mappedRevisions.add(revision);
        position = match + 1;
        lastMatchedKey.set(revision, actualKey);
      }
      positions.set(revision, position);
      if (deduction.totalTokens > 0) deductions.set(String(row.id), deduction);
    }
  }
  return { deductions, mappedReplay, mappedEvents, mappedRevisions: mappedRevisions.size };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = await connectDb(cfg);
  try {
    const result = await analyzeCodexLineage(db, cfg.archiveRoot);
    const { replayUsageByRevision: _internal, ...serializable } = result;
    console.log(JSON.stringify(serializable, null, 2));
  } finally {
    await db.close();
  }
}

if (import.meta.main) await main();
