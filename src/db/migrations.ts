import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { ArchiveSentinel } from "../infra/sentinel.ts";

/** Каталог с .surql-миграциями (docs/plan.md §6). */
export const SCHEMA_DIR = path.resolve(import.meta.dir, "../../schema");

export class MigrationError extends Error {}

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  path: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: unknown;
  baka_commit: string;
  surrealdb_version: string;
}

export interface ApplyResult {
  /** Версии, применённые в этом запуске. */
  applied: number[];
  /** Текущая версия схемы после запуска (0 — база пустая). */
  version: number;
}

export interface ApplyOptions {
  schemaDir?: string;
  bakaCommit?: string;
  surrealdbVersion?: string;
  /** Если задан — после применения 0001 обновляется archive_meta:main. */
  sentinel?: ArchiveSentinel;
}

const EMBEDDING_TABLE_NAME = /^search_embedding_[a-zA-Z0-9_]+$/;

type LoadedMigration = Readonly<
  MigrationFile & {
    checksum: string;
    /** Immutable string snapshot: этот же payload хэшируется и передаётся в db.query. */
    content: string;
  }
>;

/** SHA-256 содержимого файла миграции (hex). */
export function checksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Разбирает имя файла вида `0001_initial.surql`; null — не похоже на миграцию. */
export function parseMigrationFileName(
  file: string,
): { version: number; name: string } | null {
  const match = /^(\d{4})_(.+)\.surql$/.exec(file);
  if (!match) return null;
  return { version: Number(match[1]), name: match[2]! };
}

/** Список миграций в каталоге, отсортированный по версии. */
export async function listMigrations(dir: string = SCHEMA_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".surql")).sort();
  const migrations: MigrationFile[] = [];
  for (const file of entries) {
    const parsed = parseMigrationFileName(file);
    if (!parsed) {
      throw new MigrationError(`некорректное имя файла миграции: ${file}`);
    }
    if (migrations.some((m) => m.version === parsed.version)) {
      throw new MigrationError(`дубликат версии миграции: ${file}`);
    }
    migrations.push({ ...parsed, file, path: path.join(dir, file) });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * Чистая логика сверки версий (без БД):
 * - применённая миграция без файла или с другим checksum → ошибка;
 * - версия в БД новее всех известных → ошибка (код старее базы);
 * - возвращает файлы, которые нужно применить.
 */
export function planPendingMigrations<T extends Readonly<MigrationFile & { checksum: string }>>(
  files: readonly T[],
  applied: readonly AppliedMigration[],
): T[] {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const maxKnown = files.length ? Math.max(...files.map((f) => f.version)) : 0;
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      if (row.version > maxKnown) {
        throw new MigrationError(
          `в БД применена миграция ${row.version} (${row.name}), новее всех известных ` +
            `(max ${maxKnown}) — обновите baka до версии, знающей эту схему`,
        );
      }
      throw new MigrationError(
        `в БД применена миграция ${row.version} (${row.name}), но файл отсутствует в schema/`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `checksum миграции ${file.file} не совпадает: в БД ${row.checksum}, в файле ${file.checksum} ` +
          `(файл изменён после применения)`,
      );
    }
  }
  const appliedVersions = new Set(applied.map((r) => r.version));
  return files.filter((f) => !appliedVersions.has(f.version));
}

/** Текущий commit репозитория; "unknown" вне git-окружения. */
export function gitHead(cwd: string = path.resolve(import.meta.dir, "../..")): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Таблица учёта миграций (docs/plan.md §6) — bootstrap самим runner'ом. */
async function ensureMigrationTable(db: Surreal): Promise<void> {
  await db.query(`
DEFINE TABLE IF NOT EXISTS schema_migration SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS version ON TABLE schema_migration TYPE int;
DEFINE FIELD IF NOT EXISTS name ON TABLE schema_migration TYPE string;
DEFINE FIELD IF NOT EXISTS checksum ON TABLE schema_migration TYPE string;
DEFINE FIELD IF NOT EXISTS applied_at ON TABLE schema_migration TYPE datetime;
DEFINE FIELD IF NOT EXISTS baka_commit ON TABLE schema_migration TYPE string;
DEFINE FIELD IF NOT EXISTS surrealdb_version ON TABLE schema_migration TYPE string;
DEFINE INDEX IF NOT EXISTS schema_migration_version_unique ON TABLE schema_migration FIELDS version UNIQUE;
`);
}

