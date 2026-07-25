import { open, readFile, unlink } from "node:fs/promises";
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

/** Паузы перед признанием нечитаемого lock'а stale (см. acquireLock). */
const BROKEN_REREAD_MS = [50, 100, 200, 400];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Захватывает process lock. Броском LockError отказывает, если lock держит
 * живой процесс; stale lock (мёртвый PID) перезаписывается.
 *
 * Атомарность (сценарий §19.2 №29): lock создаётся open(2) с флагом "wx"
 * (O_EXCL) — атомарный exclusive create, работает на томе архива (hardlink
 * там не поддерживается, ENOTSUP). Между create и записью содержимого есть
 * окно «пустой lock-файл»: конкурент, увидевший нечитаемый lock, повторяет
 * чтение с паузами (BROKEN_REREAD_MS) и лишь затем считает его stale.
 * Stale-takeover (unlink → wx) повторяется ограниченное число раз:
 * проигравший гонку видит живой PID победителя и получает LockError.
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
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify(info), "utf8");
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing = await readLock(archiveRoot);
      // Окно create→write у держателя: нечитаемый lock перечитываем с
      // паузами, прежде чем считать его битым/stale.
      for (const pause of BROKEN_REREAD_MS) {
        if (existing) break;
        await sleep(pause);
        existing = await readLock(archiveRoot);
      }
      if (existing && pidAlive(existing.pid)) {
        throw new LockError(
          `lock уже захвачен: pid=${existing.pid} ` +
            `command="${existing.command}" с ${existing.startedAt}`,
        );
      }
      // Stale или битый lock: убираем и пробуем снова. Если параллельный
      // процесс успеет создать свой lock раньше — следующий wx даст
      // EEXIST, и мы увидим его живой PID.
      await unlink(file).catch(() => {});
      continue;
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
