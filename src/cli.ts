#!/usr/bin/env bun
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import { loadConfig, type AppConfig } from "./config.ts";
import { initArchive } from "./infra/sentinel.ts";
import { runPreflight } from "./infra/preflight.ts";
import {
  composeDown,
  composeLogs,
  composeStatus,
  composeUp,
} from "./infra/compose.ts";
import { ejectDisk } from "./infra/disk-eject.ts";
import { connectDb, serverVersion } from "./db/client.ts";
import { applyMigrations, checkSchemaVersion } from "./db/migrations.ts";
import { assertPreflight } from "./infra/preflight.ts";
import { acquireLock } from "./infra/lock.ts";
import { readSentinel } from "./infra/sentinel.ts";
import { discoverSourceRoots } from "./sources/discovery/discovery.ts";
import { runSync } from "./sync/sync-run.ts";
import { HARNESSES, type HarnessSlug } from "./sources/adapters/harnesses.ts";
import { collectStatus, formatStatus } from "./status.ts";
import { runValidation } from "./validate.ts";
import { isForensic, searchForensic, searchText, type SearchHit } from "./search/fulltext.ts";
import {
  searchHybrid,
  searchVector,
  VectorSearchUnavailable,
} from "./search/hybrid.ts";
import { rebuildSearchProjection } from "./search/rebuild.ts";
import { backupTimestamp, runLogicalBackup } from "./backup/backup.ts";
import { runRestoreTest } from "./backup/restore-test.ts";
import { runRawVerify } from "./backup/raw-verify.ts";
import { OpenAIEmbeddingProvider } from "./embeddings/openai-provider.ts";
import type { EmbeddingProvider } from "./embeddings/provider.ts";
import {
  activateSpace,
  createSpace,
  getActiveSpace,
  listSpaces,
  type EmbeddingSpace,
} from "./embeddings/spaces.ts";
import {
  cancelPendingJobs,
  embeddingsPlan,
  embeddingsStatus,
  rebuildStaleJobs,
  retryFailedJobs,
  runEmbeddingWorker,
  type ProviderFactory,
} from "./embeddings/jobs.ts";
import { localIdentity } from "./sync/host-identity.ts";
import { ensureLegacySnapshot, migrationInputDir } from "./migration/legacy-snapshot.ts";
import {
  analysisCheckpointPath,
  analyzeLegacySnapshot,
  buildPreflightReport,
  formatPreflightSummary,
  loadAnalysisCheckpoint,
  probeLiveCorpus,
  saveAnalysisCheckpoint,
} from "./migration/preflight.ts";
import { ensureHost } from "./db/repositories/identity.ts";
import { TARGET_TOKENS } from "./search/segmenter.ts";

const program = new Command();

program
  .name("baka")
  .description("Локальный архив AI-диалогов: SurrealDB + immutable raw")
  .version("0.1.0");

function handle<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      console.error(`ошибка: ${error instanceof Error ? error.message : error}`);
      // Жёсткий exit: на путях ошибок могут остаться незакрытые ресурсы
      // (WS-соединение SurrealDB и т.п.), держащие event loop, — тогда
      // exitCode=1 не завершит процесс и зомби удержит sync lock
      // (live acceptance, этап 8).
      process.exit(1);
    }
  };
}

program
  .command("archive:init")
  .description("Создать структуру каталогов архива и sentinel-файл")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      const sentinel = await initArchive(cfg.archiveRoot, {
        namespace: cfg.surrealNamespace,
        database: cfg.surrealDatabase,
      });
      console.log(`архив инициализирован: ${cfg.archiveRoot}`);
      console.log(`archiveId: ${sentinel.archiveId}`);
    }),
  );

program
  .command("discover")
  .description("Обнаружить harness installations и source roots на этой машине")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const report = await discoverSourceRoots({ overrides: cfg.sourceOverrides });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const rows = report.roots.map((r) => [
        r.harness,
        r.enabled ? "ok" : "нет",
        r.sourceKind,
        r.snapshotStrategy,
        r.origin === "override" ? "*" : "",
        r.path,
      ]);
      const header = ["harness", "статус", "kind", "strategy", "", "path"];
      const widths = header.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => r[i]!.length)),
      );
      const line = (cols: string[]) =>
        cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
      console.log(line(header));
      for (const row of rows) console.log(line(row));
      console.log(
        `\nнайдено: ${report.enabled.length}/${report.roots.length} roots (* — переопределено через BAKA_SOURCES__*)`,
      );
    }),
  );

