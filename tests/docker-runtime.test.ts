import { expect, test } from "bun:test";
import { ensureDockerRuntime, type DockerRuntimeDependencies } from "../src/infra/docker-runtime.ts";

function runtime(endpoint: string) {
  const state = { ready: false, launched: "", launches: 0, elapsed: 0, polls: 0, boot: true };
  const dependencies: DockerRuntimeDependencies = {
    platform: "darwin",
    env: {},
    now: () => state.elapsed,
    sleep: async (ms) => { state.elapsed += ms; },
    run: async (file, args, timeoutMs) => {
      if (file === "open") {
        state.launched = args.at(-1)!;
        state.launches++;
        return "";
      }
      if (args[0] === "context") {
        return JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]);
      }
      state.polls++;
      if (state.launches && state.boot && state.elapsed >= 2_000) state.ready = true;
      if (state.ready) return "27.0.0";
      state.elapsed += timeoutMs;
      throw new Error("daemon unavailable");
    },
  };
  return { state, dependencies };
}

test("running daemon requires neither app launch nor endpoint resolution", async () => {
  await ensureDockerRuntime(() => {}, {
    run: async (file, args) => {
      if (file !== "docker" || args[0] !== "info") throw new Error("unexpected launch or context lookup");
      return "27.0.0";
    },
  });
});

test("missing OrbStack socket triggers one launch and waits for Docker API", async () => {
  const { state, dependencies } = runtime("unix:///Users/example/.orbstack/run/docker.sock");
  await ensureDockerRuntime(() => {}, dependencies);
  expect(state.ready).toBe(true);
  expect(state.launched).toBe("OrbStack");
  expect(state.launches).toBe(1);
});

test("Docker Desktop endpoint selects Docker rather than OrbStack", async () => {
  const { state, dependencies } = runtime("unix:///Users/example/.docker/run/docker.sock");
  await ensureDockerRuntime(() => {}, dependencies);
  expect(state.ready).toBe(true);
  expect(state.launched).toBe("Docker");
});

test("daemon that never boots exhausts the deadline without relaunching", async () => {
  const { state, dependencies } = runtime("unix:///Users/example/.orbstack/run/docker.sock");
  state.boot = false;
  await expect(ensureDockerRuntime(() => {}, dependencies)).rejects.toThrow("60 секунд");
  expect(state.elapsed).toBe(61_000); // Initial probe plus the bounded startup window.
  expect(state.launches).toBe(1);
  expect(state.polls).toBe(61); // One initial probe, then sixty one-second attempts.
});

test("DOCKER_HOST override never starts an unrelated local runtime", async () => {
  const { state, dependencies } = runtime("unix:///Users/example/.orbstack/run/docker.sock");
  dependencies.env = { DOCKER_HOST: "tcp://remote.example:2376" };
  await expect(ensureDockerRuntime(() => {}, dependencies)).rejects.toThrow("endpoint не распознан");
  expect(state.launches).toBe(0);
});

test("DOCKER_CONTEXT takes precedence over DOCKER_HOST", async () => {
  const { state, dependencies } = runtime("unix:///Users/example/.orbstack/run/docker.sock");
  dependencies.env = { DOCKER_HOST: "tcp://remote.example:2376", DOCKER_CONTEXT: "orbstack" };
  await ensureDockerRuntime(() => {}, dependencies);
  expect(state.ready).toBe(true);
  expect(state.launched).toBe("OrbStack");
});

test("missing CLI and missing application fail without readiness polling", async () => {
  await expect(ensureDockerRuntime(() => {}, {
    run: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  })).rejects.toThrow("Docker CLI не установлен");
  const { state, dependencies } = runtime("unix:///Users/example/.orbstack/run/docker.sock");
  const run = dependencies.run!;
  dependencies.run = async (file, args, timeoutMs) => {
    if (file === "open") throw new Error("application not found");
    return run(file, args, timeoutMs);
  };
  await expect(ensureDockerRuntime(() => {}, dependencies)).rejects.toThrow("Не удалось запустить OrbStack");
  expect(state.polls).toBe(1);
});

test("fast failures are polled once per second and readiness returns immediately", async () => {
  const { state, dependencies } = runtime("unix:///Users/example/.orbstack/run/docker.sock");
  const run = dependencies.run!;
  const attempts: number[] = [];
  dependencies.run = async (file, args, timeoutMs) => {
    if (file === "docker" && args[0] === "info") {
      attempts.push(state.elapsed);
      if (state.elapsed >= 2_250) return "27.0.0";
      state.elapsed += 250;
      throw new Error("not ready");
    }
    return run(file, args, timeoutMs);
  };
  await ensureDockerRuntime(() => {}, dependencies);
  expect(attempts).toEqual([0, 250, 1_250, 2_250]);
  expect(state.elapsed).toBe(2_250);
});

test("missing installation provides both installation choices and next steps", async () => {
  let failure: unknown;
  try {
    await ensureDockerRuntime(() => {}, {
      run: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).toContain("https://orbstack.dev/download");
  expect(message).toContain("https://docs.docker.com/desktop/setup/install/");
  expect(message).toContain("первоначальную настройку");
  expect(message).toContain("bun sync");
});
