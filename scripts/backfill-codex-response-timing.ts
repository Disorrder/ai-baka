#!/usr/bin/env bun
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { RecordId, type Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { checkSchemaVersion } from "../src/db/migrations.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { acquireLock } from "../src/infra/lock.ts";
import { codexParser } from "../src/parsers/codex/index.ts";
import { collectDialogues } from "../src/parsers/shared/parser.ts";
import { messageRecordId } from "../src/sync/canonical-hash.ts";

interface TargetRow {
  id: RecordId | string;
  raw_archive_path?: string;
  sha256: string;
  captured_at: Date | string;
  relative_path: string;
  dialogue_revision?: RecordId | string;
}

interface TimingRow {
  sequence: number;
  clearResponseTiming?: boolean;
  responseWaitMs?: number;
  responseStatus?: string;
  responseCompletedAt?: Date;
  responseTurnId?: string;
  durationMs?: number;
  durationSource?: string;
  durationTurnId?: string;
}

interface Options {
  dryRun: boolean;
  limit?: number;
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const options: Options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--limit") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function archivedRegularFile(archiveRoot: string, rawArchivePath: string): Promise<string> {
  if (!rawArchivePath || path.isAbsolute(rawArchivePath)) {
    throw new Error(`raw_archive_path must be relative: ${rawArchivePath}`);
  }
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(root, rawArchivePath);
  if (!containedBy(root, resolved) || resolved === root) {
    throw new Error(`raw_archive_path escapes archive root: ${rawArchivePath}`);
  }
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`raw file is not a regular non-symlink file: ${rawArchivePath}`);
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolved)]);
  if (!containedBy(realRoot, realFile)) {
    throw new Error(`raw file realpath escapes archive root: ${rawArchivePath}`);
  }
  return realFile;
}

function recordId(table: string, value: RecordId | string | undefined): RecordId | undefined {
  if (!value) return undefined;
  if (value instanceof RecordId) return value;
  const text = String(value);
  const prefix = `${table}:`;
  if (!text.startsWith(prefix)) {
    throw new Error(`expected ${table} record id, got ${text}`);
  }
  return new RecordId(table, text.slice(prefix.length));
}

function recordKey(table: string, value: RecordId): string {
  const text = value.toString();
  const prefix = `${table}:`;
  if (!text.startsWith(prefix)) {
    throw new Error(`expected ${table} record id, got ${text}`);
  }
  return text.slice(prefix.length);
}

async function selectTargets(db: Surreal, limit?: number): Promise<TargetRow[]> {
  const limitClause = limit ? ` LIMIT ${limit}` : "";
  const rows = await selectAll<TargetRow>(
    db,
    `SELECT id, raw_archive_path, sha256, captured_at,
       source_location.relative_path AS relative_path,
       (SELECT VALUE id FROM dialogue_revision
        WHERE source_revision = $parent.id
          AND id = dialogue.current_revision
        LIMIT 1)[0] AS dialogue_revision
     FROM source_revision
     WHERE id = source_location.current_revision
       AND source_location.source_root.harness_installation.harness.slug = "codex"
       AND raw_archive_path IS NOT NONE
       AND parse_status = "parsed"
     ORDER BY captured_at ASC, id ASC${limitClause}`,
  );
  return rows.filter((row) => row.dialogue_revision !== undefined && row.dialogue_revision !== null);
}

function timingRowsFromDialogue(rawPath: string, dialogueMessages: Awaited<ReturnType<typeof collectDialogues>>[number]["messages"]): TimingRow[] {
  const rows: TimingRow[] = [];
  for (const message of dialogueMessages) {
    const clearResponseTiming = message.role === "user";
    const responseWaitMs = message.role === "user" && message.humanAuthored === true
      ? message.responseWaitMs
      : undefined;
    const durationSource = typeof message.metadata.durationSource === "string"
      ? message.metadata.durationSource
      : undefined;
    const rawDurationMs = Number(message.metadata.durationMs);
    const durationMs = durationSource?.startsWith("codex.task_") &&
        Number.isFinite(rawDurationMs) && rawDurationMs >= 0
      ? rawDurationMs
      : undefined;
    if (!clearResponseTiming && durationMs === undefined) continue;
    if (responseWaitMs !== undefined && (!Number.isFinite(responseWaitMs) || responseWaitMs < 0)) {
      throw new Error(`invalid responseWaitMs in ${rawPath} sequence=${message.sequence}`);
    }
    rows.push({
      sequence: message.sequence,
      ...(clearResponseTiming ? { clearResponseTiming: true } : {}),
      ...(responseWaitMs !== undefined
        ? {
            responseWaitMs: Math.round(responseWaitMs),
            responseStatus: message.responseStatus ?? "completed",
            responseCompletedAt: message.responseCompletedAt,
            responseTurnId: message.responseTurnId,
          }
        : {}),
      ...(durationMs !== undefined
        ? {
            durationMs: Math.round(durationMs),
            durationSource,
            durationTurnId:
              typeof message.metadata.durationTurnId === "string"
                ? message.metadata.durationTurnId
                : undefined,
          }
        : {}),
    });
  }
  return rows;
}

