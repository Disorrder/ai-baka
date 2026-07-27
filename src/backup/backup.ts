/**
 * Logical backup (docs/plan.md §16.1): HTTP /export боевой базы в
 * `backups/surreal/<timestamp>__schema-<v>__surreal-<ver>.surql.zst` +
 * manifest JSON в `backups/manifests/` (createdAt, версии, bakaCommit,
 * recordCounts по таблицам, rawManifestSha256, exportSha256 сжатого
 * артефакта).
 *
 * Гарантии записи:
 * - тело /export стримится на диск (НЕ arrayBuffer в память): большой
 *   export не должен целиком занимать RAM и создавать риск OOM
 *   (симметрично потоковому /import через Bun.file в restore-test);
 * - publication никогда не перезаписывает destination: atomic rename-no-replace
 *   используется где поддержан, ExFAT fallback — O_EXCL + bounded copy;
 *   manifest публикуется последним как commit marker, поэтом crash-visible
 *   partial/export-only файл не матчится latestExportPath;
 * - recordCounts и rawManifestSha256 собираются в одной точке,
 *   непосредственно примыкающей к export'у, при открытом SDK-соединении
 *   (то же lock-окно, что берёт CLI). Оставшееся допущение: HTTP /export
 *   и SELECT count() — не одна транзакция, SurrealDB не даёт общего
 *   snapshot'а между вызовами; drift возможен только от writer'ов мимо
 *   baka — lock не пускает sync на время backup.
 *
 * Preflight/lock не выполняются внутри — это обязанность CLI-обёртки
 * (integration-тесты гоняют backup против временных баз без sentinel).
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb, serverVersion } from "../db/client.ts";
import { checkSchemaVersion, gitHead } from "../db/migrations.ts";
import { selectAll, selectOne } from "../db/repositories/helpers.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import { compressFile, detectCompression, type Compression } from "./compress.ts";
import { httpBaseUrl, httpHeaders } from "./http.ts";
import { streamHttpGetToExclusiveFile } from "./http-stream.ts";
import { buildRawManifest, hashRawManifest } from "./raw-verify.ts";
import {
  assertEmbeddingTableIdentifier,
  assertInternalTableIdentifier,
  createExclusiveTemporaryFile,
  fsyncRegularFile,
  publishPreparedFileNoClobber,
  writePrivateFileAtomicNoClobber,
} from "./safety.ts";

/** Таблицы схемы 0001–0004. */
const SCHEMA_4_CORE_TABLES = [
  "archive_meta",
  "host",
  "os_account",
  "vendor",
  "harness",
  "harness_installation",
  "model",
  "workspace",
  "workspace_location",
  "source_root",
  "sync_run",
  "source_scan",
  "source_location",
  "source_revision",
  "ingest_error",
  "dialogue",
  "dialogue_revision",
  "message",
  "chunk",
  "search_document",
  "embedding_space",
  "embedding_job",
  "legacy_identity_map",
  "migration_meta",
  "schema_migration",
] as const;

/** Новые durable-таблицы, введённые схемой 0005. */
export const SCHEMA_5_CORE_TABLES = [
  "migration_row_commit",
  "migration_quarantine",
] as const;

/** Все core-таблицы текущей схемы; динамические search_embedding_* добавляются из БД. */
export const CORE_TABLES = [...SCHEMA_4_CORE_TABLES, ...SCHEMA_5_CORE_TABLES] as const;

export type SupportedBackupSchemaVersion = 4 | 5;

/**
 * Backup/restore intentionally support only the two on-disk schemas that can
 * occur around migration 0005. Guessing a table set for any other version
 * could publish a manifest that silently omits durable data.
 */
export function coreTablesForSchemaVersion(schemaVersion: number): readonly string[] {
  if (schemaVersion === 4) return SCHEMA_4_CORE_TABLES;
  if (schemaVersion === 5) return CORE_TABLES;
  throw new Error(`backup: неподдерживаемая версия схемы ${schemaVersion}; ожидается 4 или 5`);
}

export interface BackupManifest {
  createdAt: string;
  surrealdbVersion: string;
  schemaVersion: number;
  bakaCommit: string;
  namespace: string;
  database: string;
  recordCounts: Record<string, number>;
  /**
   * SHA-256 канонического содержимого raw manifest'а (§16.1/§16.2).
   * Опционально: manifest'ы, записанные до введения поля, его не имеют.
   */
  rawManifestSha256?: string;
  exportFile: string;
  compression: Compression;
  exportBytes: number;
  exportSha256: string;
}

