/**
 * Privacy-safe structured logging primitives (docs/plan.md §22).
 *
 * The logger accepts metadata, not corpus content. Fields are retained only
 * through an explicit allowlist of identifiers, enums, booleans and counters;
 * arbitrary text (including Error.message) is rejected recursively.
 */

import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type StructuredLogValue =
  | string
  | number
  | boolean
  | null
  | StructuredLogValue[]
  | { [key: string]: StructuredLogValue };
export type StructuredLogFields = Record<string, unknown>;

export interface StructuredLogEvent {
  level: LogLevel;
  event: string;
  timestamp: string;
  runId: string;
  [key: string]: StructuredLogValue;
}

const OMIT = Symbol("omit-log-field");
const MAX_SAFE_STRING_BYTES = 256;
const MAX_ARRAY_ITEMS = 100;
const MAX_DEPTH = 6;

const RESERVED_FIELDS = new Set(["level", "event", "timestamp", "run_id", "runid"]);
const REJECTED_FIELDS = new Set([
  "error",
  "message",
  "detail",
  "text",
  "prompt",
  "full_prompt",
  "assistant_response",
  "response",
  "tool_result",
  "raw_payload",
  "payload",
  "content",
  "input",
  "output",
  "body",
  "request_body",
  "response_body",
  "api_key",
  "openai_api_key",
  "db_password",
  "password",
  "secret",
  "authorization",
  "cookie",
  "headers",
  "path",
  "relative_path",
  "original_path",
  "raw_archive_path",
  "output_path",
  "report_path",
  "export_file",
  "bundle_path",
]);

const SAFE_STRING_FIELDS = new Set([
  "action",
  "check",
  "code",
  "error_code",
  "harness",
  "kind",
  "mode",
  "model",
  "operation",
  "output_mode",
  "parser",
  "parser_name",
  "parser_version",
  "provider",
  "reason_code",
  "selector",
  "slug",
  "space",
  "stage",
  "status",
  "vector_type",
  "distance",
]);

const SAFE_STRING_ARRAY_FIELDS = new Set([
  "harnesses",
  "modes",
  "scenarios",
  "spaces",
]);

const SAFE_NUMBER_FIELDS = new Set([
  "actions",
  "affected",
  "attempts",
  "batches",
  "bytes",
  "checked_bytes",
  "checked_files",
  "chunks",
  "completed",
  "dialogues",
  "documents",
  "duration_ms",
  "errors",
  "failed",
  "files",
  "findings",
  "judgments",
  "manual",
  "max_jobs",
  "messages",
  "permanent_errors",
  "privacy_excluded",
  "prompt_tokens",
  "released_stale",
  "revisions",
  "scenarios",
  "search_documents",
  "skipped",
  "total_tokens",
  "units",
]);

const SAFE_BOOLEAN_FIELDS = new Set([
  "active",
  "allow_external_provider_calls",
  "dry_run",
  "enqueue_embeddings",
  "force",
  "ok",
  "verify_raw",
]);

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /:\/\/[^\s/@:]+:[^\s/@]+@/g,
];

function canonicalFieldName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

function rejectedField(name: string): boolean {
  const canonical = canonicalFieldName(name);
  return RESERVED_FIELDS.has(canonical) || REJECTED_FIELDS.has(canonical);
}

function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function safeIdentifierField(name: string): boolean {
  const canonical = canonicalFieldName(name);
  return canonical === "id" || canonical.endsWith("_id") || canonical.endsWith("_ids");
}

function safeHashField(name: string): boolean {
  const canonical = canonicalFieldName(name);
  return canonical === "sha256" || canonical.endsWith("_sha256") || canonical.endsWith("_hash");
}

function safeNumberField(name: string): boolean {
  const canonical = canonicalFieldName(name);
  return SAFE_NUMBER_FIELDS.has(canonical) ||
    /(?:_count|_bytes|_ms|_tokens|_revisions|_documents|_jobs|_errors|_failed|_completed|_skipped|_written|_seen|_new|_changed|_missing|_total)$/.test(canonical);
}

function safeBooleanField(name: string): boolean {
  const canonical = canonicalFieldName(name);
  return SAFE_BOOLEAN_FIELDS.has(canonical) || canonical.startsWith("is_") || canonical.startsWith("has_");
}

function safeStringField(name: string): boolean {
  const canonical = canonicalFieldName(name);
  return SAFE_STRING_FIELDS.has(canonical) || safeIdentifierField(canonical) || safeHashField(canonical);
}

function sanitizeSafeString(fieldName: string, value: string): string | typeof OMIT {
  if (Buffer.byteLength(value, "utf8") > MAX_SAFE_STRING_BYTES) return OMIT;
  const redacted = redactSecrets(value);
  if (redacted !== value) return OMIT;
  // Safe textual metadata is identifier/enum shaped, never prose.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,255}$/.test(value)) return OMIT;
  return safeStringField(fieldName) || SAFE_STRING_ARRAY_FIELDS.has(canonicalFieldName(fieldName))
    ? value
    : OMIT;
}

