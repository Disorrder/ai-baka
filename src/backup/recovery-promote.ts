/**
 * Atomic, no-delete promotion of a verified recovery tree into the configured
 * production path. This command never opens a database or starts a container.
 */

import { rename, lstat, realpath, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import type { AppConfig } from "../config.ts";
import { acquireLock } from "../infra/lock.ts";
import {
  assertOpenAuthenticatedRegularFileUnchanged,
  authenticateRegularFileIdentity,
  openAuthenticatedRegularFile,
  type AuthenticatedRegularFileIdentity,
} from "./safety.ts";
import {
  inspectStoppedCorruptProduction,
  type StoppedProductionEvidence,
} from "./recovery-target.ts";

const PROMOTION_FORMAT_VERSION = 1;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

export interface RecoveryPromotionOptions {
  reportPath: string;
  expectedReportSha256: string;
  currentDbRoot: string;
  freshDbRoot: string;
  quarantineDbRoot: string;
  stoppedContainerId: string;
  confirmPromote: boolean;
}

export interface RecoveryDirectoryIdentity {
  path: string;
  device: string;
  inode: string;
  mode: string;
  nonSymlinkDirectory: true;
}

export interface RecoveryPromotionStorageEvidence {
  current: RecoveryDirectoryIdentity;
  fresh: RecoveryDirectoryIdentity;
  quarantineParent: RecoveryDirectoryIdentity;
  sameDevice: true;
  supportedPosixFilesystem: true;
  quarantineAbsent: true;
}

export interface AuthenticatedRecoveryPromotionInput {
  identity: AuthenticatedRegularFileIdentity;
  report: Record<string, unknown>;
}

export interface RecoveryPromotionReport {
  formatVersion: 1;
  ok: true;
  promotedAt: string;
  recoveryAttemptId: string;
  recoveryReportPath: string;
  recoveryReportSha256: string;
  exportSha256: string;
  manifestSha256: string;
  rawManifestSha256: string;
  schemaVersion: 1;
  stoppedContainerId: string;
  productionStarted: false;
  databaseOpened: false;
  currentDbRoot: string;
  quarantineDbRoot: string;
  promotedIdentity: RecoveryDirectoryIdentity;
  retainedPreviousIdentity: RecoveryDirectoryIdentity;
  freshPathAbsent: true;
}

export interface RecoveryPromotionDependencies {
  now(): Date;
  acquireArchiveLock(archiveRoot: string): Promise<() => Promise<void>>;
  authenticateReport(reportPath: string): Promise<AuthenticatedRecoveryPromotionInput>;
  inspectStoppedProduction(currentDbRoot: string): Promise<StoppedProductionEvidence>;
  inspectStorage(paths: RecoveryPromotionPaths): Promise<RecoveryPromotionStorageEvidence>;
  directoryIdentity(directory: string, label: string): Promise<RecoveryDirectoryIdentity>;
  pathAbsent(target: string): Promise<boolean>;
  rename(source: string, destination: string): Promise<void>;
}

export interface RecoveryPromotionPaths {
  currentDbRoot: string;
  freshDbRoot: string;
  quarantineDbRoot: string;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function exactAbsolutePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || path.normalize(trimmed) !== trimmed) {
    throw new Error(`${label} must be an exact normalized absolute path`);
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(homedir())) {
    throw new Error(`${label} must not be a filesystem root or broad home directory`);
  }
  return resolved;
}

function archiveVolumeRoot(archiveRoot: string): string | undefined {
  return /^\/Volumes\/[^/]+/u.exec(path.resolve(archiveRoot))?.[0];
}

function assertOutsideArchive(archiveRoot: string, candidate: string, label: string): void {
  const volume = archiveVolumeRoot(archiveRoot);
  if (
    isInside(archiveRoot, candidate) || isInside(candidate, archiveRoot) ||
    (volume !== undefined && isInside(volume, candidate))
  ) {
    throw new Error(`${label} must be internal and outside BAKA_ARCHIVE_ROOT/archive volume`);
  }
}

