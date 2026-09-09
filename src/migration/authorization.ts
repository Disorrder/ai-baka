/** Fail-closed approval artifacts for the destructive Stage 10 runner. */

import { Database } from "bun:sqlite";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  manifestPathForExport,
  parseBackupManifest,
} from "../backup/backup.ts";
import {
  parsePersistedRestoreTestReport,
  type PersistedRestoreTestReport,
} from "../backup/restore-test.ts";
import { writePrivateFileAtomicNoClobber } from "../backup/safety.ts";
import type { LocalIdentity } from "../sync/host-identity.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import {
  LEGACY_TABLES,
  type LegacyTable,
} from "./legacy-reader.ts";
import type {
  LiveCorpusProbe,
  PreflightProblem,
  PreflightReport,
} from "./preflight.ts";
import {
  resolveApprovedHostMapping,
  type ApprovedLegacyHostMapping,
} from "./store.ts";

export const MIGRATION_APPROVAL_FORMAT_VERSION = 1;
export const HOST_MAPPING_APPROVAL_FORMAT_VERSION = 1;
export const MIGRATION_ATTESTATION_FORMAT_VERSION = 1;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalMigrationJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function migrationArtifactSha256(value: unknown): string {
  return createHash("sha256").update(canonicalMigrationJson(value), "utf8").digest("hex");
}

