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
    const root = p.rootsTotal === undefined ? p.root ? ` · ${p.root}` : ""
      : ` · ист. ${p.rootsCompleted}/${p.rootsTotal}${p.root ? ` ${p.root}` : ""}`;
    // Bun measures terminal cells, not UTF-16 length; never wrap into another line.
    const text = ` ${bar} ${p.stage}/5${root}${count} · ${p.detail} · ${elapsed}`
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
      const name = String(event.event ?? "");
      if (!event.error && !Number(event.errors) && !Number(event.scanErrors) &&
          !/failed|error|session_view_skipped/.test(name) &&
          !(event.status && !["complete", "completed", "parsed"].includes(String(event.status)))) return;
      // Do not expose source paths or arbitrary parser/provider error payloads.
      stream.write(`\r\x1b[2K! ${name.replace(/[^a-zA-Z0-9_]/g, "")} · см. итог sync / baka validate\n`);
      draw();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write("\r\x1b[2K");
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
