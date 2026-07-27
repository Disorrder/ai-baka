/**
 * Persistent SurrealDB target used only by `recovery:rebuild`.
 *
 * Unlike the disposable restore-test target, this target bind-mounts a fresh
 * operator-selected POSIX filesystem directory which becomes the production
 * store after verification. The corrupt production container and its bind
 * source are inspected read-only and are never started or changed here.
 */

import path from "node:path";
import {
  DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE,
  type IsolatedTargetResourceProfile,
} from "./isolated-target.ts";
import {
  PINNED_RESTORE_TARGET_IMAGE_DIGEST,
  PINNED_RESTORE_TARGET_VERSION,
} from "./restore-test.ts";

const MAX_OUTPUT_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 120_000;
const READINESS_POLL_MS = 1_000;
const PRODUCTION_NAME = "baka-surrealdb";
const PRODUCTION_PORT = 8901;
const CONTAINER_PORT = 8000;

export const RECOVERY_PINNED_IMAGE =
  `surrealdb/surrealdb:v${PINNED_RESTORE_TARGET_VERSION}@${PINNED_RESTORE_TARGET_IMAGE_DIGEST}`;

export interface RecoveryTargetIdentity {
  token: string;
  stagingName: string;
}

export interface RecoveryTargetPlan {
  image: typeof RECOVERY_PINNED_IMAGE;
  identity: RecoveryTargetIdentity;
  dbRoot: string;
  temporaryRoot: string;
  hostPort: 8901;
  resources: IsolatedTargetResourceProfile;
}

