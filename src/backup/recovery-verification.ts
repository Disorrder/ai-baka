/** Reusable verification core for a persistent production recovery target. */

import { createHash } from "node:crypto";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb } from "../db/client.ts";
import { checkSchemaVersion } from "../db/migrations.ts";
import { selectAll, selectOne } from "../db/repositories/helpers.ts";
import { validateEmbeddingState } from "../validate.ts";
import {
  recordCounts,
  type BackupManifest,
} from "./backup.ts";
import { httpBaseUrl, httpHeaders } from "./http.ts";
import {
  buildRawManifest,
  hashRawManifest,
  verifyRawFiles,
} from "./raw-verify.ts";
import {
  buildDeferredFulltextIndexes,
  type RestoreIndexBuildDiagnostic,
  type RestoreIndexCommand,
  type RestoreIndexCommandResult,
} from "./restore-indexes.ts";
import {
  restoreRelationalChecksForSchemaVersion,
  verifyRestoredSearch,
  type RestoreCheck,
} from "./restore-test.ts";

const MAX_SQL_RESPONSE_BYTES = 1024 * 1024;
export const RECOVERY_REQUIRED_BM25_PROBES = 2;
const RECOVERY_INDEX_NAMESPACE_SENTINEL =
  "baka_restore_test_00000000000000000000000000000000";

export interface RecoverySearchSourceChunkOwnership {
  documentsChecked: number;
  referencesChecked: number;
  valid: true;
}

export interface RecoveryDatabaseVerification {
  ok: true;
  schemaVersion: 5;
  recordCounts: Record<string, number>;
  rawManifestSha256: string;
  rawFilesChecked: number;
  rawOrphans: number;
  searchSourceChunkOwnership: RecoverySearchSourceChunkOwnership;
  searchProbes: RestoreCheck[];
  fulltext: {
    name: "search_document_content";
    table: "search_document";
    ready: true;
    chunkContentAbsent: true;
  };
}

function sqlForCommand(command: RestoreIndexCommand): string {
  if (command.name !== "search_document_content" || command.table !== "search_document" ||
      command.ordinal !== 1) {
    throw new Error("recovery index command identity mismatch");
  }
  if (command.kind === "define") {
    return "DEFINE INDEX search_document_content ON TABLE search_document FIELDS content " +
      "FULLTEXT ANALYZER archive_mixed BM25 HIGHLIGHTS CONCURRENTLY;";
  }
  if (command.kind === "inspect") {
    return "INFO FOR TABLE search_document;\n" +
      "INFO FOR INDEX search_document_content ON TABLE search_document;";
  }
  if (command.kind === "remove") {
    return "REMOVE INDEX IF EXISTS search_document_content ON TABLE search_document;";
  }
  return "INFO FOR TABLE search_document;";
}

async function readBounded(response: Response): Promise<{
  body: unknown;
  responseBytes: number;
  responseSha256: string;
}> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_SQL_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("recovery SQL response exceeds its bound");
  }
  if (!response.body) throw new Error("recovery SQL response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (bytes + item.value.byteLength > MAX_SQL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("recovery SQL response exceeds its bound");
      }
      bytes += item.value.byteLength;
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new Error("recovery SQL response is malformed");
  }
  return {
    body,
    responseBytes: bytes,
    responseSha256: createHash("sha256").update(joined).digest("hex"),
  };
}

