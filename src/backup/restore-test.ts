/**
 * Restore drill (docs/plan.md §16.4) без второго контейнера:
 * импорт export'а в отдельный namespace `baka_restore_test` того же сервера,
 * проверка record counts против manifest'а, referential-инвариантов и
 * нескольких известных search-запросов, затем REMOVE NAMESPACE.
 *
 * Боевой namespace из конфига НИКОГДА не изменяется: импорт идёт только в
 * RESTORE_NAMESPACE, боевой используется лишь для чтения эталонных значений.
 */

import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb } from "../db/client.ts";
import { selectOne } from "../db/repositories/helpers.ts";
import {
  latestExportPath,
  manifestPathForExport,
  type BackupManifest,
} from "./backup.ts";
import { decompressFile } from "./compress.ts";
import { httpBaseUrl, httpHeaders, sqlRoot } from "./http.ts";

export const RESTORE_NAMESPACE = "baka_restore_test";

/** Известные запросы для smoke-проверки BM25 после импорта (§16.4 шаг 6). */
export const PROBE_QUERIES = ["baka", "sync", "ошибка"];

export interface RestoreCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RestoreTestReport {
  ok: boolean;
  exportFile: string;
  namespace: string;
  checks: RestoreCheck[];
}

async function removeRestoreNamespace(cfg: AppConfig): Promise<void> {
  await sqlRoot(cfg, `REMOVE NAMESPACE IF EXISTS ${RESTORE_NAMESPACE};`);
}

async function connectRestoreDb(cfg: AppConfig): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(cfg.surrealUrl);
  await db.signin({ username: cfg.surrealUser, password: cfg.surrealPass });
  await db.use({ namespace: RESTORE_NAMESPACE, database: cfg.surrealDatabase });
  return db;
}

/** count() по таблице; 0, если таблицы нет (пустой export без DEFINE TABLE). */
async function countOf(db: Surreal, table: string): Promise<number> {
  const row = await selectOne<{ n: number }>(
    db,
    `SELECT count() AS n FROM ${table} GROUP ALL`,
  );
  return row?.n ?? 0;
}

export async function runRestoreTest(
  cfg: AppConfig,
  options: { exportPath?: string } = {},
): Promise<RestoreTestReport> {
  if (cfg.surrealNamespace === RESTORE_NAMESPACE) {
    throw new Error(`боевой namespace не может быть ${RESTORE_NAMESPACE}`);
  }
  const exportPath = options.exportPath ?? (await latestExportPath(cfg.archiveRoot));
  const manifest: BackupManifest = JSON.parse(
    await readFile(manifestPathForExport(exportPath), "utf8"),
  );

  const checks: RestoreCheck[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const tmpExport = path.join(
    os.tmpdir(),
    `baka-restore-${process.pid}-${Date.now().toString(36)}.surql`,
  );
  // Защита от остатков прошлого упавшего drill'а — до импорта.
  await removeRestoreNamespace(cfg);
  try {
    await decompressFile(exportPath, tmpExport);

    // Тело — Bun.file (поток с диска), НЕ readFile в память: большой буфер
    // может оборвать upload, после чего сервер применит усечённый поток.
    const response = await fetch(`${httpBaseUrl(cfg)}/import`, {
      method: "POST",
      headers: httpHeaders(cfg, RESTORE_NAMESPACE, cfg.surrealDatabase),
      body: Bun.file(tmpExport),
    });
    if (!response.ok) {
      throw new Error(`import: HTTP ${response.status}: ${await response.text()}`);
    }

    const source = await connectDb(cfg);
    const restored = await connectRestoreDb(cfg);
    try {
      // 1. record counts против manifest'а
      let mismatches = 0;
      for (const [table, expected] of Object.entries(manifest.recordCounts)) {
        // SELECT по неопределённой таблице в 3.2.3 — ошибка, а не 0 строк:
        // неполный импорт фиксируем как failed check, а не исключение.
        let actual: number | null = null;
        try {
          actual = await countOf(restored, table);
        } catch {
          actual = null;
        }
        if (actual !== expected) {
          mismatches += 1;
          push(
            "record_counts",
            false,
            `${table}: manifest ${expected}, restored ${actual ?? "таблица отсутствует"}`,
          );
        }
      }
      if (mismatches === 0) {
        push(
          "record_counts",
          true,
          `${Object.keys(manifest.recordCounts).length} таблиц совпали с manifest'ом`,
        );
      }

      // 2. referential-инварианты: нарушений ровно столько же, сколько в боевой (ожидаем 0)
      const invariants: [string, string][] = [
        ["dialogue без current_revision", "SELECT count() AS n FROM dialogue WHERE current_revision IS NONE GROUP ALL"],
        ["message без dialogue_revision", "SELECT count() AS n FROM message WHERE dialogue_revision IS NONE GROUP ALL"],
        ["chunk без message", "SELECT count() AS n FROM chunk WHERE message IS NONE GROUP ALL"],
      ];
      for (const [name, sql] of invariants) {
        const inSource = (await selectOne<{ n: number }>(source, sql))?.n ?? 0;
        const inRestored = (await selectOne<{ n: number }>(restored, sql))?.n ?? 0;
        push(
          `invariant: ${name}`,
          inRestored === inSource,
          `source ${inSource}, restored ${inRestored}`,
        );
      }

      // 3. известные search-запросы: одинаковое число BM25-попаданий
      for (const query of PROBE_QUERIES) {
        const sql = "SELECT count() AS n FROM search_document WHERE content @0@ $q GROUP ALL";
        const vars = { q: query };
        const inSource = (await selectOne<{ n: number }>(source, sql, vars))?.n ?? 0;
        const inRestored = (await selectOne<{ n: number }>(restored, sql, vars))?.n ?? 0;
        push(
          `search: "${query}"`,
          inRestored === inSource,
          `source ${inSource} hits, restored ${inRestored} hits`,
        );
      }
    } finally {
      await source.close();
      await restored.close();
    }
  } finally {
    await rm(tmpExport, { force: true });
    await removeRestoreNamespace(cfg);
  }

  return {
    ok: checks.every((c) => c.ok),
    exportFile: path.basename(exportPath),
    namespace: RESTORE_NAMESPACE,
    checks,
  };
}
