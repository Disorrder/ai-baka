/**
 * Off-device backup (docs/plan.md §16.3).
 *
 * Это файловый слой поверх уже созданного logical backup: он не обращается
 * к SurrealDB и не копирует RocksDB. В переносимый набор входят logical
 * export'ы с manifest'ами, все raw-файлы (включая orphan'ы, чтобы не терять
 * данные), выбранный raw manifest, sentinel, schema migrations и migration
 * reports.
 *
 * Публикация идемпотентна и возобновляема на уровне файлов:
 * - deterministic backupId зависит от путей/size/SHA-256 всех payload-файлов;
 * - копирование идёт в deterministic staging-каталог на целевом filesystem;
 * - уже проверенные staging-файлы переиспользуются;
 * - каждый новый файл пишется через .part + fsync + rename;
 * - полностью проверенный staging атомарно переименовывается в final bundle;
 * - существующий final bundle никогда не перезаписывается, а только
 *   проверяется и переиспользуется.
 *
 * st_dev подтверждает другой filesystem/mount и защищает от сценария, когда
 * внешний диск не смонтирован, но его каталог создался локально. Он НЕ может
 * доказать, что два filesystem находятся на разных физических устройствах —
 * это явно фиксируется в machine-readable report как operator gate.
 * Manifest/report checksums prove self-consistent integrity, not provenance:
 * joint replacement of payload + both metadata files is detectable only with
 * an external trusted copy/signature. Publication races among baka writers are
 * serialized by an O_EXCL destination lock; an actor that ignores/replaces the
 * lock is part of that same external filesystem trust boundary.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readSentinel, SENTINEL_FILE } from "../infra/sentinel.ts";
import { acquireLock } from "../infra/lock.ts";
import { SCHEMA_DIR } from "../db/migrations.ts";
import { hashFile } from "../sources/snapshot/hashing.ts";
import {
  latestExportPath,
  manifestPathForExport,
  parseBackupManifest,
  type BackupManifest,
} from "./backup.ts";
import { hashRawManifest, type RawManifest, type RawManifestEntry } from "./raw-verify.ts";
import { renameNoReplace, resolveContainedRawFile } from "./safety.ts";

export const OFF_DEVICE_FORMAT_VERSION = 1;
export const OFF_DEVICE_MANIFEST_FILE = "off-device-manifest.json";
export const OFF_DEVICE_REPORT_FILE = "off-device-report.json";

export type OffDeviceFileCategory =
  | "logical_export"
  | "logical_manifest"
  | "raw"
  | "raw_orphan"
  | "raw_manifest"
  | "sentinel"
  | "schema_migration"
  | "migration_report";

export interface OffDeviceFileEntry {
  /** Путь внутри опубликованного bundle; всегда POSIX и без `..`. */
  path: string;
  category: OffDeviceFileCategory;
  sizeBytes: number;
  sha256: string;
}

export interface OffDeviceLogicalBackup {
  exportFile: string;
  exportSha256: string;
  exportBytes: number;
  schemaVersion: number;
  surrealdbVersion: string;
  createdAt: string;
}

export interface OffDeviceManifest {
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  archiveId: string;
  archiveFormatVersion: number;
  namespace: string;
  database: string;
  deviceCheck: OffDeviceDeviceCheck;
  /** Хэш канонического списка payload-файлов; createdAt в него не входит. */
  sourceFingerprint: string;
  rawManifestSha256: string;
  logicalBackups: OffDeviceLogicalBackup[];
  files: OffDeviceFileEntry[];
  totals: {
    files: number;
    bytes: number;
    rawFiles: number;
    rawOrphans: number;
    schemaMigrations: number;
    migrationReports: number;
  };
}

export interface OffDeviceDeviceCheck {
  sourceFilesystemDevice: number;
  destinationFilesystemDevice: number;
  differentFilesystem: boolean;
  requiredDifferentFilesystem: boolean;
  operatorConfirmedPhysicalDevice: boolean;
  /** Durable operator attestation timestamp, required for publication. */
  checkedAt?: string;
}

export interface OffDeviceVerificationIssue {
  path: string;
  reason:
    | "missing"
    | "not_regular_file"
    | "size_mismatch"
    | "sha256_mismatch"
    | "invalid_metadata"
    | "unexpected";
  expected?: string | number;
  actual?: string | number;
}

export interface OffDeviceVerificationReport {
  ok: boolean;
  bundlePath: string;
  backupId?: string;
  checkedFiles: number;
  checkedBytes: number;
  issues: OffDeviceVerificationIssue[];
}

export interface VerifiedOffDeviceLogicalArtifact {
  bundlePath: string;
  archiveRoot: string;
  backupId: string;
  exportPath: string;
  manifestPath: string;
  rawManifestPath: string;
  rawManifestFile: string;
  rawManifestFileSha256: string;
  rawManifestSha256: string;
  bundleManifestSha256: string;
  integrity: "verified";
  /** Checksums prove integrity; origin authenticity still needs external trust. */
  trustRequirement: "external_bundle_provenance_required";
}

export interface OffDeviceRunReport {
  formatVersion: 1;
  backupId: string;
  status: "planned" | "completed" | "reused";
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  sourceArchiveRoot: string;
  destinationRoot: string;
  bundlePath: string;
  deviceCheck: OffDeviceDeviceCheck;
  files: {
    total: number;
    copied: number;
    reused: number;
    verified: number;
  };
  bytes: {
    total: number;
    copied: number;
    reused: number;
    verified: number;
  };
  manifestSha256?: string;
  verification?: OffDeviceVerificationReport;
}

export interface OffDeviceBackupPlan {
  archiveRoot: string;
  destinationRoot: string;
  bundlePath: string;
  stagingPath: string;
  manifest: OffDeviceManifest;
  deviceCheck: OffDeviceRunReport["deviceCheck"];
  /** Internal source mapping; exported so a CLI can render a detailed dry-run. */
  sources: ReadonlyArray<{
    sourcePath: string;
    entry: OffDeviceFileEntry;
  }>;
}

export interface OffDeviceBackupOptions {
  archiveRoot: string;
  /** Корень назначения; final bundle создаётся отдельным дочерним каталогом. */
  destination: string;
  /** Default: корень текущего checkout, вычисленный от этого module. */
  projectRoot?: string;
  /** Default: последний logical export. Можно передать несколько export'ов. */
  exportPaths?: string[];
  /** Default: последний raw-manifest-*.json в backups/manifests. */
  rawManifestPath?: string;
  /** Default: migration/reconciliation reports из archive + project reports/. */
  migrationReportPaths?: string[];
  dryRun?: boolean;
  /** Default true. false предназначен для тестов/явной диагностики. */
  requireDifferentFilesystem?: boolean;
  /** Explicit operator attestation that destination is another physical device. */
  operatorConfirmedPhysicalDevice?: boolean;
  /** Required with confirmation; CLI should persist the time the check was made. */
  physicalDeviceCheckedAt?: Date;
  /** Seam для детерминированного теста/report; на backupId не влияет. */
  now?: Date;
}

