/**
 * Disposable SurrealDB target for production-size restore drills.
 *
 * This module deliberately has no dependency on the production SurrealDB
 * configuration. It derives the exact pinned image from the project compose,
 * creates one random Docker container plus one random named volume, publishes
 * an engine-assigned port on 127.0.0.1 only, and removes those exact resources
 * in container-before-volume order on success, failure, or cancellation.
 *
 * Credentials are inherited by the Docker CLI process and forwarded with
 * `--env NAME`; their values are never placed in argv, evidence, or errors.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const EXPECTED_IMAGE_REPOSITORY = "surrealdb/surrealdb";
export const ISOLATED_SURREAL_VERSION = "3.2.3";
const PINNED_IMAGE_PATTERN =
  /^surrealdb\/surrealdb:v(3\.2\.3)@sha256:([0-9a-f]{64})$/u;
const IDENTITY_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const CONTAINER_NAME_PATTERN = /^baka-restore-target-[0-9a-f]{32}$/u;
const VOLUME_NAME_PATTERN = /^baka-restore-target-data-[0-9a-f]{32}$/u;
const OWNER_LABEL = "io.ai-baka.restore-target.owner";
const ATTEMPT_LABEL = "io.ai-baka.restore-target.attempt";
const OWNER_LABEL_VALUE = "ai-baka";
const CONTAINER_PORT = 8000;
const PRODUCTION_HOST_PORT = 8901;
const DATA_MOUNT_TARGET = "/data";
const LOGS_TMPFS_TARGET = "/logs";
const TMP_TMPFS_TARGET = "/tmp";
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 120_000;
const DEFAULT_COMPOSE_PATH = fileURLToPath(
  new URL("../../docker-compose.yml", import.meta.url),
);

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export interface IsolatedTargetResourceProfile {
  /** Hard Docker cgroup limit. */
  memoryBytes: number;
  /** Equal to memoryBytes: swap cannot turn the hard bound into host pressure. */
  memorySwapBytes: number;
  cpus: number;
  pidsLimit: number;
  rocksDbBlockCacheBytes: number;
  rocksDbThreadCount: number;
  rocksDbJobsCount: number;
  rocksDbMaxConcurrentSubcompactions: number;
  hnswCacheBytes: number;
  memoryThresholdBytes: number;
  httpMaxImportBodyBytes: number;
}

/**
 * Compile-time FULLTEXT indexing behavior of surrealdb-core 3.2.3 at
 * 40522d1d2fd8e30017ebc2625a14aa5435c27347. It is attested from the exact
 * pinned image and deliberately is not presented as a configurable resource.
 */
export interface PinnedIndexingBehavior {
  readonly probeRecords: 16;
  readonly targetBytes: 8_388_608;
  readonly maxRecords: 250;
}

export const PINNED_SURREAL_INDEXING_BEHAVIOR = Object.freeze({
  probeRecords: 16,
  targetBytes: 8_388_608,
  maxRecords: 250,
}) satisfies PinnedIndexingBehavior;

/**
 * Conservative starting point for a multi-GiB restore. Callers may
 * provide another profile, but every field remains bounded by validation.
 */
export const DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE = Object.freeze({
  memoryBytes: 12 * GIB,
  memorySwapBytes: 12 * GIB,
  cpus: 4,
  pidsLimit: 512,
  rocksDbBlockCacheBytes: 1 * GIB,
  rocksDbThreadCount: 4,
  rocksDbJobsCount: 4,
  rocksDbMaxConcurrentSubcompactions: 2,
  hnswCacheBytes: 256 * MIB,
  memoryThresholdBytes: 6 * GIB,
  httpMaxImportBodyBytes: 32 * GIB,
}) satisfies Readonly<IsolatedTargetResourceProfile>;

export interface IsolatedTargetIdentity {
  attemptToken: string;
  containerName: string;
  volumeName: string;
}

export interface IsolatedTargetStorage {
  type: "volume";
  source: string;
  target: "/data";
}

/** Pure launch contract: exported so hostile mutations can be unit-tested. */
export interface IsolatedTargetLaunchPlan {
  image: string;
  version: string;
  identity: IsolatedTargetIdentity;
  hostAddress: "127.0.0.1";
  containerPort: 8000;
  storage: IsolatedTargetStorage;
  resources: IsolatedTargetResourceProfile;
  containerUser: "0:0";
  restartPolicy: "no";
  indexBuildResumeInterval: "0";
}

export interface IsolatedTargetCredentials {
  username: string;
  password: string;
}

