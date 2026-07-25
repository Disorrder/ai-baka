/**
 * Raw manifest и сверка с файловой системой (docs/plan.md §16.2).
 *
 * Manifest строится по БД (все source_revision: относительный raw-путь,
 * sha256, size, harness, revision ID), затем каждая запись проверяется
 * против реального файла: существование, размер, полный SHA-256.
 * Orphan-файлы (raw без source_revision) — предупреждение, на ok не влияют
 * (их разбор — validate/doctor).
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb } from "../db/client.ts";
import { selectAll } from "../db/repositories/helpers.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import { backupTimestamp } from "./backup.ts";

export interface RawManifestEntry {
  revisionId: string;
  /** raw_archive_path относительно archiveRoot. */
  path: string;
  sha256: string;
  sizeBytes: number;
  harness: string | null;
}

export interface RawManifest {
  createdAt: string;
  count: number;
  entries: RawManifestEntry[];
}

export interface RawVerifyReport {
  /** ok = нет missing/size/hash расхождений; orphans — только предупреждение. */
  ok: boolean;
  checked: number;
  missing: string[];
  sizeMismatch: string[];
  hashMismatch: string[];
  orphans: string[];
  manifestPath?: string;
}

/** Manifest из БД: все source_revision с raw-путём, hash, size и harness'ом. */
export async function buildRawManifest(db: Surreal): Promise<RawManifest> {
  const rows = await selectAll<{
    id: unknown;
    path: string;
    sha256: string;
    sizeBytes: number;
    harness: string | null;
  }>(
    db,
    `SELECT
       id,
       raw_archive_path AS path,
       sha256,
       size_bytes AS sizeBytes,
       source_location.source_root.harness_installation.harness.slug AS harness
     FROM source_revision
     ORDER BY raw_archive_path`,
  );
  return {
    createdAt: new Date().toISOString(),
    count: rows.length,
    entries: rows.map((row) => ({
      revisionId: String(row.id),
      path: row.path,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      harness: row.harness ?? null,
    })),
  };
}

/**
 * Канонический SHA-256 содержимого raw manifest'а (поле rawManifestSha256
 * в backup manifest'е, §16.1). Хэшируются только записи (createdAt
 * недетерминирован и исключён); порядок уже канонический — buildRawManifest
 * сортирует по raw_archive_path.
 */
export function hashRawManifest(manifest: RawManifest): string {
  const canonical = manifest.entries.map((e) => [
    e.revisionId,
    e.path,
    e.sha256,
    e.sizeBytes,
    e.harness,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function listRawFiles(rawDir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(rawDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // AppleDouble-артефакты Finder на внешнем диске — не данные архива.
    if (entry.name.startsWith("._")) continue;
    const full = path.join(rawDir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await listRawFiles(full)) out.push(nested);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Сверка manifest'а с файловой системой (чистая FS-часть, без БД). */
export async function verifyRawFiles(
  archiveRoot: string,
  manifest: RawManifest,
): Promise<RawVerifyReport> {
  const report: RawVerifyReport = {
    ok: false,
    checked: 0,
    missing: [],
    sizeMismatch: [],
    hashMismatch: [],
    orphans: [],
  };
  const referenced = new Set<string>();
  for (const entry of manifest.entries) {
    const absolute = path.join(archiveRoot, entry.path);
    referenced.add(path.normalize(absolute));
    let size: number;
    try {
      size = (await stat(absolute)).size;
    } catch {
      report.missing.push(entry.path);
      continue;
    }
    if (size !== entry.sizeBytes) {
      report.sizeMismatch.push(`${entry.path}: в БД ${entry.sizeBytes}, на диске ${size}`);
      continue;
    }
    const hashes = await hashFile(absolute);
    if (hashes.sha256 !== entry.sha256) {
      report.hashMismatch.push(
        `${entry.path}: в БД ${entry.sha256.slice(0, 12)}…, на диске ${hashes.sha256.slice(0, 12)}…`,
      );
      continue;
    }
    report.checked += 1;
  }
  for (const file of await listRawFiles(path.join(archiveRoot, "raw"))) {
    if (!referenced.has(path.normalize(file))) {
      report.orphans.push(path.relative(archiveRoot, file));
    }
  }
  report.ok =
    report.missing.length === 0 &&
    report.sizeMismatch.length === 0 &&
    report.hashMismatch.length === 0;
  return report;
}

export async function runRawVerify(
  cfg: AppConfig,
  options: { writeManifest?: boolean } = {},
): Promise<RawVerifyReport> {
  const db = await connectDb(cfg);
  let manifest: RawManifest;
  try {
    manifest = await buildRawManifest(db);
  } finally {
    await db.close();
  }
  const report = await verifyRawFiles(cfg.archiveRoot, manifest);
  if (options.writeManifest) {
    const dir = path.join(cfg.archiveRoot, "backups", "manifests");
    await mkdir(dir, { recursive: true });
    const manifestPath = path.join(dir, `raw-manifest-${backupTimestamp()}.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    report.manifestPath = manifestPath;
  }
  return report;
}
