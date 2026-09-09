/**
 * FS-only тесты off-device backup (§16.3). Никакой production DB и реальный
 * внешний носитель не используются; requireDifferentFilesystem=false —
 * явный test seam, а default-политика проверяется отдельно.
 */

import { describe, expect, test } from "bun:test";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OFF_DEVICE_MANIFEST_FILE,
  OFF_DEVICE_REPORT_FILE,
  planOffDeviceBackup,
  runOffDeviceBackup,
  verifyOffDeviceBackup,
  type OffDeviceBackupOptions,
} from "../src/backup/off-device.ts";
import { manifestPathForExport, type BackupManifest } from "../src/backup/backup.ts";
import { hashRawManifest, type RawManifest } from "../src/backup/raw-verify.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";

interface Fixture {
  base: string;
  archiveRoot: string;
  projectRoot: string;
  destination: string;
  options: OffDeviceBackupOptions;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), "baka-off-device-test-"));
  const archiveRoot = path.join(base, "archive");
  const projectRoot = path.join(base, "project");
  const destination = path.join(base, "destination-not-created");
  await mkdir(path.join(archiveRoot, "backups", "surreal"), { recursive: true });
  await mkdir(path.join(archiveRoot, "backups", "manifests"), { recursive: true });
  await mkdir(path.join(archiveRoot, "raw", "codex"), { recursive: true });
  await mkdir(path.join(archiveRoot, "db"), { recursive: true });
  await mkdir(path.join(projectRoot, "schema"), { recursive: true });
  await mkdir(path.join(projectRoot, "reports"), { recursive: true });

  await writeFile(
    path.join(archiveRoot, ".baka-archive.json"),
    JSON.stringify({
      archiveId: "11111111-2222-4333-8444-555555555555",
      formatVersion: 1,
      createdAt: "2026-07-26T10:00:00.000Z",
      expectedNamespace: "baka",
      expectedDatabase: "archive",
    }),
  );

  const rawRelative = "raw/codex/session.jsonl";
  const rawPath = path.join(archiveRoot, rawRelative);
  await writeFile(rawPath, "raw-data");
  const rawHashes = await hashFile(rawPath);
  const rawManifest: RawManifest = {
    createdAt: "2026-07-26T10:01:00.000Z",
    count: 1,
    entries: [
      {
        revisionId: "source_revision:test",
        path: rawRelative,
        sha256: rawHashes.sha256,
        sizeBytes: rawHashes.sizeBytes,
        harness: "codex",
      },
    ],
  };
  await writeFile(
    path.join(archiveRoot, "backups", "manifests", "raw-manifest-2026-07-26T100100Z.json"),
    `${JSON.stringify(rawManifest, null, 2)}\n`,
  );
  // Orphan не теряется: он копируется и маркируется отдельно.
  await writeFile(path.join(archiveRoot, "raw", "codex", "orphan.jsonl"), "orphan");
  // RocksDB специально присутствует, но не должен попасть в plan.
  await writeFile(path.join(archiveRoot, "db", "rocks.db"), "not-a-backup");

  const exportFile =
    "2026-07-26T100000Z__schema-1__surreal-3.2.3.surql.gz";
  const exportPath = path.join(archiveRoot, "backups", "surreal", exportFile);
  await writeFile(exportPath, "logical-surreal-export");
  const exportHashes = await hashFile(exportPath);
  const logicalManifest: BackupManifest = {
    createdAt: "2026-07-26T10:00:00.000Z",
    surrealdbVersion: "3.2.3",
    schemaVersion: 1,
    bakaCommit: "test",
    namespace: "baka",
    database: "archive",
    recordCounts: { source_revision: 1 },
    rawManifestSha256: hashRawManifest(rawManifest),
    exportFile,
    compression: "gzip",
    exportBytes: exportHashes.sizeBytes,
    exportSha256: exportHashes.sha256,
  };
  await writeFile(
    manifestPathForExport(exportPath),
    `${JSON.stringify(logicalManifest, null, 2)}\n`,
  );

  await writeFile(
    path.join(projectRoot, "schema", "0001_initial.surql"),
    "-- initial schema 1\n",
  );
  await writeFile(
    path.join(projectRoot, "reports", "migration-preflight-2026-07-26.md"),
    "# migration report\n",
  );
  await writeFile(
    path.join(archiveRoot, "backups", "manifests", "migration-run-2026-07-26.json"),
    '{"ok":true}\n',
  );

  return {
    base,
    archiveRoot,
    projectRoot,
    destination,
    options: {
      archiveRoot,
      destination,
      projectRoot,
      requireDifferentFilesystem: false,
      operatorConfirmedPhysicalDevice: true,
      physicalDeviceCheckedAt: new Date("2026-07-26T11:59:00.000Z"),
      now: new Date("2026-07-26T12:00:00.000Z"),
    },
  };
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await makeFixture();
  try {
    await fn(fixture);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
}