const db = program.command("db").description("Управление SurrealDB");

db.command("preflight")
  .description("Проверить готовность архива к записи")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      const report = await runPreflight(cfg);
      for (const issue of report.issues) {
        console.error(`FAIL [${issue.check}] ${issue.detail}`);
      }
      if (!report.ok) {
        process.exitCode = 1;
        return;
      }
      console.log("preflight: ok");
    }),
  );

db.command("up")
  .description("Поднять SurrealDB (docker compose up)")
  .action(
    handle(async () => {
      await composeUp();
      console.log("SurrealDB запущен: 127.0.0.1:8901");
    }),
  );

db.command("down")
  .description("Остановить SurrealDB (docker compose down)")
  .action(
    handle(async () => {
      await composeDown();
      console.log("SurrealDB остановлен");
    }),
  );

db.command("status")
  .description("Статус контейнера и подключения")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      const status = await composeStatus();
      if (!status) {
        console.log("контейнер: не создан");
        return;
      }
      console.log(`контейнер: ${status.state} (health: ${status.health})`);
      const version = await serverVersion(cfg);
      console.log(`версия сервера: ${version ?? "недоступна"}`);
      if (status.state === "running") {
        try {
          const db = await connectDb(cfg);
          await db.query("RETURN 1");
          const schemaVersion = await checkSchemaVersion(db);
          await db.close();
          console.log("подключение: ok");
          console.log(
            schemaVersion > 0
              ? `версия схемы: ${schemaVersion}`
              : "версия схемы: не инициализирована (baka db migrate)",
          );
        } catch (error) {
          console.error(`подключение: FAIL (${error instanceof Error ? error.message : error})`);
          process.exitCode = 1;
        }
      }
    }),
  );

db.command("migrate")
  .description("Применить недостающие schema migrations (docs/plan.md §6)")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "db migrate");
      try {
        const sentinel = await readSentinel(cfg.archiveRoot);
        const db = await connectDb(cfg);
        try {
          const version = (await serverVersion(cfg)) ?? "unknown";
          const result = await applyMigrations(db, {
            sentinel,
            surrealdbVersion: version,
          });
          if (result.applied.length === 0) {
            console.log(`схема актуальна, версия: ${result.version}`);
          } else {
            console.log(`применены миграции: ${result.applied.join(", ")}`);
            console.log(`версия схемы: ${result.version}`);
          }
        } finally {
          await db.close();
        }
      } finally {
        await release();
      }
    }),
  );

db.command("logs")
  .description("Логи контейнера SurrealDB")
  .option("-n, --tail <lines>", "число строк", "100")
  .action(
    handle(async (options: { tail: string }) => {
      console.log(await composeLogs(Number(options.tail)));
    }),
  );

const disk = program.command("disk").description("Операции с диском архива");

disk
  .command("eject")
  .description("Остановить БД и размонтировать том архива")
  .action(
    handle(async () => {
      const cfg = loadConfig();
      await ejectDisk(cfg.archiveRoot, (message) => console.log(message));
      console.log("диск извлечён");
    }),
  );

program
  .command("sync")
  .description("Structured sync: discovery → snapshot → parse → SurrealDB (docs/plan.md §10)")
  .option("--harness <slug>", `только один harness (${Object.keys(HARNESSES).join(", ")})`)
  .option("--source-root <path>", "только один source root (точный путь)")
  .option("--full-rescan", "игнорировать fingerprint'ы и переснять все файлы")
  .option("--deletion-confirmations <n>", "complete-scan'ов до deleted_in_source", Number)
  .option("--no-enqueue-embeddings", "не создавать embedding jobs")
  .option("--dry-run", "только показать действия, без записи в БД и raw")
  .option("--json", "итоговая сводка в JSON (лог событий — в stderr)")
  .action(
    handle(
      async (options: {
        harness?: string;
        sourceRoot?: string;
        fullRescan?: boolean;
        deletionConfirmations?: number;
        enqueueEmbeddings?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        if (options.harness && !(options.harness in HARNESSES)) {
          throw new Error(`неизвестный harness: ${options.harness}`);
        }
        const cfg = loadConfig();
        const summary = await runSync(cfg, {
          harness: options.harness as HarnessSlug | undefined,
          sourceRoot: options.sourceRoot,
          fullRescan: options.fullRescan,
          deletionConfirmations:
            options.deletionConfirmations && options.deletionConfirmations > 0
              ? options.deletionConfirmations
              : undefined,
          enqueueEmbeddings: options.enqueueEmbeddings,
          dryRun: options.dryRun,
        });
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(`sync: ${summary.status}`);
          for (const [key, value] of Object.entries(summary.counters)) {
            console.log(`  ${key}: ${value}`);
          }
          for (const error of summary.errors) console.error(`  error: ${error}`);
        }
        if (summary.status === "failed") process.exitCode = 1;
      },
    ),
  );

