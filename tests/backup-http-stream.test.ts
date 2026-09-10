import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  streamHttpGetToExclusiveFile,
  streamHttpPostResponse,
} from "../src/backup/http-stream.ts";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  httpUploadCurlArguments,
  streamHttpPostFile,
  StreamHttpUploadError,
} from "../src/backup/http-upload.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

async function withTempDir(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "baka-http-stream-test-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test HTTP server has no TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

interface RawRequest {
  headers: Record<string, string>;
  initialBody: Buffer;
  path: string;
}

async function listenRaw(
  handler: (request: RawRequest, socket: Socket) => void | Promise<void>,
): Promise<{ server: TcpServer; sockets: Set<Socket>; baseUrl: string }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let prefix = Buffer.alloc(0);
    const readHeaders = (chunk: Buffer): void => {
      prefix = Buffer.concat([prefix, chunk]);
      const end = prefix.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", readHeaders);
      const lines = prefix.subarray(0, end).toString("latin1").split("\r\n");
      const requestLine = lines.shift()?.split(" ") ?? [];
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      void Promise.resolve(handler({
        headers,
        initialBody: prefix.subarray(end + 4),
        path: requestLine[1] ?? "/",
      }, socket)).catch(() => socket.destroy());
    };
    socket.on("data", readHeaders);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("raw server has no TCP port");
  return { server, sockets, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeRawServer(server: TcpServer, sockets: Set<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  for (const socket of sockets) socket.destroy();
  await closed;
}

function rawResponse(socket: Socket, status: string, body = Buffer.alloc(0), headers = ""): void {
  const head = Buffer.from(
    `HTTP/1.1 ${status}\r\nContent-Length: ${body.byteLength}\r\n` +
      `Connection: close\r\n${headers}\r\n`,
    "latin1",
  );
  socket.end(Buffer.concat([head, body]));
}

async function waitForExactBytes(filePath: string, expected: Buffer): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const actual = await readFile(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (actual?.equals(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("streamed bytes did not become visible before test deadline");
}

function sendChunks(response: ServerResponse, chunks: readonly Buffer[]): void {
  void (async () => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      connection: "close",
    });
    for (const chunk of chunks) {
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  })().catch((error) => response.destroy(error as Error));
}

async function createSparseFile(filePath: string, size: number): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

async function uploadFailure(operation: Promise<unknown>): Promise<StreamHttpUploadError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(StreamHttpUploadError);
    return error as StreamHttpUploadError;
  }
  throw new Error("expected upload to fail");
}

