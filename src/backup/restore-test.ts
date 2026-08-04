/**
 * Restore drill verification core (docs/plan.md §16.4):
 * импорт export'а в уникальный namespace `baka_restore_test_<attempt>`
 * переданного disposable target,
 * проверка record counts против manifest'а, referential-инвариантов,
 * hash-derived search-запросов с известным nonzero ожиданием и raw references, затем
 * REMOVE NAMESPACE.
 *
 * До импорта проверяется целостность самого export'а (exportSha256/
 * exportBytes из manifest'а): битый архив в drill-ns не разливается.
 *
 * Referential-проверки — девиации «ноль в restored». Live source DB вообще
 * не открывается: counts берутся из проверенного manifest, а invariants,
 * embedding ownership и BM25 smoke probes вычисляются по restored DB.
 *
 * Production acceptance requires strict isolated pinned-target evidence;
 * same-server namespace evidence is rejected by the durable parser.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { selectAll, selectOne } from "../db/repositories/helpers.ts";
import { validateEmbeddingState } from "../validate.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import {
  latestExportPath,
  isSupportedBackupSchemaVersion,
  manifestPathForExport,
  ownedEmbeddingTables,
  parseBackupManifest,
  validateRecordCountTables,
  type BackupManifest,
  type SupportedBackupSchemaVersion,
} from "./backup.ts";
import { decompressFile } from "./compress.ts";
import { httpBaseUrl, httpHeaders, sqlRoot } from "./http.ts";
import {
  DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE,
  PINNED_SURREAL_INDEXING_BEHAVIOR,
  type PinnedIndexingBehavior,
} from "./isolated-target.ts";
import {
  streamHttpPostFile,
  StreamHttpUploadError,
  type StreamHttpPostFileOptions,
  type StreamHttpPostFileResult,
  type StreamHttpUploadFailureEvidence,
} from "./http-upload.ts";
import { buildRawManifest, hashRawManifest, verifyRawFiles } from "./raw-verify.ts";
import { reorderImportFile } from "./reorder-import.ts";
import {
  buildDeferredFulltextIndexes,
  removeStartedFulltextIndexes,
  RESTORE_FULLTEXT_INDEX_DEFINITIONS,
  RestoreIndexBuildError,
  type RestoreFulltextIndexDefinition,
  type RestoreIndexBuildDiagnostic,
} from "./restore-indexes.ts";
import {
  OFF_DEVICE_MANIFEST_FILE,
  verifyOffDeviceBackup,
  type OffDeviceManifest,
} from "./off-device.ts";
import {
  assertInternalTableIdentifier,
  assertRegularNonSymlinkFile,
  createExclusiveTemporaryFile,
} from "./safety.ts";

/** Stable prefix retained for operator recognition and strict CLI validation. */
export const RESTORE_NAMESPACE = "baka_restore_test";
const RESTORE_NAMESPACE_PATTERN = /^baka_restore_test_[0-9a-f]{32}$/;
export const PERSISTED_RESTORE_REPORT_FORMAT_VERSION = 5;
export const PINNED_RESTORE_TARGET_VERSION = "3.2.3";
export const PINNED_RESTORE_TARGET_IMAGE_DIGEST =
  "sha256:2006fe3f88f6f240c6463460021b4a14ffe102aea376284428f850045b7b382e";
const SEARCH_PROBE_LIMIT = 3;
const SEARCH_PROBE_SOURCE_LIMIT = 32;

/**
 * The only isolated profile accepted as durable restore evidence. The target
 * lifecycle may validate other bounded launch profiles for diagnostics, but
 * docs/plan.md §16.4 defines this resource profile as exact for acceptance.
 */
export const APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS = Object.freeze({
  memoryBytes: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.memoryBytes,
  memorySwapBytes: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.memorySwapBytes,
  nanoCpus: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.cpus * 1_000_000_000,
  pidsLimit: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.pidsLimit,
  rocksDbBlockCacheBytes:
    DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.rocksDbBlockCacheBytes,
  rocksDbThreadCount: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.rocksDbThreadCount,
  rocksDbJobsCount: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.rocksDbJobsCount,
  rocksDbMaxConcurrentSubcompactions:
    DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.rocksDbMaxConcurrentSubcompactions,
  hnswCacheBytes: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.hnswCacheBytes,
  memoryThresholdBytes: DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.memoryThresholdBytes,
  httpMaxImportBodyBytes:
    DEFAULT_ISOLATED_TARGET_RESOURCE_PROFILE.httpMaxImportBodyBytes,
  indexBuildResumeIntervalSeconds: 0,
} as const);

export interface RestoreTargetFulltextIndexEvidence {
  ordinal: 1;
  name: "search_document_content";
  table: "search_document";
  field: "content";
  analyzer: "archive_mixed";
  state: "ready";
}

/**
 * Lifecycle-agnostic, privacy-safe acceptance evidence for a disposable
 * restore target. F22/F24 may construct it through another lifecycle module,
 * but this contract deliberately accepts no container names, paths, ports,
 * credentials or arbitrary diagnostic strings.
 */
export interface RestoreTargetEvidence {
  mode: "isolated_pinned_container";
  image: {
    version: typeof PINNED_RESTORE_TARGET_VERSION;
    digest: typeof PINNED_RESTORE_TARGET_IMAGE_DIGEST;
  };
  /** Opaque identity only; the underlying container/volume name is private. */
  dataIdentitySha256: string;
  /** Exact approved profile, not a caller-selected minimum or range. */
  resourceBounds: {
    memoryBytes: number;
    memorySwapBytes: number;
    nanoCpus: number;
    pidsLimit: number;
    rocksDbBlockCacheBytes: number;
    rocksDbThreadCount: 4;
    rocksDbJobsCount: 4;
    rocksDbMaxConcurrentSubcompactions: 2;
    hnswCacheBytes: number;
    memoryThresholdBytes: number;
    httpMaxImportBodyBytes: number;
    indexBuildResumeIntervalSeconds: 0;
  };
  /** Compile-time behavior attested by the exact pinned image, not launch configuration. */
  pinnedIndexingBehavior: PinnedIndexingBehavior;
  fulltextIndexes: readonly RestoreTargetFulltextIndexEvidence[];
  cleanup: {
    containerRemoved: true;
    dataVolumeRemoved: true;
  };
}

export interface RestoreCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RestoreTestReport {
  formatVersion: 5;
  ok: true;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  /** Restored Surreal database name inside the unique namespace. */
  database: string;
  /** Exact root used to resolve raw/... evidence. */
  archiveRoot: string;
  /** Compatibility alias; strict persisted reports require exact equality. */
  rawArchiveRoot: string;
  exportPath: string;
  exportFile: string;
  exportBytes: number;
  exportSha256: string;
  manifestPath: string;
  manifestFile: string;
  manifestSha256: string;
  rawManifestSha256: string;
  schemaVersion: number;
  searchDocuments: number;
  chunks: number;
  namespace: string;
  checks: RestoreCheck[];
  target: RestoreTargetEvidence;
  cleanup: {
    databaseClosed: true;
    temporaryExportRemoved: true;
    namespaceRemoved: true;
  };
}

/** Exact durable success evidence consumed by status and migration gates. */
export interface PersistedRestoreTestReport extends RestoreTestReport {
  runId: string;
  createdAt: string;
}

export type RestoreAttemptStage =
  | "input_validation"
  | "manifest_validation"
  | "bundle_integrity"
  | "export_integrity"
  | "temporary_export"
  | "namespace_prepare"
  | "decompress"
  | "index_reorder"
  | "import"
  | "index_build"
  | "connect"
  | "verification"
  | "target_validation"
  | "cleanup";

export interface RestoreAttemptFailure {
  stage: RestoreAttemptStage;
  /** Stable, privacy-safe machine code. Never contains an underlying error. */
  code: string;
}

/**
 * Persistable evidence for attempts which fail before a complete report exists.
 * Absolute paths, database errors, search terms and private content are omitted.
 */