export function recoveryPromotionPaths(
  cfg: AppConfig,
  options: Pick<
    RecoveryPromotionOptions,
    "currentDbRoot" | "freshDbRoot" | "quarantineDbRoot"
  >,
): RecoveryPromotionPaths {
  const currentDbRoot = exactAbsolutePath(options.currentDbRoot, "--current-db-root");
  const freshDbRoot = exactAbsolutePath(options.freshDbRoot, "--fresh-db-root");
  const quarantineDbRoot = exactAbsolutePath(
    options.quarantineDbRoot,
    "--quarantine-db-root",
  );
  if (currentDbRoot !== path.resolve(cfg.dbRoot)) {
    throw new Error("--current-db-root must exactly match effective BAKA_DB_ROOT");
  }
  for (const [label, candidate] of [
    ["--current-db-root", currentDbRoot],
    ["--fresh-db-root", freshDbRoot],
    ["--quarantine-db-root", quarantineDbRoot],
  ] as const) {
    assertOutsideArchive(path.resolve(cfg.archiveRoot), candidate, label);
  }
  const paths = [currentDbRoot, freshDbRoot, quarantineDbRoot];
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (isInside(paths[left]!, paths[right]!) || isInside(paths[right]!, paths[left]!)) {
        throw new Error("recovery promotion paths must be distinct non-ancestor directories");
      }
    }
  }
  return { currentDbRoot, freshDbRoot, quarantineDbRoot };
}

function expectedSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be an independently pinned lowercase SHA-256`);
  }
  return value;
}

function expectedContainerId(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("--stopped-container-id must be an exact 64-lowercase-hex Docker ID");
  }
  return value;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`recovery report ${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function exactHashField(report: Record<string, unknown>, field: string): string {
  const value = report[field];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`recovery report ${field} is not a pinned SHA-256`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`recovery report ${label} is invalid`);
  }
  return value as number;
}

