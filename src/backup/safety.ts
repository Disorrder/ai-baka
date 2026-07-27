/**
 * Shared filesystem/identifier safety for backup artifacts.
 *
 * Backup metadata is input at restore time, not trusted code. Identifiers are
 * therefore validated before interpolation, and filesystem references are
 * resolved through realpath without following a manifest-controlled symlink.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";

export const INTERNAL_TABLE_IDENTIFIER = /^[a-z][a-z0-9_]{0,127}$/;
export const EMBEDDING_TABLE_IDENTIFIER = /^search_embedding_[a-z0-9_]{1,110}$/;

export function assertInternalTableIdentifier(value: string, label = "table"): string {
  if (!INTERNAL_TABLE_IDENTIFIER.test(value)) {
    throw new Error(`${label}: небезопасный внутренний идентификатор ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertEmbeddingTableIdentifier(value: string, label = "embedding table"): string {
  assertInternalTableIdentifier(value, label);
  if (!EMBEDDING_TABLE_IDENTIFIER.test(value)) {
    throw new Error(`${label}: ожидалось имя search_embedding_*: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function assertRegularNonSymlinkFile(
  filePathInput: string,
  label = "file",
): Promise<string> {
  const filePath = path.resolve(filePathInput);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} должен быть обычным файлом без symlink: ${filePath}`);
  }
  return filePath;
}

/** Content and inode identity carried from authentication to a later read. */
export interface AuthenticatedRegularFileIdentity {
  resolvedPath: string;
  device: string;
  inode: string;
  sizeBytes: number;
  mode: string;
  sha256: string;
}

export interface OpenAuthenticatedRegularFile {
  identity: AuthenticatedRegularFileIdentity;
  descriptor: FileHandle;
}

function sameRegularFileStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode;
}