export interface OffDeviceBackupResult {
  plan: OffDeviceBackupPlan;
  report: OffDeviceRunReport;
  manifestPath?: string;
  reportPath?: string;
}

interface SourceFile {
  sourcePath: string;
  entry: OffDeviceFileEntry;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertSafeRelative(relative: string, label: string): string {
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`${label}: путь должен быть относительным: ${relative}`);
  }
  const normalized = path.posix.normalize(relative.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`${label}: путь выходит из backup bundle: ${relative}`);
  }
  return normalized;
}

async function existingAncestor(target: string): Promise<string> {
  let current = path.resolve(target);
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** Real path существующего префикса + ещё не созданный хвост. */
async function prospectiveRealPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const ancestor = await existingAncestor(absolute);
  const realAncestor = await realpath(ancestor);
  return path.resolve(realAncestor, path.relative(ancestor, absolute));
}

async function assertRegularFile(filePath: string, label: string): Promise<number> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} не найден: ${filePath}`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} должен быть обычным файлом без symlink: ${filePath}`);
  }
  return info.size;
}

function rawEntry(raw: unknown, index: number): RawManifestEntry {
  const entry = raw as Partial<RawManifestEntry>;
  if (
    typeof entry.revisionId !== "string" ||
    typeof entry.path !== "string" ||
    typeof entry.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.sha256) ||
    typeof entry.sizeBytes !== "number" ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0 ||
    !(typeof entry.harness === "string" || entry.harness === null)
  ) {
    throw new Error(`raw manifest: невалидная запись #${index}`);
  }
  const relative = assertSafeRelative(entry.path, `raw manifest #${index}`);
  if (!(relative === "raw" || relative.startsWith("raw/"))) {
    throw new Error(`raw manifest #${index}: путь должен находиться в raw/: ${entry.path}`);
  }
  return { ...entry, path: relative } as RawManifestEntry;
}

async function readRawManifest(filePath: string): Promise<RawManifest> {
  await assertRegularFile(filePath, "raw manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`raw manifest повреждён (не JSON): ${filePath}`);
  }
  const raw = parsed as Partial<RawManifest>;
  if (!Array.isArray(raw.entries) || typeof raw.count !== "number") {
    throw new Error(`raw manifest неполный: ${filePath}`);
  }
  const entries = raw.entries.map(rawEntry);
  if (raw.count !== entries.length) {
    throw new Error(`raw manifest count=${raw.count}, записей=${entries.length}: ${filePath}`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`raw manifest: дубликат path ${entry.path}`);
    seen.add(entry.path);
  }
  return {
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "unknown",
    count: entries.length,
    entries,
  };
}

async function readBackupManifest(filePath: string): Promise<BackupManifest> {
  await assertRegularFile(filePath, "logical backup manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`logical backup manifest повреждён (не JSON): ${filePath}`);
  }
  const manifest = parseBackupManifest(parsed, filePath);
  if (!manifest.rawManifestSha256) {
    throw new Error(`logical backup manifest неполный для off-device backup: ${filePath}`);
  }
  return manifest;
}

async function latestRawManifestPath(archiveRoot: string): Promise<string> {
  const dir = path.join(archiveRoot, "backups", "manifests");
  const names = (await readdir(dir))
    .filter((name) => /^raw-manifest-.*\.json$/.test(name))
    .sort();
  const latest = names.at(-1);
  if (!latest) {
    throw new Error(`в ${dir} нет raw-manifest-*.json — сначала baka raw:verify --manifest`);
  }
  return path.join(dir, latest);
}

