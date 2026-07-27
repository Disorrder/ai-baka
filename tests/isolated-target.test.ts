import { describe, expect, test } from "bun:test";
import {
  createIsolatedTargetIdentity,
  DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE,
  IsolatedTargetLifecycleError,
  PINNED_SURREAL_INDEXING_BEHAVIOR,
  pinnedSurrealImageFromCompose,
  validateIsolatedTargetIdentity,
  validateIsolatedTargetLaunchPlan,
  validateIsolatedTargetResourceProfile,
  withIsolatedSurrealTarget,
  type DockerCommandRequest,
  type DockerCommandResult,
  type IsolatedTargetDependencies,
  type IsolatedTargetIdentity,
  type IsolatedTargetLaunchPlan,
} from "../src/backup/isolated-target.ts";

const PINNED_IMAGE =
  "surrealdb/surrealdb:v3.2.3@sha256:" +
  "2006fe3f88f6f240c6463460021b4a14ffe102aea376284428f850045b7b382e";
const ATTEMPT_UUID = "11111111-2222-4333-8444-555555555555";
const ATTEMPT_TOKEN = ATTEMPT_UUID.replaceAll("-", "");
const COMPOSE = `services:
  surrealdb:
    image: ${PINNED_IMAGE}
`;

interface FakeVolume {
  name: string;
  driver: string;
  labels: Record<string, string>;
}

interface FakeContainer {
  name: string;
  configImage: string;
  labels: Record<string, string>;
  restartPolicy: string;
  memory: number;
  memorySwap: number;
  nanoCpus: number;
  pidsLimit: number;
  user: string;
  readOnlyRootfs: boolean;
  privileged: boolean;
  capDrop: string[];
  tmpfs: Record<string, string>;
  mounts: Array<Record<string, string>>;
  ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  state: { Running: boolean; OOMKilled: boolean; ExitCode: number };
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || args[index + 1] === undefined) throw new Error(`missing fake option ${name}`);
  return args[index + 1]!;
}

