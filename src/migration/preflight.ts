/**
 * Preflight migration report (docs/plan.md §15.2, этап 9).
 *
 * Работает ТОЛЬКО со snapshot-копией legacy index.sqlite (§15.3,
 * src/migration/legacy-snapshot.ts) — оригинал никогда не открывается.
 * Ничего не изменяет ни в legacy, ни в SurrealDB: все запросы read-only.
 *
 * Классификация каждого legacy-диалога (threads) по приоритету
 * восстановления §15.4:
 *   from_raw      — все source files диалога имеют raw backup, файл на диске
 *                   и НИ один thread_record не оборван (source_file_id NULL);
 *   from_payload  — все thread_records диалога имеют валидный JSON payload;
 *   from_normalized — есть нормализованные messages/message_chunks;
 *   quarantined   — ничего из перечисленного (§15.9: с record ID и причиной).
 *
 * Reconciliation (§15.9 «ни одна исходная строка не потеряна») ведётся
 * ПОСТРОЧНО по всем legacy-таблицам: для каждой таблицы total (COUNT(*))
 * сопоставляется с числом строк, реально увиденных анализом — штатно
 * (классификация, агрегации) или через запись в problems (orphan,
 * quarantine, missing file). ok = true только когда accounted == legacyTotal,
 * т.е. lost == 0 по каждой таблице; бесшумное отсечение строк (например,
 * INNER JOIN'ом) даёт lost > 0 и ok = false.
 *
 * Анализ большого snapshot'а (json_valid по всем payload) может быть долгим,
 * поэтому результат кэшируется в checkpoint-файл,
 * ключованный SHA-256 snapshot'а (saveAnalysisCheckpoint). Повторный запуск
 * с тем же snapshot'ом читает checkpoint и повторяет только дешёвый live
 * probe против SurrealDB — он зависит от текущего состояния корпуса и
 * никогда не кэшируется.
 */

import { Database } from "bun:sqlite";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb } from "../db/client.ts";
import { selectAll } from "../db/repositories/helpers.ts";
import type { LocalIdentity } from "../sync/host-identity.ts";

/** Таблицы плана §15.5 — фактическое соответствие фиксируется в отчёте. */
const EXPECTED_TABLES = [
  "agent_systems",
  "projects",
  "source_files",
  "raw_backups",
  "threads",
  "thread_records",
  "messages",
  "message_chunks",
] as const;

/**
 * Проблемная строка (§15.9): таблица, primary key, причина.
 * Raw payload, parser version и retry-механизм quarantine-записей —
 * зона этапа 10 (migration run); preflight-отчёт только фиксирует scope
 * проблемы, чтобы ни одна строка не потерялась бесшумно.
 */
export interface PreflightProblem {
  table: string;
  recordId: string;
  reason: string;
}

/** Построчный учёт одной legacy-таблицы (§15.9). */
export interface TableReconciliation {
  /** COUNT(*) таблицы в snapshot'е. */
  total: number;
  /**
   * Строки, реально увиденные анализом: штатная классификация/агрегация
   * плюс orphan-строки, перечисленные в problems с record ID.
   */
  accounted: number;
  /** Из accounted — строки с записью в problems. */
  withProblems: number;
  /** total - accounted; > 0 означает бесшумную потерю строк. */
  lost: number;
}

export interface LiveCorpusProbe {
  available: boolean;
  note?: string;
  /** sha256 всех source_revision живого корпуса. */
  revisionSha256: Set<string>;
  /** "<harness-slug>:<external_id>" всех dialogue живого корпуса. */
  dialogueKeys: Set<string>;
}

/**
 * Результат анализа snapshot'а — всё, что детерминированно выводится из
 * legacy-копии (кэшируется в checkpoint). Сверка с live корпусом сюда не
 * входит: она зависит от текущего состояния SurrealDB.
 */
export interface LegacyAnalysis {
  formatVersion: 2;
  snapshotSha256?: string;
  checkRawFiles: boolean;
  schema: PreflightReport["schema"];
  counts: PreflightReport["counts"];
  payload: PreflightReport["payload"];
  reconstructable: PreflightReport["reconstructable"];
  deletedInSource: number;
  missingRawBackup: PreflightReport["missingRawBackup"];
  withinLegacy: PreflightReport["duplicates"]["withinLegacy"];
  hostMapping: PreflightReport["hostMapping"];
  reconciliation: PreflightReport["reconciliation"];
  problems: PreflightProblem[];
  /** Вход для сверки с live (в итоговый отчёт не попадает): id → sha256. */
  sourceFileSha256: Record<string, string>;
  /** Вход для сверки с live: "<slug>:<external_id>" каждого диалога. */
  threadKeys: string[];
}