async function hashOpenRegularFile(
  descriptor: FileHandle,
  sizeBytes: number,
  label: string,
): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < sizeBytes) {
    const { bytesRead } = await descriptor.read(
      buffer,
      0,
      Math.min(buffer.byteLength, sizeBytes - position),
      position,
    );
    if (bytesRead <= 0) throw new Error(`${label} changed during authenticated read`);
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

function identityFromStat(
  resolvedPath: string,
  info: BigIntStats,
  sha256: string,
  label: string,
): AuthenticatedRegularFileIdentity {
  const sizeBytes = Number(info.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error(`${label} size is invalid`);
  }
  return {
    resolvedPath,
    device: String(info.dev),
    inode: String(info.ino),
    sizeBytes,
    mode: String(info.mode),
    sha256,
  };
}

function sameAuthenticatedIdentity(
  left: AuthenticatedRegularFileIdentity,
  right: AuthenticatedRegularFileIdentity,
): boolean {
  return left.resolvedPath === right.resolvedPath && left.device === right.device &&
    left.inode === right.inode && left.sizeBytes === right.sizeBytes &&
    left.mode === right.mode && left.sha256 === right.sha256;
}

async function authenticateOpenRegularFile(
  descriptor: FileHandle,
  resolvedPath: string,
  label: string,
): Promise<AuthenticatedRegularFileIdentity> {
  const before = await descriptor.stat({ bigint: true });
  const linkedBefore = await lstat(resolvedPath, { bigint: true });
  if (!sameRegularFileStat(before, linkedBefore)) {
    throw new Error(`${label} pathname does not identify the opened regular file`);
  }
  const sizeBytes = Number(before.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error(`${label} size is invalid`);
  }
  const sha256 = await hashOpenRegularFile(descriptor, sizeBytes, label);
  const after = await descriptor.stat({ bigint: true });
  const linkedAfter = await lstat(resolvedPath, { bigint: true });
  if (!sameRegularFileStat(before, after) || !sameRegularFileStat(after, linkedAfter)) {
    throw new Error(`${label} pathname or identity changed during authentication`);
  }
  return identityFromStat(resolvedPath, after, sha256, label);
}

/** Authenticate a regular file without following a symlink at its leaf. */
export async function authenticateRegularFileIdentity(
  filePathInput: string,
  label = "file",
): Promise<AuthenticatedRegularFileIdentity> {
  const resolvedPath = path.resolve(filePathInput);
  const descriptor = await open(
    resolvedPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    return await authenticateOpenRegularFile(descriptor, resolvedPath, label);
  } finally {
    await descriptor.close();
  }
}

/**
 * Open the exact previously authenticated inode and re-hash it before use.
 * Callers keep this descriptor open across the later streaming read.
 */
export async function openAuthenticatedRegularFile(
  expected: AuthenticatedRegularFileIdentity,
  label = "file",
): Promise<OpenAuthenticatedRegularFile> {
  const descriptor = await open(
    expected.resolvedPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const identity = await authenticateOpenRegularFile(
      descriptor,
      expected.resolvedPath,
      label,
    );
    if (!sameAuthenticatedIdentity(identity, expected)) {
      throw new Error(`${label} no longer matches its authenticated identity`);
    }
    return { identity, descriptor };
  } catch (error) {
    await descriptor.close().catch(() => {});
    throw error;
  }
}

/** Revalidate descriptor bytes and pathname identity after the streaming read. */
export async function assertOpenAuthenticatedRegularFileUnchanged(
  source: OpenAuthenticatedRegularFile,
  label = "file",
): Promise<void> {
  const identity = await authenticateOpenRegularFile(
    source.descriptor,
    source.identity.resolvedPath,
    label,
  );
  if (!sameAuthenticatedIdentity(identity, source.identity)) {
    throw new Error(`${label} changed across the authenticated streaming read`);
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * Resolves a manifest raw path to a regular, non-symlink file below raw/.
 * Both lexical and real containment are checked; a symlink in any parent is
 * rejected because lexical and real paths no longer match.
 */
export async function resolveContainedRawFile(
  archiveRootInput: string,
  manifestPath: string,
): Promise<string> {
  if (!manifestPath || path.isAbsolute(manifestPath)) {
    throw new Error(`raw path должен быть относительным: ${JSON.stringify(manifestPath)}`);
  }
  const normalized = path.normalize(manifestPath);
  if (!(normalized === "raw" || normalized.startsWith(`raw${path.sep}`))) {
    throw new Error(`raw path должен находиться в raw/: ${manifestPath}`);
  }
  const archiveRoot = await realpath(path.resolve(archiveRootInput));
  const rawRoot = await realpath(path.join(archiveRoot, "raw"));
  const lexical = path.resolve(archiveRoot, normalized);
  if (!isInside(rawRoot, lexical)) {
    throw new Error(`raw path выходит из raw root: ${manifestPath}`);
  }
  const info = await lstat(lexical);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`raw path должен быть обычным файлом без symlink: ${manifestPath}`);
  }
  const resolved = await realpath(lexical);
  if (!isInside(rawRoot, resolved) || resolved !== lexical) {
    throw new Error(`raw path проходит через symlink или выходит из raw root: ${manifestPath}`);
  }
  return resolved;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class AtomicNoReplaceUnsupportedError extends Error {
  readonly code = "ATOMIC_NOREPLACE_UNSUPPORTED";

  constructor(readonly errno?: number) {
    super(
      `atomic rename-no-replace is unsupported${errno === undefined ? "" : ` (errno ${errno})`}`,
    );
    this.name = "AtomicNoReplaceUnsupportedError";
  }
}

function isUnsupportedAtomicRenameErrno(errno: number): boolean {
  const unsupported = [
    osConstants.errno.ENOTSUP,
    osConstants.errno.EOPNOTSUPP,
    osConstants.errno.ENOSYS,
    // Some filesystems report an unsupported rename flag as EINVAL.
    osConstants.errno.EINVAL,
  ].filter((value): value is number => typeof value === "number");
  return unsupported.includes(errno);
}

function atomicRenameFailure(errno: number, destination: string): Error {
  if (isUnsupportedAtomicRenameErrno(errno)) {
    return new AtomicNoReplaceUnsupportedError(errno);
  }
  if (errno === osConstants.errno.EEXIST) {
    return new Error(`backup artifact уже существует; destination не будет перезаписан: ${destination}`);
  }
  return new Error(
    `atomic no-clobber publication failed (errno ${errno}); ` +
      `destination не будет перезаписан: ${destination}`,
  );
}

/**
 * Atomic publication primitive with kernel-enforced no-replace semantics.
 *
 * A preceding lstat cannot implement no-clobber: ordinary rename(2) replaces a
 * destination created in the check/rename window. Stage 12 targets Darwin and
 * Linux and therefore fails closed elsewhere instead of reintroducing TOCTOU.
 * Works for both regular files and directories on the same filesystem.
 */
export async function renameNoReplace(source: string, destination: string): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new AtomicNoReplaceUnsupportedError();
  }
  const { dlopen, FFIType, read } = await import("bun:ffi");
  const nul = (value: string): Buffer => Buffer.from(`${value}\0`);
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.uint32_t],
        returns: FFIType.int,
      },
      __error: { args: [], returns: FFIType.ptr },
    });
    try {
      // RENAME_EXCL from <sys/stdio.h>.
      if (library.symbols.renamex_np(nul(source), nul(destination), 0x00000004) !== 0) {
        const errnoPointer = library.symbols.__error();
        const errno = errnoPointer === null ? -1 : read.i32(errnoPointer);
        throw atomicRenameFailure(errno, destination);
      }
      return;
    } finally {
      library.close();
    }
  }

  const library = dlopen("libc.so.6", {
    renameat2: {
      args: [
        FFIType.int,
        FFIType.cstring,
        FFIType.int,
        FFIType.cstring,
        FFIType.uint32_t,
      ],
      returns: FFIType.int,
    },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  try {
    // AT_FDCWD + RENAME_NOREPLACE from renameat2(2).
    if (library.symbols.renameat2(-100, nul(source), -100, nul(destination), 1) !== 0) {
      const errnoPointer = library.symbols.__errno_location();
      const errno = errnoPointer === null ? -1 : read.i32(errnoPointer);
      throw atomicRenameFailure(errno, destination);
    }
  } finally {
    library.close();
  }
}

export async function fsyncRegularFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`fsync target должен быть обычным файлом: ${filePath}`);
  }
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface WritePrivateFileAtomicOptions {
  /** Replace an existing regular file atomically; symlinks are never followed. */
  overwrite?: boolean;
  /** No-clobber publication seam; ignored for explicit overwrite. */
  publication?: PublishPreparedFileOptions;
}