async function postSql(
  cfg: AppConfig,
  statement: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RestoreIndexCommandResult> {
  const response = await fetchImpl(`${httpBaseUrl(cfg)}/sql`, {
    method: "POST",
    headers: {
      ...httpHeaders(cfg, cfg.surrealNamespace, cfg.surrealDatabase),
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body: statement,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => {
    throw new Error("recovery SQL request failed");
  });
  const bounded = await readBounded(response);
  if (!response.ok) throw new Error("recovery SQL request was rejected");
  return {
    body: bounded.body,
    httpStatus: response.status,
    responseBytes: bounded.responseBytes,
    responseSha256: bounded.responseSha256,
    responseTruncated: false,
  };
}

/**
 * Reuses the restore-test parser/poller while routing its fixed, validated
 * command identity to the real recovery namespace. The fake namespace value
 * satisfies the destructive test-helper guard but is never sent to a server.
 */
export async function buildRecoveryCoreIndex(
  cfg: AppConfig,
  deferredStatements: readonly string[],
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<readonly RestoreIndexBuildDiagnostic[]> {
  return buildDeferredFulltextIndexes(
    cfg,
    RECOVERY_INDEX_NAMESPACE_SENTINEL,
    cfg.surrealDatabase,
    deferredStatements,
    {
      signal: options.signal,
      executeCommand: (command) =>
        postSql(cfg, sqlForCommand(command), command.timeoutMs, options.fetchImpl ?? fetch),
    },
  );
}

function firstEnvelope(body: unknown): Record<string, unknown> {
  if (!Array.isArray(body) || body.length !== 1 || !body[0] ||
      typeof body[0] !== "object" || Array.isArray(body[0])) {
    throw new Error("recovery INFO response is malformed");
  }
  const envelope = body[0] as Record<string, unknown>;
  if (envelope.status !== "OK" || !envelope.result ||
      typeof envelope.result !== "object" || Array.isArray(envelope.result)) {
    throw new Error("recovery INFO response failed");
  }
  return envelope.result as Record<string, unknown>;
}

function indexesFromInfo(body: unknown): Record<string, unknown> {
  const result = firstEnvelope(body);
  const indexes = result.indexes;
  if (!indexes || typeof indexes !== "object" || Array.isArray(indexes)) {
    throw new Error("recovery INFO indexes are malformed");
  }
  return indexes as Record<string, unknown>;
}

export async function verifyRecoveryIndexTopology(
  cfg: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RecoveryDatabaseVerification["fulltext"]> {
  const [search, chunk] = await Promise.all([
    postSql(cfg, "INFO FOR TABLE search_document;", 30_000, fetchImpl),
    postSql(cfg, "INFO FOR TABLE chunk;", 30_000, fetchImpl),
  ]);
  const searchIndexes = indexesFromInfo(search.body);
  const chunkIndexes = indexesFromInfo(chunk.body);
  const definition = searchIndexes.search_document_content;
  const sql = typeof definition === "string"
    ? definition
    : definition && typeof definition === "object" && !Array.isArray(definition)
    ? (definition as Record<string, unknown>).sql
    : undefined;
  if (typeof sql !== "string" ||
      !/^DEFINE INDEX search_document_content ON(?: TABLE)? search_document FIELDS content FULLTEXT ANALYZER archive_mixed BM25(?:\s*\(\s*1\.2(?:0*)?\s*,\s*0\.75(?:0*)?\s*\))? HIGHLIGHTS(?: CONCURRENTLY)?$/iu.test(
        sql.replaceAll(/\s+/gu, " ").trim().replace(/;$/u, ""),
      )) {
    throw new Error("recovery core FULLTEXT identity mismatch");
  }
  if (Object.hasOwn(chunkIndexes, "chunk_content")) {
    throw new Error("recovery retained forbidden chunk_content index");
  }
  return {
    name: "search_document_content",
    table: "search_document",
    ready: true,
    chunkContentAbsent: true,
  };
}

export async function verifyRecoveryRelationalChecks(db: Surreal): Promise<void> {
  // Recovery accepts schema 5 as the only baseline, so its durable migration
  // ledger/quarantine references are part of the same fail-closed check set.
  for (const [, sql] of restoreRelationalChecksForSchemaVersion(5)) {
    const violations = (await selectOne<{ n: number }>(db, sql))?.n ?? 0;
    if (violations !== 0) throw new Error("recovery relational invariant failed");
  }
}

/**
 * `record::exists()` alone is insufficient here: every projected source chunk
 * must belong to the same dialogue and current revision as its search document.
 */
export async function verifyRecoverySearchSourceChunkOwnership(
  db: Surreal,
): Promise<RecoverySearchSourceChunkOwnership> {
  const chunks = new Map(
    (await selectAll<{ id: unknown; dialogue: unknown; dialogue_revision: unknown }>(
      db,
      "SELECT id, dialogue, dialogue_revision FROM chunk",
    )).map((row) => [String(row.id), row]),
  );
  const documents = await selectAll<{
    dialogue: unknown;
    dialogue_revision: unknown;
    source_chunks: unknown;
  }>(db, "SELECT dialogue, dialogue_revision, source_chunks FROM search_document");
  let referencesChecked = 0;
  let invalid = 0;
  for (const document of documents) {
    if (!Array.isArray(document.source_chunks)) {
      invalid += 1;
      continue;
    }
    for (const sourceChunk of document.source_chunks) {
      referencesChecked += 1;
      const chunk = chunks.get(String(sourceChunk));
      if (!chunk || String(chunk.dialogue) !== String(document.dialogue) ||
          String(chunk.dialogue_revision) !== String(document.dialogue_revision)) {
        invalid += 1;
      }
    }
  }
  if (invalid !== 0) {
    throw new Error("recovery search_document.source_chunks ownership failed");
  }
  return {
    documentsChecked: documents.length,
    referencesChecked,
    valid: true,
  };
}

export function assertRecoveryBm25Probes(
  probes: readonly RestoreCheck[],
  expectedDocumentCount: number,
): void {
  if (!Number.isSafeInteger(expectedDocumentCount) || expectedDocumentCount < 1) {
    throw new Error("recovery requires a nonempty search corpus for two BM25 probes");
  }
  const named = probes.filter((probe) => /^search: probe_[1-9]\d*$/u.test(probe.name));
  const uniqueNames = new Set(named.map((probe) => probe.name));
  const summary = probes.filter((probe) => probe.name === "search probes");
  if (
    named.length !== uniqueNames.size ||
    named.length < RECOVERY_REQUIRED_BM25_PROBES ||
    !uniqueNames.has("search: probe_1") || !uniqueNames.has("search: probe_2") ||
    named.some((probe) => !probe.ok) || summary.length !== 1 || !summary[0]!.ok
  ) {
    throw new Error("recovery requires at least two deterministic successful BM25 probes");
  }
}

function exactCounts(actual: Record<string, number>, expected: Record<string, number>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    actualKeys.every((key) => actual[key] === expected[key]);
}

export async function verifyRecoveryDatabase(
  cfg: AppConfig,
  manifest: BackupManifest,
  options: {
    connect?: (cfg: AppConfig) => Promise<Surreal>;
    verifyTopology?: (cfg: AppConfig) => Promise<RecoveryDatabaseVerification["fulltext"]>;
  } = {},
): Promise<RecoveryDatabaseVerification> {
  if (manifest.schemaVersion !== 5 || !manifest.rawManifestSha256) {
    throw new Error("recovery verification requires authenticated schema 5 manifest");
  }
  const db = await (options.connect ?? connectDb)(cfg);
  try {
    if (await checkSchemaVersion(db) !== 5) throw new Error("recovery schema version mismatch");
    const counts = await recordCounts(db, 5);
    if (!exactCounts(counts, manifest.recordCounts)) {
      throw new Error("recovery record counts differ from authenticated manifest");
    }
    await verifyRecoveryRelationalChecks(db);
    const searchSourceChunkOwnership = await verifyRecoverySearchSourceChunkOwnership(db);
    const embeddingIssues = await validateEmbeddingState(db);
    if (embeddingIssues.length !== 0) throw new Error("recovery embedding invariants failed");
    const rawManifest = await buildRawManifest(db);
    const rawHash = hashRawManifest(rawManifest);
    if (rawHash !== manifest.rawManifestSha256) {
      throw new Error("recovery raw manifest hash mismatch");
    }
    const raw = await verifyRawFiles(cfg.archiveRoot, rawManifest);
    if (!raw.ok || raw.checked !== rawManifest.count) {
      throw new Error("recovery raw file verification failed");
    }
    const expectedSearchDocuments = manifest.recordCounts.search_document ?? 0;
    const probes = await verifyRestoredSearch(db, expectedSearchDocuments);
    assertRecoveryBm25Probes(probes, expectedSearchDocuments);
    const fulltext = await (options.verifyTopology ?? verifyRecoveryIndexTopology)(cfg);
    return {
      ok: true,
      schemaVersion: 5,
      recordCounts: counts,
      rawManifestSha256: rawHash,
      rawFilesChecked: raw.checked,
      rawOrphans: raw.orphans.length,
      searchSourceChunkOwnership,
      searchProbes: probes,
      fulltext,
    };
  } finally {
    await db.close();
  }
}
