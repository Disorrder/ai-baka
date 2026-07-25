/**
 * Orphan detection (docs/plan.md §9.3, §17.4 doctor):
 *
 * - staging-orphans: каталоги/файлы в staging/, не относящиеся к текущему
 *   run (остатки упавших запусков; дочищает будущий `doctor
 *   --remove-stale-staging`);
 * - raw-orphans: файлы в raw/, чей SHA-256 не входит в список известных
 *   (например, сбой после rename, но до DB commit). Здесь только обнаружение,
 *   удаление ничего не выполняется.
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const RAW_NAME_RE = /__([0-9a-f]{64})(\.[^.]+)?$/;

/** SHA-256 из имени raw-файла; null, если имя не соответствует формату. */
export function sha256FromRawName(basename: string): string | null {
  const m = RAW_NAME_RE.exec(basename);
  return m ? (m[1] ?? null) : null;
}

/** Записи в staging/, не принадлежащие текущему run (каталоги <run-id> и stray-файлы). */
export async function findStagingOrphans(
  archiveRoot: string,
  currentRunId: string,
): Promise<string[]> {
  const stagingDir = path.join(archiveRoot, "staging");
  if (!existsSync(stagingDir)) return [];
  const entries = await readdir(stagingDir, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== currentRunId)
    .map((e) => path.join(stagingDir, e.name))
    .sort();
}

/**
 * Raw-файлы, о которых ничего не известно: hash не в `knownSha256`
 * или имя вообще не соответствует формату `<basename>__<sha256>.<ext>`.
 */
export async function findRawOrphans(
  archiveRoot: string,
  knownSha256: ReadonlySet<string>,
): Promise<string[]> {
  const rawDir = path.join(archiveRoot, "raw");
  if (!existsSync(rawDir)) return [];
  const orphans: string[] = [];
  for (const harnessEntry of await readdir(rawDir, { withFileTypes: true })) {
    if (!harnessEntry.isDirectory()) {
      orphans.push(path.join(rawDir, harnessEntry.name));
      continue;
    }
    const harnessDir = path.join(rawDir, harnessEntry.name);
    for (const file of await readdir(harnessDir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const sha = sha256FromRawName(file.name);
      if (sha === null || !knownSha256.has(sha)) {
        orphans.push(path.join(harnessDir, file.name));
      }
    }
  }
  return orphans.sort();
}
