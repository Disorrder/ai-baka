import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LIVE_TEST_LEASE_PORT,
  SURREAL_PASS,
  SURREAL_URL,
  SURREAL_USER,
  createLiveServerOperationPoisonStore,
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
  liveServerOperationClearConfirmation,
  liveTestLeasePortForScope,
} from "./db-test-utils.ts";

const HELPER_PATH = path.resolve(import.meta.dir, "db-test-utils.ts");
const TEST_NAMESPACE_PATTERN = /^baka_test_[0-9]+_[0-9a-f]{12}$/u;
const liveTest = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

interface ChildRun {
  child: ChildProcess;
  result: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }>;
}

interface Marker {
  namespace: string;
  database: string;
  leasePort: number;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function distinctScope(label: string, excludedPorts: Set<number>): string {
  for (;;) {
    const scope = `${label}-${randomUUID()}`;
    const port = liveTestLeasePortForScope(scope);
    if (!excludedPorts.has(port)) {
      excludedPorts.add(port);
      return scope;
    }
  }
}

function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function startFixture(
  fixturePath: string,
  options: {
    scope: string;
    markerPath: string;
    releasePath: string;
    pattern?: string;
    setupFail?: boolean;
    hold?: boolean;
  },
): ChildRun {
  const args = ["test", "--timeout", "10000", "--pass-with-no-tests"];
  if (options.pattern) args.push("--test-name-pattern", options.pattern);
  args.push(fixturePath);
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH ?? "",
      SURREAL_URL,
      SURREAL_USER,
      SURREAL_PASS,
      BAKA_TEST_LIVE_LEASE_SCOPE: options.scope,
      MARKER_PATH: options.markerPath,
      RELEASE_PATH: options.releasePath,
      SETUP_FAIL: options.setupFail ? "1" : "0",
      HOLD_TEST_DB: options.hold ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  return {
    child,
    result: new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal, output }));
    }),
  };
}

async function rootSql(statement: string): Promise<Array<{ status: string; result: unknown }>> {
  const base = SURREAL_URL
    .replace(/^ws:\/\//u, "http://")
    .replace(/^wss:\/\//u, "https://")
    .replace(/\/rpc\/?$/u, "");
  const response = await fetch(`${base}/sql`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${SURREAL_USER}:${SURREAL_PASS}`).toString("base64")}`,
    },
    body: statement,
  });
  if (!response.ok) throw new Error(`root SQL HTTP ${response.status}`);
  const rows = await response.json() as Array<{ status: string; result: unknown }>;
  const failed = rows.find((row) => row.status !== "OK");
  if (failed) throw new Error(`root SQL failed: ${JSON.stringify(failed)}`);
  return rows;
}

async function namespaceDatabases(namespace: string): Promise<string[]> {
  if (!TEST_NAMESPACE_PATTERN.test(namespace)) throw new Error("unsafe test namespace");
  const rows = await rootSql(`USE NS ${namespace}; INFO FOR NS;`);
  const info = rows[1]?.result as { databases?: Record<string, unknown> } | undefined;
  return Object.keys(info?.databases ?? {});
}

async function namespaceExists(namespace: string): Promise<boolean> {
  if (!TEST_NAMESPACE_PATTERN.test(namespace)) throw new Error("unsafe test namespace");
  const rows = await rootSql("INFO FOR ROOT;");
  const info = rows[0]?.result as { namespaces?: Record<string, unknown> } | undefined;
  return Object.hasOwn(info?.namespaces ?? {}, namespace);
}

async function removeOwnedNamespace(namespace: string): Promise<void> {
  if (!TEST_NAMESPACE_PATTERN.test(namespace)) throw new Error("unsafe test namespace");
  await rootSql(`REMOVE NAMESPACE IF EXISTS ${namespace};`);
}

async function marker(filePath: string): Promise<Marker> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Marker;
  if (
    !TEST_NAMESPACE_PATTERN.test(value.namespace) ||
    typeof value.database !== "string" ||
    !Number.isSafeInteger(value.leasePort) ||
    value.leasePort < 40_000 ||
    value.leasePort >= 60_000
  ) throw new Error("invalid subprocess marker");
  return value;
}

