/**
 * Post-import operator exclusions for narrowly defined irreducible legacy rows.
 *
 * This module deliberately does not change migration reconciliation.  The
 * historical row remains `quarantined` and continues to point at its durable
 * migration_quarantine record.  A signed exclusion only adjudicates the
 * current unresolved state through resolved_at/resolution and schema-5
 * migration_meta evidence.
 */

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import {
  assertOpenAuthenticatedRegularFileUnchanged,
  assertRegularNonSymlinkFile,
  authenticateRegularFileIdentity,
  openAuthenticatedRegularFile,
  writePrivateFileAtomicNoClobber,
} from "../backup/safety.ts";
import { checkSchemaVersion } from "../db/migrations.ts";
import { selectAll, selectOne } from "../db/repositories/helpers.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import {
  canonicalMigrationJson,
  migrationApprovalKeyFingerprint,
  migrationArtifactSha256,
  type MigrationApprovalTrustAnchor,
} from "./authorization.ts";
import {
  isLegacySourceDeleted,
  LEGACY_TABLES,
  legacyRowPayload,
  LegacySnapshotReader,
  type LegacySqlRow,
  type LegacyTable,
  type LegacyThreadRecordRow,
} from "./legacy-reader.ts";
import type { MigrationReconciliation, MigrationRunReport } from "./reconciliation.ts";

export const OPERATOR_EXCLUSION_FORMAT_VERSION = 1;
export const OPERATOR_EXCLUSION_BATCH_SIZE = 500;
export const OPERATOR_EXCLUSION_CODES = [
  "active_original_without_exact_dialogue",
  "deleted_original_unrecoverable_no_messages",
  "canonical_child_of_excluded_active_thread",
  "source_less_record_of_excluded_active_thread",
] as const;

export type OperatorExclusionCode = (typeof OPERATOR_EXCLUSION_CODES)[number];

export interface OperatorExclusionRow {
  quarantineId: string;
  migrationId: string;
  lineageKey: string;
  legacyTable: LegacyTable;
  legacyId: string;
  exclusionCode: OperatorExclusionCode;
  reasonSha256: string;
  rawPayloadSha256: string;
  parserName: string;
  parserVersion: string;
  attempts: number;
  lastFailedAt: string;
}

export interface OperatorExclusionArtifact {
  kind: "baka-legacy-operator-exclusions";
  formatVersion: 1;
  createdAt: string;
  sourceMigrationId: string;
  sourceReportSha256: string;
  snapshotSha256: string;
  rowSetSha256: string;
  counts: Record<OperatorExclusionCode, number>;
  rows: OperatorExclusionRow[];
  artifactSha256: string;
}

export interface OperatorExclusionAttestationPayload {
  artifactFileSha256: string;
  artifactSha256: string;
  rowSetSha256: string;
  sourceMigrationId: string;
  snapshotSha256: string;
  issuedAt: string;
}

export interface OperatorExclusionAttestation {
  kind: "baka-legacy-operator-exclusions-attestation";
  formatVersion: 1;
  keyFingerprint: string;
  payload: OperatorExclusionAttestationPayload;
  signature: string;
}

export interface OperatorExclusionReport {
  kind: "baka-legacy-operator-exclusion-report";
  formatVersion: 1;
  createdAt: string;
  state: "accepted_with_operator_exclusions";
  acceptanceId: string;
  sourceMigrationId: string;
  snapshotSha256: string;
  artifactSha256: string;
  artifactFileSha256: string;
  attestationSha256: string;
  rowSetSha256: string;
  reconciliation: MigrationReconciliation;
  excludedRows: number;
  excludedLineages: number;
  excludedByCode: Record<OperatorExclusionCode, number>;
  unresolved: 0;
  invalidResolutions: 0;
  reportPath: string;
}

export interface MigrationQuarantineLifecycle {
  state: "blocked" | "complete" | "accepted_with_operator_exclusions";
  unresolved: number;
  documentedOperatorExclusions: number;
  documentedOperatorExclusionLineages: number;
  retryResolved: number;
  supersededOperatorExclusions: number;
  invalidResolutions: number;
  byCode: Record<OperatorExclusionCode, number>;
  issues: Array<{ check: string; detail: string }>;
}

interface QuarantineRow {
  id: RecordId;
  migration: RecordId;
  legacy_table: LegacyTable;
  legacy_id: string;
  raw_payload: Record<string, unknown>;
  reason: string;
  parser_name: string;
  parser_version: string;
  retryable: boolean;
  attempts: number;
  lineage_key: string;
  previous_attempt?: RecordId;
  first_failed_at: Date | string;
  last_failed_at: Date | string;
  resolved_at?: Date | string;
  resolution?: string;
}

interface MigrationMetaRow {
  id: RecordId;
  status: string;
  started_at: Date | string;
  finished_at?: Date | string;
  legacy_db_path?: string;
  legacy_db_sha256?: string;
  counters?: unknown;
  notes?: string;
  approval_artifact_sha256?: string;
  approval_file_sha256?: string;
  approval_attestation_sha256?: string;
  approval_key_fingerprint?: string;
  host_mapping_artifact_sha256?: string;
  report_path?: string;
  report_sha256?: string;
  report_size_bytes?: number;
}

interface AcceptanceNotes {
  kind: "baka-legacy-operator-exclusion-evidence";
  formatVersion: 1;
  sourceMigrationId: string;
  artifactPath: string;
  attestationPath: string;
  publicKeyPem: string;
  artifactSha256: string;
  rowSetSha256: string;
}

interface ExactEligibility {
  codes: Map<string, OperatorExclusionCode>;
  payloads: Map<string, Record<string, unknown>>;
}

