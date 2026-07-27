/**
 * Deferred restore FULLTEXT indexes.
 *
 * SurrealDB exports index DDL before table data. The restore path strips the
 * migration-owned FULLTEXT definitions, imports all rows, then recreates only
 * the core `search_document_content` index with CONCURRENTLY and polls
 * INFO FOR INDEX. Canonical chunks are still restored and count/ownership
 * checked, but the optional forensic `chunk_content` index is deliberately not
 * rebuilt by the core recovery drill. Raw export SQL is validated but never
 * executed: every database statement below is reconstructed from the fixed
 * migration-owned identity whitelist.
 */

import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { httpBaseUrl, httpHeaders } from "./http.ts";
import { assertInternalTableIdentifier } from "./safety.ts";

export const RESTORE_INDEX_BUILD_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
export const RESTORE_INDEX_POLL_INTERVAL_MS = 5_000;
export const RESTORE_INDEX_REQUEST_TIMEOUT_MS = 30_000;
export const RESTORE_INDEX_REMOVAL_TIMEOUT_MS = 5 * 60 * 1_000;
export const RESTORE_INDEX_ABSENCE_STABILIZATION_MS = 30_000;
export const RESTORE_INDEX_REMOVAL_POLL_INTERVAL_MS = 5_000;
const RESTORE_TEST_NAMESPACE_PATTERN = /^baka_restore_test_[0-9a-f]{32}$/u;
const MAX_INDEX_SQL_RESPONSE_BYTES = 1024 * 1024;

/**
 * Destructive restore-index helpers are exported for orchestration seams, so
 * they must enforce the generated drill namespace independently of callers.
 */
export function assertRestoreIndexNamespace(namespace: string): string {
  // JavaScript `$` also matches immediately before a final newline. Comparing
  // the full match closes that edge while retaining the documented pattern.
  if (namespace.match(RESTORE_TEST_NAMESPACE_PATTERN)?.[0] !== namespace) {
    throw new Error(
      "restore index operation requires an exact generated restore namespace",
    );
  }
  return namespace;
}

/** Exact core-search index built and accepted by the restore drill. */
export const RESTORE_FULLTEXT_INDEX_DEFINITIONS = [
  {
    ordinal: 1,
    name: "search_document_content",
    table: "search_document",
    field: "content",
    analyzer: "archive_mixed",
  },
] as const;

export type RestoreFulltextIndexDefinition =
  (typeof RESTORE_FULLTEXT_INDEX_DEFINITIONS)[number];

export type RestoreIndexBuildState = "scheduled" | "building" | "ready" | "failed";

export type RestoreIndexBuildCategory =
  | "define_accepted"
  | "progress"
  | "ready"
  | "cancelled"
  | "ddl_validation"
  | "define_rejected"
  | "define_request"
  | "inspect_request"
  | "malformed_response"
  | "malformed_info"
  | "memory_pressure"
  | "missing_index"
  | "unexpected_identity"
  | "asynchronous_failure"
  | "non_ready_terminal"
  | "timeout";

export type RestoreIndexInfoEnvelope = "table_info" | "index_info";

/**
 * Safe to persist. It deliberately contains no SQL, response body, error
 * detail, credentials, paths, or indexed content.
 */
export interface RestoreIndexBuildDiagnostic {
  readonly name: string;
  readonly table: string;
  readonly ordinal: number;
  readonly state: RestoreIndexBuildState;
  readonly category: RestoreIndexBuildCategory;
  /** Present only for a failed outer INFO envelope; never contains server text. */
  readonly envelope?: RestoreIndexInfoEnvelope;
  readonly status?: string;
  readonly initial?: number;
  readonly pending?: number;
  readonly updated?: number;
  readonly polls: number;
  readonly elapsedMs: number;
  readonly indexElapsedMs: number;
  readonly httpStatus?: number;
  readonly responseBytes?: number;
  readonly responseSha256?: string;
  readonly responseTruncated?: boolean;
}

type DiagnosticAdditions = Partial<Omit<
  RestoreIndexBuildDiagnostic,
  "name" | "table" | "ordinal" | "state" | "category" | "polls" | "elapsedMs" |
    "indexElapsedMs"
>>;

