import { link, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

/** Ограничение попыток stale-takeover при гонке за освобождённый lock. */
const MAX_ATTEMPTS = 5;

/**
 * Захватывает process lock. Броском LockError отказывает, если lock держит
 * живой процесс; stale lock (мёртвый PID) перезаписывается.
 *
 * Атомарность (сценарий §19.2 №29): содержимое пишется во временный файл
 * и появляется на месте lock-файла через link(2) — атомарно и с отказом
 * EEXIST, если lock уже существует. Окон «пустой lock-файл» и read-check-
 * write гонки нет. Stale-takeover (unlink → link) повторяется ограниченное
 * число раз: проигравший гонку видит живой PID победителя и получает
 * LockError.
 */
export async function acquireLock(
  archiveRoot: string,
  command: string,
): Promise<() => Promise<void>> {
  const file = lockPath(archiveRoot);
  const info: LockInfo = {
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(info), "utf8");
    try {
      await link(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLock(archiveRoot);
      if (existing && pidAlive(existing.pid)) {
        throw new LockError(
          `lock уже захвачен: pid=${existing.pid} ` +
            `command="${existing.command}" с ${existing.startedAt}`,
        );
      }
      // Stale или битый lock: убираем и пробуем снова. Если параллельный
      // процесс успеет создать свой lock раньше — следующий link даст
      // EEXIST, и мы увидим его живой PID.
      await unlink(file).catch(() => {});
      continue;
    } finally {
      await rm(tmp, { force: true });
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await unlink(lockPath(archiveRoot)).catch(() => {});
    };
  }
  throw new LockError(`не удалось захватить lock за ${MAX_ATTEMPTS} попыток: ${file}`);
}

/** Есть ли активный (живой) lock. */
export async function isLocked(archiveRoot: string): Promise<boolean> {
  const existing = await readLock(archiveRoot);
  return existing !== null && pidAlive(existing.pid);
}

export function lockFilePath(archiveRoot: string): string {
  return path.join(archiveRoot, LOCK_FILE);
}
