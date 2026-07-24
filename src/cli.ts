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
          await db.close();
          console.log("подключение: ok");
        } catch (error) {
          console.error(`подключение: FAIL (${error instanceof Error ? error.message : error})`);
          process.exitCode = 1;
        }
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
