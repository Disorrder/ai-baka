import { HARNESSES, HARNESS_ORDER, type HarnessSlug } from "./sources/adapters/harnesses.ts";
import { parseSourceOverride } from "./sources/discovery/discovery.ts";

export interface AppConfig {
  /** Корень архива (BAKA_ARCHIVE_ROOT). Обязателен. */
  archiveRoot: string;
  surrealUrl: string;
  surrealUser: string;
  surrealPass: string;
  surrealNamespace: string;
  surrealDatabase: string;
  /** Если задан — preflight сверяет UUID sentinel-файла. */
  expectedArchiveId?: string;
  minFreeBytes: number;
  deletionConfirmations: number;
  /**
   * Переопределённые source roots (BAKA_SOURCES__<SLUG>, пути через запятую).
   * Отсутствие ключа — используются дефолтные пути harness'а.
   */
  sourceOverrides: Partial<Record<HarnessSlug, string[]>>;
}

const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const DEFAULT_DELETION_CONFIRMATIONS = 2;

export class ConfigError extends Error {}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const archiveRoot = optional(env, "BAKA_ARCHIVE_ROOT");
  if (!archiveRoot) {
    throw new ConfigError("BAKA_ARCHIVE_ROOT не задан (см. .env.example)");
  }
  const home = env.HOME ?? process.env.HOME ?? "";
  const sourceOverrides: Partial<Record<HarnessSlug, string[]>> = {};
  for (const slug of HARNESS_ORDER) {
    const raw = optional(env, HARNESSES[slug].envOverride);
    if (raw) sourceOverrides[slug] = parseSourceOverride(raw, home);
  }
  return {
    archiveRoot,
    surrealUrl: optional(env, "SURREAL_URL") ?? "ws://127.0.0.1:8901/rpc",
    surrealUser: optional(env, "SURREAL_USER") ?? "root",
    surrealPass: optional(env, "SURREAL_PASS") ?? "root",
    surrealNamespace: optional(env, "SURREAL_NAMESPACE") ?? "baka",
    surrealDatabase: optional(env, "SURREAL_DATABASE") ?? "archive",
    expectedArchiveId: optional(env, "BAKA_ARCHIVE_ID"),
    minFreeBytes: Number(env.BAKA_MIN_FREE_BYTES) || DEFAULT_MIN_FREE_BYTES,
    deletionConfirmations:
      Number(env.BAKA_DELETION_CONFIRMATIONS) || DEFAULT_DELETION_CONFIRMATIONS,
    sourceOverrides,
  };
}