export interface PreflightReport {
  createdAt: string;
  snapshotPath: string;
  snapshotSha256?: string;
  schema: {
    tables: string[];
    /** соответствие таблиц плану §15.5: expected → присутствует */
    expected: Record<string, boolean>;
    /** таблицы, которых нет в плане (sync_runs, FTS и т.п.) */
    extra: string[];
  };
  counts: {
    sourceFiles: number;
    rawBackups: number;
    dialogues: number;
    messages: number;
    chunks: number;
    threadRecords: number;
  };
  payload: {
    present: number;
    missing: number;
    validJson: number;
    invalidJson: number;
    /** диалоги, где ВСЕ thread_records имеют валидный payload */
    threadsFullyCovered: number;
    threadsPartiallyCovered: number;
    /** включая диалоги вообще без thread_records */
    threadsUncovered: number;
    /** ответ на ключевой вопрос §15.2: покрывает ли payload все диалоги */
    coversAllDialogues: boolean;
  };
  reconstructable: {
    fromRaw: number;
    fromPayload: number;
    onlyNormalized: number;
    quarantined: number;
  };
  deletedInSource: number;
  missingRawBackup: {
    /** source_files без записи raw_backups */
    withoutBackupRow: number;
    /** raw_backups, чей файл отсутствует на диске */
    fileMissingOnDisk: number;
  };
  duplicates: {
    withinLegacy: {
      duplicateSha256Groups: number;
      affectedSourceFiles: number;
      affectedThreads: number;
      examples: Array<{ sha256: string; sourceFileIds: number[] }>;
    };
    vsLiveCorpus: {
      available: boolean;
      note?: string;
      /** legacy source_files, чей sha256 уже есть в live source_revision */
      revisionsMatched: number;
      /** legacy threads, чей (harness, external_id) уже есть в live dialogue */
      dialoguesMatched: number;
      examples: string[];
    };
  };
  hostMapping: {
    /** original_path однозначно принадлежит текущему host (под homePath) */
    currentHost: number;
    /** host:legacy-<fingerprint> → количество source_files (§15.6 п.3) */
    legacyHosts: Record<string, number>;
    /** пути, не относимые ни к одному home уверенно (§15.6 п.4) */
    uncertain: Record<string, number>;
    note: string;
  };
  /**
   * §15.9: ok = true только когда КАЖДАЯ строка каждой legacy-таблицы
   * учтена (accounted == legacyTotal, lost == 0 по всем таблицам).
   */
  reconciliation: {
    /** Полное число legacy rows по всем таблицам (до всякой фильтрации). */
    legacyTotal: number;
    accounted: number;
    lost: number;
    ok: boolean;
    tables: Record<string, TableReconciliation>;
  };
  problems: PreflightProblem[];
}

export interface PreflightOptions {
  snapshotPath: string;
  snapshotSha256?: string;
  /** Текущая машина — для host mapping preview (§15.6). */
  identity: LocalIdentity;
  /** Probe живого корпуса; undefined — секция vsLiveCorpus помечается unavailable. */
  live?: LiveCorpusProbe;
  /** Проверять существование raw backup файлов на диске (default true). */
  checkRawFiles?: boolean;
  /**
   * Готовый анализ (из checkpoint) — скан snapshot'а пропускается.
   * Должен соответствовать snapshotSha256 и checkRawFiles.
   */
  analysis?: LegacyAnalysis;
}