export interface RestoreTestFailureEvidence {
  formatVersion: 1;
  ok: false;
  attemptId: string;
  startedAt: string;
  namespace: string;
  exportFile?: string;
  exportBytes?: number;
  exportSha256?: string;
  manifestFile?: string;
  manifestSha256?: string;
  schemaVersion?: SupportedBackupSchemaVersion;
  checks: RestoreCheck[];
  failure: RestoreAttemptFailure;
  /** Present only for import transport failures; contains no response content. */
  importTransport?: StreamHttpUploadFailureEvidence;
  /** Present only after deferred index work starts; safe to persist. */
  indexBuilds?: readonly RestoreIndexBuildDiagnostic[];
  cleanupFailures: Array<
    "database_close" | "temporary_export_remove" | "index_remove" | "namespace_remove" |
      "target_cleanup"
  >;
}

/** Safe outer error: `report` is durable; `cause` must never be serialized. */
export class RestoreTestAttemptError extends Error {
  constructor(readonly report: RestoreTestFailureEvidence, cause?: unknown) {
    super(`restore test attempt failed: ${report.failure.stage}/${report.failure.code}`, { cause });
    this.name = "RestoreTestAttemptError";
  }
}

export interface RestoreTestOptions {
  exportPath?: string;
  /**
   * Корень переносимой archive-структуры с raw/ внутри. Для off-device
   * bundle это `<bundle>/archive`; default — cfg.archiveRoot.
   */
  rawArchiveRoot?: string;
  /**
   * Strict final target evidence. Integration code which can only produce it
   * after target teardown may instead use `resolveTargetEvidence` below.
   */
  targetEvidence?: RestoreTargetEvidence;
  /** Cooperative cancellation for long import and deferred-index polling. */
  signal?: AbortSignal;
}

export interface RestoreTargetFinalizationContext {
  /** Safe generated identity; never a container/volume identifier. */
  attemptId: string;
  verificationSucceeded: boolean;
  restoreCleanupComplete: boolean;
  fulltextIndexes: readonly RestoreTargetFulltextIndexEvidence[];
}