async function recursiveFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let dirInfo;
  try {
    dirInfo = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    throw new Error(`backup source directory должен быть каталогом без symlink: ${dir}`);
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("._")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink запрещён в backup source: ${absolute}`);
    }
    if (entry.isDirectory()) files.push(...(await recursiveFiles(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function migrationReportName(name: string): boolean {
  return /^(migration|reconciliation)(?:[-_].*)?\.(json|md)$/i.test(name);
}

async function discoverMigrationReports(
  archiveRoot: string,
  projectRoot: string,
): Promise<string[]> {
  const archive = (await recursiveFiles(path.join(archiveRoot, "backups", "manifests"))).filter(
    (file) => migrationReportName(path.basename(file)),
  );
  const project = (await recursiveFiles(path.join(projectRoot, "reports"))).filter((file) =>
    migrationReportName(path.basename(file)),
  );
  return [...archive, ...project].sort();
}

function portablePath(...parts: string[]): string {
  return assertSafeRelative(parts.join("/"), "destination");
}

async function hashedSource(
  sourcePath: string,
  destinationPath: string,
  category: OffDeviceFileCategory,
): Promise<SourceFile> {
  await assertRegularFile(sourcePath, category);
  const hashes = await hashFile(sourcePath);
  return {
    sourcePath,
    entry: {
      path: assertSafeRelative(destinationPath, category),
      category,
      sizeBytes: hashes.sizeBytes,
      sha256: hashes.sha256,
    },
  };
}

async function expectedSource(
  sourcePath: string,
  destinationPath: string,
  category: OffDeviceFileCategory,
  expected: { sizeBytes: number; sha256: string },
  verifyHash: boolean,
): Promise<SourceFile> {
  const actualSize = await assertRegularFile(sourcePath, category);
  if (actualSize !== expected.sizeBytes) {
    throw new Error(
      `${category}: size не совпадает для ${sourcePath}: ожидалось ${expected.sizeBytes}, фактически ${actualSize}`,
    );
  }
  if (verifyHash) {
    const hashes = await hashFile(sourcePath);
    if (hashes.sha256 !== expected.sha256) {
      throw new Error(
        `${category}: sha256 не совпадает для ${sourcePath}: ожидалось ${expected.sha256}, фактически ${hashes.sha256}`,
      );
    }
  }
  return {
    sourcePath,
    entry: {
      path: assertSafeRelative(destinationPath, category),
      category,
      sizeBytes: expected.sizeBytes,
      sha256: expected.sha256,
    },
  };
}

function fingerprint(files: OffDeviceFileEntry[]): string {
  const canonical = files.map((file) => [
    file.path,
    file.category,
    file.sizeBytes,
    file.sha256,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function shortSafeId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 96) || "backup";
}

async function addSource(
  sources: SourceFile[],
  source: Promise<SourceFile> | SourceFile,
): Promise<void> {
  const resolved = await source;
  if (sources.some((item) => item.entry.path === resolved.entry.path)) {
    throw new Error(`дубликат destination path: ${resolved.entry.path}`);
  }
  sources.push(resolved);
}

function reportDestination(
  filePath: string,
  archiveRoot: string,
  projectRoot: string,
  index: number,
): string {
  if (isInside(archiveRoot, filePath)) {
    return portablePath("archive", path.relative(archiveRoot, filePath).replaceAll(path.sep, "/"));
  }
  const reportsRoot = path.join(projectRoot, "reports");
  if (isInside(reportsRoot, filePath)) {
    return portablePath(
      "project",
      "reports",
      path.relative(reportsRoot, filePath).replaceAll(path.sep, "/"),
    );
  }
  return portablePath(
    "migration-reports",
    "external",
    `${String(index + 1).padStart(3, "0")}__${path.basename(filePath)}`,
  );
}

/**
 * Строит полный read-only plan. При dryRun=true дополнительно хэширует
 * referenced raw/export sources, поэтому dry-run проверяет исходники, но
 * ничего не создаёт в destination.
 */
export async function planOffDeviceBackup(
  options: OffDeviceBackupOptions,
): Promise<OffDeviceBackupPlan> {
  const archiveRoot = await realpath(path.resolve(options.archiveRoot));
  const projectRoot = await realpath(path.resolve(options.projectRoot ?? path.resolve(import.meta.dir, "../..")));
  const destinationRoot = await prospectiveRealPath(options.destination);
  if (isInside(archiveRoot, destinationRoot) || isInside(destinationRoot, archiveRoot)) {
    throw new Error(
      `destination должен быть вне archive root и не быть его родителем: ${destinationRoot}`,
    );
  }

  const destinationAncestor = await existingAncestor(destinationRoot);
  const destinationAncestorInfo = await stat(destinationAncestor);
  if (!destinationAncestorInfo.isDirectory()) {
    throw new Error(`существующий префикс destination не является каталогом: ${destinationAncestor}`);
  }
  const archiveInfo = await stat(archiveRoot);
  const requireDifferentFilesystem = options.requireDifferentFilesystem ?? true;
  const differentFilesystem = archiveInfo.dev !== destinationAncestorInfo.dev;
  if (requireDifferentFilesystem && !differentFilesystem) {
    throw new Error(
      `destination находится на том же filesystem (st_dev=${archiveInfo.dev}); ` +
        `off-device backup требует смонтированное другое устройство`,
    );
  }

  const sentinel = await readSentinel(archiveRoot);
  const exportPaths = options.exportPaths?.length
    ? [...new Set(options.exportPaths.map((file) => path.resolve(file)))].sort()
    : [await latestExportPath(archiveRoot)];
  const surrealDir = path.join(archiveRoot, "backups", "surreal");
  const manifestsDir = path.join(archiveRoot, "backups", "manifests");
  const rawManifestPath = await realpath(
    path.resolve(options.rawManifestPath ?? (await latestRawManifestPath(archiveRoot))),
  );
  if (!isInside(manifestsDir, rawManifestPath)) {
    throw new Error(`raw manifest должен находиться в ${manifestsDir}: ${rawManifestPath}`);
  }
  const rawManifest = await readRawManifest(rawManifestPath);
  const rawManifestSha256 = hashRawManifest(rawManifest);

  const sources: SourceFile[] = [];
  const logicalBackups: OffDeviceLogicalBackup[] = [];
  let primaryExportBase = "logical";
  for (const [index, exportPathInput] of exportPaths.entries()) {
    const exportPath = await realpath(path.resolve(exportPathInput));
    if (!isInside(surrealDir, exportPath)) {
      throw new Error(`logical export должен находиться в ${surrealDir}: ${exportPath}`);
    }
    if (!/\.surql\.(zst|gz)$/.test(path.basename(exportPath))) {
      throw new Error(`неподдерживаемое имя logical export: ${exportPath}`);
    }
    const backupManifestPath = manifestPathForExport(exportPath);
    if (!isInside(manifestsDir, backupManifestPath)) {
      throw new Error(`logical manifest должен находиться в ${manifestsDir}: ${backupManifestPath}`);
    }
    const backupManifest = await readBackupManifest(backupManifestPath);
    if (backupManifest.exportFile !== path.basename(exportPath)) {
      throw new Error(
        `logical manifest ожидает ${backupManifest.exportFile}, выбран ${path.basename(exportPath)}`,
      );
    }
    if (
      backupManifest.namespace !== sentinel.expectedNamespace ||
      backupManifest.database !== sentinel.expectedDatabase
    ) {
      throw new Error(
        `logical backup ${backupManifest.exportFile}: ns/db не совпадают с sentinel ` +
          `(${backupManifest.namespace}/${backupManifest.database} vs ` +
          `${sentinel.expectedNamespace}/${sentinel.expectedDatabase})`,
      );
    }
    await addSource(
      sources,
      expectedSource(
        exportPath,
        portablePath("archive", "backups", "surreal", path.basename(exportPath)),
        "logical_export",
        { sizeBytes: backupManifest.exportBytes, sha256: backupManifest.exportSha256 },
        options.dryRun ?? false,
      ),
    );
    await addSource(
      sources,
      hashedSource(
        backupManifestPath,
        portablePath("archive", "backups", "manifests", path.basename(backupManifestPath)),
        "logical_manifest",
      ),
    );
    logicalBackups.push({
      exportFile: backupManifest.exportFile,
      exportSha256: backupManifest.exportSha256,
      exportBytes: backupManifest.exportBytes,
      schemaVersion: backupManifest.schemaVersion,
      surrealdbVersion: backupManifest.surrealdbVersion,
      createdAt: backupManifest.createdAt,
    });
    if (index === exportPaths.length - 1) {
      primaryExportBase = path.basename(exportPath).replace(/\.surql\.(zst|gz)$/, "");
      if (backupManifest.rawManifestSha256 !== rawManifestSha256) {
        throw new Error(
          `raw manifest ${path.basename(rawManifestPath)} не соответствует последнему logical backup ` +
            `${backupManifest.exportFile}: ${rawManifestSha256} != ${backupManifest.rawManifestSha256}`,
        );
      }
    }
  }

  await addSource(
    sources,
    hashedSource(
      rawManifestPath,
      portablePath("archive", "backups", "manifests", path.basename(rawManifestPath)),
      "raw_manifest",
    ),
  );
  await addSource(
    sources,
    hashedSource(
      path.join(archiveRoot, SENTINEL_FILE),
      portablePath("archive", SENTINEL_FILE),
      "sentinel",
    ),
  );

  const referencedRaw = new Set<string>();
  for (const entry of rawManifest.entries) {
    const relative = assertSafeRelative(entry.path, "raw manifest");
    // The same boundary as raw:verify: reject parent/leaf symlinks,
    // non-regular files and realpath escapes before copying any payload.
    const sourcePath = await resolveContainedRawFile(archiveRoot, relative);
    referencedRaw.add(sourcePath);
    await addSource(
      sources,
      expectedSource(
        sourcePath,
        portablePath("archive", relative),
        "raw",
        { sizeBytes: entry.sizeBytes, sha256: entry.sha256 },
        options.dryRun ?? false,
      ),
    );
  }
  // Orphan raw-файлы тоже данные: raw:verify сообщает о них как warning,
  // а off-device backup сохраняет их с отдельной категорией.
  for (const sourcePath of await recursiveFiles(path.join(archiveRoot, "raw"))) {
    if (referencedRaw.has(sourcePath)) continue;
    const relative = path.relative(archiveRoot, sourcePath).replaceAll(path.sep, "/");
    await addSource(
      sources,
      hashedSource(sourcePath, portablePath("archive", relative), "raw_orphan"),
    );
  }

  const schemaDir = options.projectRoot ? path.join(projectRoot, "schema") : SCHEMA_DIR;
  const schemaPaths = (await recursiveFiles(schemaDir)).filter((file) => file.endsWith(".surql"));
  if (schemaPaths.length === 0) throw new Error(`schema migrations не найдены: ${schemaDir}`);
  const schemaVersions = new Set(
    schemaPaths
      .map((file) => /^(\d{4})_.+\.surql$/.exec(path.basename(file)))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1])),
  );
  const maxRequiredSchema = Math.max(...logicalBackups.map((backup) => backup.schemaVersion));
  for (let version = 1; version <= maxRequiredSchema; version += 1) {
    if (!schemaVersions.has(version)) {
      throw new Error(`для logical backup schema v${maxRequiredSchema} отсутствует migration ${version}`);
    }
  }
  for (const schemaPath of schemaPaths.sort()) {
    await addSource(
      sources,
      hashedSource(
        schemaPath,
        portablePath("project", "schema", path.basename(schemaPath)),
        "schema_migration",
      ),
    );
  }

  const migrationReportPaths = options.migrationReportPaths?.length
    ? [
        ...new Set(
          await Promise.all(
            options.migrationReportPaths.map((file) => realpath(path.resolve(file))),
          ),
        ),
      ].sort()
    : await discoverMigrationReports(archiveRoot, projectRoot);
  if (migrationReportPaths.length === 0) {
    throw new Error(
      `migration reports не найдены; передайте migrationReportPaths или сохраните отчёт в ` +
        `${path.join(archiveRoot, "backups", "manifests")}/ либо ${path.join(projectRoot, "reports")}/`,
    );
  }
  for (const [index, reportPath] of migrationReportPaths.entries()) {
    await addSource(
      sources,
      hashedSource(
        reportPath,
        reportDestination(reportPath, archiveRoot, projectRoot, index),
        "migration_report",
      ),
    );
  }

  sources.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
  const files = sources.map((source) => source.entry);
  const sourceFingerprint = fingerprint(files);
  // Hash всегда остаётся в имени (не обрезается длинным export base): это
  // разводит staging/final для разных наборов файлов того же logical export.
  const backupId = [
    "baka",
    shortSafeId(sentinel.archiveId).slice(0, 40),
    shortSafeId(primaryExportBase).slice(0, 48),
    sourceFingerprint.slice(0, 12),
  ].join("-");
  const bundlePath = path.join(destinationRoot, backupId);
  const stagingPath = path.join(destinationRoot, `.staging-${backupId}`);
  const operatorConfirmed = options.operatorConfirmedPhysicalDevice === true;
  const checkedAt = operatorConfirmed
    ? (options.physicalDeviceCheckedAt ?? options.now ?? new Date()).toISOString()
    : undefined;
  const deviceCheck: OffDeviceDeviceCheck = {
    sourceFilesystemDevice: archiveInfo.dev,
    destinationFilesystemDevice: destinationAncestorInfo.dev,
    differentFilesystem,
    requiredDifferentFilesystem: requireDifferentFilesystem,
    operatorConfirmedPhysicalDevice: operatorConfirmed,
    ...(checkedAt ? { checkedAt } : {}),
  };
  const manifest: OffDeviceManifest = {
    formatVersion: OFF_DEVICE_FORMAT_VERSION,
    backupId,
    createdAt: (options.now ?? new Date()).toISOString(),
    archiveId: sentinel.archiveId,
    archiveFormatVersion: sentinel.formatVersion,
    namespace: sentinel.expectedNamespace,
    database: sentinel.expectedDatabase,
    deviceCheck,
    sourceFingerprint,
    rawManifestSha256,
    logicalBackups,
    files,
    totals: {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      rawFiles: files.filter((file) => file.category === "raw").length,
      rawOrphans: files.filter((file) => file.category === "raw_orphan").length,
      schemaMigrations: files.filter((file) => file.category === "schema_migration").length,
      migrationReports: files.filter((file) => file.category === "migration_report").length,
    },
  };
  return {
    archiveRoot,
    destinationRoot,
    bundlePath,
    stagingPath,
    manifest,
    deviceCheck,
    sources,
  };
}

async function maybeLstat(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fsyncPath(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** mkdir без следования symlink-компонентам внутри staging. */
async function ensureSafeDirectory(root: string, relativeDir: string): Promise<void> {
  const safe = relativeDir === "." ? "" : assertSafeRelative(relativeDir, "staging directory");
  let current = root;
  for (const component of safe ? safe.split("/") : []) {
    current = path.join(current, component);
    const info = await maybeLstat(current);
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`небезопасный staging path (не каталог или symlink): ${current}`);
      }
    } else {
      await mkdir(current);
    }
  }
}

async function writeStagingJsonExclusive(filePath: string, value: unknown): Promise<void> {
  // Metadata lives only in the unpublished staging directory. O_EXCL gives
  // race-free no-clobber; the directory rename publishes the complete file
  // atomically with the rest of the bundle.
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await fsyncPath(path.dirname(filePath));
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function removeSafeStagingMetadata(filePath: string): Promise<void> {
  const info = await maybeLstat(filePath);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`staging metadata небезопасны и не будут удалены: ${filePath}`);
  }
  await rm(filePath);
}

async function verifyOneFile(
  filePath: string,
  entry: OffDeviceFileEntry,
): Promise<{ ok: boolean; issue?: OffDeviceVerificationIssue }> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, issue: { path: entry.path, reason: "missing" } };
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { ok: false, issue: { path: entry.path, reason: "not_regular_file" } };
  }
  if (info.size !== entry.sizeBytes) {
    return {
      ok: false,
      issue: {
        path: entry.path,
        reason: "size_mismatch",
        expected: entry.sizeBytes,
        actual: info.size,
      },
    };
  }
  const hashes = await hashFile(filePath);
  if (hashes.sha256 !== entry.sha256) {
    return {
      ok: false,
      issue: {
        path: entry.path,
        reason: "sha256_mismatch",
        expected: entry.sha256,
        actual: hashes.sha256,
      },
    };
  }
  return { ok: true };
}

/**
 * Streaming copy whose destination is created with O_EXCL. Unlike hashFile's
 * general copy seam, this never reopens/truncates a path after the exclusive
 * create, so an attacker cannot pre-place a symlink at the reserved part name.
 */
async function copyExclusiveAndHash(
  sourcePath: string,
  destinationPath: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  const sha = createHash("sha256");
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sha.update(chunk);
      sizeBytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(sourcePath),
    meter,
    createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
  );
  await fsyncPath(destinationPath);
  return { sizeBytes, sha256: sha.digest("hex") };
}

async function removeOwnedStagingPart(part: string): Promise<void> {
  const info = await maybeLstat(part);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`staging part небезопасен и не будет удалён: ${part}`);
  }
  await rm(part);
  await fsyncPath(path.dirname(part));
}

function parseOffDeviceManifest(raw: unknown, filePath: string): OffDeviceManifest {
  const manifest = raw as Partial<OffDeviceManifest>;
  if (
    manifest.formatVersion !== OFF_DEVICE_FORMAT_VERSION ||
    typeof manifest.backupId !== "string" ||
    typeof manifest.sourceFingerprint !== "string" ||
    typeof manifest.rawManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.rawManifestSha256) ||
    !Array.isArray(manifest.logicalBackups) ||
    manifest.logicalBackups.length === 0 ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`off-device manifest неполный/неподдерживаемый: ${filePath}`);
  }
  const files = manifest.files as OffDeviceFileEntry[];
  const logicalBackups = manifest.logicalBackups as OffDeviceLogicalBackup[];
  const device = manifest.deviceCheck;
  if (
    !device || !Number.isSafeInteger(device.sourceFilesystemDevice) ||
    !Number.isSafeInteger(device.destinationFilesystemDevice) ||
    typeof device.requiredDifferentFilesystem !== "boolean" ||
    device.differentFilesystem !==
      (device.sourceFilesystemDevice !== device.destinationFilesystemDevice) ||
    (device.requiredDifferentFilesystem === true && device.differentFilesystem !== true) ||
    device.operatorConfirmedPhysicalDevice !== true ||
    typeof device.checkedAt !== "string" || !Number.isFinite(Date.parse(device.checkedAt))
  ) {
    throw new Error(`off-device manifest: physical-device attestation отсутствует/невалидна: ${filePath}`);
  }
  const categories = new Set<OffDeviceFileCategory>([
    "logical_export",
    "logical_manifest",
    "raw",
    "raw_orphan",
    "raw_manifest",
    "sentinel",
    "schema_migration",
    "migration_report",
  ]);
  const seen = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (
      typeof file.path !== "string" ||
      !categories.has(file.category) ||
      typeof file.sizeBytes !== "number" ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error(`off-device manifest: невалидный file #${index}`);
    }
    const safe = assertSafeRelative(file.path, `off-device manifest file #${index}`);
    if (safe !== file.path || seen.has(safe)) {
      throw new Error(`off-device manifest: небезопасный/дублированный path ${file.path}`);
    }
    seen.add(safe);
  }
  const logicalSeen = new Set<string>();
  for (const [index, backup] of logicalBackups.entries()) {
    if (
      typeof backup.exportFile !== "string" ||
      path.basename(backup.exportFile) !== backup.exportFile ||
      !/\.surql\.(zst|gz)$/.test(backup.exportFile) ||
      typeof backup.exportSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(backup.exportSha256) ||
      !Number.isSafeInteger(backup.exportBytes) || backup.exportBytes < 0 ||
      !Number.isSafeInteger(backup.schemaVersion) || backup.schemaVersion < 1 ||
      typeof backup.surrealdbVersion !== "string" ||
      typeof backup.createdAt !== "string" || !Number.isFinite(Date.parse(backup.createdAt)) ||
      logicalSeen.has(backup.exportFile)
    ) {
      throw new Error(`off-device manifest: невалидный logical backup #${index}`);
    }
    logicalSeen.add(backup.exportFile);
    const exportRelative = portablePath(
      "archive",
      "backups",
      "surreal",
      backup.exportFile,
    );
    const manifestRelative = portablePath(
      "archive",
      "backups",
      "manifests",
      path.basename(manifestPathForExport(backup.exportFile)),
    );
    const exportEntry = files.find((file) =>
      file.path === exportRelative && file.category === "logical_export"
    );
    if (!exportEntry || exportEntry.sizeBytes !== backup.exportBytes ||
        exportEntry.sha256 !== backup.exportSha256 ||
        !files.some((file) =>
          file.path === manifestRelative && file.category === "logical_manifest"
        )) {
      throw new Error(`off-device manifest: logical backup #${index} не связан с payload`);
    }
  }
  if (files.filter((file) => file.category === "logical_export").length !== logicalBackups.length ||
      files.filter((file) => file.category === "logical_manifest").length !== logicalBackups.length ||
      files.filter((file) => file.category === "raw_manifest").length !== 1) {
    throw new Error("off-device manifest: logical/raw manifest cardinality невалидна");
  }
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  if (fingerprint(sorted) !== manifest.sourceFingerprint) {
    throw new Error(`off-device manifest sourceFingerprint не совпадает: ${filePath}`);
  }
  const totals = manifest.totals;
  if (
    !totals ||
    totals.files !== files.length ||
    totals.bytes !== files.reduce((sum, file) => sum + file.sizeBytes, 0) ||
    totals.rawFiles !== files.filter((file) => file.category === "raw").length ||
    totals.rawOrphans !== files.filter((file) => file.category === "raw_orphan").length ||
    totals.schemaMigrations !==
      files.filter((file) => file.category === "schema_migration").length ||
    totals.migrationReports !==
      files.filter((file) => file.category === "migration_report").length
  ) {
    throw new Error(`off-device manifest totals не совпадают со списком файлов: ${filePath}`);
  }
  return manifest as OffDeviceManifest;
}