export interface IsolatedTargetOptions {
  credentials: IsolatedTargetCredentials;
  composePath?: string;
  resources?: IsolatedTargetResourceProfile;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  statsPollMs?: number;
  /** Deadline for each individual Docker CLI subprocess. */
  dockerCommandTimeoutMs?: number;
  /** Aggregate deadline for monitor shutdown, final inspect and exact cleanup. */
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface DockerCommandRequest {
  args: readonly string[];
  /** Explicit wall-clock deadline for this subprocess. */
  timeoutMs: number;
  /** Combined stdout+stderr byte ceiling. */
  maxOutputBytes: number;
  /** Values may contain credentials; implementations must never log them. */
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: "timed_out" | "aborted" | "output_limit";
}

export interface IsolatedTargetDependencies {
  readComposeFile(filePath: string): Promise<string>;
  runDocker(request: DockerCommandRequest): Promise<DockerCommandResult>;
  randomUuid(): string;
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface IsolatedTargetObservation {
  statsSamples: number;
  peakMemoryBytes?: number;
  peakCpuPercent?: number;
  peakPids?: number;
  oomKilled?: boolean;
  exitCode?: number;
}

export interface IsolatedTargetCleanupEvidence {
  containerRemoved: boolean;
  volumeRemoved: boolean;
  /** A cleanup command/deadline or an interrupted create made absence unprovable. */
  timedOut: boolean;
  failures: readonly (
    | "container_inspect"
    | "container_remove"
    | "volume_inspect"
    | "volume_remove"
    | "cleanup_timeout"
  )[];
}

export interface IsolatedTargetEvidence {
  formatVersion: 2;
  image: string;
  version: "3.2.3";
  runtimeVersion?: string;
  identity: IsolatedTargetIdentity;
  hostAddress: "127.0.0.1";
  hostPort?: number;
  containerPort: 8000;
  storage: IsolatedTargetStorage;
  resources: IsolatedTargetResourceProfile;
  pinnedIndexingBehavior: PinnedIndexingBehavior;
  containerUser: "0:0";
  restartPolicy: "no";
  indexBuildResumeInterval: "0";
  startedAt: string;
  readyAt?: string;
  finishedAt?: string;
  observation: IsolatedTargetObservation;
  cleanup: IsolatedTargetCleanupEvidence;
}

export interface IsolatedSurrealTarget {
  /** WebSocket endpoint suitable for the Surreal SDK. */
  surrealUrl: string;
  /** HTTP endpoint suitable for authenticated /import and /sql calls. */
  httpBaseUrl: string;
  hostAddress: "127.0.0.1";
  hostPort: number;
  containerName: string;
  volumeName: string;
  signal?: AbortSignal;
  /**
   * Idempotently stops/removes the exact owned target and proves the named
   * volume is absent. Restore integration calls this only after its namespace
   * and deferred-index cleanup, but before it makes success publishable.
   */
  finalize(): Promise<IsolatedTargetEvidence>;
}

export interface IsolatedTargetRunResult<T> {
  value: T;
  evidence: IsolatedTargetEvidence;
}

export type IsolatedTargetFailureStage =
  | "configuration"
  | "volume_create"
  | "container_start"
  | "readiness"
  | "operation"
  | "cleanup";

/** Privacy-safe lifecycle error. Raw Docker/callback errors are not retained. */
export class IsolatedTargetLifecycleError extends Error {
  constructor(
    readonly stage: IsolatedTargetFailureStage,
    readonly code: string,
    readonly evidence?: IsolatedTargetEvidence,
  ) {
    super(`isolated SurrealDB target failed: ${stage}/${code}`);
    this.name = "IsolatedTargetLifecycleError";
  }
}

interface ContainerInspection {
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
  mounts: Array<{
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
  }>;
  ports: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  state: {
    Running?: boolean;
    OOMKilled?: boolean;
    ExitCode?: number;
  };
}

interface VolumeInspection {
  name: string;
  driver: string;
  labels: Record<string, string>;
}

interface MutableObservation {
  statsSamples: number;
  peakMemoryBytes?: number;
  peakCpuPercent?: number;
  peakPids?: number;
  oomKilled?: boolean;
  exitCode?: number;
}

class InternalDockerCommandError extends Error {
  constructor(
    readonly operation: string,
    readonly exitCode: number,
    readonly failure?: DockerCommandResult["failure"],
  ) {
    super(`${operation} failed with exit code ${exitCode}`);
  }
}

function assertPlainCredential(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`isolated target ${label} must be 1..1024 non-control characters`);
  }
}

function assertIntegerInRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`isolated target ${label} is outside its bounded range`);
  }
}

export function validateIsolatedTargetResourceProfile(
  input: IsolatedTargetResourceProfile,
): IsolatedTargetResourceProfile {
  const profile = { ...input };
  assertIntegerInRange(profile.memoryBytes, 2 * GIB, 64 * GIB, "memoryBytes");
  assertIntegerInRange(profile.memorySwapBytes, 2 * GIB, 64 * GIB, "memorySwapBytes");
  if (profile.memorySwapBytes !== profile.memoryBytes) {
    throw new Error("isolated target memorySwapBytes must equal memoryBytes");
  }
  if (!Number.isFinite(profile.cpus) || profile.cpus < 0.5 || profile.cpus > 16) {
    throw new Error("isolated target cpus is outside its bounded range");
  }
  assertIntegerInRange(profile.pidsLimit, 64, 4096, "pidsLimit");
  assertIntegerInRange(
    profile.rocksDbBlockCacheBytes,
    16 * MIB,
    Math.min(4 * GIB, Math.floor(profile.memoryBytes / 4)),
    "rocksDbBlockCacheBytes",
  );
  assertIntegerInRange(profile.rocksDbThreadCount, 1, 16, "rocksDbThreadCount");
  assertIntegerInRange(profile.rocksDbJobsCount, 1, 16, "rocksDbJobsCount");
  assertIntegerInRange(
    profile.rocksDbMaxConcurrentSubcompactions,
    1,
    profile.rocksDbJobsCount,
    "rocksDbMaxConcurrentSubcompactions",
  );
  assertIntegerInRange(
    profile.hnswCacheBytes,
    16 * MIB,
    Math.min(4 * GIB, Math.floor(profile.memoryBytes / 4)),
    "hnswCacheBytes",
  );
  assertIntegerInRange(
    profile.memoryThresholdBytes,
    64 * MIB,
    Math.floor(profile.memoryBytes / 2),
    "memoryThresholdBytes",
  );
  assertIntegerInRange(
    profile.httpMaxImportBodyBytes,
    1 * MIB,
    64 * GIB,
    "httpMaxImportBodyBytes",
  );
  return profile;
}

export function createIsolatedTargetIdentity(uuid: string = randomUUID()): IsolatedTargetIdentity {
  const attemptToken = uuid.replaceAll("-", "").toLowerCase();
  const identity = {
    attemptToken,
    containerName: `baka-restore-target-${attemptToken}`,
    volumeName: `baka-restore-target-data-${attemptToken}`,
  };
  return validateIsolatedTargetIdentity(identity);
}

export function validateIsolatedTargetIdentity(
  input: IsolatedTargetIdentity,
): IsolatedTargetIdentity {
  if (!IDENTITY_TOKEN_PATTERN.test(input.attemptToken) ||
      !CONTAINER_NAME_PATTERN.test(input.containerName) ||
      !VOLUME_NAME_PATTERN.test(input.volumeName) ||
      input.containerName !== `baka-restore-target-${input.attemptToken}` ||
      input.volumeName !== `baka-restore-target-data-${input.attemptToken}`) {
    throw new Error("isolated target identity is not an exact allowlisted identity");
  }
  return { ...input };
}

function unquoteYamlScalar(value: string): string | undefined {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.includes("#") || /\s/u.test(value)) return undefined;
  return value;
}