export interface RecoveryDockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RecoveryDockerRequest {
  args: readonly string[];
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

export interface RecoveryDockerRuntime {
  run(request: RecoveryDockerRequest): Promise<RecoveryDockerResult>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface StoppedProductionEvidence {
  id: string;
  imageId: typeof PINNED_RESTORE_TARGET_IMAGE_DIGEST;
  corruptDbRoot: string;
}

export interface RecoveryAnonymousVolumes {
  data: string;
  logs: string;
}

export interface RecoveryTargetEvidence {
  id: string;
  name: string;
  dbRoot: string;
  temporaryRoot: string;
  image: typeof RECOVERY_PINNED_IMAGE;
  hostPort: 8901;
  anonymousVolumes: RecoveryAnonymousVolumes;
}

export interface StoppedRecoveryEvidence extends RecoveryTargetEvidence {
  oomKilled: false;
  exitCode: 0;
}

interface DockerInspection {
  Id?: unknown;
  Image?: unknown;
  Name?: unknown;
  Config?: {
    Image?: unknown;
    User?: unknown;
    Labels?: unknown;
    Healthcheck?: unknown;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: unknown };
    Memory?: unknown;
    MemorySwap?: unknown;
    NanoCpus?: unknown;
    PidsLimit?: unknown;
    ReadonlyRootfs?: unknown;
    CapDrop?: unknown;
    PortBindings?: unknown;
  };
  Mounts?: unknown;
  State?: {
    Running?: unknown;
    OOMKilled?: unknown;
    ExitCode?: unknown;
  };
}

function safeEnvironment(extra: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...Object.fromEntries(
      [
        "PATH",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
      ]
        .map((name) => [name, process.env[name]])
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ...extra,
  };
}

async function boundedText(
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
  budget: { bytes: number },
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (budget.bytes + item.value.byteLength > MAX_OUTPUT_BYTES) {
        stop();
        throw new Error("recovery docker output exceeded its bound");
      }
      budget.bytes += item.value.byteLength;
      length += item.value.byteLength;
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function runDocker(request: RecoveryDockerRequest): Promise<RecoveryDockerResult> {
  const timeoutMs = request.timeoutMs ?? COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) {
    throw new Error("recovery docker timeout is invalid");
  }
  const child = Bun.spawn({
    cmd: ["docker", ...request.args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: safeEnvironment(request.env ?? {}),
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    child.kill();
    throw new Error("recovery docker streams are unavailable");
  }
  const stop = () => {
    try {
      child.kill();
    } catch {
      // The process may already be gone.
    }
  };
  const timer = setTimeout(stop, timeoutMs);
  const budget = { bytes: 0 };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      boundedText(child.stdout, stop, budget),
      boundedText(child.stderr, stop, budget),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_RECOVERY_DOCKER_RUNTIME: RecoveryDockerRuntime = {
  run: runDocker,
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function assertToken(token: string): string {
  if (!/^[0-9a-f]{32}$/u.test(token)) throw new Error("recovery token must be 32 lowercase hex");
  return token;
}

export function recoveryTargetIdentity(tokenInput: string): RecoveryTargetIdentity {
  const token = assertToken(tokenInput);
  return {
    token,
    stagingName: `baka-recovery-stage-${token}`,
  };
}

export function recoveryTargetPlan(input: {
  token: string;
  dbRoot: string;
  temporaryRoot: string;
  image?: string;
  resources?: IsolatedTargetResourceProfile;
}): RecoveryTargetPlan {
  if ((input.image ?? RECOVERY_PINNED_IMAGE) !== RECOVERY_PINNED_IMAGE) {
    throw new Error("recovery target requires the exact pinned SurrealDB image");
  }
  const dbRoot = path.resolve(input.dbRoot);
  const temporaryRoot = path.resolve(input.temporaryRoot);
  if (dbRoot === temporaryRoot) throw new Error("recovery DB and temporary roots must differ");
  return {
    image: RECOVERY_PINNED_IMAGE,
    identity: recoveryTargetIdentity(input.token),
    dbRoot,
    temporaryRoot,
    hostPort: PRODUCTION_PORT,
    resources: { ...(input.resources ?? DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE) },
  };
}

/** Pure argv contract: credentials are inherited by name and never enter argv. */
export function recoveryTargetRunArgs(plan: RecoveryTargetPlan): string[] {
  const { resources } = plan;
  return [
    "container",
    "run",
    "--detach",
    "--pull",
    "missing",
    "--name",
    plan.identity.stagingName,
    "--label",
    "io.ai-baka.recovery.owner=ai-baka",
    "--label",
    `io.ai-baka.recovery.attempt=${plan.identity.token}`,
    "--restart",
    "no",
    "--network",
    "bridge",
    "--publish",
    `127.0.0.1:${plan.hostPort}:${CONTAINER_PORT}`,
    "--mount",
    `type=bind,src=${plan.dbRoot},dst=/data/db`,
    "--mount",
    `type=bind,src=${plan.temporaryRoot},dst=/recovery-tmp`,
    "--read-only",
    "--init",
    "--user",
    "0:0",
    "--security-opt",
    "no-new-privileges=true",
    "--cap-drop",
    "ALL",
    "--memory",
    String(resources.memoryBytes),
    "--memory-swap",
    String(resources.memorySwapBytes),
    "--cpus",
    String(resources.cpus),
    "--pids-limit",
    String(resources.pidsLimit),
    "--stop-timeout",
    "60",
    // Docker CLI serializes --health-cmd as CMD-SHELL. The pinned image is
    // distroless and deliberately has no /bin/sh, so disable image healthchecks
    // as well and poll the pinned binary with `docker container exec` below.
    "--no-healthcheck",
    ...[
      "SURREAL_USER",
      "SURREAL_PASS",
      "SURREAL_HTTP_MAX_IMPORT_BODY_SIZE",
      "SURREAL_ROCKSDB_BLOCK_CACHE_SIZE",
      "SURREAL_ROCKSDB_THREAD_COUNT",
      "SURREAL_ROCKSDB_JOBS_COUNT",
      "SURREAL_ROCKSDB_MAX_CONCURRENT_SUBCOMPACTIONS",
      "SURREAL_HNSW_CACHE_SIZE",
      "SURREAL_MEMORY_THRESHOLD",
      "SURREAL_DURABLE_SESSIONS",
      "SURREAL_TEMPORARY_DIRECTORY",
    ].flatMap((name) => ["--env", name]),
    plan.image,
    "start",
    "--no-banner",
    "--log",
    "warn",
    "--bind",
    `0.0.0.0:${CONTAINER_PORT}`,
    "--index-build-resume-interval",
    "0",
    "rocksdb:///data/db",
  ];
}

export function recoveryTargetEnvironment(
  plan: RecoveryTargetPlan,
  credentials: { username: string; password: string },
): Record<string, string> {
  if (!credentials.username || !credentials.password) {
    throw new Error("recovery target credentials are required");
  }
  const resources = plan.resources;
  return {
    SURREAL_USER: credentials.username,
    SURREAL_PASS: credentials.password,
    SURREAL_HTTP_MAX_IMPORT_BODY_SIZE: String(resources.httpMaxImportBodyBytes),
    SURREAL_ROCKSDB_BLOCK_CACHE_SIZE: String(resources.rocksDbBlockCacheBytes),
    SURREAL_ROCKSDB_THREAD_COUNT: String(resources.rocksDbThreadCount),
    SURREAL_ROCKSDB_JOBS_COUNT: String(resources.rocksDbJobsCount),
    SURREAL_ROCKSDB_MAX_CONCURRENT_SUBCOMPACTIONS: String(
      resources.rocksDbMaxConcurrentSubcompactions,
    ),
    SURREAL_HNSW_CACHE_SIZE: String(resources.hnswCacheBytes),
    SURREAL_MEMORY_THRESHOLD: String(resources.memoryThresholdBytes),
    SURREAL_DURABLE_SESSIONS: "false",
    SURREAL_TEMPORARY_DIRECTORY: "/recovery-tmp/server",
  };
}

async function dockerOk(
  runtime: RecoveryDockerRuntime,
  args: readonly string[],
  options: { timeoutMs?: number; env?: Readonly<Record<string, string>> } = {},
): Promise<string> {
  const result = await runtime.run({ args, ...options });
  if (result.exitCode !== 0) throw new Error("recovery Docker command failed");
  return result.stdout.trim();
}

async function inspect(
  runtime: RecoveryDockerRuntime,
  target: string,
  options: { timeoutMs?: number } = {},
): Promise<DockerInspection> {
  const output = await dockerOk(
    runtime,
    ["container", "inspect", target],
    options,
  );
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] ||
        typeof parsed[0] !== "object" || Array.isArray(parsed[0])) throw new Error();
    return parsed[0] as DockerInspection;
  } catch {
    throw new Error("recovery Docker inspect returned invalid JSON");
  }
}

async function assertContainerAbsent(
  runtime: RecoveryDockerRuntime,
  target: string,
): Promise<void> {
  const result = await runtime.run({ args: ["container", "inspect", target] });
  if (result.exitCode !== 1 || !/No such (?:object|container)/iu.test(result.stderr)) {
    throw new Error("recovery staging container absence was not proven");
  }
}

async function assertVolumeAbsent(
  runtime: RecoveryDockerRuntime,
  volumeName: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(volumeName)) {
    throw new Error("recovery anonymous volume identity is invalid");
  }
  const result = await runtime.run({ args: ["volume", "inspect", volumeName] });
  const exactLine = (actual: string, expected: string): boolean =>
    actual === expected || actual === `${expected}\n`;
  const missingMessage =
    `Error response from daemon: get ${volumeName}: no such volume`;
  if (
    result.exitCode !== 1 || !exactLine(result.stdout, "[]") ||
    !exactLine(result.stderr, missingMessage)
  ) {
    throw new Error("recovery anonymous volume absence was not proven");
  }
}

async function assertAnonymousVolumesAbsent(
  runtime: RecoveryDockerRuntime,
  volumes: RecoveryAnonymousVolumes,
): Promise<void> {
  const failures: unknown[] = [];
  for (const volumeName of [volumes.data, volumes.logs]) {
    try {
      await assertVolumeAbsent(runtime, volumeName);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "recovery anonymous volume cleanup evidence is incomplete",
    );
  }
}

function mounts(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object")) {
    throw new Error("recovery container mounts are invalid");
  }
  return value as Array<Record<string, unknown>>;
}