const SHA256_RE = /^[a-f0-9]{64}$/u;
const RESOLUTION_RE = /^operator_excluded:v1:([a-z_]+):(.+):([a-f0-9]{64})$/u;
const RETRY_RESOLUTION_RE = /^retry_mapped:(.+)$/u;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (canonicalMigrationJson(actual) !== canonicalMigrationJson(expected)) {
    throw new Error(`${label} fields are incomplete or unknown`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredSha(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!SHA256_RE.test(parsed)) throw new Error(`${label} must be lowercase SHA-256`);
  return parsed;
}

function requiredIso(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  return parsed;
}

function iso(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is not a valid timestamp`);
  return date.toISOString();
}

function requiredInt(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function exclusionCode(value: unknown, label: string): OperatorExclusionCode {
  if (!(OPERATOR_EXCLUSION_CODES as readonly unknown[]).includes(value)) {
    throw new Error(`${label} is not a reviewed operator exclusion code`);
  }
  return value as OperatorExclusionCode;
}

function parseRecordId(value: string, table: string): RecordId {
  const prefix = `${table}:`;
  if (!value.startsWith(prefix)) throw new Error(`invalid ${table} record id: ${value}`);
  const encoded = value.slice(prefix.length);
  let key: string;
  if (/^[a-zA-Z0-9_]+$/u.test(encoded)) {
    key = encoded;
  } else if (encoded.startsWith("⟨") && encoded.endsWith("⟩")) {
    key = encoded.slice(1, -1);
    if (!key || /[\u0000-\u001f\u007f⟨⟩]/u.test(key)) {
      throw new Error(`invalid ${table} record id: ${value}`);
    }
  } else {
    throw new Error(`invalid ${table} record id: ${value}`);
  }
  const parsed = new RecordId(table, key);
  if (String(parsed) !== value) throw new Error(`non-canonical ${table} record id: ${value}`);
  return parsed;
}

function emptyCounts(): Record<OperatorExclusionCode, number> {
  return {
    active_original_without_exact_dialogue: 0,
    deleted_original_unrecoverable_no_messages: 0,
    canonical_child_of_excluded_active_thread: 0,
    source_less_record_of_excluded_active_thread: 0,
  };
}

function normalizedCounts(rows: readonly OperatorExclusionRow[]): Record<OperatorExclusionCode, number> {
  const counts = emptyCounts();
  for (const row of rows) counts[row.exclusionCode] += 1;
  return counts;
}

function artifactBody(artifact: Omit<OperatorExclusionArtifact, "artifactSha256">): Omit<OperatorExclusionArtifact, "artifactSha256"> {
  return artifact;
}

export function parseOperatorExclusionArtifact(value: unknown): OperatorExclusionArtifact {
  const root = record(value, "operator exclusion artifact");
  exactKeys(root, [
    "kind", "formatVersion", "createdAt", "sourceMigrationId", "sourceReportSha256",
    "snapshotSha256", "rowSetSha256", "counts", "rows", "artifactSha256",
  ], "operator exclusion artifact");
  if (root.kind !== "baka-legacy-operator-exclusions" ||
      root.formatVersion !== OPERATOR_EXCLUSION_FORMAT_VERSION) {
    throw new Error("unsupported operator exclusion artifact");
  }
  const rowsRaw = root.rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    throw new Error("operator exclusion artifact rows must be non-empty");
  }
  const seenQuarantine = new Set<string>();
  const rows = rowsRaw.map((item, index): OperatorExclusionRow => {
    const row = record(item, `operator exclusion rows[${index}]`);
    exactKeys(row, [
      "quarantineId", "migrationId", "lineageKey", "legacyTable", "legacyId",
      "exclusionCode", "reasonSha256", "rawPayloadSha256", "parserName",
      "parserVersion", "attempts", "lastFailedAt",
    ], `operator exclusion rows[${index}]`);
    const legacyTable = requiredString(row.legacyTable, `rows[${index}].legacyTable`) as LegacyTable;
    if (![
      "agent_systems", "projects", "source_files", "raw_backups", "threads",
      "thread_records", "messages", "message_chunks",
    ].includes(legacyTable)) throw new Error(`rows[${index}].legacyTable invalid`);
    const parsed: OperatorExclusionRow = {
      quarantineId: requiredString(row.quarantineId, `rows[${index}].quarantineId`),
      migrationId: requiredString(row.migrationId, `rows[${index}].migrationId`),
      lineageKey: requiredString(row.lineageKey, `rows[${index}].lineageKey`),
      legacyTable,
      legacyId: requiredString(row.legacyId, `rows[${index}].legacyId`),
      exclusionCode: exclusionCode(row.exclusionCode, `rows[${index}].exclusionCode`),
      reasonSha256: requiredSha(row.reasonSha256, `rows[${index}].reasonSha256`),
      rawPayloadSha256: requiredSha(row.rawPayloadSha256, `rows[${index}].rawPayloadSha256`),
      parserName: requiredString(row.parserName, `rows[${index}].parserName`),
      parserVersion: requiredString(row.parserVersion, `rows[${index}].parserVersion`),
      attempts: requiredInt(row.attempts, `rows[${index}].attempts`, 1),
      lastFailedAt: requiredIso(row.lastFailedAt, `rows[${index}].lastFailedAt`),
    };
    try {
      parseRecordId(parsed.quarantineId, "migration_quarantine");
      parseRecordId(parsed.migrationId, "migration_meta");
    } catch {
      throw new Error(`rows[${index}] record identity mismatch`);
    }
    if (parsed.lineageKey !== `${parsed.legacyTable}:${parsed.legacyId}`) {
      throw new Error(`rows[${index}] record identity mismatch`);
    }
    if (seenQuarantine.has(parsed.quarantineId)) throw new Error("duplicate operator exclusion quarantine id");
    seenQuarantine.add(parsed.quarantineId);
    return parsed;
  });
  const sorted = [...rows].sort(compareExclusionRows);
  if (canonicalMigrationJson(rows) !== canonicalMigrationJson(sorted)) {
    throw new Error("operator exclusion rows must be canonically sorted");
  }
  const countsRaw = record(root.counts, "operator exclusion counts");
  exactKeys(countsRaw, OPERATOR_EXCLUSION_CODES, "operator exclusion counts");
  const counts = Object.fromEntries(OPERATOR_EXCLUSION_CODES.map((code) => [
    code,
    requiredInt(countsRaw[code], `counts.${code}`),
  ])) as Record<OperatorExclusionCode, number>;
  if (canonicalMigrationJson(counts) !== canonicalMigrationJson(normalizedCounts(rows))) {
    throw new Error("operator exclusion counts do not match rows");
  }
  const rowSetSha256 = requiredSha(root.rowSetSha256, "operator exclusion rowSetSha256");
  if (rowSetSha256 !== migrationArtifactSha256(rows)) {
    throw new Error("operator exclusion rowSetSha256 mismatch");
  }
  const body: Omit<OperatorExclusionArtifact, "artifactSha256"> = {
    kind: "baka-legacy-operator-exclusions",
    formatVersion: 1,
    createdAt: requiredIso(root.createdAt, "operator exclusion createdAt"),
    sourceMigrationId: requiredString(root.sourceMigrationId, "operator exclusion sourceMigrationId"),
    sourceReportSha256: requiredSha(root.sourceReportSha256, "operator exclusion sourceReportSha256"),
    snapshotSha256: requiredSha(root.snapshotSha256, "operator exclusion snapshotSha256"),
    rowSetSha256,
    counts,
    rows,
  };
  parseRecordId(body.sourceMigrationId, "migration_meta");
  if (!rows.some((row) => row.migrationId === body.sourceMigrationId)) {
    throw new Error("operator exclusion sourceMigrationId must own at least one row");
  }
  const artifactSha256 = requiredSha(root.artifactSha256, "operator exclusion artifactSha256");
  if (artifactSha256 !== migrationArtifactSha256(artifactBody(body))) {
    throw new Error("operator exclusion artifactSha256 mismatch");
  }
  return { ...body, artifactSha256 };
}

function compareExclusionRows(left: OperatorExclusionRow, right: OperatorExclusionRow): number {
  return left.legacyTable.localeCompare(right.legacyTable) ||
    left.legacyId.localeCompare(right.legacyId, "en", { numeric: true }) ||
    left.lastFailedAt.localeCompare(right.lastFailedAt) ||
    left.quarantineId.localeCompare(right.quarantineId);
}

function canonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("operator exclusion signature must be canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    throw new Error("operator exclusion signature must be a 64-byte Ed25519 signature");
  }
  return decoded;
}

export function parseOperatorExclusionAttestation(value: unknown): OperatorExclusionAttestation {
  const root = record(value, "operator exclusion attestation");
  exactKeys(root, ["kind", "formatVersion", "keyFingerprint", "payload", "signature"],
    "operator exclusion attestation");
  if (root.kind !== "baka-legacy-operator-exclusions-attestation" ||
      root.formatVersion !== OPERATOR_EXCLUSION_FORMAT_VERSION) {
    throw new Error("unsupported operator exclusion attestation");
  }
  const payload = record(root.payload, "operator exclusion attestation payload");
  exactKeys(payload, [
    "artifactFileSha256", "artifactSha256", "rowSetSha256", "sourceMigrationId",
    "snapshotSha256", "issuedAt",
  ], "operator exclusion attestation payload");
  const parsedPayload: OperatorExclusionAttestationPayload = {
    artifactFileSha256: requiredSha(payload.artifactFileSha256, "attestation artifactFileSha256"),
    artifactSha256: requiredSha(payload.artifactSha256, "attestation artifactSha256"),
    rowSetSha256: requiredSha(payload.rowSetSha256, "attestation rowSetSha256"),
    sourceMigrationId: requiredString(payload.sourceMigrationId, "attestation sourceMigrationId"),
    snapshotSha256: requiredSha(payload.snapshotSha256, "attestation snapshotSha256"),
    issuedAt: requiredIso(payload.issuedAt, "attestation issuedAt"),
  };
  parseRecordId(parsedPayload.sourceMigrationId, "migration_meta");
  const keyFingerprint = requiredSha(root.keyFingerprint, "attestation keyFingerprint");
  const signature = requiredString(root.signature, "attestation signature");
  canonicalBase64(signature);
  return {
    kind: "baka-legacy-operator-exclusions-attestation",
    formatVersion: 1,
    keyFingerprint,
    payload: parsedPayload,
    signature,
  };
}

export function verifyOperatorExclusionAttestation(input: {
  artifact: OperatorExclusionArtifact;
  artifactFileSha256: string;
  attestation: OperatorExclusionAttestation;
  trustAnchor: MigrationApprovalTrustAnchor;
}): { attestationSha256: string; keyFingerprint: string; issuedAt: string } {
  const artifact = parseOperatorExclusionArtifact(input.artifact);
  const attestation = parseOperatorExclusionAttestation(input.attestation);
  const key = createPublicKey(input.trustAnchor.ed25519PublicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("operator exclusion trust key must be Ed25519");
  const fingerprint = migrationApprovalKeyFingerprint(input.trustAnchor.ed25519PublicKeyPem);
  if (!SHA256_RE.test(input.trustAnchor.sha256Fingerprint) ||
      fingerprint !== input.trustAnchor.sha256Fingerprint ||
      attestation.keyFingerprint !== fingerprint) {
    throw new Error("operator exclusion trust key does not match independently pinned fingerprint");
  }
  const expected: OperatorExclusionAttestationPayload = {
    artifactFileSha256: requiredSha(input.artifactFileSha256, "artifact file SHA-256"),
    artifactSha256: artifact.artifactSha256,
    rowSetSha256: artifact.rowSetSha256,
    sourceMigrationId: artifact.sourceMigrationId,
    snapshotSha256: artifact.snapshotSha256,
    issuedAt: attestation.payload.issuedAt,
  };
  if (canonicalMigrationJson(attestation.payload) !== canonicalMigrationJson(expected)) {
    throw new Error("operator exclusion attestation is not bound to the exact artifact");
  }
  if (!verifySignature(
    null,
    Buffer.from(canonicalMigrationJson(attestation.payload), "utf8"),
    key,
    canonicalBase64(attestation.signature),
  )) throw new Error("operator exclusion attestation signature verification failed");
  return {
    attestationSha256: migrationArtifactSha256(attestation),
    keyFingerprint: fingerprint,
    issuedAt: attestation.payload.issuedAt,
  };
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function authenticatedEvidenceFile(
  archiveRoot: string,
  filePath: string,
  label: string,
): Promise<{ path: string; bytes: Buffer; sha256: string; sizeBytes: number }> {
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(filePath);
  if (!containedBy(root, resolved)) throw new Error(`${label} must be contained by archiveRoot`);
  const file = await authenticatedRegularFile(resolved, label);
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolved)]);
  const expectedRealFile = path.join(realRoot, path.relative(root, resolved));
  if (!containedBy(realRoot, realFile) || realFile !== expectedRealFile) {
    throw new Error(`${label} must not traverse a symlink or leave archiveRoot`);
  }
  return file;
}

async function authenticatedRegularFile(
  filePath: string,
  label: string,
): Promise<{ path: string; bytes: Buffer; sha256: string; sizeBytes: number }> {
  const resolved = path.resolve(filePath);
  const identity = await authenticateRegularFileIdentity(resolved, label);
  const opened = await openAuthenticatedRegularFile(identity, label);
  try {
    const bytes = await opened.descriptor.readFile();
    await assertOpenAuthenticatedRegularFileUnchanged(opened, label);
    return {
      path: resolved,
      bytes,
      sha256: identity.sha256,
      sizeBytes: identity.sizeBytes,
    };
  } finally {
    await opened.descriptor.close();
  }
}

function parseReconciliation(value: unknown): MigrationReconciliation {
  const raw = record(value, "source migration reconciliation");
  for (const key of ["legacyTotal", "matched", "inserted", "quarantined", "accounted", "lost"] as const) {
    requiredInt(raw[key], `source migration reconciliation.${key}`);
  }
  if (typeof raw.ok !== "boolean" || raw.tables === null || typeof raw.tables !== "object") {
    throw new Error("source migration reconciliation is malformed");
  }
  const tables = record(raw.tables, "source migration reconciliation.tables");
  exactKeys(tables, LEGACY_TABLES, "source migration reconciliation.tables");
  const aggregate = {
    legacyTotal: 0,
    matched: 0,
    inserted: 0,
    quarantined: 0,
    accounted: 0,
    lost: 0,
  };
  for (const table of LEGACY_TABLES) {
    const counters = record(tables[table], `source migration reconciliation.tables.${table}`);
    exactKeys(counters, [
      "total", "matched", "inserted", "quarantined", "accounted", "lost",
    ], `source migration reconciliation.tables.${table}`);
    for (const key of ["total", "matched", "inserted", "quarantined", "accounted", "lost"] as const) {
      requiredInt(counters[key], `source migration reconciliation.tables.${table}.${key}`);
      aggregate[key === "total" ? "legacyTotal" : key] += counters[key] as number;
    }
    if (counters.accounted !== (counters.matched as number) + (counters.inserted as number) +
        (counters.quarantined as number) ||
        counters.lost !== (counters.total as number) - (counters.accounted as number)) {
      throw new Error(`source migration reconciliation table arithmetic is invalid: ${table}`);
    }
  }
  const parsed = raw as unknown as MigrationReconciliation;
  if (parsed.accounted !== parsed.matched + parsed.inserted + parsed.quarantined ||
      parsed.lost !== parsed.legacyTotal - parsed.accounted ||
      aggregate.legacyTotal !== parsed.legacyTotal || aggregate.matched !== parsed.matched ||
      aggregate.inserted !== parsed.inserted || aggregate.quarantined !== parsed.quarantined ||
      aggregate.accounted !== parsed.accounted || aggregate.lost !== parsed.lost ||
      parsed.ok !== (parsed.lost === 0)) {
    throw new Error("source migration reconciliation arithmetic is invalid");
  }
  return parsed;
}

async function authenticateSourceMigration(input: {
  db: Surreal;
  archiveRoot: string;
  sourceMigrationId: string;
  snapshotPath?: string;
}): Promise<{
  meta: MigrationMetaRow;
  report: MigrationRunReport;
  reportSha256: string;
  snapshotSha256: string;
}> {
  const id = parseRecordId(input.sourceMigrationId, "migration_meta");
  const meta = await selectOne<MigrationMetaRow>(input.db, "SELECT * FROM ONLY $id", { id });
  if (!meta || String(meta.id) !== String(id)) throw new Error("source migration metadata is missing");
  if (meta.status !== "completed_with_errors" || !meta.legacy_db_path ||
      !meta.legacy_db_sha256 || !meta.report_path ||
      !meta.report_sha256 || meta.report_size_bytes === undefined ||
      !meta.approval_artifact_sha256 || !meta.approval_file_sha256 ||
      !meta.approval_attestation_sha256 || !meta.approval_key_fingerprint ||
      !meta.host_mapping_artifact_sha256) {
    throw new Error("source migration is not an authenticated completed_with_errors run");
  }
  const snapshotSha256 = meta.legacy_db_sha256;
  if (input.snapshotPath) {
    const snapshot = await authenticatedEvidenceFile(
      input.archiveRoot,
      input.snapshotPath,
      "operator exclusion legacy snapshot",
    );
    if (snapshot.sha256 !== snapshotSha256 ||
        path.resolve(meta.legacy_db_path) !== snapshot.path) {
      throw new Error("operator exclusion snapshot does not match source migration metadata");
    }
  }
  const reportFile = await authenticatedRegularFile(
    meta.report_path,
    "source migration report",
  );
  if (reportFile.sha256 !== meta.report_sha256 || reportFile.sizeBytes !== meta.report_size_bytes) {
    throw new Error("source migration report bytes do not match migration metadata");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportFile.bytes.toString("utf8"));
  } catch {
    throw new Error("source migration report is not valid JSON");
  }
  const reportRoot = record(parsed, "source migration report");
  if (reportRoot.formatVersion !== 1 || reportRoot.status !== "completed_with_errors" ||
      reportRoot.migrationId !== String(id) || reportRoot.snapshotSha256 !== snapshotSha256 ||
      path.resolve(requiredString(reportRoot.snapshotPath, "source migration snapshotPath")) !==
        path.resolve(meta.legacy_db_path) ||
      path.resolve(requiredString(reportRoot.reportPath, "source migration reportPath")) !== reportFile.path) {
    throw new Error("source migration report metadata binding mismatch");
  }
  const reconciliation = parseReconciliation(reportRoot.reconciliation);
  const metaCounters = record(meta.counters, "source migration durable counters");
  const metaReconciliation = parseReconciliation(metaCounters.reconciliation ?? metaCounters);
  if (canonicalMigrationJson(metaReconciliation) !== canonicalMigrationJson(reconciliation)) {
    throw new Error("source migration report reconciliation differs from durable counters");
  }
  if (reconciliation.lost !== 0 || reconciliation.accounted !== reconciliation.legacyTotal ||
      reconciliation.quarantined < 1) {
    throw new Error("source migration report is not eligible for exclusion acceptance");
  }
  return {
    meta,
    report: { ...(reportRoot as unknown as MigrationRunReport), reconciliation },
    reportSha256: reportFile.sha256,
    snapshotSha256,
  };
}

async function authenticateRetrySourceMigrations(input: {
  db: Surreal;
  archiveRoot: string;
  primary: Awaited<ReturnType<typeof authenticateSourceMigration>>;
  migrationIds: readonly string[];
}): Promise<void> {
  const primaryId = String(input.primary.meta.id);
  const migrationIds = [...new Set(input.migrationIds)].filter((id) => id !== primaryId).sort();
  for (const sourceMigrationId of migrationIds) {
    const retry = await authenticateSourceMigration({
      db: input.db,
      archiveRoot: input.archiveRoot,
      sourceMigrationId,
    });
    if (retry.snapshotSha256 !== input.primary.snapshotSha256 ||
        path.resolve(retry.meta.legacy_db_path!) !== path.resolve(input.primary.meta.legacy_db_path!)) {
      throw new Error("operator exclusion retry source migration snapshot binding mismatch");
    }
  }
}

function payloadForSnapshotRow(row: LegacySqlRow): Record<string, unknown> {
  return { row: legacyRowPayload(row) };
}

/** Re-derives exact eligible row lineages without reading quarantine reason text. */
export async function deriveEligibleOperatorExclusions(
  db: Surreal,
  snapshotPath: string,
): Promise<ExactEligibility> {
  const reader = new LegacySnapshotReader(snapshotPath);
  try {
    const agents = new Map(reader.agents().map((row) => [row.id, row.slug]));
    const sources = new Map(reader.sourceFiles().map((row) => [row.id, row]));
    const [liveDialogues, liveRevisions, durableMappings, sourceRevisions] = await Promise.all([
      selectAll<{ harness?: string; external_id: string }>(
        db,
        `SELECT harness_installation.harness.slug AS harness, external_id FROM dialogue
         WHERE external_id IS NOT NONE`,
      ),
      selectAll<{ source_dialogue_id?: string; sha256?: string }>(
        db,
        `SELECT source_dialogue_id, source_revision.sha256 AS sha256 FROM dialogue_revision
         WHERE source_dialogue_id IS NOT NONE AND source_revision IS NOT NONE`,
      ),
      selectAll<{ legacy_table: LegacyTable; legacy_id: string; target: RecordId }>(
        db,
        `SELECT legacy_table, legacy_id, target FROM legacy_identity_map
         WHERE legacy_table IN ["threads", "source_files", "thread_records"]`,
      ),
      selectAll<{ id: RecordId; source_location: RecordId; sha256: string }>(
        db,
        `SELECT id, source_location, sha256 FROM source_revision
         WHERE record::exists(source_location)`,
      ),
    ]);
    const dialogueKeys = new Set(liveDialogues.map((row) => `${row.harness ?? "?"}:${row.external_id}`));
    const revisionDialogueKeys = new Set(liveRevisions
      .filter((row) => row.source_dialogue_id && row.sha256)
      .map((row) => `${row.sha256}:${row.source_dialogue_id}`));
    const durableTargets = new Map<string, string[]>();
    for (const row of durableMappings) {
      const key = `${row.legacy_table}:${row.legacy_id}`;
      const targets = durableTargets.get(key) ?? [];
      targets.push(String(row.target));
      durableTargets.set(key, targets);
    }
    const exactRevisionTargets = new Map<string, string[]>();
    for (const revision of sourceRevisions) {
      const key = `${String(revision.source_location)}:${revision.sha256}`;
      const targets = exactRevisionTargets.get(key) ?? [];
      targets.push(String(revision.id));
      exactRevisionTargets.set(key, targets);
    }
    const exactTarget = (table: LegacyTable, legacyId: string): string | undefined => {
      const targets = durableTargets.get(`${table}:${legacyId}`);
      return targets?.length === 1 ? targets[0] : undefined;
    };
    const hasExactRecordOwnership = (records: readonly LegacyThreadRecordRow[]): boolean => records.every((row) => {
      if (row.source_file_id === null) return true;
      const source = sources.get(row.source_file_id);
      if (!source || !SHA256_RE.test(source.sha256)) return false;
      const location = exactTarget("source_files", String(source.id));
      if (!location) return false;
      const revisions = exactRevisionTargets.get(`${location}:${source.sha256}`);
      return revisions?.length === 1 &&
        exactTarget("thread_records", String(row.id)) === revisions[0];
    });
    const codes = new Map<string, OperatorExclusionCode>();
    const payloads = new Map<string, Record<string, unknown>>();
    const remember = (table: LegacyTable, row: LegacySqlRow, code: OperatorExclusionCode): void => {
      const key = `${table}:${String(row.id)}`;
      codes.set(key, code);
      payloads.set(key, payloadForSnapshotRow(row));
    };

    for (const thread of reader.threads()) {
      const bundle = reader.threadBundle(thread);
      const harness = agents.get(thread.agent_id);
      if (!harness || exactTarget("threads", String(thread.id))) continue;
      const linkedSources = bundle.records
        .filter((row) => row.source_file_id !== null)
        .map((row) => sources.get(row.source_file_id!));
      if (linkedSources.some((source) => source === undefined) || !hasExactRecordOwnership(bundle.records)) continue;
      const activeSources = linkedSources
        .filter((source): source is NonNullable<typeof source> => source !== undefined)
        .filter((source) => !isLegacySourceDeleted(source));
      const exactDialogueExists = dialogueKeys.has(`${harness}:${thread.external_id}`) ||
        linkedSources.some((source) => source !== undefined &&
          revisionDialogueKeys.has(`${source.sha256}:${thread.external_id}`));
      if (exactDialogueExists) continue;

      if (linkedSources.length > 0 &&
          activeSources.length === 0 &&
          bundle.messages.length === 0 && bundle.chunks.length === 0) {
        remember("threads", bundle.thread, "deleted_original_unrecoverable_no_messages");
        continue;
      }

      // No positive active-original evidence means this row is not eligible
      // for the narrow active-original policy.
      if (activeSources.length === 0) continue;

      remember("threads", bundle.thread, "active_original_without_exact_dialogue");
      for (const row of bundle.records) {
        if (row.source_file_id === null) {
          remember("thread_records", row, "source_less_record_of_excluded_active_thread");
        }
      }
      for (const row of bundle.messages) {
        remember("messages", row, "canonical_child_of_excluded_active_thread");
      }
      for (const row of bundle.chunks) {
        remember("message_chunks", row, "canonical_child_of_excluded_active_thread");
      }
    }
    return { codes, payloads };
  } finally {
    reader.close();
  }
}

async function unresolvedForSnapshot(db: Surreal, snapshotSha256: string): Promise<QuarantineRow[]> {
  return selectAll<QuarantineRow>(
    db,
    `SELECT * FROM migration_quarantine
     WHERE resolved_at IS NONE AND migration.legacy_db_sha256 = $snapshotSha
     ORDER BY legacy_table, legacy_id, last_failed_at, id`,
    { snapshotSha: snapshotSha256 },
  );
}

function artifactRowFromQuarantine(
  row: QuarantineRow,
  code: OperatorExclusionCode,
  expectedPayload: Record<string, unknown>,
): OperatorExclusionRow {
  if (row.lineage_key !== `${row.legacy_table}:${row.legacy_id}` ||
      canonicalMigrationJson(row.raw_payload) !== canonicalMigrationJson(expectedPayload)) {
    throw new Error(`quarantine provenance drift: ${row.lineage_key}`);
  }
  return {
    quarantineId: String(row.id),
    migrationId: String(row.migration),
    lineageKey: row.lineage_key,
    legacyTable: row.legacy_table,
    legacyId: row.legacy_id,
    exclusionCode: code,
    reasonSha256: sha256(row.reason),
    rawPayloadSha256: migrationArtifactSha256(row.raw_payload),
    parserName: row.parser_name,
    parserVersion: row.parser_version,
    attempts: row.attempts,
    lastFailedAt: iso(row.last_failed_at, `${row.lineage_key}.last_failed_at`),
  };
}

export async function buildOperatorExclusionArtifact(input: {
  db: Surreal;
  archiveRoot: string;
  snapshotPath: string;
  sourceMigrationId: string;
  createdAt?: string;
}): Promise<OperatorExclusionArtifact> {
  const schemaVersion = await checkSchemaVersion(input.db);
  if (schemaVersion !== 5) throw new Error(`operator exclusions require exact schema 5; current ${schemaVersion}`);
  const source = await authenticateSourceMigration(input);
  const eligibility = await deriveEligibleOperatorExclusions(input.db, input.snapshotPath);
  const unresolved = await unresolvedForSnapshot(input.db, source.snapshotSha256);
  if (unresolved.length === 0) throw new Error("operator exclusion plan has no unresolved rows");
  if (!unresolved.some((row) => String(row.migration) === String(source.meta.id))) {
    throw new Error("operator exclusion source migration has no unresolved rows");
  }
  await authenticateRetrySourceMigrations({
    db: input.db,
    archiveRoot: input.archiveRoot,
    primary: source,
    migrationIds: unresolved.map((row) => String(row.migration)),
  });
  const rows: OperatorExclusionRow[] = [];
  const ineligible: string[] = [];
  for (const row of unresolved) {
    const code = eligibility.codes.get(row.lineage_key);
    const expectedPayload = eligibility.payloads.get(row.lineage_key);
    if (!code || !expectedPayload) {
      ineligible.push(row.lineage_key);
      continue;
    }
    rows.push(artifactRowFromQuarantine(row, code, expectedPayload));
  }
  if (ineligible.length > 0) {
    throw new Error(
      `operator exclusion plan refused ${ineligible.length} unresolved non-eligible rows; ` +
      `first ${ineligible.slice(0, 10).join(", ")}`,
    );
  }
  rows.sort(compareExclusionRows);
  const createdAt = input.createdAt ?? new Date().toISOString();
  requiredIso(createdAt, "operator exclusion createdAt");
  const body: Omit<OperatorExclusionArtifact, "artifactSha256"> = {
    kind: "baka-legacy-operator-exclusions",
    formatVersion: 1,
    createdAt,
    sourceMigrationId: String(source.meta.id),
    sourceReportSha256: source.reportSha256,
    snapshotSha256: source.snapshotSha256,
    rowSetSha256: migrationArtifactSha256(rows),
    counts: normalizedCounts(rows),
    rows,
  };
  return parseOperatorExclusionArtifact({
    ...body,
    artifactSha256: migrationArtifactSha256(body),
  });
}

export async function writeOperatorExclusionArtifact(
  archiveRoot: string,
  filePath: string,
  artifact: OperatorExclusionArtifact,
): Promise<void> {
  const parsed = parseOperatorExclusionArtifact(artifact);
  await assertArchiveContainedTarget(archiveRoot, filePath, "operator exclusion artifact");
  await writePrivateFileAtomicNoClobber(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function resolutionFor(
  row: OperatorExclusionRow,
  acceptanceId: RecordId,
  artifactSha256: string,
): string {
  return `operator_excluded:v1:${row.exclusionCode}:${String(acceptanceId)}:${artifactSha256}`;
}

function parseAcceptanceNotes(value: string): AcceptanceNotes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("operator exclusion acceptance notes are not valid JSON");
  }
  const root = record(parsed, "operator exclusion acceptance notes");
  exactKeys(root, [
    "kind", "formatVersion", "sourceMigrationId", "artifactPath", "attestationPath",
    "publicKeyPem", "artifactSha256", "rowSetSha256",
  ], "operator exclusion acceptance notes");
  if (root.kind !== "baka-legacy-operator-exclusion-evidence" || root.formatVersion !== 1) {
    throw new Error("operator exclusion acceptance notes kind/version invalid");
  }
  const sourceMigrationId = requiredString(root.sourceMigrationId, "acceptance sourceMigrationId");
  parseRecordId(sourceMigrationId, "migration_meta");
  return {
    kind: "baka-legacy-operator-exclusion-evidence",
    formatVersion: 1,
    sourceMigrationId,
    artifactPath: requiredString(root.artifactPath, "acceptance artifactPath"),
    attestationPath: requiredString(root.attestationPath, "acceptance attestationPath"),
    publicKeyPem: requiredString(root.publicKeyPem, "acceptance publicKeyPem"),
    artifactSha256: requiredSha(root.artifactSha256, "acceptance artifactSha256"),
    rowSetSha256: requiredSha(root.rowSetSha256, "acceptance rowSetSha256"),
  };
}

function evidenceRelativePath(archiveRoot: string, filePath: string, label: string): string {
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(filePath);
  if (!containedBy(root, resolved)) throw new Error(`${label} must be contained by archiveRoot`);
  const relative = path.relative(root, resolved);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must be an archive-relative evidence file`);
  }
  return relative;
}

