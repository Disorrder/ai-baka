import type { Command } from "commander";
import type { Surreal } from "surrealdb";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { HARNESSES, HARNESS_ORDER } from "../sources/adapters/harnesses.ts";
import { loadConfig } from "../config.ts";
import { connectDb } from "../db/client.ts";
import { ExportConfigError, FILTERS, exportDiscovery, resolveExportConfig } from "./config.ts";
import { gitHead } from "../db/migrations.ts";
import { createSurrealExportSource } from "./source.ts";
import { exportSqlite } from "./index.ts";
import { createSqliteExportProgress } from "./progress.ts";
import type { SqliteExportProgressDisplay } from "./progress.ts";
import { SqliteExportFailure } from "./errors.ts";

export function registerSqliteExport(program: Command): void {
  const command = program.command("export:sqlite")
    .description("Readonly canonical export в переносимый аналитический SQLite; не raw backup")
    .option("--out <path>", "новый .sqlite файл (каталог должен существовать)")
    .option("--force", "атомарно заменить существующий regular export после проверки")
    .option("--dry-run", "прочитать и оценить срез без итоговой базы")
    .option("--discover", "показать допустимые поля и фильтры без подключения к БД")
    .option("--config <path>", "JSON конфигурация; явные CLI flags имеют приоритет")
    .option("--preset <name>", "qa-analysis|conversation|tools|instructions|full-canonical")
    .option("--categories <list>", "категории через запятую; reasoning = thought")
    .option("--instructions <mode>", "exclude|separate")
    .option("--unknown-policy <mode>", "metadata|separate|include")
    .option("--match-scope <scope>", "turn|dialogue|message")
    .option("--revisions <mode>", "current|all ready revisions")
    .option("--after <UTC>", "message timestamp >= ISO UTC Z")
    .option("--before <UTC>", "message timestamp < ISO UTC Z")
    .option("--fields <list>", "whitelist optional fields через запятую, массив заменяется")
    .option("--exclude-fields <list>", "исключить optional fields; обязательные ключи неизменны")
    .option("--batch-size <number>", "размер keyset batch")
    .option("--max-revision-bytes <number>", "явный предел сборки одной ревизии");
  for (const filter of FILTERS) {
    const flag = filter.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
    command.option(`--${flag} <values>`, `${filter}: OR значения через запятую; AND между фильтрами`);
    // Commander interprets --no-* specially, hence an explicit value-bearing exclusion prefix.
    command.option(`--exclude-${flag} <values>`, `исключить ${filter}, любое совпадение запрещено`);
  }
  command.action(async (options: Record<string, unknown>) => {
    let db: Surreal | undefined;
    let progress: SqliteExportProgressDisplay | undefined;
    const abort = new AbortController();
    const onSignal = () => {
      abort.abort(new Error("sqlite export cancelled"));
      progress?.stop();
    };
    try {
      if (options.discover) { console.log(JSON.stringify(exportDiscovery(), null, 2)); return; }
      const configFile: unknown = options.config ? JSON.parse(await readFile(String(options.config), "utf8")) : {};
      const overrides: Record<string, unknown> = {};
      for (const key of ["preset", "instructions", "unknownPolicy", "matchScope", "revisions", "after", "before"]) if (options[key] !== undefined) overrides[key] = options[key];
      for (const key of ["batchSize", "maxRevisionBytes"]) if (options[key] !== undefined) overrides[key] = Number(options[key]);
      for (const key of ["fields", "excludeFields", "categories"]) if (options[key] !== undefined) overrides[key] = String(options[key]).split(",").filter(Boolean);
      for (const [prefix, configKey] of [["", "filters"], ["exclude", "excludeFilters"]]) {
        const filters: Record<string, string[]> = {};
        for (const filter of FILTERS) {
          const key = prefix ? `${prefix}${filter[0]!.toUpperCase()}${filter.slice(1)}` : filter;
          if (options[key] !== undefined) filters[filter] = String(options[key]).split(",").filter(Boolean);
        }
        overrides[configKey!] = filters;
      }
      const config = resolveExportConfig(configFile, overrides);
      if (!options.dryRun && !options.out) throw new Error("export:sqlite требует --out или --dry-run");
      const app = loadConfig();
      progress = createSqliteExportProgress(config, options.dryRun === true);
      process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
      db = await connectDb(app, { failFast: true });
      const report = await exportSqlite(createSurrealExportSource(db, app.surrealUrl), config, {
        out: typeof options.out === "string" ? options.out : undefined,
        force: options.force === true, dryRun: options.dryRun === true, signal: abort.signal,
        exporterCommit: gitHead(),
        protectedPaths: [app.dbRoot, app.archiveRoot, ...HARNESS_ORDER.flatMap(slug => app.sourceOverrides[slug] ?? HARNESSES[slug].defaultRoots({ home: os.homedir(), env: process.env }))],
        progress: progress.update,
      });
      progress.stop();
      console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      progress?.stop();
      // Query, SDK, file and source errors may contain private paths, bindings or content.
      const message = error instanceof ExportConfigError || error instanceof SqliteExportFailure
        ? error.message : new SqliteExportFailure("setup", error).message;
      process.stderr.write(`${message}\n`); process.exitCode = 1;
    } finally {
      progress?.stop();
      process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
      await db?.close();
    }
  });
}
