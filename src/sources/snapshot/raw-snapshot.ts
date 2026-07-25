/**
 * Консистентный raw snapshot (docs/plan.md §4.2, §4.3, §9).
 *
 * Pipeline обычного файла (§9.1):
 *   stat → копия в staging/<run-id>/ с одновременным SHA-256 → fsync →
 *   повторный stat источника → при изменении retry (до maxAttempts) →
 *   raw/<harness>/<basename>__<sha256>.<ext> уже есть? проверить size+hash
 *   и переиспользовать : atomic rename из staging → результат.
 *
 * SQLite-источники (§9.2): НИКОГДА не filesystem copy живой базы — только
 * `VACUUM INTO` во временный файл в staging (консистентная копия при
 * открытом WAL), дальше тот же pipeline хэширования.
 *
 * Staging всегда внутри archiveRoot (§4.3), поэтому rename атомарен.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isSqlitePath } from "../adapters/file-matchers.ts";
import { hashFile, type FileHashes } from "./hashing.ts";
import { rawFileName } from "./naming.ts";

export class SnapshotError extends Error {}

export type SnapshotKind = "regular_copy" | "vacuum_into";

export interface SnapshotResult {
  /** Абсолютный путь immutable raw-файла. */
  rawArchivePath: string;
  /** Путь относительно archiveRoot: raw/<harness>/<name>. */
  relativeRawPath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  headHash: string;
  /** true, если raw с таким hash уже существовал и копирование не понадобилось. */
  reused: boolean;
  snapshotKind: SnapshotKind;
}

export interface SnapshotOptions {
  archiveRoot: string;
  harness: string;
  runId: string;
  /** Лимит повторов при изменении источника во время копирования (§9.1). */
  maxAttempts?: number;
  /**
   * Тестовый seam: вызывается после копирования попытки N, до повторного
   * stat источника. Позволяет детерминированно сымитировать «файл изменился
   * во время копирования» (сценарий §19.2 №14).
   */
  afterCopyAttempt?: (attempt: number, stagingPath: string) => void | Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function stagingDir(opts: SnapshotOptions): string {
  return path.join(opts.archiveRoot, "staging", opts.runId);
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Финализация snapshot'а: reuse существующего raw (проверка size+hash)
 * или atomic rename из staging в raw/<harness>/.
 */
async function finalize(
  stagingPath: string,
  sourceBasename: string,
  hashes: FileHashes,
  mtimeMs: number,
  kind: SnapshotKind,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  const rawDir = path.join(opts.archiveRoot, "raw", opts.harness);
  await mkdir(rawDir, { recursive: true });
  const name = rawFileName(sourceBasename, hashes.sha256);
  const target = path.join(rawDir, name);
  const relativeRawPath = path.join("raw", opts.harness, name);

  if (existsSync(target)) {
    // Raw immutable: существующий файл с тем же hash переиспользуется,
    // но сначала проверяем, что он не повреждён (size + полный hash).
    const existing = await stat(target);
    if (existing.size !== hashes.sizeBytes) {
      throw new SnapshotError(
        `raw-коллизия имени с другим размером: ${target} — архив повреждён`,
      );
    }
    const actual = await hashFile(target);
    if (actual.sha256 !== hashes.sha256) {
      throw new SnapshotError(`raw-файл не совпадает по hash: ${target} — архив повреждён`);
    }
    await rm(stagingPath, { force: true });
    return {
      rawArchivePath: target,
      relativeRawPath,
      sha256: hashes.sha256,
      sizeBytes: hashes.sizeBytes,
      mtimeMs,
      headHash: hashes.headHash,
      reused: true,
      snapshotKind: kind,
    };
  }

  await rename(stagingPath, target);
  await fsyncDir(rawDir);
  return {
    rawArchivePath: target,
    relativeRawPath,
    sha256: hashes.sha256,
    sizeBytes: hashes.sizeBytes,
    mtimeMs,
    headHash: hashes.headHash,
    reused: false,
    snapshotKind: kind,
  };
}

/** Snapshot обычного файла с retry при изменении во время копирования. */
export async function snapshotRegularFile(
  sourcePath: string,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const dir = stagingDir(opts);
  await mkdir(dir, { recursive: true });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = await stat(sourcePath);
    const stagingPath = path.join(dir, `${crypto.randomUUID()}.part`);
    let hashes: FileHashes;
    try {
      hashes = await hashFile(sourcePath, stagingPath);
      await opts.afterCopyAttempt?.(attempt, stagingPath);
    } catch (err) {
      await rm(stagingPath, { force: true });
      throw err;
    }
    const after = await stat(sourcePath);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return finalize(
        stagingPath,
        path.basename(sourcePath),
        hashes,
        after.mtimeMs,
        "regular_copy",
        opts,
      );
    }
    // Источник изменился во время копирования — staging выбрасываем (§9.1 п.6).
    await rm(stagingPath, { force: true });
    if (attempt === maxAttempts) {
      throw new SnapshotError(
        `источник нестабилен, snapshot не удался за ${maxAttempts} попытки: ${sourcePath}`,
      );
    }
  }
  throw new SnapshotError("unreachable");
}

/**
 * Snapshot живой SQLite-базы через `VACUUM INTO` (§9.2). Источник открывается
 * read-only; WAL учитывается движком SQLite, копия консистентна.
 */
export async function snapshotSqlite(
  sourcePath: string,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  const dir = stagingDir(opts);
  await mkdir(dir, { recursive: true });
  const stagingPath = path.join(dir, `${crypto.randomUUID()}.db`);

  const srcStat = await stat(sourcePath);
  const db = new Database(sourcePath, { readonly: true });
  try {
    const escaped = stagingPath.replaceAll("'", "''");
    db.run(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }

  const hashes = await hashFile(stagingPath);
  return finalize(
    stagingPath,
    path.basename(sourcePath),
    hashes,
    srcStat.mtimeMs,
    "vacuum_into",
    opts,
  );
}

/** Выбор стратегии по расширению: SQLite — только VACUUM INTO. */
export async function snapshotSource(
  sourcePath: string,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  return isSqlitePath(sourcePath)
    ? snapshotSqlite(sourcePath, opts)
    : snapshotRegularFile(sourcePath, opts);
}
