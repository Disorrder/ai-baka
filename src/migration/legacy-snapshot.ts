/**
 * Консистентная snapshot-копия legacy index.sqlite (docs/plan.md §15.3).
 *
 * Importer и preflight НИКОГДА не работают с оригиналом: база копируется
 * через `VACUUM INTO` (источник открывается read-only, WAL учитывается
 * движком SQLite) в `<archiveRoot>/migration-input/index__<sha256>.sqlite`.
 * Оригинал остаётся нетронутым.
 *
 * Идемпотентно: snapshot с тем же SHA-256 уже существует → проверка
 * size+hash и переиспользование (как immutable raw, §4.2).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile, type FileHashes } from "../sources/snapshot/hashing.ts";

export class LegacySnapshotError extends Error {}

export interface LegacySnapshotResult {
  /** Абсолютный путь snapshot-копии. */
  snapshotPath: string;
  sha256: string;
  sizeBytes: number;
  /** true, если snapshot с этим hash уже существовал и копирование не понадобилось. */
  reused: boolean;
}

export function migrationInputDir(archiveRoot: string): string {
  return path.join(archiveRoot, "migration-input");
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
 * Sidecar с stat источника на момент vacuum: если legacy index.sqlite не
 * менялся (size + mtime совпадают), snapshot переиспользуется без повторного
 * VACUUM INTO и хэширования 6+ ГБ. mtime SQLite-файла меняется при любой
 * записи, поэтому совпадение stat = источник тот же; подмена sidecar вне
 * нашего архива невозможна, а битый snapshot всплывёт на анализе.
 */
interface SnapshotSourceSidecar {
  sourcePath: string;
  sourceSizeBytes: number;
  sourceMtimeMs: number;
  snapshotPath: string;
  sha256: string;
  sizeBytes: number;
}

function sidecarPath(snapshotPath: string): string {
  return `${snapshotPath}.source.json`;
}

/** Быстрый reuse по sidecar'ам существующих snapshot'ов, null если не подошло. */
async function reuseBySidecar(
  dir: string,
  sourcePath: string,
  sourceStat: { size: number; mtimeMs: number },
): Promise<LegacySnapshotResult | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".source.json")) continue;
    let sidecar: SnapshotSourceSidecar;
    try {
      sidecar = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (
      sidecar.sourcePath !== sourcePath ||
      sidecar.sourceSizeBytes !== sourceStat.size ||
      sidecar.sourceMtimeMs !== sourceStat.mtimeMs
    ) {
      continue;
    }
    try {
      const existing = await stat(sidecar.snapshotPath);
      if (existing.size !== sidecar.sizeBytes) continue;
    } catch {
      continue;
    }
    return {
      snapshotPath: sidecar.snapshotPath,
      sha256: sidecar.sha256,
      sizeBytes: sidecar.sizeBytes,
      reused: true,
    };
  }
  return null;
}

/**
 * Создаёт (или переиспользует) snapshot-копию legacy index.sqlite.
 * Имя результата: `index__<sha256>.sqlite` — hash содержимого, не источника.
 */
export async function ensureLegacySnapshot(
  sourcePath: string,
  archiveRoot: string,
): Promise<LegacySnapshotResult> {
  const dir = migrationInputDir(archiveRoot);
  await mkdir(dir, { recursive: true });
  const srcStat = await stat(sourcePath);

  const fast = await reuseBySidecar(dir, sourcePath, srcStat);
  if (fast) return fast;

  const stagingPath = path.join(dir, `.staging-${crypto.randomUUID()}.sqlite`);

  let db: Database;
  try {
    db = new Database(sourcePath, { readonly: true });
  } catch (err) {
    throw new LegacySnapshotError(
      `не удалось открыть legacy SQLite read-only: ${sourcePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  try {
    const escaped = stagingPath.replaceAll("'", "''");
    db.run(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }

  const hashes = await hashFile(stagingPath);
  const target = path.join(dir, `index__${hashes.sha256}.sqlite`);

  if (existsSync(target)) {
    // Snapshot immutable: существующий файл с тем же hash переиспользуется,
    // но сначала проверяем, что он не повреждён (size + полный hash).
    const existing = await stat(target);
    if (existing.size !== hashes.sizeBytes) {
      await rm(stagingPath, { force: true });
      throw new LegacySnapshotError(
        `snapshot-коллизия имени с другим размером: ${target} — migration-input повреждён`,
      );
    }
    const actual = await hashFile(target);
    if (actual.sha256 !== hashes.sha256) {
      await rm(stagingPath, { force: true });
      throw new LegacySnapshotError(
        `snapshot-файл не совпадает по hash: ${target} — migration-input повреждён`,
      );
    }
    await rm(stagingPath, { force: true });
    await writeSidecar(sourcePath, srcStat, target, hashes);
    return {
      snapshotPath: target,
      sha256: hashes.sha256,
      sizeBytes: hashes.sizeBytes,
      reused: true,
    };
  }

  await rename(stagingPath, target);
  await fsyncDir(dir);
  await writeSidecar(sourcePath, srcStat, target, hashes);
  return {
    snapshotPath: target,
    sha256: hashes.sha256,
    sizeBytes: hashes.sizeBytes,
    reused: false,
  };
}

async function writeSidecar(
  sourcePath: string,
  sourceStat: { size: number; mtimeMs: number },
  snapshotPath: string,
  hashes: FileHashes,
): Promise<void> {
  const sidecar: SnapshotSourceSidecar = {
    sourcePath,
    sourceSizeBytes: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    snapshotPath,
    sha256: hashes.sha256,
    sizeBytes: hashes.sizeBytes,
  };
  await writeFile(sidecarPath(snapshotPath), `${JSON.stringify(sidecar, null, 2)}\n`);
}
