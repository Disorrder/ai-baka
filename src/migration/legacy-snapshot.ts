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
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "../sources/snapshot/hashing.ts";

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
 * Создаёт (или переиспользует) snapshot-копию legacy index.sqlite.
 * Имя результата: `index__<sha256>.sqlite` — hash содержимого, не источника.
 */
export async function ensureLegacySnapshot(
  sourcePath: string,
  archiveRoot: string,
): Promise<LegacySnapshotResult> {
  const dir = migrationInputDir(archiveRoot);
  await mkdir(dir, { recursive: true });
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
    return {
      snapshotPath: target,
      sha256: hashes.sha256,
      sizeBytes: hashes.sizeBytes,
      reused: true,
    };
  }

  await rename(stagingPath, target);
  await fsyncDir(dir);
  return {
    snapshotPath: target,
    sha256: hashes.sha256,
    sizeBytes: hashes.sizeBytes,
    reused: false,
  };
}