async function readApplied(db: Surreal): Promise<AppliedMigration[]> {
  const [rows] = await db.query<[AppliedMigration[]]>(
    "SELECT version, name, checksum, applied_at, baka_commit, surrealdb_version FROM schema_migration ORDER BY version",
  );
  return rows ?? [];
}

/** Текущая версия схемы (max version из schema_migration; 0 — схема не применялась). */
export async function checkSchemaVersion(db: Surreal): Promise<number> {
  const rows = await readApplied(db);
  return rows.reduce((max, row) => Math.max(max, row.version), 0);
}

async function upsertArchiveMeta(
  db: Surreal,
  sentinel: ArchiveSentinel,
  schemaVersion: number,
  bakaCommit: string,
): Promise<void> {
  const [existing] = await db.query<[Array<{ archive_uuid: string }>]>(
    "SELECT archive_uuid FROM archive_meta:main",
  );
  if (existing && existing.length > 0) {
    // Отступление от плана: CREATE ... ON DUPLICATE KEY UPDATE в SurrealDB
    // 3.2.3 не поддержан для CREATE — заменено на SELECT + CREATE/UPDATE.
    await db.query(
      "UPDATE archive_meta:main SET schema_version = $schemaVersion, last_opened_at = $now",
      { schemaVersion, now: new Date() },
    );
    return;
  }
  await db.query(
    `CREATE archive_meta:main SET
      archive_uuid = $archiveUuid,
      format_version = $formatVersion,
      schema_version = $schemaVersion,
      created_at = $now,
      last_opened_at = $now,
      created_by_baka_commit = $bakaCommit`,
    {
      archiveUuid: sentinel.archiveId,
      formatVersion: sentinel.formatVersion,
      schemaVersion,
      now: new Date(),
      bakaCommit,
    },
  );
}

/**
 * Физические embedding-таблицы создаются динамически, поэтому их индексы не
 * могут жить в numbered .surql schema-файле. Схема 0007 вводит writer
 * reference indexes; этот helper догоняет уже существующие search_embedding_*.
 */
async function ensureEmbeddingReferenceIndexes(db: Surreal): Promise<void> {
  const [spaces] = await db.query<[Array<{ physical_table?: string }>]>(
    "SELECT physical_table FROM embedding_space",
  );
  for (const space of spaces ?? []) {
    const table = space.physical_table;
    if (!table) continue;
    if (!EMBEDDING_TABLE_NAME.test(table)) {
      throw new MigrationError(`небезопасное имя embedding-таблицы в БД: ${table}`);
    }
    await db.query(
      `DEFINE INDEX IF NOT EXISTS search_document_idx ON TABLE ${table} FIELDS search_document;`,
    );
  }
}

/**
 * Применяет недостающие миграции последовательно (docs/plan.md §6):
 * сверяет checksums применённых, отказывает при неизвестной более новой
 * версии в БД, после 0001 создаёт/обновляет archive_meta:main.
 */
export async function applyMigrations(
  db: Surreal,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const files = await listMigrations(options.schemaDir);
  const bakaCommit = options.bakaCommit ?? gitHead();
  const surrealdbVersion = options.surrealdbVersion ?? "unknown";

  await ensureMigrationTable(db);
  const applied = await readApplied(db);

  const loaded = await Promise.all(
    files.map(async (file): Promise<LoadedMigration> => {
      // Строки JS неизменяемы: один snapshot исключает подмену файла между
      // checksum-проверкой и выполнением этого же migration payload.
      const content = await readFile(file.path, "utf8");
      return Object.freeze({ ...file, content, checksum: checksum(content) });
    }),
  );
  const pending = planPendingMigrations(loaded, applied);

  const appliedNow: number[] = [];
  for (const migration of pending) {
    await db.query(migration.content);
    if (migration.version === 7) {
      await ensureEmbeddingReferenceIndexes(db);
    }
    await db.query(
      `CREATE schema_migration SET
        version = $version,
        name = $name,
        checksum = $checksum,
        applied_at = $appliedAt,
        baka_commit = $bakaCommit,
        surrealdb_version = $surrealdbVersion`,
      {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        appliedAt: new Date(),
        bakaCommit,
        surrealdbVersion,
      },
    );
    appliedNow.push(migration.version);
  }

  const version = Math.max(0, ...applied.map((r) => r.version), ...appliedNow);

  if (options.sentinel && version >= 1) {
    await upsertArchiveMeta(db, options.sentinel, version, bakaCommit);
  }

  if (version >= 7) {
    await ensureEmbeddingReferenceIndexes(db);
  }

  return { applied: appliedNow, version };
}
