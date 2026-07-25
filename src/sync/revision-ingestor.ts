/**
 * Revision ingestor (этап 5, docs/plan.md §10.3–10.4): parse одного
 * source snapshot'а и запись canonical-данных в SurrealDB.
 *
 * Каждый диалог пишется ОТДЕЛЬНОЙ транзакцией (§10.4): для SQLite
 * snapshot'ов с множеством диалогов parse_status может быть "partial",
 * повторный запуск идемпотентно продолжает (revision id детерминирован).
 *
 * Ошибки НЕ молчаливые: parse/write failures → ingest_error (§7.2),
 * source_revision.parse_status = parse_error|partial. Прежняя current
 * revision затронутого диалога не меняется (инвариант №4, сценарий №10).
 */

import type { RecordId, Surreal } from "surrealdb";
import type { ParsedDialogue } from "../domain/canonical-types.ts";
import { dialogueIdentityKey, fallbackDialogueSourceId } from "../domain/identity.ts";
import type { HarnessParser } from "../parsers/shared/parser.ts";
import { collectDialogues } from "../parsers/shared/parser.ts";
import type { HarnessExtractors } from "../search/extractors/types.ts";
import {
  ensureModel,
  ensureVendor,
  ensureWorkspace,
} from "../db/repositories/identity.ts";
import { createIngestError } from "../db/repositories/provenance.ts";
import { modelKeyOf, writeDialogueRevision } from "../db/repositories/corpus.ts";
import { sha256hex } from "../db/transactions.ts";

export type IngestParseStatus = "parsed" | "partial" | "parse_error" | "unsupported";

export interface IngestContext {
  db: Surreal;
  syncRun: RecordId;
  host: RecordId;
  harnessInstallation: RecordId;
  /** Строковый префикс identity_key (record id harness_installation). */
  installationKey: string;
  osAccount?: RecordId;
  parser: HarnessParser;
  extractors: HarnessExtractors;
  activeEmbeddingSpaces: RecordId[];
  enqueueEmbeddings: boolean;
}

export interface IngestOptions {
  sourceRevision: RecordId;
  /** Путь, который читает parser (raw-файл или parse-view каталог). */
  parsePath: string;
  /** relative_path источника — база fallback identity (§7.3). */
  relativePath: string;
  harnessSlug: string;
  workspaceHint?: string;
}

export interface IngestOutcome {
  status: IngestParseStatus;
  dialoguesDiscovered: number;
  dialoguesWritten: number;
  dialoguesFailed: number;
  /** Сводный canonical hash содержимого snapshot'а. */
  canonicalHash?: string;
  messagesWritten: number;
  chunksWritten: number;
  searchDocumentsWritten: number;
  embeddingJobsCreated: number;
  errors: number;
}

async function recordError(
  ctx: IngestContext,
  input: {
    sourceRevision: RecordId;
    sourceRecordKey?: string;
    stage: string;
    code: string;
    message: string;
  },
): Promise<void> {
  await createIngestError(ctx.db, {
    syncRun: ctx.syncRun,
    sourceRevision: input.sourceRevision,
    sourceRecordKey: input.sourceRecordKey ?? undefined,
    stage: input.stage,
    errorCode: input.code,
    errorMessage: input.message,
    parserVersion: ctx.parser.parserVersion,
  });
}

/** Модели всех сообщений: ensure vendor+model, возвращает ключ → record id. */
async function ensureDialogueModels(
  ctx: IngestContext,
  dialogue: ParsedDialogue,
): Promise<Map<string, RecordId>> {
  const ids = new Map<string, RecordId>();
  for (const message of dialogue.messages) {
    const key = modelKeyOf(message);
    if (!key || !message.model || ids.has(key)) continue;
    const vendor = await ensureVendor(ctx.db, message.model.vendor);
    const model = await ensureModel(ctx.db, {
      vendor,
      canonicalName: message.model.canonicalName,
      rawName: message.model.rawModelName,
    });
    ids.set(key, model);
  }
  return ids;
}