async function unsafeParent(bundlePath: string, relative: string): Promise<boolean> {
  let current = bundlePath;
  const components = path.posix.dirname(relative).split("/").filter((part) => part !== ".");
  for (const component of components) {
    current = path.join(current, component);
    const info = await maybeLstat(current);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return true;
  }
  return false;
}

/** Независимая checksum/size-проверка опубликованного (или staging) bundle. */
export async function verifyOffDeviceBackup(
  bundlePathInput: string,
  options: { requireReport?: boolean } = {},
): Promise<OffDeviceVerificationReport> {
  const bundlePath = path.resolve(bundlePathInput);
  const bundleInfo = await lstat(bundlePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!bundleInfo) {
    return {
      ok: false,
      bundlePath,
      checkedFiles: 0,
      checkedBytes: 0,
      issues: [{ path: ".", reason: "missing" }],
    };
  }
  if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink()) {
    return {
      ok: false,
      bundlePath,
      checkedFiles: 0,
      checkedBytes: 0,
      issues: [{ path: ".", reason: "not_regular_file" }],
    };
  }
  const manifestPath = path.join(bundlePath, OFF_DEVICE_MANIFEST_FILE);
  let parsed: unknown;
  try {
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      return {
        ok: false,
        bundlePath,
        checkedFiles: 0,
        checkedBytes: 0,
        issues: [{ path: OFF_DEVICE_MANIFEST_FILE, reason: "not_regular_file" }],
      };
    }
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        bundlePath,
        checkedFiles: 0,
        checkedBytes: 0,
        issues: [{ path: OFF_DEVICE_MANIFEST_FILE, reason: "missing" }],
      };
    }
    throw new Error(`off-device manifest повреждён (не JSON): ${manifestPath}`);
  }
  const manifest = parseOffDeviceManifest(parsed, manifestPath);
  const issues: OffDeviceVerificationIssue[] = [];
  if (bundleInfo.dev !== manifest.deviceCheck.destinationFilesystemDevice) {
    issues.push({
      path: OFF_DEVICE_MANIFEST_FILE,
      reason: "invalid_metadata",
      expected: manifest.deviceCheck.destinationFilesystemDevice,
      actual: bundleInfo.dev,
    });
  }
  const rawManifestEntry = manifest.files.find((entry) => entry.category === "raw_manifest")!;
  const rawManifestPath = path.resolve(bundlePath, rawManifestEntry.path);
  try {
    if (await unsafeParent(bundlePath, rawManifestEntry.path)) {
      throw new Error("unsafe parent");
    }
    const rawManifest = await readRawManifest(rawManifestPath);
    const actualRawManifestSha256 = hashRawManifest(rawManifest);
    if (actualRawManifestSha256 !== manifest.rawManifestSha256) {
      issues.push({
        path: rawManifestEntry.path,
        reason: "invalid_metadata",
        expected: manifest.rawManifestSha256,
        actual: actualRawManifestSha256,
      });
    }
    const rawPayloads = manifest.files.filter((entry) => entry.category === "raw");
    const rawPayloadByPath = new Map(rawPayloads.map((entry) => [entry.path, entry]));
    for (const raw of rawManifest.entries) {
      const payload = rawPayloadByPath.get(portablePath("archive", raw.path));
      if (!payload || payload.sizeBytes !== raw.sizeBytes || payload.sha256 !== raw.sha256) {
        throw new Error("raw manifest entry is not bound to payload");
      }
    }
    if (rawPayloads.length !== rawManifest.entries.length) {
      throw new Error("raw payload cardinality mismatch");
    }
  } catch {
    issues.push({ path: rawManifestEntry.path, reason: "invalid_metadata" });
  }
  const expectedPaths = new Set(manifest.files.map((entry) => entry.path));
  expectedPaths.add(OFF_DEVICE_MANIFEST_FILE);
  if (options.requireReport ?? true) expectedPaths.add(OFF_DEVICE_REPORT_FILE);
  let checkedFiles = 0;
  let checkedBytes = 0;
  for (const entry of manifest.files) {
    const filePath = path.resolve(bundlePath, entry.path);
    if (!isInside(bundlePath, filePath)) {
      throw new Error(`off-device manifest path выходит из bundle: ${entry.path}`);
    }
    const result = (await unsafeParent(bundlePath, entry.path))
      ? {
          ok: false,
          issue: {
            path: entry.path,
            reason: "not_regular_file" as const,
          },
        }
      : await verifyOneFile(filePath, entry);
    if (result.ok) {
      checkedFiles += 1;
      checkedBytes += entry.sizeBytes;
    } else if (result.issue) {
      issues.push(result.issue);
    }
  }
  if (options.requireReport ?? true) {
    const reportPath = path.join(bundlePath, OFF_DEVICE_REPORT_FILE);
    let reportRaw: string;
    try {
      const reportInfo = await lstat(reportPath);
      if (!reportInfo.isFile() || reportInfo.isSymbolicLink()) {
        issues.push({ path: OFF_DEVICE_REPORT_FILE, reason: "not_regular_file" });
        reportRaw = "";
      } else {
        reportRaw = await readFile(reportPath, "utf8");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      issues.push({ path: OFF_DEVICE_REPORT_FILE, reason: "missing" });
      reportRaw = "";
    }
    if (reportRaw) {
      try {
        const report = JSON.parse(reportRaw) as Partial<OffDeviceRunReport>;
        const manifestHashes = await hashFile(manifestPath);
        if (
          report.formatVersion !== OFF_DEVICE_FORMAT_VERSION ||
          report.backupId !== manifest.backupId ||
          report.manifestSha256 !== manifestHashes.sha256 ||
          report.status !== "completed" ||
          JSON.stringify(report.deviceCheck) !== JSON.stringify(manifest.deviceCheck)
        ) {
          issues.push({
            path: OFF_DEVICE_REPORT_FILE,
            reason: "invalid_metadata",
            expected: `${manifest.backupId}/${manifestHashes.sha256}/completed`,
            actual: `${report.backupId ?? "?"}/${report.manifestSha256 ?? "?"}/${report.status ?? "?"}`,
          });
        }
      } catch {
        issues.push({ path: OFF_DEVICE_REPORT_FILE, reason: "invalid_metadata" });
      }
    }
  }
  for (const actualPath of await recursiveFiles(bundlePath)) {
    const relative = path.relative(bundlePath, actualPath).replaceAll(path.sep, "/");
    if (!expectedPaths.has(relative)) {
      issues.push({ path: relative, reason: "unexpected" });
    }
  }
  return {
    ok: issues.length === 0,
    bundlePath,
    backupId: manifest.backupId,
    checkedFiles,
    checkedBytes,
    issues,
  };
}

