import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordId, type Surreal } from "surrealdb";
import {
  assertDoctorSafety,
  choosePrimaryModel,
  inspectOrphanRawFiles,
  inspectUnresolvedIngestErrors,
  runDoctor,
  runDoctorWithDb,
} from "../src/doctor.ts";
import type { AppConfig } from "../src/config.ts";
import { hashFile } from "../src/sources/snapshot/hashing.ts";
import { rawFileName } from "../src/sources/snapshot/naming.ts";

type QueryHandler = (sql: string, vars?: Record<string, unknown>) => unknown[];

function fakeDb(handler: QueryHandler): Surreal {
  return {
    query: async (sql: string, vars?: Record<string, unknown>) => [handler(sql, vars)],
    close: async () => {},
  } as unknown as Surreal;
}

function doctorConfig(archiveRoot: string): AppConfig {
  return { archiveRoot } as AppConfig;
}

describe("unresolved ingest error classification", () => {
  test("retains unsupported raw and refuses to guess provenance from historical text", async () => {
    const unsupportedRevision = new RecordId("source_revision", "unsupported");
    const db = fakeDb((sql) => {
      if (!sql.includes("FROM ingest_error")) return [];
      return [
        {
          id: new RecordId("ingest_error", "unsupported_original"),
          source_revision: unsupportedRevision,
          stage: "parse",
          error_code: "unsupported_file",
          revision_parse_status: "unsupported",
          location_current_revision: unsupportedRevision,
        },
        {
          id: new RecordId("ingest_error", "historical_snapshot"),
          stage: "snapshot",
          error_code: "snapshot_exception",
        },
        {
          id: new RecordId("ingest_error", "attributed_snapshot"),
          source_record_key: "source_location:known",
          stage: "snapshot",
          error_code: "snapshot_exception",
        },
        {
          id: new RecordId("ingest_error", "failed_reparse_after_success"),
          source_revision: new RecordId("source_revision", "parsed"),
          stage: "parse",
          error_code: "parser_exception",
          revision_parse_status: "parsed",
          location_current_revision: new RecordId("source_revision", "newer"),
        },
        {
          id: new RecordId("ingest_error", "unsupported_prefix_is_not_documented"),
          source_revision: new RecordId("source_revision", "current_prefix"),
          stage: "parse",
          error_code: "unsupported_transient_state",
          revision_parse_status: "unsupported",
          location_current_revision: new RecordId("source_revision", "current_prefix"),
        },
        {
          id: new RecordId("ingest_error", "unsupported_code_after_failed_retry"),
          source_revision: new RecordId("source_revision", "current_failed"),
          stage: "parse",
          error_code: "unsupported_file",
          revision_parse_status: "parse_error",
          location_current_revision: new RecordId("source_revision", "current_failed"),
        },
      ];
    });

    const assessed = await inspectUnresolvedIngestErrors(db);

    expect(assessed.map((item) => item.classification)).toEqual([
      "documented_unsupported",
      "unattributed_snapshot_failure",
      "attributed_snapshot_failure",
      "historical_revision_failure",
      "actionable_current_failure",
      "actionable_current_failure",
    ]);
    expect(assessed[0]).toEqual(expect.objectContaining({
      errorCode: "unsupported_file",
      currentRevision: true,
    }));
    expect(assessed[1]).toEqual(expect.objectContaining({
      id: new RecordId("ingest_error", "historical_snapshot"),
      currentRevision: false,
    }));
  });
});

async function applyDoctorWithDb(
  db: Surreal,
  archiveRoot: string,
  options: Parameters<typeof runDoctor>[1],
  dependencies: Parameters<typeof runDoctor>[2] = {},
) {
  return runDoctor(
    doctorConfig(archiveRoot),
    { ...options, dryRun: false },
    { ...dependencies, connect: async () => db },
  );
}

const validationOk = async () => ({ ok: true, issues: [] });

async function makeOrphan(
  root: string,
  harness: string,
  sourceBasename: string,
  content: string,
): Promise<{ rawPath: string; sha256: string }> {
  const scratch = path.join(root, "scratch");
  await writeFile(scratch, content);
  const sha256 = (await hashFile(scratch)).sha256;
  const rawDir = path.join(root, "raw", harness);
  await mkdir(rawDir, { recursive: true });
  const rawPath = path.join(rawDir, rawFileName(sourceBasename, sha256));
  await writeFile(rawPath, content);
  await rm(scratch);
  return { rawPath, sha256 };
}