async function writeFixture(directory: string): Promise<string> {
  const fixturePath = path.join(directory, "lease-fixture.test.ts");
  await writeFile(
    fixturePath,
    `import { afterAll, beforeAll } from "bun:test";
import { access, writeFile } from "node:fs/promises";
import {
  LIVE_TEST_LEASE_PORT,
  TEST_NAMESPACE,
  createTestDb,
  dbTest,
  dropTestDb,
  finishLiveTestFile,
} from ${JSON.stringify(HELPER_PATH)};

const liveTest = await dbTest();
afterAll(async () => { await finishLiveTestFile(); });

beforeAll(async () => {
  if (process.env.SETUP_FAIL !== "1") return;
  const db = await createTestDb(false);
  await writeFile(process.env.MARKER_PATH!, JSON.stringify({
    namespace: TEST_NAMESPACE,
    database: db.name,
    leasePort: LIVE_TEST_LEASE_PORT,
  }));
  throw new Error("intentional setup failure");
});

liveTest("selected live lease", async () => {
  const db = await createTestDb(false);
  try {
    await writeFile(process.env.MARKER_PATH!, JSON.stringify({
      namespace: TEST_NAMESPACE,
      database: db.name,
      leasePort: LIVE_TEST_LEASE_PORT,
    }));
    if (process.env.HOLD_TEST_DB === "1") {
      while (true) {
        try { await access(process.env.RELEASE_PATH!); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
    }
  } finally {
    await dropTestDb(db);
  }
});
`,
    { mode: 0o600 },
  );
  return fixturePath;
}

async function stop(run: ChildRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  await run.result;
}

async function cleanupMarkedNamespaces(markerPaths: string[]): Promise<void> {
  for (const markerPath of markerPaths) {
    if (!(await exists(markerPath))) continue;
    const state = await marker(markerPath);
    if (await namespaceExists(state.namespace)) await removeOwnedNamespace(state.namespace);
  }
}

async function writePoisonFixture(directory: string): Promise<string> {
  const fixturePath = path.join(directory, "poison-fixture.ts");
  await writeFile(
    fixturePath,
    `import { writeFile } from "node:fs/promises";
import { createLiveServerOperationPoisonStore } from ${JSON.stringify(HELPER_PATH)};

const store = createLiveServerOperationPoisonStore({
  scope: process.env.POISON_SCOPE!,
  stateDir: process.env.BAKA_TEST_STATE_DIR!,
});
await store.run("http-import", async () => {
  await writeFile(process.env.POISON_READY!, "ready", { mode: 0o600 });
  await new Promise(() => {});
});
`,
    { mode: 0o600 },
  );
  return fixturePath;
}

async function writePoisonAcquireFixture(directory: string): Promise<string> {
  const fixturePath = path.join(directory, "poison-acquire.test.ts");
  await writeFile(
    fixturePath,
    `import { dbTest } from ${JSON.stringify(HELPER_PATH)};
await dbTest();
`,
    { mode: 0o600 },
  );
  return fixturePath;
}