function validateRecoverySuccessReport(
  report: Record<string, unknown>,
  reportPath: string,
  paths: RecoveryPromotionPaths,
  containerId: string,
): {
  attemptId: string;
  exportSha256: string;
  manifestSha256: string;
  rawManifestSha256: string;
  currentDbIdentity: RecoveryDirectoryIdentity;
  freshDbIdentity: RecoveryDirectoryIdentity;
} {
  if (
    report.formatVersion !== 1 || report.ok !== true || report.schemaVersion !== 1 ||
    report.sourceMode !== "current-internal" || report.dbRoot !== paths.freshDbRoot ||
    report.corruptDbRoot !== paths.currentDbRoot || report.reportPath !== reportPath ||
    report.stoppedCorruptContainerId !== containerId ||
    report.stagingContainerRemoved !== true || report.temporaryFilesRemoved !== true
  ) {
    throw new Error("recovery report is not the exact successful internal-current rebuild");
  }
  const attemptId = report.attemptId;
  if (typeof attemptId !== "string" || !/^[0-9a-f]{32}$/u.test(attemptId)) {
    throw new Error("recovery report attempt identity is invalid");
  }
  const expectedJournalPath = path.join(path.dirname(reportPath), "recovery-journal.json");
  if (
    path.basename(reportPath) !== "recovery-report.json" ||
    path.basename(path.dirname(reportPath)) !== attemptId ||
    report.journalPath !== expectedJournalPath
  ) {
    throw new Error("recovery report durable path identity is invalid");
  }
  if (typeof report.exportFile !== "string" || !/\.surql\.(?:zst|gz)$/u.test(report.exportFile)) {
    throw new Error("recovery report export identity is invalid");
  }
  positiveSafeInteger(report.exportBytes, "exportBytes");
  const storage = requiredObject(report.storage, "storage evidence");
  if (
    storage.sameInternalDevice !== true || storage.supportedPosixFilesystem !== true ||
    !Number.isSafeInteger(storage.minimumAvailableBytes) ||
    !Number.isSafeInteger(storage.availableBytesBefore)
  ) {
    throw new Error("recovery report storage evidence is incomplete");
  }
  const anonymous = requiredObject(report.stagingAnonymousVolumes, "cleanup evidence");
  if (
    anonymous.absentAfterCleanup !== true ||
    typeof anonymous.data !== "string" || !/^[0-9a-f]{64}$/u.test(anonymous.data) ||
    typeof anonymous.logs !== "string" || !/^[0-9a-f]{64}$/u.test(anonymous.logs) ||
    anonymous.data === anonymous.logs
  ) {
    throw new Error("recovery report staging cleanup evidence is incomplete");
  }
  if (!Array.isArray(report.indexBuilds) || report.indexBuilds.length !== 1) {
    throw new Error("recovery report index evidence is incomplete");
  }
  const index = requiredObject(report.indexBuilds[0], "index evidence");
  if (index.name !== "search_document_content" || index.state !== "ready") {
    throw new Error("recovery report core index was not verified ready");
  }
  const verification = requiredObject(report.stagedVerification, "staged verification");
  const recordCounts = requiredObject(verification.recordCounts, "record counts");
  if (
    verification.ok !== true || verification.schemaVersion !== 1 ||
    verification.rawManifestSha256 !== report.rawManifestSha256 ||
    Object.keys(recordCounts).length < 1 ||
    Object.values(recordCounts).some((count) =>
      !Number.isSafeInteger(count) || (count as number) < 0
    )
  ) {
    throw new Error("recovery report staged verification is incomplete");
  }
  const fulltext = requiredObject(verification.fulltext, "FULLTEXT verification");
  if (
    fulltext.name !== "search_document_content" || fulltext.table !== "search_document" ||
    fulltext.ready !== true || fulltext.chunkContentAbsent !== true
  ) {
    throw new Error("recovery report FULLTEXT topology was not verified");
  }
  const ownership = requiredObject(
    verification.searchSourceChunkOwnership,
    "search source-chunk verification",
  );
  if (ownership.valid !== true) {
    throw new Error("recovery report source-chunk ownership was not verified");
  }
  if (!Array.isArray(verification.searchProbes)) {
    throw new Error("recovery report BM25 evidence is incomplete");
  }
  const probeNames = new Set(
    verification.searchProbes
      .filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
      .filter((item) => item.ok === true)
      .map((item) => item.name),
  );
  if (!probeNames.has("search: probe_1") || !probeNames.has("search: probe_2") ||
      !probeNames.has("search probes")) {
    throw new Error("recovery report BM25 evidence is incomplete");
  }
  const reportDirectoryIdentity = (
    value: unknown,
    expectedPath: string,
    label: string,
  ): RecoveryDirectoryIdentity => {
    const identity = requiredObject(value, `${label} identity`);
    if (
      identity.path !== expectedPath || typeof identity.device !== "string" ||
      !/^\d+$/u.test(identity.device) || typeof identity.inode !== "string" ||
      !/^\d+$/u.test(identity.inode) || typeof identity.mode !== "string" ||
      !/^\d+$/u.test(identity.mode) || identity.nonSymlinkDirectory !== true
    ) {
      throw new Error(`recovery report ${label} directory identity is invalid`);
    }
    return {
      path: expectedPath,
      device: identity.device,
      inode: identity.inode,
      mode: identity.mode,
      nonSymlinkDirectory: true,
    };
  };
  return {
    attemptId,
    exportSha256: exactHashField(report, "exportSha256"),
    manifestSha256: exactHashField(report, "manifestSha256"),
    rawManifestSha256: exactHashField(report, "rawManifestSha256"),
    currentDbIdentity: reportDirectoryIdentity(
      report.currentDbIdentity,
      paths.currentDbRoot,
      "current DB",
    ),
    freshDbIdentity: reportDirectoryIdentity(
      report.freshDbIdentity,
      paths.freshDbRoot,
      "fresh DB",
    ),
  };
}

function filesystemIsPosix(type: number | bigint): boolean {
  const value = Number(type);
  if (process.platform === "darwin") return value === 0x1a;
  return value === 0xef53 || value === 0x58465342 || value === 0x9123683e;
}