function labels(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const item = args[index + 1] ?? "";
    const separator = item.indexOf("=");
    if (separator > 0) result[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return result;
}

class FakeDocker {
  readonly requests: DockerCommandRequest[] = [];
  readonly volumes = new Map<string, FakeVolume>();
  readonly containers = new Map<string, FakeContainer>();
  readonly commandCounts = new Map<string, number>();
  readonly hungCommandOccurrences = new Map<string, number>();
  failVersion = false;
  readinessFailures = 0;
  commandFailureText = "";
  hostPort = "49152";

  constructor() {
    this.volumes.set("production-data", {
      name: "production-data",
      driver: "local",
      labels: { owner: "production" },
    });
    this.containers.set("baka-surrealdb", {
      name: "/baka-surrealdb",
      configImage: PINNED_IMAGE,
      labels: { owner: "production" },
      restartPolicy: "unless-stopped",
      memory: 0,
      memorySwap: 0,
      nanoCpus: 0,
      pidsLimit: 0,
      user: "nonroot",
      readOnlyRootfs: false,
      privileged: false,
      capDrop: [],
      tmpfs: {},
      mounts: [{ Type: "bind", Source: "/production/db", Destination: "/data" }],
      ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }] },
      state: { Running: true, OOMKilled: false, ExitCode: 0 },
    });
  }

  dependencies(overrides: Partial<IsolatedTargetDependencies> = {}): Partial<IsolatedTargetDependencies> {
    return {
      readComposeFile: async () => COMPOSE,
      runDocker: (request) => this.run(request),
      randomUuid: () => ATTEMPT_UUID,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
      ...overrides,
    };
  }

  private result(exitCode = 0, stdout = "", stderr = ""): DockerCommandResult {
    return { exitCode, stdout, stderr };
  }

  async run(request: DockerCommandRequest): Promise<DockerCommandResult> {
    this.requests.push({
      args: [...request.args],
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      env: request.env ? { ...request.env } : undefined,
      signal: request.signal,
    });
    const args = request.args;
    const command = `${args[0] ?? ""} ${args[1] ?? ""}`;
    const occurrence = (this.commandCounts.get(command) ?? 0) + 1;
    this.commandCounts.set(command, occurrence);
    if (this.hungCommandOccurrences.get(command) === occurrence) {
      // Deliberately ignores AbortSignal: the lifecycle wrapper, not the fake,
      // must guarantee that even a broken runner settles at its deadline.
      return await new Promise<DockerCommandResult>(() => {});
    }

    if (args[0] === "volume" && args[1] === "create") {
      const name = args.at(-1)!;
      this.volumes.set(name, { name, driver: "local", labels: labels(args) });
      return this.result(0, `${name}\n`);
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1)!;
      const volume = this.volumes.get(name);
      return volume
        ? this.result(0, JSON.stringify(volume))
        : this.result(1, "", `Error: No such volume: ${name}`);
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const name = args.at(-1)!;
      if (!this.volumes.has(name)) return this.result(1, "", `No such volume: ${name}`);
      this.volumes.delete(name);
      return this.result(0, `${name}\n`);
    }
    if (args[0] === "container" && args[1] === "run") {
      const name = option(args, "--name");
      const image = args.find((item) => item.startsWith("surrealdb/surrealdb:"))!;
      const publish = option(args, "--publish");
      const [hostIp] = publish.split("::");
      const mount = option(args, "--mount");
      const volumeName = mount.match(/(?:^|,)src=([^,]+)/u)?.[1] ?? "";
      this.containers.set(name, {
        name: `/${name}`,
        configImage: image,
        labels: labels(args),
        restartPolicy: option(args, "--restart"),
        memory: Number(option(args, "--memory")),
        memorySwap: Number(option(args, "--memory-swap")),
        nanoCpus: Math.round(Number(option(args, "--cpus")) * 1_000_000_000),
        pidsLimit: Number(option(args, "--pids-limit")),
        user: option(args, "--user"),
        readOnlyRootfs: args.includes("--read-only"),
        privileged: args.includes("--privileged"),
        capDrop: [option(args, "--cap-drop")],
        tmpfs: {
          "/logs": "rw,noexec,nosuid,nodev,size=16777216",
          "/tmp": "rw,noexec,nosuid,nodev,size=67108864",
        },
        mounts: [
          { Type: "volume", Name: volumeName, Destination: "/data" },
        ],
        ports: { "8000/tcp": [{ HostIp: hostIp!, HostPort: this.hostPort }] },
        state: { Running: true, OOMKilled: false, ExitCode: 0 },
      });
      return this.result(0, "container-id\n");
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const name = args.at(-1)!;
      const container = this.containers.get(name);
      return container
        ? this.result(0, JSON.stringify(container))
        : this.result(1, "", `Error: No such container: ${name}`);
    }
    if (args[0] === "container" && args[1] === "exec") {
      if (args.includes("is-ready")) {
        if (this.readinessFailures > 0) {
          this.readinessFailures -= 1;
          return this.result(1, "", "not ready");
        }
        return this.result(0, "ready\n");
      }
      if (args.includes("version")) {
        return this.failVersion
          ? this.result(19, "", this.commandFailureText)
          : this.result(0, "3.2.3 for linux on aarch64\n");
      }
    }
    if (args[0] === "container" && args[1] === "stats") {
      if (request.signal?.aborted) return this.result(130);
      return this.result(0, JSON.stringify({
        MemUsage: "1.5GiB / 12GiB",
        CPUPerc: "87.5%",
        PIDs: "23",
      }));
    }
    if (args[0] === "container" && args[1] === "rm") {
      const name = args.at(-1)!;
      if (!this.containers.has(name)) return this.result(1, "", `No such container: ${name}`);
      this.containers.delete(name);
      return this.result(0, `${name}\n`);
    }
    return this.result(99, "", "unexpected fake Docker command");
  }

  markAttemptOom(): void {
    const container = this.containers.get(`baka-restore-target-${ATTEMPT_TOKEN}`);
    if (!container) throw new Error("attempt container not found");
    container.state = { Running: false, OOMKilled: true, ExitCode: 137 };
  }

  replaceAttemptOwnership(): void {
    const container = this.containers.get(`baka-restore-target-${ATTEMPT_TOKEN}`);
    if (!container) throw new Error("attempt container not found");
    container.labels = { owner: "foreign" };
  }

  removeAttemptContainerUnexpectedly(): void {
    this.containers.delete(`baka-restore-target-${ATTEMPT_TOKEN}`);
  }

  hangCommand(command: string, occurrence = 1): void {
    this.hungCommandOccurrences.set(command, occurrence);
  }

  removalCommands(): DockerCommandRequest[] {
    return this.requests.filter((request) =>
      (request.args[0] === "container" && request.args[1] === "rm") ||
      (request.args[0] === "volume" && request.args[1] === "rm")
    );
  }
}