function recoveryMounts(
  value: unknown,
  dbRoot: string,
  temporaryRoot: string,
): RecoveryAnonymousVolumes {
  const targetMounts = mounts(value);
  const byDestination = new Map(
    targetMounts.map((mount) => [mount.Destination, mount]),
  );
  const db = byDestination.get("/data/db");
  const temporary = byDestination.get("/recovery-tmp");
  const anonymousData = byDestination.get("/data");
  const anonymousLogs = byDestination.get("/logs");
  const safeAnonymousVolume = (mount: Record<string, unknown> | undefined): boolean =>
    mount?.Type === "volume" && mount.Driver === "local" && mount.RW === true &&
    typeof mount.Name === "string" && /^[0-9a-f]{64}$/u.test(mount.Name);
  if (
    targetMounts.length !== 4 || byDestination.size !== 4 ||
    db?.Type !== "bind" || db.RW !== true || db.Source !== dbRoot ||
    temporary?.Type !== "bind" || temporary.RW !== true ||
    temporary.Source !== temporaryRoot ||
    !safeAnonymousVolume(anonymousData) || !safeAnonymousVolume(anonymousLogs) ||
    anonymousData?.Name === anonymousLogs?.Name
  ) {
    throw new Error("recovery container mounts are not the exact allowlist");
  }
  return {
    data: anonymousData!.Name as string,
    logs: anonymousLogs!.Name as string,
  };
}