function assertSha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} должен быть lowercase SHA-256`);
}

export interface CanonicalLiveProbeEvidence {
  available: boolean;
  note?: string;
  revisionSha256: string[];
  dialogueKeys: string[];
}

export function canonicalLiveProbe(live: LiveCorpusProbe): CanonicalLiveProbeEvidence {
  return {
    available: live.available,
    ...(live.note ? { note: live.note } : {}),
    revisionSha256: [...live.revisionSha256].sort(),
    dialogueKeys: [...live.dialogueKeys].sort(),
  };
}

export function canonicalProblems(problems: PreflightProblem[]): PreflightProblem[] {
  return problems
    .map((problem) => ({
      table: String(problem.table),
      recordId: String(problem.recordId),
      reason: String(problem.reason),
    }))
    .sort((a, b) =>
      a.table.localeCompare(b.table) ||
      a.recordId.localeCompare(b.recordId) ||
      a.reason.localeCompare(b.reason));
}

export interface LegacyHostAssignment {
  table: "projects" | "source_files" | "threads";
  legacyId: string;
  mappingId: string;
  basis: "explicit" | "path" | "source_relation" | "project_relation";
}

export interface LegacyHostMappingApproval {
  kind: "baka-legacy-host-mapping-approval";
  formatVersion: 1;
  snapshotSha256: string;
  mappings: ApprovedLegacyHostMapping[];
  assignments: LegacyHostAssignment[];
  artifactSha256: string;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .some((item) => item.name === column);
}

function normalizedMappings(mappings: ApprovedLegacyHostMapping[]): ApprovedLegacyHostMapping[] {
  return mappings.map((mapping) => ({
    mappingId: mapping.mappingId,
    host: { ...mapping.host },
    ...(mapping.sourceFileIds ? { sourceFileIds: [...mapping.sourceFileIds].map(String).sort() } : {}),
    ...(mapping.projectIds ? { projectIds: [...mapping.projectIds].map(String).sort() } : {}),
    ...(mapping.threadIds ? { threadIds: [...mapping.threadIds].map(String).sort() } : {}),
    ...(mapping.pathPrefixes ? { pathPrefixes: [...mapping.pathPrefixes].sort() } : {}),
  })).sort((a, b) => a.mappingId.localeCompare(b.mappingId));
}

function selectorValues(
  mapping: ApprovedLegacyHostMapping,
  table: LegacyHostAssignment["table"],
): Array<string | number> | undefined {
  if (table === "source_files") return mapping.sourceFileIds;
  if (table === "projects") return mapping.projectIds;
  return mapping.threadIds;
}

function explicitMapping(
  mappings: ApprovedLegacyHostMapping[],
  table: LegacyHostAssignment["table"],
  legacyId: number,
): ApprovedLegacyHostMapping | undefined {
  const matches = mappings.filter((mapping) =>
    selectorValues(mapping, table)?.some((value) => String(value) === String(legacyId)));
  if (matches.length > 1) {
    throw new Error(`host mapping ambiguous: ${table}:${legacyId} assigned to ${matches.map((m) => m.mappingId).join(", ")}`);
  }
  return matches[0];
}

function oneRelationalMapping(
  table: LegacyHostAssignment["table"],
  id: number,
  candidates: Iterable<string>,
): string | undefined {
  const unique = new Set(candidates);
  if (unique.size > 1) {
    throw new Error(`host mapping relational conflict: ${table}:${id} resolves to ${[...unique].sort().join(", ")}`);
  }
  return [...unique][0];
}

/**
 * Validates full mapping coverage against the exact read-only snapshot.
 * Selectors pointing at missing rows, ambiguous paths and relational host
 * conflicts all fail before the migration backend is started.
 */
export function buildLegacyHostMappingApproval(
  snapshotPath: string,
  snapshotSha256: string,
  mappings: ApprovedLegacyHostMapping[],
): LegacyHostMappingApproval {
  assertSha256(snapshotSha256, "snapshotSha256");
  const mappingIds = new Set<string>();
  const hostIdentityByUuid = new Map<string, string>();
  for (const mapping of mappings) {
    if (!mapping.mappingId.trim() || !mapping.host.hostUuid.trim()) {
      throw new Error("approved host mapping requires mappingId and hostUuid");
    }
    if (mappingIds.has(mapping.mappingId)) throw new Error(`duplicate host mapping id: ${mapping.mappingId}`);
    mappingIds.add(mapping.mappingId);
    const hostIdentity = canonicalMigrationJson(mapping.host);
    const existingHostIdentity = hostIdentityByUuid.get(mapping.host.hostUuid);
    if (existingHostIdentity && existingHostIdentity !== hostIdentity) {
      throw new Error(`conflicting approved identity for hostUuid ${mapping.host.hostUuid}`);
    }
    hostIdentityByUuid.set(mapping.host.hostUuid, hostIdentity);
  }

  const db = new Database(snapshotPath, { readonly: true, create: false });
  try {
    db.run("PRAGMA query_only = ON");
    const sources = db.query<{ id: number; original_path: string }, []>(
      "SELECT id, original_path FROM source_files ORDER BY id",
    ).all();
    const projects = db.query<{ id: number; path?: string | null }, []>(
      hasColumn(db, "projects", "path")
        ? "SELECT id, path FROM projects ORDER BY id"
        : "SELECT id, NULL AS path FROM projects ORDER BY id",
    ).all();
    const projectColumn = hasColumn(db, "threads", "project_id");
    const threads = db.query<{ id: number; project_id?: number | null }, []>(
      projectColumn
        ? "SELECT id, project_id FROM threads ORDER BY id"
        : "SELECT id, NULL AS project_id FROM threads ORDER BY id",
    ).all();
    const records = db.query<{ thread_id: number; source_file_id: number | null }, []>(
      "SELECT thread_id, source_file_id FROM thread_records ORDER BY id",
    ).all();

    const idsByTable = {
      source_files: new Set(sources.map((row) => String(row.id))),
      projects: new Set(projects.map((row) => String(row.id))),
      threads: new Set(threads.map((row) => String(row.id))),
    };
    for (const mapping of mappings) {
      for (const table of ["projects", "source_files", "threads"] as const) {
        for (const selected of selectorValues(mapping, table) ?? []) {
          if (!idsByTable[table].has(String(selected))) {
            throw new Error(`host mapping ${mapping.mappingId} selects missing ${table}:${String(selected)}`);
          }
        }
      }
    }

    const assignments: LegacyHostAssignment[] = [];
    const sourceMappings = new Map<number, string>();
    for (const source of sources) {
      const explicit = explicitMapping(mappings, "source_files", source.id);
      const selected = resolveApprovedHostMapping(mappings, "source_files", source.id, source.original_path);
      sourceMappings.set(source.id, selected.mappingId);
      assignments.push({
        table: "source_files",
        legacyId: String(source.id),
        mappingId: selected.mappingId,
        basis: explicit ? "explicit" : "path",
      });
    }

    const sourceMappingsByThread = new Map<number, Set<string>>();
    for (const record of records) {
      if (record.source_file_id === null) continue;
      const mapping = sourceMappings.get(record.source_file_id);
      if (!mapping) continue; // provenance validator quarantines the exact broken FK
      const set = sourceMappingsByThread.get(record.thread_id) ?? new Set<string>();
      set.add(mapping);
      sourceMappingsByThread.set(record.thread_id, set);
    }

    const projectMappings = new Map<number, { mappingId: string; basis: LegacyHostAssignment["basis"] }>();
    for (const project of projects) {
      const explicit = explicitMapping(mappings, "projects", project.id);
      let direct: ApprovedLegacyHostMapping | undefined;
      try {
        direct = resolveApprovedHostMapping(mappings, "projects", project.id, project.path ?? undefined);
      } catch (error) {
        if (!String(error).includes("host mapping missing")) throw error;
      }
      const related = threads
        .filter((thread) => thread.project_id === project.id)
        .flatMap((thread) => [...(sourceMappingsByThread.get(thread.id) ?? [])]);
      const relational = oneRelationalMapping("projects", project.id, related);
      const candidates = new Set([direct?.mappingId, relational].filter(Boolean) as string[]);
      if (candidates.size > 1) {
        throw new Error(`host mapping relational conflict: projects:${project.id} resolves to ${[...candidates].join(", ")}`);
      }
      const mappingId = [...candidates][0];
      if (!mappingId) throw new Error(`host mapping missing: projects:${project.id} has no approved assignment`);
      const basis: LegacyHostAssignment["basis"] = explicit
        ? "explicit"
        : direct
          ? "path"
          : "source_relation";
      projectMappings.set(project.id, { mappingId, basis });
      assignments.push({ table: "projects", legacyId: String(project.id), mappingId, basis });
    }

    for (const thread of threads) {
      const explicit = explicitMapping(mappings, "threads", thread.id);
      const source = oneRelationalMapping(
        "threads",
        thread.id,
        sourceMappingsByThread.get(thread.id) ?? [],
      );
      const project = thread.project_id === null || thread.project_id === undefined
        ? undefined
        : projectMappings.get(thread.project_id)?.mappingId;
      const candidates = new Set([explicit?.mappingId, source, project].filter(Boolean) as string[]);
      if (candidates.size > 1) {
        throw new Error(`host mapping relational conflict: threads:${thread.id} resolves to ${[...candidates].join(", ")}`);
      }
      const mappingId = [...candidates][0];
      if (!mappingId) throw new Error(`host mapping missing: threads:${thread.id} has no approved assignment`);
      assignments.push({
        table: "threads",
        legacyId: String(thread.id),
        mappingId,
        basis: explicit ? "explicit" : source ? "source_relation" : "project_relation",
      });
    }

    assignments.sort((a, b) => a.table.localeCompare(b.table) || a.legacyId.localeCompare(b.legacyId));
    const body = {
      kind: "baka-legacy-host-mapping-approval" as const,
      formatVersion: HOST_MAPPING_APPROVAL_FORMAT_VERSION as 1,
      snapshotSha256,
      mappings: normalizedMappings(mappings),
      assignments,
    };
    return { ...body, artifactSha256: migrationArtifactSha256(body) };
  } finally {
    db.close();
  }
}

export interface MigrationPreflightEvidence {
  snapshotSha256: string;
  snapshotSizeBytes: number;
  checkRawFiles: boolean;
  tableTotals: Record<LegacyTable, number>;
  problems: PreflightProblem[];
  liveProbe: CanonicalLiveProbeEvidence;
  expectedDeletedCount: number;
  hostMappingArtifactSha256: string;
}

export interface MigrationPreflightApproval {
  kind: "baka-legacy-preflight-approval";
  formatVersion: 1;
  approvedAt: string;
  /**
   * Audit label only. This field is integrity-protected, but it is not an
   * authentication factor and does not prove that a human approved the run.
   * The runner separately requires externalApprovalDigest.
   */
  approvedBy: string;
  evidence: MigrationPreflightEvidence;
  evidenceSha256: string;
  artifactSha256: string;
}

export function buildMigrationPreflightApproval(input: {
  report: PreflightReport;
  snapshotSizeBytes: number;
  checkRawFiles: boolean;
  liveProbe: LiveCorpusProbe;
  hostMappingArtifactSha256: string;
  approvedBy: string;
  approvedAt?: string;
}): MigrationPreflightApproval {
  if (!input.liveProbe.available) throw new Error("operator approval requires successful live corpus probe");
  if (!input.report.snapshotSha256) throw new Error("preflight report не содержит snapshotSha256");
  assertSha256(input.report.snapshotSha256, "preflight snapshotSha256");
  assertSha256(input.hostMappingArtifactSha256, "hostMappingArtifactSha256");
  if (!input.report.reconciliation.ok || input.report.reconciliation.lost !== 0) {
    throw new Error("preflight reconciliation не подтверждает полный учёт legacy rows");
  }
  const tableTotals = Object.fromEntries(LEGACY_TABLES.map((table) => {
    const total = input.report.reconciliation.tables[table]?.total;
    if (!Number.isSafeInteger(total) || total! < 0) throw new Error(`preflight missing total: ${table}`);
    return [table, total];
  })) as Record<LegacyTable, number>;
  const evidence: MigrationPreflightEvidence = {
    snapshotSha256: input.report.snapshotSha256,
    snapshotSizeBytes: input.snapshotSizeBytes,
    checkRawFiles: input.checkRawFiles,
    tableTotals,
    problems: canonicalProblems(input.report.problems),
    liveProbe: canonicalLiveProbe(input.liveProbe),
    expectedDeletedCount: input.report.deletedInSource,
    hostMappingArtifactSha256: input.hostMappingArtifactSha256,
  };
  const evidenceSha256 = migrationArtifactSha256(evidence);
  const body = {
    kind: "baka-legacy-preflight-approval" as const,
    formatVersion: MIGRATION_APPROVAL_FORMAT_VERSION as 1,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
    approvedBy: input.approvedBy.trim(),
    evidence,
    evidenceSha256,
  };
  if (!body.approvedBy) throw new Error("approvedBy обязателен");
  return { ...body, artifactSha256: migrationArtifactSha256(body) };
}

export function validateMigrationPreflightApproval(approval: MigrationPreflightApproval): void {
  if (approval.kind !== "baka-legacy-preflight-approval" || approval.formatVersion !== 1) {
    throw new Error("unsupported migration preflight approval format");
  }
  assertSha256(approval.evidence.snapshotSha256, "approval snapshotSha256");
  assertSha256(approval.evidence.hostMappingArtifactSha256, "approval host mapping SHA");
  if (migrationArtifactSha256(approval.evidence) !== approval.evidenceSha256) {
    throw new Error("migration preflight approval evidence SHA mismatch");
  }
  const { artifactSha256: _ignored, ...body } = approval;
  if (migrationArtifactSha256(body) !== approval.artifactSha256) {
    throw new Error("migration preflight approval artifact SHA mismatch");
  }
  if (!approval.approvedBy.trim() || !Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new Error("migration preflight approval metadata invalid");
  }
  if (!approval.evidence.liveProbe.available) throw new Error("approved live-probe evidence unavailable");
  const totalKeys = Object.keys(approval.evidence.tableTotals).sort();
  if (canonicalMigrationJson(totalKeys) !== canonicalMigrationJson([...LEGACY_TABLES].sort())) {
    throw new Error("approval table totals set is truncated or contains unknown tables");
  }
  for (const table of LEGACY_TABLES) {
    const total = approval.evidence.tableTotals[table];
    if (!Number.isSafeInteger(total) || total < 0) throw new Error(`approval table total invalid: ${table}`);
  }
}

/** Durable, no-clobber JSON artifact for explicit operator hand-off to CLI. */
export async function writeMigrationPreflightApprovalArtifact(
  filePath: string,
  approval: MigrationPreflightApproval,
): Promise<void> {
  validateMigrationPreflightApproval(approval);
  await writePrivateFileAtomicNoClobber(
    path.resolve(filePath),
    `${JSON.stringify(approval, null, 2)}\n`,
  );
}

export async function readMigrationPreflightApprovalArtifact(
  filePath: string,
): Promise<MigrationPreflightApproval> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as MigrationPreflightApproval;
  validateMigrationPreflightApproval(parsed);
  return parsed;
}

export interface MigrationEvidenceFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface MigrationSafetyEvidence {
  /** Logical export; the matching manifest path is derived fail-closed. */
  backup: MigrationEvidenceFile;
  /** Persisted semantic restore report, not a caller-supplied boolean. */
  restore: MigrationEvidenceFile & { ok?: true };
}

export interface MigrationSafetyRuntimeContext {
  schemaVersion: number;
  /** Independently supplied live source environment; never derived from evidence. */
  sourceNamespace: string;
  sourceDatabase: string;
  /** Unique disposable restore target namespace, distinct from the source namespace. */
  restoreNamespace: string;
  archiveRoot: string;
}

export interface MigrationRunAuthorization {
  approval: MigrationPreflightApproval;
  /** Exact immutable file whose bytes were reviewed and signed. */
  approvalFile?: MigrationEvidenceFile;
  /** Detached signature; the runner never creates or signs this object. */
  attestation?: MigrationManualAttestation;
  currentLiveProbe: LiveCorpusProbe;
  hostMapping: LegacyHostMappingApproval;
  safety: MigrationSafetyEvidence;
  /** @deprecated ignored; a self-copied digest is not authentication. */
  externalApprovalDigest?: string;
  /** @deprecated ignored; the signed attestation carries the observed count. */
  externallyConfirmedDeletedCount?: number;
}

async function withStableRegularFile<T>(
  filePath: string,
  label: string,
  consume: (descriptor: Awaited<ReturnType<typeof open>>, size: number) => Promise<T>,
): Promise<T> {
  const descriptor = await open(path.resolve(filePath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) throw new Error(`${label} artifact is not regular file`);
    const value = await consume(descriptor, before.size);
    const after = await descriptor.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} artifact changed during verification`);
    }
    return value;
  } finally {
    await descriptor.close();
  }
}

