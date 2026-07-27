/**
 * Native streaming HTTP(S) upload for multi-gigabyte SurrealDB imports.
 *
 * Bun's node:http outgoing requests buffer bodies, and passing Bun.file()
 * directly to fetch stalled on a large import. curl's upload-file
 * path streams a regular file with libcurl backpressure. URL and headers
 * (including Basic auth) are delivered through stdin config, never argv,
 * inherited environment or logs.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

const CURL_EXECUTABLE = "/usr/bin/curl";
const DEFAULT_MAX_ERROR_BODY_BYTES = 64 * 1024;
// SurrealDB can remain silent while it applies the tail of a multi-gigabyte
// import. Keep production tolerance deliberately long; deterministic tests
// pass a much smaller override.
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_DIAGNOSTIC_BYTES = 4096;
const CURL_WRITE_OUT =
  "%{stderr}BAKA_HTTP_UPLOAD_V1:%{response_code}:%{size_upload}:%{size_download}:%{exitcode}\\n";

/** Pure subprocess contract; --disable must precede every curl option. */
export function httpUploadCurlArguments(): string[] {
  return ["--disable", "--config", "-", "--write-out", CURL_WRITE_OUT];
}

export type StreamHttpUploadFailureCategory =
  | "http_redirect"
  | "http_client_error"
  | "http_server_error"
  | "http_status_error"
  | "timeout"
  | "aborted"
  | "socket_error"
  | "file_read_error"
  | "protocol_error";

/** Privacy-safe evidence: response content is represented only by length/SHA. */
export interface StreamHttpUploadFailureEvidence {
  category: StreamHttpUploadFailureCategory;
  bytesSent: number;
  statusCode?: number;
  responseBodyBytes?: number;
  responseBodySha256?: string;
  responseBodyTruncated?: boolean;
}

export class StreamHttpUploadError extends Error {
  constructor(readonly evidence: StreamHttpUploadFailureEvidence, operation = "HTTP upload") {
    const status = evidence.statusCode === undefined ? "" : ` status=${evidence.statusCode}`;
    const body = evidence.responseBodySha256 === undefined
      ? ""
      : ` bodyBytes=${evidence.responseBodyBytes} bodySha256=${evidence.responseBodySha256}` +
        ` bodyTruncated=${evidence.responseBodyTruncated === true}`;
    super(`${operation}: ${evidence.category}${status} bytesSent=${evidence.bytesSent}${body}`);
    this.name = "StreamHttpUploadError";
  }
}

export interface StreamHttpPostFileOptions {
  url: string | URL;
  headers?: Readonly<Record<string, string>>;
  sourcePath: string;
  signal?: AbortSignal;
  /** Low-speed/connection timeout; long active imports have no total deadline. */
  idleTimeoutMs?: number;
  maxErrorBodyBytes?: number;
  /** Safe operation name; never pass credentials, paths or URLs. */
  operation?: string;
}

export interface StreamHttpPostFileResult {
  bytesSent: number;
  statusCode: number;
}

interface CurlWriteOut {
  statusCode: number;
  bytesSent: number;
  responseBytes: number;
  exitCode: number;
}

function safeError(
  category: StreamHttpUploadFailureCategory,
  bytesSent: number,
  operation: string,
): StreamHttpUploadError {
  return new StreamHttpUploadError({ category, bytesSent }, operation);
}

function validateUrl(input: string | URL): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HTTP upload: unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("HTTP upload: credentials in URL are forbidden");
  }
  return url;
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_ERROR_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024) {
    throw new Error("HTTP upload: maxErrorBodyBytes must be an integer between 1 and 1048576");
  }
  return limit;
}

function validateIdleTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 24 * 60 * 60 * 1000) {
    throw new Error("HTTP upload: idleTimeoutMs must be an integer between 1 and 86400000");
  }
  return timeout;
}

