/**
 * Discovery: обнаружение harness installations и source roots на текущей
 * машине (docs/plan.md §10.1 п.7, docs/sources.md).
 *
 * Дефолтные пути берутся из HARNESSES; полностью переопределяются для
 * конкретного harness'а через env `BAKA_SOURCES__<SLUG>` (список путей через
 * запятую) или параметр `overrides`. Для kimi-code учитывается KIMI_CODE_HOME.
 *
 * Root, которого нет на диске, попадает в отчёт с `enabled: false`,
 * но не в список `enabled`.
 */

import { homedir } from "node:os";
import { lstat } from "node:fs/promises";
import {
  HARNESSES,
  HARNESS_ORDER,
  type HarnessSlug,
  type SnapshotStrategy,
  type SourceKind,
} from "../adapters/harnesses.ts";

export interface DiscoveredSourceRoot {
  harness: HarnessSlug;
  path: string;
  sourceKind: SourceKind;
  snapshotStrategy: SnapshotStrategy;
  /** true, если путь существует на диске и участвует в sync. */
  enabled: boolean;
  origin: "default" | "override";
}

export interface DiscoveryReport {
  roots: DiscoveredSourceRoot[];
  enabled: DiscoveredSourceRoot[];
  missing: DiscoveredSourceRoot[];
}

export interface DiscoverOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Явные root'ы по harness'ам (имеют приоритет над env). */
  overrides?: Partial<Record<HarnessSlug, string[]>>;
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

/** Разбор значения `BAKA_SOURCES__<SLUG>`: пути через запятую, `~` разворачивается. */
export function parseSourceOverride(value: string, home: string): string[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => expandTilde(p, home));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function discoverSourceRoots(
  options: DiscoverOptions = {},
): Promise<DiscoveryReport> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const roots: DiscoveredSourceRoot[] = [];

  for (const slug of HARNESS_ORDER) {
    const def = HARNESSES[slug];
    const override =
      options.overrides?.[slug] ??
      (env[def.envOverride]?.trim()
        ? parseSourceOverride(env[def.envOverride] as string, home)
        : undefined);
    const paths = (override !== undefined ? override : def.defaultRoots({ home, env }))
      .map((p) => expandTilde(p, home));
    for (const p of paths) {
      const exists = await pathExists(p);
      roots.push({
        harness: slug,
        path: p,
        sourceKind: def.sourceKind,
        snapshotStrategy: def.snapshotStrategy,
        enabled: exists,
        origin: override !== undefined ? "override" : "default",
      });
    }
  }

  return {
    roots,
    enabled: roots.filter((r) => r.enabled),
    missing: roots.filter((r) => !r.enabled),
  };
}
