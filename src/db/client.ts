import { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";
import { httpBaseUrl } from "../backup/http.ts";

/**
 * Токен сессии SurrealDB живёт ~1 час; длительные команды требуют обновления
 * авторизации. Периодический повторный signin на том же соединении продлевает
 * сессию без разрыва соединения.
 */
const AUTH_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/** Подключается к SurrealDB и выбирает namespace/database из конфига. */
export async function connectDb(cfg: AppConfig, options: { failFast?: boolean } = {}): Promise<Surreal> {
  const db = new Surreal();
  let timer: NodeJS.Timeout | undefined;
  try {
    const connect = async () => {
      await db.connect(cfg.surrealUrl, options.failFast ? { reconnect: false } : undefined);
      await db.signin({ username: cfg.surrealUser, password: cfg.surrealPass });
      await db.use({ namespace: cfg.surrealNamespace, database: cfg.surrealDatabase });
    };
    if (options.failFast) {
      await Promise.race([
        connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("SurrealDB: подключение не завершилось за 10 секунд")), 10_000);
        }),
      ]);
    } else {
      await connect();
    }
  } catch (error) {
    // Close failed connections so neither sockets nor SDK retries outlive the command.
    await db.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const refresh = setInterval(() => {
    db.signin({ username: cfg.surrealUser, password: cfg.surrealPass }).catch(() => {});
  }, AUTH_REFRESH_INTERVAL_MS);
  refresh.unref();
  const originalClose = db.close.bind(db);
  db.close = async (): Promise<true> => {
    clearInterval(refresh);
    await originalClose();
    return true;
  };
  return db;
}

/** Версия сервера SurrealDB через HTTP endpoint /version, null если недоступен. */
export async function serverVersion(cfg: AppConfig): Promise<string | null> {
  try {
    const response = await fetch(`${httpBaseUrl(cfg)}/version`);
    if (!response.ok) return null;
    return (await response.text()).trim();
  } catch {
    return null;
  }
}