export interface BackupResult {
  exportPath: string;
  manifestPath: string;
  manifest: BackupManifest;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Strict untrusted manifest parser; table ownership is checked against DB later. */
export function parseBackupManifest(value: unknown, source = "backup manifest"): BackupManifest {
  const raw = objectRecord(value);
  const countsRaw = objectRecord(raw?.recordCounts);
  if (!raw || !countsRaw) throw new Error(`${source}: recordCounts отсутствует/не object`);
  const recordCounts: Record<string, number> = {};
  for (const [table, count] of Object.entries(countsRaw)) {
    assertInternalTableIdentifier(table, `${source} recordCounts table`);
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`${source}: recordCounts.${table} должен быть целым числом >= 0`);
    }
    recordCounts[table] = count as number;
  }
  const exportFile = raw.exportFile;
  const compression = raw.compression;
  if (
    typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) ||
    typeof raw.surrealdbVersion !== "string" ||
    !Number.isSafeInteger(raw.schemaVersion) || (raw.schemaVersion as number) < 0 ||
    typeof raw.bakaCommit !== "string" ||
    typeof raw.namespace !== "string" || raw.namespace.length === 0 ||
    typeof raw.database !== "string" || raw.database.length === 0 ||
    typeof exportFile !== "string" || path.basename(exportFile) !== exportFile ||
    (compression !== "zstd" && compression !== "gzip") ||
    !Number.isSafeInteger(raw.exportBytes) || (raw.exportBytes as number) < 0 ||
    typeof raw.exportSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.exportSha256) ||
    (raw.rawManifestSha256 !== undefined &&
      (typeof raw.rawManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.rawManifestSha256)))
  ) {
    throw new Error(`${source}: поля неполны или невалидны`);
  }
  // Never infer a table contract for a schema this binary does not know.
  coreTablesForSchemaVersion(raw.schemaVersion as number);
  const expectedSuffix = compression === "zstd" ? ".surql.zst" : ".surql.gz";
  if (!exportFile.endsWith(expectedSuffix)) {
    throw new Error(`${source}: exportFile не соответствует compression=${compression}`);
  }
  return {
    createdAt: raw.createdAt,
    surrealdbVersion: raw.surrealdbVersion,
    schemaVersion: raw.schemaVersion as number,
    bakaCommit: raw.bakaCommit,
    namespace: raw.namespace,
    database: raw.database,
    recordCounts,
    ...(raw.rawManifestSha256 !== undefined
      ? { rawManifestSha256: raw.rawManifestSha256 as string }
      : {}),
    exportFile,
    compression,
    exportBytes: raw.exportBytes as number,
    exportSha256: raw.exportSha256,
  };
}

/** Метка вида 2026-07-24T120000Z (план §16.1). */
export function backupTimestamp(date: Date = new Date()): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

export function exportBaseName(
  timestamp: string,
  schemaVersion: number,
  surrealVersion: string,
): string {
  // /version возвращает "surrealdb-3.2.3+20260721.40522d1"; в имя — semver (§16.1).
  const version = /\d+\.\d+\.\d+/.exec(surrealVersion)?.[0] ?? surrealVersion;
  return `${timestamp}__schema-${schemaVersion}__surreal-${version}`;
}

export function exportFileName(base: string, compression: Compression): string {
  return `${base}.surql.${compression === "zstd" ? "zst" : "gz"}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function availableBackupBase(
  preferred: string,
  compression: Compression,
  surrealDir: string,
  manifestsDir: string,
): Promise<string> {
  const occupied = async (base: string) =>
    (await pathExists(path.join(surrealDir, exportFileName(base, compression)))) ||
    (await pathExists(path.join(manifestsDir, `${base}.json`)));
  if (!(await occupied(preferred))) return preferred;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${preferred}__run-${randomUUID().slice(0, 8)}`;
    if (!(await occupied(candidate))) return candidate;
  }
  throw new Error(`не удалось выбрать свободное no-clobber имя backup для ${preferred}`);
}

export interface EmbeddingTableOwner {
  id: unknown;
  physical_table: string;
}

