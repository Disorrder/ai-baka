import { createProgressLogger, createTerminalProgress } from "../cli-progress.ts";
import { hasExecutionFilters } from "./project.ts";
import type { ExportConfig, SqliteExportProgress } from "./types.ts";

export interface SqliteExportProgressDisplay {
  update(progress: SqliteExportProgress): void;
  stop(): void;
}

export function createSqliteExportProgress(config: ExportConfig, dryRun = false): SqliteExportProgressDisplay {
  const matching = config.matchScope === "dialogue" && hasExecutionFilters(config) ? 1 : 0;
  const stages = (dryRun ? 3 : 5) + matching;
  const ui = process.stderr.isTTY && process.env.TERM !== "dumb"
    ? createTerminalProgress(stages, "Подготовка экспорта") : undefined;
  const log = createProgressLogger("sqlite_export_progress");
  const stageNumbers: Record<SqliteExportProgress["stage"], number> = {
    manifest: 1, source_scan: 2, matching: 3, export: 3 + matching, verify: 4 + matching, publish: 5 + matching,
  };
  const details: Record<SqliteExportProgress["stage"], string> = {
    manifest: "Сбор manifest", source_scan: "Чтение canonical-корпуса", matching: "Отбор диалогов",
    export: dryRun ? "Проверка выбранного среза" : "Экспорт в SQLite",
    verify: "Проверка SQLite и SHA-256", publish: "Публикация файла",
  };
  let stopped = false;
  return {
    update(progress) {
      if (stopped) return;
      const view = {
        stage: stageNumbers[progress.stage], detail: details[progress.stage],
        completed: progress.completed, total: progress.total,
        unit: progress.stage === "manifest" ? "ревизий найдено" : progress.stage === "source_scan" ? "записей" : "ревизий",
        suffix: progress.stage === "export" ? ` · ${progress.counts.read_messages ?? 0} сообщений` : undefined,
      };
      if (ui) ui.update(view);
      else log(view);
    },
    stop() { stopped = true; ui?.stop(); },
  };
}
