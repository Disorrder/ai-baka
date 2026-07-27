/**
 * Raw manifest и сверка с файловой системой (docs/plan.md §16.2).
 *
 * Manifest строится по БД (source_revision с физическим raw: относительный
 * путь, sha256, size, harness, revision ID), затем каждая запись проверяется
 * против реального файла: существование, размер, полный SHA-256. Stage 10
 * revision с snapshot_kind=legacy_missing_raw и raw_archive_path=NONE
 * намеренно пропускаются; NONE у любого другого kind — ошибка инварианта.
 * Orphan-файлы (raw без source_revision) — предупреждение, на ok не влияют
 * (их разбор — validate/doctor).
 */

import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { connectDb } from "../db/client.ts";
import { selectAll } from "../db/repositories/helpers.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import { backupTimestamp } from "./backup.ts";
import {
  resolveContainedRawFile,
  writePrivateFileAtomicNoClobber,
} from "./safety.ts";

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

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} должен быть object`);
  }
  const object = value as Record<string, unknown>;
  const expected = new Set(expectedKeys);
  const actual = Object.keys(object);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !Object.hasOwn(object, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label}: exact fields mismatch; unknown=${unknown.join(",") || "—"}, ` +
        `missing=${missing.join(",") || "—"}`,
    );
  }
  return object;
}

/** Strict parser shared by status/off-device consumers of durable raw evidence. */
export function parseRawManifest(value: unknown, source = "raw manifest"): RawManifest {
  const raw = exactObject(value, ["createdAt", "count", "entries"], source);
  if (
    typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) ||
    !Number.isSafeInteger(raw.count) || (raw.count as number) < 0 ||
    !Array.isArray(raw.entries)
  ) {
    throw new Error(`${source}: fields are incomplete or invalid`);
  }
  const seenPaths = new Set<string>();
  const seenRevisions = new Set<string>();
  const entries = raw.entries.map((value, index): RawManifestEntry => {
    const entry = exactObject(
      value,
      ["revisionId", "path", "sha256", "sizeBytes", "harness"],
      `${source}.entries[${index}]`,
    );
    if (
      typeof entry.revisionId !== "string" || entry.revisionId.length === 0 ||
      typeof entry.path !== "string" || entry.path.length === 0 || path.isAbsolute(entry.path) ||
      !(entry.path === "raw" || entry.path.startsWith("raw/")) ||
      path.normalize(entry.path).replaceAll(path.sep, "/") !== entry.path ||
      typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0 ||
      !(entry.harness === null || typeof entry.harness === "string")
    ) {
      throw new Error(`${source}.entries[${index}] is invalid`);
    }
    if (seenPaths.has(entry.path) || seenRevisions.has(entry.revisionId)) {
      throw new Error(`${source}.entries[${index}] duplicates path or revision`);
    }
    seenPaths.add(entry.path);
    seenRevisions.add(entry.revisionId);
    return {
      revisionId: entry.revisionId,
      path: entry.path,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes as number,
      harness: entry.harness as string | null,
    };
  });
  if (raw.count !== entries.length) {
    throw new Error(`${source}: count does not match entries`);
  }
  return { createdAt: raw.createdAt, count: entries.length, entries };
}

/** Проекция source_revision, достаточная для построения raw manifest. */
export interface RawManifestSourceRow {
  id: unknown;
  /** NONE из SurrealDB может декодироваться как null либо undefined. */
  path?: string | null;
  sha256: string;
  sizeBytes: number;
  harness: string | null;
  snapshotKind: string;
}

export interface RawVerifyReport {
  /** ok = нет missing/size/hash расхождений; orphans — только предупреждение. */
  ok: boolean;
  checked: number;
  missing: string[];
  sizeMismatch: string[];
  hashMismatch: string[];
  unsafe: string[];
  orphans: string[];
  manifestPath?: string;
}

/**
 * Чистая нормализация строк source_revision.
 *
 * Stage 10 (§15.8) намеренно создаёт revision без raw только с
 * snapshot_kind=legacy_missing_raw — такой revision не описывает файл и в
 * raw manifest не входит. Любой другой NONE/пустой raw_archive_path означает
 * нарушение инварианта и блокирует backup/restore verification.
 */
export function rawManifestFromRows(
  rows: RawManifestSourceRow[],
  createdAt: Date = new Date(),
): RawManifest {
  const entries: RawManifestEntry[] = [];
  for (const row of rows) {
    if (typeof row.path !== "string" || row.path.length === 0) {
      if (row.snapshotKind === "legacy_missing_raw") continue;
      throw new Error(
        `source_revision ${String(row.id)}: raw_archive_path=NONE допустим только для ` +
          `snapshot_kind=legacy_missing_raw (получен ${row.snapshotKind || "NONE"})`,
      );
    }
    entries.push({
      revisionId: String(row.id),
      path: row.path,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      harness: row.harness ?? null,
    });
  }
  return {
    createdAt: createdAt.toISOString(),
    count: entries.length,
    entries,
  };
}

/** Manifest из БД: все revision с физическим raw-путём, hash, size и harness'ом. */
export async function buildRawManifest(db: Surreal): Promise<RawManifest> {
  const rows = await selectAll<RawManifestSourceRow>(
    db,
    `SELECT
       id,
       raw_archive_path AS path,
       sha256,
       size_bytes AS sizeBytes,
       source_location.source_root.harness_installation.harness.slug AS harness,
       snapshot_kind AS snapshotKind
     FROM source_revision
     ORDER BY raw_archive_path, id`,
  );
  return rawManifestFromRows(rows);
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
    unsafe: [],
    orphans: [],
  };
  const referenced = new Set<string>();
  for (const entry of manifest.entries) {
    let absolute: string;
    try {
      absolute = await resolveContainedRawFile(archiveRoot, entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        report.missing.push(entry.path);
      } else {
        report.unsafe.push(
          `${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    referenced.add(path.normalize(absolute));
    const size = (await lstat(absolute)).size;
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
  const resolvedArchiveRoot = await realpath(path.resolve(archiveRoot)).catch(() => path.resolve(archiveRoot));
  for (const file of await listRawFiles(path.join(resolvedArchiveRoot, "raw"))) {
    if (!referenced.has(path.normalize(file))) {
      report.orphans.push(path.relative(resolvedArchiveRoot, file));
    }
  }
  report.ok =
    report.missing.length === 0 &&
    report.sizeMismatch.length === 0 &&
    report.hashMismatch.length === 0 &&
    report.unsafe.length === 0;
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
    const manifestPath = path.join(
      cfg.archiveRoot,
      "backups",
      "manifests",
      `raw-manifest-${backupTimestamp()}.json`,
    );
    await writePrivateFileAtomicNoClobber(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    report.manifestPath = manifestPath;
  }
  return report;
}
