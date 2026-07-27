/**
 * Safe reparse of immutable raw source revisions (docs/plan.md §11.1, §17).
 *
 * The command-facing API requires one explicit selector. Harness/location/all
 * selectors operate on location.current_revision only; an explicitly named
 * historical source revision is reported as skipped instead of rewinding a
 * dialogue to old raw content. Parsing and canonical writes are delegated to
 * HARNESS_TOOLS + ingestSourceRevision, preserving the per-dialogue
 * transaction and current-pointer semantics from structured sync.
 */

import { constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import type { AppConfig } from "./config.ts";
import { connectDb } from "./db/client.ts";
import { checkSchemaVersion, gitHead, listMigrations } from "./db/migrations.ts";
import { ensureHost } from "./db/repositories/identity.ts";
import { selectAll } from "./db/repositories/helpers.ts";
import {
  createSyncRun,
  finishSyncRun,
  listActiveEmbeddingSpaces,
  resolveStaleIngestErrors,
  setLocationRevisions,
  updateSourceRevisionParse,
} from "./db/repositories/provenance.ts";
import { listEmbeddingTables } from "./embeddings/spaces.ts";
import { acquireLock } from "./infra/lock.ts";
import { assertPreflight } from "./infra/preflight.ts";
import { sanitizeLogFields } from "./observability.ts";
import type { HarnessSlug } from "./sources/adapters/harnesses.ts";
import { HARNESS_ORDER } from "./sources/adapters/harnesses.ts";
import { hashFile } from "./sources/snapshot/hashing.ts";
import { HARNESS_TOOLS, kimiSessionDir } from "./sync/harness-tools.ts";
import { localIdentity } from "./sync/host-identity.ts";
import {
  ingestSourceRevision,
  type IngestContext,
  type IngestOutcome,
} from "./sync/revision-ingestor.ts";

export type ReparseRecordInput = string | RecordId;

export type ReparseSelection =
  | { sourceRevisions: ReparseRecordInput[] }
  | { sourceLocations: ReparseRecordInput[] }
  | { harness: HarnessSlug }
  | { all: true };

export interface ReparseOptions {
  selection: ReparseSelection;
  /** Only the currently registered parser can execute; "latest" is the normal CLI value. */
  parserVersion?: "latest" | number;
  /** Skip targets already recorded with the registered parser version. */
  onlyOutdated?: boolean;
  /** Read-only plan: no parser, corpus, source revision, error or sync_run writes. */
  dryRun?: boolean;
  /** Default true; reparsed current revisions should receive normal embedding jobs. */
  enqueueEmbeddings?: boolean;
  /** Full SHA-256 check of immutable raw before parsing (default true). */
  verifyRaw?: boolean;
  /** High-level runReparse only: false is useful for isolated integration tests. */
  preflight?: boolean;
  hostIdPath?: string;
  logger?: (event: Record<string, unknown>) => void;
}

export interface ReparseTarget {
  id: RecordId;
  sourceLocation: RecordId;
  locationCurrentRevision?: RecordId;
  lastSuccessfulRevision?: RecordId;
  sourceRoot: RecordId;
  harnessInstallation: RecordId;
  host: RecordId;
  harness: HarnessSlug;
  relativePath: string;
  rawArchivePath: string;
  sha256: string;
  parserName: string;
  parserVersion: string;
  parseStatus: string;
  canonicalHash?: string;
  dialoguesDiscovered?: number;
  syncRun?: RecordId;
  syncRunStatus?: string;
}

export interface ReparseSkippedTarget {
  id: string;
  reason:
    | "not_found"
    | "historical_revision"
    | "already_latest"
    | "unsupported_parse_unit"
    | "incomplete_session";
  detail?: string;
}

export interface ReparseUnit {
  key: string;
  kind: "file" | "kimi-session";
  harness: HarnessSlug;
  relativePath: string;
  targets: ReparseTarget[];
  primary: ReparseTarget;
}

export interface ReparsePlan {
  units: ReparseUnit[];
  selectedRevisionIds: string[];
  expandedRevisionIds: string[];
  skipped: ReparseSkippedTarget[];
}

export interface ReparseSummary {
  status: "dry_run" | "completed" | "completed_with_errors";
  syncRunId?: string;
  counters: {
    selectedRevisions: number;
    expandedRevisions: number;
    unitsPlanned: number;
    unitsProcessed: number;
    unitsSucceeded: number;
    unitsFailed: number;
    unitsSkipped: number;
    dialoguesDiscovered: number;
    dialoguesWritten: number;
    messagesWritten: number;
    chunksWritten: number;
    searchDocuments: number;
    embeddingJobs: number;
    ingestErrors: number;
  };
  skipped: ReparseSkippedTarget[];
  errors: string[];
}

interface ReparseTargetRow {
  id: RecordId;
  source_location: RecordId;
  location_current_revision?: RecordId;
  last_successful_revision?: RecordId;
  source_root: RecordId;
  harness_installation: RecordId;
  host: RecordId;
  harness_slug: string;
  relative_path: string;
  raw_archive_path: string;
  sha256: string;
  captured_at: Date | string;
  parser_name: string;
  parser_version: string;
  parse_status: string;
  canonical_hash?: string;
  dialogues_discovered?: number;
  sync_run?: RecordId;
  sync_run_status?: string;
}

export interface ReparseDependencies {
  ingest: typeof ingestSourceRevision;
  updateParse: typeof updateSourceRevisionParse;
  setLocation: typeof setLocationRevisions;
  resolveErrors: typeof resolveStaleIngestErrors;
  verifyFile: typeof hashFile;
  updateParserIdentity: (
    db: Surreal,
    id: RecordId,
    parserName: string,
    parserVersion: number,
  ) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: ReparseDependencies = {
  ingest: ingestSourceRevision,
  updateParse: updateSourceRevisionParse,
  setLocation: setLocationRevisions,
  resolveErrors: resolveStaleIngestErrors,
  verifyFile: hashFile,
  updateParserIdentity: async (db, id, parserName, parserVersion) => {
    await db.query(
      "UPDATE $id SET parser_name = $parser, parser_version = $version",
      { id, parser: parserName, version: String(parserVersion) },
    );
  },
};

function defaultLogger(event: Record<string, unknown>): void {
  const eventName = typeof event.event === "string" ? event.event : "reparse_event";
  const { event: _event, ...fields } = event;
  console.error(JSON.stringify({ event: eventName, ...sanitizeLogFields(fields) }));
}

function recordText(value: RecordId | undefined): string | undefined {
  return value?.toString();
}

function sameRecord(a: RecordId | undefined, b: RecordId | undefined): boolean {
  return a !== undefined && b !== undefined && a.toString() === b.toString();
}

function recordId(table: "source_revision" | "source_location", input: ReparseRecordInput): RecordId {
  if (input instanceof RecordId) {
    if (input.table.name !== table) {
      throw new Error(`expected ${table} record id, got ${input.toString()}`);
    }
    return input;
  }
  const value = input.trim();
  if (!value) throw new Error(`${table} id is empty`);
  const colon = value.indexOf(":");
  if (colon > 0) {
    const prefix = value.slice(0, colon);
    if (prefix !== table) throw new Error(`expected ${table} record id, got ${value}`);
    return new RecordId(table, value.slice(colon + 1));
  }
  return new RecordId(table, value);
}

function validateSelection(selection: ReparseSelection): void {
  if ("sourceRevisions" in selection && selection.sourceRevisions.length === 0) {
    throw new Error("sourceRevisions selector is empty");
  }
  if ("sourceLocations" in selection && selection.sourceLocations.length === 0) {
    throw new Error("sourceLocations selector is empty");
  }
  if ("harness" in selection && !HARNESS_ORDER.includes(selection.harness)) {
    throw new Error(`unknown harness: ${selection.harness}`);
  }
}

function mapTarget(row: ReparseTargetRow): ReparseTarget {
  if (!HARNESS_ORDER.includes(row.harness_slug as HarnessSlug)) {
    throw new Error(`source revision ${row.id.toString()} has unknown harness ${row.harness_slug}`);
  }
  return {
    id: row.id,
    sourceLocation: row.source_location,
    locationCurrentRevision: row.location_current_revision,
    lastSuccessfulRevision: row.last_successful_revision,
    sourceRoot: row.source_root,
    harnessInstallation: row.harness_installation,
    host: row.host,
    harness: row.harness_slug as HarnessSlug,
    relativePath: row.relative_path,
    rawArchivePath: row.raw_archive_path,
    sha256: row.sha256,
    parserName: row.parser_name,
    parserVersion: row.parser_version,
    parseStatus: row.parse_status,
    canonicalHash: row.canonical_hash,
    dialoguesDiscovered: row.dialogues_discovered,
    syncRun: row.sync_run,
    syncRunStatus: row.sync_run_status,
  };
}

const TARGET_PROJECTION = `id, source_location,
  source_location.current_revision AS location_current_revision,
  source_location.last_successful_revision AS last_successful_revision,
  source_location.source_root AS source_root,
  source_location.source_root.harness_installation AS harness_installation,
  source_location.source_root.harness_installation.host AS host,
  source_location.source_root.harness_installation.harness.slug AS harness_slug,
  source_location.relative_path AS relative_path, raw_archive_path, sha256,
  captured_at, parser_name, parser_version, parse_status, canonical_hash, dialogues_discovered,
  sync_run, sync_run.status AS sync_run_status`;

async function selectTargetRows(
  db: Surreal,
  selection: ReparseSelection,
): Promise<{ rows: ReparseTargetRow[]; missing: ReparseSkippedTarget[] }> {
  if ("sourceRevisions" in selection) {
    const ids = selection.sourceRevisions.map((value) => recordId("source_revision", value));
    const rows = await selectAll<ReparseTargetRow>(
      db,
      `SELECT ${TARGET_PROJECTION} FROM source_revision WHERE id IN $ids
       ORDER BY captured_at ASC, id ASC`,
      { ids },
    );
    const found = new Set(rows.map((row) => row.id.toString()));
    return {
      rows,
      missing: ids
        .filter((id) => !found.has(id.toString()))
        .map((id) => ({ id: id.toString(), reason: "not_found" as const })),
    };
  }

  if ("sourceLocations" in selection) {
    const ids = selection.sourceLocations.map((value) => recordId("source_location", value));
    const rows = await selectAll<ReparseTargetRow>(
      db,
      `SELECT ${TARGET_PROJECTION} FROM source_revision
       WHERE source_location IN $ids AND id = source_location.current_revision
       ORDER BY captured_at ASC, id ASC`,
      { ids },
    );
    const foundLocations = new Set(rows.map((row) => row.source_location.toString()));
    return {
      rows,
      missing: ids
        .filter((id) => !foundLocations.has(id.toString()))
        .map((id) => ({
          id: id.toString(),
          reason: "not_found" as const,
          detail: "location missing or has no current revision",
        })),
    };
  }

  if ("harness" in selection) {
    const rows = await selectAll<ReparseTargetRow>(
      db,
      `SELECT ${TARGET_PROJECTION} FROM source_revision
       WHERE id = source_location.current_revision
         AND source_location.source_root.harness_installation.harness.slug = $harness
       ORDER BY captured_at ASC, id ASC`,
      { harness: selection.harness },
    );
    return { rows, missing: [] };
  }

  const rows = await selectAll<ReparseTargetRow>(
    db,
    `SELECT ${TARGET_PROJECTION} FROM source_revision
     WHERE id = source_location.current_revision ORDER BY captured_at ASC, id ASC`,
  );
  return { rows, missing: [] };
}

/** Current companion files are required to reconstruct a complete kimi session parse-view. */
async function expandKimiCompanions(db: Surreal, selected: ReparseTarget[]): Promise<ReparseTarget[]> {
  const roots = new Map<string, RecordId>();
  for (const target of selected) {
    if (target.harness === "kimi-code" && kimiSessionDir(target.relativePath)) {
      roots.set(target.sourceRoot.toString(), target.sourceRoot);
    }
  }
  if (roots.size === 0) return selected;
  const rows = await selectAll<ReparseTargetRow>(
    db,
    `SELECT ${TARGET_PROJECTION} FROM source_revision
     WHERE id = source_location.current_revision AND source_location.source_root IN $roots
     ORDER BY captured_at ASC, id ASC`,
    { roots: [...roots.values()] },
  );
  const candidates = rows.map(mapTarget);
  const selectedSessions = new Set(
    selected.flatMap((target) => {
      const session = target.harness === "kimi-code" ? kimiSessionDir(target.relativePath) : undefined;
      return session ? [`${target.sourceRoot.toString()}\0${session}`] : [];
    }),
  );
  const result = new Map(selected.map((target) => [target.id.toString(), target]));
  for (const candidate of candidates) {
    const session = kimiSessionDir(candidate.relativePath);
    if (!session) continue;
    if (selectedSessions.has(`${candidate.sourceRoot.toString()}\0${session}`)) {
      result.set(candidate.id.toString(), candidate);
    }
  }
  return [...result.values()];
}

interface KimiMembershipRow {
  id: RecordId;
  source_root: RecordId;
  relative_path: string;
  presence_status: string;
  current_revision?: RecordId;
  revision_source_location?: RecordId;
  revision_run_status?: string;
}

export interface KimiMembershipAssessment {
  ok: boolean;
  code?: string;
}

/**
 * Re-read the entire session membership from source_location. A parse-view is
 * allowed only when all known members are active, own an existing current raw
 * revision from a finished run, required state/main files exist, and the unit
 * exactly matches those current pointers. This check is repeated at execution
 * time so a plan cannot mix stale and current companions.
 */
export async function verifyKimiSessionMembership(
  db: Surreal,
  unit: ReparseUnit,
): Promise<KimiMembershipAssessment> {
  if (unit.kind !== "kimi-session") return { ok: true };
  const rows = await selectAll<KimiMembershipRow>(
    db,
    `SELECT id, source_root, relative_path, presence_status, current_revision,
       current_revision.source_location AS revision_source_location,
       current_revision.sync_run.status AS revision_run_status
     FROM source_location WHERE source_root = $root ORDER BY relative_path ASC, id ASC`,
    { root: unit.primary.sourceRoot },
  );
  const members = rows.filter((row) => kimiSessionDir(row.relative_path) === unit.relativePath);
  const required = [
    `${unit.relativePath}/state.json`,
    `${unit.relativePath}/agents/main/wire.jsonl`,
  ];
  if (required.some((relativePath) => !members.some((row) => row.relative_path === relativePath))) {
    return { ok: false, code: "kimi_required_member_missing" };
  }
  if (members.some((row) => row.presence_status !== "active")) {
    return { ok: false, code: "kimi_member_inactive" };
  }
  if (members.some((row) => row.current_revision === undefined || row.current_revision === null)) {
    return { ok: false, code: "kimi_current_revision_missing" };
  }
  if (
    members.some(
      (row) =>
        row.revision_source_location === undefined ||
        !sameRecord(row.revision_source_location, row.id),
    )
  ) {
    return { ok: false, code: "kimi_current_revision_cross_owner" };
  }
  if (
    members.some(
      (row) =>
        row.revision_run_status !== "completed" &&
        row.revision_run_status !== "completed_with_errors",
    )
  ) {
    return { ok: false, code: "kimi_snapshot_run_incomplete" };
  }
  if (
    unit.targets.some(
      (target) =>
        target.harness !== "kimi-code" ||
        !sameRecord(target.sourceRoot, unit.primary.sourceRoot) ||
        kimiSessionDir(target.relativePath) !== unit.relativePath ||
        !sameRecord(target.id, target.locationCurrentRevision),
    )
  ) {
    return { ok: false, code: "kimi_mixed_session_unit" };
  }
  const currentIds = members.map((row) => row.current_revision!.toString()).sort();
  const targetIds = unit.targets.map((target) => target.id.toString()).sort();
  if (
    currentIds.length !== targetIds.length ||
    currentIds.some((id, index) => id !== targetIds[index])
  ) {
    return { ok: false, code: "kimi_membership_changed" };
  }
  return { ok: true };
}

/** Resolve selectors without mutation and group targets by the parser's atomic parse unit. */
export async function planReparseTargets(
  db: Surreal,
  options: Pick<ReparseOptions, "selection" | "parserVersion" | "onlyOutdated">,
): Promise<ReparsePlan> {
  validateSelection(options.selection);
  const selectedRows = await selectTargetRows(db, options.selection);
  const skipped: ReparseSkippedTarget[] = [...selectedRows.missing];
  const selected = selectedRows.rows.map(mapTarget);
  const current: ReparseTarget[] = [];
  for (const target of selected) {
    if (!sameRecord(target.id, target.locationCurrentRevision)) {
      skipped.push({
        id: target.id.toString(),
        reason: "historical_revision",
        detail: `location current is ${recordText(target.locationCurrentRevision) ?? "NONE"}`,
      });
      continue;
    }
    const tools = HARNESS_TOOLS[target.harness];
    const requested = options.parserVersion ?? "latest";
    if (requested !== "latest" && requested !== tools.parser.parserVersion) {
      throw new Error(
        `parser ${target.harness}@${requested} is not registered; available version is ${tools.parser.parserVersion}`,
      );
    }
    if (options.onlyOutdated && target.parserVersion === String(tools.parser.parserVersion)) {
      skipped.push({ id: target.id.toString(), reason: "already_latest" });
      continue;
    }
    current.push(target);
  }

  const expanded = await expandKimiCompanions(db, current);
  const byUnit = new Map<string, ReparseTarget[]>();
  for (const target of expanded) {
    if (target.harness !== "kimi-code") {
      byUnit.set(`file\0${target.id.toString()}`, [target]);
      continue;
    }
    const session = kimiSessionDir(target.relativePath);
    if (!session) {
      // session_index.jsonl is archived provenance, not a dialogue source.
      if (current.some((item) => item.id.toString() === target.id.toString())) {
        skipped.push({
          id: target.id.toString(),
          reason: "unsupported_parse_unit",
          detail: "kimi-code file is outside a session directory",
        });
      }
      continue;
    }
    const key = `kimi\0${target.sourceRoot.toString()}\0${session}`;
    const list = byUnit.get(key) ?? [];
    list.push(target);
    byUnit.set(key, list);
  }

  let units: ReparseUnit[] = [...byUnit.entries()].map(([key, targets]) => {
    targets.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.id.toString().localeCompare(b.id.toString()));
    const session = targets[0]!.harness === "kimi-code"
      ? kimiSessionDir(targets[0]!.relativePath)!
      : targets[0]!.relativePath;
    const primary = targets.find((target) => target.relativePath.endsWith("/agents/main/wire.jsonl"))
      ?? targets[0]!;
    return {
      key,
      kind: targets[0]!.harness === "kimi-code" ? "kimi-session" : "file",
      harness: targets[0]!.harness,
      relativePath: session,
      targets,
      primary,
    };
  });
  units.sort((a, b) => a.key.localeCompare(b.key));

  const rejectedSelected = new Set<string>();
  const completeUnits: ReparseUnit[] = [];
  for (const unit of units) {
    if (unit.kind === "kimi-session") {
      const assessment = await verifyKimiSessionMembership(db, unit);
      if (!assessment.ok) {
        for (const target of current.filter((candidate) =>
          unit.targets.some((member) => member.id.toString() === candidate.id.toString())
        )) {
          rejectedSelected.add(target.id.toString());
          skipped.push({
            id: target.id.toString(),
            reason: "incomplete_session",
            detail: assessment.code,
          });
        }
        continue;
      }
    }
    completeUnits.push(unit);
  }
  units = completeUnits;

  const selectedIds = current
    .map((target) => target.id.toString())
    .filter((id) => !rejectedSelected.has(id))
    .sort();
  const selectedSet = new Set(selectedIds);
  const acceptedTargets = units.flatMap((unit) => unit.targets);
  const expandedIds = acceptedTargets
    .map((target) => target.id.toString())
    .filter((id) => !selectedSet.has(id))
    .sort();
  skipped.sort((a, b) => a.id.localeCompare(b.id) || a.reason.localeCompare(b.reason));
  return {
    units,
    selectedRevisionIds: selectedIds,
    expandedRevisionIds: expandedIds,
    skipped,
  };
}

export class ReparseSafetyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ReparseSafetyError";
    this.code = code;
  }
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function archivedPath(archiveRoot: string, relativeRawPath: string): Promise<string> {
  if (!relativeRawPath || path.isAbsolute(relativeRawPath)) {
    throw new ReparseSafetyError("raw_path_not_relative");
  }
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(root, relativeRawPath);
  if (!containedBy(root, resolved) || resolved === root) {
    throw new ReparseSafetyError("raw_path_escape");
  }
  const info = await lstat(resolved).catch(() => undefined);
  if (!info) throw new ReparseSafetyError("raw_file_missing");
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ReparseSafetyError("raw_file_not_regular");
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolved)]);
  if (!containedBy(realRoot, realFile)) {
    throw new ReparseSafetyError("raw_realpath_escape");
  }
  return realFile;
}