async function hashStableRegularFile(
  filePath: string,
  label: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  return withStableRegularFile(filePath, label, async (descriptor, size) => {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await descriptor.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) throw new Error(`${label} artifact was truncated during verification`);
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { sha256: digest.digest("hex"), sizeBytes: position };
  });
}

async function readStableRegularFile(filePath: string, label: string): Promise<Buffer> {
  return withStableRegularFile(filePath, label, async (descriptor, size) => {
    const content = await descriptor.readFile();
    if (content.byteLength !== size) throw new Error(`${label} artifact size changed during verification`);
    return content;
  });
}

/**
 * Detached manual attestation payload. It deliberately contains no public
 * key: trust is supplied independently by the runner/CLI configuration.
 */
export interface MigrationManualAttestationPayload {
  approvalFileSha256: string;
  approvalArtifactSha256: string;
  hostMappingArtifactSha256: string;
  snapshotSha256: string;
  snapshotSizeBytes: number;
  observedDeletedCount: number;
  issuedAt: string;
}

export interface MigrationManualAttestation {
  kind: "baka-legacy-migration-attestation";
  formatVersion: 1;
  keyFingerprint: string;
  payload: MigrationManualAttestationPayload;
  /** Canonical base64 Ed25519 signature over canonicalMigrationJson(payload). */
  signature: string;
}

