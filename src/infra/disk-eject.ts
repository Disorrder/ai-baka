import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isLocked } from "./lock.ts";
import { composeDown, composeStatus } from "./compose.ts";

const run = promisify(execFile);

export class EjectError extends Error {}

/** Точка монтирования тома, на котором лежит путь (через `df`). */
export async function mountPointOf(targetPath: string): Promise<string> {
  const { stdout } = await run("df", [targetPath]);
  const lines = stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  const mountPoint = last.split(/\s+/).pop();
  if (!mountPoint || !mountPoint.startsWith("/")) {
    throw new EjectError(`не удалось определить точку монтирования для ${targetPath}`);
  }
  return mountPoint;
}

/** Есть ли открытые файлы внутри пути (через lsof). */
export async function openFilesUnder(targetPath: string): Promise<string[]> {
  try {
    const { stdout } = await run("lsof", ["+D", targetPath]);
    return stdout
      .trim()
      .split("\n")
      .slice(1) // заголовок
      .filter(Boolean);
  } catch (error) {
    // lsof возвращает 1, когда ничего не найдено
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
}

/**
 * disk:eject (docs/plan.md §5.3):
 * lock check → compose down → открытые файлы → размонтирование тома.
 */
export async function ejectDisk(
  archiveRoot: string,
  log: (message: string) => void,
): Promise<void> {
  if (await isLocked(archiveRoot)) {
    throw new EjectError("активный sync lock — дождитесь завершения sync");
  }

  const status = await composeStatus();
  if (status && status.state === "running") {
    log("останавливаю SurrealDB…");
    await composeDown();
  }

  const openFiles = await openFilesUnder(archiveRoot);
  if (openFiles.length > 0) {
    throw new EjectError(
      `есть открытые файлы в архиве:\n${openFiles.slice(0, 10).join("\n")}`,
    );
  }

  const mountPoint = await mountPointOf(archiveRoot);
  if (mountPoint === "/") {
    throw new EjectError(
      `${archiveRoot} на корневой файловой системе — размонтировать нельзя`,
    );
  }
  log(`размонтирую ${mountPoint}…`);
  await run("diskutil", ["eject", mountPoint]);
}
