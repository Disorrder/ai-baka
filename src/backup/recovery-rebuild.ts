/**
 * Fail-closed production rebuild from an authenticated schema-1 logical backup.
 *
 * The corrupt RocksDB tree is never opened or renamed. A fresh BAKA_DB_ROOT on
 * a POSIX filesystem is restored and verified behind the archive process lock.
 * The staging container and all large temporary files are then removed; a
 * later, separately reviewed compose change performs cutover. No source
 * discovery, sync, export, reparse or search projection rebuild is reachable.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  statfs,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.ts";
import { COMPOSE_FILE } from "../infra/compose.ts";
import { acquireLock } from "../infra/lock.ts";
import {
  parseBackupManifest,
  type BackupManifest,
} from "./backup.ts";
import { httpBaseUrl, httpHeaders } from "./http.ts";
import { streamHttpPostFile } from "./http-upload.ts";
import { pinnedSurrealImageFromCompose } from "./isolated-target.ts";
import { reorderAuthenticatedCompressedImportFile } from "./reorder-import.ts";
import {
  buildRecoveryCoreIndex,
  verifyRecoveryDatabase,
  type RecoveryDatabaseVerification,
} from "./recovery-verification.ts";
import {
  readRecoveryDirectoryIdentity,
  type RecoveryDirectoryIdentity,
} from "./recovery-promote.ts";
import {
  DEFAULT_RECOVERY_DOCKER_RUNTIME,
  RECOVERY_PINNED_IMAGE,
  inspectStoppedCorruptProduction,
  removeRecoveryTarget,
  recoveryTargetPlan,
  startRecoveryTarget,
  stopRecoveryTarget,
  type RecoveryDockerRuntime,
  type RecoveryTargetEvidence,
  type StoppedProductionEvidence,
  type StoppedRecoveryEvidence,
} from "./recovery-target.ts";
import { PINNED_RESTORE_TARGET_VERSION } from "./restore-test.ts";
import {
  assertRegularNonSymlinkFile,
  authenticateRegularFileIdentity,
  writePrivateFileAtomic,
  writePrivateFileAtomicNoClobber,
  type AuthenticatedRegularFileIdentity,
} from "./safety.ts";

const RECOVERY_FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PRODUCTION_URL = "ws://127.0.0.1:8901/rpc";
export const RECOVERY_MIN_AVAILABLE_BYTES = 64 * 1024 * 1024 * 1024;
const EXISTING_RECOVERY_DB_ROOT_ERROR =
  "recovery DB destination already exists; retry requires the coordinator to " +
  "independently prove it empty and remove only this exact failed DB root";

export interface RecoveryRebuildOptions {
  exportPath: string;
  /** Independently recorded trust anchors; never inferred from the adjacent manifest. */
  expectedExportSha256: string;
  expectedManifestSha256: string;
  dbRoot?: string;
  /**
   * Explicit opt-in for rebuilding away from the currently mounted internal
   * production tree. The source is attested read-only and is never a cleanup
   * target. When omitted, the original archive/db corruption flow is used.
   */
  currentDbRoot?: string;
  workRoot?: string;
  confirmRebuild: boolean;
  signal?: AbortSignal;
}

export interface RecoveryPaths {
  archiveRoot: string;
  corruptDbRoot: string;
  sourceMode: "archive-corrupt" | "current-internal";
  dbRoot: string;
  workRoot: string;
  temporaryRoot: string;
  journalPath: string;
  reportPath: string;
}

export interface RecoveryBackupEvidence {
  exportPath: string;
  exportBytes: number;
  exportSha256: string;
  sourceIdentity: AuthenticatedRegularFileIdentity;
  manifestPath: string;
  manifestSha256: string;
  manifest: BackupManifest;
}

export interface RecoveryStorageEvidence {
  minimumAvailableBytes: typeof RECOVERY_MIN_AVAILABLE_BYTES;
  availableBytesBefore: number;
  sameInternalDevice: true;
  supportedPosixFilesystem: true;
}

