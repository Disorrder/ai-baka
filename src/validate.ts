/**
 * `baka validate` (docs/plan.md §17.3) — проверки инвариантов (§23).
 *
 * Реализовано на этапе 5:
 * - orphan raw files (raw без source_revision; detect-часть doctor'а,
 *   сценарий §19.2 №12);
 * - source_revision без raw-файла + hash mismatch (инвариант №2);
 * - dialogue без current_revision;
 * - current revision не в статусе ready (инвариант №5);
 * - duplicate identity keys;
 * - message/chunk sequence collisions (инварианты №6–7);
 * - search_document не из current revision (инвариант №10);
 * - unknown schema version.
 * Embedding-проверки (dimension mismatch, job без vector и т.п.) — этап 7,
 * migration quarantine — этап 9.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { AppConfig } from "./config.ts";
import { connectDb } from "./db/client.ts";
import { checkSchemaVersion, listMigrations } from "./db/migrations.ts";
import { selectAll } from "./db/repositories/helpers.ts";
import { hashFile } from "./sources/snapshot/hashing.ts";

export interface ValidationIssue {
  check: string;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

async function listRawFiles(rawDir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(rawDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // AppleDouble-артефакты Finder на внешнем диске — не данные архива
    // (scanner игнорирует их так же).
    if (entry.name.startsWith("._")) continue;
    const full = path.join(rawDir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await listRawFiles(full)) out.push(nested);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export async function runValidation(cfg: AppConfig): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  const db = await connectDb(cfg);
  try {
    // unknown schema version
    const schemaVersion = await checkSchemaVersion(db);
    const maxKnown = Math.max(0, ...(await listMigrations()).map((m) => m.version));
    if (schemaVersion > maxKnown) {
      issues.push({
        check: "unknown_schema_version",
        detail: `в БД версия ${schemaVersion}, код знает до ${maxKnown}`,
      });
    }

    // source_revision ↔ raw file (существование + hash)
    const revisions = await selectAll<{ id: unknown; sha256: string; raw_archive_path: string }>(
      db,
      "SELECT id, sha256, raw_archive_path FROM source_revision",
    );
    const referencedRaw = new Set<string>();
    for (const rev of revisions) {
      const absolute = path.join(cfg.archiveRoot, rev.raw_archive_path);
      referencedRaw.add(path.normalize(absolute));
      try {
        const hashes = await hashFile(absolute);
        if (hashes.sha256 !== rev.sha256) {
          issues.push({
            check: "hash_mismatch",
            detail: `${rev.raw_archive_path}: в БД ${rev.sha256.slice(0, 12)}…, на диске ${hashes.sha256.slice(0, 12)}…`,
          });
        }
      } catch {
        issues.push({
          check: "missing_raw_file",
          detail: `${rev.raw_archive_path} (source_revision ${String(rev.id)})`,
        });
      }
    }

    // orphan raw files
    for (const file of await listRawFiles(path.join(cfg.archiveRoot, "raw"))) {
      if (!referencedRaw.has(path.normalize(file))) {
        issues.push({
          check: "orphan_raw_file",
          detail: path.relative(cfg.archiveRoot, file),
        });
      }
    }

    // dialogue без current_revision
    for (const row of await selectAll<{ identity_key: string }>(
      db,
      "SELECT identity_key FROM dialogue WHERE current_revision IS NONE",
    )) {
      issues.push({ check: "dialogue_without_current", detail: row.identity_key });
    }

    // current revision не ready
    for (const row of await selectAll<{ identity_key: string; status: string }>(
      db,
      "SELECT identity_key, current_revision.status AS status FROM dialogue WHERE current_revision IS NOT NONE AND current_revision.status != 'ready'",
    )) {
      issues.push({
        check: "current_revision_not_ready",
        detail: `${row.identity_key} (status: ${row.status})`,
      });
    }

    // duplicate identity keys (unique index не даёт, но проверка обязательна)
    for (const row of await selectAll<{ identity_key: string; n: number }>(
      db,
      "SELECT identity_key, count() AS n FROM dialogue GROUP BY identity_key",
    )) {
      if (row.n > 1) {
        issues.push({ check: "duplicate_identity_key", detail: `${row.identity_key} ×${row.n}` });
      }
    }

    // message sequence collisions
    for (const row of await selectAll<{ dialogue_revision: unknown; sequence: number; n: number }>(
      db,
      "SELECT dialogue_revision, sequence, count() AS n FROM message GROUP BY dialogue_revision, sequence",
    )) {
      if (row.n > 1) {
        issues.push({
          check: "message_sequence_collision",
          detail: `${String(row.dialogue_revision)} seq ${row.sequence} ×${row.n}`,
        });
      }
    }

    // chunk sequence collisions
    for (const row of await selectAll<{ message: unknown; sequence: number; n: number }>(
      db,
      "SELECT message, sequence, count() AS n FROM chunk GROUP BY message, sequence",
    )) {
      if (row.n > 1) {
        issues.push({
          check: "chunk_sequence_collision",
          detail: `${String(row.message)} seq ${row.sequence} ×${row.n}`,
        });
      }
    }

    // search_document не из current revision
    for (const row of await selectAll<{ id: unknown; dialogue: unknown }>(
      db,
      "SELECT id, dialogue FROM search_document WHERE dialogue_revision != dialogue.current_revision",
    )) {
      issues.push({
        check: "search_document_not_current",
        detail: `${String(row.id)} (dialogue ${String(row.dialogue)})`,
      });
    }
  } finally {
    await db.close();
  }
  return { ok: issues.length === 0, issues };
}