/** Safe outer error; `cause` is process-local and must never be serialized. */
export class RestoreIndexBuildError extends Error {
  constructor(
    readonly diagnostics: readonly RestoreIndexBuildDiagnostic[],
    cause?: unknown,
    /** Allowlisted indexes whose DEFINE may have started but never reached ready. */
    readonly startedIndexes: readonly RestoreFulltextIndexDefinition[] = [],
  ) {
    const failed = diagnostics.at(-1);
    super(
      failed
        ? `restore index ${failed.ordinal} failed: ${failed.category}/${failed.state}`
        : "restore index build failed without diagnostics",
      { cause },
    );
    this.name = "RestoreIndexBuildError";
  }
}

export interface RestoreIndexCommand {
  readonly kind: "define" | "inspect" | "remove" | "inspect_absence";
  readonly ordinal: number;
  readonly name: string;
  readonly table: string;
  /** Per-request bound, already capped by the remaining overall deadline. */
  readonly timeoutMs: number;
}

export interface RestoreIndexCommandResult {
  /** Parsed /sql JSON. Callers must never persist or log this value. */
  readonly body: unknown;
  readonly httpStatus?: number;
  readonly responseBytes?: number;
  readonly responseSha256?: string;
  readonly responseTruncated?: boolean;
}

export interface RestoreIndexBuildOptions {
  /** One deadline shared by all indexes, not a fresh timeout per index. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  /** Cooperative caller cancellation; cleanup deliberately uses its own deadline. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Deterministic test seam; production always uses the global fetch. */
  readonly fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Test seam carries only a validated command identity, never arbitrary SQL. */
  readonly executeCommand?: (
    command: RestoreIndexCommand,
  ) => Promise<RestoreIndexCommandResult>;
  readonly onProgress?: (diagnostic: RestoreIndexBuildDiagnostic) => void;
}

interface ParsedIndexDefinition {
  name: string;
  table: string;
  field: string;
  analyzer: string;
  concurrently: boolean;
}

interface ResponseEvidence {
  httpStatus?: number;
  responseBytes?: number;
  responseSha256?: string;
  responseTruncated?: boolean;
}

class IndexCommandError extends Error {
  constructor(
    readonly category: "request" | "malformed_response",
    readonly evidence: ResponseEvidence,
  ) {
    super(`restore index command failed: ${category}`);
    this.name = "IndexCommandError";
  }
}

class IndexInfoError extends Error {
  constructor(
    readonly category: Exclude<
      RestoreIndexBuildCategory,
      "define_accepted" | "progress" | "ready" | "define_request" | "inspect_request" |
        "timeout"
    >,
    readonly status?: string,
    readonly counts: Pick<RestoreIndexBuildDiagnostic, "initial" | "pending" | "updated"> = {},
    readonly envelope?: RestoreIndexInfoEnvelope,
  ) {
    super(`restore index info failed: ${category}`);
    this.name = "IndexInfoError";
  }
}

/** Exact public SurrealDB 3.2.3 error display; no fuzzy/private text matching. */
const MEMORY_THRESHOLD_ERROR_RESULT =
  "The query was not executed due to the memory threshold being reached";

function outerInfoError(
  envelope: Record<string, unknown>,
  scope: RestoreIndexInfoEnvelope,
): IndexInfoError {
  const category = envelope.status === "ERR" &&
      envelope.result === MEMORY_THRESHOLD_ERROR_RESULT
    ? "memory_pressure"
    : "malformed_info";
  return new IndexInfoError(
    category,
    sanitizedStatus(envelope.status),
    {},
    scope,
  );
}

function finitePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeElapsed(now: number, startedAt: number): number {
  if (!Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor(now - startedAt));
}

function sanitizedStatus(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/iu.test(value)
    ? value.toLowerCase()
    : undefined;
}