/** Read-only probe живого корпуса: sha256 ревизий и (harness, external_id) диалогов. */
export async function probeLiveCorpus(cfg: AppConfig): Promise<LiveCorpusProbe> {
  const probe: LiveCorpusProbe = {
    available: false,
    revisionSha256: new Set(),
    dialogueKeys: new Set(),
  };
  let db: Surreal;
  try {
    db = await connectDb(cfg);
  } catch (err) {
    probe.note = `SurrealDB недоступен: ${err instanceof Error ? err.message : err}`;
    return probe;
  }
  try {
    const revisions = await selectAll<{ sha256: string }>(
      db,
      `SELECT sha256 FROM source_revision`,
    );
    for (const row of revisions) probe.revisionSha256.add(row.sha256);
    const dialogues = await selectAll<{ external_id: string; harness: string | null }>(
      db,
      `SELECT external_id, harness_installation.harness.slug AS harness
       FROM dialogue WHERE external_id IS NOT NONE`,
    );
    for (const row of dialogues) {
      probe.dialogueKeys.add(`${row.harness ?? "?"}:${row.external_id}`);
    }
    probe.available = true;
    probe.note = `live corpus: ${revisions.length} source_revision, ${dialogues.length} dialogue с external_id`;
  } catch (err) {
    probe.note = `запрос к SurrealDB не удался: ${err instanceof Error ? err.message : err}`;
  } finally {
    await db.close();
  }
  return probe;
}

/** Fingerprint префикса пути для host:legacy-<fingerprint> (§15.6 п.3). */
function legacyHostFingerprint(prefix: string): string {
  return createHash("sha256").update(prefix).digest("hex").slice(0, 12);
}

/**
 * Префикс, идентифицирующий машину/аккаунт: /Users/<name> для macOS-home,
 * иначе первые два сегмента ("/Volumes/X", "/home/u" и т.п.).
 */
function pathPrefix(p: string): string {
  const users = p.match(/^\/Users\/[^/]+/);
  if (users) return users[0];
  const parts = p.split("/").filter((s) => s.length > 0);
  return `/${parts.slice(0, 2).join("/")}`;
}