function stoppedProductionTopology(item: DockerInspection, corruptDbRoot: string): void {
  const productionMounts = mounts(item.Mounts);
  const byDestination = new Map(
    productionMounts.map((mount) => [mount.Destination, mount]),
  );
  const db = byDestination.get("/data/db");
  const anonymousData = byDestination.get("/data");
  const anonymousLogs = byDestination.get("/logs");
  const safeAnonymousVolume = (mount: Record<string, unknown> | undefined): boolean =>
    mount?.Type === "volume" && mount.Driver === "local" && mount.RW === true &&
    typeof mount.Name === "string" && /^[0-9a-f]{64}$/u.test(mount.Name);
  if (
    productionMounts.length !== 3 || byDestination.size !== 3 ||
    db?.Type !== "bind" || db.RW !== true || db.Source !== corruptDbRoot ||
    !safeAnonymousVolume(anonymousData) || !safeAnonymousVolume(anonymousLogs) ||
    anonymousData?.Name === anonymousLogs?.Name
  ) {
    throw new Error("stopped corrupt production mount topology mismatch");
  }

  const bindings = item.HostConfig?.PortBindings as
    | Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
    | undefined;
  const published = bindings?.[`${CONTAINER_PORT}/tcp`];
  if (
    !bindings || Object.keys(bindings).length !== 1 ||
    !Array.isArray(published) || published.length !== 1 ||
    published[0]?.HostIp !== "127.0.0.1" || published[0]?.HostPort !== "8901"
  ) {
    throw new Error("stopped corrupt production port topology mismatch");
  }
  if (item.HostConfig?.RestartPolicy?.Name !== "unless-stopped") {
    throw new Error("stopped corrupt production restart policy mismatch");
  }
}

function exactImageId(): typeof PINNED_RESTORE_TARGET_IMAGE_DIGEST {
  return PINNED_RESTORE_TARGET_IMAGE_DIGEST;
}

export async function inspectStoppedCorruptProduction(
  corruptDbRootInput: string,
  runtime: RecoveryDockerRuntime = DEFAULT_RECOVERY_DOCKER_RUNTIME,
): Promise<StoppedProductionEvidence> {
  const corruptDbRoot = path.resolve(corruptDbRootInput);
  const item = await inspect(runtime, PRODUCTION_NAME);
  if (
    typeof item.Id !== "string" || !/^[0-9a-f]{64}$/u.test(item.Id) ||
    item.Name !== `/${PRODUCTION_NAME}` || item.Image !== exactImageId() ||
    item.Config?.Image !== RECOVERY_PINNED_IMAGE || item.State?.Running !== false
  ) {
    throw new Error("stopped corrupt production identity mismatch");
  }
  stoppedProductionTopology(item, corruptDbRoot);
  return { id: item.Id, imageId: exactImageId(), corruptDbRoot };
}