/** Extracts exactly one literal image from the compose `surrealdb` service. */
export function pinnedSurrealImageFromCompose(compose: string): {
  image: string;
  version: "3.2.3";
} {
  const lines = compose.replaceAll("\r\n", "\n").split("\n");
  const serviceIndex = lines.findIndex((line) => /^  surrealdb:\s*(?:#.*)?$/u.test(line));
  if (serviceIndex < 0) {
    throw new Error("compose must contain one literal surrealdb service");
  }
  const images: string[] = [];
  for (let index = serviceIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const indentation = line.match(/^ */u)?.[0].length ?? 0;
    if (indentation <= 2) break;
    const match = line.match(/^    image:\s*(.+?)\s*$/u);
    if (match) {
      const image = unquoteYamlScalar(match[1]!);
      if (!image) throw new Error("compose surrealdb image must be a literal scalar");
      images.push(image);
    }
  }
  if (images.length !== 1) {
    throw new Error("compose surrealdb service must contain exactly one image");
  }
  const match = images[0]!.match(PINNED_IMAGE_PATTERN);
  if (!match || !images[0]!.startsWith(`${EXPECTED_IMAGE_REPOSITORY}:`)) {
    throw new Error("compose surrealdb image must be exact v3.2.3 tag plus sha256 digest");
  }
  return { image: images[0]!, version: ISOLATED_SURREAL_VERSION };
}

export function validateIsolatedTargetLaunchPlan(
  input: IsolatedTargetLaunchPlan,
): IsolatedTargetLaunchPlan {
  const imageMatch = input.image.match(PINNED_IMAGE_PATTERN);
  if (!imageMatch || input.version !== ISOLATED_SURREAL_VERSION) {
    throw new Error("isolated target requires the exact pinned SurrealDB v3.2.3 image");
  }
  const identity = validateIsolatedTargetIdentity(input.identity);
  if (input.hostAddress !== "127.0.0.1") {
    throw new Error("isolated target host binding must be exactly 127.0.0.1");
  }
  if (input.containerPort !== CONTAINER_PORT) {
    throw new Error("isolated target container port must be exactly 8000");
  }
  if (input.storage?.type !== "volume" ||
      input.storage.source !== identity.volumeName ||
      input.storage.target !== DATA_MOUNT_TARGET) {
    throw new Error("isolated target storage must be its exact named volume at /data");
  }
  if (input.restartPolicy !== "no") {
    throw new Error("isolated target restart policy must disable restart");
  }
  if (input.containerUser !== "0:0") {
    throw new Error("isolated target fresh named volume requires the exact proven 0:0 user");
  }
  if (input.indexBuildResumeInterval !== "0") {
    throw new Error("isolated target index auto-resume must be disabled");
  }
  return {
    ...input,
    identity,
    storage: { ...input.storage },
    resources: validateIsolatedTargetResourceProfile(input.resources),
  };
}

function buildLaunchPlan(
  image: string,
  identity: IsolatedTargetIdentity,
  resources: IsolatedTargetResourceProfile,
): IsolatedTargetLaunchPlan {
  return validateIsolatedTargetLaunchPlan({
    image,
    version: ISOLATED_SURREAL_VERSION,
    identity,
    hostAddress: "127.0.0.1",
    containerPort: CONTAINER_PORT,
    storage: { type: "volume", source: identity.volumeName, target: DATA_MOUNT_TARGET },
    resources,
    containerUser: "0:0",
    restartPolicy: "no",
    indexBuildResumeInterval: "0",
  });
}

function safeDockerEnvironment(extra: Readonly<Record<string, string>>): Record<string, string> {
  const inheritedNames = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ];
  return {
    ...Object.fromEntries(
      inheritedNames
        .map((name) => [name, process.env[name]])
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ...extra,
  };
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
  budget: { bytes: number; maximum: number },
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (budget.bytes + item.value.byteLength > budget.maximum) {
        budget.bytes = budget.maximum;
        stop();
        throw new Error("docker command output exceeded the bounded limit");
      }
      chunks.push(item.value);
      bytes += item.value.byteLength;
      budget.bytes += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function runDockerCommand(
  request: DockerCommandRequest,
): Promise<DockerCommandResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd: ["docker", ...request.args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: safeDockerEnvironment(request.env ?? {}),
    });
  } catch {
    return { exitCode: 127, stdout: "", stderr: "docker process could not be started" };
  }
  const stop = () => {
    try {
      child.kill();
    } catch {
      // The outer deadline still settles even when the process already exited.
    }
  };
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    stop();
    void child.exited.catch(() => {});
    return { exitCode: 1, stdout: "", stderr: "docker command streams were unavailable" };
  }
  const onAbort = () => stop();
  const outputBudget = { bytes: 0, maximum: request.maxOutputBytes };
  if (request.signal?.aborted) stop();
  else request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedStream(child.stdout, stop, outputBudget),
      readBoundedStream(child.stderr, stop, outputBudget),
    ]);
    return { exitCode, stdout, stderr };
  } catch {
    stop();
    void child.exited.catch(() => {});
    return {
      exitCode: 1,
      stdout: "",
      stderr: "docker command output was invalid",
      ...(outputBudget.bytes >= outputBudget.maximum ? { failure: "output_limit" as const } : {}),
    };
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
  }
}

function failedDockerResult(
  failure: NonNullable<DockerCommandResult["failure"]>,
): DockerCommandResult {
  return { exitCode: 1, stdout: "", stderr: "", failure };
}

function boundedDockerResult(
  result: DockerCommandResult,
  maximumBytes: number,
): DockerCommandResult {
  if (!Number.isSafeInteger(result?.exitCode) ||
      typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    return { exitCode: 1, stdout: "", stderr: "" };
  }
  const bytes = new TextEncoder().encode(result.stdout).byteLength +
    new TextEncoder().encode(result.stderr).byteLength;
  if (bytes > maximumBytes) return failedDockerResult("output_limit");
  return result;
}

/**
 * Enforces the request contract outside the injected runner as well as inside
 * the real Bun subprocess. A hostile or broken test runner which never settles
 * therefore cannot make creation, observation, readiness or cleanup hang.
 */