function responseEvidence(result: RestoreIndexCommandResult): ResponseEvidence {
  let responseBytes = result.responseBytes;
  let responseSha256 = result.responseSha256;
  let responseTruncated = result.responseTruncated;
  if (
    !Number.isSafeInteger(responseBytes) || responseBytes === undefined || responseBytes < 0 ||
    typeof responseSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(responseSha256)
  ) {
    try {
      const serialized = JSON.stringify(result.body);
      if (serialized !== undefined) {
        responseBytes = Buffer.byteLength(serialized);
        responseSha256 = createHash("sha256").update(serialized).digest("hex");
        responseTruncated = false;
      }
    } catch {
      responseBytes = undefined;
      responseSha256 = undefined;
    }
  }
  return {
    ...(Number.isSafeInteger(result.httpStatus) ? { httpStatus: result.httpStatus } : {}),
    ...(Number.isSafeInteger(responseBytes) && responseBytes !== undefined && responseBytes >= 0
      ? { responseBytes }
      : {}),
    ...(typeof responseSha256 === "string" && /^[0-9a-f]{64}$/u.test(responseSha256)
      ? { responseSha256 }
      : {}),
    ...(typeof responseTruncated === "boolean" ? { responseTruncated } : {}),
  };
}

function parseIndexDefinition(
  statement: string,
  allowConcurrent: boolean,
  requireTerminator = true,
): ParsedIndexDefinition | undefined {
  // Migration/export forms accepted here are semantically exact: the export
  // may spell ON TABLE as ON and may expand default BM25 parameters. Quotes,
  // comments, multiple fields, extra clauses and extra statements all fail.
  if (requireTerminator && !/;\s*$/u.test(statement)) return undefined;
  const match = /^\s*DEFINE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_][a-z0-9_]*)\s+ON(?:\s+TABLE)?\s+([a-z_][a-z0-9_]*)\s+(?:FIELDS|COLUMNS)\s+([a-z_][a-z0-9_]*)\s+FULLTEXT\s+ANALYZER\s+([a-z_][a-z0-9_]*)\s+BM25(?:\s*\(\s*1\.2(?:0*)?\s*,\s*0\.75(?:0*)?\s*\))?\s+HIGHLIGHTS(\s+CONCURRENTLY)?\s*;?\s*$/iu.exec(
    statement,
  );
  if (!match) return undefined;
  const concurrently = match[5] !== undefined;
  if (concurrently && !allowConcurrent) return undefined;
  return {
    name: match[1]!.toLowerCase(),
    table: match[2]!.toLowerCase(),
    field: match[3]!.toLowerCase(),
    analyzer: match[4]!.toLowerCase(),
    concurrently,
  };
}

function definitionMatches(
  parsed: ParsedIndexDefinition | undefined,
  expected: RestoreFulltextIndexDefinition,
): boolean {
  return parsed?.name === expected.name && parsed.table === expected.table &&
    parsed.field === expected.field && parsed.analyzer === expected.analyzer;
}

function diagnostic(
  index: RestoreFulltextIndexDefinition,
  overallStartedAt: number,
  indexStartedAt: number,
  now: number,
  polls: number,
  state: RestoreIndexBuildState,
  category: RestoreIndexBuildCategory,
  additions: DiagnosticAdditions = {},
): RestoreIndexBuildDiagnostic {
  return Object.freeze({
    name: index.name,
    table: index.table,
    ordinal: index.ordinal,
    state,
    category,
    polls,
    elapsedMs: safeElapsed(now, overallStartedAt),
    indexElapsedMs: safeElapsed(now, indexStartedAt),
    ...additions,
  });
}

function ddlValidationError(
  expected: RestoreFulltextIndexDefinition,
): RestoreIndexBuildError {
  const failed = diagnostic(
    expected,
    0,
    0,
    0,
    0,
    "failed",
    "ddl_validation",
  );
  return new RestoreIndexBuildError([failed]);
}

/**
 * Rejects any deferred SQL except the exact core search definition. The
 * returned value is a whitelist object, not caller-controlled SQL.
 */
export function validateDeferredFulltextIndexes(
  statements: readonly string[],
): readonly RestoreFulltextIndexDefinition[] {
  if (statements.length !== RESTORE_FULLTEXT_INDEX_DEFINITIONS.length) {
    throw ddlValidationError(RESTORE_FULLTEXT_INDEX_DEFINITIONS.at(-1)!);
  }
  const seen = new Set<string>();
  for (const statement of statements) {
    const parsed = parseIndexDefinition(statement, false);
    const expected = RESTORE_FULLTEXT_INDEX_DEFINITIONS.find(
      (candidate) => definitionMatches(parsed, candidate),
    );
    const firstMissing = RESTORE_FULLTEXT_INDEX_DEFINITIONS.find(
      (candidate) => !seen.has(candidate.name),
    ) ?? RESTORE_FULLTEXT_INDEX_DEFINITIONS[0];
    if (!expected || seen.has(expected.name)) throw ddlValidationError(firstMissing);
    seen.add(expected.name);
  }
  return RESTORE_FULLTEXT_INDEX_DEFINITIONS;
}