/**
 * Resolve one logical backup only after authenticating the complete bundle.
 * This is the status/restore evidence seam: caller-provided names remain
 * basenames, and neither a symlinked bundle path nor an unlisted payload can
 * become an authenticated artifact.
 */
export async function resolveVerifiedOffDeviceLogicalArtifact(
  bundlePathInput: string,
  exportFile: string,
  manifestFile: string,
): Promise<VerifiedOffDeviceLogicalArtifact> {
  if (!path.isAbsolute(bundlePathInput)) {
    throw new Error("off-device bundle path должен быть абсолютным");
  }
  if (path.basename(exportFile) !== exportFile || path.basename(manifestFile) !== manifestFile) {
    throw new Error("off-device logical artifact names должны быть basenames");
  }
  const bundlePath = path.resolve(bundlePathInput);
  const canonicalBundlePath = await realpath(bundlePath);
  if (canonicalBundlePath !== bundlePath) {
    throw new Error(`off-device bundle path проходит через symlink: ${bundlePath}`);
  }
  const verification = await verifyOffDeviceBackup(bundlePath);
  if (!verification.ok || !verification.backupId) {
    throw new Error(
      `off-device bundle не прошёл verification: ${verification.issues[0]?.reason ?? "unknown"}`,
    );
  }

  const offDeviceManifestPath = path.join(bundlePath, OFF_DEVICE_MANIFEST_FILE);
  const manifest = parseOffDeviceManifest(
    JSON.parse(await readFile(offDeviceManifestPath, "utf8")),
    offDeviceManifestPath,
  );
  const exportRelative = portablePath("archive", "backups", "surreal", exportFile);
  const manifestRelative = portablePath("archive", "backups", "manifests", manifestFile);
  if (!manifest.files.some(
    (file) => file.path === exportRelative && file.category === "logical_export",
  ) || !manifest.files.some(
    (file) => file.path === manifestRelative && file.category === "logical_manifest",
  )) {
    throw new Error("off-device manifest не содержит выбранную logical backup пару");
  }

  const exportPath = path.join(bundlePath, exportRelative);
  const logicalManifestPath = path.join(bundlePath, manifestRelative);
  for (const [label, filePath] of [
    ["logical export", exportPath],
    ["logical manifest", logicalManifestPath],
  ] as const) {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(filePath) !== filePath) {
      throw new Error(`off-device ${label} должен быть contained regular non-symlink file`);
    }
  }
  const logicalManifest = await readBackupManifest(logicalManifestPath);
  if (logicalManifest.rawManifestSha256 !== manifest.rawManifestSha256) {
    throw new Error("off-device logical/raw manifest integrity binding не совпадает");
  }
  const rawManifestEntry = manifest.files.find((file) => file.category === "raw_manifest");
  if (!rawManifestEntry) throw new Error("off-device raw manifest payload missing");
  const rawManifestPath = path.join(bundlePath, rawManifestEntry.path);
  const rawManifestInfo = await lstat(rawManifestPath);
  if (
    !rawManifestInfo.isFile() || rawManifestInfo.isSymbolicLink() ||
    await realpath(rawManifestPath) !== rawManifestPath
  ) {
    throw new Error("off-device raw manifest должен быть contained regular non-symlink file");
  }
  return {
    bundlePath,
    archiveRoot: path.join(bundlePath, "archive"),
    backupId: verification.backupId,
    exportPath,
    manifestPath: logicalManifestPath,
    rawManifestPath,
    rawManifestFile: path.basename(rawManifestPath),
    rawManifestFileSha256: (await hashFile(rawManifestPath)).sha256,
    rawManifestSha256: manifest.rawManifestSha256,
    bundleManifestSha256: (await hashFile(offDeviceManifestPath)).sha256,
    integrity: "verified",
    trustRequirement: "external_bundle_provenance_required",
  };
}

