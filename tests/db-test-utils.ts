/**
 * Общие helper'ы integration-тестов с живым SurrealDB (образец —
 * tests/migrations.integration.test.ts): уникальные namespace на test-файл
 * и database на прогон, cleanup в teardown, скип без живой БД.
 *
 * Bun запускает test-файлы параллельно в отдельных worker-процессах. RocksDB
 * одного Surreal-сервера и HTTP export/import при этом остаются общим тяжёлым
 * ресурсом, поэтому live-файлы дополнительно берут межпроцессный lease. Lease
 * берётся top-level (до test timeout), а не внутри отдельного test callback.
 */

import { test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Surreal } from "surrealdb";
import { applyMigrations } from "../src/db/migrations.ts";

export const SURREAL_URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8901/rpc";
export const SURREAL_USER = process.env.SURREAL_USER ?? "root";
export const SURREAL_PASS = process.env.SURREAL_PASS ?? "root";
export const TEST_NAMESPACE =
  `baka_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const LIVE_TEST_LEASE_SCOPE = process.env.BAKA_TEST_LIVE_LEASE_SCOPE ?? SURREAL_URL;
const LIVE_TEST_LEASE_SCOPE_SHA256 = createHash("sha256")
  .update(LIVE_TEST_LEASE_SCOPE)
  .digest("hex");
const LIVE_TEST_STATE_DIR = path.resolve(
  process.env.BAKA_TEST_STATE_DIR ??
    path.join(tmpdir(), `ai-baka-live-test-state-v1-${process.getuid?.() ?? "user"}`),
);

/** Stable non-system port in the documented high range 40000..59999. */
export function liveTestLeasePortForScope(scope: string): number {
  const prefix = createHash("sha256").update(scope).digest().readUInt32BE(0);
  return 40_000 + (prefix % 20_000);
}

export const LIVE_TEST_LEASE_PORT = liveTestLeasePortForScope(LIVE_TEST_LEASE_SCOPE);
const LIVE_TEST_LEASE_BANNER =
  `ai-baka-live-test-lease:v1:${LIVE_TEST_LEASE_SCOPE_SHA256.slice(0, 24)}\n`;

export type LiveServerOperationKind = "http-export" | "http-import";

interface LiveServerOperationPoisonMarker {
  readonly formatVersion: 1;
  readonly scopeSha256: string;
  readonly kind: LiveServerOperationKind;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
}

interface ObservedLiveServerOperationPoison {
  readonly marker: LiveServerOperationPoisonMarker;
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface ObservedLiveServerOperationPoisonState {
  readonly claim?: ObservedLiveServerOperationPoison;
  readonly marker?: ObservedLiveServerOperationPoison;
}

interface OwnedLiveServerOperationPoison {
  readonly claim: ObservedLiveServerOperationPoison & { readonly handle: FileHandle };
  readonly marker: ObservedLiveServerOperationPoison & { readonly handle: FileHandle };
}

export interface LiveServerOperationPoisonProbe {
  readonly poisoned: boolean;
  readonly scopeSha256: string;
  readonly kind?: LiveServerOperationKind;
  readonly token?: string;
  readonly pid?: number;
  readonly createdAt?: string;
}

export interface LiveServerOperationPoisonStore {
  readonly scopeSha256: string;
  readonly poisonPathPrefix: string;
  pathForToken(token: string): string;
  probe(): Promise<LiveServerOperationPoisonProbe>;
  run<T>(
    kind: LiveServerOperationKind,
    callback: () => T | Promise<T>,
    options?: {
      removeWithin?: (removeExactMarker: () => Promise<void>) => Promise<void>;
    },
  ): Promise<T>;
  clear(options: {
    scopeSha256: string;
    confirmation: string;
    healthProbe: () => Promise<void>;
  }): Promise<LiveServerOperationPoisonProbe>;
}

const LIVE_SERVER_OPERATION_KINDS = new Set<LiveServerOperationKind>([
  "http-export",
  "http-import",
]);
const LIVE_SERVER_OPERATION_POISON_FORMAT_VERSION = 1;
const LIVE_SERVER_OPERATION_POISON_MAX_BYTES = 4096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function stateDirectoryFor(options?: { stateDir?: string }): string {
  return path.resolve(options?.stateDir ?? LIVE_TEST_STATE_DIR);
}

export function liveServerOperationPoisonPathForScope(
  scope: string,
  options?: { stateDir?: string },
): string {
  const scopeSha256 = createHash("sha256").update(scope).digest("hex");
  return path.join(stateDirectoryFor(options), `${scopeSha256}.http-operation.poison`);
}

function poisonPathForToken(prefix: string, token: string): string {
  if (!/^[0-9a-f]{32}$/u.test(token)) throw new Error("invalid live test poison token");
  return `${prefix}.${token}.json`;
}

function poisonClaimPath(prefix: string): string {
  return `${prefix}.claim`;
}

export function liveServerOperationClearConfirmation(scopeSha256: string): string {
  if (!SHA256_PATTERN.test(scopeSha256)) throw new Error("invalid live test scope SHA-256");
  return `I RESET DISPOSABLE SURREAL ${scopeSha256}`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateStateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assertPrivateStateDirectoryStats(await lstat(directory));
}

function assertPrivateStateDirectoryStats(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("live test state directory must be a real directory");
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("live test state directory must not be accessible by group or other");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("live test state directory must be owned by the current user");
  }
}

async function poisonPathInStateDirectory(
  poisonPathPrefix: string,
): Promise<string | undefined> {
  const directory = path.dirname(poisonPathPrefix);
  try {
    assertPrivateStateDirectoryStats(await lstat(directory));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  const base = path.basename(poisonPathPrefix);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const validName = new RegExp(`^${escapedBase}\\.[0-9a-f]{32}\\.json$`, "u");
  const related = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(`${base}.`) && entry.name !== `${base}.claim`);
  const invalid = related.find((entry) => !validName.test(entry.name));
  if (invalid) {
    throw new Error("live test HTTP operation poison marker name is malformed");
  }
  if (related.length > 1) {
    throw new Error("multiple live test HTTP operation poison markers exist for one scope");
  }
  return related[0] ? path.join(directory, related[0].name) : undefined;
}

function parseLiveServerOperationPoison(raw: string): LiveServerOperationPoisonMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("live test HTTP operation poison marker is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("live test HTTP operation poison marker is malformed");
  }
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  const expectedKeys = ["createdAt", "formatVersion", "kind", "pid", "scopeSha256", "token"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    marker.formatVersion !== LIVE_SERVER_OPERATION_POISON_FORMAT_VERSION ||
    typeof marker.scopeSha256 !== "string" ||
    !SHA256_PATTERN.test(marker.scopeSha256) ||
    typeof marker.kind !== "string" ||
    !LIVE_SERVER_OPERATION_KINDS.has(marker.kind as LiveServerOperationKind) ||
    typeof marker.token !== "string" ||
    !/^[0-9a-f]{32}$/u.test(marker.token) ||
    !Number.isSafeInteger(marker.pid) ||
    (marker.pid as number) <= 0 ||
    typeof marker.createdAt !== "string" ||
    !Number.isFinite(Date.parse(marker.createdAt))
  ) {
    throw new Error("live test HTTP operation poison marker is malformed");
  }
  return Object.freeze({
    formatVersion: LIVE_SERVER_OPERATION_POISON_FORMAT_VERSION,
    scopeSha256: marker.scopeSha256,
    kind: marker.kind as LiveServerOperationKind,
    token: marker.token,
    pid: marker.pid as number,
    createdAt: marker.createdAt,
  });
}

function assertSafePoisonStats(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error("live test HTTP operation poison marker is not a safe regular file");
  }
  if (stats.size <= 0 || stats.size > LIVE_SERVER_OPERATION_POISON_MAX_BYTES) {
    throw new Error("live test HTTP operation poison marker has an invalid size");
  }
  if ((stats.mode & 0o777) !== 0o600) {
    throw new Error("live test HTTP operation poison marker mode must be exactly 0600");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("live test HTTP operation poison marker has the wrong owner");
  }
}

async function observeLiveServerOperationPoison(
  poisonPath: string,
  expectedScopeSha256: string,
  expectedPath: "claim" | "marker",
): Promise<ObservedLiveServerOperationPoison | undefined> {
  try {
    assertPrivateStateDirectoryStats(await lstat(path.dirname(poisonPath)));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  let pathStats: Awaited<ReturnType<typeof lstat>>;
  try {
    pathStats = await lstat(poisonPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  assertSafePoisonStats(pathStats);
  const handle = await open(poisonPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = await handle.stat();
    assertSafePoisonStats(openedStats);
    if (openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
      throw new Error("live test HTTP operation poison marker changed while opening");
    }
    const buffer = Buffer.alloc(LIVE_SERVER_OPERATION_POISON_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      LIVE_SERVER_OPERATION_POISON_MAX_BYTES + 1,
      0,
    );
    if (bytesRead > LIVE_SERVER_OPERATION_POISON_MAX_BYTES) {
      throw new Error("live test HTTP operation poison marker exceeds the read limit");
    }
    const marker = parseLiveServerOperationPoison(buffer.subarray(0, bytesRead).toString("utf8"));
    if (marker.scopeSha256 !== expectedScopeSha256) {
      throw new Error("live test HTTP operation poison marker scope mismatch");
    }
    const expectedBasename = expectedPath === "claim"
      ? `${expectedScopeSha256}.http-operation.poison.claim`
      : `${expectedScopeSha256}.http-operation.poison.${marker.token}.json`;
    if (path.basename(poisonPath) !== expectedBasename) {
      throw new Error("live test HTTP operation poison marker token/path mismatch");
    }
    const finalStats = await lstat(poisonPath);
    if (finalStats.dev !== openedStats.dev || finalStats.ino !== openedStats.ino) {
      throw new Error("live test HTTP operation poison marker changed while reading");
    }
    return Object.freeze({
      marker,
      path: poisonPath,
      dev: openedStats.dev,
      ino: openedStats.ino,
    });
  } finally {
    await handle.close();
  }
}

async function createLiveServerOperationPoisonFile(
  poisonPath: string,
  marker: LiveServerOperationPoisonMarker,
): Promise<ObservedLiveServerOperationPoison & { readonly handle: FileHandle }> {
  const directory = path.dirname(poisonPath);
  let handle: FileHandle;
  try {
    handle = await open(
      poisonPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_RDWR |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (isNodeError(error, "EEXIST") || isNodeError(error, "ELOOP")) {
      throw new Error("live test HTTP operation scope is poisoned by an existing atomic claim");
    }
    throw error;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
    const stats = await handle.stat();
    assertSafePoisonStats(stats);
    await syncDirectory(directory);
    return Object.freeze({ marker, path: poisonPath, dev: stats.dev, ino: stats.ino, handle });
  } catch (error) {
    await handle.close().catch(() => {});
    // A partial claim/marker is deliberately left behind and will fail closed.
    throw error;
  }
}

async function createLiveServerOperationPoison(
  poisonPathPrefix: string,
  scopeSha256: string,
  kind: LiveServerOperationKind,
): Promise<OwnedLiveServerOperationPoison> {
  if (!LIVE_SERVER_OPERATION_KINDS.has(kind)) {
    throw new Error(`unsupported live server operation kind: ${String(kind)}`);
  }
  const directory = path.dirname(poisonPathPrefix);
  await ensurePrivateStateDirectory(directory);
  const orphanPath = await poisonPathInStateDirectory(poisonPathPrefix);
  if (orphanPath) {
    const orphan = await observeLiveServerOperationPoison(orphanPath, scopeSha256, "marker");
    if (!orphan) throw new Error("live test HTTP operation poison disappeared while opening");
    throw new Error(
      `live test HTTP operation scope is poisoned by ${orphan.marker.kind} ` +
        `(${orphan.marker.token}); run the explicit probe/clear workflow`,
    );
  }
  const marker: LiveServerOperationPoisonMarker = Object.freeze({
    formatVersion: LIVE_SERVER_OPERATION_POISON_FORMAT_VERSION,
    scopeSha256,
    kind,
    token: randomUUID().replaceAll("-", ""),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  const claim = await createLiveServerOperationPoisonFile(
    poisonClaimPath(poisonPathPrefix),
    marker,
  );
  try {
    const racedOrphanPath = await poisonPathInStateDirectory(poisonPathPrefix);
    if (racedOrphanPath) {
      throw new Error("live test HTTP operation marker appeared after the atomic claim");
    }
    const tokenMarker = await createLiveServerOperationPoisonFile(
      poisonPathForToken(poisonPathPrefix, marker.token),
      marker,
    );
    return Object.freeze({ claim, marker: tokenMarker });
  } catch (error) {
    await claim.handle.close().catch(() => {});
    // The stable claim remains as poison on every partial acquisition.
    throw error;
  }
}

async function removeExactLiveServerOperationPoison(
  observed: ObservedLiveServerOperationPoison,
  expectedPath: "claim" | "marker",
): Promise<void> {
  const current = await observeLiveServerOperationPoison(
    observed.path,
    observed.marker.scopeSha256,
    expectedPath,
  );
  if (
    !current ||
    current.dev !== observed.dev ||
    current.ino !== observed.ino ||
    current.marker.token !== observed.marker.token
  ) {
    throw new Error("live test HTTP operation poison ownership changed; refusing stale deletion");
  }
  const finalStats = await lstat(observed.path);
  if (finalStats.dev !== observed.dev || finalStats.ino !== observed.ino) {
    throw new Error("live test HTTP operation poison changed before deletion");
  }
  await unlink(observed.path);
  await syncDirectory(path.dirname(observed.path));
}

function poisonProbe(
  scopeSha256: string,
  state: ObservedLiveServerOperationPoisonState | undefined,
): LiveServerOperationPoisonProbe {
  const observed = state?.claim ?? state?.marker;
  return Object.freeze(observed
    ? {
        poisoned: true,
        scopeSha256,
        kind: observed.marker.kind,
        token: observed.marker.token,
        pid: observed.marker.pid,
        createdAt: observed.marker.createdAt,
      }
    : { poisoned: false, scopeSha256 });
}

export function createLiveServerOperationPoisonStore(options: {
  scope: string;
  stateDir?: string;
}): LiveServerOperationPoisonStore {
  const scopeSha256 = createHash("sha256").update(options.scope).digest("hex");
  const poisonPathPrefix = liveServerOperationPoisonPathForScope(options.scope, options);
  const observeCurrent = async (): Promise<ObservedLiveServerOperationPoisonState | undefined> => {
    const claim = await observeLiveServerOperationPoison(
      poisonClaimPath(poisonPathPrefix),
      scopeSha256,
      "claim",
    );
    const markerPath = await poisonPathInStateDirectory(poisonPathPrefix);
    const marker = markerPath
      ? await observeLiveServerOperationPoison(markerPath, scopeSha256, "marker")
      : undefined;
    if (!claim && !marker) return undefined;
    if (claim && marker && JSON.stringify(claim.marker) !== JSON.stringify(marker.marker)) {
      throw new Error("live test HTTP operation claim/marker binding mismatch");
    }
    return Object.freeze({ claim, marker });
  };
  const probe = async (): Promise<LiveServerOperationPoisonProbe> =>
    poisonProbe(scopeSha256, await observeCurrent());
  return Object.freeze({
    scopeSha256,
    poisonPathPrefix,
    pathForToken: (token: string) => poisonPathForToken(poisonPathPrefix, token),
    probe,
    async run<T>(
      kind: LiveServerOperationKind,
      callback: () => T | Promise<T>,
      runOptions?: {
        removeWithin?: (removeExactMarker: () => Promise<void>) => Promise<void>;
      },
    ): Promise<T> {
      const owned = await createLiveServerOperationPoison(poisonPathPrefix, scopeSha256, kind);
      try {
        const result = await callback();
        const remove = async () => {
          await removeExactLiveServerOperationPoison(owned.marker, "marker");
          await removeExactLiveServerOperationPoison(owned.claim, "claim");
        };
        if (runOptions?.removeWithin) await runOptions.removeWithin(remove);
        else await remove();
        return result;
      } finally {
        await Promise.all([
          owned.marker.handle.close().catch(() => {}),
          owned.claim.handle.close().catch(() => {}),
        ]);
      }
    },
    async clear(clearOptions: {
      scopeSha256: string;
      confirmation: string;
      healthProbe: () => Promise<void>;
    }): Promise<LiveServerOperationPoisonProbe> {
      if (clearOptions.scopeSha256 !== scopeSha256) {
        throw new Error("live test poison clear scope SHA-256 mismatch");
      }
      if (clearOptions.confirmation !== liveServerOperationClearConfirmation(scopeSha256)) {
        throw new Error("live test poison clear requires the exact disposable reset confirmation");
      }
      const observed = await observeCurrent();
      if (!observed) throw new Error("live test HTTP operation poison marker does not exist");
      await clearOptions.healthProbe();
      if (observed.marker) {
        await removeExactLiveServerOperationPoison(observed.marker, "marker");
      }
      if (observed.claim) {
        await removeExactLiveServerOperationPoison(observed.claim, "claim");
      }
      return poisonProbe(scopeSha256, undefined);
    },
  });
}

const liveServerOperationPoisonStore = createLiveServerOperationPoisonStore({
  scope: LIVE_TEST_LEASE_SCOPE,
  stateDir: LIVE_TEST_STATE_DIR,
});

let liveTestLease: Server | undefined;
let liveTestFinishPromise: Promise<void> | undefined;
let liveTestLeaseClosing = false;
let liveServerOperationRemovalPromise: Promise<void> | undefined;
const openTestDbs = new Set<TestDb>();
const testDbStates = new WeakMap<TestDb, { databaseRemoved: boolean; connectionClosed: boolean }>();
const testDbDropPromises = new WeakMap<TestDb, Promise<void>>();
const TEST_DATABASE_PATTERN = /^test_[0-9a-f]{32}$/u;

let dbAvailable: boolean | undefined;

export async function isDbAvailable(): Promise<boolean> {
  if (dbAvailable !== undefined) return dbAvailable;
  const probe = new Surreal();
  try {
    await Promise.race([
      probe.connect(SURREAL_URL),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connect timeout")), 2000),
      ),
    ]);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  } finally {
    await probe.close().catch(() => {});
  }
  if (!dbAvailable) console.warn("SKIP: SurrealDB недоступен (docker не поднят)");
  return dbAvailable;
}

/**
 * `test` при живой БД, иначе `test.skip` — ЯВНЫЙ skip в отчёте вместо
 * молчаливого pass (раньше тесты делали `return` и выглядели зелёными,
 * ничего не проверив). Использование в integration-файле (проверка
 * доступности выполняется один раз на файл, до регистрации тестов):
 *
 *   const testDb = await dbTest();
 *   testDb("сценарий", async () => { ... });
 */
export async function dbTest(): Promise<typeof test> {
  await acquireLiveTestFileLease();
  try {
    await assertNoLiveServerOperationPoison();
    if (!(await isDbAvailable())) {
      await releaseLiveTestFileLease();
      return test.skip;
    }
    return test;
  } catch (error) {
    await releaseLiveTestFileLease().catch(() => {});
    throw error;
  }
}

async function assertNoLiveServerOperationPoison(): Promise<void> {
  const poison = await liveServerOperationPoisonStore.probe();
  if (!poison.poisoned) return;
  throw new Error(
    `live test HTTP operation scope ${poison.scopeSha256} is poisoned by ` +
      `${poison.kind ?? "unknown"} (${poison.token ?? "unknown"}); ` +
      "run the explicit probe/clear workflow on a drained disposable server",
  );
}

/**
 * Guard only server-side HTTP export/import work whose callback includes its
 * complete cleanup boundary. Rejection, Bun timeout or process death keeps the
 * marker; only fulfilled cleanup may remove the exact token+inode marker.
 */
export async function withLiveServerOperationGuard<T>(
  kind: LiveServerOperationKind,
  callback: () => T | Promise<T>,
): Promise<T> {
  if (!liveTestLease || liveTestLeaseClosing) {
    throw new Error("live server operation guard requires the live test TCP lease");
  }
  const lease = liveTestLease;
  return liveServerOperationPoisonStore.run(kind, callback, {
    removeWithin: async (removeExactMarker) => {
      if (liveTestLease !== lease || liveTestLeaseClosing || !lease.listening) {
        throw new Error(
          "live test TCP lease ended before guarded HTTP cleanup; poison remains",
        );
      }
      if (liveServerOperationRemovalPromise) {
        throw new Error("another guarded HTTP poison removal is already in progress");
      }
      let settle!: () => void;
      const removal = new Promise<void>((resolve) => { settle = resolve; });
      liveServerOperationRemovalPromise = removal;
      try {
        await removeExactMarker();
      } finally {
        settle();
        if (liveServerOperationRemovalPromise === removal) {
          liveServerOperationRemovalPromise = undefined;
        }
      }
    },
  });
}

export function probeLiveServerOperationPoison(): Promise<LiveServerOperationPoisonProbe> {
  return liveServerOperationPoisonStore.probe();
}

function validateExplicitDisposableServerUrl(
  serverUrl: string,
  expectedScopeSha256: string,
): URL {
  if (!serverUrl.trim()) throw new Error("--surreal-url must be explicitly supplied");
  if (serverUrl !== SURREAL_URL || LIVE_TEST_LEASE_SCOPE !== serverUrl) {
    throw new Error("explicit clear URL must exactly equal SURREAL_URL and the lease scope");
  }
  if (createHash("sha256").update(serverUrl).digest("hex") !== expectedScopeSha256) {
    throw new Error("explicit clear URL does not match the confirmed scope SHA-256");
  }
  const literal = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/rpc$/u.exec(serverUrl);
  if (!literal) {
    throw new Error(
      "poison clear requires literal canonical ws://127.0.0.1:<port>/rpc",
    );
  }
  const url = new URL(serverUrl);
  if (url.toString() !== serverUrl) {
    throw new Error("poison clear refuses noncanonical URL serialization");
  }
  const port = Number(literal[1]);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535 || port === 8901) {
    throw new Error("poison clear refuses the shared/production SurrealDB port");
  }
  return url;
}

async function acquireLiveTestFileLeaseOnceForClear(): Promise<void> {
  if (liveTestLease) {
    throw new Error("live test poison clear already owns an unexpected test lease");
  }
  const acquired = await tryAcquireLiveTestFileLease();
  if (!acquired) {
    throw new Error(
      `live test lease port ${LIVE_TEST_LEASE_PORT} is occupied; poison clear never waits`,
    );
  }
  liveTestLease = acquired;
}

async function boundedDisposableServerHealthProbe(serverUrl: string): Promise<void> {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/sql";
  const signal = AbortSignal.timeout(2000);
  const queryInfo = async (
    body: string,
    scope?: { namespace: string; database?: string },
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${SURREAL_USER}:${SURREAL_PASS}`).toString("base64")}`,
        "Content-Type": "text/plain",
        ...(scope ? { "surreal-ns": scope.namespace } : {}),
        ...(scope?.database ? { "surreal-db": scope.database } : {}),
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`disposable SurrealDB health probe failed with HTTP ${response.status}`);
    }
    const rows = await response.json() as Array<{ status?: unknown; result?: unknown }>;
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?.status !== "OK" ||
      !row.result ||
      typeof row.result !== "object" ||
      Array.isArray(row.result)
    ) {
      throw new Error("disposable SurrealDB health probe returned an invalid INFO response");
    }
    return row.result as Record<string, unknown>;
  };

  const rootInfo = await queryInfo("INFO FOR ROOT;");
  const namespaces = rootInfo.namespaces;
  if (!namespaces || typeof namespaces !== "object" || Array.isArray(namespaces)) {
    throw new Error("disposable SurrealDB health probe omitted root namespaces");
  }
  const allowedNamespace = /^(?:baka_test_[0-9]+_[0-9a-f]{12}|baka_restore_test_[0-9a-f]{32})$/u;
  const namespaceEntries = Object.entries(namespaces);
  const defaultNamespaceDefinition =
    "DEFINE NAMESPACE main COMMENT 'Default namespace generated by SurrealDB'";
  for (const [namespace, definition] of namespaceEntries) {
    if (allowedNamespace.test(namespace)) continue;
    if (namespace !== "main" || definition !== defaultNamespaceDefinition) {
      throw new Error("poison clear refuses a shared/production SurrealDB namespace set");
    }
  }
  if (!Object.hasOwn(namespaces, "main")) {
    throw new Error("poison clear requires the exact SurrealDB default main namespace");
  }

  const namespaceInfo = await queryInfo("INFO FOR NS;", { namespace: "main" });
  const databases = namespaceInfo.databases;
  if (!databases || typeof databases !== "object" || Array.isArray(databases)) {
    throw new Error("disposable SurrealDB health probe omitted main databases");
  }
  const defaultDatabaseDefinition =
    "DEFINE DATABASE main COMMENT 'Default database generated by SurrealDB'";
  if (
    Object.keys(databases).length !== 1 ||
    (databases as Record<string, unknown>).main !== defaultDatabaseDefinition
  ) {
    throw new Error("poison clear requires the exact SurrealDB default main database");
  }

  const databaseInfo = await queryInfo("INFO FOR DB;", {
    namespace: "main",
    database: "main",
  });
  const emptyDatabaseMaps = [
    "accesses",
    "analyzers",
    "apis",
    "buckets",
    "configs",
    "functions",
    "models",
    "modules",
    "params",
    "sequences",
    "tables",
    "users",
  ] as const;
  if (
    Object.keys(databaseInfo).length !== emptyDatabaseMaps.length ||
    emptyDatabaseMaps.some((key) => {
      const value = databaseInfo[key];
      return !value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value as Record<string, unknown>).length !== 0;
    })
  ) {
    throw new Error("poison clear refuses a non-empty or non-default main database");
  }
}

/**
 * Standalone operator recovery only. It never removes namespaces/data: the
 * literal confirmation attests that the explicitly configured disposable
 * server was already drained/reset outside this helper.
 */
export async function clearLiveServerOperationPoison(options: {
  scopeSha256: string;
  confirmation: string;
  serverUrl: string;
}): Promise<LiveServerOperationPoisonProbe> {
  if (liveTestLease) {
    throw new Error("live test poison clear must run standalone without an owned test lease");
  }
  if (options.scopeSha256 !== LIVE_TEST_LEASE_SCOPE_SHA256) {
    throw new Error("live test poison clear scope SHA-256 mismatch");
  }
  if (
    options.confirmation !==
      liveServerOperationClearConfirmation(LIVE_TEST_LEASE_SCOPE_SHA256)
  ) {
    throw new Error("live test poison clear requires the exact disposable reset confirmation");
  }
  validateExplicitDisposableServerUrl(options.serverUrl, options.scopeSha256);
  await acquireLiveTestFileLeaseOnceForClear();
  try {
    return await liveServerOperationPoisonStore.clear({
      scopeSha256: options.scopeSha256,
      confirmation: options.confirmation,
      healthProbe: () => boundedDisposableServerHealthProbe(options.serverUrl),
    });
  } finally {
    await releaseLiveTestFileLease();
  }
}

export interface TestDb {
  readonly db: Surreal;
  readonly name: string;
}

function tryAcquireLiveTestFileLease(): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.end(LIVE_TEST_LEASE_BANNER);
    });
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve(undefined);
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      // The lease must not keep a zero-match Bun subprocess alive. The kernel
      // still owns the port until normal close or process death (including
      // SIGKILL), which removes pathname/PID stale-recovery races entirely.
      server.unref();
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: LIVE_TEST_LEASE_PORT, exclusive: true });
  });
}

type LeaseProbe = "same-lease" | "close-race" | "unrelated";

function probeLiveTestLeaseOwner(): Promise<LeaseProbe> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: LIVE_TEST_LEASE_PORT });
    let received = "";
    let settled = false;
    const finish = (result: LeaseProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (
        received.length > LIVE_TEST_LEASE_BANNER.length ||
        !LIVE_TEST_LEASE_BANNER.startsWith(received)
      ) finish("unrelated");
    });
    socket.once("end", () => {
      if (received === LIVE_TEST_LEASE_BANNER) finish("same-lease");
      else if (LIVE_TEST_LEASE_BANNER.startsWith(received)) finish("close-race");
      else finish("unrelated");
    });
    socket.once("timeout", () => finish("unrelated"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error.code ?? "")) {
        finish("close-race");
      } else {
        settled = true;
        socket.destroy();
        reject(error);
      }
    });
  });
}

async function acquireLiveTestFileLease(timeoutMs?: number): Promise<void> {
  if (liveTestLease) return;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  let consecutiveCloseRaces = 0;
  for (;;) {
    const acquired = await tryAcquireLiveTestFileLease();
    if (acquired) {
      liveTestLease = acquired;
      return;
    }
    const owner = await probeLiveTestLeaseOwner();
    if (owner === "unrelated") {
      throw new Error(
        `live test lease port ${LIVE_TEST_LEASE_PORT} is occupied by an unrelated listener`,
      );
    }
    if (owner === "close-race") {
      consecutiveCloseRaces += 1;
      if (consecutiveCloseRaces >= 10) {
        throw new Error(
          `live test lease port ${LIVE_TEST_LEASE_PORT} has an unverifiable listener`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    consecutiveCloseRaces = 0;
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`timed out acquiring live test lease port ${LIVE_TEST_LEASE_PORT}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function releaseLiveTestFileLease(): Promise<void> {
  const lease = liveTestLease;
  if (!lease) return;
  liveTestLeaseClosing = true;
  try {
    await liveServerOperationRemovalPromise;
    await new Promise<void>((resolve, reject) => {
      lease.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    // Do not advertise the lease as released until the OS confirms close.
    if (liveTestLease === lease) liveTestLease = undefined;
    liveTestFinishPromise = undefined;
  } finally {
    liveTestLeaseClosing = false;
  }
}

function rootSqlUrl(): string {
  const url = new URL(SURREAL_URL);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "/sql";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function removeTestNamespace(): Promise<void> {
  const response = await fetch(rootSqlUrl(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${SURREAL_USER}:${SURREAL_PASS}`).toString("base64")}`,
    },
    body: `REMOVE NAMESPACE IF EXISTS ${TEST_NAMESPACE};`,
  });
  if (!response.ok) {
    throw new Error(`test namespace cleanup: HTTP ${response.status}: ${await response.text()}`);
  }
  const results = (await response.json()) as Array<{ status?: unknown; detail?: unknown }>;
  const failed = results.find((result) => result.status !== "OK");
  if (failed) {
    throw new Error(`test namespace cleanup: ${String(failed.detail ?? failed.status)}`);
  }
}

function assertTestDatabaseName(name: string): void {
  if (!TEST_DATABASE_PATTERN.test(name)) {
    throw new Error(`unsafe test database identifier: ${JSON.stringify(name)}`);
  }
}

async function removeTestDatabase(name: string): Promise<void> {
  assertTestDatabaseName(name);
  const cleanupDb = new Surreal();
  try {
    await cleanupDb.connect(SURREAL_URL);
    await cleanupDb.signin({ username: SURREAL_USER, password: SURREAL_PASS });
    await cleanupDb.use({ namespace: TEST_NAMESPACE });
    await cleanupDb.query(`REMOVE DATABASE IF EXISTS ${name}`);
  } finally {
    await cleanupDb.close().catch(() => {});
  }
}

/**
 * Explicit file teardown seam. It must be registered by the caller test file:
 * Bun does not attach an `afterAll` declared inside this imported helper to
 * the caller's lifecycle.
 */
export function finishLiveTestFile(): Promise<void> {
  // When SurrealDB was unavailable, dbTest returned test.skip without taking
  // a lease or creating a namespace; teardown must preserve the explicit skip.
  if (!liveTestLease) return Promise.resolve();
  liveTestFinishPromise ??= cleanupLiveTestFile();
  return liveTestFinishPromise;
}

async function cleanupLiveTestFile(): Promise<void> {
  let failure: unknown;
  try {
    for (const t of [...openTestDbs]) {
      try {
        await dropTestDb(t);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await removeTestNamespace();
    } catch (error) {
      failure ??= error;
    }
  } finally {
    try {
      await releaseLiveTestFileLease();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/** Новая уникальная database с применёнными миграциями. */
export async function createTestDb(withSchema = true): Promise<TestDb> {
  const db = new Surreal();
  let tracked: TestDb | undefined;
  try {
    await db.connect(SURREAL_URL);
    await db.signin({ username: SURREAL_USER, password: SURREAL_PASS });
    await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${TEST_NAMESPACE}`);
    await db.use({ namespace: TEST_NAMESPACE });
    const name = `test_${randomUUID().replaceAll("-", "")}`;
    assertTestDatabaseName(name);
    await db.query(`DEFINE DATABASE ${name}`);
    await db.use({ namespace: TEST_NAMESPACE, database: name });
    tracked = Object.freeze({ db, name });
    testDbStates.set(tracked, { databaseRemoved: false, connectionClosed: false });
    openTestDbs.add(tracked);
    if (withSchema) {
      await applyMigrations(db, { bakaCommit: "test", surrealdbVersion: "test" });
    }
    return tracked;
  } catch (error) {
    if (tracked) {
      try {
        await dropTestDb(tracked);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "test database setup and cleanup failed");
      }
    } else {
      await db.close().catch(() => {});
    }
    throw error;
  }
}

export async function dropTestDb(t: TestDb): Promise<void> {
  const existing = testDbDropPromises.get(t);
  if (existing) return existing;
  const operation = dropTrackedTestDb(t);
  testDbDropPromises.set(t, operation);
  try {
    await operation;
  } catch (error) {
    if (testDbDropPromises.get(t) === operation) testDbDropPromises.delete(t);
    throw error;
  }
}

async function dropTrackedTestDb(t: TestDb): Promise<void> {
  const state = testDbStates.get(t);
  if (!state) throw new Error("dropTestDb only accepts handles returned by createTestDb");
  assertTestDatabaseName(t.name);
  if (!state.databaseRemoved) {
    await removeTestDatabase(t.name);
    state.databaseRemoved = true;
  }
  if (!state.connectionClosed) {
    await t.db.close();
    state.connectionClosed = true;
  }
  openTestDbs.delete(t);
  // Namespace deletion belongs to the last database owner, not a hook in the
  // imported helper module (Bun scopes that hook to the helper, before caller
  // tests). A failure leaves the completed DB state retryable through this
  // same tracked handle, while never widening cleanup beyond its namespace.
  if (openTestDbs.size === 0) await removeTestNamespace();
}

function cliOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runLiveTestPoisonCli(): Promise<void> {
  const action = process.argv[2];
  if (action === "poison:probe") {
    console.log(JSON.stringify(await probeLiveServerOperationPoison(), null, 2));
    return;
  }
  if (action === "poison:clear") {
    const result = await clearLiveServerOperationPoison({
      scopeSha256: cliOption("--scope-sha256"),
      confirmation: cliOption("--confirm"),
      serverUrl: cliOption("--surreal-url"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(
    "usage: bun run tests/db-test-utils.ts poison:probe | " +
      "poison:clear --scope-sha256 <sha256> --surreal-url <disposable-url> " +
      "--confirm <literal>",
  );
}

if (import.meta.main) {
  runLiveTestPoisonCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
