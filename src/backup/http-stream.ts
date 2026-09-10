/**
 * Header-first HTTP download transport for very large logical exports.
 *
 * Bun's fetch() may wait for a multi-gigabyte response body before resolving
 * the Response promise. Node's request API invokes its callback as soon as
 * response headers arrive, so pipeline() can apply backpressure while bytes
 * are written to the private target file.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, rm, unlink, type FileHandle } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { CURL_EXECUTABLE, curlConfigQuote, curlChildEnvironment } from "./http-curl.ts";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_MAX_ERROR_BODY_BYTES = 8 * 1024;
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export interface StreamHttpGetOptions {
  url: string | URL;
  headers?: Readonly<Record<string, string>>;
  targetPath: string;
  signal?: AbortSignal;
  /** Safe operation name used in errors; never pass credentials or URLs. */
  operation?: string;
  maxErrorBodyBytes?: number;
}

export interface StreamHttpGetResult {
  bytesWritten: number;
  statusCode: number;
}

interface OwnedFileIdentity {
  dev: number;
  ino: number;
}

function validateUrl(input: string | URL): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HTTP stream: unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("HTTP stream: credentials in URL are forbidden");
  }
  return url;
}

function validateErrorBodyLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_ERROR_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1024 * 1024) {
    throw new Error("HTTP stream: maxErrorBodyBytes must be an integer between 0 and 1048576");
  }
  return limit;
}

function redactEchoedCredentials(
  text: string,
  headers: Readonly<Record<string, string>>,
): string {
  let redacted = text;
  for (const [name, value] of Object.entries(headers)) {
    if (value && SENSITIVE_REQUEST_HEADERS.has(name.toLowerCase())) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  return redacted;
}

function responseFromHeaders(
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
): Promise<{ response: IncomingMessage; dispose: () => void }> {
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let settled = false;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        headers,
        agent: false,
      },
      (incoming) => {
        response = incoming;
        settled = true;
        resolve({ response: incoming, dispose });
      },
    );
    const abortError = () => {
      const reason = signal?.reason;
      return reason instanceof Error ? reason : new DOMException("HTTP stream aborted", "AbortError");
    };
    const dispose = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      const error = abortError();
      response?.destroy(error);
      request.destroy(error);
      if (!settled) {
        settled = true;
        dispose();
        reject(error);
      }
    };
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        dispose();
        reject(error);
      } else {
        response?.destroy(error);
      }
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

/**
 * Bounded POST download through an OS pipe. Bun 1.3's fetch and IncomingMessage
 * can accumulate native response buffers behind a slow JavaScript consumer.
 * curl blocks on its stdout pipe instead; credentials/config travel only on stdin.
 */
export async function* streamHttpPostResponse(options: {
  url: string | URL;
  headers: Readonly<Record<string,string>>;
  body: string;
  signal?: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const url=validateUrl(options.url);
  if(!Bun.which(CURL_EXECUTABLE))throw Object.assign(new Error("HTTP stream: curl is required"),{code:"CURL_NOT_FOUND"});
  const mkfifo=Bun.which("mkfifo");
  if(!mkfifo)throw Object.assign(new Error("HTTP stream: mkfifo is required"),{code:"MKFIFO_NOT_FOUND"});
  options.signal?.throwIfAborted();
  const lines=[
    `url = ${curlConfigQuote(url.href)}`, 'request = "POST"', `data-raw = ${curlConfigQuote(options.body)}`,
    "http1.1", "connect-timeout = 30", "speed-limit = 1", "speed-time = 3600",
    `header = "Content-Length: ${Buffer.byteLength(options.body)}"`, 'header = "Expect:"', 'header = "Connection: close"',
  ];
  for(const [name,value] of Object.entries(options.headers)) {
    if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)||["content-length","transfer-encoding","expect","connection"].includes(name.toLowerCase()))throw new Error("HTTP stream: invalid header");
    lines.push(`header = ${curlConfigQuote(`${name}: ${value}`)}`);
  }
  const directory=await mkdtemp(path.join(tmpdir(),"baka-http-pipe-"));
  const fifo=path.join(directory,"body");
  let bootstrap:FileHandle|undefined,reader:FileHandle|undefined,writer:FileHandle|undefined;
  let child:Bun.Subprocess<"pipe",number,"pipe">|undefined,statusTask:Promise<number>|undefined;
  const onAbort=()=>{try{child?.kill("SIGTERM");}catch{}};
  try {
    const made=Bun.spawn([mkfifo,"-m","600",fifo],{stdout:"ignore",stderr:"ignore",env:curlChildEnvironment()});
    if(await made.exited!==0||!(await lstat(fifo)).isFIFO())throw new Error("HTTP stream: cannot create private FIFO");
    // Bootstrap avoids blocking either open; only the child retains a writer afterward.
    bootstrap=await open(fifo,fsConstants.O_RDWR|fsConstants.O_NOFOLLOW);
    reader=await open(fifo,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
    writer=await open(fifo,fsConstants.O_WRONLY|fsConstants.O_NOFOLLOW);
    options.signal?.throwIfAborted();
    child=Bun.spawn([CURL_EXECUTABLE,"--disable","--silent","--show-error","--fail","--no-buffer","--config","-","--write-out","%{stderr}\\nBAKA_HTTP_STATUS:%{http_code}\\n"],{stdin:"pipe",stdout:writer.fd,stderr:"pipe",env:curlChildEnvironment()});
    await writer.close();writer=undefined;await bootstrap.close();bootstrap=undefined;
    options.signal?.addEventListener("abort",onAbort,{once:true});
    const process=child;
    statusTask=(async()=>{
      let suffix="";
      for await(const chunk of process.stderr)suffix=(suffix+Buffer.from(chunk).toString("utf8")).slice(-8192);
      return Number(/BAKA_HTTP_STATUS:(\d{3})/.exec(suffix)?.[1]??0);
    })();
    child.stdin.write(`${lines.join("\n")}\n`);await child.stdin.end();
    while(true) {
      options.signal?.throwIfAborted();
      const buffer=Buffer.allocUnsafe(64*1024);
      const {bytesRead}=await reader.read(buffer,0,buffer.byteLength,null);
      if(!bytesRead)break;
      yield buffer.subarray(0,bytesRead);
    }
    const exitCode=await child.exited,status=await statusTask;
    options.signal?.throwIfAborted();
    if(exitCode!==0||status!==200)throw Object.assign(new Error("HTTP stream: source request failed"),{code:exitCode===28?"ETIMEDOUT":status?"HTTP_STATUS_ERROR":"HTTP_TRANSPORT_ERROR",status,exitCode});
  } finally {
    options.signal?.removeEventListener("abort",onAbort);
    if(child?.exitCode===null)onAbort();
    await writer?.close();await bootstrap?.close();
    if(child)await child.exited;
    await statusTask;await reader?.close();
    await rm(directory,{recursive:true,force:true});
  }
}

