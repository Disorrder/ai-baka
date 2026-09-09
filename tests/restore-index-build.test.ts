import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildDeferredFulltextIndexes,
  removeStartedFulltextIndexes,
  RESTORE_FULLTEXT_INDEX_DEFINITIONS,
  RestoreIndexBuildError,
  type RestoreFulltextIndexDefinition,
  type RestoreIndexBuildDiagnostic,
  type RestoreIndexBuildOptions,
  type RestoreIndexCommand,
  type RestoreIndexCommandResult,
  validateDeferredFulltextIndexes,
} from "../src/backup/restore-indexes.ts";
import type { AppConfig } from "../src/config.ts";

const SEARCH_INDEX = `DEFINE INDEX IF NOT EXISTS search_document_content
ON TABLE search_document
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25 HIGHLIGHTS;`;

const CHUNK_INDEX = `DEFINE INDEX IF NOT EXISTS chunk_content
ON TABLE chunk
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25 HIGHLIGHTS;`;

const DEFERRED_INDEXES = [SEARCH_INDEX] as const;
const MAX_INDEX_SQL_RESPONSE_BYTES = 1024 * 1024;
const MEMORY_THRESHOLD_ERROR_RESULT =
  "The query was not executed due to the memory threshold being reached";

const cfg = {
  surrealUrl: "ws://127.0.0.1:1/rpc",
  surrealUser: "root",
  surrealPass: "private-password",
} as AppConfig;

function definitionFor(command: RestoreIndexCommand): RestoreFulltextIndexDefinition {
  const definition = RESTORE_FULLTEXT_INDEX_DEFINITIONS[command.ordinal - 1];
  if (!definition || definition.name !== command.name || definition.table !== command.table) {
    throw new Error("test received an unexpected command identity");
  }
  return definition;
}

function storedDefinition(index: RestoreFulltextIndexDefinition): string {
  return `DEFINE INDEX ${index.name} ON ${index.table} FIELDS ${index.field} ` +
    `FULLTEXT ANALYZER ${index.analyzer} BM25(1.2,0.75) HIGHLIGHTS CONCURRENTLY`;
}

function accepted(): RestoreIndexCommandResult {
  return { body: [{ status: "OK", result: null }] };
}

function inspected(
  command: RestoreIndexCommand,
  status: string,
  counts: Record<string, unknown> = {},
  identityOverride?: string | null,
): RestoreIndexCommandResult {
  const index = definitionFor(command);
  const indexes = identityOverride === null
    ? {}
    : {
      [index.name]: {
        sql: identityOverride ?? storedDefinition(index),
      },
    };
  return {
    body: [
      { status: "OK", result: { indexes } },
      { status: "OK", result: { building: { status, ...counts } } },
    ],
  };
}

function absenceInspected(
  command: RestoreIndexCommand,
  present: boolean,
  entryOverride?: unknown,
): RestoreIndexCommandResult {
  const index = definitionFor(command);
  return {
    body: [{
      status: "OK",
      result: {
        indexes: present
          ? { [index.name]: entryOverride ?? { sql: storedDefinition(index) } }
          : {},
      },
    }],
  };
}

function fakeClock() {
  let milliseconds = 0;
  const sleeps: number[] = [];
  return {
    now: () => milliseconds,
    sleep: async (duration: number) => {
      sleeps.push(duration);
      milliseconds += duration;
    },
    sleeps,
  };
}

type IndexFetch = NonNullable<RestoreIndexBuildOptions["fetchImpl"]>;

function streamedResponse(
  chunks: readonly Uint8Array[],
  options: {
    contentLength?: number;
    onCancel?: () => void;
    onReaderCancel?: () => void;
  } = {},
): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[offset++];
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel() {
      options.onCancel?.();
    },
  });
  if (options.onReaderCancel) {
    const originalGetReader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      value: () => {
        const reader = originalGetReader();
        const originalCancel = reader.cancel.bind(reader);
        Object.defineProperty(reader, "cancel", {
          value: (reason?: unknown) => {
            options.onReaderCancel?.();
            return originalCancel(reason);
          },
        });
        return reader;
      },
    });
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (options.contentLength !== undefined) {
    headers.set("content-length", String(options.contentLength));
  }
  return new Response(body, { status: 200, headers });
}

