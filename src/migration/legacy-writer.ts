/**
 * Migration-specific seam над canonical corpus writer.
 *
 * Новый dialogue проходит обычный writeDialogueRevision (включая search
 * projection). Если reliable identity уже существует, legacy revision
 * добавляется как историческая: current_revision и её projection не
 * переключаются на потенциально более старое содержимое.
 */

import { RecordId, type Surreal } from "surrealdb";
import type { ParsedDialogue, ParsedMessage } from "../domain/canonical-types.ts";
import type { HarnessExtractors } from "../search/extractors/types.ts";
import { normalizeUsageEvents } from "../parsers/shared/usage-normalization.ts";
import {
  chunkRecordId,
  canonicalDialogueHash,
  dialogueRevisionId,
  messageRecordId,
} from "../sync/canonical-hash.ts";
import { sha256hex } from "../db/transactions.ts";
import { clean, selectOne } from "../db/repositories/helpers.ts";
import {
  contentChars,
  modelKeyOf,
  writeDialogueRevision,
  type DialogueWriteResult,
} from "../db/repositories/corpus.ts";

export interface LegacyDialogueWriteInput {
  identityKey: string;
  harnessInstallation: RecordId;
  osAccount?: RecordId;
  workspace?: RecordId;
  sourceRevision: RecordId;
  sourceDialogueId: string;
  parserName: string;
  parserVersion: number;
  parsed: ParsedDialogue;
  extractors: HarnessExtractors;
  modelIds: Map<string, RecordId>;
  canonicalImportPolicy: "match_existing" | "import_deleted";
  /** Already resolved by migration dedup (mapping → source key → identity). */
  existingDialogueId?: RecordId;
}

export interface LegacyDialogueWriteResult extends DialogueWriteResult {
  /** reliable identity уже существовала до migration write. */
  matchedExistingDialogue: boolean;
  /** Новая revision записана без смены current_revision. */
  historical: boolean;
}

function messageFields(
  message: ParsedMessage,
  modelIds: Map<string, RecordId>,
): Array<[string, unknown]> {
  const usage = normalizeUsageEvents(message.usageEvents);
  return [
    ["external_id", message.externalId],
    ["sequence", message.sequence],
    ["role", message.role],
    ["raw_role", message.rawRole],
    ["human_authored", message.humanAuthored === true],
    ["visible_to_user", message.visibleToUser === true],
    ["timestamp", message.timestamp],
    ["model", message.model ? modelIds.get(modelKeyOf(message)!) : undefined],
    ["raw_model_name", message.model?.rawModelName],
    ["reasoning_effort", message.model?.reasoningEffort],
    ["service_provider", message.model?.serviceProvider],
    ["content_chars", messageContentChars(message)],
    ["usage", usage ? clean(usage) : undefined],
    ["raw_usage_events", message.usageEvents.length > 0 ? clean(message.usageEvents) : undefined],
    ["metadata", Object.keys(message.metadata).length > 0 ? clean(message.metadata) : undefined],
  ];
}

function messageContentChars(message: ParsedMessage): number {
  return message.chunks.reduce((total, chunk) => total + contentChars(chunk.content ?? ""), 0);
}

class Tx {
  readonly sql: string[] = [];
  readonly vars: Record<string, unknown> = {};
  private n = 0;

  param(value: unknown): string {
    const key = `p${this.n++}`;
    this.vars[key] = value;
    return `$${key}`;
  }

  assignments(fields: Array<[string, unknown]>): string[] {
    return fields
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => `${field} = ${this.param(value)}`);
  }
}