async function copyToStaging(
  source: SourceFile,
  stagingPath: string,
): Promise<{ reused: boolean; bytes: number }> {
  const target = path.join(stagingPath, source.entry.path);
  await ensureSafeDirectory(stagingPath, path.dirname(source.entry.path));
  // target.part is a reserved deterministic resume slot for exactly this
  // manifest payload. It is always created O_EXCL, never followed as a
  // symlink, and must match the manifest checksum before promotion.
  const part = `${target}.part`;
  const existing = await maybeLstat(target);
  if (existing) {
    const verified = await verifyOneFile(target, source.entry);
    if (verified.ok) {
      await removeOwnedStagingPart(part);
      return { reused: true, bytes: source.entry.sizeBytes };
    }
    throw new Error(`повреждённый staging target не будет перезаписан: ${target}`);
  }

  const crashedPart = await maybeLstat(part);
  if (crashedPart) {
    if (!crashedPart.isFile() || crashedPart.isSymbolicLink()) {
      throw new Error(`staging part небезопасен и не будет удалён: ${part}`);
    }
    const verified = await verifyOneFile(part, source.entry);
    if (verified.ok) {
      await fsyncPath(part);
      await rename(part, target);
      await fsyncPath(path.dirname(target));
      return { reused: true, bytes: source.entry.sizeBytes };
    }
    // This exact reserved regular-file slot belongs to this manifest entry;
    // malformed contents are a safely removable interrupted copy. Unrelated
    // names are never swept or deleted.
    await removeOwnedStagingPart(part);
  }

  const copied = await copyExclusiveAndHash(source.sourcePath, part);
  if (copied.sizeBytes !== source.entry.sizeBytes || copied.sha256 !== source.entry.sha256) {
    throw new Error(
      `checksum/size source изменились при копировании ${source.sourcePath}: ` +
        `ожидалось ${source.entry.sizeBytes}/${source.entry.sha256}, ` +
        `получено ${copied.sizeBytes}/${copied.sha256}; .part сохранён для диагностики`,
    );
  }
  await rename(part, target);
  await fsyncPath(path.dirname(target));
  return { reused: false, bytes: source.entry.sizeBytes };
}