async function runDockerBounded(
  dependencies: IsolatedTargetDependencies,
  request: DockerCommandRequest,
): Promise<DockerCommandResult> {
  assertTiming(request.timeoutMs, request.timeoutMs, "Docker command timeout");
  assertIntegerInRange(
    request.maxOutputBytes,
    1,
    MAX_DOCKER_OUTPUT_BYTES,
    "Docker command output limit",
  );
  if (request.signal?.aborted) return failedDockerResult("aborted");

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const interrupted = new Promise<DockerCommandResult>((resolve) => {
    const stop = (failure: "timed_out" | "aborted") => {
      resolve(failedDockerResult(failure));
      controller.abort();
    };
    timeout = setTimeout(() => stop("timed_out"), request.timeoutMs);
    onAbort = () => stop("aborted");
    request.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const pending = Promise.resolve()
    .then(() => dependencies.runDocker({ ...request, signal: controller.signal }))
    .then((result) => boundedDockerResult(result, request.maxOutputBytes))
    .catch((): DockerCommandResult => ({ exitCode: 1, stdout: "", stderr: "" }));
  // The losing runner may ignore cancellation and reject much later.
  void pending.catch(() => {});
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("isolated target operation aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("isolated target operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_DEPENDENCIES: IsolatedTargetDependencies = {
  readComposeFile: (filePath) => readFile(filePath, "utf8"),
  runDocker: runDockerCommand,
  randomUuid: randomUUID,
  now: () => new Date(),
  sleep,
};

function assertTiming(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 10 * 60 * 1000) {
    throw new Error(`isolated target ${label} must be bounded to 1..600000ms`);
  }
  return resolved;
}

function labelsFor(identity: IsolatedTargetIdentity): Record<string, string> {
  return {
    [OWNER_LABEL]: OWNER_LABEL_VALUE,
    [ATTEMPT_LABEL]: identity.attemptToken,
  };
}

function labelArgs(identity: IsolatedTargetIdentity): string[] {
  return Object.entries(labelsFor(identity)).flatMap(([name, value]) => [
    "--label",
    `${name}=${value}`,
  ]);
}

function assertOwnedLabels(
  labels: Record<string, string> | undefined,
  identity: IsolatedTargetIdentity,
): void {
  const expected = labelsFor(identity);
  if (!labels || labels[OWNER_LABEL] !== expected[OWNER_LABEL] ||
      labels[ATTEMPT_LABEL] !== expected[ATTEMPT_LABEL]) {
    throw new Error("Docker target does not carry the exact ownership labels");
  }
}

function dockerContainerRunArgs(plan: IsolatedTargetLaunchPlan): string[] {
  const { resources, identity } = plan;
  return [
    "container",
    "run",
    "--detach",
    "--pull",
    "missing",
    "--name",
    identity.containerName,
    ...labelArgs(identity),
    "--restart",
    plan.restartPolicy,
    "--network",
    "bridge",
    "--publish",
    `${plan.hostAddress}::${plan.containerPort}`,
    "--mount",
    `type=volume,src=${identity.volumeName},dst=${DATA_MOUNT_TARGET}`,
    "--tmpfs",
    `${LOGS_TMPFS_TARGET}:rw,noexec,nosuid,nodev,size=${16 * MIB}`,
    "--tmpfs",
    `${TMP_TMPFS_TARGET}:rw,noexec,nosuid,nodev,size=${64 * MIB}`,
    "--read-only",
    "--init",
    // The pinned image runs as uid 65532, while a fresh Docker named volume is
    // root-owned and the minimal image contains no chown helper. Root inside
    // this cap-dropped, no-new-privileges, read-only container is the narrow
    // portable way to initialize/write the disposable volume.
    "--user",
    plan.containerUser,
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
    "30",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=2",
    "--env",
    "SURREAL_USER",
    "--env",
    "SURREAL_PASS",
    "--env",
    "SURREAL_HTTP_MAX_IMPORT_BODY_SIZE",
    "--env",
    "SURREAL_ROCKSDB_BLOCK_CACHE_SIZE",
    "--env",
    "SURREAL_ROCKSDB_THREAD_COUNT",
    "--env",
    "SURREAL_ROCKSDB_JOBS_COUNT",
    "--env",
    "SURREAL_ROCKSDB_MAX_CONCURRENT_SUBCOMPACTIONS",
    "--env",
    "SURREAL_HNSW_CACHE_SIZE",
    "--env",
    "SURREAL_MEMORY_THRESHOLD",
    "--env",
    "SURREAL_DURABLE_SESSIONS",
    "--env",
    "SURREAL_TEMPORARY_DIRECTORY",
    plan.image,
    "start",
    "--no-banner",
    "--log",
    "warn",
    "--bind",
    `0.0.0.0:${plan.containerPort}`,
    "--index-build-resume-interval",
    plan.indexBuildResumeInterval,
    "rocksdb:///data/db",
  ];
}

function containerEnvironment(
  credentials: IsolatedTargetCredentials,
  resources: IsolatedTargetResourceProfile,
): Record<string, string> {
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
    SURREAL_TEMPORARY_DIRECTORY: "/data",
  };
}

async function docker(
  dependencies: IsolatedTargetDependencies,
  request: DockerCommandRequest,
  operation: string,
): Promise<DockerCommandResult> {
  const result = await runDockerBounded(dependencies, request);
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0 || result.failure) {
    throw new InternalDockerCommandError(operation, result.exitCode, result.failure);
  }
  return result;
}

function isDockerMissing(result: DockerCommandResult, kind: "container" | "volume"): boolean {
  if (result.exitCode === 0) return false;
  const text = `${result.stdout}\n${result.stderr}`;
  return kind === "container"
    ? /no such (?:container|object)/iu.test(text)
    : /no such volume/iu.test(text);
}

function parseJsonObject<T>(text: string, label: string): T {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new Error(`Docker ${label} returned invalid bounded JSON`);
  }
}

const CONTAINER_INSPECT_FORMAT =
  "{" +
  '"name":{{json .Name}},' +
  '"configImage":{{json .Config.Image}},' +
  '"labels":{{json .Config.Labels}},' +
  '"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},' +
  '"memory":{{json .HostConfig.Memory}},' +
  '"memorySwap":{{json .HostConfig.MemorySwap}},' +
  '"nanoCpus":{{json .HostConfig.NanoCpus}},' +
  '"pidsLimit":{{json .HostConfig.PidsLimit}},' +
  '"user":{{json .Config.User}},' +
  '"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},' +
  '"privileged":{{json .HostConfig.Privileged}},' +
  '"capDrop":{{json .HostConfig.CapDrop}},' +
  '"tmpfs":{{json .HostConfig.Tmpfs}},' +
  '"mounts":{{json .Mounts}},' +
  '"ports":{{json .NetworkSettings.Ports}},' +
  '"state":{{json .State}}' +
  "}";