export interface RestoreTestDependencies {
  uploadFile(options: StreamHttpPostFileOptions): Promise<StreamHttpPostFileResult>;
  removeNamespace(cfg: AppConfig, namespace: string): Promise<void>;
  connectDb(cfg: AppConfig, namespace: string): Promise<Surreal>;
  decompress(source: string, destination: string): Promise<void>;
  buildDeferredIndexes(
    cfg: AppConfig,
    namespace: string,
    database: string,
    statements: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly RestoreIndexBuildDiagnostic[]>;
  removeDeferredIndexes(
    cfg: AppConfig,
    namespace: string,
    database: string,
    indexes: readonly RestoreFulltextIndexDefinition[],
  ): Promise<void>;
  /**
   * Optional late resolver used by lifecycle integration. It runs only after
   * restore DB/index/namespace cleanup, so it can tear down the disposable
   * target before a successful report becomes publishable.
   */
  resolveTargetEvidence?(
    provided: RestoreTargetEvidence | undefined,
    context: RestoreTargetFinalizationContext,
  ): Promise<unknown>;
}

/** Unique strict identifier: concurrent drills never share a removable namespace. */
export function createRestoreNamespace(uuid = randomUUID()): string {
  const suffix = uuid.replaceAll("-", "").toLowerCase();
  const namespace = `${RESTORE_NAMESPACE}_${suffix}`;
  if (!RESTORE_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error("restore namespace generator returned an unsafe identifier");
  }
  return namespace;
}

export function isRestoreNamespace(namespace: string): boolean {
  return RESTORE_NAMESPACE_PATTERN.test(namespace);
}

async function removeRestoreNamespace(cfg: AppConfig, namespace: string): Promise<void> {
  if (!isRestoreNamespace(namespace)) throw new Error("refusing to remove unsafe restore namespace");
  await sqlRoot(cfg, `REMOVE NAMESPACE IF EXISTS ${namespace};`);
}

/**
 * Test seam is intentionally limited to construction. A partially connected
 * SDK client is always closed when authentication or database selection fails.
 */
export async function connectRestoreDb(
  cfg: AppConfig,
  namespace: string,
  createDb: () => Surreal = () => new Surreal(),
): Promise<Surreal> {
  if (!isRestoreNamespace(namespace)) throw new Error("unsafe restore namespace");
  const db = createDb();
  try {
    await db.connect(cfg.surrealUrl);
    await db.signin({ username: cfg.surrealUser, password: cfg.surrealPass });
    await db.use({ namespace, database: cfg.surrealDatabase });
    return db;
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}

const DEFAULT_RESTORE_DEPENDENCIES: RestoreTestDependencies = {
  uploadFile: streamHttpPostFile,
  removeNamespace: removeRestoreNamespace,
  connectDb: connectRestoreDb,
  decompress: decompressFile,
  buildDeferredIndexes: (cfg, namespace, database, statements, signal) =>
    buildDeferredFulltextIndexes(cfg, namespace, database, statements, { signal }),
  removeDeferredIndexes: removeStartedFulltextIndexes,
};

/** Never forwards AbortSignal.reason, which may contain private operator data. */
function throwIfRestoreCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("restore test cancelled");
}

/** count() по таблице; 0, если таблицы нет (пустой export без DEFINE TABLE). */
async function countOf(db: Surreal, table: string): Promise<number> {
  assertInternalTableIdentifier(table, "restore count table");
  const row = await selectOne<{ n: number }>(
    db,
    `SELECT count() AS n FROM ${table} GROUP ALL`,
  );
  return row?.n ?? 0;
}

/**
 * Dangling references (§16.4 шаг 5): каждая ссылка обязана указывать на
 * существующую запись; current_revision — на ready-ревизию этого же
 * dialogue. Restored обязан иметь НОЛЬ нарушений.
 */
const SCHEMA_4_RESTORE_RELATIONAL_CHECKS: ReadonlyArray<readonly [string, string]> = [
  [
    "os_account.host",
    `SELECT count() AS n FROM os_account WHERE host IS NONE OR !record::exists(host) GROUP ALL`,
  ],
  [
    "harness_installation.host/harness",
    `SELECT count() AS n FROM harness_installation
     WHERE host IS NONE OR !record::exists(host) OR harness IS NONE OR !record::exists(harness)
     GROUP ALL`,
  ],
  [
    "model.vendor",
    `SELECT count() AS n FROM model WHERE vendor IS NONE OR !record::exists(vendor) GROUP ALL`,
  ],
  [
    "workspace_location.workspace/host",
    `SELECT count() AS n FROM workspace_location
     WHERE workspace IS NONE OR !record::exists(workspace) OR host IS NONE OR !record::exists(host)
     GROUP ALL`,
  ],
  [
    "source_root.harness_installation",
    `SELECT count() AS n FROM source_root
     WHERE harness_installation IS NONE OR !record::exists(harness_installation) GROUP ALL`,
  ],
  [
    "sync_run.host",
    `SELECT count() AS n FROM sync_run WHERE host IS NONE OR !record::exists(host) GROUP ALL`,
  ],
  [
    "source_scan.sync_run/source_root",
    `SELECT count() AS n FROM source_scan
     WHERE sync_run IS NONE OR !record::exists(sync_run)
        OR source_root IS NONE OR !record::exists(source_root) GROUP ALL`,
  ],
  [
    "source_location.source_root/renamed_from",
    `SELECT count() AS n FROM source_location
     WHERE source_root IS NONE OR !record::exists(source_root)
        OR (renamed_from IS NOT NONE AND !record::exists(renamed_from)) GROUP ALL`,
  ],
  [
    "source_location.current_revision ownership",
    `SELECT count() AS n FROM source_location
     WHERE current_revision IS NOT NONE
       AND (!record::exists(current_revision) OR current_revision.source_location != id)
     GROUP ALL`,
  ],
  [
    "source_location.last_successful_revision ownership/status",
    `SELECT count() AS n FROM source_location
     WHERE last_successful_revision IS NOT NONE
       AND (!record::exists(last_successful_revision)
            OR last_successful_revision.source_location != id
            OR last_successful_revision.parse_status != "parsed")
     GROUP ALL`,
  ],
  [
    "source_revision.source_location/sync_run",
    `SELECT count() AS n FROM source_revision
     WHERE source_location IS NONE OR !record::exists(source_location)
        OR sync_run IS NONE OR !record::exists(sync_run) GROUP ALL`,
  ],
  [
    "ingest_error.sync_run/source_revision",
    `SELECT count() AS n FROM ingest_error
     WHERE sync_run IS NONE OR !record::exists(sync_run)
        OR (source_revision IS NOT NONE AND !record::exists(source_revision)) GROUP ALL`,
  ],
  [
    "dialogue identity references",
    `SELECT count() AS n FROM dialogue
     WHERE harness_installation IS NONE OR !record::exists(harness_installation)
        OR (os_account IS NOT NONE AND !record::exists(os_account))
        OR (workspace IS NOT NONE AND !record::exists(workspace))
        OR (primary_model IS NOT NONE AND !record::exists(primary_model)) GROUP ALL`,
  ],
  [
    "message.dialogue_revision → существующая revision",
    `SELECT count() AS n FROM message
     WHERE dialogue_revision IS NONE OR !record::exists(dialogue_revision) GROUP ALL`,
  ],
  [
    "chunk.message → существующий message",
    `SELECT count() AS n FROM chunk
     WHERE message IS NONE OR !record::exists(message) GROUP ALL`,
  ],
  [
    "dialogue.current_revision → ready revision этого dialogue",
    `SELECT count() AS n FROM dialogue
     WHERE current_revision IS NOT NONE
       AND (!record::exists(current_revision)
            OR current_revision.status != "ready"
            OR current_revision.dialogue != id)
     GROUP ALL`,
  ],
  [
    "dialogue_revision.dialogue → существующий dialogue",
    `SELECT count() AS n FROM dialogue_revision
     WHERE dialogue IS NONE OR !record::exists(dialogue) GROUP ALL`,
  ],
  [
    "dialogue_revision.source_revision",
    `SELECT count() AS n FROM dialogue_revision
     WHERE source_revision IS NOT NONE AND !record::exists(source_revision) GROUP ALL`,
  ],
  [
    "message dialogue/revision/model ownership",
    `SELECT count() AS n FROM message
     WHERE dialogue IS NONE OR !record::exists(dialogue)
        OR dialogue_revision IS NONE OR !record::exists(dialogue_revision)
        OR dialogue_revision.dialogue != dialogue
        OR (model IS NOT NONE AND !record::exists(model)) GROUP ALL`,
  ],
  [
    "chunk dialogue/revision/message ownership",
    `SELECT count() AS n FROM chunk
     WHERE dialogue IS NONE OR !record::exists(dialogue)
        OR dialogue_revision IS NONE OR !record::exists(dialogue_revision)
        OR message IS NONE OR !record::exists(message)
        OR dialogue_revision.dialogue != dialogue
        OR message.dialogue != dialogue OR message.dialogue_revision != dialogue_revision GROUP ALL`,
  ],
  [
    "search_document current dialogue/revision/message ownership",
    `SELECT count() AS n FROM search_document
     WHERE dialogue IS NONE OR !record::exists(dialogue)
        OR dialogue_revision IS NONE OR !record::exists(dialogue_revision)
        OR dialogue_revision.dialogue != dialogue OR dialogue.current_revision != dialogue_revision
        OR (message IS NOT NONE AND (!record::exists(message)
            OR message.dialogue != dialogue OR message.dialogue_revision != dialogue_revision)) GROUP ALL`,
  ],
  [
    "embedding_job document/space/hash ownership",
    `SELECT count() AS n FROM embedding_job
     WHERE search_document IS NONE OR !record::exists(search_document)
        OR embedding_space IS NONE OR !record::exists(embedding_space)
        OR input_sha256 != search_document.content_sha256 GROUP ALL`,
  ],
  [
    "legacy_identity_map.target",
    `SELECT count() AS n FROM legacy_identity_map
     WHERE target IS NONE OR !record::exists(target) GROUP ALL`,
  ],
  [
    "migration_meta.sync_run",
    `SELECT count() AS n FROM migration_meta
     WHERE sync_run IS NOT NONE AND !record::exists(sync_run) GROUP ALL`,
  ],
];

/** Referential checks for durable tables introduced by migration 0005. */
const SCHEMA_5_RESTORE_RELATIONAL_CHECKS: ReadonlyArray<readonly [string, string]> = [
  [
    "migration_row_commit migration/target",
    `SELECT count() AS n FROM migration_row_commit
     WHERE migration IS NONE OR !record::exists(migration)
        OR target IS NONE OR !record::exists(target) GROUP ALL`,
  ],
  [
    "migration_quarantine migration/previous_attempt",
    `SELECT count() AS n FROM migration_quarantine
     WHERE migration IS NONE OR !record::exists(migration)
        OR (previous_attempt IS NOT NONE AND !record::exists(previous_attempt)) GROUP ALL`,
  ],
];

/** Current-schema compatibility export retained for existing callers/tests. */
export const RESTORE_RELATIONAL_CHECKS: ReadonlyArray<readonly [string, string]> = [
  ...SCHEMA_4_RESTORE_RELATIONAL_CHECKS,
  ...SCHEMA_5_RESTORE_RELATIONAL_CHECKS,
];

/** Never query tables which are absent from the authenticated backup schema. */
export function restoreRelationalChecksForSchemaVersion(
  schemaVersion: number,
): ReadonlyArray<readonly [string, string]> {
  if (schemaVersion === 4) return SCHEMA_4_RESTORE_RELATIONAL_CHECKS;
  if (schemaVersion >= 5 && schemaVersion <= 9) return RESTORE_RELATIONAL_CHECKS;
  throw new Error(`restore:test: unsupported schema ${schemaVersion}; expected 4–9`);
}

async function invalidSearchSourceChunks(db: Surreal): Promise<number> {
  const chunks = new Map(
    (await selectAll<{ id: unknown; dialogue: unknown; dialogue_revision: unknown }>(
      db,
      "SELECT id, dialogue, dialogue_revision FROM chunk",
    )).map((row) => [String(row.id), row]),
  );
  let invalid = 0;
  for (const document of await selectAll<{
    dialogue: unknown;
    dialogue_revision: unknown;
    source_chunks: unknown[];
  }>(db, "SELECT dialogue, dialogue_revision, source_chunks FROM search_document")) {
    for (const sourceChunk of document.source_chunks ?? []) {
      const chunk = chunks.get(String(sourceChunk));
      if (!chunk || String(chunk.dialogue) !== String(document.dialogue) ||
          String(chunk.dialogue_revision) !== String(document.dialogue_revision)) {
        invalid += 1;
      }
    }
  }
  return invalid;
}

function searchProbeTerms(contents: readonly string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const content of contents) {
    for (const match of content.normalize("NFKC").matchAll(/[\p{L}\p{N}]{3,64}/gu)) {
      const term = match[0]!.toLocaleLowerCase("und");
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length === SEARCH_PROBE_LIMIT) return terms;
    }
  }
  return terms;
}

interface Bm25ProbeContract {
  sourceSql: string;
  countSql: string;
  itemLabel: string;
  probeName(index: number): string;
  summaryName: string;
}

async function verifyRestoredBm25(
  db: Surreal,
  expectedCount: number,
  contract: Bm25ProbeContract,
): Promise<RestoreCheck[]> {
  if (expectedCount === 0) {
    return [{
      name: contract.summaryName,
      ok: true,
      detail: `authenticated manifest expects 0 ${contract.itemLabel}; no nonzero probe required`,
    }];
  }

  let rows: Array<{ id: unknown; content: string }>;
  try {
    rows = await selectAll<{ id: unknown; content: string }>(db, contract.sourceSql);
  } catch {
    return [{ name: contract.summaryName, ok: false, detail: "probe source query failed" }];
  }
  const terms = searchProbeTerms(
    rows.map((row) => typeof row.content === "string" ? row.content : ""),
  );
  if (terms.length === 0) {
    return [{
      name: contract.summaryName,
      ok: false,
      detail: `authenticated nonempty ${contract.itemLabel} set yielded no safe probe token`,
    }];
  }

  const checks: RestoreCheck[] = [];
  for (const [index, term] of terms.entries()) {
    const querySha256 = createHash("sha256").update(term, "utf8").digest("hex");
    try {
      const hits = (await selectOne<{ n: number }>(
        db,
        contract.countSql,
        { q: term },
      ))?.n ?? 0;
      checks.push({
        name: contract.probeName(index + 1),
        ok: hits >= 1,
        detail: `querySha256 ${querySha256}; expected >= 1 authenticated hit, restored ${hits}`,
      });
    } catch {
      checks.push({
        name: contract.probeName(index + 1),
        ok: false,
        detail: `querySha256 ${querySha256}; BM25 query failed`,
      });
    }
  }
  checks.push({
    name: contract.summaryName,
    ok: checks.every((check) => check.ok),
    detail: `${checks.filter((check) => check.ok).length}/${checks.length} probes returned authenticated nonzero hits`,
  });
  return checks;
}