function validPlan(): IsolatedTargetLaunchPlan {
  const identity = createIsolatedTargetIdentity(ATTEMPT_UUID);
  return {
    image: PINNED_IMAGE,
    version: "3.2.3",
    identity,
    hostAddress: "127.0.0.1",
    containerPort: 8000,
    storage: { type: "volume", source: identity.volumeName, target: "/data" },
    resources: { ...DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE },
    containerUser: "0:0",
    restartPolicy: "no",
    indexBuildResumeInterval: "0",
  };
}

function lifecycleFailure(error: unknown): IsolatedTargetLifecycleError {
  expect(error).toBeInstanceOf(IsolatedTargetLifecycleError);
  return error as IsolatedTargetLifecycleError;
}

describe("isolated target fail-closed launch contract", () => {
  test("derives one exact v3.2.3 tag+digest and rejects every unpinned form", () => {
    expect(pinnedSurrealImageFromCompose(COMPOSE)).toEqual({
      image: PINNED_IMAGE,
      version: "3.2.3",
    });
    for (const image of [
      "surrealdb/surrealdb:v3.2.3",
      "surrealdb/surrealdb:latest@sha256:" + "a".repeat(64),
      "surrealdb/surrealdb:v3.2.2@sha256:" + "a".repeat(64),
      "${SURREAL_IMAGE}",
    ]) {
      expect(() => pinnedSurrealImageFromCompose(`services:\n  surrealdb:\n    image: ${image}\n`))
        .toThrow(/literal|tag plus sha256/);
    }
  });

  test("rejects non-loopback publication, path mounts, restart and auto-resume", () => {
    expect(() => validateIsolatedTargetLaunchPlan({
      ...validPlan(),
      hostAddress: "0.0.0.0",
    } as unknown as IsolatedTargetLaunchPlan)).toThrow(/127\.0\.0\.1/);
    expect(() => validateIsolatedTargetLaunchPlan({
      ...validPlan(),
      storage: {
        type: "bind",
        source: "/Volumes/Archive/Conversations/db",
        target: "/data",
      },
    } as unknown as IsolatedTargetLaunchPlan)).toThrow(/named volume/);
    expect(() => validateIsolatedTargetLaunchPlan({
      ...validPlan(),
      restartPolicy: "unless-stopped",
    } as unknown as IsolatedTargetLaunchPlan)).toThrow(/restart/);
    expect(() => validateIsolatedTargetLaunchPlan({
      ...validPlan(),
      containerUser: "nonroot",
    } as unknown as IsolatedTargetLaunchPlan)).toThrow(/proven 0:0/);
    expect(() => validateIsolatedTargetLaunchPlan({
      ...validPlan(),
      indexBuildResumeInterval: "30s",
    } as unknown as IsolatedTargetLaunchPlan)).toThrow(/auto-resume/);
  });

  test("rejects zero, unlimited, or disproportionate resource controls", () => {
    const valid = { ...DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE };
    for (const mutation of [
      { memoryBytes: 0, memorySwapBytes: 0 },
      { memorySwapBytes: -1 },
      { cpus: 0 },
      { rocksDbBlockCacheBytes: 0 },
      { rocksDbBlockCacheBytes: 8 * 1024 ** 3 },
      { rocksDbThreadCount: 0 },
      { rocksDbJobsCount: 0 },
      { rocksDbMaxConcurrentSubcompactions: 5, rocksDbJobsCount: 4 },
      { memoryThresholdBytes: 0 },
      { httpMaxImportBodyBytes: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => validateIsolatedTargetResourceProfile({ ...valid, ...mutation }))
        .toThrow(/bounded|equal/);
    }
  });

  test("exposes immutable compile-time indexing behavior, not a configurable resource", () => {
    expect(PINNED_SURREAL_INDEXING_BEHAVIOR).toEqual({
      probeRecords: 16,
      targetBytes: 8_388_608,
      maxRecords: 250,
    });
    expect(Object.isFrozen(PINNED_SURREAL_INDEXING_BEHAVIOR)).toBe(true);
    expect(DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE).not.toHaveProperty("indexingBatchSize");
  });

  test("rejects malformed, mismatched, and non-allowlisted Docker identities", () => {
    const valid = createIsolatedTargetIdentity(ATTEMPT_UUID);
    expect(validateIsolatedTargetIdentity(valid)).toEqual(valid);
    const invalid: IsolatedTargetIdentity[] = [
      { ...valid, attemptToken: "../production" },
      { ...valid, containerName: "baka-surrealdb" },
      { ...valid, volumeName: "production-data" },
      { ...valid, containerName: `baka-restore-target-${"a".repeat(32)}` },
    ];
    for (const identity of invalid) {
      expect(() => validateIsolatedTargetIdentity(identity)).toThrow(/allowlisted/);
    }
  });
});

describe("isolated target dependency-injected lifecycle", () => {
  test("explicit finalize is idempotent and completes container then volume cleanup before callback return", async () => {
    const fake = new FakeDocker();
    const trace: string[] = [];
    const result = await withIsolatedSurrealTarget(
      { credentials: { username: "root", password: "private" } },
      async (target) => {
        trace.push("restore-cleanup");
        const first = await target.finalize();
        trace.push("target-finalized");
        const second = await target.finalize();
        expect(second).toBe(first);
        expect(fake.containers.has(target.containerName)).toBe(false);
        expect(fake.volumes.has(target.volumeName)).toBe(false);
        trace.push("callback-return");
        return "done";
      },
      fake.dependencies(),
    );
    trace.push("outer-return");
    expect(result.value).toBe("done");
    expect(trace).toEqual([
      "restore-cleanup",
      "target-finalized",
      "callback-return",
      "outer-return",
    ]);
    expect(fake.removalCommands()).toHaveLength(2);
  });

  test("explicit finalize rejects an unexpectedly disappeared target even after exact volume cleanup", async () => {
    const fake = new FakeDocker();
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        { credentials: { username: "root", password: "private" } },
        async (target) => {
          fake.removeAttemptContainerUnexpectedly();
          await target.finalize();
          return "unreachable";
        },
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.code).toBe("target_disappeared");
    expect(failure.evidence?.cleanup).toEqual({
      containerRemoved: true,
      volumeRemoved: true,
      timedOut: false,
      failures: [],
    });
  });

  test("rejects a Docker-assigned production port without entering the callback", async () => {
    const fake = new FakeDocker();
    fake.hostPort = "8901";
    let callbackCalled = false;
    await expect(withIsolatedSurrealTarget(
      { credentials: { username: "root", password: "private" } },
      async () => {
        callbackCalled = true;
        return "unreachable";
      },
      fake.dependencies(),
    )).rejects.toBeInstanceOf(IsolatedTargetLifecycleError);
    expect(callbackCalled).toBe(false);
    expect(fake.containers.has("baka-surrealdb")).toBe(true);
    expect(fake.volumes.has("production-data")).toBe(true);
    for (const request of fake.requests) {
      expect(request.timeoutMs).toBe(30_000);
      expect(request.maxOutputBytes).toBe(256 * 1024);
    }
  });

  test("uses bounded argv/env, captures safe evidence, and cleans container before volume", async () => {
    const fake = new FakeDocker();
    const result = await withIsolatedSurrealTarget(
      { credentials: { username: "operator-user", password: "top-secret-password" } },
      async (target) => ({ endpoint: target.httpBaseUrl }),
      fake.dependencies(),
    );

    expect(result.value.endpoint).toBe("http://127.0.0.1:49152");
    expect(result.evidence.image).toBe(PINNED_IMAGE);
    expect(result.evidence.formatVersion).toBe(2);
    expect(result.evidence.version).toBe("3.2.3");
    expect(result.evidence.runtimeVersion).toStartWith("3.2.3 ");
    expect(result.evidence.resources).toEqual(DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE);
    expect(result.evidence.pinnedIndexingBehavior).toEqual(
      PINNED_SURREAL_INDEXING_BEHAVIOR,
    );
    expect(result.evidence.containerUser).toBe("0:0");
    expect(result.evidence.indexBuildResumeInterval).toBe("0");
    expect(result.evidence.observation.statsSamples).toBeGreaterThanOrEqual(1);
    expect(result.evidence.observation.peakMemoryBytes).toBe(Math.round(1.5 * 1024 ** 3));
    expect(result.evidence.cleanup).toEqual({
      containerRemoved: true,
      volumeRemoved: true,
      timedOut: false,
      failures: [],
    });
    expect(JSON.stringify(result.evidence)).not.toContain("operator-user");
    expect(JSON.stringify(result.evidence)).not.toContain("top-secret-password");

    const run = fake.requests.find((request) =>
      request.args[0] === "container" && request.args[1] === "run"
    )!;
    expect(run.args).toContain("127.0.0.1::8000");
    expect(run.args).toContain("--memory");
    expect(run.args).toContain("--cpus");
    expect(run.args).toContain("--memory-swap");
    expect(option(run.args, "--memory")).toBe(String(12 * 1024 ** 3));
    expect(option(run.args, "--memory-swap")).toBe(String(12 * 1024 ** 3));
    expect(option(run.args, "--user")).toBe("0:0");
    expect(run.args).toContain("type=volume,src=" + result.evidence.identity.volumeName + ",dst=/data");
    expect(run.args).not.toContain("operator-user");
    expect(run.args).not.toContain("top-secret-password");
    expect(run.env?.SURREAL_USER).toBe("operator-user");
    expect(run.env?.SURREAL_PASS).toBe("top-secret-password");
    expect(run.env?.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE).toBe(String(1024 ** 3));
    expect(run.env?.SURREAL_ROCKSDB_THREAD_COUNT).toBe("4");
    expect(run.env?.SURREAL_ROCKSDB_JOBS_COUNT).toBe("4");
    expect(run.env?.SURREAL_ROCKSDB_MAX_CONCURRENT_SUBCOMPACTIONS).toBe("2");
    expect(run.env).not.toHaveProperty("SURREAL_ROCKSDB_MAX_BACKGROUND_JOBS");
    expect(run.env).not.toHaveProperty("SURREAL_ROCKSDB_MAX_SUBCOMPACTIONS");
    expect(run.env).not.toHaveProperty("SURREAL_INDEXING_BATCH_SIZE");
    expect(run.args).not.toContain("SURREAL_INDEXING_BATCH_SIZE");
    expect(run.env?.SURREAL_MEMORY_THRESHOLD).toBe(String(6 * 1024 ** 3));
    expect(run.env?.SURREAL_TEMPORARY_DIRECTORY).toBe("/data");
    expect(run.args.slice(-7)).toEqual([
      "--log",
      "warn",
      "--bind",
      "0.0.0.0:8000",
      "--index-build-resume-interval",
      "0",
      "rocksdb:///data/db",
    ]);

    const removals = fake.removalCommands().map((request) => request.args);
    expect(removals).toEqual([
      [
        "container",
        "rm",
        "--force",
        "--volumes",
        `baka-restore-target-${ATTEMPT_TOKEN}`,
      ],
      ["volume", "rm", `baka-restore-target-data-${ATTEMPT_TOKEN}`],
    ]);
    expect(fake.containers.has("baka-surrealdb")).toBe(true);
    expect(fake.volumes.has("production-data")).toBe(true);
  });

  test("redacts command failures and still cleans only its exact resources", async () => {
    const fake = new FakeDocker();
    fake.failVersion = true;
    fake.commandFailureText = "auth rejected top-secret-password for operator-user";
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        { credentials: { username: "operator-user", password: "top-secret-password" } },
        async () => "not reached",
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.stage).toBe("readiness");
    expect(failure.code).toBe("docker_command_failed");
    expect(String(failure)).not.toContain("top-secret-password");
    expect(String(failure)).not.toContain("operator-user");
    expect(JSON.stringify(failure.evidence)).not.toContain("top-secret-password");
    expect(JSON.stringify(failure.evidence)).not.toContain("operator-user");
    expect(failure.evidence?.cleanup.containerRemoved).toBe(true);
    expect(failure.evidence?.cleanup.volumeRemoved).toBe(true);
    expect(fake.containers.has("baka-surrealdb")).toBe(true);
    expect(fake.volumes.has("production-data")).toBe(true);
  });

  test("abort races a stalled callback and performs exact cleanup without using the aborted signal", async () => {
    const fake = new FakeDocker();
    const controller = new AbortController();
    const promise = withIsolatedSurrealTarget(
      {
        credentials: { username: "root", password: "private" },
        signal: controller.signal,
      },
      async () => await new Promise<never>(() => {}),
      fake.dependencies(),
    );
    setTimeout(() => controller.abort("private abort reason"), 1);
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.code).toBe("aborted");
    expect(String(failure)).not.toContain("private abort reason");
    expect(failure.evidence?.cleanup).toEqual({
      containerRemoved: true,
      volumeRemoved: true,
      timedOut: false,
      failures: [],
    });
    for (const request of fake.removalCommands()) {
      expect(request.signal).not.toBe(controller.signal);
      expect(request.timeoutMs).toBeGreaterThan(0);
    }
  });

  test("readiness has a bounded timeout and failure cleanup", async () => {
    const fake = new FakeDocker();
    fake.readinessFailures = 100;
    let now = Date.parse("2026-07-27T12:00:00.000Z");
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        {
          credentials: { username: "root", password: "private" },
          readinessTimeoutMs: 10,
          readinessPollMs: 5,
        },
        async () => "not reached",
        fake.dependencies({
          now: () => new Date(now),
          sleep: async (milliseconds, signal) => {
            if (signal?.aborted) throw new Error("aborted");
            now += milliseconds;
          },
        }),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.stage).toBe("readiness");
    expect(failure.evidence?.cleanup.containerRemoved).toBe(true);
    expect(failure.evidence?.cleanup.volumeRemoved).toBe(true);
  });

  test("hung volume/container creation commands expire and still finalize exact resources", async () => {
    for (const [command, containerRemoved] of [
      ["volume create", true],
      ["container run", false],
    ] as const) {
      const fake = new FakeDocker();
      fake.hangCommand(command);
      let caught: unknown;
      try {
        await withIsolatedSurrealTarget(
          {
            credentials: { username: "root", password: "private" },
            dockerCommandTimeoutMs: 5,
            cleanupTimeoutMs: 100,
          },
          async () => "not reached",
          fake.dependencies(),
        );
      } catch (error) {
        caught = error;
      }
      const failure = lifecycleFailure(caught);
      expect(failure.stage).toBe("cleanup");
      expect(failure.code).toBe("owned_resource_cleanup_failed");
      expect(failure.evidence?.cleanup).toEqual({
        containerRemoved,
        volumeRemoved: false,
        timedOut: true,
        failures: ["cleanup_timeout"],
      });
    }
  });

  test("hung inspect expires without hiding the creation failure or leaking its volume", async () => {
    const fake = new FakeDocker();
    fake.hangCommand("volume inspect");
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        {
          credentials: { username: "root", password: "private" },
          dockerCommandTimeoutMs: 5,
          cleanupTimeoutMs: 100,
        },
        async () => "not reached",
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.stage).toBe("volume_create");
    expect(failure.code).toBe("docker_command_timeout");
    expect(failure.evidence?.cleanup).toEqual({
      containerRemoved: true,
      volumeRemoved: true,
      timedOut: false,
      failures: [],
    });
  });

  test("hung container rm fails closed and never attempts volume removal", async () => {
    const fake = new FakeDocker();
    fake.hangCommand("container rm");
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        {
          credentials: { username: "root", password: "private" },
          dockerCommandTimeoutMs: 5,
          cleanupTimeoutMs: 100,
        },
        async () => "operation complete",
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.stage).toBe("cleanup");
    expect(failure.code).toBe("owned_resource_cleanup_failed");
    expect(failure.evidence?.cleanup).toEqual({
      containerRemoved: false,
      volumeRemoved: false,
      timedOut: true,
      failures: ["container_remove", "cleanup_timeout"],
    });
    expect(fake.removalCommands().map((request) => request.args.slice(0, 2))).toEqual([
      ["container", "rm"],
    ]);
  });

  test("hung volume rm cannot produce successful cleanup evidence", async () => {
    const fake = new FakeDocker();
    fake.hangCommand("volume rm");
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        {
          credentials: { username: "root", password: "private" },
          dockerCommandTimeoutMs: 5,
          cleanupTimeoutMs: 100,
        },
        async () => "operation complete",
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.stage).toBe("cleanup");
    expect(failure.code).toBe("owned_resource_cleanup_failed");
    expect(failure.evidence?.cleanup).toEqual({
      containerRemoved: true,
      volumeRemoved: false,
      timedOut: true,
      failures: ["volume_remove", "cleanup_timeout"],
    });
  });

  test("aggregate cleanup deadline settles and marks all unproven removals false", async () => {
    const fake = new FakeDocker();
    // First inspect validates launch; the second is final state observation.
    fake.hangCommand("container inspect", 2);
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        {
          credentials: { username: "root", password: "private" },
          dockerCommandTimeoutMs: 100,
          cleanupTimeoutMs: 5,
        },
        async () => "operation complete",
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.stage).toBe("cleanup");
    expect(failure.code).toBe("owned_resource_cleanup_failed");
    expect(failure.evidence?.cleanup).toEqual({
      containerRemoved: false,
      volumeRemoved: false,
      timedOut: true,
      failures: ["container_inspect", "cleanup_timeout"],
    });
  });

  test("records observable OOM state and refuses to report success", async () => {
    const fake = new FakeDocker();
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        { credentials: { username: "root", password: "private" } },
        async () => {
          fake.markAttemptOom();
          return "callback completed";
        },
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.code).toBe("target_oom_killed");
    expect(failure.evidence?.observation.oomKilled).toBe(true);
    expect(failure.evidence?.observation.exitCode).toBe(137);
    expect(failure.evidence?.cleanup.containerRemoved).toBe(true);
    expect(failure.evidence?.cleanup.volumeRemoved).toBe(true);
  });

  test("refuses deletion when an exact-name target no longer proves ownership", async () => {
    const fake = new FakeDocker();
    let caught: unknown;
    try {
      await withIsolatedSurrealTarget(
        { credentials: { username: "root", password: "private" } },
        async () => {
          fake.replaceAttemptOwnership();
          return "ownership changed";
        },
        fake.dependencies(),
      );
    } catch (error) {
      caught = error;
    }
    const failure = lifecycleFailure(caught);
    expect(failure.stage).toBe("cleanup");
    expect(failure.code).toBe("owned_resource_cleanup_failed");
    expect(failure.evidence?.cleanup.containerRemoved).toBe(false);
    expect(failure.evidence?.cleanup.volumeRemoved).toBe(false);
    expect(fake.removalCommands()).toHaveLength(0);
    expect(fake.containers.has("baka-surrealdb")).toBe(true);
    expect(fake.volumes.has("production-data")).toBe(true);
  });
});
