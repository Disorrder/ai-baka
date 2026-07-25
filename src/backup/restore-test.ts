/**
 * Restore drill (docs/plan.md §16.4) без второго контейнера:
 * импорт export'а в отдельный namespace `baka_restore_test` того же сервера,
 * проверка record counts против manifest'а, referential-инвариантов,
 * нескольких известных search-запросов и raw references, затем
 * REMOVE NAMESPACE.
 *
 * До импорта проверяется целостность самого export'а (exportSha256/
 * exportBytes из manifest'а): битый архив в drill-ns не разливается.
 *
 * Referential-проверки — девиации «ноль в restored»: боевая база
 * приводится только как informational-справка, равенство с ней НЕ является
 * критерием (иначе drill сертифицировал бы некорректную базу).
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
import { hashFile } from "../sources/snapshot/hashing.ts";
import {
  latestExportPath,
  manifestPathForExport,
  type BackupManifest,
} from "./backup.ts";
import { decompressFile } from "./compress.ts";
import { httpBaseUrl, httpHeaders, sqlRoot } from "./http.ts";
import { buildRawManifest, hashRawManifest, verifyRawFiles } from "./raw-verify.ts";

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

/**
 * Dangling references (§16.4 шаг 5): каждая ссылка обязана указывать на
 * существующую запись; current_revision — на ready-ревизию этого же
 * dialogue. Restored обязан иметь НОЛЬ нарушений.
 */
const DANGLING_CHECKS: [string, string][] = [
  [
    "message.dialogue_revision → существующая revision",
    `SELECT count() AS n FROM message
     WHERE dialogue_revision IS NONE OR !record::exists(dialogue_revision) GROUP ALL`,
  ],
  [
    "chunk.message → существующий message",
    `SELECT count() AS n FROM chunk
     WHERE message IS NONE OR !record::exists(message) GROUP ALL`,
  ],
  [
    "dialogue.current_revision → ready revision этого dialogue",
    `SELECT count() AS n FROM dialogue
     WHERE current_revision IS NOT NONE
       AND (!record::exists(current_revision)
            OR current_revision.status != "ready"
            OR current_revision.dialogue != id)
     GROUP ALL`,
  ],
  [
    "dialogue_revision.dialogue → существующий dialogue",
    `SELECT count() AS n FROM dialogue_revision
     WHERE dialogue IS NONE OR !record::exists(dialogue) GROUP ALL`,
  ],
];

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

  // Целостность export'а — ДО импорта: несовпадение hash/размера = ошибка,
  // битый архив в drill-namespace не разливается.
  const exportHashes = await hashFile(exportPath);
  if (exportHashes.sha256 !== manifest.exportSha256) {
    throw new Error(
      `exportSha256 не совпадает: manifest ${manifest.exportSha256}, файл ${exportHashes.sha256}`,
    );
  }
  if (exportHashes.sizeBytes !== manifest.exportBytes) {
    throw new Error(
      `exportBytes не совпадает: manifest ${manifest.exportBytes}, файл ${exportHashes.sizeBytes}`,
    );
  }

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

      // 2. referential-инварианты: restored обязан иметь НОЛЬ нарушений;
      //    боевая база — отдельный informational отчёт, не критерий.
      for (const [name, sql] of DANGLING_CHECKS) {
        const inSource = (await selectOne<{ n: number }>(source, sql))?.n ?? 0;
        const inRestored = (await selectOne<{ n: number }>(restored, sql))?.n ?? 0;
        push(
          `invariant: ${name}`,
          inRestored === 0,
          `restored ${inRestored} нарушений (source: ${inSource}, informational)`,
        );
      }
      // Диалоги без current_revision — не referential-коррупция (revision
      // могла быть отклонена), поэтому только informational-сверка.
      const noCurrentSql = "SELECT count() AS n FROM dialogue WHERE current_revision IS NONE GROUP ALL";
      const noCurrentSource = (await selectOne<{ n: number }>(source, noCurrentSql))?.n ?? 0;
      const noCurrentRestored = (await selectOne<{ n: number }>(restored, noCurrentSql))?.n ?? 0;
      push(
        "info: dialogue без current_revision",
        noCurrentRestored === noCurrentSource,
        `source ${noCurrentSource}, restored ${noCurrentRestored}`,
      );

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

      // 4. raw references (§16.4 шаг 7): raw_archive_path восстановленных
      //    source_revision существуют на диске и совпадают по sha256
      //    (drill запускается на машине с тем же archive root). Raw
      //    manifest restored сверяется с manifest.rawManifestSha256,
      //    если поле есть (старые manifest'ы его не имеют).
      const rawManifest = await buildRawManifest(restored);
      const rawReport = await verifyRawFiles(cfg.archiveRoot, rawManifest);
      push(
        "raw references",
        rawReport.ok,
        rawReport.ok
          ? `${rawReport.checked}/${rawManifest.count} raw-файлов на диске, size+sha256 совпали`
          : `missing ${rawReport.missing.length}, size ${rawReport.sizeMismatch.length}, hash ${rawReport.hashMismatch.length} (первое: ${[...rawReport.missing, ...rawReport.sizeMismatch, ...rawReport.hashMismatch][0] ?? "?"})`,
      );
      if (manifest.rawManifestSha256) {
        const actualRawHash = hashRawManifest(rawManifest);
        push(
          "raw manifest hash",
          actualRawHash === manifest.rawManifestSha256,
          `manifest ${manifest.rawManifestSha256.slice(0, 12)}…, restored ${actualRawHash.slice(0, 12)}…`,
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