function sanitizeValue(
  fieldName: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): StructuredLogValue | typeof OMIT {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return OMIT;
  if (rejectedField(fieldName)) return OMIT;
  if (value === null) return OMIT;
  if (typeof value === "boolean") return safeBooleanField(fieldName) ? value : OMIT;
  if (typeof value === "number") {
    return safeNumberField(fieldName) && Number.isFinite(value) ? value : OMIT;
  }
  if (typeof value === "bigint") {
    return safeNumberField(fieldName) ? value.toString() : OMIT;
  }
  if (typeof value === "string") {
    return safeStringField(fieldName) ? sanitizeSafeString(fieldName, value) : OMIT;
  }
  if (value instanceof Date) {
    const canonical = canonicalFieldName(fieldName);
    return canonical.endsWith("_at") && Number.isFinite(value.getTime())
      ? value.toISOString()
      : OMIT;
  }
  // Error.name/message/stack are arbitrary text and never log metadata.
  if (value instanceof Error) return OMIT;
  if (depth >= MAX_DEPTH || typeof value !== "object" || seen.has(value)) return OMIT;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const canonical = canonicalFieldName(fieldName);
      if (!SAFE_STRING_ARRAY_FIELDS.has(canonical) && !safeIdentifierField(canonical)) return OMIT;
      const result: StructuredLogValue[] = [];
      for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
        if (typeof item !== "string") continue;
        const safe = sanitizeSafeString(fieldName, item);
        if (safe !== OMIT) result.push(safe);
      }
      return result;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return OMIT;
    const result: Record<string, StructuredLogValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (rejectedField(key)) continue;
      const safe = sanitizeValue(key, nested, depth + 1, seen);
      if (safe !== OMIT) result[key] = safe;
    }
    return Object.keys(result).length > 0 ? result : OMIT;
  } finally {
    seen.delete(value);
  }
}

/** Retains only explicitly safe fields; arbitrary text is rejected recursively. */
export function sanitizeLogFields(fields: StructuredLogFields): Record<string, StructuredLogValue> {
  const result: Record<string, StructuredLogValue> = {};
  const seen = new WeakSet<object>();
  for (const [key, value] of Object.entries(fields)) {
    if (rejectedField(key)) continue;
    const safe = sanitizeValue(key, value, 0, seen);
    if (safe !== OMIT) result[key] = safe;
  }
  return result;
}

function assertEventName(event: string): void {
  if (!/^[a-z][a-z0-9_]{0,95}$/.test(event)) {
    throw new Error(`structured log event должен быть snake_case: ${event}`);
  }
}

function assertRunId(runId: string): void {
  if (runId.length === 0 || runId.length > 200 || /[\r\n\u0000-\u001f]/.test(runId)) {
    throw new Error("runId должен быть непустым безопасным идентификатором до 200 символов");
  }
  if (redactSecrets(runId) !== runId) throw new Error("runId похож на credential");
}

/** ID для операций без собственного durable record ID (backup/restore/rebuild). */
export function createRunId(
  operation: string,
  uuid: () => string = randomUUID,
): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(operation)) {
    throw new Error(`operation должна быть snake_case: ${operation}`);
  }
  const runId = `${operation}:${uuid()}`;
  assertRunId(runId);
  return runId;
}

export interface CreateStructuredEventOptions {
  level?: LogLevel;
  event: string;
  runId: string;
  fields?: StructuredLogFields;
  timestamp?: Date;
}

export function createStructuredEvent(
  options: CreateStructuredEventOptions,
): StructuredLogEvent {
  assertEventName(options.event);
  assertRunId(options.runId);
  const timestamp = options.timestamp ?? new Date();
  if (!Number.isFinite(timestamp.getTime())) throw new Error("timestamp невалиден");
  return {
    level: options.level ?? "info",
    event: options.event,
    timestamp: timestamp.toISOString(),
    runId: options.runId,
    ...sanitizeLogFields(options.fields ?? {}),
  };
}

/** JSONL formatter shared by console and file sinks. */
export function formatStructuredEvent(event: StructuredLogEvent): string {
  return JSON.stringify(event);
}

export type StructuredLogSink = (line: string) => void;

export interface StructuredLogger {
  readonly runId: string;
  emit(level: LogLevel, event: string, fields?: StructuredLogFields): StructuredLogEvent;
  debug(event: string, fields?: StructuredLogFields): StructuredLogEvent;
  info(event: string, fields?: StructuredLogFields): StructuredLogEvent;
  warn(event: string, fields?: StructuredLogFields): StructuredLogEvent;
  error(event: string, fields?: StructuredLogFields): StructuredLogEvent;
}

export interface CreateStructuredLoggerOptions {
  /** Use String(syncRunId) for sync/migration so logs correlate with the DB. */
  runId: string;
  baseFields?: StructuredLogFields;
  sink?: StructuredLogSink;
  now?: () => Date;
}

/**
 * Reusable JSONL logger. The default sink is stderr, leaving stdout clean for
 * command results and `--json` output.
 */
export function createStructuredLogger(
  options: CreateStructuredLoggerOptions,
): StructuredLogger {
  assertRunId(options.runId);
  const sink = options.sink ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const baseFields = sanitizeLogFields(options.baseFields ?? {});
  const emit = (
    level: LogLevel,
    event: string,
    fields: StructuredLogFields = {},
  ): StructuredLogEvent => {
    const structured = createStructuredEvent({
      level,
      event,
      runId: options.runId,
      timestamp: now(),
      fields: { ...baseFields, ...fields },
    });
    sink(formatStructuredEvent(structured));
    return structured;
  };
  return {
    runId: options.runId,
    emit,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
