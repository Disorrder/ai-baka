/**
 * Идентичность текущей машины и OS-аккаунта (docs/plan.md §7.1, §10.1 п.6).
 *
 * host UUID хранится в `${XDG_CONFIG_HOME:-~/.config}/baka/host-id`,
 * создаётся при первом обращении. hostname НЕ является identity.
 */

import { hostname, userInfo, platform, arch } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function hostIdFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(userInfo().homedir, ".config");
  return path.join(configHome, "baka", "host-id");
}

/** Читает или создаёт стабильный host UUID. */
export async function ensureHostId(filePath: string = hostIdFilePath()): Promise<string> {
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // файла нет — создаём ниже
  }
  const uuid = crypto.randomUUID();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${uuid}\n`, { mode: 0o600 });
  return uuid;
}

export interface LocalIdentity {
  hostUuid: string;
  hostname: string;
  platform: string;
  arch: string;
  osUsername: string;
  homePath: string;
}

export async function localIdentity(
  options: { hostIdPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LocalIdentity> {
  const info = userInfo();
  return {
    hostUuid: await ensureHostId(options.hostIdPath ?? hostIdFilePath(options.env)),
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    osUsername: info.username,
    homePath: info.homedir,
  };
}