/**
 * Probe expectations come from the hash-authenticated imported export itself:
 * a token taken from a restored search_document must return at least that
 * document through BM25. Terms stay process-local and never enter the report.
 */
export async function verifyRestoredSearch(
  db: Surreal,
  expectedDocumentCount: number,
): Promise<RestoreCheck[]> {
  return verifyRestoredBm25(db, expectedDocumentCount, {
    sourceSql:
      `SELECT id, content FROM search_document ORDER BY id LIMIT ${SEARCH_PROBE_SOURCE_LIMIT}`,
    countSql: "SELECT count() AS n FROM search_document WHERE content @0@ $q GROUP ALL",
    itemLabel: "search documents",
    probeName: (index) => `search: probe_${index}`,
    summaryName: "search probes",
  });
}

const COMMON_REQUIRED_RESTORE_CHECK_NAMES = [
  "record_counts",
  ...SCHEMA_4_RESTORE_RELATIONAL_CHECKS.map(([name]) => `invariant: ${name}`),
  "invariant: search_document.source_chunks ownership",
  "invariant: embedding physical ownership/vector symmetry",
  "info: dialogue без current_revision",
] as const;

/** Exact schema-5 success contract retained for final migration acceptance. */
export const REQUIRED_RESTORE_CHECK_NAMES = [
  "record_counts",
  ...RESTORE_RELATIONAL_CHECKS.map(([name]) => `invariant: ${name}`),
  "invariant: search_document.source_chunks ownership",
  "invariant: embedding physical ownership/vector symmetry",
  "info: dialogue без current_revision",
] as const;

export function requiredRestoreCheckNamesForSchemaVersion(
  schemaVersion: number,
): readonly string[] {
  if (schemaVersion === 4) return COMMON_REQUIRED_RESTORE_CHECK_NAMES;
  if (schemaVersion >= 5 && schemaVersion <= 9) return REQUIRED_RESTORE_CHECK_NAMES;
  throw new Error(`restore report: unsupported schema ${schemaVersion}; expected 4–9`);
}

const RESTORE_FINAL_CHECK_NAMES = [
  "raw references",
  "raw manifest hash",
] as const;

export function expectedSuccessfulRestoreCheckNames(
  searchDocuments: number,
  probeCount: number,
  schemaVersion: SupportedBackupSchemaVersion = 5,
): string[] {
  if (!Number.isSafeInteger(searchDocuments) || searchDocuments < 0) {
    throw new Error("searchDocuments must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(probeCount) || probeCount < 0 || probeCount > SEARCH_PROBE_LIMIT ||
    (searchDocuments === 0 && probeCount !== 0) ||
    (searchDocuments > 0 && probeCount === 0)
  ) {
    throw new Error("BM25 probe count does not match searchDocuments");
  }
  return [
    ...requiredRestoreCheckNamesForSchemaVersion(schemaVersion),
    ...Array.from({ length: probeCount }, (_, index) => `search: probe_${index + 1}`),
    "search probes",
    ...RESTORE_FINAL_CHECK_NAMES,
  ];
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} должен быть object`);
  }
  const object = value as Record<string, unknown>;
  const expected = new Set(expectedKeys);
  const unknown = Object.keys(object).filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !Object.hasOwn(object, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label}: exact fields mismatch; unknown=${unknown.join(",") || "—"}, ` +
        `missing=${missing.join(",") || "—"}`,
    );
  }
  return object;
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} невалиден`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} должен быть canonical ISO timestamp`);
  }
  return value;
}

const EXPECTED_TARGET_FULLTEXT_INDEXES: readonly RestoreTargetFulltextIndexEvidence[] =
  RESTORE_FULLTEXT_INDEX_DEFINITIONS.map((index) => ({
    ordinal: index.ordinal,
    name: index.name,
    table: index.table,
    field: index.field,
    analyzer: index.analyzer,
    state: "ready" as const,
  }));

function exactApprovedResourceInteger(
  value: unknown,
  expected: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new Error(
      `restore target evidence ${label} must match the exact bounded approved isolated profile`,
    );
  }
  return value;
}

/** Strict parser shared by run-time acceptance and persisted-report parsing. */
export function parseRestoreTargetEvidence(value: unknown): RestoreTargetEvidence {
  const raw = exactObject(value, [
    "mode",
    "image",
    "dataIdentitySha256",
    "resourceBounds",
    "pinnedIndexingBehavior",
    "fulltextIndexes",
    "cleanup",
  ], "restore target evidence");
  if (raw.mode !== "isolated_pinned_container") {
    throw new Error("restore target evidence mode must be isolated_pinned_container");
  }

  const image = exactObject(raw.image, ["version", "digest"], "restore target evidence.image");
  if (
    image.version !== PINNED_RESTORE_TARGET_VERSION ||
    image.digest !== PINNED_RESTORE_TARGET_IMAGE_DIGEST
  ) {
    throw new Error("restore target evidence image is not the exact pinned version/digest");
  }
  if (
    typeof raw.dataIdentitySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.dataIdentitySha256)
  ) {
    throw new Error("restore target evidence data identity must be opaque lowercase SHA-256");
  }

  const resources = exactObject(
    raw.resourceBounds,
    [
      "memoryBytes",
      "memorySwapBytes",
      "nanoCpus",
      "pidsLimit",
      "rocksDbBlockCacheBytes",
      "rocksDbThreadCount",
      "rocksDbJobsCount",
      "rocksDbMaxConcurrentSubcompactions",
      "hnswCacheBytes",
      "memoryThresholdBytes",
      "httpMaxImportBodyBytes",
      "indexBuildResumeIntervalSeconds",
    ],
    "restore target evidence.resourceBounds",
  );
  const memoryBytes = exactApprovedResourceInteger(
    resources.memoryBytes,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.memoryBytes,
    "memoryBytes",
  );
  const memorySwapBytes = exactApprovedResourceInteger(
    resources.memorySwapBytes,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.memorySwapBytes,
    "memorySwapBytes",
  );
  const nanoCpus = exactApprovedResourceInteger(
    resources.nanoCpus,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.nanoCpus,
    "nanoCpus",
  );
  const pidsLimit = exactApprovedResourceInteger(
    resources.pidsLimit,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.pidsLimit,
    "pidsLimit",
  );
  const rocksDbBlockCacheBytes = exactApprovedResourceInteger(
    resources.rocksDbBlockCacheBytes,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.rocksDbBlockCacheBytes,
    "rocksDbBlockCacheBytes",
  );
  if (
    resources.rocksDbThreadCount !== 4 || resources.rocksDbJobsCount !== 4 ||
    resources.rocksDbMaxConcurrentSubcompactions !== 2 ||
    resources.indexBuildResumeIntervalSeconds !== 0
  ) {
    throw new Error("restore target evidence requires the exact proven RocksDB/index profile");
  }
  const hnswCacheBytes = exactApprovedResourceInteger(
    resources.hnswCacheBytes,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.hnswCacheBytes,
    "hnswCacheBytes",
  );
  const memoryThresholdBytes = exactApprovedResourceInteger(
    resources.memoryThresholdBytes,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.memoryThresholdBytes,
    "memoryThresholdBytes",
  );
  const httpMaxImportBodyBytes = exactApprovedResourceInteger(
    resources.httpMaxImportBodyBytes,
    APPROVED_RESTORE_TARGET_RESOURCE_BOUNDS.httpMaxImportBodyBytes,
    "httpMaxImportBodyBytes",
  );

  const pinnedIndexing = exactObject(
    raw.pinnedIndexingBehavior,
    ["probeRecords", "targetBytes", "maxRecords"],
    "restore target evidence.pinnedIndexingBehavior",
  );
  if (
    pinnedIndexing.probeRecords !== PINNED_SURREAL_INDEXING_BEHAVIOR.probeRecords ||
    pinnedIndexing.targetBytes !== PINNED_SURREAL_INDEXING_BEHAVIOR.targetBytes ||
    pinnedIndexing.maxRecords !== PINNED_SURREAL_INDEXING_BEHAVIOR.maxRecords
  ) {
    throw new Error(
      "restore target evidence pinned indexing behavior does not match the exact pinned binary",
    );
  }

  if (!Array.isArray(raw.fulltextIndexes)) {
    throw new Error("restore target evidence.fulltextIndexes должен быть array");
  }
  const fulltextIndexes = raw.fulltextIndexes.map((value, index) => {
    const parsed = exactObject(
      value,
      ["ordinal", "name", "table", "field", "analyzer", "state"],
      `restore target fulltext index[${index}]`,
    );
    return parsed;
  });
  if (
    fulltextIndexes.length !== EXPECTED_TARGET_FULLTEXT_INDEXES.length ||
    fulltextIndexes.some((actual, index) => {
      const expected = EXPECTED_TARGET_FULLTEXT_INDEXES[index]!;
      return Object.entries(expected).some(([key, expectedValue]) => actual[key] !== expectedValue);
    })
  ) {
    throw new Error(
      "restore target evidence requires the exact search_document_content ready index",
    );
  }

  const cleanup = exactObject(
    raw.cleanup,
    ["containerRemoved", "dataVolumeRemoved"],
    "restore target evidence.cleanup",
  );
  if (cleanup.containerRemoved !== true || cleanup.dataVolumeRemoved !== true) {
    throw new Error("restore target evidence cleanup is incomplete");
  }

  return {
    mode: "isolated_pinned_container",
    image: {
      version: PINNED_RESTORE_TARGET_VERSION,
      digest: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
    },
    dataIdentitySha256: raw.dataIdentitySha256,
    resourceBounds: {
      memoryBytes,
      memorySwapBytes,
      nanoCpus,
      pidsLimit,
      rocksDbBlockCacheBytes,
      rocksDbThreadCount: 4,
      rocksDbJobsCount: 4,
      rocksDbMaxConcurrentSubcompactions: 2,
      hnswCacheBytes,
      memoryThresholdBytes,
      httpMaxImportBodyBytes,
      indexBuildResumeIntervalSeconds: 0,
    },
    pinnedIndexingBehavior: { ...PINNED_SURREAL_INDEXING_BEHAVIOR },
    fulltextIndexes: EXPECTED_TARGET_FULLTEXT_INDEXES.map((index) => ({ ...index })),
    cleanup: {
      containerRemoved: true,
      dataVolumeRemoved: true,
    },
  };
}