function assertTargetInspection(
  item: DockerInspection,
  plan: RecoveryTargetPlan,
  anonymousVolumes: RecoveryAnonymousVolumes,
): RecoveryTargetEvidence {
  const bindings = item.HostConfig?.PortBindings as
    | Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
    | undefined;
  const published = bindings?.[`${CONTAINER_PORT}/tcp`];
  const resources = plan.resources;
  const healthcheck = item.Config?.Healthcheck;
  const disabledHealthcheck = healthcheck === undefined || healthcheck === null ||
    (typeof healthcheck === "object" && !Array.isArray(healthcheck) &&
      Array.isArray((healthcheck as { Test?: unknown }).Test) &&
      ((healthcheck as { Test: unknown[] }).Test.length === 1) &&
      (healthcheck as { Test: unknown[] }).Test[0] === "NONE");
  if (
    typeof item.Id !== "string" || !/^[0-9a-f]{64}$/u.test(item.Id) ||
    item.Name !== `/${plan.identity.stagingName}` || item.Image !== exactImageId() ||
    item.Config?.Image !== plan.image || item.Config.User !== "0:0" ||
    !disabledHealthcheck ||
    item.HostConfig?.RestartPolicy?.Name !== "no" ||
    item.HostConfig.ReadonlyRootfs !== true ||
    !Array.isArray(item.HostConfig.CapDrop) || !item.HostConfig.CapDrop.includes("ALL") ||
    item.HostConfig.Memory !== resources.memoryBytes ||
    item.HostConfig.MemorySwap !== resources.memorySwapBytes ||
    item.HostConfig.NanoCpus !== Math.round(resources.cpus * 1_000_000_000) ||
    item.HostConfig.PidsLimit !== resources.pidsLimit ||
    !bindings || Object.keys(bindings).length !== 1 ||
    !Array.isArray(published) || published.length !== 1 ||
    published[0]?.HostIp !== "127.0.0.1" || published[0]?.HostPort !== "8901"
  ) {
    throw new Error("recovery target launch contract mismatch");
  }
  return {
    id: item.Id,
    name: plan.identity.stagingName,
    dbRoot: plan.dbRoot,
    temporaryRoot: plan.temporaryRoot,
    image: plan.image,
    hostPort: plan.hostPort,
    anonymousVolumes,
  };
}

function readinessOperationTimeout(
  runtime: RecoveryDockerRuntime,
  deadline: number,
): number {
  const remainingMs = deadline - runtime.now();
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
    throw new Error("recovery target readiness deadline expired");
  }
  return Math.min(COMMAND_TIMEOUT_MS, remainingMs);
}

async function inspectBeforeReadinessDeadline(
  runtime: RecoveryDockerRuntime,
  target: string,
  deadline: number,
): Promise<DockerInspection> {
  const item = await inspect(runtime, target, {
    timeoutMs: readinessOperationTimeout(runtime, deadline),
  });
  // A Docker command may acknowledge after its requested timeout in an
  // ambiguous daemon/transport failure. Never accept such late evidence.
  readinessOperationTimeout(runtime, deadline);
  return item;
}

function assertReadinessInspection(
  item: DockerInspection,
  plan: RecoveryTargetPlan,
  expectedId: string,
  expectedVolumes: RecoveryAnonymousVolumes,
): void {
  const volumes = recoveryMounts(item.Mounts, plan.dbRoot, plan.temporaryRoot);
  assertTargetInspection(item, plan, volumes);
  if (
    item.Id !== expectedId || volumes.data !== expectedVolumes.data ||
    volumes.logs !== expectedVolumes.logs
  ) {
    throw new Error("recovery target identity changed during readiness");
  }
  if (item.State?.OOMKilled === true) {
    throw new Error("recovery target was OOM-killed before readiness");
  }
  if (item.State?.Running !== true) {
    throw new Error("recovery target stopped before readiness");
  }
}

