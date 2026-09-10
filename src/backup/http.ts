/**
 * HTTP helpers для backup/restore: SurrealDB HTTP API (/export, /import, /sql).
 * Basic auth root-уровня; namespace/database передаются заголовками
 * `surreal-ns`/`surreal-db` (заголовок `NS` в 3.x не работает).
 */

import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";

export const SQL_ROOT_TIMEOUT_MS = 30_000;
export const SQL_ROOT_MAX_RESPONSE_BYTES = 1024 * 1024;

export type SqlRootFailureCategory =
  | "timeout"
  | "transport_error"
  | "http_error"
  | "response_too_large"
  | "malformed_response"
  | "sql_error";

/** Privacy-safe transport evidence: response content is never retained here. */
export interface SqlRootFailureEvidence {
  category: SqlRootFailureCategory;
  httpStatus?: number;
  responseBytes?: number;
  responseSha256?: string;
  responseTruncated?: boolean;
}

export class SqlRootError extends Error {
  constructor(readonly evidence: SqlRootFailureEvidence, cause?: unknown) {
    const status = evidence.httpStatus === undefined ? "" : ` status=${evidence.httpStatus}`;
    const body = evidence.responseSha256 === undefined
      ? ""
      : ` bodyBytes=${evidence.responseBytes} bodySha256=${evidence.responseSha256}` +
        ` bodyTruncated=${evidence.responseTruncated === true}`;
    super(`sql root: ${evidence.category}${status}${body}`, { cause });
    this.name = "SqlRootError";
  }
}

export interface SqlRootOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Deterministic test seam; production always uses the global fetch. */
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/** Базовый HTTP URL сервера (ws://…/rpc → http://…). */
export function httpBaseUrl(cfg: Pick<AppConfig, "surrealUrl">): string {
  return cfg.surrealUrl
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://")
    .replace(/\/rpc\/?$/, "");
}

function basicAuth(cfg: AppConfig): string {
  return `Basic ${Buffer.from(`${cfg.surrealUser}:${cfg.surrealPass}`).toString("base64")}`;
}

export function httpHeaders(
  cfg: AppConfig,
  namespace: string,
  database: string,
): Record<string, string> {
  return {
    Authorization: basicAuth(cfg),
    "surreal-ns": namespace,
    "surreal-db": database,
  };
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

interface BoundedSqlBody {
  bytes: Uint8Array;
  evidence: Pick<
    SqlRootFailureEvidence,
    "responseBytes" | "responseSha256" | "responseTruncated"
  >;
}

async function readBoundedSqlBody(
  response: Response,
  limit: number,
): Promise<BoundedSqlBody> {
  const declaredText = response.headers.get("content-length");
  const declared = declaredText !== null && /^\d+$/u.test(declaredText)
    ? Number(declaredText)
    : undefined;
  if (declared !== undefined && Number.isSafeInteger(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new SqlRootError({
      category: "response_too_large",
      httpStatus: response.status,
      responseBytes: declared,
      responseTruncated: true,
    });
  }
  if (!response.body) {
    const empty = new Uint8Array();
    return {
      bytes: empty,
      evidence: {
        responseBytes: 0,
        responseSha256: createHash("sha256").update(empty).digest("hex"),
        responseTruncated: false,
      },
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let retained = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = limit - retained;
      if (item.value.byteLength > remaining) {
        if (remaining > 0) {
          const prefix = item.value.subarray(0, remaining);
          chunks.push(prefix);
          hash.update(prefix);
          retained += prefix.byteLength;
        }
        await reader.cancel().catch(() => {});
        throw new SqlRootError({
          category: "response_too_large",
          httpStatus: response.status,
          responseBytes: retained,
          responseSha256: hash.digest("hex"),
          responseTruncated: true,
        });
      }
      chunks.push(item.value);
      hash.update(item.value);
      retained += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    evidence: {
      responseBytes: retained,
      responseSha256: hash.digest("hex"),
      responseTruncated: false,
    },
  };
}

/**
 * Statement уровня сервера (DEFINE/REMOVE NAMESPACE) без выбранного ns/db.
 * The complete request and response-read window is bounded; failures expose
 * only numeric/hash evidence, never credentials, SQL or response content.
 */
export async function sqlRoot(
  cfg: AppConfig,
  statement: string,
  options: SqlRootOptions = {},
): Promise<void> {
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs ?? SQL_ROOT_TIMEOUT_MS,
    5 * 60 * 1_000,
    "sql root timeout",
  );
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes ?? SQL_ROOT_MAX_RESPONSE_BYTES,
    SQL_ROOT_MAX_RESPONSE_BYTES,
    "sql root response limit",
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${httpBaseUrl(cfg)}/sql`, {
      method: "POST",
      headers: {
        Authorization: basicAuth(cfg),
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      body: statement,
      redirect: "error",
      signal: timeoutSignal,
    });
  } catch (error) {
    throw new SqlRootError({
      category: timeoutSignal.aborted ? "timeout" : "transport_error",
    }, error);
  }

  let bounded: BoundedSqlBody;
  try {
    bounded = await readBoundedSqlBody(response, maxResponseBytes);
  } catch (error) {
    if (error instanceof SqlRootError) throw error;
    throw new SqlRootError({
      category: timeoutSignal.aborted ? "timeout" : "transport_error",
      httpStatus: response.status,
    }, error);
  }
  const evidence = { httpStatus: response.status, ...bounded.evidence };
  if (!response.ok) {
    throw new SqlRootError({ category: "http_error", ...evidence });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bounded.bytes));
  } catch (error) {
    throw new SqlRootError({ category: "malformed_response", ...evidence }, error);
  }
  if (!Array.isArray(parsed) || parsed.some((result) =>
    !result || typeof result !== "object" || Array.isArray(result) ||
    (result as { status?: unknown }).status !== "OK"
  )) {
    throw new SqlRootError({ category: "sql_error", ...evidence });
  }
}