function configQuote(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("HTTP upload: control characters are forbidden in curl config values");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function curlConfig(input: {
  url: URL;
  sourcePath: string;
  headers: Readonly<Record<string, string>>;
  contentLength: number;
  maxErrorBodyBytes: number;
  idleTimeoutMs: number;
}): string {
  const forbidden = new Set(["content-length", "transfer-encoding", "expect", "connection"]);
  const headerLines: string[] = [];
  for (const [name, value] of Object.entries(input.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || forbidden.has(name.toLowerCase())) {
      throw new Error(`HTTP upload: forbidden or invalid caller header ${name}`);
    }
    headerLines.push(`header = ${configQuote(`${name}: ${value}`)}`);
  }
  const timeoutSeconds = Math.max(1, Math.ceil(input.idleTimeoutMs / 1000));
  return [
    "silent",
    "http1.1",
    `url = ${configQuote(input.url.toString())}`,
    'request = "POST"',
    `upload-file = ${configQuote(input.sourcePath)}`,
    `header = ${configQuote(`Content-Length: ${input.contentLength}`)}`,
    'header = "Expect:"',
    'header = "Connection: close"',
    ...headerLines,
    'output = "-"',
    `max-filesize = ${input.maxErrorBodyBytes}`,
    "speed-limit = 1",
    `speed-time = ${timeoutSeconds}`,
    `connect-timeout = ${Math.min(timeoutSeconds, 30)}`,
    "",
  ].join("\n");
}

function parseSafeInteger(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseCurlWriteOut(value: string): CurlWriteOut | undefined {
  const matches = [...value.matchAll(
    /(?:^|\n)BAKA_HTTP_UPLOAD_V1:(\d{3}):(\d+):(\d+):(\d+)(?=\n|$)/gu,
  )];
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const statusCode = Number(match[1]);
  const bytesSent = parseSafeInteger(match[2]!);
  const responseBytes = parseSafeInteger(match[3]!);
  const exitCode = parseSafeInteger(match[4]!);
  if (bytesSent === undefined || responseBytes === undefined || exitCode === undefined) {
    return undefined;
  }
  return { statusCode, bytesSent, responseBytes, exitCode };
}

function statusCategory(statusCode: number): StreamHttpUploadFailureCategory {
  if (statusCode >= 300 && statusCode < 400) return "http_redirect";
  if (statusCode >= 400 && statusCode < 500) return "http_client_error";
  if (statusCode >= 500 && statusCode < 600) return "http_server_error";
  return "http_status_error";
}

async function hashBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  stop: () => void,
): Promise<{ bytes: number; sha256: string; overflow: boolean }> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  let bytes = 0;
  let overflow = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = limit - bytes;
      if (remaining > 0) {
        const retained = item.value.subarray(0, remaining);
        hash.update(retained);
        bytes += retained.byteLength;
      }
      if (item.value.byteLength > remaining) {
        overflow = true;
        stop();
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // Transport exit can close stdout after a bounded prefix; the prefix hash
    // remains honest and raw bytes are never surfaced.
  } finally {
    reader.releaseLock();
  }
  return { bytes, sha256: hash.digest("hex"), overflow };
}

