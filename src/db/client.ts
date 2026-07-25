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
export async function connectDb(cfg: AppConfig): Promise<Surreal> {
  const db = new Surreal();
  try {
    await db.connect(cfg.surrealUrl);
    await db.signin({ username: cfg.surrealUser, password: cfg.surrealPass });
    await db.use({ namespace: cfg.surrealNamespace, database: cfg.surrealDatabase });
  } catch (error) {
    // Иначе открытый WS (connect прошёл, signin/use упали) держит event loop
    // и CLI не завершается после фатальной ошибки (live acceptance, этап 8).
    await db.close().catch(() => {});
    throw error;
  }
  const refresh = setInterval(() => {
    // Ошибка refresh'а не фатальна: следующий tick или переподключение команды.
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