function canonicalConcurrentDefinition(index: RestoreFulltextIndexDefinition): string {
  return `DEFINE INDEX ${index.name} ON TABLE ${index.table} FIELDS ${index.field} ` +
    `FULLTEXT ANALYZER ${index.analyzer} BM25 HIGHLIGHTS CONCURRENTLY;`;
}

function canonicalInspect(index: RestoreFulltextIndexDefinition): string {
  return `INFO FOR TABLE ${index.table};\nINFO FOR INDEX ${index.name} ON TABLE ${index.table};`;
}

function canonicalRemove(index: RestoreFulltextIndexDefinition): string {
  return `REMOVE INDEX IF EXISTS ${index.name} ON TABLE ${index.table};`;
}

function canonicalInspectAbsence(index: RestoreFulltextIndexDefinition): string {
  return `INFO FOR TABLE ${index.table};`;
}

interface BoundedIndexResponseBody {
  readonly bytes: Uint8Array;
  readonly evidence: Required<Pick<
    ResponseEvidence,
    "responseBytes" | "responseSha256" | "responseTruncated"
  >>;
}

function declaredResponseBytes(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedIndexResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<BoundedIndexResponseBody> {
  const declaredBytes = declaredResponseBytes(response);
  if (declaredBytes !== undefined && declaredBytes > MAX_INDEX_SQL_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new IndexCommandError("malformed_response", {
      httpStatus: response.status,
      responseBytes: declaredBytes,
      responseTruncated: true,
    });
  }

  if (!response.body) {
    const bytes = new Uint8Array();
    return {
      bytes,
      evidence: {
        responseBytes: 0,
        responseSha256: createHash("sha256").update(bytes).digest("hex"),
        responseTruncated: false,
      },
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let retainedBytes = 0;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    // Never forward AbortSignal.reason: callers may put private text there.
    void reader.cancel().catch(() => {});
    rejectAbort(new Error("restore index response read aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    for (;;) {
      const item = await Promise.race([reader.read(), aborted]);
      // cancel() may resolve a pending read as `{ done: true }` before the
      // abort promise wins the race. Never parse that partial prefix as a
      // complete response.
      if (signal.aborted) throw new Error("restore index response read aborted");
      if (item.done) break;
      const remaining = MAX_INDEX_SQL_RESPONSE_BYTES - retainedBytes;
      if (item.value.byteLength > remaining) {
        if (remaining > 0) {
          const prefix = item.value.subarray(0, remaining);
          chunks.push(prefix);
          hash.update(prefix);
          retainedBytes += prefix.byteLength;
        }
        void reader.cancel().catch(() => {});
        throw new IndexCommandError("malformed_response", {
          httpStatus: response.status,
          responseBytes: retainedBytes,
          responseSha256: hash.digest("hex"),
          responseTruncated: true,
        });
      }
      chunks.push(item.value);
      hash.update(item.value);
      retainedBytes += item.value.byteLength;
    }
  } catch (error) {
    if (error instanceof IndexCommandError) throw error;
    // A partial transport failure retains only a hash/count of the bounded
    // prefix. The transport error itself may echo server-private content.
    throw new IndexCommandError("request", {
      httpStatus: response.status,
      responseBytes: retainedBytes,
      responseSha256: hash.copy().digest("hex"),
      responseTruncated: true,
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A deliberately uncooperative stream may still have a pending read
      // after cancellation. It must not delay the caller's deadline.
    }
  }

  const bytes = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    evidence: {
      responseBytes: retainedBytes,
      responseSha256: hash.digest("hex"),
      responseTruncated: false,
    },
  };
}

async function executeHttpIndexCommand(
  cfg: AppConfig,
  namespace: string,
  database: string,
  command: RestoreIndexCommand,
  callerSignal?: AbortSignal,
  fetchImpl: NonNullable<RestoreIndexBuildOptions["fetchImpl"]> = fetch,
): Promise<RestoreIndexCommandResult> {
  const expected = RESTORE_FULLTEXT_INDEX_DEFINITIONS[command.ordinal - 1];
  if (!expected || expected.name !== command.name || expected.table !== command.table) {
    throw new IndexCommandError("malformed_response", {});
  }
  const statement = command.kind === "define"
    ? canonicalConcurrentDefinition(expected)
    : command.kind === "inspect"
    ? canonicalInspect(expected)
    : command.kind === "remove"
    ? canonicalRemove(expected)
    : canonicalInspectAbsence(expected);

  const requestSignal = AbortSignal.timeout(command.timeoutMs);
  const responseSignal = callerSignal
    ? AbortSignal.any([callerSignal, requestSignal])
    : requestSignal;
  let response: Response;
  try {
    response = await fetchImpl(`${httpBaseUrl(cfg)}/sql`, {
      method: "POST",
      headers: {
        ...httpHeaders(cfg, namespace, database),
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      body: statement,
      signal: responseSignal,
    });
  } catch {
    // Fetch failures and AbortSignal reasons may contain private server or
    // operator text; the stable category is the only retained detail.
    throw new IndexCommandError("request", {});
  }

  const bounded = await readBoundedIndexResponseBody(response, responseSignal);
  const responseText = new TextDecoder().decode(bounded.bytes);
  const evidence: ResponseEvidence = {
    httpStatus: response.status,
    ...bounded.evidence,
  };
  if (!response.ok) throw new IndexCommandError("request", evidence);

  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    // JSON parser errors may quote private response fragments.
    throw new IndexCommandError("malformed_response", evidence);
  }
  return { body, ...evidence };
}

function sqlEnvelopes(body: unknown, expected: number): Array<Record<string, unknown>> {
  if (!Array.isArray(body) || body.length !== expected) {
    throw new IndexInfoError("malformed_response");
  }
  const envelopes: Array<Record<string, unknown>> = [];
  for (const value of body) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new IndexInfoError("malformed_response");
    }
    envelopes.push(value as Record<string, unknown>);
  }
  return envelopes;
}

function assertDefineAccepted(body: unknown): void {
  const [result] = sqlEnvelopes(body, 1);
  if (result!.status !== "OK") {
    throw new IndexInfoError("define_rejected", sanitizedStatus(result!.status));
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function indexSqlFromTableInfo(
  tableInfo: unknown,
  index: RestoreFulltextIndexDefinition,
): string {
  const indexes = objectValue(objectValue(tableInfo)?.indexes);
  if (!indexes || !Object.hasOwn(indexes, index.name)) {
    throw new IndexInfoError("missing_index");
  }
  const entry = indexes[index.name];
  const statement = typeof entry === "string"
    ? entry
    : objectValue(entry)?.sql;
  if (typeof statement !== "string") throw new IndexInfoError("malformed_info");
  if (!definitionMatches(parseIndexDefinition(statement, true, false), index)) {
    throw new IndexInfoError("unexpected_identity");
  }
  return statement;
}

function progressCounts(
  building: Record<string, unknown>,
): Pick<RestoreIndexBuildDiagnostic, "initial" | "pending" | "updated"> {
  const counts: { initial?: number; pending?: number; updated?: number } = {};
  for (const field of ["initial", "pending", "updated"] as const) {
    if (!Object.hasOwn(building, field)) continue;
    const value = building[field];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new IndexInfoError("malformed_info");
    }
    counts[field] = value as number;
  }
  return counts;
}

function inspectProgress(
  body: unknown,
  index: RestoreFulltextIndexDefinition,
): { status: "started" | "cleaning" | "indexing" | "ready"; counts: Pick<
  RestoreIndexBuildDiagnostic,
  "initial" | "pending" | "updated"
> } {
  const [tableEnvelope, indexEnvelope] = sqlEnvelopes(body, 2);
  if (tableEnvelope!.status !== "OK") {
    throw outerInfoError(tableEnvelope!, "table_info");
  }
  // INFO FOR INDEX on a missing index is an outer ERR in pinned 3.2.3.
  // Check INFO FOR TABLE first so absence is classified without inspecting or
  // persisting the private server detail.
  indexSqlFromTableInfo(tableEnvelope!.result, index);
  if (indexEnvelope!.status !== "OK") {
    throw outerInfoError(indexEnvelope!, "index_info");
  }

  const building = objectValue(objectValue(indexEnvelope!.result)?.building);
  if (!building) throw new IndexInfoError("malformed_info");
  const status = sanitizedStatus(building.status);
  const counts = progressCounts(building);
  if (status === "error" || status === "aborted") {
    throw new IndexInfoError("asynchronous_failure", status, counts);
  }
  if (
    status === "ready" || status === "indexing" || status === "cleaning" ||
    status === "started"
  ) {
    return { status, counts };
  }
  if (status) throw new IndexInfoError("non_ready_terminal", status, counts);
  throw new IndexInfoError("malformed_info", undefined, counts);
}

function errorEvidence(error: unknown): ResponseEvidence {
  return error instanceof IndexCommandError ? error.evidence : {};
}

function commandFailureCategory(
  command: RestoreIndexCommand["kind"],
  error: unknown,
): RestoreIndexBuildCategory {
  if (error instanceof IndexCommandError && error.category === "malformed_response") {
    return "malformed_response";
  }
  return command === "inspect" ? "inspect_request" : "define_request";
}

export interface RestoreIndexRemovalOptions {
  /** One deadline shared by the reverse-order cleanup of all started indexes. */
  readonly timeoutMs?: number;
  /** Required continuous absence before cleanup may report success. */
  readonly stabilizationMs?: number;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly executeCommand?: (
    command: RestoreIndexCommand,
  ) => Promise<RestoreIndexCommandResult>;
}

function inspectIndexAbsent(
  body: unknown,
  index: RestoreFulltextIndexDefinition,
): boolean {
  const [tableEnvelope] = sqlEnvelopes(body, 1);
  if (tableEnvelope!.status !== "OK") {
    throw new IndexInfoError("malformed_info", sanitizedStatus(tableEnvelope!.status));
  }
  const tableInfo = objectValue(tableEnvelope!.result);
  const indexes = objectValue(tableInfo?.indexes);
  if (!indexes) throw new IndexInfoError("malformed_info");
  return !Object.hasOwn(indexes, index.name);
}

function exactWhitelistedIndex(
  candidate: Pick<RestoreFulltextIndexDefinition, "ordinal" | "name" | "table">,
): RestoreFulltextIndexDefinition {
  const expected = RESTORE_FULLTEXT_INDEX_DEFINITIONS[candidate.ordinal - 1];
  if (!expected || expected.name !== candidate.name || expected.table !== candidate.table) {
    throw new RestoreIndexBuildError([
      diagnostic(
        RESTORE_FULLTEXT_INDEX_DEFINITIONS[0],
        0,
        0,
        0,
        0,
        "failed",
        "ddl_validation",
      ),
    ]);
  }
  return expected;
}

/**
 * Cancels allowlisted non-ready builders before namespace removal. All
 * targets are attempted in reverse start order; response/error text is never
 * included in the thrown error.
 */
export async function removeStartedFulltextIndexes(
  cfg: AppConfig,
  namespaceInput: string,
  databaseInput: string,
  targets: readonly Pick<RestoreFulltextIndexDefinition, "ordinal" | "name" | "table">[],
  options: RestoreIndexRemovalOptions = {},
): Promise<void> {
  const namespace = assertRestoreIndexNamespace(namespaceInput);
  const database = assertInternalTableIdentifier(databaseInput, "restore database");
  const timeoutMs = finitePositiveInteger(
    options.timeoutMs ?? RESTORE_INDEX_REMOVAL_TIMEOUT_MS,
    "restore index removal timeout",
  );
  const stabilizationMs = finitePositiveInteger(
    options.stabilizationMs ?? RESTORE_INDEX_ABSENCE_STABILIZATION_MS,
    "restore index absence stabilization window",
  );
  const pollIntervalMs = finitePositiveInteger(
    options.pollIntervalMs ?? RESTORE_INDEX_REMOVAL_POLL_INTERVAL_MS,
    "restore index removal poll interval",
  );
  const requestTimeoutMs = finitePositiveInteger(
    options.requestTimeoutMs ?? RESTORE_INDEX_REQUEST_TIMEOUT_MS,
    "restore index removal request timeout",
  );
  const indexes = targets.map(exactWhitelistedIndex);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const executeCommand = options.executeCommand ?? ((command: RestoreIndexCommand) =>
    executeHttpIndexCommand(cfg, namespace, database, command));
  const deadline = now() + timeoutMs;
  const remainingRequestTimeout = (): number =>
    Math.max(1, Math.min(requestTimeoutMs, Math.floor(deadline - now())));
  const failures: unknown[] = [];
  for (const index of [...indexes].reverse()) {
    try {
      let removeRequired = true;
      let absentSince: number | undefined;
      while (true) {
        if (now() >= deadline) throw new Error("restore index cleanup deadline exceeded");
        if (removeRequired) {
          const result = await executeCommand({
            kind: "remove",
            ordinal: index.ordinal,
            name: index.name,
            table: index.table,
            timeoutMs: remainingRequestTimeout(),
          });
          assertDefineAccepted(result.body);
        }

        if (now() >= deadline) throw new Error("restore index cleanup deadline exceeded");
        const inspection = await executeCommand({
          kind: "inspect_absence",
          ordinal: index.ordinal,
          name: index.name,
          table: index.table,
          timeoutMs: remainingRequestTimeout(),
        });
        const observedAt = now();
        if (inspectIndexAbsent(inspection.body, index)) {
          absentSince ??= observedAt;
          removeRequired = false;
          if (observedAt - absentSince >= stabilizationMs) break;
        } else {
          absentSince = undefined;
          removeRequired = true;
        }

        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw new Error("restore index cleanup deadline exceeded");
        const stabilizationRemaining = absentSince === undefined
          ? pollIntervalMs
          : stabilizationMs - safeElapsed(now(), absentSince);
        await sleep(Math.min(pollIntervalMs, stabilizationRemaining, remainingMs));
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(`restore index cleanup failed for ${failures.length} allowlisted index(es)`, {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
    });
  }
}

/**
 * Builds the validated FULLTEXT indexes one at a time under one overall
 * deadline. DEFINE requests are individually bounded and return after
 * scheduling; every index must subsequently reach INFO status `ready`.
 */
export async function buildDeferredFulltextIndexes(
  cfg: AppConfig,
  namespaceInput: string,
  databaseInput: string,
  statements: readonly string[],
  options: RestoreIndexBuildOptions = {},
): Promise<readonly RestoreIndexBuildDiagnostic[]> {
  const namespace = assertRestoreIndexNamespace(namespaceInput);
  const database = assertInternalTableIdentifier(databaseInput, "restore database");
  const indexes = validateDeferredFulltextIndexes(statements);
  const timeoutMs = finitePositiveInteger(
    options.timeoutMs ?? RESTORE_INDEX_BUILD_TIMEOUT_MS,
    "restore index timeout",
  );
  const pollIntervalMs = finitePositiveInteger(
    options.pollIntervalMs ?? RESTORE_INDEX_POLL_INTERVAL_MS,
    "restore index poll interval",
  );
  const requestTimeoutMs = finitePositiveInteger(
    options.requestTimeoutMs ?? RESTORE_INDEX_REQUEST_TIMEOUT_MS,
    "restore index request timeout",
  );
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const executeCommand = options.executeCommand ?? ((command: RestoreIndexCommand) =>
    executeHttpIndexCommand(cfg, namespace, database, command, signal, options.fetchImpl));
  const overallStartedAt = now();
  const deadline = overallStartedAt + timeoutMs;
  const completed: RestoreIndexBuildDiagnostic[] = [];
  const startedNotReady: RestoreFulltextIndexDefinition[] = [];

  const remainingRequestTimeout = (): number =>
    Math.max(1, Math.min(requestTimeoutMs, Math.floor(deadline - now())));
  const fail = (
    index: RestoreFulltextIndexDefinition,
    indexStartedAt: number,
    polls: number,
    category: RestoreIndexBuildCategory,
    additions: DiagnosticAdditions = {},
    cause?: unknown,
  ): never => {
    const failed = diagnostic(
      index,
      overallStartedAt,
      indexStartedAt,
      now(),
      polls,
      "failed",
      category,
      additions,
    );
    throw new RestoreIndexBuildError([...completed, failed], cause, [...startedNotReady]);
  };

  const failIfCancelled = (
    index: RestoreFulltextIndexDefinition,
    indexStartedAt: number,
    polls: number,
    cause?: unknown,
  ): void => {
    if (signal?.aborted) {
      fail(index, indexStartedAt, polls, "cancelled", {}, cause);
    }
  };

  const sleepWhileActive = async (
    milliseconds: number,
    index: RestoreFulltextIndexDefinition,
    indexStartedAt: number,
    polls: number,
  ): Promise<void> => {
    failIfCancelled(index, indexStartedAt, polls);
    if (!signal) {
      await sleep(milliseconds);
      return;
    }
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("restore index build cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(milliseconds), cancelled]);
    } catch (error) {
      failIfCancelled(index, indexStartedAt, polls, error);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    failIfCancelled(index, indexStartedAt, polls);
  };

  for (const index of indexes) {
    const indexStartedAt = now();
    failIfCancelled(index, indexStartedAt, 0);
    if (indexStartedAt >= deadline) fail(index, indexStartedAt, 0, "timeout");

    const defineCommand: RestoreIndexCommand = {
      kind: "define",
      ordinal: index.ordinal,
      name: index.name,
      table: index.table,
      timeoutMs: remainingRequestTimeout(),
    };
    // The request can reach SurrealDB even if the client loses its response,
    // so cleanup owns this identity from immediately before dispatch.
    startedNotReady.push(index);
    let defineResult!: RestoreIndexCommandResult;
    try {
      defineResult = await executeCommand(defineCommand);
      failIfCancelled(index, indexStartedAt, 0);
      assertDefineAccepted(defineResult.body);
    } catch (error) {
      failIfCancelled(index, indexStartedAt, 0, error);
      if (error instanceof IndexInfoError) {
        fail(index, indexStartedAt, 0, error.category, { status: error.status }, error);
      }
      fail(
        index,
        indexStartedAt,
        0,
        commandFailureCategory("define", error),
        errorEvidence(error),
        error,
      );
    }
    options.onProgress?.(diagnostic(
      index,
      overallStartedAt,
      indexStartedAt,
      now(),
      0,
      "scheduled",
      "define_accepted",
      { status: "ok", ...responseEvidence(defineResult) },
    ));

    let polls = 0;
    while (true) {
      failIfCancelled(index, indexStartedAt, polls);
      if (now() >= deadline) fail(index, indexStartedAt, polls, "timeout");
      const inspectCommand: RestoreIndexCommand = {
        kind: "inspect",
        ordinal: index.ordinal,
        name: index.name,
        table: index.table,
        timeoutMs: remainingRequestTimeout(),
      };
      let inspectResult!: RestoreIndexCommandResult;
      polls += 1;
      try {
        inspectResult = await executeCommand(inspectCommand);
        failIfCancelled(index, indexStartedAt, polls);
      } catch (error) {
        failIfCancelled(index, indexStartedAt, polls, error);
        fail(
          index,
          indexStartedAt,
          polls,
          commandFailureCategory("inspect", error),
          errorEvidence(error),
          error,
        );
      }
      const evidence = responseEvidence(inspectResult);
      let progress!: ReturnType<typeof inspectProgress>;
      try {
        progress = inspectProgress(inspectResult.body, index);
      } catch (error) {
        if (error instanceof IndexInfoError) {
          fail(index, indexStartedAt, polls, error.category, {
            ...(error.envelope ? { envelope: error.envelope } : {}),
            status: error.status,
            ...error.counts,
            ...evidence,
          }, error);
        }
        fail(index, indexStartedAt, polls, "malformed_info", evidence, error);
      }
      if (progress.status === "ready") {
        const ready = diagnostic(
          index,
          overallStartedAt,
          indexStartedAt,
          now(),
          polls,
          "ready",
          "ready",
          { status: progress.status, ...progress.counts, ...evidence },
        );
        completed.push(ready);
        startedNotReady.pop();
        options.onProgress?.(ready);
        break;
      }

      options.onProgress?.(diagnostic(
        index,
        overallStartedAt,
        indexStartedAt,
        now(),
        polls,
        "building",
        "progress",
        { status: progress.status, ...progress.counts, ...evidence },
      ));
      const remainingMs = deadline - now();
      if (remainingMs <= 0) fail(index, indexStartedAt, polls, "timeout");
      await sleepWhileActive(
        Math.min(pollIntervalMs, remainingMs),
        index,
        indexStartedAt,
        polls,
      );
    }
  }

  return completed;
}