async function readBoundedDiagnostic(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (bytes + item.value.byteLength > MAX_DIAGNOSTIC_BYTES) return "";
      chunks.push(item.value);
      bytes += item.value.byteLength;
    }
  } catch {
    return "";
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

function safeChildEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR"]
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Streams one regular file into HTTP(S) POST through native curl/libcurl.
 * Redirect following is never enabled. curl receives every secret only via
 * stdin config and emits no response/error text; stderr contains fixed numeric
 * write-out counters consumed privately by this function.
 */
export async function streamHttpPostFile(
  options: StreamHttpPostFileOptions,
): Promise<StreamHttpPostFileResult> {
  const operation = options.operation?.trim() || "HTTP upload";
  const url = validateUrl(options.url);
  const maxErrorBodyBytes = validateLimit(options.maxErrorBodyBytes);
  const idleTimeoutMs = validateIdleTimeout(options.idleTimeoutMs);
  let handle: FileHandle;
  try {
    handle = await open(options.sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw safeError("file_read_error", 0, operation);
  }

  let child: ReturnType<typeof Bun.spawn> | undefined;
  let externallyAborted = false;
  let removeAbortListener = () => {};
  try {
    const initial = await handle.stat();
    const pathStats = await lstat(options.sourcePath);
    if (!initial.isFile() || pathStats.isSymbolicLink() || !pathStats.isFile() ||
        initial.dev !== pathStats.dev || initial.ino !== pathStats.ino ||
        !Number.isSafeInteger(initial.size) || initial.size < 0) {
      throw safeError("file_read_error", 0, operation);
    }
    const config = curlConfig({
      url,
      sourcePath: options.sourcePath,
      headers: options.headers ?? {},
      contentLength: initial.size,
      maxErrorBodyBytes,
      idleTimeoutMs,
    });
    if (options.signal?.aborted) throw safeError("aborted", 0, operation);

    try {
      child = Bun.spawn({
        cmd: [CURL_EXECUTABLE, ...httpUploadCurlArguments()],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: safeChildEnvironment(),
      });
    } catch {
      throw safeError("socket_error", 0, operation);
    }
    const onAbort = () => {
      externallyAborted = true;
      child?.kill();
    };
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const childStdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdin || typeof childStdin === "number" ||
        !(childStdout instanceof ReadableStream) || !(childStderr instanceof ReadableStream)) {
      throw safeError("protocol_error", 0, operation);
    }
    childStdin.write(config);
    childStdin.end();

    const stopForOverflow = () => child?.kill();
    const [exitCode, body, diagnostic] = await Promise.all([
      child.exited,
      hashBoundedOutput(childStdout, maxErrorBodyBytes, stopForOverflow),
      readBoundedDiagnostic(childStderr),
    ]);
    const writeOut = parseCurlWriteOut(diagnostic);
    const bytesSent = writeOut?.bytesSent ?? 0;
    const finalHandleStats = await handle.stat();
    const finalPathStats = await lstat(options.sourcePath).catch(() => undefined);
    if (!finalPathStats || finalPathStats.isSymbolicLink() || !finalPathStats.isFile() ||
        finalPathStats.dev !== initial.dev || finalPathStats.ino !== initial.ino ||
        finalHandleStats.size !== initial.size || finalPathStats.size !== initial.size) {
      throw safeError("file_read_error", bytesSent, operation);
    }
    if (externallyAborted) throw safeError("aborted", bytesSent, operation);
    if (writeOut && writeOut.exitCode !== exitCode) {
      throw safeError("protocol_error", bytesSent, operation);
    }

    const statusCode = writeOut?.statusCode ?? 0;
    if (statusCode >= 300) {
      throw new StreamHttpUploadError({
        category: statusCategory(statusCode),
        bytesSent,
        statusCode,
        responseBodyBytes: body.bytes,
        responseBodySha256: body.sha256,
        responseBodyTruncated: body.overflow || exitCode === 63 ||
          (writeOut?.responseBytes ?? body.bytes) > body.bytes,
      }, operation);
    }
    if (body.overflow) throw safeError("protocol_error", bytesSent, operation);
    if (exitCode === 28) throw safeError("timeout", bytesSent, operation);
    if (statusCode >= 200 && statusCode < 300 && bytesSent !== initial.size) {
      throw safeError("protocol_error", bytesSent, operation);
    }
    if (exitCode !== 0 || !writeOut || statusCode < 200) {
      throw safeError("socket_error", bytesSent, operation);
    }
    return { bytesSent, statusCode };
  } catch (error) {
    if (error instanceof StreamHttpUploadError) throw error;
    throw safeError("file_read_error", 0, operation);
  } finally {
    removeAbortListener();
    if (child && child.exitCode === null) child.kill();
    await closeFile(handle);
  }
}

async function closeFile(handle: FileHandle): Promise<void> {
  await handle.close().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EBADF") throw error;
  });
}