/**
 * Converts only the exact terminal diagnostics emitted by the fixed restore
 * builder. Missing, duplicate, reordered or merely scheduled indexes fail.
 */
export function validateRestoreFulltextIndexReadiness(
  diagnostics: readonly RestoreIndexBuildDiagnostic[] | undefined,
): readonly RestoreTargetFulltextIndexEvidence[] {
  if (
    !Array.isArray(diagnostics) || diagnostics.length !== RESTORE_FULLTEXT_INDEX_DEFINITIONS.length
  ) {
    throw new Error("restore target requires exactly one core FULLTEXT ready diagnostic");
  }
  for (const [index, expected] of RESTORE_FULLTEXT_INDEX_DEFINITIONS.entries()) {
    const actual = diagnostics[index];
    if (
      !actual || actual.ordinal !== expected.ordinal || actual.name !== expected.name ||
      actual.table !== expected.table || actual.state !== "ready" || actual.category !== "ready" ||
      actual.status !== "ready"
    ) {
      throw new Error(`restore FULLTEXT readiness evidence ${expected.name} is missing or invalid`);
    }
  }
  return EXPECTED_TARGET_FULLTEXT_INDEXES.map((index) => ({ ...index }));
}

/**
 * RestoreIndexBuildError keeps only builders which have not reached `ready`.
 * Merge those with terminal ready diagnostics so finally-cleanup owns every
 * exact index whose DEFINE was accepted, including a ready first index when a
 * later index fails. The returned order is always the canonical start order;
 * removeStartedFulltextIndexes reverses it before issuing REMOVE INDEX.
 */
function startedFulltextIndexesFromBuildFailure(
  error: RestoreIndexBuildError,
): readonly RestoreFulltextIndexDefinition[] {
  const startedNames = new Set<string>();
  for (const candidate of error.startedIndexes) {
    const expected = RESTORE_FULLTEXT_INDEX_DEFINITIONS[candidate.ordinal - 1];
    if (
      expected && candidate.name === expected.name && candidate.table === expected.table &&
      candidate.field === expected.field && candidate.analyzer === expected.analyzer
    ) {
      startedNames.add(expected.name);
    }
  }
  for (const diagnostic of error.diagnostics) {
    if (diagnostic.state !== "ready") continue;
    const expected = RESTORE_FULLTEXT_INDEX_DEFINITIONS[diagnostic.ordinal - 1];
    if (
      expected && diagnostic.name === expected.name && diagnostic.table === expected.table
    ) {
      startedNames.add(expected.name);
    }
  }
  return RESTORE_FULLTEXT_INDEX_DEFINITIONS.filter((index) => startedNames.has(index.name));
}

/**
 * Fail-closed parser for the sole durable successful restore-report contract.
 * Status and migration must consume this API rather than implementing subsets.
 */
