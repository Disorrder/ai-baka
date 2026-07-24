import { statfsSync, statSync, existsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.ts";
import { readSentinel, SentinelError } from "./sentinel.ts";
import { isLocked, lockFilePath } from "./lock.ts";

export interface PreflightIssue {
  check: string;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  issues: PreflightIssue[];
}

/**
 * Проверки перед любой операцией записи в архив (docs/plan.md §4.1).
 * Проверка совместимости версии SurrealDB выполняется отдельно после
 * подключения (требует живой БД).
 */
export async function runPreflight(cfg: AppConfig): Promise<PreflightReport> {
  const issues: PreflightIssue[] = [];
  const root = cfg.archiveRoot;

  // 2. Путь существует
  if (!existsSync(root)) {
    issues.push({
      check: "archive_root_exists",
      detail: `путь не существует: ${root} (диск смонтирован? сначала archive:init)`,
    });
    return { ok: false, issues }; // дальнейшие проверки бессмысленны
  }

  // 3–5. Sentinel: наличие, UUID, namespace/database
  try {
    const sentinel = await readSentinel(root);
    if (cfg.expectedArchiveId && sentinel.archiveId !== cfg.expectedArchiveId) {
      issues.push({
        check: "archive_id_match",
        detail:
          `archiveId sentinel (${sentinel.archiveId}) не совпадает с ` +
          `BAKA_ARCHIVE_ID (${cfg.expectedArchiveId})`,
      });
    }
    if (sentinel.expectedNamespace !== cfg.surrealNamespace) {
      issues.push({
        check: "namespace_match",
        detail: `sentinel ожидает namespace "${sentinel.expectedNamespace}", конфиг — "${cfg.surrealNamespace}"`,
      });
    }
    if (sentinel.expectedDatabase !== cfg.surrealDatabase) {
      issues.push({
        check: "database_match",
        detail: `sentinel ожидает database "${sentinel.expectedDatabase}", конфиг — "${cfg.surrealDatabase}"`,
      });
    }
  } catch (error) {
    issues.push({
      check: "sentinel",
      detail: error instanceof SentinelError ? error.message : String(error),
    });
  }

  // 5. Директория writable
  const probe = path.join(root, `.baka-write-probe-${process.pid}`);
  try {
    await writeFile(probe, "");
    await unlink(probe);
  } catch {
    issues.push({ check: "writable", detail: `директория не writable: ${root}` });
  }

  // 6. Путь реально на смонтированном томе, а не локальная папка на /
  try {
    const rootDev = statSync(root).dev;
    const slashDev = statSync("/").dev;
    if (rootDev === slashDev) {
      issues.push({
        check: "mounted_volume",
        detail:
          `${root} находится на корневой файловой системе — ` +
          `внешний диск, скорее всего, не смонтирован`,
      });
    }
  } catch (error) {
    issues.push({ check: "mounted_volume", detail: String(error) });
  }

  // 7. Свободное место
  try {
    const free = statfsSync(root).bavail * statfsSync(root).bsize;
    if (free < cfg.minFreeBytes) {
      issues.push({
        check: "free_space",
        detail: `свободно ${free} байт, требуется минимум ${cfg.minFreeBytes}`,
      });
    }
  } catch (error) {
    issues.push({ check: "free_space", detail: String(error) });
  }

  // 8. Не запущен другой sync
  if (await isLocked(root)) {
    issues.push({
      check: "sync_lock",
      detail: `активный lock: ${lockFilePath(root)}`,
    });
  }

  return { ok: issues.length === 0, issues };
}

/** Быстрая проверка «можно ли писать» для использования внутри других команд. */
export async function assertPreflight(cfg: AppConfig): Promise<void> {
  const report = await runPreflight(cfg);
  if (!report.ok) {
    const details = report.issues
      .map((i) => `  - [${i.check}] ${i.detail}`)
      .join("\n");
    throw new Error(`preflight не пройден:\n${details}`);
  }
}