/**
 * Private unpredictable temp + fsync + atomic publication.
 *
 * No-clobber is the default and is enforced by the kernel. Explicit overwrite
 * accepts only a missing destination or a regular file: a stable symlink (or
 * any other non-regular leaf) is rejected, while rename(2) itself never follows
 * a destination symlink created in the lstat/rename race window.
 */
export async function writePrivateFileAtomic(
  filePathInput: string,
  content: string,
  options: WritePrivateFileAtomicOptions = {},
): Promise<void> {
  const filePath = path.resolve(filePathInput);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.part`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();

    if (options.overwrite) {
      const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error(`refusing to overwrite non-regular private artifact: ${filePath}`);
      }
      await rename(temporary, filePath);
      await fsyncDirectory(directory);
    } else {
      await publishPreparedFileNoClobber(temporary, filePath, options.publication);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Private unpredictable temp + fsync + kernel-enforced no-clobber publication. */
export async function writePrivateFileAtomicNoClobber(
  filePathInput: string,
  content: string,
  publication: PublishPreparedFileOptions = {},
): Promise<void> {
  await writePrivateFileAtomic(filePathInput, content, { publication });
}

/** Create an unpredictable, private temp file exclusively in a target dir. */
export async function createExclusiveTemporaryFile(
  directory: string,
  label: string,
): Promise<{ path: string; close: () => Promise<void> }> {
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${label}.${randomUUID()}.part`);
  const handle = await open(temporary, "wx", 0o600);
  let closed = false;
  return {
    path: temporary,
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

export interface PublishPreparedFileOptions {
  /** Test seam for forcing the filesystem's unsupported atomic path. */
  atomicRename?: (source: string, destination: string) => Promise<void>;
  /** Bounded fallback buffer; defaults to 1 MiB. */
  copyChunkBytes?: number;
  /** Test/observability seam called after each fully written fallback chunk. */
  afterCopyChunk?: (copiedBytes: number) => void | Promise<void>;
}

function copyChunkSize(value: number | undefined): number {
  const size = value ?? 1024 * 1024;
  if (!Number.isSafeInteger(size) || size < 4096 || size > 8 * 1024 * 1024) {
    throw new Error("fallback copyChunkBytes must be an integer between 4096 and 8388608");
  }
  return size;
}

async function writeAll(
  destination: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await destination.write(
      buffer,
      written,
      length - written,
      position + written,
    );
    if (result.bytesWritten <= 0) throw new Error("fallback publication made no write progress");
    written += result.bytesWritten;
  }
}