describe("off-device backup plan", () => {
  test("dry-run полностью планирует/проверяет источники и не пишет destination", async () => {
    await withFixture(async (fixture) => {
      const result = await runOffDeviceBackup({ ...fixture.options, dryRun: true });
      expect(result.report.status).toBe("planned");
      expect(result.report.dryRun).toBe(true);
      expect(await exists(fixture.destination)).toBe(false);
      expect(result.plan.manifest.totals.rawFiles).toBe(1);
      expect(result.plan.manifest.totals.rawOrphans).toBe(1);
      expect(result.plan.manifest.totals.schemaMigrations).toBe(1);
      expect(result.plan.manifest.totals.migrationReports).toBe(2);
      expect(result.plan.manifest.files.some((file) => file.path.includes("rocks.db"))).toBe(false);
      expect(result.plan.manifest.files.map((file) => file.category)).toContain("logical_export");
      expect(result.plan.manifest.files.map((file) => file.category)).toContain("raw_manifest");
      expect(result.plan.manifest.files.map((file) => file.category)).toContain("sentinel");
      expect(
        result.plan.manifest.files.some(
          (file) => file.path === "project/schema/0001_initial.surql",
        ),
      ).toBe(true);
    });
  });

  test("destination внутри archive и same-filesystem по умолчанию блокируются", async () => {
    await withFixture(async (fixture) => {
      await expect(
        planOffDeviceBackup({
          ...fixture.options,
          destination: path.join(fixture.archiveRoot, "bad-destination"),
        }),
      ).rejects.toThrow(/destination должен быть вне archive root/);
      await expect(
        planOffDeviceBackup({
          archiveRoot: fixture.archiveRoot,
          destination: fixture.destination,
          projectRoot: fixture.projectRoot,
        }),
      ).rejects.toThrow(/том же filesystem/);
    });
  });

  test("path traversal в raw manifest отклоняется до записи", async () => {
    await withFixture(async (fixture) => {
      const rawManifestPath = path.join(
        fixture.archiveRoot,
        "backups",
        "manifests",
        "raw-manifest-2026-07-26T999999Z.json",
      );
      await writeFile(
        rawManifestPath,
        JSON.stringify({
          createdAt: "x",
          count: 1,
          entries: [
            {
              revisionId: "source_revision:escape",
              path: "raw/../../secret",
              sha256: "0".repeat(64),
              sizeBytes: 1,
              harness: "codex",
            },
          ],
        }),
      );
      await expect(
        planOffDeviceBackup({ ...fixture.options, rawManifestPath }),
      ).rejects.toThrow(/выходит из backup bundle/);
      expect(await exists(fixture.destination)).toBe(false);
    });
  });

  test("symlink-компонент raw path не позволяет копировать файл вне raw root", async () => {
    await withFixture(async (fixture) => {
      const rawHarnessDir = path.join(fixture.archiveRoot, "raw", "codex");
      const outsideDir = path.join(fixture.base, "outside-codex");
      await rm(rawHarnessDir, { recursive: true });
      await mkdir(outsideDir);
      await writeFile(path.join(outsideDir, "session.jsonl"), "raw-data");
      await symlink(outsideDir, rawHarnessDir, "dir");

      await expect(planOffDeviceBackup(fixture.options)).rejects.toThrow(
        /symlink|выходит из raw root/,
      );
      expect(await exists(fixture.destination)).toBe(false);
    });
  });
});
describe("off-device publication and verification", () => {
  test("non-dry publication requires durable operator attestation", async () => {
    await withFixture(async (fixture) => {
      await expect(runOffDeviceBackup({
        ...fixture.options,
        operatorConfirmedPhysicalDevice: false,
        physicalDeviceCheckedAt: undefined,
      })).rejects.toThrow(/operatorConfirmedPhysicalDevice/);
      expect(await exists(fixture.destination)).toBe(false);
    });
  });

  test("публикует атомарный bundle, проверяет и идемпотентно переиспользует", async () => {
    await withFixture(async (fixture) => {
      const first = await runOffDeviceBackup(fixture.options);
      expect(first.report.status).toBe("completed");
      expect(first.report.verification?.ok).toBe(true);
      expect(await exists(first.plan.stagingPath)).toBe(false);
      expect(await exists(first.plan.bundlePath)).toBe(true);
      expect(await exists(path.join(first.plan.bundlePath, OFF_DEVICE_MANIFEST_FILE))).toBe(true);
      expect(await exists(path.join(first.plan.bundlePath, OFF_DEVICE_REPORT_FILE))).toBe(true);

      const verification = await verifyOffDeviceBackup(first.plan.bundlePath);
      expect(verification.ok).toBe(true);
      expect(verification.checkedFiles).toBe(first.plan.manifest.totals.files);
      const machineReport = JSON.parse(
        await readFile(path.join(first.plan.bundlePath, OFF_DEVICE_REPORT_FILE), "utf8"),
      ) as {
        status: string;
        deviceCheck: { operatorConfirmedPhysicalDevice: boolean; checkedAt: string };
      };
      expect(machineReport.status).toBe("completed");
      expect(machineReport.deviceCheck.operatorConfirmedPhysicalDevice).toBe(true);
      expect(machineReport.deviceCheck.checkedAt).toBe("2026-07-26T11:59:00.000Z");

      const second = await runOffDeviceBackup(fixture.options);
      expect(second.plan.bundlePath).toBe(first.plan.bundlePath);
      expect(second.report.status).toBe("reused");
      expect(second.report.files.copied).toBe(0);
      expect(second.report.files.reused).toBe(first.plan.manifest.totals.files);
    });
  });

  test("concurrent publishers не перезаписывают bundle/manifest/report", async () => {
    await withFixture(async (fixture) => {
      const results = await Promise.allSettled([
        runOffDeviceBackup(fixture.options),
        runOffDeviceBackup(fixture.options),
      ]);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runOffDeviceBackup>>> =>
          result.status === "fulfilled",
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const rejected of results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      )) {
        expect(String(rejected.reason)).toMatch(/lock уже захвачен/);
      }
      const bundlePath = fulfilled[0]!.value.plan.bundlePath;
      const verification = await verifyOffDeviceBackup(bundlePath);
      expect(verification.ok).toBe(true);
      expect(await exists(path.join(bundlePath, OFF_DEVICE_MANIFEST_FILE))).toBe(true);
      expect(await exists(path.join(bundlePath, OFF_DEVICE_REPORT_FILE))).toBe(true);
    });
  });

  test("resume переиспользует уже валидный staging-файл", async () => {
    await withFixture(async (fixture) => {
      const plan = await planOffDeviceBackup({ ...fixture.options, dryRun: true });
      const firstSource = plan.sources[0]!;
      const stagedTarget = path.join(plan.stagingPath, firstSource.entry.path);
      await mkdir(path.dirname(stagedTarget), { recursive: true });
      await copyFile(firstSource.sourcePath, stagedTarget);
      await writeFile(`${stagedTarget}.part`, "остаток прошлого оборванного запуска");

      const result = await runOffDeviceBackup(fixture.options);
      expect(result.report.status).toBe("completed");
      expect(result.report.files.reused).toBeGreaterThanOrEqual(1);
      expect(await exists(plan.stagingPath)).toBe(false);
      expect(await exists(path.join(plan.bundlePath, `${firstSource.entry.path}.part`))).toBe(false);
      expect((await verifyOffDeviceBackup(plan.bundlePath)).ok).toBe(true);
    });
  });

  test("resume checksum-валидирует и публикует crashed target.part", async () => {
    await withFixture(async (fixture) => {
      const plan = await planOffDeviceBackup({ ...fixture.options, dryRun: true });
      const firstSource = plan.sources[0]!;
      const stagedTarget = path.join(plan.stagingPath, firstSource.entry.path);
      const part = `${stagedTarget}.part`;
      await mkdir(path.dirname(part), { recursive: true });
      await copyFile(firstSource.sourcePath, part);

      const result = await runOffDeviceBackup(fixture.options);
      expect(result.report.status).toBe("completed");
      expect(result.report.files.reused).toBeGreaterThanOrEqual(1);
      expect(await exists(path.join(plan.bundlePath, `${firstSource.entry.path}.part`))).toBe(false);
      expect((await verifyOffDeviceBackup(plan.bundlePath)).ok).toBe(true);
    });
  });

  test("resume удаляет только invalid regular target.part и копирует заново", async () => {
    await withFixture(async (fixture) => {
      const plan = await planOffDeviceBackup({ ...fixture.options, dryRun: true });
      const firstSource = plan.sources[0]!;
      const stagedTarget = path.join(plan.stagingPath, firstSource.entry.path);
      const part = `${stagedTarget}.part`;
      await mkdir(path.dirname(part), { recursive: true });
      await writeFile(part, "interrupted-copy");

      const result = await runOffDeviceBackup(fixture.options);
      expect(result.report.status).toBe("completed");
      expect(await exists(path.join(plan.bundlePath, `${firstSource.entry.path}.part`))).toBe(false);
      expect((await verifyOffDeviceBackup(plan.bundlePath)).ok).toBe(true);
    });
  });

  test("symlink в reserved target.part отклоняется и не удаляется", async () => {
    await withFixture(async (fixture) => {
      const plan = await planOffDeviceBackup({ ...fixture.options, dryRun: true });
      const firstSource = plan.sources[0]!;
      const stagedTarget = path.join(plan.stagingPath, firstSource.entry.path);
      const part = `${stagedTarget}.part`;
      const outside = path.join(fixture.base, "attacker-owned.txt");
      await writeFile(outside, "do-not-touch");
      await mkdir(path.dirname(part), { recursive: true });
      await symlink(outside, part);

      await expect(runOffDeviceBackup(fixture.options)).rejects.toThrow(/staging part небезопасен/);
      expect((await lstat(part)).isSymbolicLink()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("do-not-touch");
    });
  });

  test("unindexed unexpected temp не удаляется и блокирует publication", async () => {
    await withFixture(async (fixture) => {
      const plan = await planOffDeviceBackup({ ...fixture.options, dryRun: true });
      const firstSource = plan.sources[0]!;
      const target = path.join(plan.stagingPath, firstSource.entry.path);
      const unexpected = path.join(
        path.dirname(target),
        `.${path.basename(target)}.attacker-uuid.part`,
      );
      await mkdir(path.dirname(unexpected), { recursive: true });
      await writeFile(unexpected, "not-owned-by-resume-protocol");

      await expect(runOffDeviceBackup(fixture.options)).rejects.toThrow(/staging verification failed/);
      expect(await readFile(unexpected, "utf8")).toBe("not-owned-by-resume-protocol");
      expect(await exists(plan.bundlePath)).toBe(false);
    });
  });

  test("unindexed unexpected symlink сохраняется и блокирует publication", async () => {
    await withFixture(async (fixture) => {
      const plan = await planOffDeviceBackup({ ...fixture.options, dryRun: true });
      const firstSource = plan.sources[0]!;
      const target = path.join(plan.stagingPath, firstSource.entry.path);
      const unexpected = path.join(path.dirname(target), ".attacker-unindexed.part");
      const outside = path.join(fixture.base, "unexpected-symlink-target.txt");
      await writeFile(outside, "outside-remains");
      await mkdir(path.dirname(unexpected), { recursive: true });
      await symlink(outside, unexpected);

      await expect(runOffDeviceBackup(fixture.options)).rejects.toThrow(/symlink запрещён/);
      expect((await lstat(unexpected)).isSymbolicLink()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("outside-remains");
      expect(await exists(plan.bundlePath)).toBe(false);
    });
  });

  test("повреждённый final bundle не считается успешным и не перезаписывается", async () => {
    await withFixture(async (fixture) => {
      const result = await runOffDeviceBackup(fixture.options);
      const raw = result.plan.manifest.files.find((file) => file.category === "raw")!;
      await writeFile(path.join(result.plan.bundlePath, raw.path), "bad-data");
      const verification = await verifyOffDeviceBackup(result.plan.bundlePath);
      expect(verification.ok).toBe(false);
      expect(verification.issues[0]?.reason).toBe("sha256_mismatch");
      await expect(runOffDeviceBackup(fixture.options)).rejects.toThrow(
        /существующий final bundle повреждён/,
      );
      expect(await readFile(path.join(result.plan.bundlePath, raw.path), "utf8")).toBe("bad-data");
    });
  });

  test("verify rejects a report whose physical attestation differs from manifest", async () => {
    await withFixture(async (fixture) => {
      const result = await runOffDeviceBackup(fixture.options);
      const reportPath = path.join(result.plan.bundlePath, OFF_DEVICE_REPORT_FILE);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        deviceCheck: { operatorConfirmedPhysicalDevice: boolean };
      };
      report.deviceCheck.operatorConfirmedPhysicalDevice = false;
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      const verification = await verifyOffDeviceBackup(result.plan.bundlePath);
      expect(verification.ok).toBe(false);
      expect(verification.issues.some((issue) => issue.reason === "invalid_metadata")).toBe(true);
    });
  });

  test("verify связывает rawManifestSha256 с raw-manifest payload", async () => {
    await withFixture(async (fixture) => {
      const result = await runOffDeviceBackup(fixture.options);
      const manifestPath = path.join(result.plan.bundlePath, OFF_DEVICE_MANIFEST_FILE);
      const reportPath = path.join(result.plan.bundlePath, OFF_DEVICE_REPORT_FILE);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        rawManifestSha256: string;
      };
      manifest.rawManifestSha256 = "0".repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        manifestSha256: string;
      };
      report.manifestSha256 = (await hashFile(manifestPath)).sha256;
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const verification = await verifyOffDeviceBackup(result.plan.bundlePath);
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(
        (issue) => issue.reason === "invalid_metadata" && issue.path.includes("raw-manifest"),
      )).toBe(true);
    });
  });

  test("verify сверяет persisted destination st_dev с текущим bundle", async () => {
    await withFixture(async (fixture) => {
      const result = await runOffDeviceBackup(fixture.options);
      const manifestPath = path.join(result.plan.bundlePath, OFF_DEVICE_MANIFEST_FILE);
      const reportPath = path.join(result.plan.bundlePath, OFF_DEVICE_REPORT_FILE);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        deviceCheck: {
          sourceFilesystemDevice: number;
          destinationFilesystemDevice: number;
          differentFilesystem: boolean;
        };
      };
      manifest.deviceCheck.destinationFilesystemDevice += 1;
      manifest.deviceCheck.differentFilesystem =
        manifest.deviceCheck.sourceFilesystemDevice !==
        manifest.deviceCheck.destinationFilesystemDevice;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        deviceCheck: typeof manifest.deviceCheck;
        manifestSha256: string;
      };
      report.deviceCheck = manifest.deviceCheck;
      report.manifestSha256 = (await hashFile(manifestPath)).sha256;
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const verification = await verifyOffDeviceBackup(result.plan.bundlePath);
      expect(verification.ok).toBe(false);
      expect(
        verification.issues.some(
          (issue) => issue.path === OFF_DEVICE_MANIFEST_FILE &&
            issue.reason === "invalid_metadata",
        ),
      ).toBe(true);
    });
  });
});