function count(db: Database, table: string): number {
  const row = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table}`).get();
  return row?.c ?? 0;
}

/**
 * Учёт строк одной таблицы (§15.9): seen — сколько строк анализ реально
 * наблюдал (штатная классификация/агрегация + orphan-строки, увиденные
 * при построении problems). lost = total - seen — бесшумная потеря.
 */
function tableRecon(total: number, seen: number, withProblems: number): TableReconciliation {
  return { total, accounted: seen, withProblems, lost: total - seen };
}

/**
 * Полный анализ snapshot'а (единственная тяжёлая часть preflight):
 * сканы legacy SQLite + stat raw backup файлов. Результат детерминирован
 * относительно содержимого snapshot'а — кэшируется checkpoint'ом.
 */
export async function analyzeLegacySnapshot(
  snapshotPath: string,
  identity: LocalIdentity,
  options: { snapshotSha256?: string; checkRawFiles?: boolean } = {},
): Promise<LegacyAnalysis> {
  const checkRawFiles = options.checkRawFiles ?? true;
  const problems: PreflightProblem[] = [];
  const db = new Database(snapshotPath, { readonly: true });
  try {
    db.run("pragma query_only = on");

    // --- Схема: фактическое соответствие плану §15.5 ---
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    const tableSet = new Set(tables);
    for (const t of EXPECTED_TABLES) {
      if (!tableSet.has(t)) throw new Error(`в snapshot нет таблицы ${t} — схема не legacy`);
    }
    const expected: Record<string, boolean> = {};
    for (const t of EXPECTED_TABLES) expected[t] = tableSet.has(t);
    const extra = tables.filter(
      (t) => !(EXPECTED_TABLES as readonly string[]).includes(t) && !t.startsWith("message_search"),
    );

    // --- agent_systems: slug для dedup-ключей + родитель orphan-проверок ---
    const agentRows = db
      .query<{ id: number; slug: string }, []>(`SELECT id, slug FROM agent_systems`)
      .all();
    const agentSlugById = new Map(agentRows.map((r) => [r.id, r.slug]));

    // --- projects: orphan agent_id ---
    const projectRows = db
      .query<{ id: number; agent_id: number }, []>(`SELECT id, agent_id FROM projects`)
      .all();
    const projectProblems = new Set<number>();
    for (const p of projectRows) {
      if (!agentSlugById.has(p.agent_id)) {
        projectProblems.add(p.id);
        problems.push({
          table: "projects",
          recordId: String(p.id),
          reason: `agent_id=${p.agent_id} отсутствует в agent_systems (orphan project)`,
        });
      }
    }

    // --- Диалоги: LEFT JOIN-семантика — тред с битым agent_id НЕ теряется ---
    const threads = db
      .query<{ id: number; external_id: string; agent_id: number }, []>(
        `SELECT id, external_id, agent_id FROM threads`,
      )
      .all()
      .map((t) => ({ ...t, slug: agentSlugById.get(t.agent_id) ?? null }));
    const threadById = new Map(threads.map((t) => [t.id, t]));
    const threadProblems = new Set<number>();
    for (const t of threads) {
      if (t.slug === null) {
        threadProblems.add(t.id);
        problems.push({
          table: "threads",
          recordId: String(t.id),
          reason: `agent_id=${t.agent_id} отсутствует в agent_systems (orphan thread, harness неизвестен)`,
        });
      }
    }

    // --- Один проход по thread_records: payload coverage + привязка к source files ---
    const coverage = db
      .query<
        {
          thread_id: number;
          total: number;
          present: number;
          valid: number;
          files_with_backup: number;
          files_total: number;
          null_file: number;
        },
        []
      >(
        `SELECT tr.thread_id,
                COUNT(*) AS total,
                SUM(CASE WHEN length(COALESCE(tr.payload, '')) > 0 THEN 1 ELSE 0 END) AS present,
                SUM(CASE WHEN length(COALESCE(tr.payload, '')) > 0
                          AND json_valid(tr.payload) THEN 1 ELSE 0 END) AS valid,
                COUNT(DISTINCT tr.source_file_id) AS files_total,
                COUNT(DISTINCT CASE WHEN rb.id IS NOT NULL THEN tr.source_file_id END) AS files_with_backup,
                SUM(CASE WHEN tr.source_file_id IS NULL THEN 1 ELSE 0 END) AS null_file
         FROM thread_records tr
         LEFT JOIN raw_backups rb ON rb.source_file_id = tr.source_file_id
         GROUP BY tr.thread_id`,
      )
      .all();

    const coverageByThread = new Map<number, (typeof coverage)[number]>();
    let payloadPresent = 0;
    let payloadValid = 0;
    let threadRecordsTotal = 0;
    let orphanRecordRows = 0; // строки thread_records с thread_id вне threads
    for (const row of coverage) {
      threadRecordsTotal += row.total;
      payloadPresent += row.present;
      payloadValid += row.valid;
      if (!threadById.has(row.thread_id)) orphanRecordRows += row.total;
      coverageByThread.set(row.thread_id, row);
    }
    // Orphan thread_records — каждая строка с record ID (§15.9)
    const recordProblems = new Set<number>();
    for (const row of db
      .query<{ id: number }, []>(
        `SELECT tr.id FROM thread_records tr
         LEFT JOIN threads t ON t.id = tr.thread_id WHERE t.id IS NULL`,
      )
      .all()) {
      recordProblems.add(row.id);
      problems.push({
        table: "thread_records",
        recordId: String(row.id),
        reason: "thread_id отсутствует в threads (orphan record)",
      });
    }

    // --- Raw backup файлы на диске (один stat на уникальный archive_path) ---
    const backupPaths = db
      .query<{ id: number; source_file_id: number; archive_path: string }, []>(
        `SELECT id, source_file_id, archive_path FROM raw_backups`,
      )
      .all();
    const sourceFileIds = new Set(
      db.query<{ id: number }, []>(`SELECT id FROM source_files`).all().map((r) => r.id),
    );
    const backupProblems = new Set<number>();
    const fileExists = new Map<string, boolean>();
    const backupFileOk = new Map<number, boolean>(); // source_file_id → файл есть
    if (checkRawFiles) {
      for (const rb of backupPaths) {
        let ok = fileExists.get(rb.archive_path);
        if (ok === undefined) {
          try {
            await stat(rb.archive_path);
            ok = true;
          } catch {
            ok = false;
          }
          fileExists.set(rb.archive_path, ok);
        }
        backupFileOk.set(rb.source_file_id, ok);
        if (!ok) {
          backupProblems.add(rb.id);
          problems.push({
            table: "raw_backups",
            recordId: String(rb.id),
            reason: `raw backup файл отсутствует на диске: ${rb.archive_path}`,
          });
        }
      }
    } else {
      for (const rb of backupPaths) backupFileOk.set(rb.source_file_id, true);
    }
    // raw_backups на несуществующий source_file — orphan с record ID
    for (const rb of backupPaths) {
      if (!sourceFileIds.has(rb.source_file_id)) {
        backupProblems.add(rb.id);
        problems.push({
          table: "raw_backups",
          recordId: String(rb.id),
          reason: `source_file_id=${rb.source_file_id} отсутствует в source_files (orphan raw backup)`,
        });
      }
    }
    const backupOkByFile = new Map<number, boolean>();
    for (const rb of backupPaths) {
      backupOkByFile.set(rb.source_file_id, backupFileOk.get(rb.source_file_id) ?? false);
    }

    // source_file → raw backup ok (для классификации from_raw нужны файлы каждого треда)
    const threadFiles = db
      .query<{ thread_id: number; source_file_id: number }, []>(
        `SELECT DISTINCT thread_id, source_file_id FROM thread_records WHERE source_file_id IS NOT NULL`,
      )
      .all();
    const filesByThread = new Map<number, number[]>();
    for (const row of threadFiles) {
      const list = filesByThread.get(row.thread_id) ?? [];
      list.push(row.source_file_id);
      filesByThread.set(row.thread_id, list);
    }

    // --- Нормализованные сообщения + orphan-учёт ---
    const messagesByThread = new Map<number, number>();
    let messagesTotal = 0;
    let orphanMessageRows = 0;
    for (const row of db
      .query<{ thread_id: number; c: number }, []>(
        `SELECT thread_id, COUNT(*) AS c FROM messages GROUP BY thread_id`,
      )
      .all()) {
      messagesByThread.set(row.thread_id, row.c);
      messagesTotal += row.c;
      if (!threadById.has(row.thread_id)) orphanMessageRows += row.c;
    }
    const messageProblems = new Set<number>();
    for (const row of db
      .query<{ id: number }, []>(
        `SELECT m.id FROM messages m
         LEFT JOIN threads t ON t.id = m.thread_id WHERE t.id IS NULL`,
      )
      .all()) {
      messageProblems.add(row.id);
      problems.push({
        table: "messages",
        recordId: String(row.id),
        reason: "thread_id отсутствует в threads (orphan message)",
      });
    }

    // --- message_chunks: orphan message_id ---
    const chunksTotal = count(db, "message_chunks");
    const orphanChunkRows =
      db
        .query<{ n: number }, []>(
          `SELECT COALESCE(SUM(c), 0) AS n FROM (
             SELECT message_id, COUNT(*) AS c FROM message_chunks GROUP BY message_id
           ) WHERE message_id NOT IN (SELECT id FROM messages)`,
        )
        .get()?.n ?? 0;
    const chunkProblems = new Set<number>();
    for (const row of db
      .query<{ id: number }, []>(
        `SELECT mc.id FROM message_chunks mc
         LEFT JOIN messages m ON m.id = mc.message_id WHERE m.id IS NULL`,
      )
      .all()) {
      chunkProblems.add(row.id);
      problems.push({
        table: "message_chunks",
        recordId: String(row.id),
        reason: "message_id отсутствует в messages (orphan chunk)",
      });
    }

    // --- Классификация диалогов (приоритет §15.4) ---
    let fromRaw = 0;
    let fromPayload = 0;
    let onlyNormalized = 0;
    let quarantined = 0;
    let threadsFullyCovered = 0;
    let threadsPartiallyCovered = 0;
    let threadsUncovered = 0;
    for (const thread of threads) {
      const cov = coverageByThread.get(thread.id);
      if (cov) {
        if (cov.valid === cov.total) threadsFullyCovered += 1;
        else if (cov.valid > 0) threadsPartiallyCovered += 1;
        else threadsUncovered += 1;
      } else {
        // тред вообще без thread_records — тоже без payload-покрытия
        threadsUncovered += 1;
      }
      const files = filesByThread.get(thread.id) ?? [];
      // null_file (thread_record без source_file_id) разрывает связь
      // тред → raw backup: такой тред НЕ полностью восстанавливается из raw.
      const rawOk =
        cov !== undefined &&
        cov.null_file === 0 &&
        files.length > 0 &&
        files.every((f) => backupOkByFile.get(f) === true);
      if (rawOk) {
        fromRaw += 1;
      } else if (cov && cov.total > 0 && cov.valid === cov.total) {
        fromPayload += 1;
      } else if ((messagesByThread.get(thread.id) ?? 0) > 0) {
        onlyNormalized += 1;
      } else {
        quarantined += 1;
        threadProblems.add(thread.id);
        const reason = !cov
          ? "нет thread_records и нет messages"
          : "raw backup неполон, payload невалиден/отсутствует, messages нет";
        problems.push({
          table: "threads",
          recordId: String(thread.id),
          reason: `quarantine: ${reason}`,
        });
      }
    }

    // --- deleted_in_source (фактическое число из snapshot, §15.8) ---
    const deletedInSource = db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM source_files
         WHERE status = 'deleted_in_source' OR deleted_at IS NOT NULL`,
      )
      .get()?.c ?? 0;

    // --- source_files без raw_backups ---
    const sourceFileProblems = new Set<number>();
    const withoutBackup = db
      .query<{ id: number }, []>(
        `SELECT sf.id FROM source_files sf
         LEFT JOIN raw_backups rb ON rb.source_file_id = sf.id
         WHERE rb.id IS NULL`,
      )
      .all();
    for (const row of withoutBackup) {
      sourceFileProblems.add(row.id);
      problems.push({
        table: "source_files",
        recordId: String(row.id),
        reason: "нет записи raw_backups (missing raw backup)",
      });
    }

    // --- Дубликаты внутри legacy: одинаковый sha256 у разных source_files ---
    const dupGroups = db
      .query<{ sha256: string; ids: string }, []>(
        `SELECT sha256, GROUP_CONCAT(id) AS ids FROM source_files
         GROUP BY sha256 HAVING COUNT(*) > 1 ORDER BY sha256`,
      )
      .all();
    const dupFileIds = dupGroups.flatMap((g) => g.ids.split(",").map(Number));
    let affectedThreads = 0;
    if (dupFileIds.length > 0) {
      affectedThreads =
        db
          .query<{ c: number }, []>(
            `SELECT COUNT(DISTINCT thread_id) AS c FROM thread_records
             WHERE source_file_id IN (
               SELECT id FROM source_files WHERE sha256 IN (
                 SELECT sha256 FROM source_files GROUP BY sha256 HAVING COUNT(*) > 1))`,
          )
          .get()?.c ?? 0;
    }

    // --- Host mapping preview (§15.6) ---
    let currentHost = 0;
    const legacyHosts = new Map<string, number>();
    const uncertain = new Map<string, number>();
    const homePrefix = identity.homePath.endsWith(path.sep)
      ? identity.homePath
      : identity.homePath + path.sep;
    const sourceFileSha256: Record<string, string> = {};
    for (const row of db
      .query<{ id: number; original_path: string; sha256: string }, []>(
        `SELECT id, original_path, sha256 FROM source_files`,
      )
      .all()) {
      sourceFileSha256[String(row.id)] = row.sha256;
      const p = row.original_path;
      if (p.startsWith(homePrefix)) {
        currentHost += 1;
        continue;
      }
      const prefix = pathPrefix(p);
      if (/^\/Users\/[^/]+$/.test(prefix) || /^\/home\/[^/]+$/.test(prefix)) {
        const key = `legacy-${legacyHostFingerprint(prefix)}`;
        legacyHosts.set(key, (legacyHosts.get(key) ?? 0) + 1);
      } else {
        // Не похоже на home-каталог — однозначно не атрибутируется (§15.6 п.4).
        uncertain.set(prefix, (uncertain.get(prefix) ?? 0) + 1);
      }
    }

    // --- Reconciliation §15.9: построчный учёт по ВСЕМ legacy-таблицам ---
    const reconTables: Record<string, TableReconciliation> = {
      agent_systems: tableRecon(count(db, "agent_systems"), agentRows.length, 0),
      projects: tableRecon(count(db, "projects"), projectRows.length, projectProblems.size),
      source_files: tableRecon(
        count(db, "source_files"),
        Object.keys(sourceFileSha256).length,
        sourceFileProblems.size,
      ),
      raw_backups: tableRecon(count(db, "raw_backups"), backupPaths.length, backupProblems.size),
      threads: tableRecon(count(db, "threads"), threads.length, threadProblems.size),
      thread_records: tableRecon(
        count(db, "thread_records"),
        threadRecordsTotal - orphanRecordRows + recordProblems.size,
        recordProblems.size,
      ),
      messages: tableRecon(
        count(db, "messages"),
        messagesTotal - orphanMessageRows + messageProblems.size,
        messageProblems.size,
      ),
      message_chunks: tableRecon(
        chunksTotal,
        chunksTotal - orphanChunkRows + chunkProblems.size,
        chunkProblems.size,
      ),
    };
    let legacyTotal = 0;
    let accounted = 0;
    let lost = 0;
    for (const t of Object.values(reconTables)) {
      legacyTotal += t.total;
      accounted += t.accounted;
      lost += t.lost;
    }

    return {
      formatVersion: 2,
      snapshotSha256: options.snapshotSha256,
      checkRawFiles,
      schema: { tables, expected, extra },
      counts: {
        sourceFiles: count(db, "source_files"),
        rawBackups: count(db, "raw_backups"),
        dialogues: threads.length,
        messages: messagesTotal,
        chunks: chunksTotal,
        threadRecords: threadRecordsTotal,
      },
      payload: {
        present: payloadPresent,
        missing: threadRecordsTotal - payloadPresent,
        validJson: payloadValid,
        invalidJson: payloadPresent - payloadValid,
        threadsFullyCovered,
        threadsPartiallyCovered,
        threadsUncovered,
        coversAllDialogues:
          threadsFullyCovered === threads.length && threadsUncovered === 0,
      },
      reconstructable: {
        fromRaw,
        fromPayload,
        onlyNormalized,
        quarantined,
      },
      deletedInSource,
      missingRawBackup: {
        withoutBackupRow: withoutBackup.length,
        fileMissingOnDisk: checkRawFiles
          ? [...fileExists.values()].filter((ok) => !ok).length
          : 0,
      },
      withinLegacy: {
        duplicateSha256Groups: dupGroups.length,
        affectedSourceFiles: dupFileIds.length,
        affectedThreads,
        examples: dupGroups.slice(0, 20).map((g) => ({
          sha256: g.sha256,
          sourceFileIds: g.ids.split(",").map(Number),
        })),
      },
      hostMapping: {
        currentHost,
        legacyHosts: Object.fromEntries([...legacyHosts.entries()].sort()),
        uncertain: Object.fromEntries([...uncertain.entries()].sort()),
        note: "legacy metadata не содержит идентификатора машины (§15.6 п.2 неприменим): атрибуция только по original_path",
      },
      reconciliation: { legacyTotal, accounted, lost, ok: lost === 0, tables: reconTables },
      problems,
      sourceFileSha256,
      threadKeys: threads.map((t) => `${t.slug ?? "?"}:${t.external_id}`),
    };
  } finally {
    db.close();
  }
}

