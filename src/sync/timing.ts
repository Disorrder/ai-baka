export interface StageTimer {
  next(stage: string, status?: string): void;
  finish(status: string): void;
}

/** Sequential stages; nested scope totals must not be summed with their parents. */
export function stageTimer(
  log: (event: Record<string, unknown>) => void,
  scope: Record<string, unknown>,
  initialStage: string,
): StageTimer {
  const started = performance.now();
  let stageStarted = started;
  let stage = initialStage;
  const emit = (status: string) => {
    const now = performance.now();
    log({ event: "sync_timing", ...scope, stage, status,
      durationMs: Number((now - stageStarted).toFixed(3)) });
    stageStarted = now;
  };
  return {
    next(nextStage: string, status = "completed") {
      emit(status);
      stage = nextStage;
    },
    finish(status: string) {
      emit(status);
      log({ event: "sync_timing", ...scope, stage: "total", status,
        durationMs: Number((performance.now() - started).toFixed(3)) });
    },
  };
}
