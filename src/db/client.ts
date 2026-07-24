import { Surreal } from "surrealdb";
import type { AppConfig } from "../config.ts";

/** Подключается к SurrealDB и выбирает namespace/database из конфига. */
export async function connectDb(cfg: AppConfig): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(cfg.surrealUrl);
  await db.signin({ username: cfg.surrealUser, password: cfg.surrealPass });
  await db.use({ namespace: cfg.surrealNamespace, database: cfg.surrealDatabase });
  return db;
}

/** Версия сервера SurrealDB через HTTP endpoint /version, null если недоступен. */
export async function serverVersion(cfg: AppConfig): Promise<string | null> {
  const httpUrl = cfg.surrealUrl
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://")
    .replace(/\/rpc\/?$/, "");
  try {
    const response = await fetch(`${httpUrl}/version`);
    if (!response.ok) return null;
    return (await response.text()).trim();
  } catch {
    return null;
  }
}
