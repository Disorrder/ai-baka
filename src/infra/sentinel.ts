import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const SENTINEL_FILE = ".baka-archive.json";
export const ARCHIVE_FORMAT_VERSION = 1;

/** Каталоги архива, создаваемые при init (см. docs/plan.md §4). */
export const ARCHIVE_DIRS = [
  "db",
  "raw",
  "staging",
  "backups/surreal",
  "backups/manifests",
  "exports",
  "logs",
  "tmp",
] as const;

export interface ArchiveSentinel {
  archiveId: string;
  formatVersion: number;
  createdAt: string;
  expectedNamespace: string;
  expectedDatabase: string;
}

export function sentinelPath(archiveRoot: string): string {
  return path.join(archiveRoot, SENTINEL_FILE);
}

export class SentinelError extends Error {}

/** Создаёт структуру каталогов и sentinel. Отказывает, если sentinel уже есть. */
export async function initArchive(
  archiveRoot: string,
  expected: { namespace: string; database: string },
): Promise<ArchiveSentinel> {
  if (existsSync(sentinelPath(archiveRoot))) {
    throw new SentinelError(
      `sentinel уже существует: ${sentinelPath(archiveRoot)} — архив уже инициализирован`,
    );
  }
  for (const dir of ARCHIVE_DIRS) {
    await mkdir(path.join(archiveRoot, dir), { recursive: true });
  }
  const sentinel: ArchiveSentinel = {
    archiveId: crypto.randomUUID(),
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    expectedNamespace: expected.namespace,
    expectedDatabase: expected.database,
  };
  await writeFile(
    sentinelPath(archiveRoot),
    JSON.stringify(sentinel, null, 2) + "\n",
    { encoding: "utf8" },
  );
  return sentinel;
}

export async function readSentinel(archiveRoot: string): Promise<ArchiveSentinel> {
  const file = sentinelPath(archiveRoot);
  if (!existsSync(file)) {
    throw new SentinelError(`sentinel не найден: ${file} (сначала archive:init)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new SentinelError(`sentinel повреждён (не JSON): ${file}`);
  }
  const s = parsed as Partial<ArchiveSentinel>;
  if (
    typeof s.archiveId !== "string" ||
    typeof s.formatVersion !== "number" ||
    typeof s.expectedNamespace !== "string" ||
    typeof s.expectedDatabase !== "string"
  ) {
    throw new SentinelError(`sentinel неполный или невалидный: ${file}`);
  }
  return s as ArchiveSentinel;
}
