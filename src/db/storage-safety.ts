/**
 * Fail-closed storage checks for the mutable production RocksDB tree.
 *
 * This module is deliberately read-only: it resolves existing path evidence,
 * queries filesystem metadata and (on macOS) asks diskutil for device facts.
 * It never creates a directory or changes a mount/container.
 */

import { execFile } from "node:child_process";
import { lstat, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const READ_ONLY_COMMAND_TIMEOUT_MS = 10_000;
const READ_ONLY_COMMAND_MAX_BUFFER = 256 * 1024;

const LINUX_LOCAL_POSIX_FILESYSTEMS = new Map<bigint, string>([
  [0xef53n, "ext2/3/4"],
  [0x58465342n, "xfs"],
  [0x9123683en, "btrfs"],
]);

export type DbStorageSafetyErrorCode =
  | "archive_db_overlap"
  | "path_evidence_unavailable"
  | "path_is_symlink"
  | "path_is_not_directory"
  | "path_is_not_real"
  | "path_changed"
  | "unsupported_platform"
  | "unsupported_filesystem"
  | "diskutil_evidence_unavailable"
  | "diskutil_not_internal"
  | "diskutil_not_apfs"
  | "recovery_db_root_mismatch";

export class DbStorageSafetyError extends Error {
  constructor(
    readonly code: DbStorageSafetyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DbStorageSafetyError";
  }
}

export interface DbStorageConfig {
  archiveRoot: string;
  dbRoot: string;
}

export interface MacDiskutilEvidence {
  internal: boolean;
  filesystemType: string;
}

export interface DbStorageSafetyEvidence {
  dbRoot: string;
  archiveDbRoot: string;
  checkedPath: string;
  platform: "darwin" | "linux";
  filesystem: string;
}

export interface DbStorageSafetyDependencies {
  platform: NodeJS.Platform;
  lstat: typeof lstat;
  realpath: typeof realpath;
  statfs: typeof statfs;
  macDiskutilInfo(targetPath: string): Promise<string>;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Pure lexical guard; no realpath call can silently redefine either root. */
export function assertDbRootLexicallySeparate(
  archiveRoot: string,
  dbRoot: string,
): { archiveDbRoot: string; dbRoot: string } {
  const archiveDbRoot = path.resolve(archiveRoot, "db");
  const effectiveDbRoot = path.resolve(dbRoot);
  if (
    isInside(archiveDbRoot, effectiveDbRoot) ||
    isInside(effectiveDbRoot, archiveDbRoot)
  ) {
    throw new DbStorageSafetyError(
      "archive_db_overlap",
      "BAKA_DB_ROOT должен быть лексически отдельным от BAKA_ARCHIVE_ROOT/db",
    );
  }
  return { archiveDbRoot, dbRoot: effectiveDbRoot };
}

/**
 * Recovery cannot introduce a second effective production root. An explicit
 * CLI value is accepted only when its normalized path equals cfg.dbRoot.
 */
export function configuredRecoveryDbRoot(
  configuredDbRoot: string,
  explicitDbRoot: string | undefined,
): string {
  const effective = path.resolve(configuredDbRoot);
  if (explicitDbRoot !== undefined) {
    const value = explicitDbRoot.trim();
    if (value.length === 0 || path.resolve(value) !== effective) {
      throw new DbStorageSafetyError(
        "recovery_db_root_mismatch",
        "recovery --db-root должен совпадать с effective BAKA_DB_ROOT",
      );
    }
  }
  return effective;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function nearestRealDirectory(
  dbRoot: string,
  dependencies: Pick<DbStorageSafetyDependencies, "lstat" | "realpath">,
): Promise<string> {
  let candidate = dbRoot;
  for (;;) {
    try {
      const before = await dependencies.lstat(candidate);
      if (before.isSymbolicLink()) {
        throw new DbStorageSafetyError(
          "path_is_symlink",
          "BAKA_DB_ROOT или его ближайший существующий родитель является symlink",
        );
      }
      if (!before.isDirectory()) {
        throw new DbStorageSafetyError(
          "path_is_not_directory",
          "BAKA_DB_ROOT или его ближайший существующий родитель не является каталогом",
        );
      }
      const resolved = path.resolve(await dependencies.realpath(candidate));
      if (resolved !== candidate) {
        throw new DbStorageSafetyError(
          "path_is_not_real",
          "BAKA_DB_ROOT не должен проходить через symlink или alias path",
        );
      }
      const after = await dependencies.lstat(candidate);
      if (
        after.isSymbolicLink() || !after.isDirectory() ||
        before.dev !== after.dev || before.ino !== after.ino
      ) {
        throw new DbStorageSafetyError(
          "path_changed",
          "storage path изменился во время проверки",
        );
      }
      return candidate;
    } catch (error) {
      if (error instanceof DbStorageSafetyError) throw error;
      if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR") {
        throw new DbStorageSafetyError(
          "path_evidence_unavailable",
          "не удалось получить real path evidence для BAKA_DB_ROOT",
          { cause: error },
        );
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new DbStorageSafetyError(
          "path_evidence_unavailable",
          "не найден существующий real parent для BAKA_DB_ROOT",
          { cause: error },
        );
      }
      candidate = parent;
    }
  }
}

async function readOnlyCommand(executable: string, args: string[]): Promise<string> {
  const result = await run(executable, args, {
    encoding: "utf8",
    timeout: READ_ONLY_COMMAND_TIMEOUT_MS,
    maxBuffer: READ_ONLY_COMMAND_MAX_BUFFER,
  });
  return result.stdout;
}

async function macDiskutilInfo(targetPath: string): Promise<string> {
  const df = await readOnlyCommand("df", ["-P", targetPath]);
  const lines = df.trim().split("\n");
  const device = lines.at(-1)?.trim().match(/^(\S+)/u)?.[1];
  if (!device?.startsWith("/dev/")) {
    throw new Error("df did not identify a local device");
  }
  return readOnlyCommand("diskutil", ["info", "-plist", device]);
}

const DEFAULT_DEPENDENCIES: DbStorageSafetyDependencies = {
  platform: process.platform,
  lstat,
  realpath,
  statfs,
  macDiskutilInfo,
};

function plistValue(plist: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return plist.match(
    new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([^<]*)</string>`, "u"),
  )?.[1];
}

function plistBoolean(plist: string, key: string): boolean | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = plist.match(
    new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<(true|false)\\s*/>`, "u"),
  )?.[1];
  return value === undefined ? undefined : value === "true";
}

/** Strict subset parser for the two diskutil plist facts used by this gate. */
export function parseMacDiskutilEvidence(plist: string): MacDiskutilEvidence {
  const internal = plistBoolean(plist, "Internal");
  const filesystemType = plistValue(plist, "FilesystemType")?.trim().toLowerCase();
  if (internal === undefined || !filesystemType) {
    throw new DbStorageSafetyError(
      "diskutil_evidence_unavailable",
      "diskutil не вернул обязательные Internal/FilesystemType evidence",
    );
  }
  return { internal, filesystemType };
}

function linuxFilesystem(type: number | bigint): string | undefined {
  const normalized = BigInt.asUintN(32, typeof type === "bigint" ? type : BigInt(type));
  return LINUX_LOCAL_POSIX_FILESYSTEMS.get(normalized);
}

/**
 * Validate the effective live RocksDB storage immediately before a production
 * start. Missing final directories are allowed only when their nearest
 * existing parent supplies stable, real, non-symlink storage evidence.
 */
export async function assertProductionDbStorageSafety(
  config: DbStorageConfig,
  dependencyOverrides: Partial<DbStorageSafetyDependencies> = {},
): Promise<DbStorageSafetyEvidence> {
  const lexical = assertDbRootLexicallySeparate(config.archiveRoot, config.dbRoot);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const checkedPath = await nearestRealDirectory(lexical.dbRoot, dependencies);

  if (dependencies.platform === "darwin") {
    let evidence: MacDiskutilEvidence;
    try {
      evidence = parseMacDiskutilEvidence(
        await dependencies.macDiskutilInfo(checkedPath),
      );
    } catch (error) {
      if (error instanceof DbStorageSafetyError) throw error;
      throw new DbStorageSafetyError(
        "diskutil_evidence_unavailable",
        "не удалось получить read-only diskutil evidence для BAKA_DB_ROOT",
        { cause: error },
      );
    }
    if (!evidence.internal) {
      throw new DbStorageSafetyError(
        "diskutil_not_internal",
        "production BAKA_DB_ROOT должен находиться на Internal=true storage",
      );
    }
    if (evidence.filesystemType !== "apfs") {
      throw new DbStorageSafetyError(
        "diskutil_not_apfs",
        "production BAKA_DB_ROOT требует APFS; ExFAT и другие filesystem запрещены",
      );
    }
    return {
      ...lexical,
      checkedPath,
      platform: "darwin",
      filesystem: evidence.filesystemType,
    };
  }

  if (dependencies.platform === "linux") {
    let filesystem: string | undefined;
    try {
      filesystem = linuxFilesystem((await dependencies.statfs(checkedPath)).type);
    } catch (error) {
      throw new DbStorageSafetyError(
        "path_evidence_unavailable",
        "не удалось получить filesystem evidence для BAKA_DB_ROOT",
        { cause: error },
      );
    }
    if (!filesystem) {
      throw new DbStorageSafetyError(
        "unsupported_filesystem",
        "production BAKA_DB_ROOT требует allowlisted local POSIX filesystem; ExFAT запрещён",
      );
    }
    return {
      ...lexical,
      checkedPath,
      platform: "linux",
      filesystem,
    };
  }

  throw new DbStorageSafetyError(
    "unsupported_platform",
    `production storage safety не поддерживает platform ${dependencies.platform}`,
  );
}