export async function ingestSourceRevision(
  ctx: IngestContext,
  opts: IngestOptions,
): Promise<IngestOutcome> {
  const outcome: IngestOutcome = {
    status: "parsed",
    dialoguesDiscovered: 0,
    dialoguesWritten: 0,
    dialoguesFailed: 0,
    messagesWritten: 0,
    chunksWritten: 0,
    searchDocumentsWritten: 0,
    embeddingJobsCreated: 0,
    errors: 0,
  };

  let dialogues: ParsedDialogue[];
  let diagnostics: Array<{ code: string; message: string; severity: string; sourceLocator?: string }>;
  try {
    const snapshot = await ctx.parser.parse(opts.parsePath, {
      workspaceHint: opts.workspaceHint ?? undefined,
    });
    dialogues = await collectDialogues(snapshot);
    diagnostics = snapshot.diagnostics;
  } catch (error) {
    await recordError(ctx, {
      sourceRevision: opts.sourceRevision,
      stage: "parse",
      code: "parser_exception",
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    outcome.status = "parse_error";
    outcome.errors = 1;
    return outcome;
  }

  outcome.dialoguesDiscovered = dialogues.length;
  const canonicalHashes: string[] = [];
  const fallbackBase = fallbackDialogueSourceId(opts.harnessSlug, opts.relativePath);

  for (const [index, dialogue] of dialogues.entries()) {
    const sourceDialogueId = dialogue.externalId ?? `${fallbackBase}#${index}`;
    try {
      const modelIds = await ensureDialogueModels(ctx, dialogue);
      const workspace = await ensureWorkspace(ctx.db, {
        host: ctx.host,
        path: dialogue.workspace?.path ?? undefined,
        name: dialogue.workspace?.name ?? undefined,
        repositoryIdentity: dialogue.workspace?.repositoryIdentity ?? undefined,
      });
      const identityKey = dialogueIdentityKey(
        ctx.installationKey,
        dialogue.externalId,
        sourceDialogueId,
      );
      const result = await writeDialogueRevision(ctx.db, {
        identityKey,
        harnessInstallation: ctx.harnessInstallation,
        osAccount: ctx.osAccount ?? undefined,
        workspace,
        sourceRevision: opts.sourceRevision,
        sourceDialogueId,
        parserName: ctx.parser.parserName,
        parserVersion: ctx.parser.parserVersion,
        parsed: dialogue,
        extractors: ctx.extractors,
        modelIds,
        activeEmbeddingSpaces: ctx.activeEmbeddingSpaces,
        enqueueEmbeddings: ctx.enqueueEmbeddings,
      });
      outcome.dialoguesWritten += 1;
      if (result.created || result.switched) {
        outcome.messagesWritten += result.messageCount;
        outcome.chunksWritten += result.chunkCount;
        outcome.searchDocumentsWritten += result.searchDocumentCount;
        outcome.embeddingJobsCreated += result.embeddingJobCount;
      }
      canonicalHashes.push(result.revisionId.toString());
    } catch (error) {
      outcome.dialoguesFailed += 1;
      outcome.errors += 1;
      await recordError(ctx, {
        sourceRevision: opts.sourceRevision,
        sourceRecordKey: sourceDialogueId,
        stage: "write",
        code: "dialogue_write_failed",
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
  }

  // Диагностики parser'а с severity=error — в карантин (без молчаливых skip).
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") continue;
    outcome.errors += 1;
    await recordError(ctx, {
      sourceRevision: opts.sourceRevision,
      stage: "parse",
      code: diagnostic.code,
      message: diagnostic.sourceLocator
        ? `${diagnostic.message} [${diagnostic.sourceLocator}]`
        : diagnostic.message,
    });
  }

  if (canonicalHashes.length > 0) {
    outcome.canonicalHash = sha256hex(canonicalHashes.sort().join("|"));
  }

  const unsupported = diagnostics.some((d) => d.code.startsWith("unsupported"));
  const hasErrorDiagnostics = diagnostics.some((d) => d.severity === "error");
  if (outcome.dialoguesWritten === 0) {
    if (unsupported) outcome.status = "unsupported";
    else if (outcome.dialoguesFailed > 0 || hasErrorDiagnostics) outcome.status = "parse_error";
    else outcome.status = "parsed"; // диалогов нет, ошибок нет (например, пустой файл)
  } else if (outcome.dialoguesFailed > 0 || hasErrorDiagnostics) {
    outcome.status = "partial";
  } else {
    outcome.status = "parsed";
  }
  return outcome;
}
