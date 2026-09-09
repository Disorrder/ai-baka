import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { ensureSyncDatabase } from "../src/infra/sync-database.ts";

const cfg = loadConfig({
  HOME: "/tmp",
  BAKA_ARCHIVE_ROOT: "/tmp/baka-startup-archive",
  BAKA_DB_ROOT: "/tmp/baka-startup-db",
});

test("ready database is not started or subjected to storage mutation checks", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null) });
  try {
    await ensureSyncDatabase(cfg, () => {}, {
      fetch: ((_, init) => fetch(`${server.url}health`, init)) as typeof fetch,
      assertStorage: async () => { throw new Error("unexpected storage check"); },
      start: async () => { throw new Error("unexpected startup"); },
    });
  } finally {
    await server.stop(true);
  }
});

test("unavailable local database becomes ready after one safe startup", async () => {
  let healthy = false;
  let checked = false;
  let starts = 0;
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: healthy ? 200 : 503 }) });
  try {
    await ensureSyncDatabase(cfg, () => {}, {
      fetch: ((_, init) => fetch(`${server.url}health`, init)) as typeof fetch,
      assertStorage: async () => {
        checked = true;
        return { dbRoot: cfg.dbRoot, archiveDbRoot: `${cfg.archiveRoot}/db`, checkedPath: "/tmp", platform: "darwin", filesystem: "apfs" };
      },
      start: async () => {
        expect(checked).toBe(true);
        starts++;
        healthy = true;
      },
    });
    expect(starts).toBe(1);
    expect((await fetch(`${server.url}health`)).ok).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("failed readiness after startup is terminal, not a restart loop", async () => {
  let starts = 0;
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
  try {
    await expect(ensureSyncDatabase(cfg, () => {}, {
      fetch: ((_, init) => fetch(`${server.url}health`, init)) as typeof fetch,
      assertStorage: async () => ({ dbRoot: cfg.dbRoot, archiveDbRoot: `${cfg.archiveRoot}/db`, checkedPath: "/tmp", platform: "darwin", filesystem: "apfs" }),
      start: async () => { starts++; },
    })).rejects.toThrow("недоступна после запуска");
    expect(starts).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("unavailable custom endpoint never starts the production container", async () => {
  await expect(ensureSyncDatabase({ ...cfg, surrealUrl: "ws://127.0.0.1:1/rpc" }, () => {}, {
    start: async () => { throw new Error("unexpected startup"); },
  })).rejects.toThrow("автозапуск разрешён только");
});

test("unsafe storage prevents startup", async () => {
  await expect(ensureSyncDatabase(cfg, () => {}, {
    fetch: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
    assertStorage: async () => { throw new Error("unsafe storage"); },
    start: async () => { throw new Error("unexpected startup"); },
  })).rejects.toThrow("unsafe storage");
});

test("sync SDK connection to a dead endpoint has a finite deadline", async () => {
  const start = performance.now();
  await expect(connectDb({ ...cfg, surrealUrl: "ws://127.0.0.1:1/rpc" }, { failFast: true })).rejects.toThrow();
  expect(performance.now() - start).toBeLessThan(12_000);
}, 15_000);

test("unresponsive SDK handshake has a finite deadline", async () => {
  // Real sockets exercise SDK cancellation, which fake timers cannot drive.
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "cbor" } })) return;
      return new Response(null, { status: 500 });
    },
    websocket: { message() {} },
  });
  try {
    await expect(connectDb({ ...cfg, surrealUrl: `ws://127.0.0.1:${server.port}/rpc` }, { failFast: true })).rejects.toThrow("10 секунд");
  } finally {
    await server.stop(true);
  }
}, 15_000);