async function removeOwnedFile(
  filePath: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  const current = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!current) return;
  if (
    !current.isFile() || current.isSymbolicLink() ||
    current.dev !== identity.dev || current.ino !== identity.ino
  ) {
    throw new Error("fallback publication destination changed during cleanup");
  }
  await unlink(filePath);
}

async function copyPreparedFileExclusive(
  temporary: string,
  destination: string,
  options: PublishPreparedFileOptions,
): Promise<void> {
  const chunkBytes = copyChunkSize(options.copyChunkBytes);
  const sourcePathInfo = await lstat(temporary);
  if (!sourcePathInfo.isFile() || sourcePathInfo.isSymbolicLink()) {
    throw new Error(`backup temp должен быть обычным файлом: ${temporary}`);
  }
  const source = await open(
    temporary,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  let destinationIdentity: { dev: number; ino: number } | undefined;
  let destinationDurable = false;
  try {
    const sourceInfo = await source.stat();
    if (
      !sourceInfo.isFile() || sourceInfo.dev !== sourcePathInfo.dev ||
      sourceInfo.ino !== sourcePathInfo.ino
    ) {
      throw new Error("backup temp changed while opening fallback source");
    }
    destinationHandle = await open(
      destination,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const destinationInfo = await destinationHandle.stat();
    destinationIdentity = { dev: destinationInfo.dev, ino: destinationInfo.ino };
    await destinationHandle.chmod(0o600);

    const buffer = Buffer.allocUnsafe(chunkBytes);
    let copied = 0;
    while (copied < sourceInfo.size) {
      const length = Math.min(buffer.byteLength, sourceInfo.size - copied);
      const { bytesRead } = await source.read(buffer, 0, length, copied);
      if (bytesRead <= 0) throw new Error("backup temp ended during fallback publication");
      await writeAll(destinationHandle, buffer, bytesRead, copied);
      copied += bytesRead;
      await options.afterCopyChunk?.(copied);
    }
    const finalSourceInfo = await source.stat();
    if (
      copied !== sourceInfo.size || finalSourceInfo.size !== sourceInfo.size ||
      finalSourceInfo.dev !== sourceInfo.dev || finalSourceInfo.ino !== sourceInfo.ino
    ) {
      throw new Error("backup temp changed during fallback publication");
    }
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;
    await fsyncDirectory(path.dirname(destination));
    destinationDurable = true;
    // Temp cleanup is not part of the commit: the final file and its directory
    // are already durable, and a leftover hidden .part is undiscoverable.
    await source.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  } catch (error) {
    await destinationHandle?.close().catch(() => {});
    await source.close().catch(() => {});
    if (destinationIdentity && !destinationDurable) {
      try {
        await removeOwnedFile(destination, destinationIdentity);
        await fsyncDirectory(path.dirname(destination));
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "fallback publication failed and owned destination cleanup failed",
        );
      }
    }
    throw error;
  }
}

/**
 * Publishes a prepared file without replacing a final artifact.
 *
 * Atomic rename-no-replace stays the fast path. Filesystems such as ExFAT
 * that reject the atomic flag fall back to an O_EXCL final file plus bounded
 * copy; a crash-visible partial has no commit manifest and is undiscoverable.
 */
export async function publishPreparedFileNoClobber(
  temporary: string,
  destinationInput: string,
  options: PublishPreparedFileOptions = {},
): Promise<void> {
  const destination = path.resolve(destinationInput);
  const info = await lstat(temporary);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`backup temp должен быть обычным файлом: ${temporary}`);
  }
  const handle = await open(temporary, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await (options.atomicRename ?? renameNoReplace)(temporary, destination);
    await fsyncDirectory(path.dirname(destination));
  } catch (error) {
    if (!(error instanceof AtomicNoReplaceUnsupportedError)) throw error;
    await copyPreparedFileExclusive(temporary, destination, options);
  }
}
