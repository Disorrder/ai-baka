/**
 * Сканирование source root с явным статусом полноты (docs/plan.md §10.2).
 *
 * Статусы:
 * - complete           — весь root обойдён без ошибок;
 * - partial            — часть дерева не прочиталась (ошибки в `errors`);
 * - unavailable        — root не существует / недоступен;
 * - permission_denied  — нет прав на чтение самого root;
 * - failed             — прочая ошибка на уровне root.
 *
 * `missing`/`deleted_in_source` в sync вычисляются только после `complete`.
 *
 * Особенности обхода:
 * - AppleDouble-файлы (`._*`) игнорируются;
 * - symlink'и не обходятся (защита от циклов и побочных деревьев);
 * - root может быть как директорией, так и одиночным файлом
 *   (например, `~/.claude/history.jsonl`).
 */

import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { matchAll, type FileMatcher } from "../adapters/file-matchers.ts";

export type ScanStatus =
  | "complete"
  | "partial"
  | "unavailable"
  | "permission_denied"
  | "failed";

export interface ScannedFile {
  /** Путь относительно root, с разделителем `/`. Для root-файла — basename. */
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ScanError {
  path: string;
  code?: string;
  message: string;
}

export interface ScanResult {
  status: ScanStatus;
  files: ScannedFile[];
  errors: ScanError[];
}

function errorInfo(err: unknown, p: string): ScanError {
  const e = err as NodeJS.ErrnoException;
  return {
    path: p,
    code: typeof e?.code === "string" ? e.code : undefined,
    message: e instanceof Error ? e.message : String(err),
  };
}

function toRelative(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join("/");
}

export async function scanSourceRoot(
  rootPath: string,
  matcher: FileMatcher = matchAll,
  onProgress?: (filesFound: number) => void,
): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const errors: ScanError[] = [];
  onProgress?.(0);

  let rootStat;
  try {
    rootStat = await lstat(rootPath);
  } catch (err) {
    const info = errorInfo(err, rootPath);
    const status: ScanStatus =
      info.code === "EACCES" || info.code === "EPERM"
        ? "permission_denied"
        : info.code === "ENOENT" || info.code === "ENOTDIR"
          ? "unavailable"
          : "failed";
    return { status, files, errors: [info] };
  }

  // Root — одиночный файл.
  if (!rootStat.isDirectory()) {
    if (rootStat.isFile() && matcher(path.basename(rootPath), path.basename(rootPath))) {
      files.push({
        relativePath: path.basename(rootPath),
        sizeBytes: rootStat.size,
        mtimeMs: rootStat.mtimeMs,
      });
    }
    onProgress?.(files.length);
    return { status: "complete", files, errors };
  }

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const info = errorInfo(err, dir);
      if (isRoot) {
        // Не смогли прочитать сам root — scan не состоялся вовсе.
        throw Object.assign(new Error(info.message), { scanError: info });
      }
      errors.push(info);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, false);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith("._")) continue; // AppleDouble
      const relativePath = toRelative(rootPath, full);
      if (!matcher(relativePath, entry.name)) continue;
      try {
        const st = await stat(full);
        files.push({ relativePath, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        errors.push(errorInfo(err, full));
      }
      onProgress?.(files.length);
    }
  }

  try {
    await walk(rootPath, true);
  } catch (err) {
    const info = (err as { scanError?: ScanError }).scanError ?? errorInfo(err, rootPath);
    const status: ScanStatus =
      info.code === "EACCES" || info.code === "EPERM" ? "permission_denied" : "failed";
    return { status, files: [], errors: [info] };
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { status: errors.length > 0 ? "partial" : "complete", files, errors };
}