function makeRunReport(
  plan: OffDeviceBackupPlan,
  options: OffDeviceBackupOptions,
  startedAt: string,
  status: OffDeviceRunReport["status"],
  progress: { copiedFiles: number; copiedBytes: number; reusedFiles: number; reusedBytes: number },
): OffDeviceRunReport {
  return {
    formatVersion: OFF_DEVICE_FORMAT_VERSION,
    backupId: plan.manifest.backupId,
    status,
    dryRun: options.dryRun ?? false,
    startedAt,
    completedAt: new Date().toISOString(),
    sourceArchiveRoot: plan.archiveRoot,
    destinationRoot: plan.destinationRoot,
    bundlePath: plan.bundlePath,
    deviceCheck: plan.deviceCheck,
    files: {
      total: plan.manifest.totals.files,
      copied: progress.copiedFiles,
      reused: progress.reusedFiles,
      verified: status === "planned" ? 0 : plan.manifest.totals.files,
    },
    bytes: {
      total: plan.manifest.totals.bytes,
      copied: progress.copiedBytes,
      reused: progress.reusedBytes,
      verified: status === "planned" ? 0 : plan.manifest.totals.bytes,
    },
  };
}

/**
 * Выполняет off-device backup либо безопасный dry-run. По умолчанию запись
 * блокируется, если destination имеет тот же st_dev, что archive root.
 */