const VOLUME_INSPECT_FORMAT =
  "{" +
  '"name":{{json .Name}},' +
  '"driver":{{json .Driver}},' +
  '"labels":{{json .Labels}}' +
  "}";

async function inspectContainer(
  dependencies: IsolatedTargetDependencies,
  identity: IsolatedTargetIdentity,
  commandTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ContainerInspection | undefined> {
  const result = await runDockerBounded(dependencies, {
    args: [
      "container",
      "inspect",
      "--format",
      CONTAINER_INSPECT_FORMAT,
      identity.containerName,
    ],
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    signal,
  });
  if (isDockerMissing(result, "container")) return undefined;
  if (result.exitCode !== 0 || result.failure) {
    throw new InternalDockerCommandError(
      "container_inspect",
      result.exitCode,
      result.failure,
    );
  }
  return parseJsonObject<ContainerInspection>(result.stdout, "container inspect");
}

async function inspectVolume(
  dependencies: IsolatedTargetDependencies,
  identity: IsolatedTargetIdentity,
  commandTimeoutMs: number,
  signal?: AbortSignal,
): Promise<VolumeInspection | undefined> {
  const result = await runDockerBounded(dependencies, {
    args: ["volume", "inspect", "--format", VOLUME_INSPECT_FORMAT, identity.volumeName],
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    signal,
  });
  if (isDockerMissing(result, "volume")) return undefined;
  if (result.exitCode !== 0 || result.failure) {
    throw new InternalDockerCommandError("volume_inspect", result.exitCode, result.failure);
  }
  return parseJsonObject<VolumeInspection>(result.stdout, "volume inspect");
}

function validateCreatedVolume(volume: VolumeInspection, identity: IsolatedTargetIdentity): void {
  if (volume.name !== identity.volumeName || volume.driver !== "local") {
    throw new Error("Docker volume is not the exact isolated local volume");
  }
  assertOwnedLabels(volume.labels, identity);
}

function validateContainerStaticContract(
  container: ContainerInspection,
  plan: IsolatedTargetLaunchPlan,
): void {
  const expectedName = `/${plan.identity.containerName}`;
  if (container.name !== expectedName || container.configImage !== plan.image) {
    throw new Error("Docker container identity or image does not match the launch contract");
  }
  assertOwnedLabels(container.labels, plan.identity);
  const { resources } = plan;
  if (container.restartPolicy !== "no" ||
      container.memory !== resources.memoryBytes ||
      container.memorySwap !== resources.memorySwapBytes ||
      container.nanoCpus !== Math.round(resources.cpus * 1_000_000_000) ||
      container.pidsLimit !== resources.pidsLimit ||
      container.user !== plan.containerUser ||
      container.readOnlyRootfs !== true ||
      container.privileged !== false ||
      !container.capDrop?.includes("ALL")) {
    throw new Error("Docker container resource or isolation bounds do not match the launch contract");
  }
  const dataMount = container.mounts.find((mount) => mount.Destination === DATA_MOUNT_TARGET);
  const expectedTmpfs = {
    [LOGS_TMPFS_TARGET]: `rw,noexec,nosuid,nodev,size=${16 * MIB}`,
    [TMP_TMPFS_TARGET]: `rw,noexec,nosuid,nodev,size=${64 * MIB}`,
  };
  if (container.mounts.length !== 1 || dataMount?.Type !== "volume" ||
      dataMount.Name !== plan.identity.volumeName ||
      Object.keys(container.tmpfs ?? {}).length !== 2 ||
      container.tmpfs?.[LOGS_TMPFS_TARGET] !== expectedTmpfs[LOGS_TMPFS_TARGET] ||
      container.tmpfs?.[TMP_TMPFS_TARGET] !== expectedTmpfs[TMP_TMPFS_TARGET] ||
      container.mounts.some((mount) => mount.Type === "bind")) {
    throw new Error("Docker container has an unexpected or path-backed mount");
  }
}

function validateCreatedContainer(
  container: ContainerInspection,
  plan: IsolatedTargetLaunchPlan,
): number {
  validateContainerStaticContract(container, plan);
  const mappings = container.ports[`${plan.containerPort}/tcp`];
  if (!Array.isArray(mappings) || mappings.length !== 1 ||
      mappings[0]?.HostIp !== plan.hostAddress ||
      !/^\d{1,5}$/u.test(mappings[0]?.HostPort ?? "")) {
    throw new Error("Docker container port is not published exactly once on loopback");
  }
  const hostPort = Number(mappings[0]!.HostPort);
  if (
    !Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535 ||
    hostPort === PRODUCTION_HOST_PORT
  ) {
    throw new Error("Docker assigned an invalid loopback host port");
  }
  return hostPort;
}

function parseDockerQuantity(value: string): number | undefined {
  const match = value.trim().match(
    /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/u,
  );
  if (!match) return undefined;
  const factors: Record<string, number> = {
    B: 1,
    kB: 1000,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  const parsed = Number(match[1]) * factors[match[2]!]!;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

function recordStats(text: string, observation: MutableObservation): void {
  const row = parseJsonObject<Record<string, unknown>>(text, "stats");
  const memoryText = typeof row.MemUsage === "string" ? row.MemUsage.split("/")[0] : undefined;
  const memory = memoryText ? parseDockerQuantity(memoryText) : undefined;
  const cpu = typeof row.CPUPerc === "string" && /^\d+(?:\.\d+)?%$/u.test(row.CPUPerc)
    ? Number(row.CPUPerc.slice(0, -1))
    : undefined;
  const pids = typeof row.PIDs === "string" && /^\d+$/u.test(row.PIDs)
    ? Number(row.PIDs)
    : typeof row.PIDs === "number" ? row.PIDs : undefined;
  observation.statsSamples += 1;
  if (memory !== undefined) {
    observation.peakMemoryBytes = Math.max(observation.peakMemoryBytes ?? 0, memory);
  }
  if (cpu !== undefined && Number.isFinite(cpu)) {
    observation.peakCpuPercent = Math.max(observation.peakCpuPercent ?? 0, cpu);
  }
  if (pids !== undefined && Number.isSafeInteger(pids) && pids >= 0) {
    observation.peakPids = Math.max(observation.peakPids ?? 0, pids);
  }
}

async function sampleDockerStats(
  dependencies: IsolatedTargetDependencies,
  identity: IsolatedTargetIdentity,
  observation: MutableObservation,
  commandTimeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runDockerBounded(dependencies, {
    args: [
      "container",
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      identity.containerName,
    ],
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    signal,
  });
  if (result.exitCode !== 0 || result.failure) return;
  try {
    recordStats(result.stdout, observation);
  } catch {
    // Stats are best-effort evidence; lifecycle safety does not depend on them.
  }
}

function startStatsMonitor(
  dependencies: IsolatedTargetDependencies,
  identity: IsolatedTargetIdentity,
  pollMs: number,
  observation: MutableObservation,
  commandTimeoutMs: number,
): { stop(): Promise<void> } {
  const controller = new AbortController();
  const monitor = (async () => {
    while (!controller.signal.aborted) {
      await sampleDockerStats(
        dependencies,
        identity,
        observation,
        commandTimeoutMs,
        controller.signal,
      );
      try {
        await dependencies.sleep(pollMs, controller.signal);
      } catch {
        break;
      }
    }
  })();
  return {
    async stop(): Promise<void> {
      controller.abort();
      await monitor.catch(() => {});
    },
  };
}

async function waitForReadiness(
  dependencies: IsolatedTargetDependencies,
  identity: IsolatedTargetIdentity,
  timeoutMs: number,
  pollMs: number,
  commandTimeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = dependencies.now().getTime() + timeoutMs;
  const readinessController = new AbortController();
  const wallClockDeadline = setTimeout(() => readinessController.abort(), timeoutMs);
  const readinessSignal = signal
    ? AbortSignal.any([signal, readinessController.signal])
    : readinessController.signal;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("isolated target operation aborted");
      if (readinessController.signal.aborted) {
        throw new Error("isolated target readiness deadline expired");
      }
      const result = await runDockerBounded(dependencies, {
        args: [
          "container",
          "exec",
          identity.containerName,
          "/surreal",
          "is-ready",
          "--endpoint",
          `http://127.0.0.1:${CONTAINER_PORT}`,
        ],
        timeoutMs: commandTimeoutMs,
        maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
        signal: readinessSignal,
      });
      if (result.exitCode === 0 && !result.failure) return;
      if (readinessController.signal.aborted || dependencies.now().getTime() >= deadline) {
        throw new Error("isolated target readiness deadline expired");
      }
      const container = await inspectContainer(
        dependencies,
        identity,
        commandTimeoutMs,
        readinessSignal,
      );
      if (!container || container.state.Running === false || container.state.OOMKilled === true) {
        throw new Error("isolated target stopped before readiness");
      }
      const polling = dependencies.sleep(pollMs, readinessSignal);
      void polling.catch(() => {});
      const pollDeadline = abortPromise(readinessSignal);
      try {
        await Promise.race([polling, pollDeadline.promise!]);
      } finally {
        pollDeadline.dispose();
      }
    }
  } finally {
    clearTimeout(wallClockDeadline);
  }
}

async function runtimeVersion(
  dependencies: IsolatedTargetDependencies,
  identity: IsolatedTargetIdentity,
  commandTimeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await docker(dependencies, {
    args: ["container", "exec", identity.containerName, "/surreal", "version"],
    timeoutMs: commandTimeoutMs,
    maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    signal,
  }, "runtime_version");
  const version = result.stdout.trim();
  if (!new RegExp(
    `^${ISOLATED_SURREAL_VERSION.replaceAll(".", "\\.")}` +
      "(?:\\+[0-9A-Za-z.-]+)?(?:\\s|$)",
    "u",
  ).test(version)) {
    throw new Error("isolated target runtime version does not match the pinned tag");
  }
  return version;
}

function abortPromise(signal: AbortSignal | undefined): {
  promise?: Promise<never>;
  dispose(): void;
} {
  if (!signal) return { dispose() {} };
  let listener = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error("isolated target operation aborted"));
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", listener),
  };
}