/** Сборка итогового отчёта: анализ snapshot'а + свежий live probe. */
export async function buildPreflightReport(opts: PreflightOptions): Promise<PreflightReport> {
  const analysis =
    opts.analysis ??
    (await analyzeLegacySnapshot(opts.snapshotPath, opts.identity, {
      snapshotSha256: opts.snapshotSha256,
      checkRawFiles: opts.checkRawFiles,
    }));

  // --- Дубликаты против живого корпуса (read-only probe, не кэшируется) ---
  const live = opts.live;
  let revisionsMatched = 0;
  let dialoguesMatched = 0;
  const liveExamples: string[] = [];
  if (live?.available) {
    for (const [id, sha256] of Object.entries(analysis.sourceFileSha256)) {
      if (live.revisionSha256.has(sha256)) {
        revisionsMatched += 1;
        if (liveExamples.length < 20) {
          liveExamples.push(`source_files:${id} sha256=${sha256.slice(0, 12)}…`);
        }
      }
    }
    for (const key of analysis.threadKeys) {
      if (live.dialogueKeys.has(key)) dialoguesMatched += 1;
    }
  }

  return {
    createdAt: new Date().toISOString(),
    snapshotPath: opts.snapshotPath,
    snapshotSha256: opts.snapshotSha256 ?? analysis.snapshotSha256,
    schema: analysis.schema,
    counts: analysis.counts,
    payload: analysis.payload,
    reconstructable: analysis.reconstructable,
    deletedInSource: analysis.deletedInSource,
    missingRawBackup: analysis.missingRawBackup,
    duplicates: {
      withinLegacy: analysis.withinLegacy,
      vsLiveCorpus: {
        available: live?.available ?? false,
        note: live?.note ?? "probe не запрашивался",
        revisionsMatched,
        dialoguesMatched,
        examples: liveExamples,
      },
    },
    hostMapping: analysis.hostMapping,
    reconciliation: analysis.reconciliation,
    problems: analysis.problems,
  };
}