describe("orphan raw — сценарий §19.2 №12", () => {
  test("однозначный неизменившийся regular source repairable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-orphan-"));
    try {
      const source = path.join(root, "source", "session.jsonl");
      await mkdir(path.dirname(source));
      await writeFile(source, "same-content\n");
      const orphan = await makeOrphan(root, "codex", "session.jsonl", "same-content\n");
      const db = fakeDb((sql) => {
        if (sql.includes("FROM source_location")) {
          return [
            {
              id: "source_location:one",
              source_root: "source_root:one",
              original_path: source,
              basename: "session.jsonl",
              harness: "codex",
              parser_name: "codex",
              host: "host:one",
            },
          ];
        }
        return [];
      });
      const assessed = await inspectOrphanRawFiles(db, root);
      expect(assessed).toHaveLength(1);
      expect(assessed[0]!.path).toBe(path.relative(root, orphan.rawPath));
      expect(assessed[0]!.sha256).toBe(orphan.sha256);
      expect(assessed[0]!.repairable).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ambiguous и SQLite provenance остаются manual", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-boundary-"));
    try {
      const sourceA = path.join(root, "a", "same.jsonl");
      const sourceB = path.join(root, "b", "same.jsonl");
      const sqlite = path.join(root, "db", "state.db");
      await mkdir(path.dirname(sourceA));
      await mkdir(path.dirname(sourceB));
      await mkdir(path.dirname(sqlite));
      await writeFile(sourceA, "duplicate");
      await writeFile(sourceB, "duplicate");
      await writeFile(sqlite, "sqlite-physical");
      await makeOrphan(root, "codex", "same.jsonl", "duplicate");
      await makeOrphan(root, "cursor", "state.db", "sqlite-physical");
      const db = fakeDb((sql) => {
        if (!sql.includes("FROM source_location")) return [];
        return [
          {
            id: "source_location:a",
            source_root: "source_root:codex",
            original_path: sourceA,
            basename: "same.jsonl",
            harness: "codex",
            parser_name: "codex",
            host: "host:one",
          },
          {
            id: "source_location:b",
            source_root: "source_root:codex",
            original_path: sourceB,
            basename: "same.jsonl",
            harness: "codex",
            parser_name: "codex",
            host: "host:one",
          },
          {
            id: "source_location:db",
            source_root: "source_root:cursor",
            original_path: sqlite,
            basename: "state.db",
            harness: "cursor",
            parser_name: "cursor",
            host: "host:one",
          },
        ];
      });
      const assessed = await inspectOrphanRawFiles(db, root);
      expect(assessed).toHaveLength(2);
      expect(assessed.every((item) => !item.repairable)).toBe(true);
      expect(assessed.some((item) => item.reason.includes("неоднозначен"))).toBe(true);
      expect(assessed.some((item) => item.reason.includes("SQLite provenance"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("explicit import регистрирует pending revision, dry-run ничего не пишет", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-import-"));
    try {
      const source = path.join(root, "source", "session.jsonl");
      await mkdir(path.dirname(source));
      await writeFile(source, "recover-me");
      await makeOrphan(root, "codex", "session.jsonl", "recover-me");
      const writes: string[] = [];
      const db = fakeDb((sql) => {
        if (sql.includes("FROM source_location")) {
          return [
            {
              id: "source_location:one",
              source_root: "source_root:one",
              original_path: source,
              basename: "session.jsonl",
              harness: "codex",
              parser_name: "codex",
              host: "host:one",
            },
          ];
        }
        if (sql.includes("FROM schema_migration")) return [{ version: 5 }];
        if (sql.includes("CREATE ONLY sync_run")) {
          writes.push(sql);
          return [{ id: "sync_run:doctor" }];
        }
        if (sql.includes("CREATE ONLY source_revision")) {
          writes.push(sql);
          return [{ id: "source_revision:recovered" }];
        }
        if (sql.trimStart().startsWith("UPDATE")) writes.push(sql);
        return [];
      });

      const preview = await runDoctorWithDb(
        db,
        { archiveRoot: root },
        { importOrphanRaw: true },
        { validate: validationOk },
      );
      expect(preview.dryRun).toBe(true);
      expect(preview.actions[0]?.status).toBe("planned");
      expect(writes).toHaveLength(0);

      const applied = await applyDoctorWithDb(
        db,
        root,
        { importOrphanRaw: true },
        { validate: validationOk },
      );
      expect(applied.actions[0]?.status).toBe("applied");
      expect(applied.actions[0]?.affected).toBe(1);
      expect(writes.some((sql) => sql.includes("CREATE ONLY source_revision"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("doctor safety and explicit repairs", () => {
  test("already-open DB API не принимает caller lock claims", async () => {
    expect(() =>
      assertDoctorSafety({ dryRun: false, removeStaleStaging: true }),
    ).toThrow("read-only");
    expect(() =>
      assertDoctorSafety({
        dryRun: false,
        exclusiveLockHeld: true,
        removeStaleStaging: true,
      }),
    ).toThrow("read-only");
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-bypass-"));
    try {
      const db = fakeDb(() => []);
      await expect(runDoctorWithDb(
        db,
        { archiveRoot: root },
        {
          dryRun: false,
          exclusiveLockHeld: true,
          allowDestructive: true,
          removeStaleStaging: true,
        },
        { validate: validationOk },
      )).rejects.toThrow("read-only");
      await expect(runDoctor(
        doctorConfig(root),
        { dryRun: false, removeStaleStaging: true },
        { connect: async () => db, validate: validationOk },
      )).rejects.toThrow("allowDestructive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove-stale-staging: default preview, explicit apply", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-staging-"));
    try {
      const stale = path.join(root, "staging", "stale-run", "left.part");
      await mkdir(path.dirname(stale), { recursive: true });
      await writeFile(stale, "leftover");
      const db = fakeDb(() => []);
      const preview = await runDoctorWithDb(
        db,
        { archiveRoot: root },
        { removeStaleStaging: true },
        { validate: validationOk },
      );
      expect(preview.actions[0]?.status).toBe("planned");
      await access(stale);

      const applied = await applyDoctorWithDb(
        db,
        root,
        {
          removeStaleStaging: true,
          allowDestructive: true,
        },
        { validate: validationOk },
      );
      expect(applied.actions[0]?.status).toBe("applied");
      await expect(access(path.join(root, "staging", "stale-run"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove-stale-staging refuses a symlink target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-staging-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "baka-doctor-outside-"));
    try {
      await mkdir(path.join(root, "staging"));
      await writeFile(path.join(outside, "keep"), "untouched");
      await symlink(outside, path.join(root, "staging", "malicious-run"));
      await expect(
        applyDoctorWithDb(
          fakeDb(() => []),
          root,
          {
            removeStaleStaging: true,
            allowDestructive: true,
          },
          { validate: validationOk },
        ),
      ).rejects.toThrow(/symlink/);
      expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("untouched");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("manifest repair refuses symlink parents and cannot write outside archive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-manifest-link-"));
    const outside = await mkdtemp(path.join(tmpdir(), "baka-doctor-manifest-outside-"));
    try {
      await symlink(outside, path.join(root, "backups"));
      await expect(
        applyDoctorWithDb(
          fakeDb(() => []),
          root,
          {
            repairManifest: true,
            allowDestructive: true,
          },
          { validate: validationOk },
        ),
      ).rejects.toThrow(/symlink/);
      await expect(access(path.join(outside, "manifests", "raw-manifest-current.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("public runDoctor owns apply lock and ignores caller lock claim; dry-run is lock-free", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-lock-"));
    try {
      const order: string[] = [];
      const db = {
        query: async () => [[]],
        close: async () => { order.push("close"); },
      } as unknown as Surreal;
      const cfg = { archiveRoot: root } as AppConfig;
      const lockPath = path.join(root, ".baka-sync.lock");
      let shouldSeeLock = true;
      const dependencies = {
        validate: validationOk,
        connect: async () => {
          if (shouldSeeLock) await access(lockPath);
          else await expect(access(lockPath)).rejects.toThrow();
          order.push("connect");
          return db;
        },
      };
      await runDoctor(
        cfg,
        { dryRun: false, exclusiveLockHeld: true, requeueStuckEmbeddings: true },
        dependencies,
      );
      expect(order).toEqual(["connect", "close"]);
      await expect(access(lockPath)).rejects.toThrow();

      order.length = 0;
      shouldSeeLock = false;
      await runDoctor(cfg, { dryRun: true, requeueStuckEmbeddings: true }, dependencies);
      expect(order).toEqual(["connect", "close"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor logger seam emits only stable codes/counts, never finding text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-log-"));
    try {
      const events: Record<string, unknown>[] = [];
      await runDoctorWithDb(
        fakeDb(() => []),
        { archiveRoot: root },
        { logger: (event) => events.push(event) },
        {
          validate: async () => ({
            ok: false,
            issues: [{ check: "private_failure", detail: "PRIVATE CORPUS CONTENT" }],
          }),
        },
      );
      expect(events.map((event) => event.event)).toEqual([
        "doctor_inspection_started",
        "doctor_inspection_finished",
      ]);
      expect(JSON.stringify(events)).not.toContain("PRIVATE CORPUS CONTENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stuck jobs, primary model, rebuild hook и raw manifest применяются", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "baka-doctor-actions-"));
    try {
      const oldModel = new RecordId("model", "old");
      const newModel = new RecordId("model", "new");
      const dialogue = new RecordId("dialogue", "one");
      const updates: string[] = [];
      const db = fakeDb((sql) => {
        if (sql.includes("SELECT id, locked_at, locked_by FROM embedding_job")) {
          return [{ id: "embedding_job:stuck", locked_at: new Date(0), locked_by: "dead" }];
        }
        if (sql.includes("UPDATE embedding_job") && sql.includes("locked_at < $cutoff")) {
          updates.push(sql);
          return [{ id: "embedding_job:stuck" }];
        }
        if (sql.includes("SELECT id, current_revision, primary_model FROM dialogue")) {
          return [{ id: dialogue, current_revision: "dialogue_revision:one", primary_model: oldModel }];
        }
        if (sql.includes("SELECT dialogue, model, sequence FROM message")) {
          return [{ dialogue, model: newModel, sequence: 1 }];
        }
        if (sql.includes("UPDATE ONLY $id SET primary_model")) updates.push(sql);
        return [];
      });
      let rebuilt = false;
      const report = await applyDoctorWithDb(
        db,
        root,
        {
          allowDestructive: true,
          requeueStuckEmbeddings: true,
          rebuildSearchProjection: true,
          recalculatePrimaryModels: true,
          repairManifest: true,
          rebuildOptions: {
            host: new RecordId("host", "one"),
            schemaVersion: 5,
            enqueueEmbeddings: true,
          },
        },
        {
          validate: validationOk,
          rebuild: async () => {
            rebuilt = true;
            return {
              revisions: 1,
              dialogues: 1,
              searchDocuments: 2,
              embeddingJobs: 2,
              skipped: 0,
            };
          },
        },
      );
      expect(rebuilt).toBe(true);
      expect(report.actions.map((action) => action.action)).toEqual([
        "requeue-stuck-embeddings",
        "rebuild-search-projection",
        "recalculate-primary-models",
        "repair-manifest",
      ]);
      expect(report.actions.every((action) => action.status === "applied")).toBe(true);
      expect(updates.some((sql) => sql.includes("locked_at < $cutoff"))).toBe(true);
      expect(updates.some((sql) => sql.includes("primary_model"))).toBe(true);
      const manifest = JSON.parse(
        await readFile(
          path.join(root, "backups", "manifests", "raw-manifest-current.json"),
          "utf8",
        ),
      ) as { count: number };
      expect(manifest.count).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("primary model tie выбирает последнюю sequence", () => {
  const a = new RecordId("model", "a");
  const b = new RecordId("model", "b");
  expect(
    choosePrimaryModel([
      { model: a, sequence: 1 },
      { model: b, sequence: 2 },
      { model: a, sequence: 3 },
      { model: b, sequence: 4 },
    ]),
  ).toEqual(b);
});