function failureCode(error: unknown, signal: AbortSignal | undefined): string {
  if (signal?.aborted) return "aborted";
  if (error instanceof InternalDockerCommandError) {
    if (error.failure === "timed_out") return "docker_command_timeout";
    if (error.failure === "output_limit") return "docker_output_limit";
    if (error.failure === "aborted") return "aborted";
    return "docker_command_failed";
  }
  return "operation_failed";
}

async function cleanupOwnedResources(
  dependencies: IsolatedTargetDependencies,
  identity: IsolatedTargetIdentity,
  commandTimeoutMs: number,
  signal: AbortSignal,
): Promise<IsolatedTargetCleanupEvidence> {
  const failures: Array<
    | "container_inspect"
    | "container_remove"
    | "volume_inspect"
    | "volume_remove"
    | "cleanup_timeout"
  > = [];
  let containerRemoved = false;
  let volumeRemoved = false;
  let commandTimedOut = false;

  try {
    const container = await inspectContainer(dependencies, identity, commandTimeoutMs, signal);
    if (!container) {
      containerRemoved = true;
    } else {
      if (container.name !== `/${identity.containerName}`) throw new Error();
      assertOwnedLabels(container.labels, identity);
      const result = await runDockerBounded(dependencies, {
        args: ["container", "rm", "--force", "--volumes", identity.containerName],
        timeoutMs: commandTimeoutMs,
        maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
        signal,
      });
      if (result.failure === "timed_out") commandTimedOut = true;
      if (result.exitCode !== 0 || result.failure) failures.push("container_remove");
      else {
        const remaining = await inspectContainer(
          dependencies,
          identity,
          commandTimeoutMs,
          signal,
        );
        if (remaining) failures.push("container_remove");
        else containerRemoved = true;
      }
    }
  } catch (error) {
    if (error instanceof InternalDockerCommandError && error.failure === "timed_out") {
      commandTimedOut = true;
    }
    failures.push("container_inspect");
  }

  // A named volume is never removed until the exact owned container is gone.
  if (containerRemoved) {
    try {
      const volume = await inspectVolume(dependencies, identity, commandTimeoutMs, signal);
      if (!volume) {
        volumeRemoved = true;
      } else {
        validateCreatedVolume(volume, identity);
        const result = await runDockerBounded(dependencies, {
          args: ["volume", "rm", identity.volumeName],
          timeoutMs: commandTimeoutMs,
          maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
          signal,
        });
        if (result.failure === "timed_out") commandTimedOut = true;
        if (result.exitCode !== 0 || result.failure) failures.push("volume_remove");
        else {
          const remaining = await inspectVolume(
            dependencies,
            identity,
            commandTimeoutMs,
            signal,
          );
          if (remaining) failures.push("volume_remove");
          else volumeRemoved = true;
        }
      }
    } catch (error) {
      if (error instanceof InternalDockerCommandError && error.failure === "timed_out") {
        commandTimedOut = true;
      }
      failures.push("volume_inspect");
    }
  }

  const timedOut = signal.aborted || commandTimedOut;
  if (timedOut) failures.push("cleanup_timeout");
  return {
    containerRemoved,
    volumeRemoved,
    timedOut,
    failures: [...new Set(failures)],
  };
}

