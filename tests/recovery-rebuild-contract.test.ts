import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "../src/config.ts";
import {
  RECOVERY_PINNED_IMAGE,
  inspectStoppedCorruptProduction,
  removeRecoveryTarget,
  recoveryTargetEnvironment,
  recoveryTargetPlan,
  recoveryTargetRunArgs,
  startRecoveryTarget,
  type RecoveryDockerRequest,
  type RecoveryDockerResult,
  type RecoveryDockerRuntime,
} from "../src/backup/recovery-target.ts";
import {
  assertRecoveryBm25Probes,
  verifyRecoveryRelationalChecks,
  verifyRecoveryIndexTopology,
  verifyRecoverySearchSourceChunkOwnership,
} from "../src/backup/recovery-verification.ts";
import { PINNED_RESTORE_TARGET_IMAGE_DIGEST } from "../src/backup/restore-test.ts";

const TOKEN = "2".repeat(32);
const CONTAINER_ID = "3".repeat(64);
const IMAGE_ID = PINNED_RESTORE_TARGET_IMAGE_DIGEST;
const DATA_VOLUME = "4".repeat(64);
const LOGS_VOLUME = "5".repeat(64);

test("schema-5 recovery verifies migration ledger and quarantine references", async () => {
  const statements: string[] = [];
  const db = {
    query: async (sql: string) => {
      statements.push(sql);
      return [[{ n: 0 }]];
    },
  } as unknown as Surreal;

  await verifyRecoveryRelationalChecks(db);

  expect(statements.some((sql) => sql.includes("FROM migration_row_commit"))).toBe(true);
  expect(statements.some((sql) => sql.includes("FROM migration_quarantine"))).toBe(true);
});

function runtime(
  handler: (request: RecoveryDockerRequest) => RecoveryDockerResult | Promise<RecoveryDockerResult>,
): RecoveryDockerRuntime {
  return { run: async (request) => handler(request), now: () => 0, sleep: async () => {} };
}

type RecoveryPlan = ReturnType<typeof recoveryTargetPlan>;

function exactTargetInspection(
  plan: RecoveryPlan,
  overrides: {
    id?: string;
    running?: boolean;
    oomKilled?: boolean;
    exitCode?: number;
    healthcheck?: unknown;
    portBindings?: unknown;
    legacyHealth?: unknown;
  } = {},
): Record<string, unknown> {
  const running = overrides.running ?? true;
  const oomKilled = overrides.oomKilled ?? false;
  return {
    Id: overrides.id ?? CONTAINER_ID,
    Image: IMAGE_ID,
    Name: `/${plan.identity.stagingName}`,
    Config: {
      Image: plan.image,
      User: "0:0",
      Healthcheck: Object.hasOwn(overrides, "healthcheck")
        ? overrides.healthcheck
        : { Test: ["NONE"] },
      Labels: {
        "io.ai-baka.recovery.owner": "ai-baka",
        "io.ai-baka.recovery.attempt": plan.identity.token,
      },
    },
    HostConfig: {
      RestartPolicy: { Name: "no" },
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      Memory: plan.resources.memoryBytes,
      MemorySwap: plan.resources.memorySwapBytes,
      NanoCpus: Math.round(plan.resources.cpus * 1_000_000_000),
      PidsLimit: plan.resources.pidsLimit,
      PortBindings: overrides.portBindings ?? {
        "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }],
      },
    },
    State: {
      Running: running,
      OOMKilled: oomKilled,
      ExitCode: overrides.exitCode ?? (oomKilled ? 137 : 0),
      ...(overrides.legacyHealth === undefined ? {} : { Health: overrides.legacyHealth }),
    },
    Mounts: [
      { Type: "bind", Source: plan.dbRoot, Destination: "/data/db", RW: true },
      {
        Type: "bind",
        Source: plan.temporaryRoot,
        Destination: "/recovery-tmp",
        RW: true,
      },
      {
        Type: "volume",
        Driver: "local",
        Name: DATA_VOLUME,
        Destination: "/data",
        RW: true,
      },
      {
        Type: "volume",
        Driver: "local",
        Name: LOGS_VOLUME,
        Destination: "/logs",
        RW: true,
      },
    ],
  };
}