async function parseTimingRows(rawPath: string): Promise<TimingRow[]> {
  const snapshot = await codexParser.parse(rawPath);
  const dialogues = await collectDialogues(snapshot);
  if (dialogues.length !== 1) {
    throw new Error(`expected exactly one Codex dialogue, got ${dialogues.length}`);
  }
  return timingRowsFromDialogue(rawPath, dialogues[0]!.messages);
}

function param(vars: Record<string, unknown>, value: unknown): string {
  const key = `p${Object.keys(vars).length}`;
  vars[key] = value;
  return `$${key}`;
}

async function updateRevisionTiming(
  db: Surreal,
  revision: RecordId,
  rows: TimingRow[],
): Promise<void> {
  const revisionKey = recordKey("dialogue_revision", revision);
  const vars: Record<string, unknown> = {};
  const statements: string[] = ["BEGIN;"];
  for (const row of rows) {
    const messageId = param(vars, new RecordId("message", messageRecordId(revisionKey, row.sequence)));
    const assignments: string[] = [];
    if (row.clearResponseTiming) {
      assignments.push(
        `response_wait_ms = ${row.responseWaitMs !== undefined ? param(vars, row.responseWaitMs) : "NONE"}`,
      );
      assignments.push(
        `response_status = ${row.responseWaitMs !== undefined ? param(vars, row.responseStatus ?? "completed") : "NONE"}`,
      );
      assignments.push(
        `response_completed_at = ${row.responseWaitMs !== undefined && row.responseCompletedAt ? param(vars, row.responseCompletedAt) : "NONE"}`,
      );
      assignments.push(
        `response_turn_id = ${row.responseWaitMs !== undefined && row.responseTurnId ? param(vars, row.responseTurnId) : "NONE"}`,
      );
    }
    if (row.durationMs !== undefined) {
      assignments.push(`metadata.durationMs = ${param(vars, row.durationMs)}`);
      assignments.push(`metadata.durationSource = ${param(vars, row.durationSource)}`);
      assignments.push(`metadata.durationKind = "turn_execution"`);
      assignments.push(
        `metadata.durationTurnId = ${row.durationTurnId ? param(vars, row.durationTurnId) : "NONE"}`,
      );
    }
    statements.push(`UPDATE ${messageId} SET ${assignments.join(",\n         ")} RETURN NONE;`);
  }
  statements.push("COMMIT;");
  await db.query(statements.join("\n"), vars);
}

async function main(): Promise<void> {
  const options = parseOptions();
  const cfg = await loadConfig();
  const release = await acquireLock(
    cfg.archiveRoot,
    options.dryRun ? "codex response timing backfill --dry-run" : "codex response timing backfill",
  );
  let db: Surreal | undefined;
  try {
    db = await connectDb(cfg);
    const schemaVersion = await checkSchemaVersion(db);
    if (schemaVersion !== 1) {
      throw new Error(`schema version ${schemaVersion} does not have response timing fields`);
    }
    const targets = await selectTargets(db, options.limit);
    const summary = {
      dryRun: options.dryRun,
      targets: targets.length,
      processed: 0,
      updatedRevisions: 0,
      timedMessages: 0,
      durationMessages: 0,
      skippedWithoutTiming: 0,
      errors: 0,
    };
    for (const target of targets) {
      summary.processed += 1;
      try {
        const rawArchivePath = target.raw_archive_path;
        if (!rawArchivePath) throw new Error("missing raw_archive_path");
        const revision = recordId("dialogue_revision", target.dialogue_revision);
        if (!revision) throw new Error("missing current dialogue_revision");
        const rawPath = await archivedRegularFile(cfg.archiveRoot, rawArchivePath);
        const timingRows = await parseTimingRows(rawPath);
        summary.timedMessages += timingRows.filter((row) => row.responseWaitMs !== undefined).length;
        summary.durationMessages += timingRows.filter((row) => row.durationMs !== undefined).length;
        if (timingRows.length === 0) {
          summary.skippedWithoutTiming += 1;
        }
        if (!options.dryRun) {
          await updateRevisionTiming(db, revision, timingRows);
          summary.updatedRevisions += 1;
        }
        if (summary.processed % 100 === 0) {
          console.error(JSON.stringify({
            event: "codex_response_timing_backfill_progress",
            processed: summary.processed,
            targets: summary.targets,
            updatedRevisions: summary.updatedRevisions,
            timedMessages: summary.timedMessages,
          }));
        }
      } catch (error) {
        summary.errors += 1;
        console.error(JSON.stringify({
          event: "codex_response_timing_backfill_error",
          sourceRevision: String(target.id),
          relativePath: target.relative_path,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db?.close();
    await release();
  }
}

await main();