function formatHit(index: number, hit: SearchHit): string {
  const meta = [
    hit.documentType ?? hit.kind,
    hit.segmentNo !== undefined ? `seg ${hit.segmentNo}` : undefined,
    hit.harness,
    hit.host,
    hit.workspace,
    hit.model,
    hit.timestamp,
  ]
    .filter(Boolean)
    .join(" | ");
  const title = hit.dialogueTitle ?? "(без названия)";
  return (
    `[${index + 1}] score ${hit.score.toFixed(3)} — ${title}\n` +
    `    ${meta}\n` +
    `    ${hit.snippet}\n` +
    `    ${hit.dialogueId} ${hit.revisionId}`
  );
}

program
  .command("search <query>")
  .description("Full-text поиск по архиву (docs/plan.md §12, §14)")
  .option("--mode <mode>", "text|vector|hybrid", "text")
  .option("--harness <slug>", "только один harness")
  .option("--host <label|hostname>", "только одна машина")
  .option("--workspace <name>", "только один проект")
  .option("--model <name>", "модель (raw или canonical name)")
  .option("--document-type <type>", "user_prompt|assistant_final")
  .option("--from <date>", "не раньше (ISO date)")
  .option("--to <date>", "не позже (ISO date)")
  .option("--deleted-only", "только диалоги, удалённые из источника")
  .option("--include-reasoning", "forensic: включить thought-чанки (поиск по chunk)")
  .option("--include-tools", "forensic: включить tool_call/tool_result (поиск по chunk)")
  .option("--all-revisions", "forensic: искать по всем revisions, не только current")
  .option("--limit <n>", "максимум результатов", Number)
  .option("--json", "вывести результат в JSON")
  .action(
    handle(
      async (
        query: string,
        options: {
          mode: string;
          harness?: string;
          host?: string;
          workspace?: string;
          model?: string;
          documentType?: string;
          from?: string;
          to?: string;
          deletedOnly?: boolean;
          includeReasoning?: boolean;
          includeTools?: boolean;
          allRevisions?: boolean;
          limit?: number;
          json?: boolean;
        },
      ) => {
        if (!["text", "vector", "hybrid"].includes(options.mode)) {
          console.error(`неизвестный режим: ${options.mode} (text|vector|hybrid)`);
          process.exitCode = 1;
          return;
        }
        const parseDate = (value: string | undefined, flag: string): Date | undefined => {
          if (!value) return undefined;
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) throw new Error(`${flag}: некорректная дата "${value}"`);
          return date;
        };
        const filters = {
          harness: options.harness,
          host: options.host,
          workspace: options.workspace,
          model: options.model,
          documentType: options.documentType,
          from: parseDate(options.from, "--from"),
          to: parseDate(options.to, "--to"),
          deletedOnly: options.deletedOnly ?? false,
          includeReasoning: options.includeReasoning ?? false,
          includeTools: options.includeTools ?? false,
          allRevisions: options.allRevisions ?? false,
          limit: options.limit && options.limit > 0 ? options.limit : 20,
        };
        const cfg = loadConfig();
        const db = await connectDb(cfg);
        try {
          const forensic = isForensic(filters);
          let mode = forensic ? "forensic" : options.mode;
          let hits: SearchHit[];
          if (forensic || options.mode === "text") {
            hits = forensic
              ? await searchForensic(db, query, filters)
              : await searchText(db, query, filters);
          } else {
            // vector/hybrid: нужен active space + OPENAI_API_KEY (§14).
            let provider: EmbeddingProvider | undefined;
            try {
              provider = await vectorProvider(db, cfg);
            } catch (error) {
              if (options.mode === "vector") throw error;
              provider = undefined;
              // Hybrid деградирует в lexical с явным предупреждением (§14).
              console.error(
                `внимание: vector-ранжирование недоступно (${error instanceof Error ? error.message : error}); ` +
                  `hybrid деградировал в text search`,
              );
              mode = "hybrid→text";
            }
            hits = provider
              ? options.mode === "vector"
                ? await searchVector(db, provider, query, filters)
                : await searchHybrid(db, provider, query, filters)
              : await searchText(db, query, filters);
          }
          if (options.json) {
            console.log(JSON.stringify({ mode, query, hits }, null, 2));
            return;
          }
          if (forensic) console.log(`forensic mode (поиск по chunk.content)`);
          if (hits.length === 0) {
            console.log("ничего не найдено");
            return;
          }
          for (const [index, hit] of hits.entries()) console.log(formatHit(index, hit));
        } finally {
          await db.close();
        }
      },
    ),
  );