async function safeStagingDirectory(archiveRoot: string): Promise<string> {
  const root = path.resolve(archiveRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new ReparseSafetyError("archive_root_not_regular_directory");
  }
  const staging = path.join(root, "staging");
  const existing = await lstat(staging).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) await mkdir(staging);
  const stagingInfo = await lstat(staging);
  if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) {
    throw new ReparseSafetyError("staging_not_regular_directory");
  }
  const [realRoot, realStaging] = await Promise.all([realpath(root), realpath(staging)]);
  if (!containedBy(realRoot, realStaging)) {
    throw new ReparseSafetyError("staging_realpath_escape");
  }
  return staging;
}

async function verifyTargetRaw(
  archiveRoot: string,
  target: ReparseTarget,
  dependencies: ReparseDependencies,
): Promise<string> {
  const rawPath = await archivedPath(archiveRoot, target.rawArchivePath);
  const hashes = await dependencies.verifyFile(rawPath);
  if (hashes.sha256 !== target.sha256) {
    throw new ReparseSafetyError("immutable_raw_hash_mismatch");
  }
  return rawPath;
}

async function createKimiView(
  archiveRoot: string,
  temporaryRoot: string,
  unit: ReparseUnit,
  verifiedPaths: Map<string, string>,
): Promise<string> {
  const view = path.join(
    temporaryRoot,
    Buffer.from(unit.primary.id.toString(), "utf8").toString("base64url"),
  );
  const sessionBase = path.basename(unit.relativePath);
  const sessionView = path.join(view, sessionBase);
  for (const target of unit.targets) {
    const relative = target.relativePath.slice(unit.relativePath.length + 1);
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`invalid kimi session member: ${target.relativePath}`);
    }
    const source = verifiedPaths.get(target.id.toString())
      ?? await archivedPath(archiveRoot, target.rawArchivePath);
    const destination = path.resolve(sessionView, relative);
    if (!destination.startsWith(`${path.resolve(sessionView)}${path.sep}`)) {
      throw new Error(`kimi session member escapes parse-view: ${target.relativePath}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await link(source, destination);
    } catch {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    }
  }
  return sessionView;
}

function emptySummary(plan: ReparsePlan, syncRun?: RecordId): ReparseSummary {
  return {
    status: "completed",
    syncRunId: syncRun?.toString(),
    counters: {
      selectedRevisions: plan.selectedRevisionIds.length,
      expandedRevisions: plan.expandedRevisionIds.length,
      unitsPlanned: plan.units.length,
      unitsProcessed: 0,
      unitsSucceeded: 0,
      unitsFailed: 0,
      unitsSkipped: plan.skipped.length,
      dialoguesDiscovered: 0,
      dialoguesWritten: 0,
      messagesWritten: 0,
      chunksWritten: 0,
      searchDocuments: 0,
      embeddingJobs: 0,
      ingestErrors: 0,
    },
    skipped: [...plan.skipped],
    errors: [],
  };
}

function accumulate(summary: ReparseSummary, outcome: IngestOutcome): void {
  summary.counters.dialoguesDiscovered += outcome.dialoguesDiscovered;
  summary.counters.dialoguesWritten += outcome.dialoguesWritten;
  summary.counters.messagesWritten += outcome.messagesWritten;
  summary.counters.chunksWritten += outcome.chunksWritten;
  summary.counters.searchDocuments += outcome.searchDocumentsWritten;
  summary.counters.embeddingJobs += outcome.embeddingJobsCreated;
  summary.counters.ingestErrors += outcome.errors;
}

async function applyOutcome(
  db: Surreal,
  syncRun: RecordId,
  unit: ReparseUnit,
  outcome: IngestOutcome,
  dependencies: ReparseDependencies,
): Promise<void> {
  const parser = HARNESS_TOOLS[unit.harness].parser;
  if (outcome.status === "parsed") {
    // Only a fully successful parse replaces the recorded successful parser
    // state and closes historical errors. Location.current_revision is
    // already this target (historical targets never enter a plan).
    for (const target of unit.targets) {
      await dependencies.updateParse(db, target.id, {
        parseStatus: "parsed",
        dialoguesDiscovered: target === unit.primary ? outcome.dialoguesDiscovered : 0,
        canonicalHash: outcome.canonicalHash,
      });
      await dependencies.updateParserIdentity(
        db,
        target.id,
        parser.parserName,
        parser.parserVersion,
      );
      await dependencies.setLocation(db, target.sourceLocation, {
        currentRevision: target.id,
        lastSuccessfulRevision: target.id,
      });
    }
    await dependencies.resolveErrors(
      db,
      unit.targets.map((target) => target.id),
      syncRun,
      `reparse:parsed@${parser.parserVersion}`,
    );
    return;
  }

  // A failed attempt must not destroy the last-known-good source state. If
  // this revision had never parsed successfully, recording its current
  // failure is safe; location pointers remain untouched in both cases.
  for (const target of unit.targets) {
    if (target.parseStatus === "parsed") continue;
    await dependencies.updateParse(db, target.id, {
      parseStatus: outcome.status,
      dialoguesDiscovered: target === unit.primary ? outcome.dialoguesDiscovered : 0,
      canonicalHash: outcome.canonicalHash,
    });
  }
}

export interface ExecuteReparseInput {
  db: Surreal;
  archiveRoot: string;
  plan: ReparsePlan;
  syncRun?: RecordId;
  dryRun?: boolean;
  enqueueEmbeddings?: boolean;
  verifyRaw?: boolean;
  activeEmbeddingSpaces?: RecordId[];
  embeddingTables?: string[];
  logger?: (event: Record<string, unknown>) => void;
  dependencies?: Partial<ReparseDependencies>;
}

/** Execute an already resolved plan. Exposed separately for service/tests and CLI composition. */
export async function executeReparsePlan(input: ExecuteReparseInput): Promise<ReparseSummary> {
  const summary = emptySummary(input.plan, input.syncRun);
  if (input.dryRun) {
    summary.status = "dry_run";
    return summary;
  }
  if (!input.syncRun) throw new Error("syncRun is required for a non-dry reparse");
  const log = input.logger ?? defaultLogger;
  const dependencies: ReparseDependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  const staging = await safeStagingDirectory(input.archiveRoot);
  const temporaryRoot = await mkdtemp(path.join(staging, "reparse-"));
  try {
    for (const unit of input.plan.units) {
      summary.counters.unitsProcessed += 1;
      const parser = HARNESS_TOOLS[unit.harness];
      try {
        if (unit.kind === "kimi-session") {
          const membership = await verifyKimiSessionMembership(input.db, unit);
          if (!membership.ok) {
            throw new ReparseSafetyError(membership.code ?? "kimi_membership_invalid");
          }
        }
        const verifiedPaths = new Map<string, string>();
        for (const target of unit.targets) {
          const rawPath = input.verifyRaw === false
            ? await archivedPath(input.archiveRoot, target.rawArchivePath)
            : await verifyTargetRaw(input.archiveRoot, target, dependencies);
          verifiedPaths.set(target.id.toString(), rawPath);
        }
        const parsePath = unit.kind === "file"
          ? verifiedPaths.get(unit.primary.id.toString())!
          : await createKimiView(input.archiveRoot, temporaryRoot, unit, verifiedPaths);
        const context: IngestContext = {
          db: input.db,
          syncRun: input.syncRun,
          host: unit.primary.host,
          harnessInstallation: unit.primary.harnessInstallation,
          installationKey: unit.primary.harnessInstallation.toString(),
          parser: parser.parser,
          extractors: parser.extractors,
          activeEmbeddingSpaces: input.activeEmbeddingSpaces ?? [],
          enqueueEmbeddings: input.enqueueEmbeddings ?? true,
          embeddingTables: input.embeddingTables ?? [],
        };
        const outcome = await dependencies.ingest(context, {
          sourceRevision: unit.primary.id,
          parsePath,
          relativePath: unit.relativePath,
          harnessSlug: unit.harness,
        });
        accumulate(summary, outcome);
        await applyOutcome(input.db, input.syncRun, unit, outcome, dependencies);
        if (outcome.status === "parsed") {
          summary.counters.unitsSucceeded += 1;
        } else {
          summary.counters.unitsFailed += 1;
          summary.errors.push(`${unit.key}: reparse result ${outcome.status}`);
        }
        log({
          event: "reparse_unit",
          sourceRevisionId: unit.primary.id.toString(),
          harness: unit.harness,
          status: outcome.status,
          revisions: unit.targets.length,
          dialogues: outcome.dialoguesWritten,
          errors: outcome.errors,
        });
      } catch (error) {
        summary.counters.unitsFailed += 1;
        summary.counters.ingestErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`${unit.key}: ${message}`);
        log({
          event: "reparse_unit_failed",
          sourceRevisionId: unit.primary.id.toString(),
          harness: unit.harness,
          errorCode: error instanceof ReparseSafetyError ? error.code : "reparse_unit_failed",
        });
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
  summary.status = summary.counters.unitsFailed > 0 ? "completed_with_errors" : "completed";
  return summary;
}

/** Core library API for callers that already own the DB connection/sync_run. */
export async function reparseSourceRevisions(
  db: Surreal,
  archiveRoot: string,
  options: ReparseOptions,
  runtime: {
    syncRun?: RecordId;
    activeEmbeddingSpaces?: RecordId[];
    embeddingTables?: string[];
    dependencies?: Partial<ReparseDependencies>;
  } = {},
): Promise<ReparseSummary> {
  const plan = await planReparseTargets(db, options);
  return executeReparsePlan({
    db,
    archiveRoot,
    plan,
    syncRun: runtime.syncRun,
    dryRun: options.dryRun,
    enqueueEmbeddings: options.enqueueEmbeddings,
    verifyRaw: options.verifyRaw,
    activeEmbeddingSpaces: runtime.activeEmbeddingSpaces,
    embeddingTables: runtime.embeddingTables,
    logger: options.logger,
    dependencies: runtime.dependencies,
  });
}

/**
 * Command-level API: preflight + process lock + schema check + sync_run
 * lifecycle. CLI wiring can stay thin and does not need parser/writer logic.
 */
export async function runReparse(cfg: AppConfig, options: ReparseOptions): Promise<ReparseSummary> {
  validateSelection(options.selection);
  if (options.preflight !== false) await assertPreflight(cfg);
  const dryRun = options.dryRun ?? false;
  const release = await acquireLock(cfg.archiveRoot, dryRun ? "reparse --dry-run" : "reparse");
  let db: Surreal | undefined;
  let syncRun: RecordId | undefined;
  let summary: ReparseSummary | undefined;
  let primaryError: unknown;
  try {
    db = await connectDb(cfg);
    const schemaVersion = await checkSchemaVersion(db);
    const known = await listMigrations();
    const maxKnown = Math.max(0, ...known.map((migration) => migration.version));
    if (schemaVersion === 0) throw new Error("schema is not initialized: run baka db migrate");
    if (schemaVersion > maxKnown) {
      throw new Error(`unknown schema version ${schemaVersion}; code knows up to ${maxKnown}`);
    }

    if (!dryRun) {
      const identity = await localIdentity({ hostIdPath: options.hostIdPath });
      const host = await ensureHost(db, {
        hostUuid: identity.hostUuid,
        hostname: identity.hostname,
        platform: identity.platform,
        arch: identity.arch,
      });
      syncRun = await createSyncRun(db, {
        kind: "reparse",
        host,
        bakaCommit: gitHead(),
        schemaVersion,
        configurationFingerprint: JSON.stringify({
          selection: Object.keys(options.selection)[0],
          parserVersion: options.parserVersion ?? "latest",
          onlyOutdated: options.onlyOutdated ?? false,
          enqueueEmbeddings: options.enqueueEmbeddings ?? true,
          verifyRaw: options.verifyRaw ?? true,
        }),
      });
    }
    const activeSpaces = options.enqueueEmbeddings === false
      ? []
      : (await listActiveEmbeddingSpaces(db)).map((space) => space.id);
    const embeddingTables = await listEmbeddingTables(db);
    summary = await reparseSourceRevisions(db, cfg.archiveRoot, options, {
      syncRun,
      activeEmbeddingSpaces: activeSpaces,
      embeddingTables,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (db && syncRun) {
      const failed = primaryError !== undefined;
      const counters = summary?.counters ?? {};
      const errors = summary?.errors ?? [];
      await finishSyncRun(db, syncRun, {
        status: failed
          ? "failed"
          : summary?.status === "completed_with_errors"
            ? "completed_with_errors"
            : "completed",
        counters,
        errorSummary: failed
          ? (primaryError instanceof Error ? primaryError.message : String(primaryError)).slice(0, 2000)
          : errors.length > 0
            ? errors.join("; ").slice(0, 2000)
            : undefined,
      }).catch((finishError) => {
        if (!primaryError) primaryError = finishError;
      });
    }
    if (db) await db.close().catch(() => {});
    await release();
  }
  if (primaryError) throw primaryError;
  return summary!;
}