async function httpBuildFailure(
  fetchImpl: IndexFetch,
  overrides: Pick<RestoreIndexBuildOptions, "requestTimeoutMs" | "signal"> = {},
): Promise<RestoreIndexBuildError> {
  try {
    await buildDeferredFulltextIndexes(
      cfg,
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "archive",
      DEFERRED_INDEXES,
      { fetchImpl, ...overrides },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreIndexBuildError);
    return error as RestoreIndexBuildError;
  }
  throw new Error("expected HTTP deferred index build to fail");
}

function errorChainMessages(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function buildFailure(
  executeCommand: (command: RestoreIndexCommand) => Promise<RestoreIndexCommandResult>,
  overrides: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<RestoreIndexBuildError> {
  try {
    await buildDeferredFulltextIndexes(
      cfg,
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "archive",
      DEFERRED_INDEXES,
      { executeCommand, ...overrides },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreIndexBuildError);
    return error as RestoreIndexBuildError;
  }
  throw new Error("expected deferred index build to fail");
}

describe("deferred restore FULLTEXT index validation", () => {
  test("accepts the curated search index and rejects the forensic chunk index", () => {
    expect(validateDeferredFulltextIndexes([SEARCH_INDEX])).toEqual(
      RESTORE_FULLTEXT_INDEX_DEFINITIONS,
    );
    expect(() => validateDeferredFulltextIndexes([CHUNK_INDEX, SEARCH_INDEX]))
      .toThrow(RestoreIndexBuildError);
  });

  test("never accepts extra or arbitrary SQL even with an expected identity", () => {
    try {
      validateDeferredFulltextIndexes([
        `${SEARCH_INDEX}\nREMOVE NAMESPACE private_namespace;`,
      ]);
      throw new Error("arbitrary SQL was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(RestoreIndexBuildError);
      const diagnostics = (error as RestoreIndexBuildError).diagnostics;
      expect(diagnostics.at(-1)?.category).toBe("ddl_validation");
      expect(JSON.stringify(diagnostics)).not.toContain("private_namespace");
    }
  });
});

describe("restore index namespace safety", () => {
  test("rejects production and malformed temporary namespaces before any command", async () => {
    const invalidNamespaces = [
      "baka",
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "baka_restore_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "baka_restore_test_temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "temp_baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_tmp",
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    ];

    for (const namespace of invalidNamespaces) {
      let buildCalls = 0;
      await expect(buildDeferredFulltextIndexes(
        cfg,
        namespace,
        "archive",
        DEFERRED_INDEXES,
        {
          executeCommand: async () => {
            buildCalls += 1;
            return accepted();
          },
        },
      )).rejects.toThrow(/exact generated restore namespace/);
      expect(buildCalls).toBe(0);

      let removeCalls = 0;
      await expect(removeStartedFulltextIndexes(
        cfg,
        namespace,
        "archive",
        RESTORE_FULLTEXT_INDEX_DEFINITIONS,
        {
          executeCommand: async () => {
            removeCalls += 1;
            return accepted();
          },
        },
      )).rejects.toThrow(/exact generated restore namespace/);
      expect(removeCalls).toBe(0);
    }
  });

  test("accepts an exact generated namespace for build and removal", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const namespace = "baka_restore_test_0123456789abcdef0123456789abcdef";
    await buildDeferredFulltextIndexes(cfg, namespace, "archive", DEFERRED_INDEXES, {
      executeCommand: async (command) => {
        calls.push(`${command.kind}:${command.ordinal}`);
        return command.kind === "inspect" ? inspected(command, "ready") : accepted();
      },
    });
    await removeStartedFulltextIndexes(
      cfg,
      namespace,
      "archive",
      RESTORE_FULLTEXT_INDEX_DEFINITIONS,
      {
        timeoutMs: 100,
        stabilizationMs: 10,
        pollIntervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
        executeCommand: async (command) => {
          calls.push(`${command.kind}:${command.ordinal}`);
          return command.kind === "inspect_absence"
            ? absenceInspected(command, false)
            : accepted();
        },
      },
    );

    expect(calls).toEqual([
      "define:1",
      "inspect:1",
      "remove:1",
      "inspect_absence:1",
      "inspect_absence:1",
    ]);
  });
});

describe("bounded restore index HTTP responses", () => {
  test("cancels a chunked response without Content-Length at the one MiB bound", async () => {
    const retained = new Uint8Array(MAX_INDEX_SQL_RESPONSE_BYTES).fill(0x61);
    const secret = "SuperPrivateToken chunked dialogue response";
    const suffix = new TextEncoder().encode(secret);
    let readerCancelCalls = 0;
    const error = await httpBuildFailure(async () => streamedResponse([
      retained.subarray(0, 256 * 1024),
      retained.subarray(256 * 1024, 512 * 1024),
      retained.subarray(512 * 1024, 768 * 1024),
      retained.subarray(768 * 1024),
      suffix,
    ], { onReaderCancel: () => readerCancelCalls += 1 }));

    expect(readerCancelCalls).toBe(1);
    expect(error.diagnostics.at(-1)).toMatchObject({
      category: "malformed_response",
      responseBytes: MAX_INDEX_SQL_RESPONSE_BYTES,
      responseSha256: createHash("sha256").update(retained).digest("hex"),
      responseTruncated: true,
    });
    expect(errorChainMessages(error)).not.toContain(secret);
    expect(JSON.stringify(error.diagnostics)).not.toContain(secret);
  });

  test("does not trust a smaller lying Content-Length", async () => {
    const retained = new Uint8Array(MAX_INDEX_SQL_RESPONSE_BYTES).fill(0x62);
    let readerCancelCalls = 0;
    const error = await httpBuildFailure(async () => streamedResponse([
      retained,
      new Uint8Array([0x63]),
    ], {
      contentLength: 16,
      onReaderCancel: () => readerCancelCalls += 1,
    }));

    expect(readerCancelCalls).toBe(1);
    expect(error.diagnostics.at(-1)).toMatchObject({
      category: "malformed_response",
      responseBytes: MAX_INDEX_SQL_RESPONSE_BYTES,
      responseSha256: createHash("sha256").update(retained).digest("hex"),
      responseTruncated: true,
    });
  });

  test("caller cancellation remains active while the response stream is pending", async () => {
    const controller = new AbortController();
    let markReadPending!: () => void;
    const readPending = new Promise<void>((resolve) => {
      markReadPending = resolve;
    });
    let releasePull!: () => void;
    const pendingPull = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("["));
      },
      pull() {
        markReadPending();
        return pendingPull;
      },
      cancel() {
        cancelled = true;
      },
    });
    const operation = httpBuildFailure(
      async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      { signal: controller.signal },
    );
    await readPending;
    controller.abort(new Error("SuperPrivateToken operator cancellation reason"));
    releasePull();
    const error = await operation;
    await Promise.resolve();

    expect(cancelled).toBe(true);
    expect(error.diagnostics.at(-1)).toMatchObject({
      category: "cancelled",
    });
    expect(error.diagnostics.at(-1)?.responseTruncated).toBeUndefined();
    expect(errorChainMessages(error)).not.toContain("SuperPrivateToken");
    expect(JSON.stringify(error.diagnostics)).not.toContain("SuperPrivateToken");
  });

  test("per-request timeout remains active while the response stream is pending", async () => {
    const prefix = new TextEncoder().encode("[");
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(prefix);
      },
      pull() {
        return new Promise<void>(() => {});
      },
    });
    const error = await httpBuildFailure(
      async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      { requestTimeoutMs: 10 },
    );

    expect(error.diagnostics.at(-1)).toMatchObject({
      category: "define_request",
      responseBytes: prefix.byteLength,
      responseSha256: createHash("sha256").update(prefix).digest("hex"),
      responseTruncated: true,
    });
  });

  test("parses valid bounded JSON and records complete response evidence", async () => {
    const commands = [
      accepted().body,
      inspected({
        kind: "inspect",
        ordinal: 1,
        name: "search_document_content",
        table: "search_document",
        timeoutMs: 1,
      }, "ready").body,
    ];
    const events: RestoreIndexBuildDiagnostic[] = [];
    let calls = 0;
    const result = await buildDeferredFulltextIndexes(
      cfg,
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "archive",
      DEFERRED_INDEXES,
      {
        onProgress: (event) => events.push(event),
        fetchImpl: async (_input, init) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          const encoded = new TextEncoder().encode(JSON.stringify(commands[calls++]));
          const midpoint = Math.floor(encoded.byteLength / 2);
          return streamedResponse(
            [encoded.subarray(0, midpoint), encoded.subarray(midpoint)],
            { contentLength: encoded.byteLength },
          );
        },
      },
    );

    expect(calls).toBe(2);
    expect(result.map((diagnostic) => diagnostic.state)).toEqual(["ready"]);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.responseBytes).toBeGreaterThan(0);
      expect(event.responseSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(event.responseTruncated).toBe(false);
    }
  });

  test("malformed response errors redact body, query, credentials and abort reason", async () => {
    const secret = "SuperPrivateToken private dialogue content";
    const encoded = new TextEncoder().encode(`not-json ${secret}`);
    let requestSql = "";
    let authorization = "";
    const error = await httpBuildFailure(async (_input, init) => {
      requestSql = String(init?.body ?? "");
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return streamedResponse([encoded], { contentLength: encoded.byteLength });
    });
    const exposed = [
      error.message,
      errorChainMessages(error),
      JSON.stringify(error),
      JSON.stringify(error.diagnostics),
    ].join("\n");

    expect(error.diagnostics.at(-1)).toMatchObject({
      category: "malformed_response",
      responseBytes: encoded.byteLength,
      responseSha256: createHash("sha256").update(encoded).digest("hex"),
      responseTruncated: false,
    });
    expect(requestSql).toContain("DEFINE INDEX");
    expect(authorization).toStartWith("Basic ");
    expect(exposed).not.toContain(secret);
    expect(exposed).not.toContain(requestSql);
    expect(exposed).not.toContain(authorization);
    expect(exposed).not.toContain(cfg.surrealPass);
  });
});