describe("narrow live HTTP operation poison store", () => {
  test("fulfilled callback clears its exact marker; rejection poisons until explicit clear", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-basic-"));
    const store = createLiveServerOperationPoisonStore({
      scope: `poison-basic-${randomUUID()}`,
      stateDir: path.join(directory, "state"),
    });
    try {
      await expect(store.run("http-export", async () => 42)).resolves.toBe(42);
      expect(await store.probe()).toEqual({ poisoned: false, scopeSha256: store.scopeSha256 });

      await expect(store.run("http-import", async () => {
        throw new Error("simulated import failure");
      })).rejects.toThrow("simulated import failure");
      const poisoned = await store.probe();
      expect(poisoned).toMatchObject({ poisoned: true, kind: "http-import" });
      await expect(store.run("http-export", async () => {})).rejects.toThrow(
        "live test HTTP operation scope is poisoned",
      );

      await expect(store.clear({
        scopeSha256: "0".repeat(64),
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      })).rejects.toThrow("scope SHA-256 mismatch");
      await expect(store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: "not confirmed",
        healthProbe: async () => {},
      })).rejects.toThrow("exact disposable reset confirmation");
      expect((await store.probe()).poisoned).toBe(true);

      let probes = 0;
      await expect(store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => { probes += 1; },
      })).resolves.toEqual({ poisoned: false, scopeSha256: store.scopeSha256 });
      expect(probes).toBe(1);
      await expect(store.run("http-export", async () => "enabled")).resolves.toBe("enabled");

      await expect(store.run("http-import", async () => "late", {
        removeWithin: async () => {
          throw new Error("lease already ended");
        },
      })).rejects.toThrow("lease already ended");
      expect((await store.probe()).poisoned).toBe(true);
      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("malformed marker fails closed while a distinct scope remains usable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-malformed-"));
    const stateDir = path.join(directory, "state");
    const poisoned = createLiveServerOperationPoisonStore({
      scope: `poison-malformed-${randomUUID()}`,
      stateDir,
    });
    const other = createLiveServerOperationPoisonStore({
      scope: `poison-other-${randomUUID()}`,
      stateDir,
    });
    try {
      await poisoned.run("http-export", async () => {});
      await writeFile(poisoned.pathForToken("a".repeat(32)), "{", { mode: 0o600 });
      await expect(poisoned.probe()).rejects.toThrow("marker is malformed");
      await expect(poisoned.run("http-import", async () => {})).rejects.toThrow(
        "marker is malformed",
      );
      await expect(other.run("http-export", async () => "other")).resolves.toBe("other");
      expect(await other.probe()).toEqual({ poisoned: false, scopeSha256: other.scopeSha256 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a symlink marker fails closed and is never followed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-symlink-"));
    const stateDir = path.join(directory, "state");
    const store = createLiveServerOperationPoisonStore({
      scope: `poison-symlink-${randomUUID()}`,
      stateDir,
    });
    const target = path.join(directory, "target");
    try {
      await store.run("http-export", async () => {});
      await writeFile(target, "private-target", { mode: 0o600 });
      await symlink(target, store.pathForToken("b".repeat(32)));
      await expect(store.probe()).rejects.toThrow("not a safe regular file");
      await expect(store.run("http-import", async () => {})).rejects.toThrow(
        "not a safe regular file",
      );
      expect(await readFile(target, "utf8")).toBe("private-target");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("marker permissions must be exactly 0600 and reads are size-bounded", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-bounds-"));
    const store = createLiveServerOperationPoisonStore({
      scope: `poison-bounds-${randomUUID()}`,
      stateDir: path.join(directory, "state"),
    });
    try {
      await expect(store.run("http-export", async () => {
        throw new Error("leave bounded marker");
      })).rejects.toThrow("leave bounded marker");
      const poison = await store.probe();
      if (!poison.token) throw new Error("poison token missing");
      const poisonPath = store.pathForToken(poison.token);
      await chmod(poisonPath, 0o640);
      await expect(store.probe()).rejects.toThrow("mode must be exactly 0600");
      await chmod(poisonPath, 0o600);
      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });

      const oversizedPath = store.pathForToken("c".repeat(32));
      await writeFile(oversizedPath, Buffer.alloc(4097, 0x7b), { mode: 0o600 });
      await expect(store.probe()).rejects.toThrow("invalid size");
      await expect(store.run("http-import", async () => {})).rejects.toThrow("invalid size");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the stable claim blocks a successor until marker-then-claim teardown completes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-replace-"));
    const store = createLiveServerOperationPoisonStore({
      scope: `poison-replace-${randomUUID()}`,
      stateDir: path.join(directory, "state"),
    });
    let firstStarted!: () => void;
    let finishFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { finishFirst = resolve; });
    try {
      const first = store.run("http-export", async () => {
        firstStarted();
        await firstRelease;
      });
      await firstReady;
      const original = await store.probe();
      if (!original.token) throw new Error("original poison token missing");
      await rm(store.pathForToken(original.token));
      let replacementCallbacks = 0;
      await expect(store.run("http-import", async () => {
        replacementCallbacks += 1;
      })).rejects.toThrow("scope is poisoned by an existing atomic claim");
      expect(replacementCallbacks).toBe(0);

      finishFirst();
      await expect(first).rejects.toThrow("refusing stale deletion");
      expect(await store.probe()).toMatchObject({
        poisoned: true,
        token: original.token,
        kind: "http-export",
      });
      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });
    } finally {
      finishFirst?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an atomic per-scope claim allows exactly one concurrent callback to enter", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-concurrent-"));
    const store = createLiveServerOperationPoisonStore({
      scope: `poison-concurrent-${randomUUID()}`,
      stateDir: path.join(directory, "state"),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let callbacksEntered = 0;
    const run = (kind: "http-export" | "http-import") => store.run(kind, async () => {
      callbacksEntered += 1;
      await gate;
      return kind;
    });
    try {
      const operations = [run("http-export"), run("http-import")];
      const settled = Promise.allSettled(operations);
      await waitFor(() => callbacksEntered === 1, "one guarded callback");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(callbacksEntered).toBe(1);
      release();
      const results = await settled;
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" ? String(rejected.reason) : "").toContain(
        "scope is poisoned by an existing atomic claim",
      );
      expect(callbacksEntered).toBe(1);
      expect((await store.probe()).poisoned).toBe(false);
    } finally {
      release?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("exact claim-only and marker-only partial states require proof before clear", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-partial-"));
    const store = createLiveServerOperationPoisonStore({
      scope: `poison-partial-${randomUUID()}`,
      stateDir: path.join(directory, "state"),
    });
    try {
      await expect(store.run("http-export", async () => {
        const poison = await store.probe();
        if (!poison.token) throw new Error("claim-only fixture token missing");
        await rm(store.pathForToken(poison.token));
        throw new Error("leave exact claim only");
      })).rejects.toThrow("leave exact claim only");
      expect(await store.probe()).toMatchObject({ poisoned: true, kind: "http-export" });
      await expect(store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => { throw new Error("health proof failed"); },
      })).rejects.toThrow("health proof failed");
      expect((await store.probe()).poisoned).toBe(true);
      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });

      await expect(store.run("http-import", async () => {
        await rm(`${store.poisonPathPrefix}.claim`);
        throw new Error("leave exact marker only");
      })).rejects.toThrow("leave exact marker only");
      expect(await store.probe()).toMatchObject({ poisoned: true, kind: "http-import" });
      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });
      expect((await store.probe()).poisoned).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("SIGKILL leaves poison and a successor is blocked until validated clear", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-kill-"));
    const stateDir = path.join(directory, "state");
    const scope = `poison-kill-${randomUUID()}`;
    const readyPath = path.join(directory, "ready");
    const fixture = await writePoisonFixture(directory);
    const store = createLiveServerOperationPoisonStore({ scope, stateDir });
    const child = spawn(process.execPath, [fixture], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        BAKA_TEST_STATE_DIR: stateDir,
        POISON_SCOPE: scope,
        POISON_READY: readyPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      await waitFor(() => exists(readyPath), "poison child ready");
      expect((await store.probe()).poisoned).toBe(true);
      expect(child.kill("SIGKILL")).toBe(true);
      expect(await result).toEqual({ code: null, signal: "SIGKILL" });
      await expect(store.run("http-export", async () => {})).rejects.toThrow(
        "live test HTTP operation scope is poisoned",
      );

      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });
      await expect(store.run("http-export", async () => "successor")).resolves.toBe("successor");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await result;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("file acquire rejects poison before the first Surreal availability probe", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-acquire-"));
    const stateDir = path.join(directory, "state");
    const fixture = await writePoisonAcquireFixture(directory);
    let connections = 0;
    const fakeSurreal = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      fakeSurreal.once("error", reject);
      fakeSurreal.listen({ host: "127.0.0.1", port: 0 }, () => {
        fakeSurreal.off("error", reject);
        resolve();
      });
    });
    const address = fakeSurreal.address();
    if (!address || typeof address === "string") throw new Error("fake Surreal address unavailable");
    const scope = `ws://127.0.0.1:${address.port}/rpc`;
    const store = createLiveServerOperationPoisonStore({ scope, stateDir });
    try {
      await expect(store.run("http-export", async () => {
        throw new Error("leave poison");
      })).rejects.toThrow("leave poison");
      const child = spawn(
        process.execPath,
        ["test", "--pass-with-no-tests", fixture],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH ?? "",
            SURREAL_URL: scope,
            BAKA_TEST_LIVE_LEASE_SCOPE: scope,
            BAKA_TEST_STATE_DIR: stateDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => { output += String(chunk); });
      child.stderr?.on("data", (chunk) => { output += String(chunk); });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(output).toContain("is poisoned by http-export");
      expect(connections).toBe(0);

      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });
    } finally {
      await close(fakeSurreal);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("operator clear refuses an occupied scope lease and preserves poison", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-clear-"));
    const stateDir = path.join(directory, "state");
    const scope = "ws://127.0.0.1:1/rpc";
    const store = createLiveServerOperationPoisonStore({ scope, stateDir });
    const port = liveTestLeasePortForScope(scope);
    const unrelated = createServer((socket) => socket.end("not-ai-baka\n"));
    try {
      await expect(store.run("http-import", async () => {
        throw new Error("leave poison for clear");
      })).rejects.toThrow("leave poison for clear");
      await listen(unrelated, port);
      const child = spawn(
        process.execPath,
        [
          "run",
          HELPER_PATH,
          "poison:clear",
          "--scope-sha256",
          store.scopeSha256,
          "--surreal-url",
          scope,
          "--confirm",
          liveServerOperationClearConfirmation(store.scopeSha256),
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH ?? "",
            SURREAL_URL: scope,
            BAKA_TEST_LIVE_LEASE_SCOPE: scope,
            BAKA_TEST_STATE_DIR: stateDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => { output += String(chunk); });
      child.stderr?.on("data", (chunk) => { output += String(chunk); });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(output).toContain(`lease port ${port} is occupied; poison clear never waits`);
      expect((await store.probe()).poisoned).toBe(true);

      await close(unrelated);
      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });
    } finally {
      await close(unrelated);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("operator clear rejects production and URL-to-scope mismatch before network", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-clear-url-"));
    const runClear = async (environmentUrl: string, argumentUrl: string): Promise<string> => {
      const store = createLiveServerOperationPoisonStore({
        scope: environmentUrl,
        stateDir: directory,
      });
      const child = spawn(
        process.execPath,
        [
          "run",
          HELPER_PATH,
          "poison:clear",
          "--scope-sha256",
          store.scopeSha256,
          "--surreal-url",
          argumentUrl,
          "--confirm",
          liveServerOperationClearConfirmation(store.scopeSha256),
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH ?? "",
            SURREAL_URL: environmentUrl,
            BAKA_TEST_LIVE_LEASE_SCOPE: environmentUrl,
            BAKA_TEST_STATE_DIR: directory,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => { output += String(chunk); });
      child.stderr?.on("data", (chunk) => { output += String(chunk); });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      return output;
    };
    try {
      const production = "ws://127.0.0.1:8901/rpc";
      expect(await runClear(production, production)).toContain(
        "refuses the shared/production SurrealDB port",
      );
      expect(await runClear("ws://127.0.0.1:19002/rpc", "ws://127.0.0.1:19003/rpc"))
        .toContain("must exactly equal SURREAL_URL and the lease scope");
      for (const nonLiteral of [
        "wss://127.0.0.1:19002/rpc",
        "ws://localhost:19002/rpc",
        "ws://[::1]:19002/rpc",
      ]) {
        expect(await runClear(nonLiteral, nonLiteral)).toContain(
          "requires literal canonical ws://127.0.0.1:<port>/rpc",
        );
      }
      expect(await runClear("ws://127.0.0.1:80/rpc", "ws://127.0.0.1:80/rpc"))
        .toContain("refuses noncanonical URL serialization");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("operator clear rejects a server exposing a shared namespace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-shared-"));
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        status: "OK",
        result: { namespaces: { baka: {} } },
      }]));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server address unavailable");
    if (address.port === 8901) throw new Error("unexpected production port allocation");
    const serverUrl = `ws://127.0.0.1:${address.port}/rpc`;
    const stateDir = path.join(directory, "state");
    const store = createLiveServerOperationPoisonStore({ scope: serverUrl, stateDir });
    try {
      await expect(store.run("http-export", async () => {
        throw new Error("leave poison for shared probe");
      })).rejects.toThrow("leave poison for shared probe");
      const child = spawn(
        process.execPath,
        [
          "run",
          HELPER_PATH,
          "poison:clear",
          "--scope-sha256",
          store.scopeSha256,
          "--surreal-url",
          serverUrl,
          "--confirm",
          liveServerOperationClearConfirmation(store.scopeSha256),
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH ?? "",
            SURREAL_URL: serverUrl,
            SURREAL_USER: "test",
            SURREAL_PASS: "test",
            BAKA_TEST_LIVE_LEASE_SCOPE: serverUrl,
            BAKA_TEST_STATE_DIR: stateDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => { output += String(chunk); });
      child.stderr?.on("data", (chunk) => { output += String(chunk); });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(output).toContain("refuses a shared/production SurrealDB namespace set");
      expect((await store.probe()).poisoned).toBe(true);
      await store.clear({
        scopeSha256: store.scopeSha256,
        confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
        healthProbe: async () => {},
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("operator clear rejects custom default-main definitions and non-empty main data", async () => {
    const emptyDatabaseInfo = () => Object.fromEntries([
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
    ].map((key) => [key, {}]));
    const scenarios = [
      {
        label: "custom-main",
        namespaceDefinition: "DEFINE NAMESPACE main COMMENT 'operator-owned namespace'",
        databaseInfo: emptyDatabaseInfo(),
        expected: "refuses a shared/production SurrealDB namespace set",
      },
      {
        label: "nonempty-main",
        namespaceDefinition:
          "DEFINE NAMESPACE main COMMENT 'Default namespace generated by SurrealDB'",
        databaseInfo: { ...emptyDatabaseInfo(), tables: { private_data: "DEFINE TABLE private_data" } },
        expected: "refuses a non-empty or non-default main database",
      },
    ] as const;

    for (const scenario of scenarios) {
      const directory = await mkdtemp(path.join(tmpdir(), `baka-http-poison-${scenario.label}-`));
      const server = createHttpServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const namespace = request.headers["surreal-ns"] as string | undefined;
        const database = request.headers["surreal-db"] as string | undefined;
        let result: Record<string, unknown>;
        if (body === "INFO FOR ROOT;" && !namespace && !database) {
          result = { namespaces: { main: scenario.namespaceDefinition } };
        } else if (body === "INFO FOR NS;" && namespace === "main" && !database) {
          result = {
            databases: {
              main: "DEFINE DATABASE main COMMENT 'Default database generated by SurrealDB'",
            },
          };
        } else if (body === "INFO FOR DB;" && namespace === "main" && database === "main") {
          result = scenario.databaseInfo;
        } else {
          response.writeHead(400, { "content-type": "application/json" });
          response.end("[]");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ status: "OK", result }]));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP server address unavailable");
      }
      if (address.port === 8901) throw new Error("unexpected production port allocation");
      const serverUrl = `ws://127.0.0.1:${address.port}/rpc`;
      const stateDir = path.join(directory, "state");
      const store = createLiveServerOperationPoisonStore({ scope: serverUrl, stateDir });
      try {
        await expect(store.run("http-import", async () => {
          throw new Error(`leave poison for ${scenario.label}`);
        })).rejects.toThrow(`leave poison for ${scenario.label}`);
        const child = spawn(
          process.execPath,
          [
            "run",
            HELPER_PATH,
            "poison:clear",
            "--scope-sha256",
            store.scopeSha256,
            "--surreal-url",
            serverUrl,
            "--confirm",
            liveServerOperationClearConfirmation(store.scopeSha256),
          ],
          {
            cwd: path.resolve(import.meta.dir, ".."),
            env: {
              PATH: process.env.PATH ?? "",
              SURREAL_URL: serverUrl,
              SURREAL_USER: "test",
              SURREAL_PASS: "test",
              BAKA_TEST_LIVE_LEASE_SCOPE: serverUrl,
              BAKA_TEST_STATE_DIR: stateDir,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout?.on("data", (chunk) => { output += String(chunk); });
        child.stderr?.on("data", (chunk) => { output += String(chunk); });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        expect(result.code).not.toBe(0);
        expect(result.signal).toBeNull();
        expect(output).toContain(scenario.expected);
        expect((await store.probe()).poisoned).toBe(true);
        await store.clear({
          scopeSha256: store.scopeSha256,
          confirmation: liveServerOperationClearConfirmation(store.scopeSha256),
          healthProbe: async () => {},
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test("operator clear succeeds only for the exact reset disposable scope", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-http-poison-clear-ok-"));
    const requests: Array<{ body: string; namespace?: string; database?: string }> = [];
    const emptyDatabaseInfo = Object.fromEntries([
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
    ].map((key) => [key, {}]));
    const server = createHttpServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const namespace = request.headers["surreal-ns"] as string | undefined;
      const database = request.headers["surreal-db"] as string | undefined;
      requests.push({ body, namespace, database });
      let result: Record<string, unknown>;
      if (body === "INFO FOR ROOT;" && !namespace && !database) {
        result = {
          namespaces: {
            main: "DEFINE NAMESPACE main COMMENT 'Default namespace generated by SurrealDB'",
          },
        };
      } else if (body === "INFO FOR NS;" && namespace === "main" && !database) {
        result = {
          databases: {
            main: "DEFINE DATABASE main COMMENT 'Default database generated by SurrealDB'",
          },
        };
      } else if (body === "INFO FOR DB;" && namespace === "main" && database === "main") {
        result = emptyDatabaseInfo;
      } else {
        response.writeHead(400, { "content-type": "application/json" });
        response.end("[]");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ status: "OK", result }]));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server address unavailable");
    if (address.port === 8901) throw new Error("unexpected production port allocation");
    const serverUrl = `ws://127.0.0.1:${address.port}/rpc`;
    const stateDir = path.join(directory, "state");
    const store = createLiveServerOperationPoisonStore({ scope: serverUrl, stateDir });
    try {
      await expect(store.run("http-import", async () => {
        throw new Error("leave poison for exact clear");
      })).rejects.toThrow("leave poison for exact clear");
      const child = spawn(
        process.execPath,
        [
          "run",
          HELPER_PATH,
          "poison:clear",
          "--scope-sha256",
          store.scopeSha256,
          "--surreal-url",
          serverUrl,
          "--confirm",
          liveServerOperationClearConfirmation(store.scopeSha256),
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            PATH: process.env.PATH ?? "",
            SURREAL_URL: serverUrl,
            SURREAL_USER: "test",
            SURREAL_PASS: "test",
            BAKA_TEST_LIVE_LEASE_SCOPE: serverUrl,
            BAKA_TEST_STATE_DIR: stateDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => { output += String(chunk); });
      child.stderr?.on("data", (chunk) => { output += String(chunk); });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(result).toEqual({ code: 0, signal: null });
      expect(output).toContain('"poisoned": false');
      expect((await store.probe()).poisoned).toBe(false);
      expect(requests).toEqual([
        { body: "INFO FOR ROOT;", namespace: undefined, database: undefined },
        { body: "INFO FOR NS;", namespace: "main", database: undefined },
        { body: "INFO FOR DB;", namespace: "main", database: "main" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("live DB test lease lifecycle", () => {
  liveTest("selected, no-match and setup-failure subprocesses release the OS lease", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-db-helper-test-"));
    const fixture = await writeFixture(directory);
    const excludedPorts = new Set([LIVE_TEST_LEASE_PORT]);
    const markerPaths: string[] = [];
    try {
      for (const scenario of ["selected", "no-match", "setup-fail"] as const) {
        const scope = distinctScope(`db-helper-${scenario}`, excludedPorts);
        const leasePort = liveTestLeasePortForScope(scope);
        const markerPath = path.join(directory, `${scenario}.marker`);
        const releasePath = path.join(directory, `${scenario}.release`);
        markerPaths.push(markerPath);
        expect(await portIsAvailable(leasePort)).toBe(true);
        const run = startFixture(fixture, {
          scope,
          markerPath,
          releasePath,
          pattern: scenario === "no-match" ? "definitely-does-not-match" : "selected live lease",
          setupFail: scenario === "setup-fail",
        });
        const result = await run.result;
        expect(result.code, result.output).toBe(scenario === "setup-fail" ? 1 : 0);
        expect(result.signal).toBeNull();
        if (await exists(markerPath)) {
          const state = await marker(markerPath);
          expect(state.leasePort).toBe(leasePort);
          expect(await namespaceExists(state.namespace)).toBe(false);
        }
        await waitFor(() => portIsAvailable(leasePort), `${scenario} port re-bind`, 2_000);
      }
    } finally {
      await cleanupMarkedNamespaces(markerPaths);
      await rm(directory, { recursive: true, force: true });
    }
  });

  liveTest("an unrelated listener fails clearly instead of blocking the test run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-db-helper-unrelated-"));
    const fixture = await writeFixture(directory);
    const scope = distinctScope("db-helper-unrelated", new Set([LIVE_TEST_LEASE_PORT]));
    const leasePort = liveTestLeasePortForScope(scope);
    const markerPath = path.join(directory, "unrelated.marker");
    const releasePath = path.join(directory, "unrelated.release");
    const unrelated = createServer((socket) => socket.end("unrelated-service\n"));
    let run: ChildRun | undefined;
    try {
      await listen(unrelated, leasePort);
      unrelated.unref();
      run = startFixture(fixture, {
        scope,
        markerPath,
        releasePath,
        pattern: "selected live lease",
      });
      const result = await run.result;
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.output).toContain(
        `live test lease port ${leasePort} is occupied by an unrelated listener`,
      );
      expect(await exists(markerPath)).toBe(false);
      expect(await portIsAvailable(leasePort)).toBe(false);
      await close(unrelated);
      await waitFor(() => portIsAvailable(leasePort), "unrelated listener port re-bind", 2_000);
    } finally {
      if (run) await stop(run);
      await close(unrelated);
      await cleanupMarkedNamespaces([markerPath]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  liveTest("test database handles keep an immutable generated cleanup identifier", async () => {
    const t = await createTestDb(false);
    const generatedName = t.name;
    try {
      expect(Object.isFrozen(t)).toBe(true);
      expect(Reflect.set(t, "name", "baka")).toBe(false);
      expect(t.name).toBe(generatedName);
      expect(generatedName).toMatch(/^test_[0-9a-f]{32}$/u);
    } finally {
      await dropTestDb(t);
    }
  });

  liveTest("two contenders serialize and an active DB keeps the lease port occupied", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-db-helper-race-"));
    const fixture = await writeFixture(directory);
    const scope = distinctScope("db-helper-race", new Set([LIVE_TEST_LEASE_PORT]));
    const leasePort = liveTestLeasePortForScope(scope);
    const markers = [path.join(directory, "one.marker"), path.join(directory, "two.marker")];
    const releases = [path.join(directory, "one.release"), path.join(directory, "two.release")];
    const runs = [0, 1].map((index) => startFixture(fixture, {
      scope,
      markerPath: markers[index]!,
      releasePath: releases[index]!,
      pattern: "selected live lease",
      hold: true,
    }));
    try {
      await waitFor(async () => (await exists(markers[0]!)) || (await exists(markers[1]!)), "first lease owner");
      const firstIndex = await exists(markers[0]!) ? 0 : 1;
      const secondIndex = firstIndex === 0 ? 1 : 0;
      const first = await marker(markers[firstIndex]!);
      expect(first.leasePort).toBe(leasePort);
      expect(await portIsAvailable(leasePort)).toBe(false);
      expect(await namespaceDatabases(first.namespace)).toContain(first.database);

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await exists(markers[secondIndex]!)).toBe(false);
      expect(await portIsAvailable(leasePort)).toBe(false);

      await writeFile(releases[firstIndex]!, "release");
      const firstResult = await runs[firstIndex]!.result;
      expect(firstResult.code, firstResult.output).toBe(0);
      await waitFor(() => exists(markers[secondIndex]!), "second lease owner");
      const second = await marker(markers[secondIndex]!);
      expect(second.leasePort).toBe(leasePort);
      expect(await namespaceExists(first.namespace)).toBe(false);
      expect(await namespaceDatabases(second.namespace)).toContain(second.database);
      expect(await portIsAvailable(leasePort)).toBe(false);

      await writeFile(releases[secondIndex]!, "release");
      const secondResult = await runs[secondIndex]!.result;
      expect(secondResult.code, secondResult.output).toBe(0);
      await waitFor(() => portIsAvailable(leasePort), "serialized port re-bind", 2_000);
      expect(await namespaceExists(second.namespace)).toBe(false);
    } finally {
      await Promise.all(runs.map(stop));
      await cleanupMarkedNamespaces(markers);
      await rm(directory, { recursive: true, force: true });
    }
  });

  liveTest("SIGKILL releases the OS lease and a waiting successor acquires it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "baka-db-helper-kill-"));
    const fixture = await writeFixture(directory);
    const scope = distinctScope("db-helper-kill", new Set([LIVE_TEST_LEASE_PORT]));
    const leasePort = liveTestLeasePortForScope(scope);
    const markers = [path.join(directory, "killed.marker"), path.join(directory, "successor.marker")];
    const releases = [path.join(directory, "killed.release"), path.join(directory, "successor.release")];
    const first = startFixture(fixture, {
      scope,
      markerPath: markers[0]!,
      releasePath: releases[0]!,
      pattern: "selected live lease",
      hold: true,
    });
    let successor: ChildRun | undefined;
    try {
      await waitFor(() => exists(markers[0]!), "SIGKILL owner");
      const killedState = await marker(markers[0]!);
      expect(killedState.leasePort).toBe(leasePort);
      expect(await namespaceDatabases(killedState.namespace)).toContain(killedState.database);
      expect(await portIsAvailable(leasePort)).toBe(false);

      successor = startFixture(fixture, {
        scope,
        markerPath: markers[1]!,
        releasePath: releases[1]!,
        pattern: "selected live lease",
        hold: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await exists(markers[1]!)).toBe(false);

      expect(first.child.kill("SIGKILL")).toBe(true);
      const killedResult = await first.result;
      expect(killedResult.code).toBeNull();
      expect(killedResult.signal).toBe("SIGKILL");
      await waitFor(() => exists(markers[1]!), "successor after SIGKILL");
      const successorState = await marker(markers[1]!);
      expect(successorState.leasePort).toBe(leasePort);
      expect(await namespaceDatabases(successorState.namespace)).toContain(successorState.database);
      expect(await portIsAvailable(leasePort)).toBe(false);

      // SIGKILL intentionally bypasses DB teardown. Clean only the exact,
      // validated namespace emitted by that dead fixture.
      expect(await namespaceExists(killedState.namespace)).toBe(true);
      await removeOwnedNamespace(killedState.namespace);
      expect(await namespaceExists(killedState.namespace)).toBe(false);

      await writeFile(releases[1]!, "release");
      const successorResult = await successor.result;
      expect(successorResult.code, successorResult.output).toBe(0);
      expect(await namespaceExists(successorState.namespace)).toBe(false);
      await waitFor(() => portIsAvailable(leasePort), "post-SIGKILL port re-bind", 2_000);
    } finally {
      await stop(first);
      if (successor) await stop(successor);
      await cleanupMarkedNamespaces(markers);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