/**
 * Physical tables are executable identifiers, so ownership in
 * embedding_space is necessary but not sufficient: names must also match the
 * strict internal search_embedding_* grammar and be uniquely owned.
 */
export async function ownedEmbeddingTables(db: Surreal): Promise<Set<string>> {
  const rows = await selectAll<EmbeddingTableOwner>(
    db,
    "SELECT id, physical_table FROM embedding_space ORDER BY id",
  );
  const owners = new Map<string, string>();
  for (const row of rows) {
    const table = assertEmbeddingTableIdentifier(
      row.physical_table,
      `embedding_space ${String(row.id)} physical_table`,
    );
    const previous = owners.get(table);
    if (previous) {
      throw new Error(
        `embedding table ${table} принадлежит нескольким spaces: ${previous}, ${String(row.id)}`,
      );
    }
    owners.set(table, String(row.id));
  }
  return new Set(owners.keys());
}

/** Validate manifest-controlled count keys before any SurrealQL interpolation. */
export function validateRecordCountTables(
  counts: Record<string, number>,
  embeddingTables: ReadonlySet<string>,
  schemaVersion: number,
): string[] {
  const core = new Set(coreTablesForSchemaVersion(schemaVersion));
  const expected = new Set(core);
  for (const table of embeddingTables) {
    expected.add(assertEmbeddingTableIdentifier(table, "owned embedding table"));
  }
  const tables = Object.keys(counts).sort();
  for (const table of tables) {
    assertInternalTableIdentifier(table, "recordCounts table");
    if (!expected.has(table)) {
      throw new Error(`recordCounts содержит неизвестную/не принадлежащую space таблицу: ${table}`);
    }
    const count = counts[table];
    if (!Number.isSafeInteger(count) || count! < 0) {
      throw new Error(`recordCounts.${table} должен быть целым числом >= 0`);
    }
  }
  const missing = [...expected].filter((table) => !Object.hasOwn(counts, table)).sort();
  if (missing.length > 0) {
    throw new Error(`recordCounts не содержит обязательные таблицы схемы ${schemaVersion}: ${missing.join(", ")}`);
  }
  return tables;
}

