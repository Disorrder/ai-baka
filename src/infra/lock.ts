import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const LOCK_FILE = ".baka-sync.lock";

export interface LockInfo {
  pid: number;
  command: string;
  startedAt: string;
}

export class LockError extends Error {}

function lockPath(archiveRoot: string): string {
  return path.join(archiveRoot, LOCK_FILE);
}

/** Жив ли процесс с данным PID. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH — процесса нет; EPERM — есть, но не наш (сигналить нельзя)
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readLock(archiveRoot: string): Promise<LockInfo | null> {
  const file = lockPath(archiveRoot);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as LockInfo;
  } catch {
    return null; // битый lock считаем отсутствующим
  }
}

/**
 * Захватывает process lock. Броском LockError отказывает, если lock держит
 * живой процесс; stale lock (мёртвый PID) перезаписывается.
 */
export async function acquireLock(
  archiveRoot: string,
  command: string,
): Promise<() => Promise<void>> {
  const existing = await readLock(archiveRoot);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    throw new LockError(
      `другой процесс держит lock: pid=${existing.pid} ` +
        `command="${existing.command}" с ${existing.startedAt}`,
    );
  }
  const info: LockInfo = {
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  };
  await writeFile(lockPath(archiveRoot), JSON.stringify(info), "utf8");
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(lockPath(archiveRoot)).catch(() => {});
  };
}

/** Есть ли активный (живой) lock. */
export async function isLocked(archiveRoot: string): Promise<boolean> {
  const existing = await readLock(archiveRoot);
  return existing !== null && pidAlive(existing.pid);
}

export function lockFilePath(archiveRoot: string): string {
  return path.join(archiveRoot, LOCK_FILE);
}