/** Independently configured/precommitted trust anchor. */
export interface MigrationApprovalTrustAnchor {
  ed25519PublicKeyPem: string;
  sha256Fingerprint: string;
}

function ed25519PublicKey(anchor: MigrationApprovalTrustAnchor) {
  assertSha256(anchor.sha256Fingerprint, "trusted approval key fingerprint");
  const key = createPublicKey(anchor.ed25519PublicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("migration approval trust anchor must be an Ed25519 public key");
  }
  const der = key.export({ format: "der", type: "spki" });
  const fingerprint = createHash("sha256").update(der).digest("hex");
  if (fingerprint !== anchor.sha256Fingerprint) {
    throw new Error("migration approval public key does not match precommitted fingerprint");
  }
  return { key, fingerprint };
}

export function migrationApprovalKeyFingerprint(ed25519PublicKeyPem: string): string {
  const key = createPublicKey(ed25519PublicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("migration approval public key must be Ed25519");
  }
  return createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function canonicalBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("migration attestation signature must be canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    throw new Error("migration attestation signature must be a 64-byte Ed25519 signature");
  }
  return decoded;
}

export function parseMigrationManualAttestation(value: unknown): MigrationManualAttestation {
  const raw = objectRecord(value);
  const payload = objectRecord(raw?.payload);
  if (
    !raw || raw.kind !== "baka-legacy-migration-attestation" ||
    raw.formatVersion !== MIGRATION_ATTESTATION_FORMAT_VERSION || !payload ||
    typeof raw.keyFingerprint !== "string" || typeof raw.signature !== "string"
  ) {
    throw new Error("unsupported or malformed migration manual attestation");
  }
  const expectedRootKeys = ["formatVersion", "keyFingerprint", "kind", "payload", "signature"];
  if (canonicalMigrationJson(Object.keys(raw).sort()) !== canonicalMigrationJson(expectedRootKeys)) {
    throw new Error("migration attestation fields are incomplete or unknown");
  }
  const expectedPayloadKeys = [
    "approvalArtifactSha256",
    "approvalFileSha256",
    "hostMappingArtifactSha256",
    "issuedAt",
    "observedDeletedCount",
    "snapshotSha256",
    "snapshotSizeBytes",
  ];
  if (canonicalMigrationJson(Object.keys(payload).sort()) !== canonicalMigrationJson(expectedPayloadKeys)) {
    throw new Error("migration attestation payload fields are incomplete or unknown");
  }
  for (const field of [
    "approvalFileSha256",
    "approvalArtifactSha256",
    "hostMappingArtifactSha256",
    "snapshotSha256",
  ] as const) {
    if (typeof payload[field] !== "string") throw new Error(`migration attestation ${field} missing`);
    assertSha256(payload[field] as string, `migration attestation ${field}`);
  }
  if (
    !Number.isSafeInteger(payload.snapshotSizeBytes) || (payload.snapshotSizeBytes as number) < 1 ||
    !Number.isSafeInteger(payload.observedDeletedCount) || (payload.observedDeletedCount as number) < 0 ||
    typeof payload.issuedAt !== "string" || !Number.isFinite(Date.parse(payload.issuedAt)) ||
    new Date(payload.issuedAt as string).toISOString() !== payload.issuedAt
  ) {
    throw new Error("migration attestation numeric/time fields invalid");
  }
  assertSha256(raw.keyFingerprint, "migration attestation keyFingerprint");
  canonicalBase64(raw.signature);
  return {
    kind: "baka-legacy-migration-attestation",
    formatVersion: 1,
    keyFingerprint: raw.keyFingerprint,
    payload: payload as unknown as MigrationManualAttestationPayload,
    signature: raw.signature,
  };
}

