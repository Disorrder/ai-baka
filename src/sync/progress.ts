import type { SyncSummary } from "./sync-run.ts";

/** Human output only; machine-readable counters retain their original contract. */
export function formatSyncSummary(
  summary: SyncSummary,
  columns = process.stdout.isTTY ? process.stdout.columns : undefined,
  dryRun = false,
): string {
  const width = Number.isFinite(columns) && columns! > 0 ? Math.max(1, Math.floor(columns!) - 1) : 80;
  const number = new Intl.NumberFormat("ru-RU");
  const lines: string[] = [];

  // Wrap without losing labels or values, including on very narrow terminals.
  function append(text: string) {
    let rest = text;
    while (Bun.stringWidth(rest) > width) {
      let end = 0;
      let cells = 0;
      let space = -1;
      for (const char of rest) {
        if (cells + Bun.stringWidth(char) > width) break;
        if (char === " " && end > 0) space = end;
        cells += Bun.stringWidth(char);
        end += char.length;
      }
      const split = space > 0 ? space : end;
      lines.push(rest.slice(0, split));
      rest = rest.slice(split).trimStart();
    }
    lines.push(rest);
  }

  const sections: { title: string; rows: [string, string][] }[] = [];
  function section(title: string, metrics: [string, string][]) {
    sections.push({
      title,
      rows: metrics.map(([key, label]) => [label, number.format(summary.counters[key] ?? 0)]),
    });
  }

  const status: Record<string, string> = {
    completed: "завершена",
    completed_with_errors: "завершена с ошибками",
    failed: "не завершена",
    cancelled: "отменена",
  };
  append(`Синхронизация: ${status[summary.status] ?? summary.status}`);
  if (dryRun) append("Пробный запуск — без записи данных.");
  append(`Ошибки обработки: ${number.format(summary.counters.ingestErrors ?? 0)}`);
  for (const error of summary.errors) append(`Ошибка: ${error}`);

  section("Исходные файлы", [
    ["filesNew", "Новых файлов"],
    ["filesChanged", "Изменённых файлов"],
    ["filesMissing", "Отсутствует в источниках"],
  ]);
  section("Детали сканирования и архива", [
    ["roots", "Источников проверено"],
    ["filesSeen", "Всего файлов"],
    ["filesDuplicateSkipped", "Дубликатов пропущено"],
  ]);
  section("Диалоги и содержимое", [
    ["dialoguesWritten", "Обработано диалогов"],
    ["messagesWritten", "Новых сообщений"],
    ["chunksWritten", "Фрагментов сообщений"],
  ]);
  section("Поиск", [
    ["searchDocuments", "Текстов для поиска"],
    ["embeddingJobs", "Заданий на векторизацию"],
  ]);
  const rows = sections.flatMap((section) => section.rows);
  const labelWidth = Math.max(...rows.map(([label]) => Bun.stringWidth(label)));
  const valueWidth = Math.max(...rows.map(([, value]) => Bun.stringWidth(value)));
  const bold = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  for (const { title, rows } of sections) {
    lines.push("");
    const headingStart = lines.length;
    append(`${title}:`);
    if (bold) {
      for (let index = headingStart; index < lines.length; index++) {
        lines[index] = `\x1b[1m${lines[index]}\x1b[22m`;
      }
    }
    for (const [label, value] of rows) {
      if (2 + labelWidth + 3 + valueWidth <= width) {
        lines.push(`  ${label}${" ".repeat(labelWidth - Bun.stringWidth(label))}   ${
          " ".repeat(valueWidth - Bun.stringWidth(value))}${value}`);
      } else {
        append(`  ${label}: ${value}`);
      }
    }
  }
  return lines.join("\n");
}

export interface SyncProgress {
  stage: number;
  detail: string;
  completed?: number;
  total?: number;
  unit?: string;
  root?: string;
  rootsCompleted?: number;
  rootsTotal?: number;
}