program
  .command("search:rebuild")
  .description("Пересоздать search projection для всех current revisions (docs/plan.md §8.1)")
  .option("--no-enqueue-embeddings", "не создавать embedding jobs")
  .option("--json", "итоговая сводка в JSON")
  .action(
    handle(async (options: { enqueueEmbeddings?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "search:rebuild");
      const db = await connectDb(cfg);
      try {
        const schemaVersion = await checkSchemaVersion(db);
        if (schemaVersion === 0) {
          throw new Error("схема не инициализирована: сначала baka db migrate");
        }
        const identity = await localIdentity({});
        const hostId = await ensureHost(db, {
          hostUuid: identity.hostUuid,
          hostname: identity.hostname,
          platform: identity.platform,
          arch: identity.arch,
        });
        const summary = await rebuildSearchProjection(db, {
          host: hostId,
          schemaVersion,
          enqueueEmbeddings: options.enqueueEmbeddings ?? true,
          logger: (event) => console.error(JSON.stringify(event)),
        });
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(
            `search:rebuild готов: revisions ${summary.revisions}, search_documents ${summary.searchDocuments}` +
              `, embedding_jobs ${summary.embeddingJobs}, skipped ${summary.skipped}`,
          );
        }
      } finally {
        await db.close();
        await release();
      }
    }),
  );

program
  .command("status")  .description("Сводка состояния архива (docs/plan.md §17.2)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const report = await collectStatus(cfg);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatStatus(report));
    }),
  );

program
  .command("validate")
  .description("Проверка инвариантов архива (docs/plan.md §17.3, §23)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const report = await runValidation(cfg);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.ok) {
        console.log("validate: ok — инварианты соблюдены");
      } else {
        console.log(`validate: ${report.issues.length} проблем(а)`);
        for (const issue of report.issues) {
          console.log(`  [${issue.check}] ${issue.detail}`);
        }
      }
      if (!report.ok) process.exitCode = 1;
    }),
  );

program
  .command("backup")
  .description("Logical backup: HTTP /export → backups/surreal + manifest (docs/plan.md §16.1)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "backup");
      try {
        const result = await runLogicalBackup(cfg);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`export: ${result.exportPath}`);
        console.log(`manifest: ${result.manifestPath}`);
        console.log(
          `schema ${result.manifest.schemaVersion}, surreal ${result.manifest.surrealdbVersion}, ` +
            `${result.manifest.exportBytes} bytes (${result.manifest.compression}), ` +
            `sha256 ${result.manifest.exportSha256.slice(0, 12)}…`,
        );
        const totals = Object.entries(result.manifest.recordCounts)
          .filter(([, n]) => n > 0)
          .map(([t, n]) => `${t} ${n}`)
          .join(", ");
        console.log(`recordCounts: ${totals}`);
      } finally {
        await release();
      }
    }),
  );

program
  .command("restore:test [export]")
  .description(
    "Restore drill в отдельный namespace baka_restore_test (docs/plan.md §16.4); боевой ns не изменяется",
  )
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (exportPath: string | undefined, options: { json?: boolean }) => {
      const cfg = loadConfig();
      const report = await runRestoreTest(cfg, { exportPath });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`restore:test: ${report.exportFile} → ns ${report.namespace}`);
        for (const check of report.checks) {
          console.log(`  ${check.ok ? "ok" : "FAIL"} [${check.name}] ${check.detail}`);
        }
        console.log(report.ok ? "restore:test: ok" : "restore:test: FAIL");
      }
      if (!report.ok) process.exitCode = 1;
    }),
  );