export interface RecoveryJournal {
  formatVersion: 1;
  attemptId: string;
  startedAt: string;
  updatedAt: string;
  status: "running" | "failed" | "completed";
  steps: string[];
  paths: {
    sourceMode: RecoveryPaths["sourceMode"];
    corruptDbRoot: string;
    dbRoot: string;
    workRoot: string;
  };
}

export interface RecoveryRebuildReport {
  formatVersion: 1;
  ok: true;
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  exportFile: string;
  exportBytes: number;
  exportSha256: string;
  manifestSha256: string;
  rawManifestSha256: string;
  schemaVersion: 1;
  dbRoot: string;
  corruptDbRoot: string;
  sourceMode: RecoveryPaths["sourceMode"];
  currentDbIdentity: RecoveryDirectoryIdentity;
  freshDbIdentity: RecoveryDirectoryIdentity;
  stoppedCorruptContainerId: string;
  stagingContainerRemoved: true;
  stagingAnonymousVolumes: {
    data: string;
    logs: string;
    absentAfterCleanup: true;
  };
  temporaryFilesRemoved: true;
  storage: RecoveryStorageEvidence;
  indexBuilds: readonly unknown[];
  stagedVerification: RecoveryDatabaseVerification;
  journalPath: string;
  reportPath: string;
}

export interface RecoveryRebuildDependencies {
  randomToken(): string;
  now(): Date;
  acquireArchiveLock(archiveRoot: string): Promise<() => Promise<void>>;
  authenticateBackup(
    cfg: AppConfig,
    exportPath: string,
  ): Promise<RecoveryBackupEvidence>;
  prepareAttemptPaths(
    paths: RecoveryPaths,
    backup: RecoveryBackupEvidence,
  ): Promise<RecoveryStorageEvidence>;
  createFreshTargetPaths(paths: RecoveryPaths): Promise<void>;
  pinnedImage(): Promise<string>;
  inspectStoppedProduction(corruptDbRoot: string): Promise<StoppedProductionEvidence>;
  startTarget(
    plan: ReturnType<typeof recoveryTargetPlan>,
    credentials: { username: string; password: string },
  ): Promise<RecoveryTargetEvidence>;
  stopTarget(target: RecoveryTargetEvidence): Promise<StoppedRecoveryEvidence>;
  prepareImport(
    source: string,
    destination: string,
    identity: AuthenticatedRegularFileIdentity,
  ): Promise<string[]>;
  upload(cfg: AppConfig, sourcePath: string, signal?: AbortSignal): Promise<void>;
  buildIndex(
    cfg: AppConfig,
    statements: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly unknown[]>;
  verify(cfg: AppConfig, manifest: BackupManifest): Promise<RecoveryDatabaseVerification>;
  directoryIdentity(directory: string, label: string): Promise<RecoveryDirectoryIdentity>;
  removeTarget(target: RecoveryTargetEvidence, force: boolean): Promise<void>;
  cleanupTemporaryRoot(temporaryRoot: string): Promise<void>;
  writeInitialJournal(filePath: string, journal: RecoveryJournal): Promise<void>;
  updateJournal(filePath: string, journal: RecoveryJournal): Promise<void>;
  writeReport(filePath: string, report: RecoveryRebuildReport): Promise<void>;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function exactAbsolutePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || path.normalize(trimmed) !== trimmed) {
    throw new Error(`${label} must be an exact normalized absolute path`);
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(homedir())) {
    throw new Error(`${label} must not be a filesystem root or the broad home directory`);
  }
  return resolved;
}

function archiveVolumeRoot(archiveRoot: string): string | undefined {
  const match = /^\/Volumes\/[^/]+/u.exec(path.resolve(archiveRoot));
  return match?.[0];
}

function token(value: string): string {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new Error("recovery attempt token is invalid");
  return value;
}

function expectedSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be an independently pinned lowercase SHA-256`);
  }
  return value;
}

export function resolveRecoveryDbRoot(
  cfg: AppConfig,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const selected = explicit?.trim() || env.BAKA_DB_ROOT?.trim() || cfg.dbRoot?.trim();
  if (!selected) {
    throw new Error("recovery:rebuild requires --db-root or BAKA_DB_ROOT");
  }
  const resolved = exactAbsolutePath(selected, "recovery DB destination");
  const corrupt = path.resolve(cfg.archiveRoot, "db");
  if (resolved === corrupt || isInside(corrupt, resolved) || isInside(resolved, corrupt)) {
    throw new Error("BAKA_DB_ROOT must be separate from the corrupt archive/db tree");
  }
  return resolved;
}

export function resolveRecoveryCurrentDbRoot(
  cfg: AppConfig,
  explicit: string | undefined,
): { path: string; mode: RecoveryPaths["sourceMode"] } {
  if (explicit === undefined) {
    return {
      path: path.resolve(cfg.archiveRoot, "db"),
      mode: "archive-corrupt",
    };
  }
  const currentDbRoot = exactAbsolutePath(explicit, "--current-db-root");
  const configuredDbRoot = path.resolve(cfg.dbRoot);
  if (currentDbRoot !== configuredDbRoot) {
    throw new Error("--current-db-root must exactly match effective BAKA_DB_ROOT");
  }
  const archiveRoot = path.resolve(cfg.archiveRoot);
  const archiveVolume = archiveVolumeRoot(archiveRoot);
  if (
    isInside(archiveRoot, currentDbRoot) || isInside(currentDbRoot, archiveRoot) ||
    (archiveVolume !== undefined && isInside(archiveVolume, currentDbRoot))
  ) {
    throw new Error("--current-db-root must be internal and outside BAKA_ARCHIVE_ROOT/archive volume");
  }
  return { path: currentDbRoot, mode: "current-internal" };
}

export function recoveryPaths(
  cfg: AppConfig,
  input: {
    attemptId: string;
    dbRoot: string;
    currentDbRoot?: string;
    workRoot?: string;
  },
): RecoveryPaths {
  const attemptId = token(input.attemptId);
  const archiveRoot = path.resolve(cfg.archiveRoot);
  const dbRoot = path.resolve(input.dbRoot);
  const source = resolveRecoveryCurrentDbRoot(cfg, input.currentDbRoot);
  if (isInside(source.path, dbRoot) || isInside(dbRoot, source.path)) {
    throw new Error("recovery DB destination must be fresh and separate from current DB root");
  }
  const workBase = path.resolve(
    input.workRoot ?? path.join(path.dirname(dbRoot), ".ai-baka-recovery"),
  );
  if (isInside(archiveRoot, workBase)) {
    throw new Error("recovery work root must be internal, never BAKA_ARCHIVE_ROOT/archive volume");
  }
  const workRoot = path.join(workBase, attemptId);
  if (isInside(dbRoot, workRoot) || isInside(workRoot, dbRoot)) {
    throw new Error("recovery work root and final DB root must be separate");
  }
  if (isInside(source.path, workRoot) || isInside(workRoot, source.path)) {
    throw new Error("recovery work root and current DB root must be separate");
  }
  return {
    archiveRoot,
    corruptDbRoot: source.path,
    sourceMode: source.mode,
    dbRoot,
    workRoot,
    temporaryRoot: path.join(workRoot, "temp"),
    journalPath: path.join(workRoot, "recovery-journal.json"),
    reportPath: path.join(workRoot, "recovery-report.json"),
  };
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("recovery:rebuild cancelled");
}

async function missing(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function filesystemIsPosix(type: number | bigint): boolean {
  const value = Number(type);
  if (process.platform === "darwin") return value === 0x1a; // APFS
  // ext2/3/4, XFS and Btrfs. Unknown filesystems fail closed.
  return value === 0xef53 || value === 0x58465342 || value === 0x9123683e;
}

export function recoveryAvailableBytes(input: { bavail: number; bsize: number }): number {
  const availableBytes = input.bavail * input.bsize;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < RECOVERY_MIN_AVAILABLE_BYTES) {
    throw new Error(
      `recovery internal storage requires at least ${RECOVERY_MIN_AVAILABLE_BYTES} available bytes`,
    );
  }
  return availableBytes;
}

export function assertRecoveryStorageTopology(input: {
  sourceMode: RecoveryPaths["sourceMode"];
  dbParentDevice: string;
  workBaseDevice: string;
  backupParentDevice: string;
  currentDbDevice: string;
  dbFilesystemSupported: boolean;
  workBaseFilesystemSupported: boolean;
  backupFilesystemSupported: boolean;
  currentFilesystemSupported: boolean;
}): void {
  if (
    !input.dbFilesystemSupported || !input.workBaseFilesystemSupported ||
    !input.backupFilesystemSupported ||
    (input.sourceMode === "current-internal" && !input.currentFilesystemSupported)
  ) {
    throw new Error("recovery source, DB and work roots require internal POSIX/APFS storage");
  }
  const sourceDeviceIsValid = input.sourceMode === "current-internal"
    ? input.dbParentDevice === input.currentDbDevice
    : input.dbParentDevice !== input.currentDbDevice;
  if (
    input.dbParentDevice !== input.workBaseDevice ||
    input.dbParentDevice !== input.backupParentDevice || !sourceDeviceIsValid
  ) {
    throw new Error(
      "recovery source/DB/work roots must share internal storage, separate from archive volume",
    );
  }
}

/** Validate storage and create only the small attempt directory needed by the journal. */
export async function prepareRecoveryAttemptPaths(
  paths: RecoveryPaths,
  backup: RecoveryBackupEvidence,
): Promise<RecoveryStorageEvidence> {
  const corruptInfo = await lstat(paths.corruptDbRoot);
  if (!corruptInfo.isDirectory() || corruptInfo.isSymbolicLink()) {
    throw new Error("current production DB root must be a real directory");
  }
  if (paths.sourceMode === "current-internal" &&
      await realpath(paths.corruptDbRoot) !== paths.corruptDbRoot) {
    throw new Error("current production DB root must not traverse a symlink or alias");
  }
  if (!(await missing(paths.dbRoot))) {
    throw new Error(EXISTING_RECOVERY_DB_ROOT_ERROR);
  }
  const dbParent = path.dirname(paths.dbRoot);
  const resolvedParent = await realpath(dbParent);
  if (resolvedParent !== path.resolve(dbParent)) {
    throw new Error("recovery DB parent must not traverse a symlink");
  }
  const workBase = path.dirname(paths.workRoot);
  const workBaseParent = path.dirname(workBase);
  const resolvedWorkParent = await realpath(workBaseParent);
  if (resolvedWorkParent !== path.resolve(workBaseParent)) {
    throw new Error("recovery work root parent must not traverse a symlink");
  }
  const sourceParent = path.dirname(backup.exportPath);
  const resolvedSourceParent = await realpath(sourceParent);
  if (resolvedSourceParent !== path.resolve(sourceParent) ||
      path.dirname(backup.manifestPath) !== sourceParent) {
    throw new Error("recovery backup copy must have one real internal parent directory");
  }
  if (await missing(workBase)) {
    await mkdir(workBase, { recursive: false, mode: 0o700 });
  }
  const workBaseInfo = await lstat(workBase);
  if (!workBaseInfo.isDirectory() || workBaseInfo.isSymbolicLink() ||
      await realpath(workBase) !== path.resolve(workBase)) {
    throw new Error("recovery work base must be a real internal directory");
  }
  const [
    dbFilesystem,
    workBaseFilesystem,
    sourceFilesystem,
    currentFilesystem,
    dbParentInfo,
    workBaseInfoAfter,
    sourceParentInfo,
  ] = await Promise.all([
    statfs(resolvedParent),
    statfs(workBase),
    statfs(resolvedSourceParent),
    statfs(paths.corruptDbRoot),
    lstat(resolvedParent),
    lstat(workBase),
    lstat(resolvedSourceParent),
  ]);
  if (
    !workBaseInfoAfter.isDirectory() || workBaseInfoAfter.isSymbolicLink() ||
    workBaseInfo.dev !== workBaseInfoAfter.dev || workBaseInfo.ino !== workBaseInfoAfter.ino ||
    workBaseInfo.mode !== workBaseInfoAfter.mode || await realpath(workBase) !== path.resolve(workBase)
  ) {
    throw new Error("recovery work base identity changed during storage validation");
  }
  assertRecoveryStorageTopology({
    sourceMode: paths.sourceMode,
    dbParentDevice: String(dbParentInfo.dev),
    workBaseDevice: String(workBaseInfo.dev),
    backupParentDevice: String(sourceParentInfo.dev),
    currentDbDevice: String(corruptInfo.dev),
    dbFilesystemSupported: filesystemIsPosix(dbFilesystem.type),
    workBaseFilesystemSupported: filesystemIsPosix(workBaseFilesystem.type),
    backupFilesystemSupported: filesystemIsPosix(sourceFilesystem.type),
    currentFilesystemSupported: filesystemIsPosix(currentFilesystem.type),
  });
  const availableBytes = recoveryAvailableBytes(dbFilesystem);
  await mkdir(paths.workRoot, { recursive: false, mode: 0o700 });
  return {
    minimumAvailableBytes: RECOVERY_MIN_AVAILABLE_BYTES,
    availableBytesBefore: availableBytes,
    sameInternalDevice: true,
    supportedPosixFilesystem: true,
  };
}

/** Called only after the initial journal is durable. */
export async function createFreshRecoveryTargetPaths(paths: RecoveryPaths): Promise<void> {
  const workRootInfo = await lstat(paths.workRoot);
  if (!workRootInfo.isDirectory() || workRootInfo.isSymbolicLink() ||
      await realpath(paths.workRoot) !== path.resolve(paths.workRoot)) {
    throw new Error("recovery attempt root must remain a real internal directory");
  }
  const dbParent = path.dirname(paths.dbRoot);
  if (await realpath(dbParent) !== path.resolve(dbParent)) {
    throw new Error("recovery DB parent changed after attempt validation");
  }
  if (!(await missing(paths.dbRoot))) {
    throw new Error(EXISTING_RECOVERY_DB_ROOT_ERROR);
  }
  await mkdir(paths.temporaryRoot, { recursive: false, mode: 0o700 });
  // Surreal does not create its configured temporary-directory leaf. Keep the
  // server scratch tree inside the attempt temp root so finally removes it.
  await mkdir(path.join(paths.temporaryRoot, "server"), {
    recursive: false,
    mode: 0o700,
  });
  // mkdir is the O_EXCL-equivalent for a fresh directory leaf.
  try {
    await mkdir(paths.dbRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(EXISTING_RECOVERY_DB_ROOT_ERROR, { cause: error });
    }
    throw error;
  }
}

export async function authenticateRecoveryBackup(
  cfg: AppConfig,
  exportPathInput: string,
): Promise<RecoveryBackupEvidence> {
  const exportPath = await assertRegularNonSymlinkFile(exportPathInput, "recovery export");
  if (isInside(path.resolve(cfg.archiveRoot), exportPath)) {
    throw new Error("recovery export must be an independently verified internal copy, not archive volume");
  }
  const exportBase = path.basename(exportPath).replace(/\.surql\.(?:zst|gz)$/u, "");
  if (exportBase === path.basename(exportPath)) throw new Error("recovery export suffix is invalid");
  const manifestPath = await assertRegularNonSymlinkFile(
    path.join(path.dirname(exportPath), `${exportBase}.json`),
    "recovery manifest",
  );
  const resolvedSourceParent = await realpath(path.dirname(exportPath));
  if (resolvedSourceParent !== path.dirname(exportPath) ||
      await realpath(exportPath) !== exportPath || await realpath(manifestPath) !== manifestPath) {
    throw new Error("recovery backup copy must not traverse symlinks");
  }
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.size < 1 || manifestInfo.size > MAX_MANIFEST_BYTES) {
    throw new Error("recovery manifest size is invalid");
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseBackupManifest(JSON.parse(manifestText), manifestPath);
  if (
    manifest.schemaVersion !== 1 || manifest.namespace !== cfg.surrealNamespace ||
    manifest.database !== cfg.surrealDatabase || manifest.exportFile !== path.basename(exportPath) ||
    !manifest.rawManifestSha256 ||
    /\d+\.\d+\.\d+/u.exec(manifest.surrealdbVersion)?.[0] !== PINNED_RESTORE_TARGET_VERSION
  ) {
    throw new Error("recovery manifest is not the exact authenticated schema-1 target");
  }
  const sourceIdentity = await authenticateRegularFileIdentity(
    exportPath,
    "recovery compressed export",
  );
  const manifestSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
  if (sourceIdentity.sizeBytes !== manifest.exportBytes ||
      sourceIdentity.sha256 !== manifest.exportSha256) {
    throw new Error("recovery export size or SHA-256 mismatch");
  }
  return {
    exportPath,
    exportBytes: sourceIdentity.sizeBytes,
    exportSha256: sourceIdentity.sha256,
    sourceIdentity,
    manifestPath,
    manifestSha256,
    manifest,
  };
}

async function defaultUpload(
  cfg: AppConfig,
  sourcePath: string,
  signal?: AbortSignal,
): Promise<void> {
  await streamHttpPostFile({
    url: `${httpBaseUrl(cfg)}/import`,
    headers: {
      ...httpHeaders(cfg, cfg.surrealNamespace, cfg.surrealDatabase),
      Accept: "application/json",
    },
    sourcePath,
    signal,
    operation: "production recovery import",
  });
}

const DEFAULT_DEPENDENCIES: RecoveryRebuildDependencies = {
  randomToken: () => randomBytes(16).toString("hex"),
  now: () => new Date(),
  acquireArchiveLock: (archiveRoot) => acquireLock(archiveRoot, "recovery:rebuild"),
  authenticateBackup: authenticateRecoveryBackup,
  prepareAttemptPaths: prepareRecoveryAttemptPaths,
  createFreshTargetPaths: createFreshRecoveryTargetPaths,
  pinnedImage: async () =>
    pinnedSurrealImageFromCompose(await readFile(COMPOSE_FILE, "utf8")).image,
  inspectStoppedProduction: (corruptDbRoot) => inspectStoppedCorruptProduction(corruptDbRoot),
  startTarget: (plan, credentials) => startRecoveryTarget(plan, credentials),
  stopTarget: (target) => stopRecoveryTarget(target),
  removeTarget: (target, force) => removeRecoveryTarget(target, { force }),
  cleanupTemporaryRoot: (temporaryRoot) => rm(temporaryRoot, { recursive: true, force: true }),
  prepareImport: (_source, destination, identity) =>
    reorderAuthenticatedCompressedImportFile(identity, destination, {
      requireExpectedIndexes: true,
    }),
  upload: defaultUpload,
  buildIndex: (cfg, statements, signal) =>
    buildRecoveryCoreIndex(cfg, statements, { signal }),
  verify: verifyRecoveryDatabase,
  directoryIdentity: readRecoveryDirectoryIdentity,
  writeInitialJournal: (filePath, journal) =>
    writePrivateFileAtomicNoClobber(filePath, `${JSON.stringify(journal, null, 2)}\n`),
  updateJournal: (filePath, journal) =>
    writePrivateFileAtomic(filePath, `${JSON.stringify(journal, null, 2)}\n`, { overwrite: true }),
  writeReport: (filePath, report) =>
    writePrivateFileAtomicNoClobber(filePath, `${JSON.stringify(report, null, 2)}\n`),
};

function journalAt(
  attemptId: string,
  startedAt: string,
  paths: RecoveryPaths,
): RecoveryJournal {
  return {
    formatVersion: RECOVERY_FORMAT_VERSION,
    attemptId,
    startedAt,
    updatedAt: startedAt,
    status: "running",
    steps: ["lock_acquired"],
    paths: {
      sourceMode: paths.sourceMode,
      corruptDbRoot: paths.corruptDbRoot,
      dbRoot: paths.dbRoot,
      workRoot: paths.workRoot,
    },
  };
}

/** Full authenticated rebuild; physical cutover is deliberately out of scope. */
export async function runRecoveryRebuild(
  cfg: AppConfig,
  options: RecoveryRebuildOptions,
  dependencyOverrides: Partial<RecoveryRebuildDependencies> = {},
): Promise<RecoveryRebuildReport> {
  if (!options.confirmRebuild) {
    throw new Error("recovery:rebuild requires --confirm-rebuild");
  }
  if (cfg.surrealUrl !== PRODUCTION_URL || cfg.surrealNamespace !== "baka" ||
      cfg.surrealDatabase !== "archive") {
    throw new Error("recovery:rebuild requires exact production endpoint baka/archive");
  }
  const expectedExportHash = expectedSha256(
    options.expectedExportSha256,
    "--export-sha256",
  );
  const expectedManifestHash = expectedSha256(
    options.expectedManifestSha256,
    "--manifest-sha256",
  );
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const attemptId = token(dependencies.randomToken());
  const startedAt = dependencies.now().toISOString();
  if (options.currentDbRoot !== undefined && options.dbRoot === undefined) {
    throw new Error("--current-db-root mode requires an explicit fresh --db-root destination");
  }
  const dbRoot = resolveRecoveryDbRoot(cfg, options.dbRoot);
  const paths = recoveryPaths(cfg, {
    attemptId,
    dbRoot,
    currentDbRoot: options.currentDbRoot,
    workRoot: options.workRoot,
  });
  // The tiny standard O_EXCL lock is the sole archive volume write: every baka writer
  // knows this exact path, so replacing it with a check plus another lock races.
  const release = await dependencies.acquireArchiveLock(paths.archiveRoot);
  let journal = journalAt(attemptId, startedAt, paths);
  let journalCreated = false;
  let target: RecoveryTargetEvidence | undefined;
  let stoppedTarget: StoppedRecoveryEvidence | undefined;

  const record = async (step: string, status = journal.status): Promise<void> => {
    journal = {
      ...journal,
      status,
      updatedAt: dependencies.now().toISOString(),
      steps: [...journal.steps, step],
    };
    if (journalCreated) await dependencies.updateJournal(paths.journalPath, journal);
  };

  try {
    let backup: RecoveryBackupEvidence | undefined;
    let production: StoppedProductionEvidence | undefined;
    let storage: RecoveryStorageEvidence | undefined;
    let indexBuilds: readonly unknown[] | undefined;
    let stagedVerification: RecoveryDatabaseVerification | undefined;
    let workflowError: unknown;
    try {
      throwIfCancelled(options.signal);
      backup = await dependencies.authenticateBackup(cfg, options.exportPath);
      if (backup.exportSha256 !== expectedExportHash ||
          backup.manifestSha256 !== expectedManifestHash) {
        throw new Error("recovery backup does not match independently pinned SHA-256 values");
      }
      if (
        backup.sourceIdentity.resolvedPath !== backup.exportPath ||
        backup.sourceIdentity.sha256 !== backup.exportSha256 ||
        backup.sourceIdentity.sizeBytes !== backup.exportBytes
      ) {
        throw new Error("recovery compressed source identity evidence is inconsistent");
      }
      throwIfCancelled(options.signal);
      if (await dependencies.pinnedImage() !== RECOVERY_PINNED_IMAGE) {
        throw new Error("project compose no longer matches the recovery pinned image");
      }
      production = await dependencies.inspectStoppedProduction(paths.corruptDbRoot);
      storage = await dependencies.prepareAttemptPaths(paths, backup);
      await dependencies.writeInitialJournal(paths.journalPath, journal);
      journalCreated = true;
      await record("authenticated_backup");
      await record("stopped_production_attested");
      await dependencies.createFreshTargetPaths(paths);
      await record("fresh_target_paths_created");

      const plan = recoveryTargetPlan({
        token: attemptId,
        dbRoot: paths.dbRoot,
        temporaryRoot: paths.temporaryRoot,
      });
      target = await dependencies.startTarget(plan, {
        username: cfg.surrealUser,
        password: cfg.surrealPass,
      });
      await record("staging_target_healthy");
      throwIfCancelled(options.signal);

      const importPath = path.join(paths.temporaryRoot, "recovery-import.surql");
      const statements = await dependencies.prepareImport(
        backup.exportPath,
        importPath,
        backup.sourceIdentity,
      );
      if (statements.length !== 1 || !/search_document_content/iu.test(statements[0] ?? "") ||
          /chunk_content/iu.test(statements[0] ?? "")) {
        throw new Error("recovery deferred FULLTEXT set is not core-only");
      }
      await record("streamed_import_prepared");
      throwIfCancelled(options.signal);
      await dependencies.upload(cfg, importPath, options.signal);
      await record("authenticated_import_complete");
      indexBuilds = await dependencies.buildIndex(cfg, statements, options.signal);
      if (indexBuilds.length !== 1 ||
          (indexBuilds[0] as { name?: unknown }).name !== "search_document_content" ||
          (indexBuilds[0] as { state?: unknown }).state !== "ready") {
        throw new Error("recovery core FULLTEXT did not reach ready");
      }
      await record("core_fulltext_ready");
      stagedVerification = await dependencies.verify(cfg, backup.manifest);
      await record("staged_verification_complete");
    } catch (error) {
      workflowError = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (target) {
        if (!stoppedTarget) {
          try {
            stoppedTarget = await dependencies.stopTarget(target);
            await record("staging_target_stopped_cleanly");
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          await dependencies.removeTarget(stoppedTarget ?? target, stoppedTarget === undefined);
          await record("staging_container_removed");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await dependencies.cleanupTemporaryRoot(paths.temporaryRoot);
        await record("large_temporary_files_removed");
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        const cleanupError = new AggregateError(
          cleanupErrors,
          "recovery staging cleanup was incomplete",
        );
        workflowError = workflowError === undefined
          ? cleanupError
          : new AggregateError([workflowError, cleanupError], "recovery and cleanup failed");
      }
    }

    if (workflowError !== undefined) throw workflowError;
    if (!backup || !production || !storage || !indexBuilds || !stagedVerification || !target) {
      throw new Error("recovery completed without required evidence");
    }
    const finishedAt = dependencies.now().toISOString();
    await record("recovery_completed", "completed");
    // Capture the exact retained source and verified fresh tree only after the
    // staging container and temp payload are gone. Nothing asynchronous occurs
    // between this identity snapshot and publication of the pinned report.
    const [currentDbIdentity, freshDbIdentity] = await Promise.all([
      dependencies.directoryIdentity(paths.corruptDbRoot, "retained current DB root"),
      dependencies.directoryIdentity(paths.dbRoot, "verified fresh DB root"),
    ]);
    const report: RecoveryRebuildReport = {
      formatVersion: RECOVERY_FORMAT_VERSION,
      ok: true,
      attemptId,
      startedAt,
      finishedAt,
      exportFile: path.basename(backup.exportPath),
      exportBytes: backup.exportBytes,
      exportSha256: backup.exportSha256,
      manifestSha256: backup.manifestSha256,
      rawManifestSha256: backup.manifest.rawManifestSha256!,
      schemaVersion: 1,
      dbRoot: paths.dbRoot,
      corruptDbRoot: paths.corruptDbRoot,
      sourceMode: paths.sourceMode,
      currentDbIdentity,
      freshDbIdentity,
      stoppedCorruptContainerId: production.id,
      stagingContainerRemoved: true,
      stagingAnonymousVolumes: {
        ...target.anonymousVolumes,
        absentAfterCleanup: true,
      },
      temporaryFilesRemoved: true,
      storage,
      indexBuilds,
      stagedVerification,
      journalPath: paths.journalPath,
      reportPath: paths.reportPath,
    };
    await dependencies.writeReport(paths.reportPath, report);
    return report;
  } catch (error) {
    await record("recovery_failed", "failed").catch(() => {});
    throw error;
  } finally {
    await release();
  }
}

// Exported only for deterministic unit tests of the default Docker boundary.
export const RECOVERY_DEFAULT_DOCKER_RUNTIME: RecoveryDockerRuntime =
  DEFAULT_RECOVERY_DOCKER_RUNTIME;