function identityFromStat(directory: string, info: BigIntStats): RecoveryDirectoryIdentity {
  return {
    path: directory,
    device: String(info.dev),
    inode: String(info.ino),
    mode: String(info.mode),
    nonSymlinkDirectory: true,
  };
}

export async function readRecoveryDirectoryIdentity(
  directoryInput: string,
  label: string,
): Promise<RecoveryDirectoryIdentity> {
  const directory = path.resolve(directoryInput);
  const before = await lstat(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error(`${label} must be a real non-symlink directory`);
  }
  const after = await lstat(directory, { bigint: true });
  if (
    !after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev ||
    before.ino !== after.ino || before.mode !== after.mode
  ) {
    throw new Error(`${label} identity changed during inspection`);
  }
  return identityFromStat(directory, after);
}

async function pathAbsent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function inspectRecoveryPromotionStorage(
  paths: RecoveryPromotionPaths,
): Promise<RecoveryPromotionStorageEvidence> {
  const quarantineParent = path.dirname(paths.quarantineDbRoot);
  const [current, fresh, parent, currentFs, freshFs, parentFs, absent] = await Promise.all([
    readRecoveryDirectoryIdentity(paths.currentDbRoot, "current DB root"),
    readRecoveryDirectoryIdentity(paths.freshDbRoot, "fresh DB root"),
    readRecoveryDirectoryIdentity(quarantineParent, "quarantine parent"),
    statfs(paths.currentDbRoot),
    statfs(paths.freshDbRoot),
    statfs(quarantineParent),
    pathAbsent(paths.quarantineDbRoot),
  ]);
  if (!absent) throw new Error("quarantine DB root must not exist");
  if (
    !filesystemIsPosix(currentFs.type) || !filesystemIsPosix(freshFs.type) ||
    !filesystemIsPosix(parentFs.type)
  ) {
    throw new Error("recovery promotion requires APFS/local POSIX storage");
  }
  if (current.device !== fresh.device || current.device !== parent.device) {
    throw new Error("current, fresh and quarantine parent must be on the same device");
  }
  return {
    current,
    fresh,
    quarantineParent: parent,
    sameDevice: true,
    supportedPosixFilesystem: true,
    quarantineAbsent: true,
  };
}

function sameInode(left: RecoveryDirectoryIdentity, right: RecoveryDirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

function sameExactDirectoryIdentity(
  left: RecoveryDirectoryIdentity,
  right: RecoveryDirectoryIdentity,
): boolean {
  return left.path === right.path && sameInode(left, right);
}

function sameStorageIdentity(
  left: RecoveryPromotionStorageEvidence,
  right: RecoveryPromotionStorageEvidence,
): boolean {
  return sameInode(left.current, right.current) && sameInode(left.fresh, right.fresh) &&
    sameInode(left.quarantineParent, right.quarantineParent);
}

function validateStorageEvidence(
  storage: RecoveryPromotionStorageEvidence,
  paths: RecoveryPromotionPaths,
): void {
  if (
    storage.sameDevice !== true || storage.supportedPosixFilesystem !== true ||
    storage.quarantineAbsent !== true || storage.current.path !== paths.currentDbRoot ||
    storage.fresh.path !== paths.freshDbRoot ||
    storage.quarantineParent.path !== path.dirname(paths.quarantineDbRoot) ||
    storage.current.nonSymlinkDirectory !== true ||
    storage.fresh.nonSymlinkDirectory !== true ||
    storage.quarantineParent.nonSymlinkDirectory !== true ||
    storage.current.device !== storage.fresh.device ||
    storage.current.device !== storage.quarantineParent.device ||
    !/^\d+$/u.test(storage.current.inode) || !/^\d+$/u.test(storage.fresh.inode) ||
    !/^\d+$/u.test(storage.quarantineParent.inode)
  ) {
    throw new Error("recovery promotion storage evidence is inconsistent");
  }
}

export async function authenticateRecoveryPromotionReport(
  reportPathInput: string,
): Promise<AuthenticatedRecoveryPromotionInput> {
  const identity = await authenticateRegularFileIdentity(
    reportPathInput,
    "recovery promotion report",
  );
  if (identity.sizeBytes > MAX_REPORT_BYTES) {
    throw new Error("recovery promotion report exceeds its size bound");
  }
  const opened = await openAuthenticatedRegularFile(identity, "recovery promotion report");
  try {
    const text = await opened.descriptor.readFile({ encoding: "utf8" });
    await assertOpenAuthenticatedRegularFileUnchanged(opened, "recovery promotion report");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("recovery promotion report is malformed JSON");
    }
    return { identity, report: requiredObject(parsed, "document") };
  } finally {
    await opened.descriptor.close();
  }
}