program
  .command("raw:verify")
  .description("Raw manifest по БД и сверка файлов: существование, size, SHA-256 (docs/plan.md §16.2)")
  .option("--manifest", "сохранить manifest в backups/manifests/raw-manifest-<timestamp>.json")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { manifest?: boolean; json?: boolean }) => {
      const cfg = loadConfig();
      const report = await runRawVerify(cfg, { writeManifest: options.manifest ?? false });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`raw:verify: проверено ${report.checked} файлов`);
        for (const item of report.missing) console.log(`  MISSING ${item}`);
        for (const item of report.sizeMismatch) console.log(`  SIZE ${item}`);
        for (const item of report.hashMismatch) console.log(`  HASH ${item}`);
        if (report.orphans.length > 0) {
          console.log(`  внимание: ${report.orphans.length} orphan-файлов (raw без source_revision):`);
          for (const item of report.orphans.slice(0, 20)) console.log(`    ${item}`);
          if (report.orphans.length > 20) console.log(`    … и ещё ${report.orphans.length - 20}`);
        }
        if (report.manifestPath) console.log(`manifest: ${report.manifestPath}`);
        console.log(report.ok ? "raw:verify: ok" : "raw:verify: FAIL");
      }
      if (!report.ok) process.exitCode = 1;
    }),
  );

/** Provider для vector/hybrid search по ACTIVE space; деградация §14. */
async function vectorProvider(db: Surreal, cfg: AppConfig): Promise<EmbeddingProvider> {
  const space = await getActiveSpace(db);
  if (!space) {
    throw new VectorSearchUnavailable(
      "нет active embedding_space (baka embeddings space:create + space:activate)",
    );
  }
  if (!cfg.openaiApiKey) {
    throw new VectorSearchUnavailable("OPENAI_API_KEY не задан");
  }
  return new OpenAIEmbeddingProvider({
    apiKey: cfg.openaiApiKey,
    model: space.model,
    dimensions: space.dimensions,
  });
}

/** ProviderFactory worker'а: model/dimensions берутся из space record. */
function workerProviderFactory(cfg: AppConfig): ProviderFactory {
  return (space: EmbeddingSpace) => {
    if (!cfg.openaiApiKey) {
      throw new Error("OPENAI_API_KEY не задан — worker не может вызвать provider");
    }
    return new OpenAIEmbeddingProvider({
      apiKey: cfg.openaiApiKey,
      model: space.model,
      dimensions: space.dimensions,
    });
  };
}

const embeddings = program
  .command("embeddings")
  .description("Embedding pipeline: spaces, jobs worker, backfill (docs/plan.md §13)");

embeddings
  .command("plan")
  .description("Оценка backfill: документы, токены, storage, цена (read-only, §13.6)")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const plan = await embeddingsPlan(db, cfg.embeddings);
        if (options.json) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }
        const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
        console.log(`документов (извлечённых): ${plan.documents}`);
        console.log(`сегментов (search_documents): ${plan.segments}`);
        console.log(`оценка токенов: ${plan.estimatedTokens}`);
        console.log(`сегментов свыше target ${TARGET_TOKENS}: ${plan.overTarget}`);
        console.log(`pending jobs: ${plan.pendingJobs}`);
        for (const space of plan.spaces) {
          console.log(
            `space ${space.slug}${space.active ? " (active)" : ""}: ${space.dimensions}d, ` +
              `оценка vector storage ${mib(space.estimatedVectorBytes)} (F32, без overhead HNSW)`,
          );
        }
        if (plan.spaces.length === 0) console.log("spaces: нет (baka embeddings space:create)");
        console.log(
          plan.estimatedPriceUsd !== undefined
            ? `цена: $${plan.pricePer1MTokens}/1M токенов → оценка $${plan.estimatedPriceUsd.toFixed(4)}`
            : "цена: не настроена (OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS в .env)",
        );
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("run")
  .description("Worker: lease pending jobs → provider → vectors (§13.6)")
  .option("--limit <n>", "максимум jobs за запуск", Number)
  .option("--space <slug>", "только один embedding space")
  .action(
    handle(async (options: { limit?: number; space?: string }) => {
      const cfg = loadConfig();
      await assertPreflight(cfg);
      const release = await acquireLock(cfg.archiveRoot, "embeddings run");
      const db = await connectDb(cfg);
      try {
        const summary = await runEmbeddingWorker(db, workerProviderFactory(cfg), {
          spaceSlug: options.space,
          limit: options.limit && options.limit > 0 ? options.limit : undefined,
          privacy: cfg.embeddings,
          logger: (event) => console.error(JSON.stringify(event)),
        });
        console.log(
          `embeddings run: completed ${summary.completed}, retryable ${summary.failed}, ` +
            `permanent ${summary.permanentErrors}, privacy-excluded ${summary.privacyExcluded}, ` +
            `stale-lease возвращено ${summary.releasedStale}, prompt tokens ${summary.promptTokens}`,
        );
      } finally {
        await db.close();
        await release();
      }
    }),
  );