describe("sequential concurrent index polling", () => {
  test("polls started through cleaning and indexing to ready with deterministic timing", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const events: RestoreIndexBuildDiagnostic[] = [];
    const firstStatuses = ["started", "cleaning", "indexing", "ready"] as const;
    let firstPoll = 0;
    const result = await buildDeferredFulltextIndexes(
      cfg,
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "archive",
      DEFERRED_INDEXES,
      {
        timeoutMs: 1_000,
        pollIntervalMs: 25,
        now: clock.now,
        sleep: clock.sleep,
        onProgress: (event) => events.push(event),
        executeCommand: async (command) => {
          calls.push(`${command.kind}:${command.ordinal}`);
          if (command.kind === "define") return accepted();
          if (command.ordinal === 1) {
            const status = firstStatuses[firstPoll++] ?? "ready";
            return inspected(
              command,
              status,
              status === "indexing" ? { initial: 120, pending: 7, updated: 3 } : {},
            );
          }
          return inspected(command, "ready");
        },
      },
    );

    expect(calls).toEqual([
      "define:1",
      "inspect:1",
      "inspect:1",
      "inspect:1",
      "inspect:1",
    ]);
    expect(clock.sleeps).toEqual([25, 25, 25]);
    expect(result.map((item) => [item.ordinal, item.state, item.status])).toEqual([
      [1, "ready", "ready"],
    ]);
    expect(events.find((event) => event.status === "indexing")).toMatchObject({
      ordinal: 1,
      state: "building",
      status: "indexing",
      initial: 120,
      pending: 7,
      updated: 3,
      polls: 3,
      elapsedMs: 50,
    });
    expect(events.find((event) => event.status === "cleaning")).toMatchObject({
      ordinal: 1,
      state: "building",
      category: "progress",
      status: "cleaning",
      polls: 2,
      elapsedMs: 25,
    });
  });

  test("cleanup proves stable absence for every identity in reverse order", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    await removeStartedFulltextIndexes(
      cfg,
      "baka_restore_test_cccccccccccccccccccccccccccccccc",
      "archive",
      RESTORE_FULLTEXT_INDEX_DEFINITIONS,
      {
        timeoutMs: 100,
        stabilizationMs: 10,
        pollIntervalMs: 10,
        now: clock.now,
        sleep: clock.sleep,
        executeCommand: async (command) => {
          calls.push(`${command.kind}:${command.ordinal}:${command.name}@${command.table}`);
          return command.kind === "inspect_absence"
            ? absenceInspected(command, false)
            : accepted();
        },
      },
    );
    expect(calls).toEqual([
      "remove:1:search_document_content@search_document",
      "inspect_absence:1:search_document_content@search_document",
      "inspect_absence:1:search_document_content@search_document",
    ]);
  });

  test("removes a delayed DEFINE appearance again before accepting stable absence", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    let present = true;
    let sleepCount = 0;
    await removeStartedFulltextIndexes(
      cfg,
      "baka_restore_test_dddddddddddddddddddddddddddddddd",
      "archive",
      [RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]],
      {
        timeoutMs: 100,
        stabilizationMs: 10,
        pollIntervalMs: 10,
        now: clock.now,
        sleep: async (duration) => {
          await clock.sleep(duration);
          if (sleepCount++ === 0) present = true;
        },
        executeCommand: async (command) => {
          calls.push(`${command.kind}:${command.ordinal}`);
          if (command.kind === "remove") {
            present = false;
            return accepted();
          }
          if (command.kind === "inspect_absence") {
            return absenceInspected(command, present);
          }
          throw new Error("unexpected cleanup command");
        },
      },
    );

    expect(calls).toEqual([
      "remove:1",
      "inspect_absence:1",
      "inspect_absence:1",
      "remove:1",
      "inspect_absence:1",
      "inspect_absence:1",
    ]);
    expect(present).toBe(false);
  });

  test("persistent delayed reappearance fails at the fake-clock deadline without private evidence", async () => {
    const clock = fakeClock();
    let present = true;
    let removeCalls = 0;
    let caught: unknown;
    try {
      await removeStartedFulltextIndexes(
        cfg,
        "baka_restore_test_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "archive",
        [RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]],
        {
          timeoutMs: 35,
          stabilizationMs: 20,
          pollIntervalMs: 5,
          now: clock.now,
          sleep: async (duration) => {
            await clock.sleep(duration);
            present = true;
          },
          executeCommand: async (command) => {
            if (command.kind === "remove") {
              removeCalls += 1;
              present = false;
              return accepted();
            }
            if (command.kind === "inspect_absence") {
              return absenceInspected(
                command,
                present,
                { sql: "SuperPrivateToken raw response detail" },
              );
            }
            throw new Error("SuperPrivateToken unexpected transport command");
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "restore index cleanup failed for 1 allowlisted index(es)",
    );
    expect(removeCalls).toBeGreaterThan(1);
    expect(clock.now()).toBe(35);
    expect(JSON.stringify(caught)).not.toContain("SuperPrivateToken");
    expect((caught as Error).message).not.toContain("SuperPrivateToken");
  });

  test("malformed absence INFO and transport errors fail without persistable private detail", async () => {
    const scenarios: Array<(
      command: RestoreIndexCommand,
    ) => Promise<RestoreIndexCommandResult>> = [
      async (command) => command.kind === "remove"
        ? accepted()
        : {
          body: [{
            status: "OK",
            result: { indexes: "SuperPrivateToken malformed response" },
          }],
        },
      async (command) => {
        if (command.kind === "remove") return accepted();
        throw new Error("SuperPrivateToken private SDK transport detail");
      },
    ];

    for (const executeCommand of scenarios) {
      let caught: unknown;
      try {
        await removeStartedFulltextIndexes(
          cfg,
          "baka_restore_test_ffffffffffffffffffffffffffffffff",
          "archive",
          [RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]],
          { timeoutMs: 100, stabilizationMs: 10, pollIntervalMs: 10, executeCommand },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(
        "restore index cleanup failed for 1 allowlisted index(es)",
      );
      expect(JSON.stringify(caught)).not.toContain("SuperPrivateToken");
      expect((caught as Error).message).not.toContain("SuperPrivateToken");
    }
  });

  test("schedules and accepts only the core search index", async () => {
    const calls: string[] = [];
    const result = await buildDeferredFulltextIndexes(
      cfg,
      "baka_restore_test_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "archive",
      DEFERRED_INDEXES,
      {
        executeCommand: async (command) => {
          calls.push(`${command.kind}:${command.ordinal}`);
          if (command.kind === "define") return accepted();
          return inspected(command, "ready");
        },
      },
    );
    expect(result.map((item) => item.ordinal)).toEqual([1]);
    expect(calls).toEqual(["define:1", "inspect:1"]);
  });
});

describe("deferred index terminal failures", () => {
  test("caller cancellation interrupts polling and retains safe cleanup ownership", async () => {
    const controller = new AbortController();
    let pollingSleepStarted!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      pollingSleepStarted = resolve;
    });
    const commands: string[] = [];
    const operation = buildDeferredFulltextIndexes(
      cfg,
      "baka_restore_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "archive",
      DEFERRED_INDEXES,
      {
        signal: controller.signal,
        executeCommand: async (command) => {
          commands.push(`${command.kind}:${command.ordinal}`);
          return command.kind === "define"
            ? accepted()
            : inspected(command, "indexing", { initial: 2, pending: 1, updated: 0 });
        },
        sleep: async () => {
          pollingSleepStarted();
          await new Promise<void>(() => {});
        },
      },
    );
    await sleeping;
    controller.abort(new Error("SuperPrivateToken operator cancellation reason"));

    let caught: unknown;
    try {
      await operation;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RestoreIndexBuildError);
    const failure = caught as RestoreIndexBuildError;
    expect(commands).toEqual(["define:1", "inspect:1"]);
    expect(failure.diagnostics.at(-1)).toMatchObject({
      ordinal: 1,
      state: "failed",
      category: "cancelled",
      polls: 1,
    });
    expect(failure.startedIndexes).toEqual([RESTORE_FULLTEXT_INDEX_DEFINITIONS[0]]);
    expect(JSON.stringify(failure.diagnostics)).not.toContain("SuperPrivateToken");
  });

  test("asynchronous error is terminal and retains only safe counts", async () => {
    const commands: RestoreIndexCommand[] = [];
    const error = await buildFailure(async (command) => {
      commands.push(command);
      if (command.kind === "define") return accepted();
      return inspected(command, "error", {
        initial: 44,
        pending: 2,
        updated: 1,
        error: "SuperPrivateToken nested builder detail",
      });
    });
    expect(commands.map((command) => `${command.kind}:${command.ordinal}`)).toEqual([
      "define:1",
      "inspect:1",
    ]);
    expect(error.diagnostics.at(-1)).toMatchObject({
      ordinal: 1,
      state: "failed",
      category: "asynchronous_failure",
      status: "error",
      initial: 44,
      pending: 2,
      updated: 1,
    });
    expect(JSON.stringify(error.diagnostics)).not.toContain("SuperPrivateToken");
  });

  test("classifies the exact memory-threshold outer ERR with its safe envelope scope", async () => {
    for (const [envelopeIndex, envelope] of [
      [0, "table_info"],
      [1, "index_info"],
    ] as const) {
      let inspectCalls = 0;
      const error = await buildFailure(async (command) => {
        if (command.kind === "define") return accepted();
        inspectCalls += 1;
        const response = inspected(command, "indexing") as {
          body: Array<Record<string, unknown>>;
        };
        response.body[envelopeIndex] = {
          status: "ERR",
          result: MEMORY_THRESHOLD_ERROR_RESULT,
          privateContext: "SuperPrivateToken envelope detail",
        };
        return response;
      });

      expect(inspectCalls).toBe(1);
      expect(error.diagnostics.at(-1)).toMatchObject({
        category: "memory_pressure",
        envelope,
        status: "err",
        polls: 1,
      });
      const durable = JSON.stringify(error.diagnostics);
      expect(durable).not.toContain(MEMORY_THRESHOLD_ERROR_RESULT);
      expect(durable).not.toContain("SuperPrivateToken");
    }
  });

  test("unknown outer ERR stays fail-closed, scoped, redacted, and is not retried", async () => {
    for (const [envelopeIndex, envelope] of [
      [0, "table_info"],
      [1, "index_info"],
    ] as const) {
      let inspectCalls = 0;
      const error = await buildFailure(async (command) => {
        if (command.kind === "define") return accepted();
        inspectCalls += 1;
        const response = inspected(command, "indexing") as {
          body: Array<Record<string, unknown>>;
        };
        response.body[envelopeIndex] = {
          status: "ERR",
          result: "SuperPrivateToken unknown database response",
        };
        return response;
      });

      expect(inspectCalls).toBe(1);
      expect(error.diagnostics.at(-1)).toMatchObject({
        category: "malformed_info",
        envelope,
        status: "err",
        polls: 1,
      });
      expect(JSON.stringify(error.diagnostics)).not.toContain("SuperPrivateToken");
      expect(error.message).not.toContain("SuperPrivateToken");
    }
  });

  test("one overall fake-clock deadline bounds all polling", async () => {
    const clock = fakeClock();
    let inspectCalls = 0;
    const error = await buildFailure(async (command) => {
      if (command.kind === "define") return accepted();
      inspectCalls += 1;
      return inspected(command, "indexing", { initial: 1, pending: 0, updated: 0 });
    }, {
      timeoutMs: 100,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(inspectCalls).toBe(1);
    expect(clock.sleeps).toEqual([100]);
    expect(error.diagnostics.at(-1)).toMatchObject({
      category: "timeout",
      polls: 1,
      elapsedMs: 100,
      indexElapsedMs: 100,
    });
  });

  test("malformed INFO counts fail closed without response content", async () => {
    const error = await buildFailure(async (command) => {
      if (command.kind === "define") return accepted();
      return inspected(command, "indexing", { pending: "SuperPrivateToken" });
    });
    expect(error.diagnostics.at(-1)?.category).toBe("malformed_info");
    const serialized = JSON.stringify(error.diagnostics);
    expect(serialized).not.toContain("SuperPrivateToken");
    expect(error.diagnostics.at(-1)?.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(error.diagnostics.at(-1)?.responseBytes).toBeGreaterThan(0);
  });

  test("missing and replaced identities are distinct terminal failures", async () => {
    for (const [identity, category] of [
      [null, "missing_index"],
      [
        "DEFINE INDEX search_document_content ON search_document FIELDS other " +
          "FULLTEXT ANALYZER archive_mixed BM25 HIGHLIGHTS CONCURRENTLY",
        "unexpected_identity",
      ],
    ] as const) {
      const error = await buildFailure(async (command) => {
        if (command.kind === "define") return accepted();
        return inspected(command, "indexing", {}, identity);
      });
      expect(error.diagnostics.at(-1)?.category).toBe(category);
    }
  });

  test("unknown non-ready status and command errors never continue polling", async () => {
    const nonReady = await buildFailure(async (command) =>
      command.kind === "define" ? accepted() : inspected(command, "stalled"));
    expect(nonReady.diagnostics.at(-1)).toMatchObject({
      category: "non_ready_terminal",
      status: "stalled",
    });

    const aborted = await buildFailure(async (command) =>
      command.kind === "define" ? accepted() : inspected(command, "aborted"));
    expect(aborted.diagnostics.at(-1)).toMatchObject({
      category: "asynchronous_failure",
      status: "aborted",
    });

    const privateError = await buildFailure(async (command) => {
      if (command.kind === "define") return accepted();
      throw new Error("SuperPrivateToken SDK details");
    });
    expect(privateError.diagnostics.at(-1)?.category).toBe("inspect_request");
    expect(JSON.stringify(privateError.diagnostics)).not.toContain("SuperPrivateToken");
  });
});
