/**
 * Logical backup (docs/plan.md §16.1): HTTP /export боевой базы в
 * `backups/surreal/<timestamp>__schema-<v>__surreal-<ver>.surql.zst` +
 * manifest JSON в `backups/manifests/` (createdAt, версии, bakaCommit,
 * recordCounts по таблицам, exportSha256 сжатого артефакта).
 * Поле rawManifestSha256 из §16.1 — этап 12, здесь не заполняется.
 *
 * Preflight/lock не выполняются внутри — это обязанность CLI-обёртки
 * (integration-тесты гоняют backup против временных баз без sentinel).
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb, serverVersion } from "../db/client.ts";
import { checkSchemaVersion, gitHead } from "../db/migrations.ts";
import { selectOne } from "../db/repositories/helpers.ts";
import { listEmbeddingTables } from "../embeddings/spaces.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import { compressFile, detectCompression, type Compression } from "./compress.ts";
import { httpBaseUrl, httpHeaders } from "./http.ts";

/** Таблицы схемы 0001–0004; динамические search_embedding_* добавляются из БД. */
export const CORE_TABLES = [
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
];

export interface BackupManifest {
  createdAt: string;
  surrealdbVersion: string;
  schemaVersion: number;
  bakaCommit: string;
  namespace: string;
  database: string;
  recordCounts: Record<string, number>;
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
  return `${timestamp}__schema-${schemaVersion}__surreal-${surrealVersion}`;
}

export function exportFileName(base: string, compression: Compression): string {
  return `${base}.surql.${compression === "zstd" ? "zst" : "gz"}`;
}

/** Число записей по всем таблицам (core + физические embedding-таблицы). */
export async function recordCounts(db: Surreal): Promise<Record<string, number>> {
  const tables = [...CORE_TABLES, ...(await listEmbeddingTables(db))];
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

/** Последний по имени export в backups/surreal/ (имена хронологичны). */
export async function latestExportPath(archiveRoot: string): Promise<string> {
  const dir = path.join(archiveRoot, "backups", "surreal");
  const files = (await readdir(dir)).filter((f) => /\.surql\.(zst|gz)$/.test(f)).sort();
  const last = files[files.length - 1];
  if (!last) throw new Error(`в ${dir} нет export'ов — сначала baka backup`);
  return path.join(dir, last);
}

export async function runLogicalBackup(cfg: AppConfig): Promise<BackupResult> {
  const surrealDir = path.join(cfg.archiveRoot, "backups", "surreal");
  const manifestsDir = path.join(cfg.archiveRoot, "backups", "manifests");
  await mkdir(surrealDir, { recursive: true });
  await mkdir(manifestsDir, { recursive: true });

  const db = await connectDb(cfg);
  let schemaVersion: number;
  let counts: Record<string, number>;
  try {
    schemaVersion = await checkSchemaVersion(db);
    counts = await recordCounts(db);
  } finally {
    await db.close();
  }
  const surrealVersion = (await serverVersion(cfg)) ?? "unknown";
  const compression = await detectCompression();

  const base = exportBaseName(backupTimestamp(), schemaVersion, surrealVersion);
  const fileName = exportFileName(base, compression);
  const exportPath = path.join(surrealDir, fileName);
  const tmpPath = path.join(surrealDir, `.tmp-${process.pid}-${fileName.replace(/\.(zst|gz)$/, "")}`);

  const response = await fetch(`${httpBaseUrl(cfg)}/export`, {
    headers: httpHeaders(cfg, cfg.surrealNamespace, cfg.surrealDatabase),
  });
  if (!response.ok) {
    throw new Error(`export: HTTP ${response.status}: ${await response.text()}`);
  }
  await writeFile(tmpPath, Buffer.from(await response.arrayBuffer()));
  try {
    await compressFile(tmpPath, exportPath, compression);
  } finally {
    await rm(tmpPath, { force: true });
  }

  const hashes = await hashFile(exportPath);
  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    surrealdbVersion: surrealVersion,
    schemaVersion,
    bakaCommit: gitHead(),
    namespace: cfg.surrealNamespace,
    database: cfg.surrealDatabase,
    recordCounts: counts,
    exportFile: fileName,
    compression,
    exportBytes: hashes.sizeBytes,
    exportSha256: hashes.sha256,
  };
  const manifestPath = path.join(manifestsDir, `${base}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { exportPath, manifestPath, manifest };
}