embeddings
  .command("status")
  .description("Jobs по статусам и vectors по каждому space")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const statuses = await embeddingsStatus(db);
        if (options.json) {
          console.log(JSON.stringify(statuses, null, 2));
          return;
        }
        if (statuses.length === 0) {
          console.log("embedding spaces: нет");
          return;
        }
        for (const s of statuses) {
          console.log(
            `${s.slug}${s.active ? " (active)" : ""}: ${s.provider}/${s.model} ${s.dimensions}d, ` +
              `vectors ${s.vectors}, jobs: ` +
              (Object.entries(s.jobs).map(([k, v]) => `${k} ${v}`).join(", ") || "—"),
          );
        }
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("retry")
  .description("Вернуть retryable/permanent error jobs в pending (§13.6)")
  .option("--space <slug>", "только один embedding space")
  .action(
    handle(async (options: { space?: string }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const n = await retryFailedJobs(db, options.space);
        console.log(`возвращено в pending: ${n} jobs`);
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("cancel")
  .description("Отменить pending/retryable jobs (status = cancelled)")
  .option("--space <slug>", "только один embedding space")
  .action(
    handle(async (options: { space?: string }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const n = await cancelPendingJobs(db, options.space);
        console.log(`отменено: ${n} jobs`);
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("space:create")
  .description("Создать embedding space + vector-таблицу с HNSW + backfill jobs (§13.1)")
  .option("--slug <slug>", "slug space (по умолчанию <provider>_<model>_<dims>_v1)")
  .option("--provider <name>", "provider", "openai")
  .option("--model <name>", "модель", "text-embedding-3-large")
  .option("--dimensions <n>", "размерность", Number, 1024)
  .option("--activate", "сразу сделать active (прежний active снимается)")
  .action(
    handle(
      async (options: {
        slug?: string;
        provider: string;
        model: string;
        dimensions: number;
        activate?: boolean;
      }) => {
        const cfg = loadConfig();
        await assertPreflight(cfg);
        const release = await acquireLock(cfg.archiveRoot, "embeddings space:create");
        const db = await connectDb(cfg);
        try {
          const result = await createSpace(db, {
            slug: options.slug,
            provider: options.provider,
            model: options.model,
            dimensions: options.dimensions,
            activate: options.activate ?? false,
          });
          console.log(
            `space ${result.space.slug}: таблица ${result.space.physical_table} ` +
              `(HNSW ${result.space.dimensions}d F32 COSINE), backfill jobs: ${result.backfilledJobs}` +
              (result.existingJobs > 0 ? ` (уже было ${result.existingJobs})` : "") +
              (result.space.active ? ", active" : ""),
          );
        } finally {
          await db.close();
          await release();
        }
      },
    ),
  );

embeddings
  .command("space:activate <slug>")
  .description("Сделать space активным (старый space не уничтожается, §13.1)")
  .action(
    handle(async (slug: string) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const space = await activateSpace(db, slug);
        console.log(`active space: ${space.slug}`);
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("space:list")
  .description("Список embedding spaces")
  .option("--json", "вывести результат в JSON")
  .action(
    handle(async (options: { json?: boolean }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const spaces = await listSpaces(db);
        if (options.json) {
          console.log(JSON.stringify(spaces, null, 2));
          return;
        }
        if (spaces.length === 0) {
          console.log("embedding spaces: нет");
          return;
        }
        for (const s of spaces) {
          console.log(
            `${s.slug}${s.active ? " (active)" : ""}: ${s.provider}/${s.model} ${s.dimensions}d ` +
              `${s.distance}/${s.vector_type}, таблица ${s.physical_table}, segmentation v${s.segmentation_version}`,
          );
        }
      } finally {
        await db.close();
      }
    }),
  );

embeddings
  .command("rebuild")
  .description("Stale jobs (смена extraction/segmentation) обратно в pending + удалить их vectors (§13.5)")
  .requiredOption("--space <slug>", "embedding space")
  .action(
    handle(async (options: { space: string }) => {
      const cfg = loadConfig();
      const db = await connectDb(cfg);
      try {
        const summary = await rebuildStaleJobs(db, options.space);
        console.log(
          `rebuild: stale jobs → pending ${summary.resetToPending}, ` +
            `orphan jobs удалено ${summary.orphansDeleted}, stale vectors удалено ${summary.vectorsDeleted}`,
        );
      } finally {
        await db.close();
      }
    }),
  );

const DEFAULT_LEGACY_DB =
  process.env.BAKA_LEGACY_DB?.trim() ||
  "/Volumes/Archive/Legacy Conversations/index.sqlite";

const migration = program
  .command("migration")
  .description("Миграция legacy SQLite-архива (docs/plan.md §15)");

migration
  .command("plan")
  .description(
    "Preflight migration report по snapshot-копии legacy index.sqlite (§15.2/§15.3); ничего не изменяет",
  )
  .option("--legacy-db <path>", "путь к legacy index.sqlite (источник snapshot'а)", DEFAULT_LEGACY_DB)
  .option("--report <path>", "куда писать JSON-отчёт (default: <archive>/backups/manifests/)")
  .option("--skip-live", "не сверять дубликаты с живым корпусом SurrealDB")
  .option("--json", "вывести отчёт в JSON")
  .action(
    handle(
      async (options: {
        legacyDb: string;
        report?: string;
        skipLive?: boolean;
        json?: boolean;
      }) => {
        const cfg = loadConfig();
        console.log(`snapshot legacy SQLite: ${options.legacyDb}`);
        const snapshot = await ensureLegacySnapshot(options.legacyDb, cfg.archiveRoot);
        console.log(
          `snapshot: ${snapshot.snapshotPath} (${snapshot.sizeBytes} bytes, sha256 ${snapshot.sha256.slice(0, 12)}…${snapshot.reused ? ", переиспользован" : ""})`,
        );
        const identity = await localIdentity();
        // Тяжёлый анализ snapshot'а кэшируется checkpoint'ом (ключ — sha256
        // snapshot'а); live probe дешёвый и всегда выполняется заново.
        const checkpointPath = analysisCheckpointPath(
          migrationInputDir(cfg.archiveRoot),
          snapshot.sha256,
        );
        let analysis = await loadAnalysisCheckpoint(checkpointPath, snapshot.sha256, true);
        if (analysis) {
          console.log(`анализ: checkpoint переиспользован (${checkpointPath})`);
        } else {
          console.log("анализ snapshot'а (первый прогон по этому snapshot'у — может занять десятки минут)…");
          analysis = await analyzeLegacySnapshot(snapshot.snapshotPath, identity, {
            snapshotSha256: snapshot.sha256,
          });
          await saveAnalysisCheckpoint(checkpointPath, analysis);
          console.log(`анализ: checkpoint сохранён (${checkpointPath})`);
        }
        const live = options.skipLive ? undefined : await probeLiveCorpus(cfg);
        if (live && !live.available) {
          console.log(`внимание: live corpus probe: ${live.note}`);
        }
        const report = await buildPreflightReport({
          snapshotPath: snapshot.snapshotPath,
          snapshotSha256: snapshot.sha256,
          identity,
          live,
          analysis,
        });
        const reportPath =
          options.report ??
          path.join(
            cfg.archiveRoot,
            "backups",
            "manifests",
            `migration-preflight-${backupTimestamp()}.json`,
          );
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(formatPreflightSummary(report));
        }
        console.log(`отчёт: ${reportPath}`);
        if (!report.reconciliation.ok) process.exitCode = 1;
      },
    ),
  );

await program.parseAsync(process.argv);
