#!/usr/bin/env bun
import { Command } from "commander";
import { loadConfig } from "./config.ts";
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
      process.exitCode = 1;
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

await program.parseAsync(process.argv);