export function parsePersistedRestoreTestReport(value: unknown): PersistedRestoreTestReport {
  const raw = exactObject(value, [
    "formatVersion",
    "ok",
    "attemptId",
    "runId",
    "startedAt",
    "finishedAt",
    "createdAt",
    "namespace",
    "database",
    "archiveRoot",
    "rawArchiveRoot",
    "exportPath",
    "exportFile",
    "exportBytes",
    "exportSha256",
    "manifestPath",
    "manifestFile",
    "manifestSha256",
    "rawManifestSha256",
    "schemaVersion",
    "searchDocuments",
    "chunks",
    "checks",
    "target",
    "cleanup",
  ], "persisted restore report");
  if (raw.formatVersion !== PERSISTED_RESTORE_REPORT_FORMAT_VERSION || raw.ok !== true) {
    throw new Error("persisted restore report formatVersion/ok невалиден");
  }
  if (
    typeof raw.attemptId !== "string" || !/^[0-9a-f]{32}$/u.test(raw.attemptId) ||
    typeof raw.runId !== "string" || raw.runId.length === 0 || raw.runId.length > 200 ||
    /[\r\n\u0000-\u001f]/u.test(raw.runId) ||
    typeof raw.namespace !== "string" || !isRestoreNamespace(raw.namespace) ||
    raw.namespace !== `${RESTORE_NAMESPACE}_${raw.attemptId}` ||
    typeof raw.database !== "string" || raw.database.length === 0 ||
    /[\r\n\u0000-\u001f]/u.test(raw.database)
  ) {
    throw new Error("persisted restore report identity binding невалиден");
  }

  const startedAt = exactIso(raw.startedAt, "persisted restore report.startedAt");
  const finishedAt = exactIso(raw.finishedAt, "persisted restore report.finishedAt");
  const createdAt = exactIso(raw.createdAt, "persisted restore report.createdAt");
  if (Date.parse(startedAt) > Date.parse(finishedAt) || Date.parse(finishedAt) > Date.parse(createdAt)) {
    throw new Error("persisted restore report timestamps out of order");
  }

  const strings = [
    "archiveRoot",
    "rawArchiveRoot",
    "exportPath",
    "exportFile",
    "exportSha256",
    "manifestPath",
    "manifestFile",
    "manifestSha256",
    "rawManifestSha256",
  ] as const;
  for (const field of strings) {
    if (typeof raw[field] !== "string" || !(raw[field] as string).length) {
      throw new Error(`persisted restore report.${field} невалиден`);
    }
  }
  const archiveRoot = raw.archiveRoot as string;
  const rawArchiveRoot = raw.rawArchiveRoot as string;
  const exportPath = raw.exportPath as string;
  const manifestPath = raw.manifestPath as string;
  const exportFile = raw.exportFile as string;
  const manifestFile = raw.manifestFile as string;
  if (
    !path.isAbsolute(archiveRoot) || path.resolve(archiveRoot) !== archiveRoot ||
    rawArchiveRoot !== archiveRoot ||
    !path.isAbsolute(exportPath) || path.resolve(exportPath) !== exportPath ||
    !path.isAbsolute(manifestPath) || path.resolve(manifestPath) !== manifestPath ||
    path.basename(exportFile) !== exportFile || path.basename(exportPath) !== exportFile ||
    path.basename(manifestFile) !== manifestFile || path.basename(manifestPath) !== manifestFile ||
    exportPath !== path.join(archiveRoot, "backups", "surreal", exportFile) ||
    manifestPath !== path.join(archiveRoot, "backups", "manifests", manifestFile) ||
    manifestPathForExport(exportPath) !== manifestPath
  ) {
    throw new Error("persisted restore report archive/export/manifest path binding невалиден");
  }
  const schemaVersion = raw.schemaVersion;
  if (
    !Number.isSafeInteger(raw.exportBytes) || (raw.exportBytes as number) < 1 ||
    (typeof schemaVersion !== "number" || !isSupportedBackupSchemaVersion(schemaVersion)) ||
    !Number.isSafeInteger(raw.searchDocuments) || (raw.searchDocuments as number) < 0 ||
    !Number.isSafeInteger(raw.chunks) || (raw.chunks as number) < 0
  ) {
    throw new Error("persisted restore report numeric binding невалиден");
  }
  for (const field of ["exportSha256", "manifestSha256", "rawManifestSha256"] as const) {
    if (!/^[0-9a-f]{64}$/u.test(raw[field] as string)) {
      throw new Error(`persisted restore report.${field} невалиден`);
    }
  }

  const cleanup = exactObject(
    raw.cleanup,
    ["databaseClosed", "temporaryExportRemoved", "namespaceRemoved"],
    "persisted restore report.cleanup",
  );
  if (
    cleanup.databaseClosed !== true || cleanup.temporaryExportRemoved !== true ||
    cleanup.namespaceRemoved !== true
  ) {
    throw new Error("persisted restore report cleanup is incomplete");
  }

  if (!Array.isArray(raw.checks)) throw new Error("persisted restore report.checks невалиден");
  const checks = raw.checks.map((value, index): RestoreCheck => {
    const check = exactObject(value, ["name", "ok", "detail"], `restore check[${index}]`);
    if (
      typeof check.name !== "string" || check.name.length === 0 || check.ok !== true ||
      typeof check.detail !== "string" || check.detail.length === 0 || check.detail.length > 2048
    ) {
      throw new Error(`restore check[${index}] failed or invalid`);
    }
    return { name: check.name, ok: true, detail: check.detail };
  });
  const searchDocuments = raw.searchDocuments as number;
  const probeNames = checks
    .map((check) => check.name)
    .filter((name) => /^search: probe_[1-3]$/u.test(name));
  if (
    (searchDocuments === 0 && probeNames.length !== 0) ||
    (searchDocuments > 0 && (probeNames.length < 1 || probeNames.length > SEARCH_PROBE_LIMIT))
  ) {
    throw new Error("persisted restore report BM25 probe cardinality невалиден");
  }
  const expectedNames = expectedSuccessfulRestoreCheckNames(
    searchDocuments,
    probeNames.length,
    schemaVersion,
  );
  const actualNames = checks.map((check) => check.name);
  if (
    new Set(actualNames).size !== actualNames.length ||
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("persisted restore report checks are missing, duplicated, unknown, or reordered");
  }

  return {
    formatVersion: PERSISTED_RESTORE_REPORT_FORMAT_VERSION,
    ok: true,
    attemptId: raw.attemptId,
    runId: raw.runId,
    startedAt,
    finishedAt,
    createdAt,
    namespace: raw.namespace,
    database: raw.database,
    archiveRoot,
    rawArchiveRoot,
    exportPath,
    exportFile,
    exportBytes: raw.exportBytes as number,
    exportSha256: raw.exportSha256 as string,
    manifestPath,
    manifestFile,
    manifestSha256: raw.manifestSha256 as string,
    rawManifestSha256: raw.rawManifestSha256 as string,
    schemaVersion,
    searchDocuments,
    chunks: raw.chunks as number,
    checks,
    target: parseRestoreTargetEvidence(raw.target),
    cleanup: {
      databaseClosed: true,
      temporaryExportRemoved: true,
      namespaceRemoved: true,
    },
  };
}

