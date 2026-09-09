import type { AppConfig } from "../config.ts";
import { httpBaseUrl } from "../backup/http.ts";
import { assertProductionDbStorageSafety } from "../db/storage-safety.ts";
import { compose } from "./compose.ts";
import { ensureDockerRuntime } from "./docker-runtime.ts";

export interface SyncDatabaseDependencies {
  fetch?: typeof fetch;
  assertStorage?: typeof assertProductionDbStorageSafety;
  start?: () => Promise<void>;
}

/** Called under the sync lock, before any SDK connection or archive mutation. */
export async function ensureSyncDatabase(
  cfg: AppConfig,
  progress: (detail: string) => void,
  dependencies: SyncDatabaseDependencies = {},
): Promise<void> {
  const base = httpBaseUrl(cfg);
  const fetchImpl = dependencies.fetch ?? fetch;
  const ready = async (): Promise<boolean> => {
    try {
      const response = await fetchImpl(`${base}/health`, {
        signal: AbortSignal.timeout(2_000),
        redirect: "error",
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
  progress("Проверка готовности БД");
  if (await ready()) return;

  const url = new URL(base);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "8901") {
    throw new Error("SurrealDB недоступна; автозапуск разрешён только для локальной БД на порту 8901");
  }
  await (dependencies.assertStorage ?? assertProductionDbStorageSafety)(cfg);
  progress("БД недоступна: подготовка запуска SurrealDB");
  if (dependencies.start) {
    await dependencies.start();
  } else {
    await ensureDockerRuntime(progress);
    progress("Запуск SurrealDB (не более 60 секунд)");
    await compose(
      ["up", "-d", "--wait", "--wait-timeout", "45", "surrealdb"],
      { timeoutMs: 60_000 },
    );
  }
  if (!(await ready())) {
    throw new Error("SurrealDB недоступна после запуска; проверьте bun run db:logs. Повторных запусков не будет");
  }
}