/** Число записей по всем таблицам (core + физические embedding-таблицы). */
export async function recordCounts(
  db: Surreal,
  schemaVersion: number,
): Promise<Record<string, number>> {
  const embeddingTables = await ownedEmbeddingTables(db);
  const tables = [...coreTablesForSchemaVersion(schemaVersion), ...embeddingTables].map((table) =>
    assertInternalTableIdentifier(table)
  );
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // Имена таблиц — константы схемы и physical_table из embedding_space,
    // пользовательский ввод сюда не попадает.
    const row = await selectOne<{ n: number }>(
      db,
      `SELECT count() AS n FROM ${table} GROUP ALL`,
    );
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

/** Путь manifest'а, соответствующего export-файлу в backups/surreal/. */
export function manifestPathForExport(exportPath: string): string {
  const base = path
    .basename(exportPath)
    .replace(/\.surql\.(zst|gz)$/, "");
  return path.join(path.dirname(path.dirname(exportPath)), "manifests", `${base}.json`);
}

async function isCommittedBackupExport(exportPath: string): Promise<boolean> {
  try {
    const exportInfo = await lstat(exportPath);
    if (!exportInfo.isFile() || exportInfo.isSymbolicLink()) return false;
    const manifestPath = manifestPathForExport(exportPath);
    const manifestInfo = await lstat(manifestPath);
    // Manifests are small commit markers; bound untrusted discovery reads.
    if (
      !manifestInfo.isFile() || manifestInfo.isSymbolicLink() ||
      manifestInfo.size <= 0 || manifestInfo.size > 1024 * 1024
    ) return false;
    const manifest = parseBackupManifest(
      JSON.parse(await readFile(manifestPath, "utf8")),
      manifestPath,
    );
    const exportFile = path.basename(exportPath);
    const schemaFromName = /__schema-(\d+)__surreal-/u.exec(exportFile)?.[1];
    return manifest.exportFile === exportFile &&
      schemaFromName !== undefined && Number(schemaFromName) === manifest.schemaVersion &&
      exportInfo.size === manifest.exportBytes;
  } catch {
    return false;
  }
}

/**
 * Последний committed backup по имени. Export без строгого
 * matching manifest'а — включая crash-residue fallback-copy — не виден.
 */
export async function latestExportPath(archiveRoot: string): Promise<string> {
  const dir = path.join(archiveRoot, "backups", "surreal");
  const files = (await readdir(dir))
    .filter((file) => /\.surql\.(zst|gz)$/u.test(file))
    .sort()
    .reverse();
  for (const file of files) {
    const exportPath = path.join(dir, file);
    if (await isCommittedBackupExport(exportPath)) return exportPath;
  }
  throw new Error(`в ${dir} нет committed export+manifest backup — сначала baka backup`);
}

export async function runLogicalBackup(cfg: AppConfig): Promise<BackupResult> {
  const surrealDir = path.join(cfg.archiveRoot, "backups", "surreal");
  const manifestsDir = path.join(cfg.archiveRoot, "backups", "manifests");
  await mkdir(surrealDir, { recursive: true });
  await mkdir(manifestsDir, { recursive: true });

  const surrealVersion = (await serverVersion(cfg)) ?? "unknown";
  const compression = await detectCompression();

  const db = await connectDb(cfg);
  let schemaVersion: number;
  let base: string;
  let counts: Record<string, number>;
  let rawHash: string;
  let rawTmp: string | undefined;
  try {
    schemaVersion = await checkSchemaVersion(db);
    // Fail before /export when the schema/table contract is unknown.
    coreTablesForSchemaVersion(schemaVersion);
    base = await availableBackupBase(
      exportBaseName(backupTimestamp(), schemaVersion, surrealVersion),
      compression,
      surrealDir,
      manifestsDir,
    );
    const fileName = exportFileName(base, compression);
    // Суффикс .part: tmp-файлы не матчатся latestExportPath (`.surql.zst|gz`).
    rawTmp = path.join(surrealDir, `.${base}.surql.${randomUUID()}.part`);

    // Node's header-first HTTP transport starts writing as soon as /export
    // emits body bytes. Bun fetch() can buffer a multi-gigabyte response before
    // resolving, which deadlocks the server once transport buffers fill.
    await streamHttpGetToExclusiveFile({
      url: `${httpBaseUrl(cfg)}/export`,
      headers: httpHeaders(cfg, cfg.surrealNamespace, cfg.surrealDatabase),
      targetPath: rawTmp,
      operation: "export",
    });
    // Durability stays at the artifact layer rather than the HTTP helper.
    await fsyncRegularFile(rawTmp);

    // Единая точка, непосредственно примыкающая к export'у (допущение —
    // в заголовке файла): counts и raw manifest из одного состояния БД.
    counts = await recordCounts(db, schemaVersion);
    rawHash = hashRawManifest(await buildRawManifest(db));
  } catch (error) {
    if (rawTmp) await rm(rawTmp, { force: true }).catch(() => {});
    throw error;
  } finally {
    await db.close();
  }

  const fileName = exportFileName(base, compression);
  const exportPath = path.join(surrealDir, fileName);
  const compressedTemporary = await createExclusiveTemporaryFile(surrealDir, fileName);
  const compressedTmp = compressedTemporary.path;
  await compressedTemporary.close();
  let manifestPath: string | undefined;
  let manifest: BackupManifest;
  try {
    // Hash the completed temp first. The export is published before the
    // manifest: on filesystems without atomic rename-no-replace, a crash may
    // expose a partial/export-only final file, but never its commit marker.
    await compressFile(rawTmp!, compressedTmp, compression);
    const hashes = await hashFile(compressedTmp);
    manifest = {
      createdAt: new Date().toISOString(),
      surrealdbVersion: surrealVersion,
      schemaVersion,
      bakaCommit: gitHead(),
      namespace: cfg.surrealNamespace,
      database: cfg.surrealDatabase,
      recordCounts: counts,
      rawManifestSha256: rawHash,
      exportFile: fileName,
      compression,
      exportBytes: hashes.sizeBytes,
      exportSha256: hashes.sha256,
    };
    manifestPath = path.join(manifestsDir, `${base}.json`);
    await publishPreparedFileNoClobber(compressedTmp, exportPath);
    // Matching strict manifest is the final commit marker used by discovery.
    await writePrivateFileAtomicNoClobber(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } finally {
    if (rawTmp) await rm(rawTmp, { force: true });
    await rm(compressedTmp, { force: true });
  }
  return { exportPath, manifestPath: manifestPath!, manifest: manifest! };
}