export function verifyMigrationManualAttestation(input: {
  attestation: MigrationManualAttestation;
  approval: MigrationPreflightApproval;
  approvalFileSha256: string;
  trustAnchor: MigrationApprovalTrustAnchor;
}): { attestationSha256: string; keyFingerprint: string; issuedAt: string } {
  const attestation = parseMigrationManualAttestation(input.attestation);
  const trusted = ed25519PublicKey(input.trustAnchor);
  if (attestation.keyFingerprint !== trusted.fingerprint) {
    throw new Error("migration attestation signer does not match trusted key fingerprint");
  }
  const expected: MigrationManualAttestationPayload = {
    approvalFileSha256: input.approvalFileSha256,
    approvalArtifactSha256: input.approval.artifactSha256,
    hostMappingArtifactSha256: input.approval.evidence.hostMappingArtifactSha256,
    snapshotSha256: input.approval.evidence.snapshotSha256,
    snapshotSizeBytes: input.approval.evidence.snapshotSizeBytes,
    observedDeletedCount: input.approval.evidence.expectedDeletedCount,
    issuedAt: attestation.payload.issuedAt,
  };
  if (canonicalMigrationJson(attestation.payload) !== canonicalMigrationJson(expected)) {
    throw new Error("migration attestation is not bound to exact approved evidence");
  }
  const verified = verifySignature(
    null,
    Buffer.from(canonicalMigrationJson(attestation.payload), "utf8"),
    trusted.key,
    canonicalBase64(attestation.signature),
  );
  if (!verified) throw new Error("migration manual attestation signature verification failed");
  return {
    attestationSha256: migrationArtifactSha256(attestation),
    keyFingerprint: trusted.fingerprint,
    issuedAt: attestation.payload.issuedAt,
  };
}