export async function writeLegacyDialogueRevision(
  db: Surreal,
  input: LegacyDialogueWriteInput,
): Promise<LegacyDialogueWriteResult> {
  const existingDialogue = input.existingDialogueId
    ? await selectOne<{ id: RecordId; current_revision?: RecordId; identity_key: string }>(
        db,
        "SELECT id, current_revision, identity_key FROM ONLY $id",
        { id: input.existingDialogueId },
      )
    : await selectOne<{ id: RecordId; current_revision?: RecordId; identity_key: string }>(
        db,
        "SELECT id, current_revision, identity_key FROM dialogue WHERE identity_key = $key LIMIT 1",
        { key: input.identityKey },
      );
  if (input.existingDialogueId && !existingDialogue) {
    throw new Error(`authoritative dialogue отсутствует: ${String(input.existingDialogueId)}`);
  }
  const effectiveIdentityKey = existingDialogue?.identity_key ?? input.identityKey;

  // Для нового dialogue используем авторитетный writer целиком.
  if (!existingDialogue?.current_revision) {
    if (input.canonicalImportPolicy === "match_existing") {
      throw new Error(
        `approved live dialogue ${input.sourceDialogueId} has no existing canonical revision`,
      );
    }
    const result = await writeDialogueRevision(db, {
      ...input,
      identityKey: effectiveIdentityKey,
      activeEmbeddingSpaces: [],
      enqueueEmbeddings: false,
    });
    return {
      ...result,
      matchedExistingDialogue: existingDialogue !== undefined,
      historical: false,
    };
  }

  const canonicalHash = canonicalDialogueHash(input.parsed);
  const revisionKey = dialogueRevisionId(
    effectiveIdentityKey,
    input.parserName,
    input.parserVersion,
    canonicalHash,
  );
  const revisionId = new RecordId("dialogue_revision", revisionKey);
  const existingRevision = await selectOne<{ id: RecordId }>(
    db,
    "SELECT id FROM ONLY $id",
    { id: revisionId },
  );
  const messageCount = input.parsed.messages.length;
  const chunkCount = input.parsed.messages.reduce((sum, message) => sum + message.chunks.length, 0);
  if (existingRevision) {
    return {
      dialogueId: existingDialogue.id,
      revisionId,
      created: false,
      switched: false,
      messageCount,
      chunkCount,
      searchDocumentCount: 0,
      embeddingJobCount: 0,
      matchedExistingDialogue: true,
      historical: true,
    };
  }
  if (input.canonicalImportPolicy === "match_existing") {
    throw new Error(
      `approved live dialogue ${input.sourceDialogueId} does not have the exact canonical revision`,
    );
  }

  // Историческая revision: canonical corpus создаётся атомарно, но search
  // projection и current pointer остаются у текущей live revision (§23.10).
  const tx = new Tx();
  tx.sql.push("BEGIN;");
  tx.sql.push(`LET $dlgId = ${tx.param(existingDialogue.id)};`);
  tx.sql.push(
    `LET $revId = (CREATE ONLY ${tx.param(revisionId)} SET ` +
      [
        "dialogue = $dlgId",
        ...tx.assignments([
          ["source_revision", input.sourceRevision],
          ["source_dialogue_id", input.sourceDialogueId],
          ["parser_name", input.parserName],
          ["parser_version", String(input.parserVersion)],
          ["canonical_hash", canonicalHash],
          ["status", "ready"],
          ["message_count", messageCount],
          ["chunk_count", chunkCount],
          ["started_at", input.parsed.startedAt],
          ["updated_at", input.parsed.updatedAt],
          ["created_at", new Date()],
        ]),
      ].join(", ") +
      `).id;`,
  );
  for (const message of input.parsed.messages) {
    const messageId = new RecordId("message", messageRecordId(revisionKey, message.sequence));
    tx.sql.push(
      `LET $m${message.sequence} = (CREATE ONLY ${tx.param(messageId)} SET ` +
        ["dialogue = $dlgId", "dialogue_revision = $revId", ...tx.assignments(messageFields(message, input.modelIds))].join(", ") +
        `).id;`,
    );
    for (const chunk of message.chunks) {
      const content = chunk.content ?? "";
      const chunkId = new RecordId(
        "chunk",
        chunkRecordId(revisionKey, message.sequence, chunk.sequence),
      );
      tx.sql.push(
        `CREATE ONLY ${tx.param(chunkId)} SET ` +
          [
            "dialogue = $dlgId",
            "dialogue_revision = $revId",
            `message = $m${message.sequence}`,
            ...tx.assignments([
              ["sequence", chunk.sequence],
              ["kind", chunk.kind],
              ["raw_kind", chunk.rawKind],
              ["role", message.role],
              ["content", content],
              ["content_sha256", sha256hex(content)],
              ["content_bytes", Buffer.byteLength(content, "utf8")],
              ["content_chars", contentChars(content)],
              ["source_locator", chunk.sourceLocator],
              ["tool_call_id", chunk.toolCallId],
              ["tool_name", chunk.toolName],
              ["raw_event_type", chunk.rawEventType],
              ["metadata", Object.keys(chunk.metadata).length > 0 ? clean(chunk.metadata) : undefined],
            ]),
          ].join(", ") +
          `;`,
      );
    }
  }
  tx.sql.push("COMMIT;");
  tx.sql.push("RETURN { dialogue: $dlgId, revision: $revId };");
  const result = await db.query<unknown[]>(tx.sql.join("\n"), tx.vars);
  const returned = result.at(-1) as { dialogue?: RecordId; revision?: RecordId } | undefined;
  if (!returned?.dialogue || !returned.revision) {
    throw new Error(
      `legacy historical transaction оборвалась: RETURN не выполнен ` +
      `(получено ${result.length} результатов из ${tx.sql.length} statements)`,
    );
  }
  return {
    dialogueId: returned.dialogue,
    revisionId: returned.revision,
    created: true,
    switched: false,
    messageCount,
    chunkCount,
    searchDocumentCount: 0,
    embeddingJobCount: 0,
    matchedExistingDialogue: true,
    historical: true,
  };
}