/**
 * Runs one operation against an isolated disposable SurrealDB target.
 *
 * The callback is raced with cancellation and receives the same signal for
 * cooperative transport cancellation. Cleanup does not inherit that signal,
 * so an abort cannot prevent exact container/volume removal.
 */
export async function withIsolatedSurrealTarget<T>(
  options: IsolatedTargetOptions,
  operation: (target: IsolatedSurrealTarget) => Promise<T>,
  dependencyOverrides: Partial<IsolatedTargetDependencies> = {},
): Promise<IsolatedTargetRunResult<T>> {
  const dependencies: IsolatedTargetDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  try {
    assertPlainCredential(options?.credentials?.username, "username");
    assertPlainCredential(options?.credentials?.password, "password");
  } catch {
    throw new IsolatedTargetLifecycleError("configuration", "invalid_credentials");
  }
  const readinessTimeoutMs = assertTiming(
    options.readinessTimeoutMs,
    60_000,
    "readinessTimeoutMs",
  );
  const readinessPollMs = assertTiming(options.readinessPollMs, 500, "readinessPollMs");
  const statsPollMs = assertTiming(options.statsPollMs, 1_000, "statsPollMs");
  const dockerCommandTimeoutMs = assertTiming(
    options.dockerCommandTimeoutMs,
    DEFAULT_DOCKER_COMMAND_TIMEOUT_MS,
    "dockerCommandTimeoutMs",
  );
  const cleanupTimeoutMs = assertTiming(
    options.cleanupTimeoutMs,
    DEFAULT_CLEANUP_TIMEOUT_MS,
    "cleanupTimeoutMs",
  );
  if (options.signal?.aborted) {
    throw new IsolatedTargetLifecycleError("configuration", "aborted");
  }

  let compose: string;
  try {
    compose = await dependencies.readComposeFile(options.composePath ?? DEFAULT_COMPOSE_PATH);
  } catch {
    throw new IsolatedTargetLifecycleError("configuration", "compose_unreadable");
  }
  let plan: IsolatedTargetLaunchPlan;
  try {
    const pinned = pinnedSurrealImageFromCompose(compose);
    const identity = createIsolatedTargetIdentity(dependencies.randomUuid());
    plan = buildLaunchPlan(
      pinned.image,
      identity,
      options.resources ?? DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE,
    );
  } catch {
    throw new IsolatedTargetLifecycleError("configuration", "invalid_launch_contract");
  }

  const observation: MutableObservation = { statsSamples: 0 };
  const evidence: IsolatedTargetEvidence = {
    formatVersion: 2,
    image: plan.image,
    version: ISOLATED_SURREAL_VERSION,
    identity: { ...plan.identity },
    hostAddress: plan.hostAddress,
    containerPort: plan.containerPort,
    storage: { ...plan.storage },
    resources: { ...plan.resources },
    pinnedIndexingBehavior: { ...PINNED_SURREAL_INDEXING_BEHAVIOR },
    containerUser: plan.containerUser,
    restartPolicy: plan.restartPolicy,
    indexBuildResumeInterval: plan.indexBuildResumeInterval,
    startedAt: dependencies.now().toISOString(),
    observation,
    cleanup: { containerRemoved: false, volumeRemoved: false, timedOut: false, failures: [] },
  };

  let stage: IsolatedTargetFailureStage = "volume_create";
  let primaryFailure: { stage: IsolatedTargetFailureStage; code: string } | undefined;
  let value: T | undefined;
  let valueReady = false;
  let monitor: { stop(): Promise<void> } | undefined;
  let containerValidated = false;
  let unsettledMutation: "volume_create" | "container_run" | undefined;
  let finalizationPromise: Promise<IsolatedTargetEvidence> | undefined;

  const finalize = (): Promise<IsolatedTargetEvidence> => {
    if (finalizationPromise) return finalizationPromise;
    finalizationPromise = (async () => {
      const cleanupController = new AbortController();
      const cleanupDeadline = setTimeout(() => cleanupController.abort(), cleanupTimeoutMs);
      let terminalFailure:
        | { stage: IsolatedTargetFailureStage; code: string }
        | undefined;
      try {
        const stopping = monitor?.stop() ?? Promise.resolve();
        // Prevent a custom dependency which ignores monitor cancellation from
        // extending finalization beyond its own aggregate deadline.
        void stopping.catch(() => {});
        const monitorDeadline = abortPromise(cleanupController.signal);
        try {
          if (monitorDeadline.promise) {
            await Promise.race([stopping, monitorDeadline.promise]);
          } else {
            await stopping;
          }
        } catch {
          terminalFailure = { stage: "cleanup", code: "state_observation_failed" };
        } finally {
          monitorDeadline.dispose();
          monitor = undefined;
        }

        try {
          const container = await inspectContainer(
            dependencies,
            plan.identity,
            dockerCommandTimeoutMs,
            cleanupController.signal,
          );
          if (!container) {
            if (containerValidated) {
              terminalFailure = { stage: "operation", code: "target_disappeared" };
            }
          } else {
            // Revalidate the immutable launch contract before observing or
            // deleting anything with this exact name.
            // NetworkSettings.Ports may be empty after an OOM/stopped state;
            // the published port was already validated before readiness. The
            // immutable identity/resources/mount contract must still match.
            validateContainerStaticContract(container, plan);
            observation.oomKilled = container.state.OOMKilled === true;
            if (Number.isSafeInteger(container.state.ExitCode)) {
              observation.exitCode = container.state.ExitCode;
            }
            if (container.state.OOMKilled === true || container.state.Running === false) {
              terminalFailure = {
                stage: "operation",
                code: container.state.OOMKilled === true ? "target_oom_killed" : "target_exited",
              };
            }
          }
        } catch {
          terminalFailure = { stage: "cleanup", code: "state_observation_failed" };
        }

        evidence.cleanup = await cleanupOwnedResources(
          dependencies,
          plan.identity,
          dockerCommandTimeoutMs,
          cleanupController.signal,
        );
        if (unsettledMutation) {
          // A timed-out/aborted Docker mutation can still finish daemon-side
          // after its CLI process is killed. Absence observed immediately
          // afterwards is not durable proof, so cleanup must remain failed.
          evidence.cleanup = {
            containerRemoved: unsettledMutation === "volume_create"
              ? evidence.cleanup.containerRemoved
              : false,
            volumeRemoved: false,
            timedOut: true,
            failures: [...new Set([...evidence.cleanup.failures, "cleanup_timeout" as const])],
          };
        }
      } finally {
        clearTimeout(cleanupDeadline);
        evidence.finishedAt = dependencies.now().toISOString();
      }
      if (evidence.cleanup.failures.length > 0 ||
          !evidence.cleanup.containerRemoved || !evidence.cleanup.volumeRemoved) {
        throw new IsolatedTargetLifecycleError(
          "cleanup",
          "owned_resource_cleanup_failed",
          evidence,
        );
      }
      if (terminalFailure) {
        throw new IsolatedTargetLifecycleError(
          terminalFailure.stage,
          terminalFailure.code,
          evidence,
        );
      }
      return evidence;
    })();
    return finalizationPromise;
  };

  try {
    await docker(dependencies, {
      args: ["volume", "create", ...labelArgs(plan.identity), plan.identity.volumeName],
      timeoutMs: dockerCommandTimeoutMs,
      maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
      signal: options.signal,
    }, "volume_create");
    const volume = await inspectVolume(
      dependencies,
      plan.identity,
      dockerCommandTimeoutMs,
      options.signal,
    );
    if (!volume) throw new Error("created volume disappeared");
    validateCreatedVolume(volume, plan.identity);

    stage = "container_start";
    await docker(dependencies, {
      args: dockerContainerRunArgs(plan),
      timeoutMs: dockerCommandTimeoutMs,
      maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
      env: containerEnvironment(options.credentials, plan.resources),
      signal: options.signal,
    }, "container_run");
    const container = await inspectContainer(
      dependencies,
      plan.identity,
      dockerCommandTimeoutMs,
      options.signal,
    );
    if (!container) throw new Error("created container disappeared");
    evidence.hostPort = validateCreatedContainer(container, plan);
    containerValidated = true;

    stage = "readiness";
    await waitForReadiness(
      dependencies,
      plan.identity,
      readinessTimeoutMs,
      readinessPollMs,
      dockerCommandTimeoutMs,
      options.signal,
    );
    evidence.runtimeVersion = await runtimeVersion(
      dependencies,
      plan.identity,
      dockerCommandTimeoutMs,
      options.signal,
    );
    evidence.readyAt = dependencies.now().toISOString();
    await sampleDockerStats(
      dependencies,
      plan.identity,
      observation,
      dockerCommandTimeoutMs,
      options.signal,
    );
    monitor = startStatsMonitor(
      dependencies,
      plan.identity,
      statsPollMs,
      observation,
      dockerCommandTimeoutMs,
    );

    stage = "operation";
    const target: IsolatedSurrealTarget = Object.freeze({
      surrealUrl: `ws://${plan.hostAddress}:${evidence.hostPort}/rpc`,
      httpBaseUrl: `http://${plan.hostAddress}:${evidence.hostPort}`,
      hostAddress: plan.hostAddress,
      hostPort: evidence.hostPort,
      containerName: plan.identity.containerName,
      volumeName: plan.identity.volumeName,
      signal: options.signal,
      finalize,
    });
    const pending = Promise.resolve().then(() => operation(target));
    // Prevent a callback which loses the abort race from becoming unhandled.
    void pending.catch(() => {});
    const cancellation = abortPromise(options.signal);
    try {
      value = cancellation.promise
        ? await Promise.race([pending, cancellation.promise])
        : await pending;
      valueReady = true;
    } finally {
      cancellation.dispose();
    }
  } catch (error) {
    if (error instanceof InternalDockerCommandError &&
        (error.operation === "volume_create" || error.operation === "container_run") &&
        (error.failure === "timed_out" || error.failure === "aborted" ||
          error.failure === "output_limit")) {
      unsettledMutation = error.operation;
    }
    primaryFailure = error instanceof IsolatedTargetLifecycleError
      ? { stage: error.stage, code: error.code }
      : { stage, code: failureCode(error, options.signal) };
  } finally {
    let finalizationFailure: IsolatedTargetLifecycleError | undefined;
    try {
      await finalize();
    } catch (error) {
      finalizationFailure = error instanceof IsolatedTargetLifecycleError
        ? error
        : new IsolatedTargetLifecycleError("cleanup", "owned_resource_cleanup_failed", evidence);
    }
    if (finalizationFailure) {
      // Cleanup/OOM/disappearance evidence is more specific than an operation
      // callback rejecting because that same finalization failed.
      primaryFailure = {
        stage: finalizationFailure.stage,
        code: finalizationFailure.code,
      };
    }
  }
  if (primaryFailure) {
    throw new IsolatedTargetLifecycleError(primaryFailure.stage, primaryFailure.code, evidence);
  }
  if (!valueReady) {
    throw new IsolatedTargetLifecycleError("operation", "missing_result", evidence);
  }
  return { value: value as T, evidence };
}
