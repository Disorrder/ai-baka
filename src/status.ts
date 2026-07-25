/**
 * `baka status` (docs/plan.md §17.2) — сводка состояния архива.
 * Реализована часть, достижимая на этапе 5: identity, provenance, corpus,
 * search projection, embedding jobs, размеры raw/ и db/, последний sync.
 * Backup/restore/migration reconciliation — поздние этапы (пока "—").
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "./config.ts";
import { connectDb } from "./db/client.ts";
import { selectAll, selectOne } from "./db/repositories/helpers.ts";

async function count(db: Surreal, table: string, where?: string): Promise<number> {
  const row = await selectOne<{ n: number }>(
    db,
    `SELECT count() AS n FROM ${table}${where ? ` WHERE ${where}` : ""} GROUP ALL`,
  );
  return row?.n ?? 0;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

export interface StatusReport {
  hosts: number;
  osAccounts: number;
  harnessInstallations: number;
  sourceRoots: number;
  locations: { active: number; missing: number; deleted_in_source: number };
  sourceRevisions: number;
  parseErrors: number;
  unresolvedIngestErrors: number;
  dialogues: number;
  dialogueRevisions: number;
  dialoguesWithoutCurrent: number;
  messages: number;
  chunks: number;
  searchDocuments: number;
  embeddingSpaces: number;
  embeddingJobs: Record<string, number>;
  rawBytes: number;
  dbBytes: number;
  lastSync?: { id: string; status: string; startedAt: string; finishedAt?: string };
}

export async function collectStatus(cfg: AppConfig): Promise<StatusReport> {
  const db = await connectDb(cfg);
  try {
    const jobs: Record<string, number> = {};
    for (const row of await selectAll<{ status: string; n: number }>(
      db,
      "SELECT status, count() AS n FROM embedding_job GROUP BY status",
    )) {
      jobs[row.status] = row.n;
    }
    const lastSync = await selectOne<{
      id: unknown;
      status: string;
      started_at: Date;
      finished_at?: Date;
    }>(
      db,
      "SELECT id, status, started_at, finished_at FROM sync_run WHERE kind = 'live_sync' ORDER BY started_at DESC LIMIT 1",
    );
    return {
      hosts: await count(db, "host"),
      osAccounts: await count(db, "os_account"),
      harnessInstallations: await count(db, "harness_installation"),
      sourceRoots: await count(db, "source_root"),
      locations: {
        active: await count(db, "source_location", "presence_status = 'active'"),
        missing: await count(db, "source_location", "presence_status = 'missing'"),
        deleted_in_source: await count(db, "source_location", "presence_status = 'deleted_in_source'"),
      },
      sourceRevisions: await count(db, "source_revision"),
      parseErrors: await count(db, "source_revision", "parse_status = 'parse_error'"),
      unresolvedIngestErrors: await count(db, "ingest_error", "resolved_at IS NONE"),
      dialogues: await count(db, "dialogue"),
      dialogueRevisions: await count(db, "dialogue_revision"),
      dialoguesWithoutCurrent: await count(db, "dialogue", "current_revision IS NONE"),
      messages: await count(db, "message"),
      chunks: await count(db, "chunk"),
      searchDocuments: await count(db, "search_document"),
      embeddingSpaces: await count(db, "embedding_space"),
      embeddingJobs: jobs,
      rawBytes: await dirSize(path.join(cfg.archiveRoot, "raw")),
      dbBytes: await dirSize(path.join(cfg.archiveRoot, "db")),
      lastSync: lastSync
        ? {
            id: String(lastSync.id),
            status: lastSync.status,
            startedAt: lastSync.started_at.toISOString(),
            finishedAt: lastSync.finished_at?.toISOString(),
          }
        : undefined,
    };
  } finally {
    await db.close();
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GiB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(2)} MiB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(2)} KiB`;
  return `${bytes} B`;
}

export function formatStatus(report: StatusReport): string {
  const lines = [
    `hosts: ${report.hosts}, os_accounts: ${report.osAccounts}, harness_installations: ${report.harnessInstallations}`,
    `source_roots: ${report.sourceRoots}`,
    `locations: active ${report.locations.active}, missing ${report.locations.missing}, deleted_in_source ${report.locations.deleted_in_source}`,
    `source_revisions: ${report.sourceRevisions} (parse_error: ${report.parseErrors}, unresolved ingest_error: ${report.unresolvedIngestErrors})`,
    `dialogues: ${report.dialogues} (без current_revision: ${report.dialoguesWithoutCurrent}), dialogue_revisions: ${report.dialogueRevisions}`,
    `messages: ${report.messages}, chunks: ${report.chunks}`,
    `search_documents: ${report.searchDocuments}`,
    `embedding_spaces: ${report.embeddingSpaces}`,
    `embedding_jobs: ${Object.entries(report.embeddingJobs).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`,
    `raw size: ${formatBytes(report.rawBytes)}, RocksDB size: ${formatBytes(report.dbBytes)}`,
    report.lastSync
      ? `last sync: ${report.lastSync.status} @ ${report.lastSync.startedAt} (${report.lastSync.id})`
      : "last sync: —",
    `last backup: — (этап 12), last restore test: — (этап 12), migration reconciliation: — (этап 9)`,
  ];
  return lines.join("\n");
}