async function waitReady(
  runtime: RecoveryDockerRuntime,
  plan: RecoveryTargetPlan,
  expectedId: string,
  expectedVolumes: RecoveryAnonymousVolumes,
  deadline: number,
): Promise<void> {
  for (;;) {
    const item = await inspectBeforeReadinessDeadline(
      runtime,
      plan.identity.stagingName,
      deadline,
    );
    assertReadinessInspection(item, plan, expectedId, expectedVolumes);

    // Exec form reaches SurrealDB's server readiness endpoint through the
    // exact binary in the pinned container. It needs neither a shell nor host
    // credentials and fails closed on every non-zero/ambiguous result.
    const result = await runtime.run({
      args: [
        "container",
        "exec",
        plan.identity.stagingName,
        "/surreal",
        "is-ready",
        "--endpoint",
        `http://127.0.0.1:${CONTAINER_PORT}`,
      ],
      timeoutMs: readinessOperationTimeout(runtime, deadline),
    });
    // Check the wall clock independently of exitCode: a success received after
    // the deadline is not readiness evidence.
    readinessOperationTimeout(runtime, deadline);
    if (result.exitCode === 0) {
      const ready = await inspectBeforeReadinessDeadline(
        runtime,
        plan.identity.stagingName,
        deadline,
      );
      assertReadinessInspection(ready, plan, expectedId, expectedVolumes);
      readinessOperationTimeout(runtime, deadline);
      return;
    }

    // A failed readiness probe can mean the server is merely starting, but it
    // can also mean exit/OOM/replacement/topology drift. Revalidate immediately
    // after every failure and before allowing even one polling sleep.
    const afterFailure = await inspectBeforeReadinessDeadline(
      runtime,
      plan.identity.stagingName,
      deadline,
    );
    assertReadinessInspection(afterFailure, plan, expectedId, expectedVolumes);
    await runtime.sleep(Math.min(
      READINESS_POLL_MS,
      readinessOperationTimeout(runtime, deadline),
    ));
  }
}

function failedRunCleanupVolumes(
  item: DockerInspection,
  plan: RecoveryTargetPlan,
): RecoveryAnonymousVolumes {
  const labels = item.Config?.Labels;
  if (
    typeof item.Id !== "string" || !/^[0-9a-f]{64}$/u.test(item.Id) ||
    item.Name !== `/${plan.identity.stagingName}` || item.Image !== exactImageId() ||
    item.Config?.Image !== plan.image || !labels || typeof labels !== "object" ||
    Array.isArray(labels) ||
    (labels as Record<string, unknown>)["io.ai-baka.recovery.owner"] !== "ai-baka" ||
    (labels as Record<string, unknown>)["io.ai-baka.recovery.attempt"] !==
      plan.identity.token
  ) {
    throw new Error("recovery failed-run cleanup identity is ambiguous");
  }
  return recoveryMounts(item.Mounts, plan.dbRoot, plan.temporaryRoot);
}

/**
 * A docker run acknowledgement is not creation evidence: the daemon may have
 * created the container before returning a non-zero code or losing the reply.
 * Always address the one random deterministic name, then prove the container
 * and both observed anonymous volumes absent. No list/prune/delete is used.
 */
async function cleanupAttemptedRecoveryRun(
  plan: RecoveryTargetPlan,
  runtime: RecoveryDockerRuntime,
): Promise<void> {
  const failures: unknown[] = [];
  let anonymousVolumes: RecoveryAnonymousVolumes | undefined;
  try {
    anonymousVolumes = failedRunCleanupVolumes(
      await inspect(runtime, plan.identity.stagingName),
      plan,
    );
  } catch (error) {
    failures.push(error);
  }

  for (const request of [
    {
      args: ["container", "stop", "--time", "60", plan.identity.stagingName],
      timeoutMs: 75_000,
    },
    {
      args: [
        "container",
        "rm",
        "--force",
        "--volumes",
        plan.identity.stagingName,
      ],
      timeoutMs: 75_000,
    },
  ] satisfies RecoveryDockerRequest[]) {
    try {
      const result = await runtime.run(request);
      if (result.exitCode !== 0) {
        throw new Error("recovery failed-run cleanup Docker command failed");
      }
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await assertContainerAbsent(runtime, plan.identity.stagingName);
  } catch (error) {
    failures.push(error);
  }
  if (anonymousVolumes) {
    try {
      await assertAnonymousVolumesAbsent(runtime, anonymousVolumes);
    } catch (error) {
      failures.push(error);
    }
  } else {
    failures.push(new Error("recovery failed run has no exact anonymous volume evidence"));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "recovery attempted-run cleanup evidence is incomplete",
    );
  }
}