async function boundedErrorBody(
  response: IncomingMessage,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks, kept)
        .toString("utf8")
        .replace(/\s+/gu, " ")
        .trim();
      resolve({ text, truncated });
    };
    response.on("data", (value: Buffer | Uint8Array | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = limit - kept;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        chunks.push(retained);
        kept += retained.byteLength;
      }
      if (chunk.byteLength > remaining) {
        truncated = true;
        // Do not wait for an unbounded or stalled error response body.
        response.destroy();
        finish();
      }
    });
    response.once("end", finish);
    response.once("close", finish);
    response.once("aborted", () => {
      if (truncated) finish();
      else reject(new Error("HTTP error response aborted before completion"));
    });
    response.once("error", (error) => {
      if (truncated) finish();
      else reject(error);
    });
  });
}

async function removeOwnedTarget(
  targetPath: string,
  identity: OwnedFileIdentity,
): Promise<void> {
  const current = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!current) return;
  if (
    !current.isFile() || current.isSymbolicLink() ||
    current.dev !== identity.dev || current.ino !== identity.ino
  ) {
    throw new Error("HTTP stream target changed during failure cleanup");
  }
  await unlink(targetPath);
}

async function closeFile(handle: FileHandle): Promise<void> {
  await handle.close().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EBADF") throw error;
  });
}

/**
 * Streams one HTTP(S) GET response into a newly-created 0600 file.
 *
 * The target is opened with O_EXCL and is removed on every transport/status/
 * write failure. Redirects are never followed. The caller owns fsync after a
 * successful return, keeping durability policy at the artifact layer.
 */
export async function streamHttpGetToExclusiveFile(
  options: StreamHttpGetOptions,
): Promise<StreamHttpGetResult> {
  const url = validateUrl(options.url);
  const errorBodyLimit = validateErrorBodyLimit(options.maxErrorBodyBytes);
  const operation = options.operation?.trim() || "HTTP download";
  const handle = await open(
    options.targetPath,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const created = await handle.stat().catch(async (error) => {
    await closeFile(handle);
    await unlink(options.targetPath).catch(() => {});
    throw error;
  });
  const identity = { dev: created.dev, ino: created.ino };
  let disposeResponse = () => {};

  try {
    await handle.chmod(0o600);
    const opened = await responseFromHeaders(url, options.headers ?? {}, options.signal);
    const response = opened.response;
    disposeResponse = opened.dispose;
    const statusCode = response.statusCode;
    if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
      const body = await boundedErrorBody(response, errorBodyLimit);
      const safeBody = redactEchoedCredentials(body.text, options.headers ?? {});
      const redirect = statusCode !== undefined && statusCode >= 300 && statusCode < 400;
      const detail = safeBody
        ? `: ${safeBody}${body.truncated ? "…" : ""}`
        : body.truncated
        ? ": …"
        : "";
      throw new Error(
        `${operation}: HTTP ${statusCode ?? "missing status"}` +
          `${redirect ? " (redirect rejected)" : ""}${detail}`,
      );
    }

    // pipeline waits for the destination close event. Let the stream close
    // its FileHandle; autoClose:false leaves pipeline waiting after "finish".
    const output = handle.createWriteStream({ autoClose: true });
    await pipeline(response, output, { signal: options.signal });
    await closeFile(handle);
    return { bytesWritten: output.bytesWritten, statusCode };
  } catch (error) {
    await closeFile(handle);
    try {
      await removeOwnedTarget(options.targetPath, identity);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${operation} failed and cleanup failed`);
    }
    throw error;
  } finally {
    disposeResponse();
  }
}