const DEFAULT_DEPENDENCIES: RecoveryPromotionDependencies = {
  now: () => new Date(),
  acquireArchiveLock: (archiveRoot) => acquireLock(archiveRoot, "recovery:promote"),
  authenticateReport: authenticateRecoveryPromotionReport,
  inspectStoppedProduction: (currentDbRoot) =>
    inspectStoppedCorruptProduction(currentDbRoot),
  inspectStorage: inspectRecoveryPromotionStorage,
  directoryIdentity: readRecoveryDirectoryIdentity,
  pathAbsent,
  rename,
};

export async function runRecoveryPromotion(
  cfg: AppConfig,
  options: RecoveryPromotionOptions,
  dependencyOverrides: Partial<RecoveryPromotionDependencies> = {},
): Promise<RecoveryPromotionReport> {
  if (!options.confirmPromote) {
    throw new Error("recovery:promote requires --confirm-promote");
  }
  const expectedReportHash = expectedSha256(options.expectedReportSha256, "--report-sha256");
  const containerId = expectedContainerId(options.stoppedContainerId);
  const reportPath = exactAbsolutePath(options.reportPath, "recovery report path");
  const paths = recoveryPromotionPaths(cfg, options);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const release = await dependencies.acquireArchiveLock(path.resolve(cfg.archiveRoot));
  try {
    const authenticated = await dependencies.authenticateReport(reportPath);
    if (
      authenticated.identity.resolvedPath !== reportPath ||
      authenticated.identity.sha256 !== expectedReportHash
    ) {
      throw new Error("recovery report does not match its exact path and pinned SHA-256");
    }
    const reportEvidence = validateRecoverySuccessReport(
      authenticated.report,
      reportPath,
      paths,
      containerId,
    );
    const production = await dependencies.inspectStoppedProduction(paths.currentDbRoot);
    if (production.id !== containerId || production.corruptDbRoot !== paths.currentDbRoot) {
      throw new Error("stopped production identity does not match promotion authorization");
    }
    const storage = await dependencies.inspectStorage(paths);
    validateStorageEvidence(storage, paths);
    if (
      !sameExactDirectoryIdentity(storage.current, reportEvidence.currentDbIdentity) ||
      !sameExactDirectoryIdentity(storage.fresh, reportEvidence.freshDbIdentity)
    ) {
      throw new Error("current or fresh DB tree no longer matches pinned recovery report identity");
    }
    const revalidated = await dependencies.inspectStorage(paths);
    validateStorageEvidence(revalidated, paths);
    if (!sameStorageIdentity(storage, revalidated)) {
      throw new Error("recovery promotion directory identities changed before rename");
    }

    await dependencies.rename(paths.currentDbRoot, paths.quarantineDbRoot);
    try {
      await dependencies.rename(paths.freshDbRoot, paths.currentDbRoot);
    } catch (promotionError) {
      let rollbackError: unknown;
      try {
        await dependencies.rename(paths.quarantineDbRoot, paths.currentDbRoot);
        const [restoredCurrent, unchangedFresh, quarantineAbsent] = await Promise.all([
          dependencies.directoryIdentity(paths.currentDbRoot, "rolled-back current DB root"),
          dependencies.directoryIdentity(paths.freshDbRoot, "unchanged fresh DB root"),
          dependencies.pathAbsent(paths.quarantineDbRoot),
        ]);
        if (
          !sameInode(restoredCurrent, storage.current) ||
          !sameInode(unchangedFresh, storage.fresh) || !quarantineAbsent
        ) {
          throw new Error("recovery promotion rollback identity verification failed");
        }
      } catch (error) {
        rollbackError = error;
      }
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [promotionError, rollbackError],
          "recovery promotion failed and rollback was incomplete",
        );
      }
      throw new Error("recovery promotion second rename failed; first rename was rolled back", {
        cause: promotionError,
      });
    }

    try {
      const [promoted, retained, freshAbsent, productionAfter, reportAfter] = await Promise.all([
        dependencies.directoryIdentity(paths.currentDbRoot, "promoted current DB root"),
        dependencies.directoryIdentity(paths.quarantineDbRoot, "retained previous DB root"),
        dependencies.pathAbsent(paths.freshDbRoot),
        dependencies.inspectStoppedProduction(paths.currentDbRoot),
        dependencies.authenticateReport(reportPath),
      ]);
      if (
        !sameInode(promoted, storage.fresh) || !sameInode(retained, storage.current) ||
        !freshAbsent || productionAfter.id !== containerId ||
        productionAfter.corruptDbRoot !== paths.currentDbRoot ||
        reportAfter.identity.resolvedPath !== authenticated.identity.resolvedPath ||
        reportAfter.identity.device !== authenticated.identity.device ||
        reportAfter.identity.inode !== authenticated.identity.inode ||
        reportAfter.identity.sizeBytes !== authenticated.identity.sizeBytes ||
        reportAfter.identity.mode !== authenticated.identity.mode ||
        reportAfter.identity.sha256 !== authenticated.identity.sha256
      ) {
        throw new Error("recovery promotion post-rename identity verification failed");
      }
      return {
        formatVersion: PROMOTION_FORMAT_VERSION,
        ok: true,
        promotedAt: dependencies.now().toISOString(),
        recoveryAttemptId: reportEvidence.attemptId,
        recoveryReportPath: reportPath,
        recoveryReportSha256: expectedReportHash,
        exportSha256: reportEvidence.exportSha256,
        manifestSha256: reportEvidence.manifestSha256,
        rawManifestSha256: reportEvidence.rawManifestSha256,
        schemaVersion: 1,
        stoppedContainerId: containerId,
        productionStarted: false,
        databaseOpened: false,
        currentDbRoot: paths.currentDbRoot,
        quarantineDbRoot: paths.quarantineDbRoot,
        promotedIdentity: promoted,
        retainedPreviousIdentity: retained,
        freshPathAbsent: true,
      };
    } catch (verificationError) {
      let rollbackError: unknown;
      try {
        await dependencies.rename(paths.currentDbRoot, paths.freshDbRoot);
        try {
          await dependencies.rename(paths.quarantineDbRoot, paths.currentDbRoot);
        } catch (restoreError) {
          // Keep a valid production path if restoring the previous tree fails.
          // The verified fresh tree is moved back into place before surfacing
          // the incomplete rollback.
          try {
            await dependencies.rename(paths.freshDbRoot, paths.currentDbRoot);
          } catch (reinstateError) {
            throw new AggregateError(
              [restoreError, reinstateError],
              "post-rename rollback could not restore either production tree",
            );
          }
          throw restoreError;
        }
        const [restoredCurrent, restoredFresh, quarantineAbsent] = await Promise.all([
          dependencies.directoryIdentity(paths.currentDbRoot, "rolled-back current DB root"),
          dependencies.directoryIdentity(paths.freshDbRoot, "rolled-back fresh DB root"),
          dependencies.pathAbsent(paths.quarantineDbRoot),
        ]);
        if (
          !sameInode(restoredCurrent, storage.current) ||
          !sameInode(restoredFresh, storage.fresh) || !quarantineAbsent
        ) {
          throw new Error("recovery promotion post-rename rollback identity verification failed");
        }
      } catch (error) {
        rollbackError = error;
      }
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [verificationError, rollbackError],
          "recovery promotion post-rename verification failed and rollback was incomplete",
        );
      }
      throw new Error("recovery promotion post-rename verification failed; promotion was rolled back", {
        cause: verificationError,
      });
    }
  } finally {
    await release();
  }
}