export async function runOffDeviceBackup(
  options: OffDeviceBackupOptions,
): Promise<OffDeviceBackupResult> {
  const startedAt = new Date().toISOString();
  const plan = await planOffDeviceBackup(options);
  const emptyProgress = { copiedFiles: 0, copiedBytes: 0, reusedFiles: 0, reusedBytes: 0 };
  if (options.dryRun) {
    return {
      plan,
      report: makeRunReport(plan, options, startedAt, "planned", emptyProgress),
    };
  }
  if (
    !plan.deviceCheck.operatorConfirmedPhysicalDevice ||
    !plan.deviceCheck.checkedAt
  ) {
    throw new Error(
      "off-device publication требует durable operatorConfirmedPhysicalDevice + physicalDeviceCheckedAt",
    );
  }

  await mkdir(plan.destinationRoot, { recursive: true });
  // CLI serializes archive operations; the destination lock additionally
  // makes the library API race-free for concurrent publishers and protects
  // the final existence-check + directory rename no-clobber critical section.
  const releasePublicationLock = await acquireLock(
    plan.destinationRoot,
    `off-device publish ${plan.manifest.backupId}`,
  );
  try {
  const finalInfo = await maybeLstat(plan.bundlePath);
  if (finalInfo) {
    if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink()) {
      throw new Error(`final bundle path занят не каталогом: ${plan.bundlePath}`);
    }
    const verification = await verifyOffDeviceBackup(plan.bundlePath);
    if (!verification.ok || verification.backupId !== plan.manifest.backupId) {
      throw new Error(
        `существующий final bundle повреждён/не соответствует плану и не будет перезаписан: ` +
          `${plan.bundlePath} (${verification.issues[0]?.reason ?? "backupId mismatch"})`,
      );
    }
    const report = makeRunReport(plan, options, startedAt, "reused", {
      copiedFiles: 0,
      copiedBytes: 0,
      reusedFiles: plan.manifest.totals.files,
      reusedBytes: plan.manifest.totals.bytes,
    });
    const manifestHashes = await hashFile(path.join(plan.bundlePath, OFF_DEVICE_MANIFEST_FILE));
    report.manifestSha256 = manifestHashes.sha256;
    report.verification = verification;
    return {
      plan,
      report,
      manifestPath: path.join(plan.bundlePath, OFF_DEVICE_MANIFEST_FILE),
      reportPath: path.join(plan.bundlePath, OFF_DEVICE_REPORT_FILE),
    };
  }

  const stagingInfo = await maybeLstat(plan.stagingPath);
  if (stagingInfo) {
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
      throw new Error(`staging path занят не каталогом: ${plan.stagingPath}`);
    }
    const oldManifestPath = path.join(plan.stagingPath, OFF_DEVICE_MANIFEST_FILE);
    if (await maybeLstat(oldManifestPath)) {
      const old = parseOffDeviceManifest(JSON.parse(await readFile(oldManifestPath, "utf8")), oldManifestPath);
      if (old.sourceFingerprint !== plan.manifest.sourceFingerprint) {
        throw new Error(`staging принадлежит другому sourceFingerprint: ${plan.stagingPath}`);
      }
    }
  } else {
    await mkdir(plan.stagingPath);
  }
  // Crash мог оставить только временные/финальные metadata после полной
  // payload-проверки. Они воспроизводимы из plan и безопасно пересоздаются;
  // payload-файлы эта очистка не затрагивает.
  await removeSafeStagingMetadata(
    path.join(plan.stagingPath, `${OFF_DEVICE_MANIFEST_FILE}.part`),
  );
  await removeSafeStagingMetadata(path.join(plan.stagingPath, OFF_DEVICE_REPORT_FILE));
  await removeSafeStagingMetadata(
    path.join(plan.stagingPath, `${OFF_DEVICE_REPORT_FILE}.part`),
  );

  const progress = { ...emptyProgress };
  for (const source of plan.sources) {
    const copied = await copyToStaging(source, plan.stagingPath);
    if (copied.reused) {
      progress.reusedFiles += 1;
      progress.reusedBytes += copied.bytes;
    } else {
      progress.copiedFiles += 1;
      progress.copiedBytes += copied.bytes;
    }
  }

  const stagingManifestPath = path.join(plan.stagingPath, OFF_DEVICE_MANIFEST_FILE);
  await removeSafeStagingMetadata(stagingManifestPath);
  await writeStagingJsonExclusive(stagingManifestPath, plan.manifest);
  const verification = await verifyOffDeviceBackup(plan.stagingPath, { requireReport: false });
  if (!verification.ok) {
    throw new Error(
      `staging verification failed: ${verification.issues[0]?.path ?? "?"} ` +
        `(${verification.issues[0]?.reason ?? "unknown"})`,
    );
  }
  const manifestHashes = await hashFile(stagingManifestPath);
  const report = makeRunReport(plan, options, startedAt, "completed", progress);
  report.manifestSha256 = manifestHashes.sha256;
  report.verification = { ...verification, bundlePath: plan.bundlePath };
  const stagingReportPath = path.join(plan.stagingPath, OFF_DEVICE_REPORT_FILE);
  await writeStagingJsonExclusive(stagingReportPath, report);
  await fsyncPath(plan.stagingPath);
  if (await maybeLstat(plan.bundlePath)) {
    throw new Error(`final bundle появился во время publication и не будет перезаписан: ${plan.bundlePath}`);
  }
  await renameNoReplace(plan.stagingPath, plan.bundlePath);
  await fsyncPath(plan.destinationRoot);

  return {
    plan,
    report,
    manifestPath: path.join(plan.bundlePath, OFF_DEVICE_MANIFEST_FILE),
    reportPath: path.join(plan.bundlePath, OFF_DEVICE_REPORT_FILE),
  };
  } finally {
    await releasePublicationLock();
  }
}