// --- Checkpoint анализа: повторный запуск не повторяет сканы snapshot'а ---

/** Путь checkpoint-файла для snapshot'а с данным SHA-256. */
export function analysisCheckpointPath(dir: string, snapshotSha256: string): string {
  return path.join(dir, `preflight-analysis__${snapshotSha256}.json`);
}

/** Сохраняет анализ в checkpoint (атомарно: tmp + rename). */
export async function saveAnalysisCheckpoint(
  filePath: string,
  analysis: LegacyAnalysis,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(analysis)}\n`);
  await rename(tmp, filePath);
}

/**
 * Читает checkpoint, если он соответствует snapshot'у (sha256 + checkRawFiles
 * + formatVersion). Несоответствие/повреждение → null (пересчёт с нуля).
 */
export async function loadAnalysisCheckpoint(
  filePath: string,
  snapshotSha256: string,
  checkRawFiles: boolean,
): Promise<LegacyAnalysis | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as LegacyAnalysis;
    if (parsed.formatVersion !== 2) return null;
    if (parsed.snapshotSha256 !== snapshotSha256) return null;
    if (parsed.checkRawFiles !== checkRawFiles) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Консольный summary отчёта (полные списки — в JSON). */
export function formatPreflightSummary(report: PreflightReport): string {
  const lines: string[] = [];
  const p = (label: string, value: number | string | boolean) =>
    lines.push(`${label}: ${value}`);
  p("snapshot", report.snapshotPath);
  p("legacy source files", report.counts.sourceFiles);
  p("legacy raw backups", report.counts.rawBackups);
  p("legacy dialogues", report.counts.dialogues);
  p("legacy messages", report.counts.messages);
  p("legacy chunks", report.counts.chunks);
  p("thread_records rows", report.counts.threadRecords);
  p("payload present", report.payload.present);
  p("payload missing", report.payload.missing);
  p("valid JSON payload", report.payload.validJson);
  p("invalid JSON payload", report.payload.invalidJson);
  p(
    "payload coverage по диалогам",
    `полное ${report.payload.threadsFullyCovered}, частичное ${report.payload.threadsPartiallyCovered}, нет ${report.payload.threadsUncovered}`,
  );
  p("payload покрывает все диалоги", report.payload.coversAllDialogues ? "да" : "НЕТ");
  p("reconstructable from raw", report.reconstructable.fromRaw);
  p("reconstructable from payload", report.reconstructable.fromPayload);
  p("reconstructable only from normalized", report.reconstructable.onlyNormalized);
  p("quarantined", report.reconstructable.quarantined);
  p("deleted_in_source", report.deletedInSource);
  p(
    "missing raw backup",
    `без записи ${report.missingRawBackup.withoutBackupRow}, файл отсутствует ${report.missingRawBackup.fileMissingOnDisk}`,
  );
  p(
    "potential duplicates (внутри legacy)",
    `${report.duplicates.withinLegacy.duplicateSha256Groups} групп sha256, файлов ${report.duplicates.withinLegacy.affectedSourceFiles}, диалогов ${report.duplicates.withinLegacy.affectedThreads}`,
  );
  const live = report.duplicates.vsLiveCorpus;
  p(
    "potential duplicates (против live)",
    live.available
      ? `revisions ${live.revisionsMatched}, dialogues ${live.dialoguesMatched}`
      : `пропущено (${live.note ?? "недоступно"})`,
  );
  p("host mapping: текущий host", report.hostMapping.currentHost);
  for (const [host, n] of Object.entries(report.hostMapping.legacyHosts)) {
    p(`host mapping: host:${host}`, n);
  }
  for (const [prefix, n] of Object.entries(report.hostMapping.uncertain)) {
    p(`host mapping: uncertain ${prefix}`, n);
  }
  const r = report.reconciliation;
  p(
    "reconciliation (§15.9)",
    `${r.legacyTotal} legacy rows = ${r.accounted} учтено + ${r.lost} потеряно → ${r.ok ? "ok" : "FAIL"}`,
  );
  for (const [table, tr] of Object.entries(r.tables)) {
    p(
      `  ${table}`,
      `total ${tr.total}, accounted ${tr.accounted}, problems ${tr.withProblems}, lost ${tr.lost}`,
    );
  }
  p("problems", report.problems.length);
  return lines.join("\n");
}
