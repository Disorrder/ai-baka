import { expect, test } from "bun:test";

// A child process isolates stderr and the renderer's timer from other test files.
test("repeated parser warnings stay on one live line and produce one private-safe summary", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { createSyncProgress } from ${JSON.stringify(new URL("../src/sync/progress.ts", import.meta.url).href)};
    const ui = createSyncProgress();
    ui.log({ event: "revision_parsed", status: "parsed", errors: 0 });
    for (let i = 0; i < 5; i++) {
      ui.log({ event: "revision_parsed", status: "unsupported", errors: 0,
        path: "private-source-path" });
    }
    ui.log({ event: "revision_parsed", status: "partial", errors: 2 });
    ui.log({ event: "snapshot_error", error: "private-error-payload" });
    ui.log({ event: "sync_finish", status: "completed_with_errors" });
    process.stderr.write("\\n<STOP>\\n");
    ui.stop();
    ui.stop();
    ui.log({ event: "root_failed", error: "late-error" });
  `], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  const [running, finished] = output.split("\n<STOP>\n");
  expect(running).toBeDefined();
  expect(finished).toBeDefined();
  expect(running).not.toContain("\n");
  const summary = Bun.stripANSI(finished!).trim();
  expect(summary.split("\n")).toHaveLength(1);
  // Seven notifications grouped as five unsupported files, one partial parse,
  // and one snapshot error. The final run status must not double-count them.
  expect((summary.match(/\d+/g) ?? []).map(Number).sort((a, b) => a - b)).toEqual([1, 1, 5, 7]);
  expect(output).not.toContain("revision_parsed");
  expect(output).not.toContain("private-source-path");
  expect(output).not.toContain("private-error-payload");
  expect(output).not.toContain("late-error");
});