/** Presentation only: percentages describe the current operation, not elapsed work. */
export function createSyncProgress() {
  const stream = process.stderr;
  const started = Date.now();
  let current: SyncProgress = { stage: 1, detail: "Подготовка" };
  let stopped = false;
  let lastDraw = 0;
  let frame = 0;
  let warningCount = 0;
  const warnings = new Map<string, number>();
  const color = !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  function draw() {
    if (stopped) return;
    lastDraw = Date.now();
    const p = current;
    const seconds = Math.floor((lastDraw - started) / 1000);
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const count = p.total === undefined
      ? p.completed === undefined ? "" : ` · ${p.completed} ${p.unit ?? ""}`
      : ` · ${p.completed ?? 0}/${p.total} ${p.unit ?? ""}`;
    const ratio = p.total === undefined ? undefined : p.total === 0 ? 1
      : Math.max(0, Math.min(1, (p.completed ?? 0) / p.total));
    const barWidth = (stream.columns || 100) >= 120 ? 10 : 6;
    const filled = Math.round((ratio ?? 0) * barWidth);
    const spinner = frames[frame++ % frames.length]!;
    const bar = ratio === undefined ? spinner
      : `${spinner} [${"━".repeat(filled)}${"─".repeat(barWidth - filled)}]`;
    const harness = p.root ? ` (${p.root})` : "";
    const roots = p.rootsTotal === undefined ? ""
      : ` · источники ${p.rootsCompleted ?? 0}/${p.rootsTotal}`;
    // Bun measures terminal cells, not UTF-16 length; never wrap into another line.
    const warningSummary = warningCount > 0 ? ` · замечания ${warningCount}` : "";
    const text = ` ${elapsed} ${bar} ${p.stage}/5 · ${p.detail}${harness}${count}${warningSummary}${roots}`
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const width = Math.max(1, (stream.columns || 100) - 1);
    let clipped = "";
    let cells = 0;
    for (const char of text) {
      cells += Bun.stringWidth(char);
      if (cells > width) break;
      clipped += char;
    }
    stream.write(`\r\x1b[2K${color ? "\x1b[36m" : ""}${clipped}${color ? "\x1b[0m" : ""}`);
  }

  draw();
  const timer = setInterval(draw, 100);
  timer.unref();
  return {
    update(progress: SyncProgress) {
      const changed = progress.stage !== current.stage || progress.detail !== current.detail;
      current = progress;
      if (changed || progress.total !== undefined && progress.completed === progress.total ||
          Date.now() - lastDraw >= 100) draw();
    },
    log(event: Record<string, unknown>) {
      if (stopped || event.event === "sync_finish" || event.event === "sync_timing") return;
      const name = String(event.event ?? "");
      const status = String(event.status ?? "");
      if (!event.error && !Number(event.errors) && !Number(event.scanErrors) &&
          !Number(event.failed) && !/failed|error|session_view_skipped/.test(name) &&
          !(status && !["complete", "completed", "parsed"].includes(status))) return;
      // Aggregate notifications, not ingest errors: one event may contain several
      // diagnostics. The authoritative error total remains in the sync summary.
      const reason = status === "unsupported" ? "неподдерживаемый формат"
        : status === "partial" ? "частичная обработка"
        : status === "parse_error" ? "ошибки обработки диалогов"
        : name === "session_view_skipped" ? "пропущенные сессии"
        : event.error || Number(event.errors) || Number(event.scanErrors) ||
          Number(event.failed) || /failed|error/.test(name) ? "ошибки синхронизации"
        : "источники недоступны или обработаны не полностью";
      warnings.set(reason, (warnings.get(reason) ?? 0) + 1);
      warningCount += 1;
      if (Date.now() - lastDraw >= 100) draw();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write("\r\x1b[2K");
      if (warningCount > 0) {
        const details = [...warnings].map(([reason, count]) => `${reason}: ${count}`).join("; ");
        stream.write(`Замечания sync (${warningCount}): ${details}. Подробный журнал доступен с --json.\n`);
      }
    },
  };
}

/** Progress JSONL is throttled independently of the existing event log. */
export function createSyncProgressLogger() {
  let previousStage = 0;
  let previousDetail = "";
  let lastWrite = 0;
  return (progress: SyncProgress) => {
    const now = Date.now();
    if (progress.stage === previousStage && progress.detail === previousDetail && now - lastWrite < 5000) return;
    previousStage = progress.stage;
    previousDetail = progress.detail;
    lastWrite = now;
    console.error(JSON.stringify({ time: new Date(now).toISOString(), event: "sync_progress", ...progress }));
  };
}
