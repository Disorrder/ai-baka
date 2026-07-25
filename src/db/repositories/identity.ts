/**
 * Identity-репозитории (docs/plan.md §7.1): host, os_account, harness,
 * harness_installation, vendor, model, workspace, workspace_location.
 *
 * Upsert по уникальным ключам схемы: при повторном обнаружении обновляются
 * только "текущие" поля (hostname, last_seen_at и т.п.), first_seen_at
 * сохраняется с первого появления.
 */

import type { RecordId, Surreal } from "surrealdb";
import { selectOne } from "./helpers.ts";

export interface HostInput {
  hostUuid: string;
  hostname: string;
  platform: string;
  arch: string;
  label?: string;
}

export async function ensureHost(db: Surreal, input: HostInput): Promise<RecordId> {
  const now = new Date();
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM host WHERE host_uuid = $uuid LIMIT 1",
    { uuid: input.hostUuid },
  );
  if (existing) {
    await db.query(
      "UPDATE $id SET hostname = $hostname, platform = $platform, arch = $arch, last_seen_at = $now",
      { id: existing.id, hostname: input.hostname, platform: input.platform, arch: input.arch, now },
    );
    return existing.id;
  }
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY host SET host_uuid = $uuid, hostname = $hostname, platform = $platform,
       arch = $arch, label = $label, first_seen_at = $now, last_seen_at = $now`,
    {
      uuid: input.hostUuid,
      hostname: input.hostname,
      platform: input.platform,
      arch: input.arch,
      label: input.label ?? undefined,
      now,
    },
  );
  return created!.id;
}

export interface OsAccountInput {
  host: RecordId;
  osUsername: string;
  homePath: string;
  displayName?: string;
}

export async function ensureOsAccount(db: Surreal, input: OsAccountInput): Promise<RecordId> {
  const now = new Date();
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM os_account WHERE host = $host AND os_username = $username LIMIT 1",
    { host: input.host, username: input.osUsername },
  );
  if (existing) {
    await db.query(
      "UPDATE $id SET home_path = $homePath, last_seen_at = $now",
      { id: existing.id, homePath: input.homePath, now },
    );
    return existing.id;
  }
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY os_account SET host = $host, os_username = $username, home_path = $homePath,
       display_name = $displayName, first_seen_at = $now, last_seen_at = $now`,
    {
      host: input.host,
      username: input.osUsername,
      homePath: input.homePath,
      displayName: input.displayName ?? undefined,
      now,
    },
  );
  return created!.id;
}

export interface HarnessInput {
  slug: string;
  displayName: string;
  /** source_kind harness'а (file_tree, sqlite, ...). */
  kind: string;
}

export async function ensureHarness(db: Surreal, input: HarnessInput): Promise<RecordId> {
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM harness WHERE slug = $slug LIMIT 1",
    { slug: input.slug },
  );
  if (existing) {
    await db.query("UPDATE $id SET display_name = $displayName, kind = $kind", {
      id: existing.id,
      displayName: input.displayName,
      kind: input.kind,
    });
    return existing.id;
  }
  const created = await selectOne<{ id: RecordId }>(
    db,
    "CREATE ONLY harness SET slug = $slug, display_name = $displayName, kind = $kind",
    { slug: input.slug, displayName: input.displayName, kind: input.kind },
  );
  return created!.id;
}

export interface HarnessInstallationInput {
  host: RecordId;
  harness: RecordId;
  installed: boolean;
  detectedVersion?: string;
}

export async function ensureHarnessInstallation(
  db: Surreal,
  input: HarnessInstallationInput,
): Promise<RecordId> {
  const now = new Date();
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM harness_installation WHERE host = $host AND harness = $harness LIMIT 1",
    { host: input.host, harness: input.harness },
  );
  if (existing) {
    await db.query(
      `UPDATE $id SET installed = $installed, detected_version = $version, last_detected_at = $now`,
      {
        id: existing.id,
        installed: input.installed,
        version: input.detectedVersion ?? undefined,
        now,
      },
    );
    return existing.id;
  }
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY harness_installation SET host = $host, harness = $harness, installed = $installed,
       detected_version = $version, first_seen_at = $now, last_detected_at = $now`,
    {
      host: input.host,
      harness: input.harness,
      installed: input.installed,
      version: input.detectedVersion ?? undefined,
      now,
    },
  );
  return created!.id;
}

const VENDOR_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  alibaba: "Alibaba",
  google: "Google",
  meta: "Meta",
  moonshot: "Moonshot AI",
  unknown: "Unknown",
};

export async function ensureVendor(db: Surreal, slug: string): Promise<RecordId> {
  const now = new Date();
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM vendor WHERE slug = $slug LIMIT 1",
    { slug },
  );
  if (existing) {
    await db.query("UPDATE $id SET last_seen_at = $now", { id: existing.id, now });
    return existing.id;
  }
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY vendor SET slug = $slug, display_name = $displayName,
       first_seen_at = $now, last_seen_at = $now`,
    { slug, displayName: VENDOR_DISPLAY_NAMES[slug] ?? slug, now },
  );
  return created!.id;
}

/**
 * Upsert модели по (vendor, canonical_name); raw-имя добавляется в aliases,
 * если встречено впервые (план §7.1 `model`).
 */