describe("header-first backup HTTP transport", () => {
  test("writes an early chunk before the response completes", async () => {
    await withTempDir(async (directory) => {
      const early = Buffer.from("early-export-chunk\n");
      const late = Buffer.from("late-export-chunk\n");
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      let earlySent!: () => void;
      const sent = new Promise<void>((resolve) => { earlySent = resolve; });
      const { server, baseUrl } = await listen((_request, response) => {
        response.writeHead(200, { connection: "close" });
        response.write(early, () => earlySent());
        void paused.then(() => response.end(late));
      });
      const targetPath = path.join(directory, "large-export.part");
      try {
        let settled = false;
        const transfer = streamHttpGetToExclusiveFile({
          url: `${baseUrl}/export`,
          targetPath,
          operation: "export",
        });
        void transfer.then(
          () => { settled = true; },
          () => { settled = true; },
        );

        await sent;
        await waitForExactBytes(targetPath, early);
        expect(settled).toBe(false);
        release();

        const result = await transfer;
        expect(result.bytesWritten).toBe(early.byteLength + late.byteLength);
        expect(await readFile(targetPath)).toEqual(Buffer.concat([early, late]));
        expect((await lstat(targetPath)).mode & 0o777).toBe(0o600);
      } finally {
        release();
        await closeServer(server);
      }
    });
  });

  test("preserves integrity across a large backpressured multi-chunk response", async () => {
    await withTempDir(async (directory) => {
      const chunks = Array.from({ length: 160 }, (_, index) => {
        const chunk = Buffer.alloc(64 * 1024);
        chunk.writeUInt32BE(index, 0);
        chunk.fill(index % 251, 4);
        return chunk;
      });
      const expectedHash = createHash("sha256");
      for (const chunk of chunks) expectedHash.update(chunk);
      const { server, baseUrl } = await listen((_request, response) => {
        sendChunks(response, chunks);
      });
      const targetPath = path.join(directory, "multi-chunk.part");
      try {
        const result = await streamHttpGetToExclusiveFile({
          url: `${baseUrl}/export`,
          headers: { "x-anonymized-test": "yes" },
          targetPath,
        });
        expect(result.bytesWritten).toBe(chunks.length * chunks[0]!.byteLength);
        expect((await hashFile(targetPath)).sha256).toBe(expectedHash.digest("hex"));
      } finally {
        await closeServer(server);
      }
    });
  });

  test("rejects redirects and bounded non-2xx bodies, removing each target", async () => {
    await withTempDir(async (directory) => {
      let redirectDestinationHits = 0;
      const { server, baseUrl } = await listen((request, response) => {
        if (request.url === "/redirect") {
          response.writeHead(302, {
            location: `${baseUrl}/redirect-destination`,
            connection: "close",
          });
          response.end("do not follow");
          return;
        }
        if (request.url === "/redirect-destination") {
          redirectDestinationHits += 1;
          response.end("unexpected");
          return;
        }
        response.writeHead(503, { connection: "close" });
        response.end(
          `bounded-error-${request.headers.authorization ?? "missing"}-${"x".repeat(128 * 1024)}`,
        );
      });
      try {
        const redirectTarget = path.join(directory, "redirect.part");
        await expect(streamHttpGetToExclusiveFile({
          url: `${baseUrl}/redirect`,
          targetPath: redirectTarget,
        })).rejects.toThrow(/HTTP 302 \(redirect rejected\)/);
        expect(redirectDestinationHits).toBe(0);
        expect(await lstat(redirectTarget).catch(() => undefined)).toBeUndefined();

        const errorTarget = path.join(directory, "error.part");
        let message = "";
        try {
          await streamHttpGetToExclusiveFile({
            url: `${baseUrl}/error`,
            targetPath: errorTarget,
            headers: { Authorization: "Basic private-test-credential" },
            maxErrorBodyBytes: 64,
          });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("HTTP 503: bounded-error-");
        expect(message).toContain("[redacted]");
        expect(message).not.toContain("private-test-credential");
        expect(message.length).toBeLessThan(256);
        expect(await lstat(errorTarget).catch(() => undefined)).toBeUndefined();
      } finally {
        await closeServer(server);
      }
    });
  });

  test("surfaces socket and abort failures and removes partial files", async () => {
    await withTempDir(async (directory) => {
      let abortChunkSent!: () => void;
      const abortChunk = new Promise<void>((resolve) => { abortChunkSent = resolve; });
      const { server, baseUrl } = await listen((request, response) => {
        response.writeHead(200, { connection: "close" });
        response.write("partial\n", () => {
          if (request.url === "/abort") abortChunkSent();
          else response.destroy(new Error("injected socket failure"));
        });
      });
      try {
        const socketTarget = path.join(directory, "socket.part");
        await expect(streamHttpGetToExclusiveFile({
          url: `${baseUrl}/socket`,
          targetPath: socketTarget,
        })).rejects.toThrow(/socket|closed|reset/iu);
        expect(await lstat(socketTarget).catch(() => undefined)).toBeUndefined();

        const abortTarget = path.join(directory, "abort.part");
        const controller = new AbortController();
        const aborted = streamHttpGetToExclusiveFile({
          url: `${baseUrl}/abort`,
          targetPath: abortTarget,
          signal: controller.signal,
        });
        await abortChunk;
        controller.abort(new Error("test abort"));
        await expect(aborted).rejects.toThrow(/test abort/iu);
        expect(await lstat(abortTarget).catch(() => undefined)).toBeUndefined();
      } finally {
        await closeServer(server);
      }
    });
  });

  test("exclusive create never overwrites an existing target", async () => {
    await withTempDir(async (directory) => {
      const targetPath = path.join(directory, "existing.part");
      await writeFile(targetPath, "preserve-me");
      await expect(streamHttpGetToExclusiveFile({
        url: "http://127.0.0.1:1/export",
        targetPath,
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(targetPath, "utf8")).toBe("preserve-me");
    });
  });
});

describe("network-streamed restore HTTP transport", () => {
  test("disables curlrc before every other curl argument", () => {
    const args = httpUploadCurlArguments();
    expect(args[0]).toBe("--disable");
    expect(args.slice(1)).toEqual([
      "--config",
      "-",
      "--write-out",
      expect.stringContaining("BAKA_HTTP_UPLOAD_V1"),
    ]);
  });

  test("keeps the production silent-response window at least one hour", () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  test("server receives initial bytes before the sparse file is fully read with bounded RSS", async () => {
    await withTempDir(async (directory) => {
      const sourcePath = path.join(directory, "large-import.surql");
      const totalBytes = 256 * 1024 * 1024;
      await createSparseFile(sourcePath, totalBytes);
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let firstChunk!: () => void;
      const firstReceived = new Promise<void>((resolve) => { firstChunk = resolve; });
      let received = 0;
      let observedHeaders: Record<string, string> | undefined;
      const { server, sockets, baseUrl } = await listenRaw((request, socket) => {
        observedHeaders = request.headers;
        let paused = false;
        const consume = (chunk: Buffer): void => {
          received += chunk.byteLength;
          if (!paused) {
            paused = true;
            socket.pause();
            firstChunk();
            void released.then(() => socket.resume());
          }
          if (received === totalBytes) rawResponse(socket, "204 No Content");
        };
        socket.on("data", consume);
        if (request.initialBody.byteLength > 0) consume(request.initialBody);
      });
      let settled = false;
      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;
      const sample = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 2);
      try {
        const upload = streamHttpPostFile({
          url: `${baseUrl}/import`,
          headers: { "x-anonymized-test": "streaming" },
          sourcePath,
          idleTimeoutMs: 5_000,
        });
        void upload.then(
          () => { settled = true; },
          () => { settled = true; },
        );

        await firstReceived;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(received).toBeGreaterThan(0);
        expect(received).toBeLessThan(totalBytes);
        expect(settled).toBe(false);
        expect(peakRss - baselineRss).toBeLessThan(96 * 1024 * 1024);
        expect(observedHeaders?.["content-length"]).toBe(String(totalBytes));
        expect(observedHeaders?.["transfer-encoding"]).toBeUndefined();
        expect(observedHeaders?.["x-anonymized-test"]).toBe("streaming");
        release();

        const result = await upload;
        expect(result.bytesSent).toBe(totalBytes);
        expect(received).toBe(totalBytes);
      } finally {
        clearInterval(sample);
        release();
        await closeRawServer(server, sockets);
      }
    });
  }, 15_000);

  test("preserves exact multi-chunk length and SHA in both directions", async () => {
    await withTempDir(async (directory) => {
      const sourcePath = path.join(directory, "multi-chunk.surql");
      const chunks = Array.from({ length: 192 }, (_, index) => {
        const chunk = Buffer.alloc(64 * 1024);
        chunk.writeUInt32BE(index, 0);
        chunk.fill((index * 17) % 251, 4);
        return chunk;
      });
      await writeFile(sourcePath, Buffer.concat(chunks));
      const expected = await hashFile(sourcePath);
      const receivedHash = createHash("sha256");
      let receivedBytes = 0;
      const { server, baseUrl } = await listen((request, response) => {
        request.on("error", () => {});
        request.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
          receivedHash.update(chunk);
        });
        request.once("end", () => {
          response.writeHead(200, { connection: "close" });
          response.end("ok");
        });
      });
      try {
        const result = await streamHttpPostFile({
          url: `${baseUrl}/import`,
          sourcePath,
        });
        expect(result.statusCode).toBe(200);
        expect(result.bytesSent).toBe(expected.sizeBytes);
        expect(receivedBytes).toBe(expected.sizeBytes);
        expect(receivedHash.digest("hex")).toBe(expected.sha256);
      } finally {
        await closeServer(server);
      }
    });
  });

  test("early non-2xx stops a >4GiB read and exposes only bounded hash evidence", async () => {
    await withTempDir(async (directory) => {
      const sourcePath = path.join(directory, "sparse-over-4g.surql");
      const totalBytes = 5 * 1024 * 1024 * 1024 + 123;
      await createSparseFile(sourcePath, totalBytes);
      const privateBody = Buffer.from("private SQL/dialogue response private-credential");
      const oversizedPrivateBody = Buffer.from(
        `private oversized response ${"x".repeat(256 * 1024)}`,
      );
      let contentLength = "";
      const { server, baseUrl } = await listen((request, response) => {
        request.on("error", () => {});
        response.on("error", () => {});
        contentLength = request.headers["content-length"] ?? "";
        response.writeHead(503, { connection: "close" });
        response.end(request.url === "/bounded" ? oversizedPrivateBody : privateBody);
      });
      try {
        const error = await uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/import`,
          headers: { Authorization: "Basic private-credential" },
          sourcePath,
          maxErrorBodyBytes: 64,
          idleTimeoutMs: 2_000,
          operation: "restore import",
        }));
        expect(contentLength).toBe(String(totalBytes));
        expect(error.evidence).toEqual({
          category: "http_server_error",
          bytesSent: expect.any(Number),
          statusCode: 503,
          responseBodyBytes: privateBody.byteLength,
          responseBodySha256: createHash("sha256").update(privateBody).digest("hex"),
          responseBodyTruncated: false,
        });
        expect(error.evidence.bytesSent).toBeLessThan(totalBytes);
        expect(error.message).not.toContain("private SQL");
        expect(error.message).not.toContain("private-credential");

        const bounded = await uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/bounded`,
          sourcePath,
          maxErrorBodyBytes: 64,
          idleTimeoutMs: 2_000,
          operation: "restore import",
        }));
        expect(bounded.evidence.category).toBe("http_server_error");
        expect(bounded.evidence.statusCode).toBe(503);
        expect(bounded.evidence.responseBodyBytes).toBeLessThanOrEqual(64);
        expect(bounded.evidence.responseBodySha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(bounded.evidence.responseBodyTruncated).toBe(true);
        expect(bounded.message).not.toContain("private oversized response");

        // The transport owns no lingering file descriptor after failure.
        const moved = `${sourcePath}.moved`;
        await rename(sourcePath, moved);
        const reopened = await open(moved, "r+");
        await reopened.close();
      } finally {
        await closeServer(server);
      }
    });
  }, 10_000);

  test("rejects redirects and an early 2xx without reading the whole source", async () => {
    await withTempDir(async (directory) => {
      const sourcePath = path.join(directory, "early-response.surql");
      await createSparseFile(sourcePath, 128 * 1024 * 1024);
      let redirectedHits = 0;
      const { server, baseUrl } = await listen((request, response) => {
        request.on("error", () => {});
        if (request.url === "/redirect") {
          response.writeHead(307, {
            location: `${baseUrl}/redirected`,
            connection: "close",
          });
          response.end("redirect rejected");
          return;
        }
        if (request.url === "/redirected") {
          redirectedHits += 1;
          response.end();
          return;
        }
        response.writeHead(204, { connection: "close" });
        response.end();
      });
      try {
        const redirect = await uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/redirect`,
          sourcePath,
          idleTimeoutMs: 2_000,
        }));
        expect(redirect.evidence.category).toBe("http_redirect");
        expect(redirect.evidence.statusCode).toBe(307);
        expect(redirect.evidence.bytesSent).toBeLessThan(128 * 1024 * 1024);
        expect(redirectedHits).toBe(0);

        const success = await uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/early-success`,
          sourcePath,
          idleTimeoutMs: 2_000,
        }));
        expect(success.evidence.category).toBe("protocol_error");
        expect(success.evidence.bytesSent).toBeLessThan(128 * 1024 * 1024);
      } finally {
        await closeServer(server);
      }
    });
  }, 10_000);

  test("socket failure and inactivity timeout stop reading and release resources", async () => {
    await withTempDir(async (directory) => {
      const sourcePath = path.join(directory, "transport-failure.surql");
      const totalBytes = 1024 * 1024 * 1024;
      await createSparseFile(sourcePath, totalBytes);
      const { server, sockets, baseUrl } = await listenRaw((request, socket) => {
        if (request.path === "/socket") {
          if (request.initialBody.byteLength > 0) socket.destroy();
          else socket.once("data", () => socket.destroy());
        } else {
          // Stop consuming at the kernel boundary. A sparse 1 GiB source
          // cannot fit into socket buffers, so curl's low-speed timer is
          // exercised without Bun's inbound HTTP buffering masking the stall.
          socket.pause();
        }
      });
      try {
        const socket = await uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/socket`,
          sourcePath,
          idleTimeoutMs: 2_000,
        }));
        expect(socket.evidence.category).toBe("socket_error");
        expect(socket.evidence.bytesSent).toBeLessThan(totalBytes);

        const timeout = await uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/timeout`,
          sourcePath,
          idleTimeoutMs: 1_000,
        }));
        expect(timeout.evidence.category).toBe("timeout");
        expect(timeout.evidence.bytesSent).toBeLessThan(totalBytes);
      } finally {
        await closeRawServer(server, sockets);
      }
    });
  }, 15_000);

  test("abort stops an active upload and releases the source handle", async () => {
    await withTempDir(async (directory) => {
      const sourcePath = path.join(directory, "aborted-upload.surql");
      const totalBytes = 1024 * 1024 * 1024;
      await createSparseFile(sourcePath, totalBytes);
      let firstChunk!: () => void;
      const firstReceived = new Promise<void>((resolve) => { firstChunk = resolve; });
      const { server, sockets, baseUrl } = await listenRaw((request, socket) => {
        const stop = (): void => {
          socket.pause();
          firstChunk();
        };
        if (request.initialBody.byteLength > 0) stop();
        else socket.once("data", stop);
      });
      const controller = new AbortController();
      try {
        const upload = uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/abort`,
          sourcePath,
          signal: controller.signal,
          idleTimeoutMs: 2_000,
        }));
        await firstReceived;
        controller.abort();
        const error = await upload;
        expect(error.evidence.category).toBe("aborted");
        expect(error.evidence.bytesSent).toBeLessThan(totalBytes);

        const moved = `${sourcePath}.moved`;
        await rename(sourcePath, moved);
        const reopened = await open(moved, "r+");
        await reopened.close();
      } finally {
        controller.abort();
        await closeRawServer(server, sockets);
      }
    });
  }, 10_000);

  test("rejects symlinks and detects truncation during an active upload", async () => {
    await withTempDir(async (directory) => {
      const realPath = path.join(directory, "real.surql");
      const linkPath = path.join(directory, "link.surql");
      await createSparseFile(realPath, 32 * 1024 * 1024);
      await symlink(realPath, linkPath);
      const symlinkError = await uploadFailure(streamHttpPostFile({
        url: "http://127.0.0.1:1/import",
        sourcePath: linkPath,
      }));
      expect(symlinkError.evidence).toEqual({ category: "file_read_error", bytesSent: 0 });

      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let firstChunk!: () => void;
      const received = new Promise<void>((resolve) => { firstChunk = resolve; });
      const { server, baseUrl } = await listen((request, response) => {
        request.on("error", () => {});
        request.once("data", () => {
          request.pause();
          firstChunk();
          void released.then(() => request.resume());
        });
        request.once("end", () => {
          response.writeHead(200, { connection: "close" });
          response.end();
        });
      });
      try {
        const upload = uploadFailure(streamHttpPostFile({
          url: `${baseUrl}/truncate`,
          sourcePath: realPath,
          idleTimeoutMs: 2_000,
        }));
        await received;
        await truncate(realPath, 1);
        release();
        const error = await upload;
        expect(error.evidence.category).toBe("file_read_error");
        expect(error.evidence.bytesSent).toBeLessThan(32 * 1024 * 1024);
      } finally {
        release();
        await closeServer(server);
      }
    });
  }, 10_000);
});

test("POST download applies real backpressure while its consumer is paused", async () => {
  const total=64*1024*1024,block=Buffer.alloc(64*1024,97);
  let sent=0,finished=false;
  const {server,sockets,baseUrl}=await listenRaw(async (_request,socket)=>{
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`);
    while(sent<total){if(!socket.write(block))await once(socket,"drain");sent+=block.length;}
    finished=true;socket.end();
  });
  const stream=streamHttpPostResponse({url:baseUrl,headers:{"Content-Type":"application/json"},body:"{}"});
  try {
    const first=await stream.next();expect(first.done).toBe(false);
    // curl and kernel socket buffers run on real time, outside Bun's fake clock.
    await Bun.sleep(200);
    expect(finished).toBe(false);
    expect(sent).toBeLessThan(total);
    let received=first.value!.byteLength,maximumChunk=received;
    for await(const chunk of stream){maximumChunk=Math.max(maximumChunk,chunk.byteLength);received+=chunk.byteLength;}
    expect(maximumChunk).toBeLessThanOrEqual(64*1024);
    expect(received).toBe(total);
  } finally {await stream.return(undefined);await closeRawServer(server,sockets);}
});

test("POST stream cancellation closes the source connection", async () => {
  let closed!:()=>void;
  const sourceClosed=new Promise<void>(resolve=>{closed=resolve;});
  const {server,sockets,baseUrl}=await listenRaw((_request,socket)=>{
    socket.once("close",closed);
    socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4000\r\n"+"x".repeat(16384)+"\r\n");
  });
  const abort=new AbortController();
  const stream=streamHttpPostResponse({url:baseUrl,headers:{},body:"{}",signal:abort.signal});
  try {
    expect((await stream.next()).done).toBe(false);
    abort.abort();
    await expect(stream.next()).rejects.toThrow();
    await sourceClosed;
  } finally {await stream.return(undefined);await closeRawServer(server,sockets);}
});