async function assertArchiveContainedTarget(
  archiveRoot: string,
  filePath: string,
  label: string,
): Promise<string> {
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(filePath);
  const relative = evidenceRelativePath(root, resolved, label);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("archiveRoot must be a non-symlink directory");
  }
  const realRoot = await realpath(root);
  let existingParent = path.dirname(resolved);
  while (true) {
    const info = await lstat(existingParent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${label} parent must be a non-symlink directory`);
      }
      break;
    }
    if (existingParent === root) throw new Error(`${label} parent is unavailable`);
    existingParent = path.dirname(existingParent);
  }
  const realParent = await realpath(existingParent);
  const expectedRealParent = path.join(realRoot, path.relative(root, existingParent));
  if (!containedBy(realRoot, realParent) || realParent !== expectedRealParent) {
    throw new Error(`${label} parent must not traverse a symlink or leave archiveRoot`);
  }
  return relative;
}

async function readOperatorExclusionArtifacts(input: {
  archiveRoot: string;
  artifactPath: string;
  attestationPath: string;
  trustAnchor: MigrationApprovalTrustAnchor;
}): Promise<{
  artifact: OperatorExclusionArtifact;
  artifactFileSha256: string;
  artifactPath: string;
  attestation: OperatorExclusionAttestation;
  attestationSha256: string;
  attestationPath: string;
}> {
  const [artifactFile, attestationFile] = await Promise.all([
    authenticatedEvidenceFile(input.archiveRoot, input.artifactPath, "operator exclusion artifact"),
    authenticatedEvidenceFile(input.archiveRoot, input.attestationPath, "operator exclusion attestation"),
  ]);
  let artifactJson: unknown;
  let attestationJson: unknown;
  try {
    artifactJson = JSON.parse(artifactFile.bytes.toString("utf8"));
    attestationJson = JSON.parse(attestationFile.bytes.toString("utf8"));
  } catch {
    throw new Error("operator exclusion artifact/attestation is not valid JSON");
  }
  const artifact = parseOperatorExclusionArtifact(artifactJson);
  const attestation = parseOperatorExclusionAttestation(attestationJson);
  const verified = verifyOperatorExclusionAttestation({
    artifact,
    artifactFileSha256: artifactFile.sha256,
    attestation,
    trustAnchor: input.trustAnchor,
  });
  return {
    artifact,
    artifactFileSha256: artifactFile.sha256,
    artifactPath: artifactFile.path,
    attestation,
    attestationSha256: verified.attestationSha256,
    attestationPath: attestationFile.path,
  };
}

async function queryQuarantinesByIds(db: Surreal, ids: RecordId[]): Promise<QuarantineRow[]> {
  const rows: QuarantineRow[] = [];
  for (let offset = 0; offset < ids.length; offset += OPERATOR_EXCLUSION_BATCH_SIZE) {
    rows.push(...await selectAll<QuarantineRow>(
      db,
      "SELECT * FROM $ids ORDER BY id",
      { ids: ids.slice(offset, offset + OPERATOR_EXCLUSION_BATCH_SIZE) },
    ));
  }
  return rows;
}

function assertArtifactRowCurrent(
  artifactRow: OperatorExclusionRow,
  current: QuarantineRow,
): void {
  if (
    String(current.id) !== artifactRow.quarantineId ||
    String(current.migration) !== artifactRow.migrationId ||
    current.legacy_table !== artifactRow.legacyTable ||
    current.legacy_id !== artifactRow.legacyId ||
    current.lineage_key !== artifactRow.lineageKey ||
    sha256(current.reason) !== artifactRow.reasonSha256 ||
    migrationArtifactSha256(current.raw_payload) !== artifactRow.rawPayloadSha256 ||
    current.parser_name !== artifactRow.parserName ||
    current.parser_version !== artifactRow.parserVersion ||
    current.attempts !== artifactRow.attempts ||
    iso(current.last_failed_at, `${artifactRow.lineageKey}.last_failed_at`) !== artifactRow.lastFailedAt
  ) throw new Error(`operator exclusion quarantine row changed: ${artifactRow.quarantineId}`);
}

async function publishOrReuseJson(filePath: string, value: unknown): Promise<{
  sha256: string;
  sizeBytes: number;
}> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    await assertRegularNonSymlinkFile(filePath, "operator exclusion report target");
    if (await readFile(filePath, "utf8") !== content) {
      throw new Error("operator exclusion report target already contains different bytes");
    }
  } else {
    // A concurrent creator after the lstat loses through the kernel-enforced
    // no-clobber primitive; only a pre-existing exact file is crash-resume.
    await writePrivateFileAtomicNoClobber(filePath, content);
  }
  const bytes = Buffer.from(content, "utf8");
  return { sha256: sha256(bytes), sizeBytes: bytes.byteLength };
}

async function assertReportAbsentOrExact(filePath: string, value: unknown): Promise<void> {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) return;
  await assertRegularNonSymlinkFile(filePath, "operator exclusion report target");
  if (await readFile(filePath, "utf8") !== expected) {
    throw new Error("operator exclusion report target already contains different bytes");
  }
}

export async function applyOperatorExclusions(input: {
  db: Surreal;
  archiveRoot: string;
  snapshotPath: string;
  artifactPath: string;
  attestationPath: string;
  reportPath: string;
  trustAnchor: MigrationApprovalTrustAnchor;
}): Promise<OperatorExclusionReport> {
  const schemaVersion = await checkSchemaVersion(input.db);
  if (schemaVersion !== 5) throw new Error(`operator exclusions require exact schema 5; current ${schemaVersion}`);
  const loaded = await readOperatorExclusionArtifacts(input);
  const source = await authenticateSourceMigration({
    db: input.db,
    archiveRoot: input.archiveRoot,
    sourceMigrationId: loaded.artifact.sourceMigrationId,
    snapshotPath: input.snapshotPath,
  });
  if (source.reportSha256 !== loaded.artifact.sourceReportSha256 ||
      source.snapshotSha256 !== loaded.artifact.snapshotSha256) {
    throw new Error("operator exclusion artifact is not bound to the authenticated source migration");
  }
  await authenticateRetrySourceMigrations({
    db: input.db,
    archiveRoot: input.archiveRoot,
    primary: source,
    migrationIds: loaded.artifact.rows.map((row) => row.migrationId),
  });
  const eligibility = await deriveEligibleOperatorExclusions(input.db, input.snapshotPath);
  const acceptanceId = new RecordId(
    "migration_meta",
    `operator-exclusions-${loaded.artifact.artifactSha256}`,
  );
  const artifactIds = loaded.artifact.rows.map((row) =>
    parseRecordId(row.quarantineId, "migration_quarantine"));
  const currentRows = await queryQuarantinesByIds(input.db, artifactIds);
  if (currentRows.length !== loaded.artifact.rows.length) {
    throw new Error("operator exclusion artifact references missing quarantine rows");
  }
  const currentById = new Map(currentRows.map((row) => [String(row.id), row]));
  const artifactIdsSet = new Set(loaded.artifact.rows.map((row) => row.quarantineId));
  const unresolved = await unresolvedForSnapshot(input.db, loaded.artifact.snapshotSha256);
  const outsideArtifact = unresolved.filter((row) => !artifactIdsSet.has(String(row.id)));
  if (outsideArtifact.length > 0) {
    throw new Error(
      `operator exclusion artifact is not the exact unresolved row set; ` +
      `${outsideArtifact.length} unlisted rows remain`,
    );
  }

  const pending: Array<{ artifact: OperatorExclusionRow; current: QuarantineRow; resolution: string }> = [];
  for (const artifactRow of loaded.artifact.rows) {
    const current = currentById.get(artifactRow.quarantineId)!;
    assertArtifactRowCurrent(artifactRow, current);
    if (eligibility.codes.get(artifactRow.lineageKey) !== artifactRow.exclusionCode ||
        canonicalMigrationJson(eligibility.payloads.get(artifactRow.lineageKey)) !==
          canonicalMigrationJson(current.raw_payload)) {
      throw new Error(`operator exclusion row is no longer structurally eligible: ${artifactRow.lineageKey}`);
    }
    const resolution = resolutionFor(artifactRow, acceptanceId, loaded.artifact.artifactSha256);
    if (current.resolved_at !== undefined && current.resolved_at !== null) {
      if (current.resolution !== resolution) {
        throw new Error(`operator exclusion row was resolved differently: ${artifactRow.quarantineId}`);
      }
      continue;
    }
    if (current.resolution !== undefined && current.resolution !== null) {
      throw new Error(`unresolved operator exclusion row already has resolution text: ${artifactRow.quarantineId}`);
    }
    pending.push({ artifact: artifactRow, current, resolution });
  }

  const resolvedReportPath = path.resolve(input.reportPath);
  await assertArchiveContainedTarget(
    input.archiveRoot,
    resolvedReportPath,
    "operator exclusion report",
  );
  const report: OperatorExclusionReport = {
    kind: "baka-legacy-operator-exclusion-report",
    formatVersion: 1,
    createdAt: loaded.artifact.createdAt,
    state: "accepted_with_operator_exclusions",
    acceptanceId: String(acceptanceId),
    sourceMigrationId: loaded.artifact.sourceMigrationId,
    snapshotSha256: loaded.artifact.snapshotSha256,
    artifactSha256: loaded.artifact.artifactSha256,
    artifactFileSha256: loaded.artifactFileSha256,
    attestationSha256: loaded.attestationSha256,
    rowSetSha256: loaded.artifact.rowSetSha256,
    reconciliation: source.report.reconciliation,
    excludedRows: loaded.artifact.rows.length,
    excludedLineages: new Set(loaded.artifact.rows.map((row) => row.lineageKey)).size,
    excludedByCode: loaded.artifact.counts,
    unresolved: 0,
    invalidResolutions: 0,
    reportPath: resolvedReportPath,
  };
  // Fail before the first DB mutation. An exact prior report is accepted only
  // as deterministic crash-resume evidence; a different or symlink target is
  // never overwritten and cannot strand partially adjudicated rows.
  await assertReportAbsentOrExact(resolvedReportPath, report);

  const artifactRelative = evidenceRelativePath(input.archiveRoot, loaded.artifactPath, "operator exclusion artifact");
  const attestationRelative = evidenceRelativePath(
    input.archiveRoot,
    loaded.attestationPath,
    "operator exclusion attestation",
  );
  const notes: AcceptanceNotes = {
    kind: "baka-legacy-operator-exclusion-evidence",
    formatVersion: 1,
    sourceMigrationId: loaded.artifact.sourceMigrationId,
    artifactPath: artifactRelative,
    attestationPath: attestationRelative,
    publicKeyPem: input.trustAnchor.ed25519PublicKeyPem,
    artifactSha256: loaded.artifact.artifactSha256,
    rowSetSha256: loaded.artifact.rowSetSha256,
  };
  const existingAcceptance = await selectOne<MigrationMetaRow>(
    input.db,
    "SELECT * FROM ONLY $id",
    { id: acceptanceId },
  );
  if (existingAcceptance) {
    const expectedReportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    const expectedReportSha256 = sha256(expectedReportBytes);
    if (
      !["running", "accepted_with_operator_exclusions"].includes(existingAcceptance.status) ||
      iso(existingAcceptance.started_at, "acceptance started_at") !== loaded.attestation.payload.issuedAt ||
      path.resolve(existingAcceptance.legacy_db_path ?? "") !== path.resolve(input.snapshotPath) ||
      existingAcceptance.legacy_db_sha256 !== loaded.artifact.snapshotSha256 ||
      existingAcceptance.approval_artifact_sha256 !== loaded.artifact.artifactSha256 ||
      existingAcceptance.approval_file_sha256 !== loaded.artifactFileSha256 ||
      existingAcceptance.approval_attestation_sha256 !== loaded.attestationSha256 ||
      existingAcceptance.approval_key_fingerprint !== input.trustAnchor.sha256Fingerprint ||
      path.resolve(existingAcceptance.report_path ?? "") !== resolvedReportPath ||
      (existingAcceptance.report_sha256 !== undefined &&
        existingAcceptance.report_sha256 !== expectedReportSha256) ||
      (existingAcceptance.report_size_bytes !== undefined &&
        existingAcceptance.report_size_bytes !== expectedReportBytes.byteLength) ||
      existingAcceptance.notes !== canonicalMigrationJson(notes)
    ) throw new Error("operator exclusion acceptance metadata collision");
  } else {
    const startedAt = new Date(loaded.attestation.payload.issuedAt);
    const result = await input.db.query<unknown[]>(
      `BEGIN;
       CREATE ONLY $id SET status = "running", started_at = $startedAt,
         legacy_db_path = $snapshotPath, legacy_db_sha256 = $snapshotSha,
         approval_artifact_sha256 = $artifactSha, approval_file_sha256 = $artifactFileSha,
         approval_attestation_sha256 = $attestationSha,
         approval_key_fingerprint = $keyFingerprint, notes = $notes,
         report_path = $reportPath;
       COMMIT;
       RETURN true;`,
      {
        id: acceptanceId,
        startedAt,
        snapshotPath: path.resolve(input.snapshotPath),
        snapshotSha: loaded.artifact.snapshotSha256,
        artifactSha: loaded.artifact.artifactSha256,
        artifactFileSha: loaded.artifactFileSha256,
        attestationSha: loaded.attestationSha256,
        keyFingerprint: input.trustAnchor.sha256Fingerprint,
        notes: canonicalMigrationJson(notes),
        reportPath: resolvedReportPath,
      },
    );
    if (result.at(-1) !== true) throw new Error("operator exclusion acceptance start failed");
  }

  for (let offset = 0; offset < pending.length; offset += OPERATOR_EXCLUSION_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + OPERATOR_EXCLUSION_BATCH_SIZE);
    const rows = batch.map((item) => ({
      id: item.current.id,
      migration: item.current.migration,
      table: item.current.legacy_table,
      legacyId: item.current.legacy_id,
      lineage: item.current.lineage_key,
      reason: item.current.reason,
      rawPayload: item.current.raw_payload,
      parserName: item.current.parser_name,
      parserVersion: item.current.parser_version,
      attempts: item.current.attempts,
      lastFailedAt: item.current.last_failed_at,
      resolution: item.resolution,
    }));
    const result = await input.db.query<unknown[]>(
      `BEGIN;
       LET $valid = $rows.all(|$item|
         $item.id.migration = $item.migration AND
         $item.id.legacy_table = $item.table AND
         $item.id.legacy_id = $item.legacyId AND
         $item.id.lineage_key = $item.lineage AND
         $item.id.reason = $item.reason AND
         $item.id.raw_payload = $item.rawPayload AND
         $item.id.parser_name = $item.parserName AND
         $item.id.parser_version = $item.parserVersion AND
         $item.id.attempts = $item.attempts AND
         $item.id.last_failed_at = $item.lastFailedAt AND
         $item.id.resolved_at IS NONE AND $item.id.resolution IS NONE
       );
       FOR $item IN $rows {
         UPDATE ONLY $item.id SET resolved_at = $now, resolution = $item.resolution
           WHERE $valid;
       };
       COMMIT;
       RETURN $valid;`,
      { rows, now: new Date() },
    );
    if (result.at(-1) !== true) throw new Error("operator exclusion optimistic guard failed");
  }

  const [remaining, legacyErrors] = await Promise.all([
    selectOne<{ n: number }>(
      input.db,
      `SELECT count() AS n FROM migration_quarantine
       WHERE resolved_at IS NONE AND migration.legacy_db_sha256 = $snapshotSha GROUP ALL`,
      { snapshotSha: loaded.artifact.snapshotSha256 },
    ),
    selectOne<{ n: number }>(
      input.db,
      `SELECT count() AS n FROM ingest_error
       WHERE stage = "migration" AND resolved_at IS NONE GROUP ALL`,
    ),
  ]);
  if ((remaining?.n ?? 0) !== 0 || (legacyErrors?.n ?? 0) !== 0) {
    throw new Error("operator exclusion finalization refused unresolved migration errors");
  }
  const publication = await publishOrReuseJson(resolvedReportPath, report);
  const counters = {
    reconciliation: source.report.reconciliation,
    operatorExclusions: {
      state: report.state,
      sourceMigrationId: report.sourceMigrationId,
      artifactSha256: report.artifactSha256,
      rowSetSha256: report.rowSetSha256,
      excludedRows: report.excludedRows,
      excludedLineages: report.excludedLineages,
      excludedByCode: report.excludedByCode,
      unresolved: 0,
      invalidResolutions: 0,
    },
  };
  const [finished] = await input.db.query<[MigrationMetaRow | undefined]>(
    `UPDATE ONLY $id SET status = "accepted_with_operator_exclusions",
       finished_at = $finishedAt, counters = $counters,
       report_sha256 = $reportSha, report_size_bytes = $reportSize
     WHERE status IN ["running", "accepted_with_operator_exclusions"] AND
       approval_artifact_sha256 = $artifactSha AND notes = $notes
     RETURN AFTER`,
    {
      id: acceptanceId,
      artifactSha: loaded.artifact.artifactSha256,
      notes: canonicalMigrationJson(notes),
      finishedAt: new Date(),
      counters,
      reportSha: publication.sha256,
      reportSize: publication.sizeBytes,
    },
  );
  if (!finished || finished.status !== "accepted_with_operator_exclusions") {
    throw new Error("operator exclusion acceptance finalization guard failed");
  }
  return report;
}

async function verifyPersistedAcceptance(input: {
  db: Surreal;
  archiveRoot?: string;
  meta: MigrationMetaRow;
  artifactSha256: string;
}): Promise<{ artifact: OperatorExclusionArtifact; notes: AcceptanceNotes }> {
  const meta = input.meta;
  if (meta.status !== "accepted_with_operator_exclusions" ||
      meta.approval_artifact_sha256 !== input.artifactSha256 || !meta.notes ||
      !meta.approval_file_sha256 || !meta.approval_attestation_sha256 ||
      !meta.approval_key_fingerprint || !meta.report_path || !meta.report_sha256 ||
      meta.report_size_bytes === undefined || !meta.legacy_db_path || !meta.legacy_db_sha256) {
    throw new Error("operator exclusion acceptance metadata is incomplete");
  }
  const notes = parseAcceptanceNotes(meta.notes);
  if (notes.artifactSha256 !== input.artifactSha256 ||
      migrationApprovalKeyFingerprint(notes.publicKeyPem) !== meta.approval_key_fingerprint) {
    throw new Error("operator exclusion acceptance notes/key mismatch");
  }
  const sourceMeta = await selectOne<MigrationMetaRow>(
    input.db,
    "SELECT * FROM ONLY $id",
    { id: parseRecordId(notes.sourceMigrationId, "migration_meta") },
  );
  if (!sourceMeta || sourceMeta.status !== "completed_with_errors" ||
      !sourceMeta.approval_artifact_sha256 || !sourceMeta.approval_file_sha256 ||
      !sourceMeta.approval_attestation_sha256 || !sourceMeta.host_mapping_artifact_sha256 ||
      !sourceMeta.approval_key_fingerprint || !sourceMeta.report_path ||
      !sourceMeta.report_sha256 || sourceMeta.report_size_bytes === undefined ||
      sourceMeta.legacy_db_sha256 !== meta.legacy_db_sha256 ||
      path.resolve(sourceMeta.legacy_db_path ?? "") !== path.resolve(meta.legacy_db_path)) {
    throw new Error("operator exclusion snapshot is not anchored to the authenticated source migration");
  }
  if (!input.archiveRoot) {
    // DB-only status remains fail-closed on metadata but leaves file/signature
    // re-authentication to validate/status with archiveRoot.
    const counters = record(meta.counters, "operator exclusion counters");
    const exclusion = record(counters.operatorExclusions, "operator exclusion counters payload");
    if (exclusion.artifactSha256 !== input.artifactSha256 || exclusion.rowSetSha256 !== notes.rowSetSha256) {
      throw new Error("operator exclusion counters do not match acceptance notes");
    }
    return {
      artifact: {
        kind: "baka-legacy-operator-exclusions",
        formatVersion: 1,
        createdAt: iso(meta.started_at, "acceptance started_at"),
        sourceMigrationId: notes.sourceMigrationId,
        sourceReportSha256: sourceMeta.report_sha256!,
        snapshotSha256: meta.legacy_db_sha256!,
        rowSetSha256: notes.rowSetSha256,
        counts: emptyCounts(),
        rows: [],
        artifactSha256: notes.artifactSha256,
      },
      notes,
    };
  }
  const artifactPath = path.join(input.archiveRoot, notes.artifactPath);
  const attestationPath = path.join(input.archiveRoot, notes.attestationPath);
  const loaded = await readOperatorExclusionArtifacts({
    archiveRoot: input.archiveRoot,
    artifactPath,
    attestationPath,
    trustAnchor: {
      ed25519PublicKeyPem: notes.publicKeyPem,
      sha256Fingerprint: meta.approval_key_fingerprint,
    },
  });
  if (loaded.artifact.artifactSha256 !== input.artifactSha256 ||
      loaded.artifact.rowSetSha256 !== notes.rowSetSha256 ||
      loaded.artifactFileSha256 !== meta.approval_file_sha256 ||
      loaded.attestationSha256 !== meta.approval_attestation_sha256 ||
      loaded.artifact.sourceMigrationId !== notes.sourceMigrationId) {
    throw new Error("persisted operator exclusion artifact binding mismatch");
  }
  const signedQuarantineIds = loaded.artifact.rows.map((row) =>
    parseRecordId(row.quarantineId, "migration_quarantine"));
  const currentSignedRows = await queryQuarantinesByIds(input.db, signedQuarantineIds);
  if (currentSignedRows.length !== loaded.artifact.rows.length) {
    throw new Error(
      `persisted operator exclusion is missing signed quarantine rows: ` +
      `expected ${loaded.artifact.rows.length}, found ${currentSignedRows.length}`,
    );
  }
  const currentSignedById = new Map(currentSignedRows.map((row) => [String(row.id), row]));
  for (const artifactRow of loaded.artifact.rows) {
    const current = currentSignedById.get(artifactRow.quarantineId);
    if (!current) {
      throw new Error(`persisted operator exclusion signed quarantine row is missing: ${artifactRow.quarantineId}`);
    }
    assertArtifactRowCurrent(artifactRow, current);
  }
  const persistedSnapshot = await lstat(meta.legacy_db_path).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  const source = await authenticateSourceMigration({
    db: input.db,
    archiveRoot: input.archiveRoot,
    sourceMigrationId: notes.sourceMigrationId,
    ...(persistedSnapshot ? { snapshotPath: meta.legacy_db_path } : {}),
  });
  if (source.reportSha256 !== loaded.artifact.sourceReportSha256 ||
      source.snapshotSha256 !== loaded.artifact.snapshotSha256) {
    throw new Error("persisted operator exclusion source evidence binding mismatch");
  }
  await authenticateRetrySourceMigrations({
    db: input.db,
    archiveRoot: input.archiveRoot,
    primary: source,
    migrationIds: loaded.artifact.rows.map((row) => row.migrationId),
  });
  const report = await authenticatedEvidenceFile(input.archiveRoot, meta.report_path, "operator exclusion report");
  if (report.sha256 !== meta.report_sha256 || report.sizeBytes !== meta.report_size_bytes) {
    throw new Error("persisted operator exclusion report bytes mismatch");
  }
  return { artifact: loaded.artifact, notes };
}

function parseResolution(value: string):
  | { kind: "operator"; code: OperatorExclusionCode; metaId: string; artifactSha256: string }
  | { kind: "retry"; target: string }
  | undefined {
  const operator = RESOLUTION_RE.exec(value);
  if (operator) {
    if (!(OPERATOR_EXCLUSION_CODES as readonly string[]).includes(operator[1]!)) return undefined;
    let metaId: string;
    try {
      metaId = String(parseRecordId(operator[2]!, "migration_meta"));
    } catch {
      return undefined;
    }
    if (metaId !== operator[2]) return undefined;
    return {
      kind: "operator",
      code: operator[1] as OperatorExclusionCode,
      metaId,
      artifactSha256: operator[3]!,
    };
  }
  const retry = RETRY_RESOLUTION_RE.exec(value);
  if (retry && retry[1]!.includes(":")) return { kind: "retry", target: retry[1]! };
  return undefined;
}

export async function inspectMigrationQuarantineLifecycle(
  db: Surreal,
  options: { archiveRoot?: string; includeRows?: boolean } = {},
): Promise<MigrationQuarantineLifecycle> {
  const rows = await selectAll<QuarantineRow>(
    db,
    `SELECT * FROM migration_quarantine ORDER BY lineage_key, last_failed_at, id`,
  );
  const mappings = await selectAll<{ legacy_table: LegacyTable; legacy_id: string; target: RecordId }>(
    db,
    "SELECT legacy_table, legacy_id, target FROM legacy_identity_map",
  );
  const mappingByLineage = new Map(mappings.map((row) => [
    `${row.legacy_table}:${row.legacy_id}`,
    String(row.target),
  ]));
  const summary: MigrationQuarantineLifecycle = {
    state: "complete",
    unresolved: 0,
    documentedOperatorExclusions: 0,
    documentedOperatorExclusionLineages: 0,
    retryResolved: 0,
    supersededOperatorExclusions: 0,
    invalidResolutions: 0,
    byCode: emptyCounts(),
    issues: [],
  };
  const metaIds = new Map<string, RecordId>();
  for (const row of rows) {
    if (!row.resolved_at) continue;
    const parsed = row.resolution ? parseResolution(row.resolution) : undefined;
    if (parsed?.kind === "operator") {
      metaIds.set(parsed.metaId, parseRecordId(parsed.metaId, "migration_meta"));
    }
  }
  const metaRows = metaIds.size > 0
    ? await selectAll<MigrationMetaRow>(db, "SELECT * FROM $ids", { ids: [...metaIds.values()] })
    : [];
  const persistedAcceptances = await selectAll<MigrationMetaRow>(
    db,
    `SELECT * FROM migration_meta WHERE status = "accepted_with_operator_exclusions"`,
  );
  const metas = new Map<string, MigrationMetaRow>();
  for (const row of [...metaRows, ...persistedAcceptances]) metas.set(String(row.id), row);
  const verified = new Map<string, Awaited<ReturnType<typeof verifyPersistedAcceptance>>>();
  const verificationErrors = new Map<string, unknown>();
  const exclusionLineages = new Set<string>();

  // Acceptance metadata is durable evidence in its own right. Verify it even
  // when every signed quarantine row was deleted and no current resolution can
  // lead the row-driven pass back to this acceptance record.
  for (const meta of persistedAcceptances) {
    const metaId = String(meta.id);
    try {
      verified.set(metaId, await verifyPersistedAcceptance({
        db,
        archiveRoot: options.archiveRoot,
        meta,
        artifactSha256: meta.approval_artifact_sha256 ?? "",
      }));
    } catch (error) {
      verificationErrors.set(metaId, error);
      if (!metaIds.has(metaId)) {
        summary.invalidResolutions += 1;
        summary.issues.push({
          check: "invalid_migration_quarantine_resolution",
          detail: `${metaId}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  for (const row of rows) {
    const label = `${row.legacy_table}:${row.legacy_id}`;
    if (!row.resolved_at) {
      summary.unresolved += 1;
      summary.issues.push({
        check: "unresolved_migration_quarantine",
        detail: options.includeRows === false ? label : `${String(row.id)} (${label}): ${row.reason}`,
      });
      continue;
    }
    if (!row.resolution) {
      summary.invalidResolutions += 1;
      summary.issues.push({ check: "invalid_migration_quarantine_resolution", detail: `${String(row.id)}: missing resolution` });
      continue;
    }
    const parsed = parseResolution(row.resolution);
    if (!parsed) {
      summary.invalidResolutions += 1;
      summary.issues.push({ check: "invalid_migration_quarantine_resolution", detail: `${String(row.id)}: unknown resolution` });
      continue;
    }
    if (parsed.kind === "retry") {
      if (mappingByLineage.get(row.lineage_key) !== parsed.target) {
        summary.invalidResolutions += 1;
        summary.issues.push({
          check: "invalid_migration_quarantine_resolution",
          detail: `${String(row.id)}: retry target does not match durable legacy identity`,
        });
      } else {
        summary.retryResolved += 1;
      }
      continue;
    }
    const meta = metas.get(parsed.metaId);
    if (!meta) {
      summary.invalidResolutions += 1;
      summary.issues.push({ check: "invalid_migration_quarantine_resolution", detail: `${String(row.id)}: acceptance metadata missing` });
      continue;
    }
    try {
      let evidence = verified.get(parsed.metaId);
      if (!evidence) {
        const verificationError = verificationErrors.get(parsed.metaId);
        if (verificationError) throw verificationError;
        evidence = await verifyPersistedAcceptance({
          db,
          archiveRoot: options.archiveRoot,
          meta,
          artifactSha256: parsed.artifactSha256,
        });
        verified.set(parsed.metaId, evidence);
      }
      if (options.archiveRoot) {
        const item = evidence.artifact.rows.find((candidate) => candidate.quarantineId === String(row.id));
        if (!item || item.exclusionCode !== parsed.code) {
          throw new Error("quarantine row is absent from signed exclusion row set");
        }
        assertArtifactRowCurrent(item, row);
      }
      if (mappingByLineage.has(row.lineage_key)) {
        summary.supersededOperatorExclusions += 1;
      } else {
        summary.documentedOperatorExclusions += 1;
        summary.byCode[parsed.code] += 1;
        exclusionLineages.add(row.lineage_key);
      }
    } catch (error) {
      summary.invalidResolutions += 1;
      summary.issues.push({
        check: "invalid_migration_quarantine_resolution",
        detail: `${String(row.id)}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  summary.documentedOperatorExclusionLineages = exclusionLineages.size;
  summary.state = summary.unresolved > 0 || summary.invalidResolutions > 0
    ? "blocked"
    : summary.documentedOperatorExclusions > 0
      ? "accepted_with_operator_exclusions"
      : "complete";
  return summary;
}