/** CLI seam: load a detached attestation; verification still requires trust. */
export async function readMigrationManualAttestationArtifact(
  filePath: string,
): Promise<MigrationManualAttestation> {
  return parseMigrationManualAttestation(JSON.parse(await readFile(filePath, "utf8")));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Hash a regular non-symlink file while detecting replacement races. */
export async function verifyMigrationEvidenceFile(
  evidence: MigrationEvidenceFile,
  label: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  assertSha256(evidence.sha256, `${label} SHA`);
  if (!Number.isSafeInteger(evidence.sizeBytes) || evidence.sizeBytes < 1) {
    throw new Error(`${label} artifact size invalid`);
  }
  if (!Number.isFinite(Date.parse(evidence.createdAt))) {
    throw new Error(`${label} artifact createdAt invalid`);
  }
  const actual = await hashStableRegularFile(evidence.path, label);
  if (actual.sha256 !== evidence.sha256 || actual.sizeBytes !== evidence.sizeBytes) {
    throw new Error(`${label} artifact hash/size mismatch`);
  }
  return actual;
}

async function readAuthenticatedEvidenceJson(
  evidence: MigrationEvidenceFile,
  label: string,
): Promise<unknown> {
  assertSha256(evidence.sha256, `${label} SHA`);
  if (!Number.isSafeInteger(evidence.sizeBytes) || evidence.sizeBytes < 1) {
    throw new Error(`${label} artifact size invalid`);
  }
  const content = await readStableRegularFile(evidence.path, label);
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (sha256 !== evidence.sha256 || content.byteLength !== evidence.sizeBytes) {
    throw new Error(`${label} artifact hash/size mismatch`);
  }
  return JSON.parse(content.toString("utf8"));
}

export async function validateMigrationRunAttestation(
  authorization: MigrationRunAuthorization,
  trustAnchor: MigrationApprovalTrustAnchor,
): Promise<{ attestationSha256: string; keyFingerprint: string; issuedAt: string }> {
  if (!authorization.approvalFile || !authorization.attestation) {
    throw new Error("detached signed migration approval attestation обязателен");
  }
  const approvalJson = await readAuthenticatedEvidenceJson(
    authorization.approvalFile,
    "migration approval file",
  );
  const persistedApproval = approvalJson as MigrationPreflightApproval;
  validateMigrationPreflightApproval(persistedApproval);
  if (canonicalMigrationJson(persistedApproval) !== canonicalMigrationJson(authorization.approval)) {
    throw new Error("runtime approval object differs from exact signed approval file");
  }
  return verifyMigrationManualAttestation({
    attestation: authorization.attestation,
    approval: authorization.approval,
    approvalFileSha256: authorization.approvalFile.sha256,
    trustAnchor,
  });
}

export interface ValidatedMigrationSafetyEvidence {
  manifestPath: string;
  manifestSha256: string;
  rawManifestSha256: string;
  restoreNamespace: string;
  restoreCreatedAt: string;
  restoreStartedAt: string;
  restoreFinishedAt: string;
  restoreRunId: string;
  sourceNamespace: string;
  sourceDatabase: string;
  schemaVersion: number;
  rawArchiveRoot: string;
}

/**
 * Runtime semantic validation of the exact export + manifest + restore report.
 * Caller-provided ok:true and self-consistent hashes are deliberately
 * insufficient: every binding is re-parsed and re-hashed here.
 */
export async function validateMigrationSafetyEvidence(
  safety: MigrationSafetyEvidence,
  context: MigrationSafetyRuntimeContext,
): Promise<ValidatedMigrationSafetyEvidence> {
  await verifyMigrationEvidenceFile(safety.backup, "backup export");
  const restoreJson = await readAuthenticatedEvidenceJson(safety.restore, "restore report");
  const exportPath = path.resolve(safety.backup.path);
  const manifestPath = path.resolve(manifestPathForExport(exportPath));
  const manifestContent = await readStableRegularFile(manifestPath, "backup manifest");
  const manifestText = manifestContent.toString("utf8");
  const manifest = parseBackupManifest(JSON.parse(manifestText), manifestPath);
  const manifestHashes = {
    sha256: createHash("sha256").update(manifestContent).digest("hex"),
    sizeBytes: manifestContent.byteLength,
  };
  if (!manifest.rawManifestSha256) {
    throw new Error("backup manifest rawManifestSha256 обязателен для migration run");
  }
  assertSha256(manifest.rawManifestSha256, "backup manifest rawManifestSha256");
  if (
    !context.sourceNamespace.trim() || !context.sourceDatabase.trim() ||
    manifest.namespace !== context.sourceNamespace || manifest.database !== context.sourceDatabase
  ) {
    throw new Error("backup manifest source namespace/database runtime binding mismatch");
  }
  if (
    manifest.exportFile !== path.basename(exportPath) ||
    manifest.exportSha256 !== safety.backup.sha256 ||
    manifest.exportBytes !== safety.backup.sizeBytes
  ) {
    throw new Error("backup export/manifest hash/size/path binding mismatch");
  }

  const restore: PersistedRestoreTestReport = parsePersistedRestoreTestReport(restoreJson);
  const archiveRoot = path.resolve(context.archiveRoot);
  if (
    context.schemaVersion !== 1 || restore.schemaVersion !== context.schemaVersion ||
    restore.namespace !== context.restoreNamespace ||
    restore.namespace === context.sourceNamespace ||
    restore.database !== context.sourceDatabase ||
    restore.archiveRoot !== archiveRoot || restore.rawArchiveRoot !== archiveRoot ||
    context.archiveRoot !== archiveRoot
  ) {
    throw new Error("restore report schema/namespace/database/archiveRoot runtime binding mismatch");
  }
  if (
    restore.createdAt !== safety.restore.createdAt ||
    restore.exportPath !== exportPath ||
    restore.exportFile !== manifest.exportFile ||
    restore.exportSha256 !== manifest.exportSha256 ||
    restore.exportBytes !== manifest.exportBytes ||
    restore.manifestPath !== manifestPath ||
    restore.manifestFile !== path.basename(manifestPath) ||
    restore.manifestSha256 !== manifestHashes.sha256 ||
    restore.rawManifestSha256 !== manifest.rawManifestSha256 ||
    restore.schemaVersion !== manifest.schemaVersion ||
    safety.backup.createdAt !== manifest.createdAt ||
    Date.parse(manifest.createdAt) > Date.parse(restore.startedAt)
  ) {
    throw new Error("restore report is not bound to exact authenticated backup/export/manifest");
  }
  return {
    manifestPath,
    manifestSha256: manifestHashes.sha256,
    rawManifestSha256: manifest.rawManifestSha256,
    restoreNamespace: restore.namespace,
    restoreCreatedAt: restore.createdAt,
    restoreStartedAt: restore.startedAt,
    restoreFinishedAt: restore.finishedAt,
    restoreRunId: restore.runId,
    sourceNamespace: manifest.namespace,
    sourceDatabase: restore.database,
    schemaVersion: restore.schemaVersion,
    rawArchiveRoot: restore.rawArchiveRoot,
  };
}

/** CLI seam: construct exact evidence metadata from already-published files. */
export async function loadMigrationSafetyEvidence(input: {
  exportPath: string;
  restoreReportPath: string;
  context: MigrationSafetyRuntimeContext;
}): Promise<MigrationSafetyEvidence> {
  const restoreRaw = parsePersistedRestoreTestReport(
    JSON.parse(await readFile(input.restoreReportPath, "utf8")),
  );
  const backup = await hashFile(input.exportPath);
  const restore = await hashFile(input.restoreReportPath);
  const safety: MigrationSafetyEvidence = {
    backup: {
      path: path.resolve(input.exportPath),
      sha256: backup.sha256,
      sizeBytes: backup.sizeBytes,
      createdAt: parseBackupManifest(
        JSON.parse(await readFile(manifestPathForExport(input.exportPath), "utf8")),
      ).createdAt,
    },
    restore: {
      path: path.resolve(input.restoreReportPath),
      sha256: restore.sha256,
      sizeBytes: restore.sizeBytes,
      createdAt: restoreRaw.createdAt,
      ok: true,
    },
  };
  await validateMigrationSafetyEvidence(safety, input.context);
  return safety;
}

/** Dummy identity is safe: approval verification uses analysis problems, not host preview. */
export const APPROVAL_ANALYSIS_IDENTITY: LocalIdentity = {
  hostUuid: "migration-approval-validation",
  hostname: "migration-approval-validation",
  platform: "unknown",
  arch: "unknown",
  osUsername: "unknown",
  homePath: "/__migration_approval_validation__",
};