export async function ensureModel(
  db: Surreal,
  input: { vendor: RecordId; canonicalName: string; rawName?: string },
): Promise<RecordId> {
  const now = new Date();
  const existing = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM model WHERE vendor = $vendor AND canonical_name = $name LIMIT 1",
    { vendor: input.vendor, name: input.canonicalName },
  );
  if (existing) {
    await db.query(
      "UPDATE $id SET last_seen_at = $now, aliases = array::union(aliases, [$raw])",
      { id: existing.id, now, raw: input.rawName ?? input.canonicalName },
    );
    return existing.id;
  }
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY model SET vendor = $vendor, canonical_name = $name, aliases = [$raw],
       first_seen_at = $now, last_seen_at = $now`,
    {
      vendor: input.vendor,
      name: input.canonicalName,
      raw: input.rawName ?? input.canonicalName,
      now,
    },
  );
  return created!.id;
}

export interface WorkspaceInput {
  host: RecordId;
  path?: string;
  name?: string;
  repositoryIdentity?: string;
}

function normalizeWorkspacePath(p: string): string {
  // v1: только синтаксическая нормализация (без realpath/регистра).
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : p;
}

/**
 * Workspace диалога (план §7.1): repository_identity — главный ключ
 * логического проекта; без него проект определяется через
 * workspace_location (host, normalized_path). По голому name проекты
 * НЕ мержатся (разные проекты могут совпадать по имени).
 *
 * Конфликт ключей (path указывает на один workspace, repository_identity —
 * на другой) разрешается детерминированно: побеждает repository_identity
 * (главный ключ проекта), location перелинковывается на него.
 *
 * Создание workspace + workspace_location — ОДНА транзакция (один query
 * BEGIN…COMMIT): orphan workspace при сбое между двумя query невозможен.
 */
export async function ensureWorkspace(
  db: Surreal,
  input: WorkspaceInput,
): Promise<RecordId | undefined> {
  if (!input.path && !input.repositoryIdentity) return undefined;
  const now = new Date();

  let workspaceId: RecordId | undefined;
  if (input.repositoryIdentity) {
    const existing = await selectOne<{ id: RecordId }>(
      db,
      "SELECT id FROM workspace WHERE repository_identity = $repo LIMIT 1",
      { repo: input.repositoryIdentity },
    );
    if (existing) workspaceId = existing.id;
  }

  const normalizedPath = input.path ? normalizeWorkspacePath(input.path) : undefined;
  const location = normalizedPath
    ? await selectOne<{ id: RecordId; workspace: RecordId }>(
        db,
        "SELECT id, workspace FROM workspace_location WHERE host = $host AND normalized_path = $path LIMIT 1",
        { host: input.host, path: normalizedPath },
      )
    : undefined;

  if (location) {
    // repository_identity побеждает path: при конфликте location
    // перелинковывается на workspace, найденный по repository_identity.
    const target = workspaceId ?? location.workspace;
    await db.query("UPDATE $id SET workspace = $ws, last_seen_at = $now", {
      id: location.id,
      ws: target,
      now,
    });
    if (workspaceId) {
      await db.query("UPDATE $id SET last_seen_at = $now", { id: workspaceId, now });
    }
    return target;
  }

  if (workspaceId) {
    await db.query("UPDATE $id SET last_seen_at = $now", { id: workspaceId, now });
    if (normalizedPath && input.path) {
      await db.query(
        `CREATE ONLY workspace_location SET workspace = $workspace, host = $host, path = $path,
           normalized_path = $normalized, git_remote = $remote, first_seen_at = $now, last_seen_at = $now`,
        {
          workspace: workspaceId,
          host: input.host,
          path: input.path,
          normalized: normalizedPath,
          remote: input.repositoryIdentity ?? undefined,
          now,
        },
      );
    }
    return workspaceId;
  }

  const fallbackName =
    input.name ??
    (normalizedPath ? (normalizedPath.split("/").pop() || normalizedPath) : undefined) ??
    input.repositoryIdentity ??
    "unknown";

  // Ни workspace, ни location: создаём обе записи одной транзакцией.
  if (normalizedPath && input.path) {
    const result = await db.query<unknown[]>(
      `BEGIN;
       LET $ws = (CREATE ONLY workspace SET name = $name, repository_identity = $repo,
         first_seen_at = $now, last_seen_at = $now).id;
       CREATE ONLY workspace_location SET workspace = $ws, host = $host, path = $path,
         normalized_path = $normalized, git_remote = $repo,
         first_seen_at = $now, last_seen_at = $now;
       COMMIT;
       RETURN $ws;`,
      {
        name: fallbackName,
        repo: input.repositoryIdentity ?? undefined,
        host: input.host,
        path: input.path,
        normalized: normalizedPath,
        now,
      },
    );
    const returned = result.at(-1) as RecordId | undefined;
    if (!returned) {
      // Защита от молчаливого обрыва транзакции (как в corpus.ts).
      throw new Error(
        `workspace transaction оборвалась: RETURN не выполнен (получено ${result.length} результатов)`,
      );
    }
    return returned;
  }

  // Только repository_identity, без path — одиночный CREATE.
  const created = await selectOne<{ id: RecordId }>(
    db,
    `CREATE ONLY workspace SET name = $name, repository_identity = $repo,
       first_seen_at = $now, last_seen_at = $now`,
    { name: fallbackName, repo: input.repositoryIdentity ?? undefined, now },
  );
  return created!.id;
}