async function verifyContainingOffDeviceBundle(
  rawArchiveRoot: string,
  exportPath: string,
  manifestPath: string,
): Promise<void> {
  if (path.basename(rawArchiveRoot) !== "archive") return;
  const bundleRoot = path.dirname(rawArchiveRoot);
  const bundleManifestPath = path.join(bundleRoot, OFF_DEVICE_MANIFEST_FILE);
  try {
    await lstat(bundleManifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const verification = await verifyOffDeviceBackup(bundleRoot);
  if (!verification.ok) {
    throw new Error(
      `off-device bundle verification failed: ${verification.issues[0]?.path ?? "?"} ` +
        `(${verification.issues[0]?.reason ?? "unknown"})`,
    );
  }
  const bundleManifest = JSON.parse(
    await readFile(bundleManifestPath, "utf8"),
  ) as OffDeviceManifest;
  const expectedExport = path.join(rawArchiveRoot, "backups", "surreal", path.basename(exportPath));
  const expectedManifest = path.join(
    rawArchiveRoot,
    "backups",
    "manifests",
    path.basename(manifestPath),
  );
  if (path.resolve(exportPath) !== path.resolve(expectedExport) ||
      path.resolve(manifestPath) !== path.resolve(expectedManifest)) {
    throw new Error("selected export/manifest не принадлежат проверенному off-device bundle");
  }
  const payloadPaths = new Set(bundleManifest.files.map((file) => file.path));
  const relativeExport = path.relative(bundleRoot, expectedExport).replaceAll(path.sep, "/");
  const relativeManifest = path.relative(bundleRoot, expectedManifest).replaceAll(path.sep, "/");
  if (!payloadPaths.has(relativeExport) || !payloadPaths.has(relativeManifest)) {
    throw new Error("off-device manifest не аутентифицирует selected export/manifest");
  }
}

export async function runRestoreTest(
  cfg: AppConfig,
  options: RestoreTestOptions = {},
  dependencyOverrides: Partial<RestoreTestDependencies> = {},
): Promise<RestoreTestReport> {
  const dependencies: RestoreTestDependencies = {
    ...DEFAULT_RESTORE_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const attemptUuid = randomUUID();
  const attemptId = attemptUuid.replaceAll("-", "");
  const namespace = createRestoreNamespace(attemptUuid);
  const startedAt = new Date().toISOString();
  const checks: RestoreCheck[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  let stage: RestoreAttemptStage = "input_validation";
  let failureCode = "input_validation_failed";
  let exportPath: string | undefined;
  let manifestPath: string | undefined;
  let rawArchiveRoot: string | undefined;
  let manifest: BackupManifest | undefined;
  let manifestSha256: string | undefined;
  let exportSha256: string | undefined;
  let exportBytes: number | undefined;
  let tmpExport: string | undefined;
  let tmpImport: string | undefined;
  let restored: Surreal | undefined;
  let namespaceTouched = false;
  let completedReport: Omit<RestoreTestReport, "finishedAt" | "cleanup" | "target"> | undefined;
  let primaryError: unknown;
  let primaryFailure: RestoreAttemptFailure | undefined;
  let importTransport: StreamHttpUploadFailureEvidence | undefined;
  let indexBuilds: readonly RestoreIndexBuildDiagnostic[] | undefined;
  let fulltextIndexes: readonly RestoreTargetFulltextIndexEvidence[] = [];
  let staticTargetEvidence: RestoreTargetEvidence | undefined;
  let startedIndexes: readonly RestoreFulltextIndexDefinition[] = [];
  const cleanupFailures: RestoreTestFailureEvidence["cleanupFailures"] = [];

  try {
    if (!dependencies.resolveTargetEvidence) {
      failureCode = options.targetEvidence === undefined
        ? "target_evidence_required"
        : "target_evidence_invalid";
      if (options.targetEvidence === undefined) {
        throw new Error("strict isolated restore target evidence is required");
      }
      staticTargetEvidence = parseRestoreTargetEvidence(options.targetEvidence);
    }
    throwIfRestoreCancelled(options.signal);
    exportPath = await assertRegularNonSymlinkFile(
      options.exportPath ?? (await latestExportPath(cfg.archiveRoot)),
      "logical export",
    );
    rawArchiveRoot = path.resolve(options.rawArchiveRoot ?? cfg.archiveRoot);
    throwIfRestoreCancelled(options.signal);

    stage = "manifest_validation";
    failureCode = "manifest_validation_failed";
    manifestPath = await assertRegularNonSymlinkFile(
      manifestPathForExport(exportPath),
      "logical backup manifest",
    );
    const manifestText = await readFile(manifestPath, "utf8");
    manifest = parseBackupManifest(JSON.parse(manifestText), manifestPath);
    if (manifest.exportFile !== path.basename(exportPath)) {
      failureCode = "manifest_export_binding_failed";
      throw new Error("logical manifest is not bound to the selected export");
    }
    const relationalChecks = restoreRelationalChecksForSchemaVersion(manifest.schemaVersion);
    if (!manifest.rawManifestSha256) {
      failureCode = "raw_manifest_hash_required";
      throw new Error("schema 4/5 restore manifest requires rawManifestSha256");
    }
    if (manifest.database !== cfg.surrealDatabase) {
      failureCode = "manifest_database_binding_failed";
      throw new Error("logical manifest database does not match restore target database");
    }
    manifestSha256 = (await hashFile(manifestPath)).sha256;
    throwIfRestoreCancelled(options.signal);

    stage = "bundle_integrity";
    failureCode = "bundle_integrity_failed";
    await verifyContainingOffDeviceBundle(rawArchiveRoot, exportPath, manifestPath);
    throwIfRestoreCancelled(options.signal);

    // Integrity is checked before namespace creation/import. A corrupt archive
    // can therefore produce durable evidence without mutating the DB server.
    stage = "export_integrity";
    failureCode = "export_integrity_failed";
    const exportHashes = await hashFile(exportPath);
    if (exportHashes.sha256 !== manifest.exportSha256) {
      failureCode = "export_sha256_mismatch";
      throw new Error("logical export SHA-256 mismatch");
    }
    if (exportHashes.sizeBytes !== manifest.exportBytes) {
      failureCode = "export_size_mismatch";
      throw new Error("logical export byte length mismatch");
    }
    exportSha256 = exportHashes.sha256;
    exportBytes = exportHashes.sizeBytes;
    throwIfRestoreCancelled(options.signal);

    stage = "temporary_export";
    failureCode = "temporary_export_failed";
    const temporary = await createExclusiveTemporaryFile(os.tmpdir(), "baka-restore.surql");
    tmpExport = temporary.path;
    await temporary.close();
    throwIfRestoreCancelled(options.signal);

    // The unique namespace makes this idempotent cleanup local to one attempt;
    // concurrent drills can never remove each other's database.
    stage = "namespace_prepare";
    failureCode = "namespace_prepare_failed";
    namespaceTouched = true;
    await dependencies.removeNamespace(cfg, namespace);
    throwIfRestoreCancelled(options.signal);

    stage = "decompress";
    failureCode = "decompress_failed";
    await dependencies.decompress(exportPath, tmpExport);
    throwIfRestoreCancelled(options.signal);

    // Surreal export defines FULLTEXT indexes before data. Strip both owned
    // BM25 definitions before import, but rebuild only the core
    // search_document index. Canonical chunks remain fully restored and
    // validated without the optional global forensic index.
    stage = "index_reorder";
    failureCode = "index_reorder_failed";
    tmpImport = `${tmpExport}.without-fulltext.surql`;
    const restoreRecordCounts = manifest.recordCounts;
    const requireExpectedIndexes = ["search_document", "chunk"].some(
      (table) => Object.prototype.hasOwnProperty.call(restoreRecordCounts, table),
    );
    const deferredIndexStatements = await reorderImportFile(tmpExport, tmpImport, {
      requireExpectedIndexes,
    });
    throwIfRestoreCancelled(options.signal);

    // Native curl/libcurl starts sending the file immediately with exact
    // Content-Length and bounded backpressure. Bun fetch(Bun.file(...)) and
    // Bun's node:http compatibility path can buffer or stall large imports.
    stage = "import";
    failureCode = "import_failed";
    await dependencies.uploadFile({
      url: `${httpBaseUrl(cfg)}/import`,
      headers: {
        ...httpHeaders(cfg, namespace, cfg.surrealDatabase),
        Accept: "application/json",
      },
      sourcePath: tmpImport,
      signal: options.signal,
      operation: "restore import",
    });
    throwIfRestoreCancelled(options.signal);

    // Build core BM25/HIGHLIGHTS once over fully imported search documents
    // instead of updating the index for every INSERT batch in the export.
    if (deferredIndexStatements.length > 0) {
      stage = "index_build";
      failureCode = "index_build_failed";
      throwIfRestoreCancelled(options.signal);
      indexBuilds = await dependencies.buildDeferredIndexes(
        cfg,
        namespace,
        cfg.surrealDatabase,
        deferredIndexStatements,
        options.signal,
      );
      // A fulfilled builder contract means the validated core DEFINE was
      // accepted and reached ready. Retain ownership through all later
      // verification/failure paths so finally always removes them first.
      startedIndexes = RESTORE_FULLTEXT_INDEX_DEFINITIONS;
      throwIfRestoreCancelled(options.signal);
    }
    stage = "connect";
    failureCode = "connect_failed";
    restored = await dependencies.connectDb(cfg, namespace);
    throwIfRestoreCancelled(options.signal);

    stage = "verification";
    failureCode = "verification_failed";
    // 1. record counts против manifest'а
    const embeddingTables = await ownedEmbeddingTables(restored);
    throwIfRestoreCancelled(options.signal);
    const tables = validateRecordCountTables(
      manifest.recordCounts,
      embeddingTables,
      manifest.schemaVersion,
    );
    let mismatches = 0;
    for (const table of tables) {
      throwIfRestoreCancelled(options.signal);
      const expected = manifest.recordCounts[table]!;
      // SELECT по неопределённой таблице в 3.2.3 — ошибка, а не 0 строк:
      // неполный импорт фиксируем как failed check, а не исключение.
      let actual: number | null = null;
      try {
        actual = await countOf(restored, table);
      } catch {
        actual = null;
      }
      throwIfRestoreCancelled(options.signal);
      if (actual !== expected) {
        mismatches += 1;
        push(
          "record_counts",
          false,
          `${table}: manifest ${expected}, restored ${actual ?? "таблица отсутствует"}`,
        );
      }
    }
    if (mismatches === 0) {
      push(
        "record_counts",
        true,
        `${Object.keys(manifest.recordCounts).length} таблиц совпали с manifest'ом`,
      );
    }

    // 2. Referential invariants are derived solely from restored data.
    for (const [name, sql] of relationalChecks) {
      throwIfRestoreCancelled(options.signal);
      const inRestored = (await selectOne<{ n: number }>(restored, sql))?.n ?? 0;
      push(
        `invariant: ${name}`,
        inRestored === 0,
        `restored ${inRestored} нарушений`,
      );
    }
    const invalidSourceChunks = await invalidSearchSourceChunks(restored);
    throwIfRestoreCancelled(options.signal);
    push(
      "invariant: search_document.source_chunks ownership",
      invalidSourceChunks === 0,
      `restored ${invalidSourceChunks} нарушений`,
    );
    const embeddingIssues = await validateEmbeddingState(restored);
    throwIfRestoreCancelled(options.signal);
    push(
      "invariant: embedding physical ownership/vector symmetry",
      embeddingIssues.length === 0,
      embeddingIssues.length === 0
        ? "restored 0 нарушений"
        : `${embeddingIssues.length} нарушений; первое: ${embeddingIssues[0]!.check}`,
    );

    // Диалоги без current_revision допустимы для отклонённых revisions;
    // standalone report records the restored count without live comparison.
    const noCurrentSql = "SELECT count() AS n FROM dialogue WHERE current_revision IS NONE GROUP ALL";
    const noCurrentRestored = (await selectOne<{ n: number }>(restored, noCurrentSql))?.n ?? 0;
    throwIfRestoreCancelled(options.signal);
    push("info: dialogue без current_revision", true, `restored ${noCurrentRestored}`);

    // 3. Search expectations are derived from the authenticated restored
    // export and require nonzero BM25 hits whenever the projection is nonempty.
    checks.push(...await verifyRestoredSearch(
      restored,
      manifest.recordCounts.search_document ?? 0,
    ));
    throwIfRestoreCancelled(options.signal);
    // 4. Raw references are checked only against the selected local/bundle
    // root. Failure details deliberately contain counts, never private paths.
    const rawManifest = await buildRawManifest(restored);
    throwIfRestoreCancelled(options.signal);
    const rawReport = await verifyRawFiles(rawArchiveRoot, rawManifest);
    throwIfRestoreCancelled(options.signal);
    push(
      "raw references",
      rawReport.ok,
      rawReport.ok
        ? `${rawReport.checked}/${rawManifest.count} raw-файлов на диске, size+sha256 совпали`
        : `missing ${rawReport.missing.length}, size ${rawReport.sizeMismatch.length}, hash ${rawReport.hashMismatch.length}, unsafe ${rawReport.unsafe.length}`,
    );
    const actualRawHash = hashRawManifest(rawManifest);
    push(
      "raw manifest hash",
      actualRawHash === manifest.rawManifestSha256,
      `manifest ${manifest.rawManifestSha256.slice(0, 12)}…, restored ${actualRawHash.slice(0, 12)}…`,
    );

    const ok = checks.every((check) => check.ok);
    if (!ok) {
      failureCode = "verification_failed";
      throw new Error("one or more restore verification checks failed");
    }
    stage = "index_build";
    failureCode = "index_readiness_evidence_invalid";
    fulltextIndexes = validateRestoreFulltextIndexReadiness(indexBuilds);
    stage = "verification";
    failureCode = "verification_failed";
    completedReport = {
      formatVersion: PERSISTED_RESTORE_REPORT_FORMAT_VERSION,
      ok: true,
      attemptId,
      startedAt,
      database: cfg.surrealDatabase,
      archiveRoot: rawArchiveRoot,
      rawArchiveRoot,
      exportPath,
      exportFile: path.basename(exportPath),
      exportBytes,
      exportSha256,
      manifestPath,
      manifestFile: path.basename(manifestPath),
      manifestSha256,
      rawManifestSha256: manifest.rawManifestSha256,
      schemaVersion: manifest.schemaVersion,
      searchDocuments: manifest.recordCounts.search_document ?? 0,
      chunks: manifest.recordCounts.chunk ?? 0,
      namespace,
      checks,
    };
  } catch (error) {
    if (stage === "import" && error instanceof StreamHttpUploadError) {
      importTransport = error.evidence;
    }
    if (stage === "index_build" && error instanceof RestoreIndexBuildError) {
      indexBuilds = error.diagnostics;
      startedIndexes = startedFulltextIndexesFromBuildFailure(error);
    } else if (stage === "index_build" && options.signal?.aborted) {
      // A custom builder may not provide started-index evidence. Removing the
      // complete fixed allowlist is safe in this unique namespace (`IF EXISTS`)
      // and prevents cancellation from orphaning a concurrently building index.
      startedIndexes = RESTORE_FULLTEXT_INDEX_DEFINITIONS;
    } else if (stage === "index_build") {
      // A custom builder can return malformed/missing terminal evidence after
      // issuing DEFINE. Own the complete fixed allowlist for conservative
      // cleanup; the unique namespace makes this safe.
      startedIndexes = RESTORE_FULLTEXT_INDEX_DEFINITIONS;
    }
    primaryError = error;
    primaryFailure = {
      stage,
      code: options.signal?.aborted ? "cancelled" : failureCode,
    };
  } finally {
    if (restored) {
      try {
        await restored.close();
      } catch {
        cleanupFailures.push("database_close");
      }
    }
    let temporaryCleanupFailed = false;
    for (const temporaryPath of [tmpImport, tmpExport]) {
      if (temporaryPath) {
        try {
          await rm(temporaryPath, { force: true });
        } catch {
          temporaryCleanupFailed = true;
        }
      }
    }
    if (temporaryCleanupFailed) cleanupFailures.push("temporary_export_remove");
    if (namespaceTouched) {
      if (startedIndexes.length > 0) {
        try {
          await dependencies.removeDeferredIndexes(
            cfg,
            namespace,
            cfg.surrealDatabase,
            startedIndexes,
          );
        } catch {
          cleanupFailures.push("index_remove");
        }
      }
      try {
        await dependencies.removeNamespace(cfg, namespace);
      } catch {
        cleanupFailures.push("namespace_remove");
      }
    }
  }

  // A signal arriving during the cleanup window must still prevent success
  // publication. Cleanup itself intentionally ignores the caller signal and
  // remains bounded by its own index/root-SQL deadlines.
  if (!primaryFailure && options.signal?.aborted) {
    primaryError = new Error("restore test cancelled");
    primaryFailure = { stage: "cleanup", code: "cancelled" };
  }

  // Target lifecycle teardown is deliberately later than DB/index/namespace
  // cleanup and earlier than any publishable success. F24 can inject a late
  // resolver; static callers may provide already-final strict evidence.
  let targetEvidence: RestoreTargetEvidence | undefined;
  if (dependencies.resolveTargetEvidence) {
    let resolved: unknown;
    try {
      resolved = await dependencies.resolveTargetEvidence(options.targetEvidence, {
        attemptId,
        verificationSucceeded: completedReport !== undefined && primaryFailure === undefined,
        restoreCleanupComplete: cleanupFailures.length === 0,
        fulltextIndexes,
      });
    } catch (error) {
      if (!cleanupFailures.includes("target_cleanup")) cleanupFailures.push("target_cleanup");
      if (!primaryFailure) {
        primaryError = error;
        primaryFailure = { stage: "cleanup", code: "target_cleanup_failed" };
      }
    }
    if (!primaryFailure && cleanupFailures.length === 0) {
      try {
        targetEvidence = parseRestoreTargetEvidence(resolved);
      } catch (error) {
        primaryError = error;
        primaryFailure = { stage: "target_validation", code: "target_evidence_invalid" };
      }
    }
  } else if (!primaryFailure && cleanupFailures.length === 0) {
    targetEvidence = staticTargetEvidence;
  }

  if (primaryFailure || cleanupFailures.length > 0) {
    const failure = primaryFailure ?? { stage: "cleanup" as const, code: "cleanup_failed" };
    throw new RestoreTestAttemptError(
      {
        formatVersion: 1,
        ok: false,
        attemptId,
        startedAt,
        namespace,
        ...(exportPath ? { exportFile: path.basename(exportPath) } : {}),
        ...(exportBytes !== undefined ? { exportBytes } : {}),
        ...(exportSha256 ? { exportSha256 } : {}),
        ...(manifestPath ? { manifestFile: path.basename(manifestPath) } : {}),
        ...(manifestSha256 ? { manifestSha256 } : {}),
        ...(manifest?.schemaVersion !== undefined &&
            isSupportedBackupSchemaVersion(manifest.schemaVersion)
          ? { schemaVersion: manifest.schemaVersion }
          : {}),
        checks,
        failure,
        ...(importTransport ? { importTransport } : {}),
        ...(indexBuilds ? { indexBuilds } : {}),
        cleanupFailures,
      },
      primaryError,
    );
  }
  if (!completedReport) {
    throw new RestoreTestAttemptError(
      {
        formatVersion: 1,
        ok: false,
        attemptId,
        startedAt,
        namespace,
        checks,
        failure: { stage: "verification", code: "missing_report" },
        cleanupFailures,
      },
    );
  }
  if (!targetEvidence) {
    throw new RestoreTestAttemptError(
      {
        formatVersion: 1,
        ok: false,
        attemptId,
        startedAt,
        namespace,
        checks,
        failure: { stage: "target_validation", code: "target_evidence_missing" },
        cleanupFailures,
      },
    );
  }
  return {
    ...completedReport,
    target: targetEvidence,
    finishedAt: new Date().toISOString(),
    cleanup: {
      databaseClosed: true,
      temporaryExportRemoved: true,
      namespaceRemoved: true,
    },
  };
}
