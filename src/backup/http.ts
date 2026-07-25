/**
 * HTTP helpers для backup/restore: SurrealDB HTTP API (/export, /import, /sql).
 * Basic auth root-уровня; namespace/database передаются заголовками
 * `surreal-ns`/`surreal-db` (заголовок `NS` в 3.x не работает).
 */

import type { AppConfig } from "../config.ts";

/** Базовый HTTP URL сервера (ws://…/rpc → http://…). */
export function httpBaseUrl(cfg: AppConfig): string {
  return cfg.surrealUrl
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://")
    .replace(/\/rpc\/?$/, "");
}

function basicAuth(cfg: AppConfig): string {
  return `Basic ${Buffer.from(`${cfg.surrealUser}:${cfg.surrealPass}`).toString("base64")}`;
}

export function httpHeaders(
  cfg: AppConfig,
  namespace: string,
  database: string,
): Record<string, string> {
  return {
    Authorization: basicAuth(cfg),
    "surreal-ns": namespace,
    "surreal-db": database,
  };
}

/** Statement уровня сервера (DEFINE/REMOVE NAMESPACE) без выбранного ns/db. */
export async function sqlRoot(cfg: AppConfig, statement: string): Promise<void> {
  const response = await fetch(`${httpBaseUrl(cfg)}/sql`, {
    method: "POST",
    headers: { Authorization: basicAuth(cfg), Accept: "application/json" },
    body: statement,
  });
  if (!response.ok) {
    throw new Error(`sql: HTTP ${response.status}: ${await response.text()}`);
  }
  const results = (await response.json()) as { status: string; result?: unknown; detail?: string }[];
  for (const result of results) {
    if (result.status !== "OK") {
      throw new Error(`sql: ${result.status}: ${result.detail ?? JSON.stringify(result.result)}`);
    }
  }
}