function recoveryLaunchHarness(
  plan: RecoveryPlan,
  behavior: {
    inspection?: (
      inspectionNo: number,
      setNow: (milliseconds: number) => void,
    ) => Record<string, unknown>;
    probe?: (
      probeNo: number,
      setNow: (milliseconds: number) => void,
    ) => RecoveryDockerResult;
  } = {},
): {
  docker: RecoveryDockerRuntime;
  requests: RecoveryDockerRequest[];
  sleeps: number[];
} {
  const requests: RecoveryDockerRequest[] = [];
  const sleeps: number[] = [];
  let now = 0;
  let inspectionNo = 0;
  let probeNo = 0;
  let removed = false;
  const setNow = (milliseconds: number): void => {
    now = milliseconds;
  };
  return {
    requests,
    sleeps,
    docker: {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      run: async (request) => {
        requests.push(request);
        if (request.args[0] === "container" && request.args[1] === "run") {
          return { exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "inspect") {
          if (removed) {
            return { exitCode: 1, stdout: "", stderr: "No such container" };
          }
          inspectionNo += 1;
          const item = behavior.inspection?.(inspectionNo, setNow) ??
            exactTargetInspection(plan);
          return { exitCode: 0, stdout: JSON.stringify([item]), stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "exec") {
          probeNo += 1;
          return behavior.probe?.(probeNo, setNow) ??
            { exitCode: 0, stdout: "ready\n", stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "stop") {
          return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "rm") {
          removed = true;
          return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
        }
        if (request.args[0] === "volume" && request.args[1] === "inspect") {
          const volumeName = request.args[2]!;
          return {
            exitCode: 1,
            stdout: "[]\n",
            stderr: `Error response from daemon: get ${volumeName}: no such volume\n`,
          };
        }
        throw new Error("unexpected Docker request");
      },
    },
  };
}

describe("recovery persistent target contract", () => {
  test("launch is exact-pinned, bind-mounted, bounded and has no credential values in argv", () => {
    const plan = recoveryTargetPlan({
      token: TOKEN,
      dbRoot: "/Volumes/Internal/baka-db",
      temporaryRoot: "/Volumes/Archive/Conversations/recovery/temp",
    });
    const args = recoveryTargetRunArgs(plan);
    const environment = recoveryTargetEnvironment(plan, {
      username: "secret-user",
      password: "secret-password",
    });
    expect(plan.image).toBe(RECOVERY_PINNED_IMAGE);
    expect(args).toContain("type=bind,src=/Volumes/Internal/baka-db,dst=/data/db");
    expect(args).toContain(
      "type=bind,src=/Volumes/Archive/Conversations/recovery/temp,dst=/recovery-tmp",
    );
    expect(args).toContain("127.0.0.1:8901:8000");
    expect(args).toContain("SURREAL_HTTP_MAX_IMPORT_BODY_SIZE");
    expect(args).not.toContain("SURREAL_INDEXING_BATCH_SIZE");
    expect(args).toContain("--no-healthcheck");
    expect(args).not.toContain("--health-cmd");
    expect(args).not.toContain("--health-interval");
    expect(args).not.toContain("--health-timeout");
    expect(args).not.toContain("--health-retries");
    expect(args).not.toContain("--health-start-period");
    expect(args.join("\0")).not.toMatch(/CMD-SHELL|\/bin\/sh/u);
    expect(args.join(" ")).not.toContain("secret-user");
    expect(args.join(" ")).not.toContain("secret-password");
    expect(environment.SURREAL_PASS).toBe("secret-password");
  });

  test("rejects the observed legacy CMD-SHELL /bin/sh health failure shape", async () => {
    const plan = recoveryTargetPlan({
      token: TOKEN,
      dbRoot: "/safe/new-db",
      temporaryRoot: "/safe/temp",
    });
    const harness = recoveryLaunchHarness(plan, {
      inspection: () => exactTargetInspection(plan, {
        healthcheck: {
          Test: [
            "CMD-SHELL",
            "/surreal is-ready --endpoint http://127.0.0.1:8000",
          ],
        },
        legacyHealth: {
          Status: "unhealthy",
          Log: [{
            ExitCode: 127,
            Output: "exec /bin/sh: no such file or directory",
          }],
        },
      }),
    });

    await expect(startRecoveryTarget(
      plan,
      { username: "u", password: "p" },
      harness.docker,
    )).rejects.toThrow("launch contract mismatch");

    const run = harness.requests.find((request) => request.args[1] === "run")!;
    expect(run.args).toContain("--no-healthcheck");
    expect(run.args).not.toContain("--health-cmd");
    expect(harness.requests.some((request) => request.args[1] === "exec")).toBe(false);
    expect(harness.requests.some((request) => request.args[1] === "rm" &&
      request.args.includes("--force") && request.args.includes("--volumes")))
      .toBe(true);
  });

  for (const portDrift of ["extra_key", "extra_binding"] as const) {
    test(`rejects staging PortBindings with ${portDrift}`, async () => {
      const plan = recoveryTargetPlan({
        token: TOKEN,
        dbRoot: "/safe/new-db",
        temporaryRoot: "/safe/temp",
      });
      const portBindings = portDrift === "extra_key"
        ? {
          "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }],
          "8001/tcp": [{ HostIp: "127.0.0.1", HostPort: "8902" }],
        }
        : {
          "8000/tcp": [
            { HostIp: "127.0.0.1", HostPort: "8901" },
            { HostIp: "127.0.0.1", HostPort: "18901" },
          ],
        };
      const harness = recoveryLaunchHarness(plan, {
        inspection: () => exactTargetInspection(plan, { portBindings }),
      });

      await expect(startRecoveryTarget(
        plan,
        { username: "u", password: "p" },
        harness.docker,
      )).rejects.toThrow("launch contract mismatch");
      expect(harness.requests.some((request) => request.args[1] === "exec")).toBe(false);
      expect(harness.requests.some((request) => request.args[1] === "rm" &&
        request.args.includes("--force") && request.args.includes("--volumes")))
        .toBe(true);
    });
  }

  for (const overdueOperation of ["inspect", "successful_probe"] as const) {
    test(`readiness rejects an overdue ${overdueOperation} at 150000ms`, async () => {
      const plan = recoveryTargetPlan({
        token: TOKEN,
        dbRoot: "/safe/new-db",
        temporaryRoot: "/safe/temp",
      });
      const harness = recoveryLaunchHarness(plan, {
        inspection: (inspectionNo, setNow) => {
          if (overdueOperation === "inspect" && inspectionNo === 1) setNow(150_000);
          return exactTargetInspection(plan);
        },
        probe: (_probeNo, setNow) => {
          if (overdueOperation === "successful_probe") setNow(150_000);
          return { exitCode: 0, stdout: "ready\n", stderr: "" };
        },
      });

      await expect(startRecoveryTarget(
        plan,
        { username: "u", password: "p" },
        harness.docker,
      )).rejects.toThrow("readiness deadline expired");

      const readinessRequests = harness.requests.filter((request) =>
        request.args[1] === "exec" ||
        (request.args[1] === "inspect" && request.timeoutMs !== undefined)
      );
      expect(readinessRequests.length).toBeGreaterThan(0);
      expect(readinessRequests.every((request) =>
        typeof request.timeoutMs === "number" && request.timeoutMs <= 30_000
      )).toBe(true);
      expect(harness.requests.some((request) => request.args[1] === "rm" &&
        request.args.includes("--force") && request.args.includes("--volumes")))
        .toBe(true);
      expect(harness.requests.filter((request) => request.args[0] === "volume").map(
        (request) => request.args[2],
      )).toEqual([DATA_VOLUME, LOGS_VOLUME]);
    });
  }

  for (const postProbeFailure of ["stopped", "identity_drift"] as const) {
    test(`failed readiness probe immediately detects ${postProbeFailure} before sleep`, async () => {
      const plan = recoveryTargetPlan({
        token: TOKEN,
        dbRoot: "/safe/new-db",
        temporaryRoot: "/safe/temp",
      });
      const driftedId = "a".repeat(64);
      const harness = recoveryLaunchHarness(plan, {
        inspection: (inspectionNo) => {
          if (inspectionNo < 3) return exactTargetInspection(plan);
          return postProbeFailure === "stopped"
            ? exactTargetInspection(plan, { running: false, exitCode: 1 })
            : exactTargetInspection(plan, { id: driftedId });
        },
        probe: () => ({ exitCode: 1, stdout: "", stderr: "not ready" }),
      });

      await expect(startRecoveryTarget(
        plan,
        { username: "u", password: "p" },
        harness.docker,
      )).rejects.toThrow(
        postProbeFailure === "stopped"
          ? "stopped before readiness"
          : "identity changed during readiness",
      );

      const probeIndex = harness.requests.findIndex((request) => request.args[1] === "exec");
      expect(probeIndex).toBeGreaterThan(0);
      expect(harness.requests[probeIndex + 1]?.args.slice(0, 2)).toEqual([
        "container",
        "inspect",
      ]);
      expect(harness.sleeps).toEqual([]);
      expect(harness.requests.some((request) => request.args[1] === "rm" &&
        request.args.includes("--force") && request.args.includes("--volumes")))
        .toBe(true);
      expect(harness.requests.filter((request) => request.args[0] === "volume")).toHaveLength(2);
    });
  }

  test("post-failure inspect and sleep are bounded to the final 500ms", async () => {
    const plan = recoveryTargetPlan({
      token: TOKEN,
      dbRoot: "/safe/new-db",
      temporaryRoot: "/safe/temp",
    });
    const harness = recoveryLaunchHarness(plan, {
      probe: (_probeNo, setNow) => {
        setNow(119_500);
        return { exitCode: 1, stdout: "", stderr: "not ready" };
      },
    });

    await expect(startRecoveryTarget(
      plan,
      { username: "u", password: "p" },
      harness.docker,
    )).rejects.toThrow("readiness deadline expired");

    const probeIndex = harness.requests.findIndex((request) => request.args[1] === "exec");
    const immediateInspection = harness.requests[probeIndex + 1];
    expect(immediateInspection?.args.slice(0, 2)).toEqual(["container", "inspect"]);
    expect(immediateInspection?.timeoutMs).toBe(500);
    expect(harness.sleeps).toEqual([500]);
    expect(harness.requests.some((request) => request.args[1] === "rm" &&
      request.args.includes("--force") && request.args.includes("--volumes")))
      .toBe(true);
  });

  test("readiness execs the pinned binary directly without a shell", async () => {
    const requests: RecoveryDockerRequest[] = [];
    const plan = recoveryTargetPlan({
      token: TOKEN,
      dbRoot: "/safe/new-db",
      temporaryRoot: "/safe/temp",
    });
    const dataVolume = "4".repeat(64);
    const logsVolume = "5".repeat(64);
    let readinessAttempts = 0;
    let now = 0;
    const inspection = {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      Name: `/${plan.identity.stagingName}`,
      Config: {
        Image: plan.image,
        User: "0:0",
        Healthcheck: { Test: ["NONE"] },
        Labels: {
          "io.ai-baka.recovery.owner": "ai-baka",
          "io.ai-baka.recovery.attempt": plan.identity.token,
        },
      },
      HostConfig: {
        RestartPolicy: { Name: "no" },
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        Memory: plan.resources.memoryBytes,
        MemorySwap: plan.resources.memorySwapBytes,
        NanoCpus: Math.round(plan.resources.cpus * 1_000_000_000),
        PidsLimit: plan.resources.pidsLimit,
        PortBindings: {
          "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }],
        },
      },
      State: { Running: true, OOMKilled: false, ExitCode: 0 },
      Mounts: [
        { Type: "bind", Source: plan.dbRoot, Destination: "/data/db", RW: true },
        {
          Type: "bind",
          Source: plan.temporaryRoot,
          Destination: "/recovery-tmp",
          RW: true,
        },
        {
          Type: "volume",
          Driver: "local",
          Name: dataVolume,
          Destination: "/data",
          RW: true,
        },
        {
          Type: "volume",
          Driver: "local",
          Name: logsVolume,
          Destination: "/logs",
          RW: true,
        },
      ],
    };
    const docker: RecoveryDockerRuntime = {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      run: async (request) => {
        requests.push(request);
        if (request.args[0] === "container" && request.args[1] === "run") {
          return { exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "inspect") {
          return { exitCode: 0, stdout: JSON.stringify([inspection]), stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "exec") {
          readinessAttempts += 1;
          return readinessAttempts === 1
            ? { exitCode: 1, stdout: "", stderr: "not ready" }
            : { exitCode: 0, stdout: "ready\n", stderr: "" };
        }
        throw new Error("unexpected Docker request");
      },
    };

    await expect(startRecoveryTarget(
      plan,
      { username: "secret-user", password: "secret-password" },
      docker,
    )).resolves.toMatchObject({
      id: CONTAINER_ID,
      anonymousVolumes: { data: dataVolume, logs: logsVolume },
    });

    const probes = requests.filter((request) => request.args[1] === "exec");
    expect(probes).toHaveLength(2);
    expect(probes.map((request) => request.args)).toEqual([
      [
        "container",
        "exec",
        plan.identity.stagingName,
        "/surreal",
        "is-ready",
        "--endpoint",
        "http://127.0.0.1:8000",
      ],
      [
        "container",
        "exec",
        plan.identity.stagingName,
        "/surreal",
        "is-ready",
        "--endpoint",
        "http://127.0.0.1:8000",
      ],
    ]);
    expect(probes.every((request) => request.timeoutMs === 30_000)).toBe(true);
    expect(probes.every((request) => request.env === undefined)).toBe(true);
    expect(JSON.stringify(probes)).not.toContain("secret-user");
    expect(JSON.stringify(probes)).not.toContain("secret-password");
    expect(requests.flatMap((request) => request.args).join("\0"))
      .not.toMatch(/CMD-SHELL|\/bin\/sh/u);
  });

  test("readiness fails closed on OOM and unconditionally removes the attempted target", async () => {
    const requests: RecoveryDockerRequest[] = [];
    const plan = recoveryTargetPlan({
      token: TOKEN,
      dbRoot: "/safe/new-db",
      temporaryRoot: "/safe/temp",
    });
    const dataVolume = "4".repeat(64);
    const logsVolume = "5".repeat(64);
    let oomKilled = false;
    let removed = false;
    let now = 0;
    const docker: RecoveryDockerRuntime = {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      run: async (request) => {
        requests.push(request);
        if (request.args[0] === "container" && request.args[1] === "run") {
          return { exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "inspect") {
          if (removed) {
            return { exitCode: 1, stdout: "", stderr: "No such container" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify([{
              Id: CONTAINER_ID,
              Image: IMAGE_ID,
              Name: `/${plan.identity.stagingName}`,
              Config: {
                Image: plan.image,
                User: "0:0",
                Healthcheck: { Test: ["NONE"] },
                Labels: {
                  "io.ai-baka.recovery.owner": "ai-baka",
                  "io.ai-baka.recovery.attempt": plan.identity.token,
                },
              },
              HostConfig: {
                RestartPolicy: { Name: "no" },
                ReadonlyRootfs: true,
                CapDrop: ["ALL"],
                Memory: plan.resources.memoryBytes,
                MemorySwap: plan.resources.memorySwapBytes,
                NanoCpus: Math.round(plan.resources.cpus * 1_000_000_000),
                PidsLimit: plan.resources.pidsLimit,
                PortBindings: {
                  "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }],
                },
              },
              State: { Running: !oomKilled, OOMKilled: oomKilled, ExitCode: oomKilled ? 137 : 0 },
              Mounts: [
                {
                  Type: "bind",
                  Source: plan.dbRoot,
                  Destination: "/data/db",
                  RW: true,
                },
                {
                  Type: "bind",
                  Source: plan.temporaryRoot,
                  Destination: "/recovery-tmp",
                  RW: true,
                },
                {
                  Type: "volume",
                  Driver: "local",
                  Name: dataVolume,
                  Destination: "/data",
                  RW: true,
                },
                {
                  Type: "volume",
                  Driver: "local",
                  Name: logsVolume,
                  Destination: "/logs",
                  RW: true,
                },
              ],
            }]),
            stderr: "",
          };
        }
        if (request.args[0] === "container" && request.args[1] === "exec") {
          oomKilled = true;
          return { exitCode: 137, stdout: "", stderr: "container stopped" };
        }
        if (request.args[0] === "container" && request.args[1] === "stop") {
          return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "rm") {
          removed = true;
          return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
        }
        if (request.args[0] === "volume" && request.args[1] === "inspect") {
          const volumeName = request.args[2]!;
          return {
            exitCode: 1,
            stdout: "[]\n",
            stderr: `Error response from daemon: get ${volumeName}: no such volume\n`,
          };
        }
        throw new Error("unexpected Docker request");
      },
    };

    await expect(startRecoveryTarget(
      plan,
      { username: "u", password: "p" },
      docker,
    )).rejects.toThrow("OOM-killed before readiness");
    expect(requests.some((request) => request.args[1] === "rm" &&
      request.args.includes("--force") && request.args.includes("--volumes")))
      .toBe(true);
    expect(requests.filter((request) => request.args[0] === "volume").map((request) =>
      request.args[2]
    )).toEqual([dataVolume, logsVolume]);
  });

  test("production must be exact-pinned, stopped, and bound to the supplied source root", async () => {
    const corrupt = "/Volumes/Archive/Conversations/db";
    const exactMounts = [
      { Type: "bind", Source: corrupt, Destination: "/data/db", RW: true },
      {
        Type: "volume",
        Driver: "local",
        Name: "6".repeat(64),
        Destination: "/data",
        RW: true,
      },
      {
        Type: "volume",
        Driver: "local",
        Name: "7".repeat(64),
        Destination: "/logs",
        RW: true,
      },
    ];
    const exact = {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      Name: "/baka-surrealdb",
      Config: { Image: RECOVERY_PINNED_IMAGE },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        PortBindings: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }] },
      },
      State: { Running: false },
      Mounts: exactMounts,
    };
    const evidence = await inspectStoppedCorruptProduction(corrupt, runtime(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify([exact]),
    })));
    expect(evidence.corruptDbRoot).toBe(corrupt);
    await expect(inspectStoppedCorruptProduction(corrupt, runtime(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify([{ ...exact, State: { Running: true } }]),
    })))).rejects.toThrow("identity mismatch");

    const currentInternal = "/Users/test/Library/Application Support/ai-baka/rocksdb";
    const internalEvidence = await inspectStoppedCorruptProduction(
      currentInternal,
      runtime(async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify([{
          ...exact,
          Mounts: exactMounts.map((mount) =>
            mount.Destination === "/data/db" ? { ...mount, Source: currentInternal } : mount
          ),
        }]),
      })),
    );
    expect(internalEvidence.corruptDbRoot).toBe(currentInternal);
    await expect(inspectStoppedCorruptProduction(currentInternal, runtime(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify([exact]),
    })))).rejects.toThrow("mount topology mismatch");
    await expect(inspectStoppedCorruptProduction(currentInternal, runtime(async () => ({
      exitCode: 1,
      stderr: "Error response from daemon: No such container: baka-surrealdb",
      stdout: "",
    })))).rejects.toThrow("Docker command failed");

    const drifted = [
      {
        ...exact,
        Mounts: [...exactMounts, {
          Type: "bind",
          Source: "/foreign",
          Destination: "/foreign",
          RW: true,
        }],
      },
      {
        ...exact,
        HostConfig: {
          ...exact.HostConfig,
          PortBindings: {
            ...exact.HostConfig.PortBindings,
            "8001/tcp": [{ HostIp: "127.0.0.1", HostPort: "8902" }],
          },
        },
      },
      {
        ...exact,
        HostConfig: {
          ...exact.HostConfig,
          RestartPolicy: { Name: "no" },
        },
      },
    ];
    for (const inspection of drifted) {
      await expect(inspectStoppedCorruptProduction(corrupt, runtime(async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify([inspection]),
      })))).rejects.toThrow(/topology|restart policy/u);
    }
  });

  test("failed launch validation force-removes staging", async () => {
    const requests: RecoveryDockerRequest[] = [];
    let removed = false;
    let remainingVolume: string | undefined;
    const plan = recoveryTargetPlan({
      token: TOKEN,
      dbRoot: "/safe/new-db",
      temporaryRoot: "/safe/temp",
    });
    const dataVolume = "4".repeat(64);
    const logsVolume = "5".repeat(64);
    const exactMounts = [
      { Type: "bind", Source: plan.dbRoot, Destination: "/data/db", RW: true },
      { Type: "bind", Source: plan.temporaryRoot, Destination: "/recovery-tmp", RW: true },
      {
        Type: "volume",
        Driver: "local",
        Name: dataVolume,
        Destination: "/data",
        RW: true,
      },
      {
        Type: "volume",
        Driver: "local",
        Name: logsVolume,
        Destination: "/logs",
        RW: true,
      },
    ];
    const failedLaunchRuntime = runtime(async (request) => {
      requests.push(request);
      if (request.args[0] === "container" && request.args[1] === "run") {
        return { exitCode: 0, stdout: CONTAINER_ID, stderr: "" };
      }
      if (request.args[0] === "container" && request.args[1] === "inspect") {
        if (removed) {
          return { exitCode: 1, stdout: "", stderr: "No such container" };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify([{
            Id: CONTAINER_ID,
            Image: IMAGE_ID,
            Name: `/${plan.identity.stagingName}`,
            // Mounts are exact, but this independent contract field is wrong.
            Config: {
              Image: plan.image,
              User: "1000:1000",
              Labels: {
                "io.ai-baka.recovery.owner": "ai-baka",
                "io.ai-baka.recovery.attempt": plan.identity.token,
              },
            },
            HostConfig: {
              RestartPolicy: { Name: "no" },
              ReadonlyRootfs: true,
              CapDrop: ["ALL"],
              Memory: plan.resources.memoryBytes,
              MemorySwap: plan.resources.memorySwapBytes,
              NanoCpus: Math.round(plan.resources.cpus * 1_000_000_000),
              PidsLimit: plan.resources.pidsLimit,
              PortBindings: {
                "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8901" }],
              },
            },
            State: { Running: true, Health: { Status: "starting" } },
            Mounts: exactMounts,
          }]),
        };
      }
      if (request.args[0] === "container" && request.args[1] === "stop") {
        return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
      }
      if (request.args[0] === "container" && request.args[1] === "rm") {
        removed = true;
        return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
      }
      if (request.args[0] === "volume" && request.args[1] === "inspect") {
        const name = request.args[2]!;
        if (remainingVolume === name) {
          return { exitCode: 0, stdout: JSON.stringify([{ Name: name }]), stderr: "" };
        }
        return {
          exitCode: 1,
          stdout: "[]\n",
          stderr: `Error response from daemon: get ${name}: no such volume\n`,
        };
      }
      throw new Error("unexpected Docker request");
    });
    await expect(startRecoveryTarget(
      plan,
      { username: "u", password: "p" },
      failedLaunchRuntime,
    )).rejects.toThrow("launch contract mismatch");
    expect(requests.some((request) =>
      request.args[1] === "rm" && request.args.includes("--force") &&
      request.args.includes("--volumes")
    )).toBe(true);
    expect(requests.some((request) =>
      request.args[1] === "stop" && request.args.at(-1) === plan.identity.stagingName
    )).toBe(true);
    expect(requests.filter((request) => request.args[0] === "volume").map((request) =>
      request.args
    )).toEqual([
      ["volume", "inspect", dataVolume],
      ["volume", "inspect", logsVolume],
    ]);

    requests.length = 0;
    removed = false;
    remainingVolume = dataVolume;
    await expect(startRecoveryTarget(
      plan,
      { username: "u", password: "p" },
      failedLaunchRuntime,
    )).rejects.toThrow("launch and cleanup both failed");
    expect(requests.filter((request) => request.args[0] === "volume")).toHaveLength(2);
  });

  for (const runFailure of ["nonzero", "ambiguous_throw"] as const) {
    test(`a ${runFailure} docker run still performs exact-name cleanup proofs`, async () => {
      const requests: Array<readonly string[]> = [];
      const plan = recoveryTargetPlan({
        token: TOKEN,
        dbRoot: "/safe/new-db",
        temporaryRoot: "/safe/temp",
      });
      const dataVolume = "4".repeat(64);
      const logsVolume = "5".repeat(64);
      let removed = false;
      const exactInspection = {
        Id: CONTAINER_ID,
        Image: IMAGE_ID,
        Name: `/${plan.identity.stagingName}`,
        Config: {
          Image: plan.image,
          Labels: {
            "io.ai-baka.recovery.owner": "ai-baka",
            "io.ai-baka.recovery.attempt": plan.identity.token,
          },
        },
        State: { Running: true },
        Mounts: [
          { Type: "bind", Source: plan.dbRoot, Destination: "/data/db", RW: true },
          {
            Type: "bind",
            Source: plan.temporaryRoot,
            Destination: "/recovery-tmp",
            RW: true,
          },
          {
            Type: "volume",
            Driver: "local",
            Name: dataVolume,
            Destination: "/data",
            RW: true,
          },
          {
            Type: "volume",
            Driver: "local",
            Name: logsVolume,
            Destination: "/logs",
            RW: true,
          },
        ],
      };
      const docker = runtime(async (request) => {
        requests.push(request.args);
        if (request.args[1] === "run") {
          if (runFailure === "ambiguous_throw") throw new Error("daemon reply lost");
          return { exitCode: 125, stdout: "", stderr: "ambiguous post-create failure" };
        }
        if (request.args[0] === "container" && request.args[1] === "inspect") {
          return removed
            ? { exitCode: 1, stdout: "", stderr: "No such container" }
            : { exitCode: 0, stdout: JSON.stringify([exactInspection]), stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "stop") {
          return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
        }
        if (request.args[0] === "container" && request.args[1] === "rm") {
          removed = true;
          return { exitCode: 0, stdout: plan.identity.stagingName, stderr: "" };
        }
        if (request.args[0] === "volume" && request.args[1] === "inspect") {
          const volumeName = request.args[2]!;
          return {
            exitCode: 1,
            stdout: "[]\n",
            stderr: `Error response from daemon: get ${volumeName}: no such volume\n`,
          };
        }
        throw new Error("unexpected Docker request");
      });

      await expect(startRecoveryTarget(
        plan,
        { username: "u", password: "p" },
        docker,
      )).rejects.toThrow(runFailure === "nonzero" ? "Docker command failed" : "reply lost");

      expect(requests.map((args) => args.slice(0, 2))).toEqual([
        ["container", "run"],
        ["container", "inspect"],
        ["container", "stop"],
        ["container", "rm"],
        ["container", "inspect"],
        ["volume", "inspect"],
        ["volume", "inspect"],
      ]);
      expect(requests[2]?.at(-1)).toBe(plan.identity.stagingName);
      expect(requests[3]).toEqual([
        "container",
        "rm",
        "--force",
        "--volumes",
        plan.identity.stagingName,
      ]);
      expect(requests.some((args) => args.includes("prune"))).toBe(false);
      expect(requests.filter((args) => args[0] === "volume").every((args) =>
        args[1] === "inspect"
      )).toBe(true);
    });
  }

  test("normal cleanup proves four mounts and removes both anonymous volumes", async () => {
    const plan = recoveryTargetPlan({
      token: TOKEN,
      dbRoot: "/safe/new-db",
      temporaryRoot: "/safe/temp",
    });
    const target = {
      id: CONTAINER_ID,
      name: plan.identity.stagingName,
      dbRoot: plan.dbRoot,
      temporaryRoot: plan.temporaryRoot,
      image: plan.image,
      hostPort: plan.hostPort,
      anonymousVolumes: {
        data: "4".repeat(64),
        logs: "5".repeat(64),
      },
    };
    const exactMounts = [
      { Type: "bind", Source: plan.dbRoot, Destination: "/data/db", RW: true },
      { Type: "bind", Source: plan.temporaryRoot, Destination: "/recovery-tmp", RW: true },
      {
        Type: "volume",
        Driver: "local",
        Name: "4".repeat(64),
        Destination: "/data",
        RW: true,
      },
      {
        Type: "volume",
        Driver: "local",
        Name: "5".repeat(64),
        Destination: "/logs",
        RW: true,
      },
    ];
    const makeRuntime = (
      mounts: unknown[],
      volumeOutcome: {
        remaining?: string;
        ambiguous?: string;
        legacyEmptyStdout?: string;
        wrongIdentity?: string;
      } = {},
    ) => {
      const requests: Array<readonly string[]> = [];
      let removed = false;
      return {
        requests,
        docker: runtime(async (request) => {
          requests.push(request.args);
          if (request.args[0] === "container" && request.args[1] === "inspect") {
            return removed
              ? { exitCode: 1, stdout: "", stderr: "No such container" }
              : {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify([{
                  Id: CONTAINER_ID,
                  Image: IMAGE_ID,
                  Name: `/${plan.identity.stagingName}`,
                  Config: { Image: plan.image },
                  State: { Running: false },
                  Mounts: mounts,
                }]),
              };
          }
          if (request.args[0] === "container" && request.args[1] === "rm") {
            removed = true;
            return { exitCode: 0, stdout: CONTAINER_ID, stderr: "" };
          }
          if (request.args[0] === "volume" && request.args[1] === "inspect") {
            const name = request.args[2]!;
            if (volumeOutcome.remaining === name) {
              return { exitCode: 0, stdout: JSON.stringify([{ Name: name }]), stderr: "" };
            }
            if (volumeOutcome.ambiguous === name) {
              return { exitCode: 1, stdout: "", stderr: "daemon unavailable" };
            }
            if (volumeOutcome.legacyEmptyStdout === name) {
              return {
                exitCode: 1,
                stdout: "",
                stderr: `Error response from daemon: get ${name}: no such volume\n`,
              };
            }
            if (volumeOutcome.wrongIdentity === name) {
              return {
                exitCode: 1,
                stdout: "[]\n",
                stderr: `Error response from daemon: get ${"f".repeat(64)}: no such volume\n`,
              };
            }
            return {
              exitCode: 1,
              stdout: "[]\n",
              stderr: `Error response from daemon: get ${name}: no such volume\n`,
            };
          }
          throw new Error("unexpected Docker request");
        }),
      };
    };
    const normal = makeRuntime(exactMounts);
    await removeRecoveryTarget(target, { force: false }, normal.docker);
    expect(normal.requests).toContainEqual([
      "container",
      "rm",
      "--volumes",
      plan.identity.stagingName,
    ]);
    expect(normal.requests.filter((args) => args[0] === "volume")).toEqual([
      ["volume", "inspect", target.anonymousVolumes.data],
      ["volume", "inspect", target.anonymousVolumes.logs],
    ]);

    const extraMount = makeRuntime([...exactMounts, {
      Type: "bind",
      Source: "/foreign",
      Destination: "/foreign",
      RW: true,
    }]);
    await expect(removeRecoveryTarget(
      target,
      { force: false },
      extraMount.docker,
    )).rejects.toThrow("exact allowlist");
    expect(extraMount.requests.some((args) => args[1] === "rm")).toBe(false);

    const remaining = makeRuntime(exactMounts, { remaining: target.anonymousVolumes.data });
    await expect(removeRecoveryTarget(target, { force: false }, remaining.docker))
      .rejects.toThrow("volume cleanup evidence is incomplete");
    expect(remaining.requests.filter((args) => args[0] === "volume")).toHaveLength(2);

    const ambiguous = makeRuntime(exactMounts, { ambiguous: target.anonymousVolumes.logs });
    await expect(removeRecoveryTarget(target, { force: false }, ambiguous.docker))
      .rejects.toThrow("volume cleanup evidence is incomplete");
    expect(ambiguous.requests.filter((args) => args[0] === "volume")).toHaveLength(2);
    expect(ambiguous.requests.some((args) =>
      args[0] === "volume" && args[1] !== "inspect"
    )).toBe(false);

    const nonDocker28Output = makeRuntime(exactMounts, {
      legacyEmptyStdout: target.anonymousVolumes.data,
    });
    await expect(removeRecoveryTarget(target, { force: false }, nonDocker28Output.docker))
      .rejects.toThrow("volume cleanup evidence is incomplete");
    expect(nonDocker28Output.requests.filter((args) => args[0] === "volume"))
      .toHaveLength(2);

    const wrongIdentity = makeRuntime(exactMounts, {
      wrongIdentity: target.anonymousVolumes.logs,
    });
    await expect(removeRecoveryTarget(target, { force: false }, wrongIdentity.docker))
      .rejects.toThrow("volume cleanup evidence is incomplete");
    expect(wrongIdentity.requests.some((args) =>
      args[0] === "volume" && args[1] !== "inspect"
    )).toBe(false);
  });
});

