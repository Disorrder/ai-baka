export interface ProgressUpdate {
  stage: number;
  detail: string;
  completed?: number;
  total?: number;
  unit?: string;
  suffix?: string;
}

export interface TerminalProgress {
  update(progress: ProgressUpdate): void;
  stop(): void;
}

/** Presentation only: a bar describes the current operation, never guessed elapsed work. */
export function createTerminalProgress(stages: number, initialDetail = "Подготовка"): TerminalProgress {
  const stream = process.stderr;
  const started = Date.now();
  let current: ProgressUpdate = { stage: 1, detail: initialDetail };
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
    const text = ` ${elapsed} ${bar} ${p.stage}/${stages} · ${p.detail}${count}${p.suffix ?? ""}`
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    // Bun measures terminal cells, not UTF-16 length; never wrap into another line.
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
    update(progress) {
      const changed = progress.stage !== current.stage || progress.detail !== current.detail;
      current = progress;
      if (changed || progress.total !== undefined && progress.completed === progress.total || Date.now() - lastDraw >= 100) draw();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write("\r\x1b[2K");
    },
  };
}

/** Pipes receive bounded JSONL on stderr, never terminal control sequences. */
export function createProgressLogger(event: string) {
  let previousStage = 0;
  let previousDetail = "";
  let previousCompleted: number | undefined;
  let lastWrite = 0;
  return (progress: ProgressUpdate) => {
    const now = Date.now();
    const finished = progress.total !== undefined && progress.completed === progress.total && previousCompleted !== progress.completed;
    if (progress.stage === previousStage && progress.detail === previousDetail && !finished && now - lastWrite < 5000) return;
    previousStage = progress.stage;
    previousDetail = progress.detail;
    previousCompleted = progress.completed;
    lastWrite = now;
    console.error(JSON.stringify({ time: new Date(now).toISOString(), event, ...progress }));
  };
}