export async function startRecoveryTarget(
  plan: RecoveryTargetPlan,
  credentials: { username: string; password: string },
  runtime: RecoveryDockerRuntime = DEFAULT_RECOVERY_DOCKER_RUNTIME,
): Promise<RecoveryTargetEvidence> {
  const runArgs = recoveryTargetRunArgs(plan);
  const runEnvironment = recoveryTargetEnvironment(plan, credentials);
  let runAttempted = false;
  try {
    runAttempted = true;
    await dockerOk(runtime, runArgs, {
      env: runEnvironment,
    });
    const readinessDeadline = runtime.now() + HEALTH_TIMEOUT_MS;
    const inspected = await inspectBeforeReadinessDeadline(
      runtime,
      plan.identity.stagingName,
      readinessDeadline,
    );
    const anonymousVolumes = recoveryMounts(
      inspected.Mounts,
      plan.dbRoot,
      plan.temporaryRoot,
    );
    const initial = assertTargetInspection(inspected, plan, anonymousVolumes);
    await waitReady(
      runtime,
      plan,
      initial.id,
      anonymousVolumes,
      readinessDeadline,
    );
    return initial;
  } catch (error) {
    if (runAttempted) {
      try {
        await cleanupAttemptedRecoveryRun(plan, runtime);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "recovery launch and cleanup both failed",
        );
      }
    }
    throw error;
  }
}

export async function stopRecoveryTarget(
  target: RecoveryTargetEvidence,
  runtime: RecoveryDockerRuntime = DEFAULT_RECOVERY_DOCKER_RUNTIME,
): Promise<StoppedRecoveryEvidence> {
  const before = await inspect(runtime, target.name);
  const beforeVolumes = recoveryMounts(before.Mounts, target.dbRoot, target.temporaryRoot);
  if (
    before.Id !== target.id || before.Name !== `/${target.name}` ||
    before.Image !== exactImageId() || before.Config?.Image !== target.image ||
    beforeVolumes.data !== target.anonymousVolumes.data ||
    beforeVolumes.logs !== target.anonymousVolumes.logs
  ) {
    throw new Error("recovery staging stop identity mismatch");
  }
  await dockerOk(runtime, ["container", "stop", "--time", "60", target.name], {
    timeoutMs: 75_000,
  });
  const item = await inspect(runtime, target.name);
  if (item.Id !== target.id || item.State?.Running !== false ||
      item.State.OOMKilled !== false || item.State.ExitCode !== 0) {
    throw new Error("recovery target did not stop cleanly");
  }
  return { ...target, oomKilled: false, exitCode: 0 };
}

/** Remove only the exact staging container; bind-mounted DB data is retained. */
export async function removeRecoveryTarget(
  target: RecoveryTargetEvidence,
  options: { force: boolean },
  runtime: RecoveryDockerRuntime = DEFAULT_RECOVERY_DOCKER_RUNTIME,
): Promise<void> {
  const item = await inspect(runtime, target.name);
  const anonymousVolumes = recoveryMounts(item.Mounts, target.dbRoot, target.temporaryRoot);
  if (
    item.Id !== target.id || item.Name !== `/${target.name}` ||
    item.Image !== exactImageId() || item.Config?.Image !== target.image ||
    anonymousVolumes.data !== target.anonymousVolumes.data ||
    anonymousVolumes.logs !== target.anonymousVolumes.logs ||
    (!options.force && item.State?.Running !== false)
  ) {
    throw new Error("recovery staging removal identity mismatch");
  }
  await dockerOk(
    runtime,
    ["container", "rm", ...(options.force ? ["--force"] : []), "--volumes", target.name],
    { timeoutMs: 75_000 },
  );
  await assertContainerAbsent(runtime, target.name);
  await assertAnonymousVolumesAbsent(runtime, target.anonymousVolumes);
}