describe("recovery FULLTEXT topology proof", () => {
  const cfg = {
    surrealUrl: "ws://127.0.0.1:8901/rpc",
    surrealUser: "root",
    surrealPass: "secret",
    surrealNamespace: "baka",
    surrealDatabase: "archive",
  } as AppConfig;

  function response(indexes: Record<string, unknown>): Response {
    return new Response(JSON.stringify([{ status: "OK", result: { indexes } }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  test("accepts the exact core index and proves chunk_content absent", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const statement = String(init?.body);
      return statement.includes("search_document")
        ? response({
          search_document_content: {
            sql: "DEFINE INDEX search_document_content ON TABLE search_document FIELDS content " +
              "FULLTEXT ANALYZER archive_mixed BM25 (1.2, 0.75) HIGHLIGHTS CONCURRENTLY",
          },
        })
        : response({});
    };
    const proof = await verifyRecoveryIndexTopology(cfg, fetchImpl as typeof fetch);
    expect(proof.ready).toBe(true);
    expect(proof.chunkContentAbsent).toBe(true);
  });

  test("rejects a legacy chunk_content index", async () => {
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const statement = String(init?.body);
      return statement.includes("search_document")
        ? response({
          search_document_content: {
            sql: "DEFINE INDEX search_document_content ON search_document FIELDS content " +
              "FULLTEXT ANALYZER archive_mixed BM25 HIGHLIGHTS",
          },
        })
        : response({ chunk_content: { sql: "forbidden" } });
    };
    await expect(verifyRecoveryIndexTopology(cfg, fetchImpl as typeof fetch))
      .rejects.toThrow("forbidden chunk_content");
  });
});

describe("recovery data verification contract", () => {
  test("source_chunks must exist and belong to the document dialogue/revision", async () => {
    const query = async (sql: string) => {
      if (sql.includes("FROM chunk")) {
        return [[
          { id: "chunk:one", dialogue: "dialogue:a", dialogue_revision: "revision:a" },
          { id: "chunk:two", dialogue: "dialogue:b", dialogue_revision: "revision:b" },
        ]];
      }
      if (sql.includes("FROM search_document")) {
        return [[{
          dialogue: "dialogue:a",
          dialogue_revision: "revision:a",
          source_chunks: ["chunk:one"],
        }]];
      }
      throw new Error("unexpected query");
    };
    const validDb = { query } as unknown as Surreal;
    await expect(verifyRecoverySearchSourceChunkOwnership(validDb)).resolves.toEqual({
      documentsChecked: 1,
      referencesChecked: 1,
      valid: true,
    });

    const wrongOwnerDb = {
      query: async (sql: string) => sql.includes("FROM chunk")
        ? query(sql)
        : [[{
          dialogue: "dialogue:a",
          dialogue_revision: "revision:a",
          source_chunks: ["chunk:two"],
        }]],
    } as unknown as Surreal;
    await expect(verifyRecoverySearchSourceChunkOwnership(wrongOwnerDb))
      .rejects.toThrow("source_chunks ownership");
  });

  test("requires the first two deterministic successful BM25 probes", () => {
    const two = [
      { name: "search: probe_1", ok: true, detail: "hash one" },
      { name: "search: probe_2", ok: true, detail: "hash two" },
      { name: "search probes", ok: true, detail: "2/2" },
    ];
    expect(() => assertRecoveryBm25Probes(two, 2)).not.toThrow();
    expect(() => assertRecoveryBm25Probes(two.slice(0, 1), 2))
      .toThrow("at least two deterministic");
    expect(() => assertRecoveryBm25Probes(two, 0)).toThrow("nonempty search corpus");
  });
});
