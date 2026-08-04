/**
 * Corpus-запись (docs/plan.md §7.3, §10.4): транзакция одного диалога.
 *
 * Порядок §10.4 в одной SurrealDB-транзакции (один query-вызов, см.
 * src/db/transactions.ts):
 *   dialogue upsert → dialogue_revision → messages → chunks →
 *   search_documents → embedding_jobs (только при active space, §13.5) →
 *   dialogue.current_revision → primary_model → удаление устаревшей
 *   search projection прежней current revision → COMMIT.
 * Любая ошибка statement'а откатывает всю транзакцию — прежняя current
 * revision остаётся действующей (§10.4).
 *
 * Идемпотентность (§19.2 №1): dialogue_revision имеет детерминированный id
 * (identity_key + parser@version + canonical_hash, src/sync/canonical-hash.ts).
 * Повторная запись того же содержимого находит существующую revision и не
 * создаёт ничего нового; если файл «откатился» к старому содержимому —
 * current pointer переключается на прежнюю revision, а её search projection
 * пересоздаётся (при смене current projection прежней current удаляется, §8.1).
 *
 * human_authored / visible_to_user в схеме — не-optional bool;
 * "unknown" из parser contract сохраняется как false (исходное значение
 * остаётся в metadata диалога и raw snapshot).
 */

import { RecordId, type Surreal } from "surrealdb";
import type {
  ParsedDialogue,
  ParsedMessage,
} from "../../domain/canonical-types.ts";
import type {
  ExtractedDocument,
  HarnessExtractors,
} from "../../search/extractors/types.ts";
import { SEGMENTATION_VERSION, segmentDocument } from "../../search/segmenter.ts";
import { normalizeUsageEvents } from "../../parsers/shared/usage-normalization.ts";
import {
  canonicalDialogueHash,
  chunkRecordId,
  dialogueRevisionId,
  embeddingJobRecordId,
  messageRecordId,
  searchDocumentRecordId,
} from "../../sync/canonical-hash.ts";
import { deterministicId, sha256hex } from "../transactions.ts";
import { clean, selectOne } from "./helpers.ts";

export interface DialogueTxInput {
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
  /** `${vendor}/${canonicalName}` → record id (ensure выполнен до транзакции). */
  modelIds: Map<string, RecordId>;
  activeEmbeddingSpaces: RecordId[];
  enqueueEmbeddings: boolean;
  /**
   * Физические vector-таблицы всех embedding spaces (search_embedding_*).
   * Нужны для каскадного удаления vectors при смене projection (§8.1);
   * заполняется из listEmbeddingTables (src/embeddings/spaces.ts).
   */
  embeddingTables?: string[];
}

export interface DialogueWriteResult {
  dialogueId: RecordId;
  revisionId: RecordId;
  /** revision создана заново (false — найдена существующая). */
  created: boolean;
  /** current pointer переключён на уже существующую revision. */
  switched: boolean;
  messageCount: number;
  chunkCount: number;
  searchDocumentCount: number;
  embeddingJobCount: number;
}

const STAGED_WRITE_CHUNK_THRESHOLD = 250;
const STAGED_WRITE_CONTENT_CHARS_THRESHOLD = 500_000;

/** primary_model (план §7.3): самая частая модель assistant messages; при равенстве — последняя. */
export function primaryModelKey(parsed: ParsedDialogue): string | undefined {
  const counts = new Map<string, { count: number; lastSeq: number }>();
  for (const m of parsed.messages) {
    if (m.role !== "assistant" || !m.model) continue;
    const key = `${m.model.vendor}/${m.model.canonicalName}`;
    const entry = counts.get(key) ?? { count: 0, lastSeq: -1 };
    entry.count += 1;
    entry.lastSeq = m.sequence;
    counts.set(key, entry);
  }
  let best: string | undefined;
  let bestCount = 0;
  let bestSeq = -1;
  for (const [key, entry] of counts) {
    if (entry.count > bestCount || (entry.count === bestCount && entry.lastSeq > bestSeq)) {
      best = key;
      bestCount = entry.count;
      bestSeq = entry.lastSeq;
    }
  }
  return best;
}

export function modelKeyOf(message: ParsedMessage): string | undefined {
  return message.model
    ? `${message.model.vendor}/${message.model.canonicalName}`
    : undefined;
}

/** JS code point count; matches SurrealDB string::len character semantics for backfill. */
export function contentChars(content: string): number {
  return Array.from(content).length;
}

function messageContentChars(message: ParsedMessage): number {
  return message.chunks.reduce((total, chunk) => total + contentChars(chunk.content ?? ""), 0);
}

export interface PreparedSearchDoc {
  recordKey: string;
  documentType: "user_prompt" | "assistant_final";
  messageSequence?: number;
  /** Номер сегмента внутри извлечённого документа (§13.4). */
  segmentNo: number;
  content: string;
  contentSha256: string;
  /** Оценка embedding-токенов сегмента (эвристика segmenter'а, этап 6). */
  tokenCount: number;
  method: string;
  chunkIds: RecordId[];
}

/**
 * Извлечение search documents через extractors (§8.2–8.3) + сегментация
 * (§13.4), до транзакции. Простое правило source_chunks: каждый сегмент
 * ссылается на ВСЕ chunks исходного извлечённого документа (они покрывают
 * его целиком; точное отображение сегмент→chunk — избыточно).
 * Каждый извлечённый user_prompt задаёт turn-window до следующего
 * извлечённого user_prompt. Для каждого такого turn'а создаётся
 * свой assistant_final, если в turn'е есть видимый assistant text.
 * Детерминированный id включает documentType + порядковый номер turn'а
 * + segment_no.
 */
export function prepareSearchDocuments(
  parsed: ParsedDialogue,
  revisionKey: string,
  extractors: HarnessExtractors,
): PreparedSearchDoc[] {
  const docs: PreparedSearchDoc[] = [];
  const chunkId = (messageSeq: number, chunkSeq: number): RecordId =>
    new RecordId("chunk", chunkRecordId(revisionKey, messageSeq, chunkSeq));
  const pushDoc = (
    documentType: PreparedSearchDoc["documentType"],
    docIndex: number,
    messageSequence: number | undefined,
    extracted: { content: string; extractionMethod: string; sourceChunks: Array<{ messageSequence: number; chunkSequence: number }> },
  ): void => {
    const chunkIds = extracted.sourceChunks.map((ref) => chunkId(ref.messageSequence, ref.chunkSequence));
    for (const [segmentNo, segment] of segmentDocument(extracted.content).entries()) {
      docs.push({
        recordKey: searchDocumentRecordId(revisionKey, documentType, docIndex, segmentNo),
        documentType,
        messageSequence,
        segmentNo,
        content: segment.content,
        contentSha256: sha256hex(segment.content),
        tokenCount: segment.tokenCount,
        method: extracted.extractionMethod,
        chunkIds,
      });
    }
  };

  const turns: Array<{
    messageIndex: number;
    message: ParsedMessage;
    prompt: ExtractedDocument;
  }> = [];
  for (const [messageIndex, message] of parsed.messages.entries()) {
    const extracted = extractors.extractUserPrompt(message);
    if (!extracted || extracted.content.trim().length === 0) continue;
    turns.push({ messageIndex, message, prompt: extracted });
  }

  for (const [turnIndex, turn] of turns.entries()) {
    pushDoc("user_prompt", turnIndex, turn.message.sequence, turn.prompt);

    const nextMessageIndex = turns[turnIndex + 1]?.messageIndex ?? parsed.messages.length;
    const turnMessages = parsed.messages.slice(turn.messageIndex, nextMessageIndex);
    const final = extractors.extractAssistantFinal(turnMessages);
    if (final && final.content.trim().length > 0) {
      pushDoc(
        "assistant_final",
        turnIndex,
        final.sourceChunks[0]?.messageSequence,
        final,
      );
    }
  }
  return docs;
}

/** Конструктор SurrealQL-скрипта транзакции с параметрами. */
class TxBuilder {
  readonly statements: string[] = [];
  readonly vars: Record<string, unknown> = {};
  private counter = 0;

  param(value: unknown): string {
    const name = `p${this.counter++}`;
    this.vars[name] = value;
    return `$${name}`;
  }

  add(sql: string): void {
    this.statements.push(sql);
  }

  /** `field = $pN` присвоения; undefined пропускаются (option-поля схемы). */
  assignments(fields: Array<[string, unknown]>): string {
    return fields
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => `${field} = ${this.param(value)}`)
      .join(", ");
  }
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
    ["response_wait_ms", message.responseWaitMs],
    ["response_status", message.responseStatus],
    ["response_completed_at", message.responseCompletedAt],
    ["response_turn_id", message.responseTurnId],
    ["content_chars", messageContentChars(message)],
    ["usage", usage ? clean(usage) : undefined],
    ["raw_usage_events", message.usageEvents.length > 0 ? clean(message.usageEvents) : undefined],
    ["metadata", Object.keys(message.metadata).length > 0 ? clean(message.metadata) : undefined],
  ];
}

function fieldObject(fields: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(fields.filter(([, value]) => value !== undefined));
}

function addBulkInsert(
  tx: TxBuilder,
  table: "message" | "chunk" | "search_document" | "embedding_job",
  rows: Array<Record<string, unknown>>,
): void {
  if (rows.length === 0) return;
  const batchSize =
    table === "message" || table === "chunk" ? 25 : table === "search_document" ? 250 : 1000;
  for (let i = 0; i < rows.length; i += batchSize) {
    tx.add(`INSERT INTO ${table} ${tx.param(rows.slice(i, i + batchSize))} RETURN NONE;`);
  }
}

async function insertRowsInBatches(
  db: Surreal,
  table: "message" | "chunk",
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const batchSize = 25;
  for (let i = 0; i < rows.length; i += batchSize) {
    await db.query(`INSERT INTO ${table} $rows RETURN NONE`, {
      rows: rows.slice(i, i + batchSize),
    });
  }
}

async function deleteRecordIds(db: Surreal, ids: RecordId[], batchSize = 1000): Promise<void> {
  for (let i = 0; i < ids.length; i += batchSize) {
    await db.query("DELETE $ids RETURN NONE", { ids: ids.slice(i, i + batchSize) });
  }
}

function messageRows(
  parsed: ParsedDialogue,
  input: DialogueTxInput,
  revisionKey: string,
  dialogueId: RecordId,
  revisionId: RecordId,
): Array<Record<string, unknown>> {
  return parsed.messages.map((message) => ({
    id: new RecordId("message", messageRecordId(revisionKey, message.sequence)),
    dialogue: dialogueId,
    dialogue_revision: revisionId,
    ...fieldObject(messageFields(message, input.modelIds)),
  }));
}

function chunkRows(
  parsed: ParsedDialogue,
  revisionKey: string,
  dialogueId: RecordId,
  revisionId: RecordId,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const message of parsed.messages) {
    const messageId = new RecordId("message", messageRecordId(revisionKey, message.sequence));
    for (const chunk of message.chunks) {
      const content = chunk.content ?? "";
      rows.push({
        id: new RecordId("chunk", chunkRecordId(revisionKey, message.sequence, chunk.sequence)),
        dialogue: dialogueId,
        dialogue_revision: revisionId,
        message: messageId,
        ...fieldObject([
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
      });
    }
  }
  return rows;
}

function messageIds(parsed: ParsedDialogue, revisionKey: string): RecordId[] {
  return parsed.messages.map(
    (message) => new RecordId("message", messageRecordId(revisionKey, message.sequence)),
  );
}

function chunkIds(parsed: ParsedDialogue, revisionKey: string): RecordId[] {
  const ids: RecordId[] = [];
  for (const message of parsed.messages) {
    for (const chunk of message.chunks) {
      ids.push(new RecordId("chunk", chunkRecordId(revisionKey, message.sequence, chunk.sequence)));
    }
  }
  return ids;
}

function searchDocumentIds(docs: PreparedSearchDoc[]): RecordId[] {
  return docs.map((doc) => new RecordId("search_document", doc.recordKey));
}

/** statements создания search_documents + embedding_jobs (общие для обоих путей). */
function addSearchProjection(
  tx: TxBuilder,
  docs: PreparedSearchDoc[],
  input: {
    extractors: HarnessExtractors;
    activeEmbeddingSpaces: RecordId[];
    enqueueEmbeddings: boolean;
  },
  revisionKey: string,
  dialogueId: RecordId,
  revisionId: RecordId,
  messageRef: (sequence: number) => RecordId,
): number {
  let jobCount = 0;
  const searchRows: Array<Record<string, unknown>> = [];
  const jobRows: Array<Record<string, unknown>> = [];
  for (const doc of docs) {
    const searchDocumentId = new RecordId("search_document", doc.recordKey);
    searchRows.push({
      id: searchDocumentId,
      dialogue: dialogueId,
      dialogue_revision: revisionId,
      ...fieldObject([
        ["message", doc.messageSequence !== undefined ? messageRef(doc.messageSequence) : undefined],
        ["document_type", doc.documentType],
        ["segment_no", doc.segmentNo],
        ["content", doc.content],
        ["content_sha256", doc.contentSha256],
        ["token_count", doc.tokenCount],
        ["source_chunks", doc.chunkIds],
        ["extraction_method", doc.method],
        ["extraction_version", String(input.extractors.extractorVersion)],
        ["segmentation_version", SEGMENTATION_VERSION],
        ["created_at", new Date()],
      ]),
    });
    if (!input.enqueueEmbeddings) continue;
    for (const space of input.activeEmbeddingSpaces) {
      const jobKey = embeddingJobRecordId(doc.recordKey, String(space));
      jobRows.push({
        id: new RecordId("embedding_job", jobKey),
        search_document: searchDocumentId,
        embedding_space: space,
        input_sha256: doc.contentSha256,
        status: "pending",
        attempts: 0,
        created_at: new Date(),
      });
      jobCount += 1;
    }
  }
  addBulkInsert(tx, "search_document", searchRows);
  addBulkInsert(tx, "embedding_job", jobRows);
  return jobCount;
}

/**
 * UPSERT dialogue одним statement'ом (БЕЗ IF/ELSE: мульти-statement IF/ELSE
 * в SurrealDB 3.2.3 молча биндит null в LET-переменную — проверено на живой
 * базе, поэтому только UPSERT ... WHERE). first_seen_at сохраняется с первого
 * появления через подзапрос; undefined-поля не перезаписываются.
 */
function dialogueUpsertStatement(tx: TxBuilder, input: DialogueTxInput): string {
  const parsed = input.parsed;
  const now = tx.param(new Date());
  const key = tx.param(input.identityKey);
  const base = tx.assignments([
    ["identity_key", input.identityKey],
    ["harness_installation", input.harnessInstallation],
    ["os_account", input.osAccount],
    ["workspace", input.workspace],
    ["external_id", parsed.externalId],
    ["title", parsed.title],
    ["started_at", parsed.startedAt],
    ["updated_at", parsed.updatedAt],
  ]);
  return (
    `LET $dlgId = (UPSERT ONLY dialogue SET ` +
    [base, `first_seen_at = ((SELECT VALUE first_seen_at FROM dialogue WHERE identity_key = ${key} LIMIT 1)[0] ?? ${now})`, `last_seen_at = ${now}`]
      .filter((s) => s.length > 0)
      .join(", ") +
    ` WHERE identity_key = ${key}).id;`
  );
}

function dialogueUpsertByIdStatement(
  tx: TxBuilder,
  input: DialogueTxInput,
  dialogueId: RecordId,
  firstSeenAt: unknown,
): string {
  const parsed = input.parsed;
  const now = new Date();
  const base = tx.assignments([
    ["identity_key", input.identityKey],
    ["harness_installation", input.harnessInstallation],
    ["os_account", input.osAccount],
    ["workspace", input.workspace],
    ["external_id", parsed.externalId],
    ["title", parsed.title],
    ["started_at", parsed.startedAt],
    ["updated_at", parsed.updatedAt],
    ["first_seen_at", firstSeenAt ?? now],
    ["last_seen_at", now],
  ]);
  return `LET $dlgId = (UPSERT ONLY ${tx.param(dialogueId)} SET ${base}).id;`;
}

/** Удаление search projection (vectors + jobs + docs) указанных revisions. */
function addProjectionDelete(tx: TxBuilder, revisionExpr: string, embeddingTables: string[] = []): void {
  // §8.1: при смене current revision удаляются и vectors физических таблиц
  // (иначе они сиротеют — инварианты §23.11–12). Таблицы динамические
  // (search_embedding_<slug>), имена приходят из embedding_space records.
  for (const table of embeddingTables) {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) {
      throw new Error(`небезопасное имя vector-таблицы: ${table}`);
    }
    tx.add(
      `DELETE ${table} WHERE search_document INSIDE ` +
        `(SELECT VALUE id FROM search_document WHERE dialogue_revision = ${revisionExpr});`,
    );
  }
  tx.add(
    `DELETE embedding_job WHERE search_document INSIDE ` +
      `(SELECT VALUE id FROM search_document WHERE dialogue_revision = ${revisionExpr});`,
  );
  tx.add(`DELETE search_document WHERE dialogue_revision = ${revisionExpr};`);
}

async function cleanupStagedRevision(
  db: Surreal,
  input: DialogueTxInput,
  prepared: {
    parsed: ParsedDialogue;
    revisionKey: string;
    revisionRid: RecordId;
    docs: PreparedSearchDoc[];
  },
): Promise<void> {
  const docIds = searchDocumentIds(prepared.docs);
  for (const table of input.embeddingTables ?? []) {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) {
      throw new Error(`небезопасное имя vector-таблицы: ${table}`);
    }
    if (docIds.length > 0) {
      await db.query(`DELETE ${table} WHERE search_document INSIDE $docs RETURN NONE`, {
        docs: docIds,
      });
    }
  }
  if (docIds.length > 0) {
    await db.query("DELETE embedding_job WHERE search_document INSIDE $docs RETURN NONE", {
      docs: docIds,
    });
    await deleteRecordIds(db, docIds, 500);
  }
  await deleteRecordIds(db, chunkIds(prepared.parsed, prepared.revisionKey), 500);
  await deleteRecordIds(db, messageIds(prepared.parsed, prepared.revisionKey), 1000);
  await db.query("DELETE $rid RETURN NONE", { rid: prepared.revisionRid });
}

async function writeDialogueRevisionStaged(
  db: Surreal,
  input: DialogueTxInput,
  prepared: {
    canonicalHash: string;
    revisionKey: string;
    revisionRid: RecordId;
    docs: PreparedSearchDoc[];
    primaryModel?: RecordId;
    messageCount: number;
    chunkCount: number;
    dialogueRid: RecordId;
    firstSeenAt?: unknown;
  },
): Promise<DialogueWriteResult> {
  const parsed = input.parsed;
  const lineage = parsed.metadata.lineage as Record<string, unknown> | undefined;
  const createTx = new TxBuilder();
  createTx.add("BEGIN;");
  createTx.add(
    dialogueUpsertByIdStatement(createTx, input, prepared.dialogueRid, prepared.firstSeenAt),
  );
  createTx.add(
    `LET $revId = (CREATE ONLY type::record("dialogue_revision", ${createTx.param(prepared.revisionKey)}) SET ` +
      [
        "dialogue = $dlgId",
        ...createTx
          .assignments([
            ["source_revision", input.sourceRevision],
            ["source_dialogue_id", input.sourceDialogueId],
            ["parser_name", input.parserName],
            ["parser_version", String(input.parserVersion)],
            ["canonical_hash", prepared.canonicalHash],
            ["status", "writing"],
            ["message_count", prepared.messageCount],
            ["chunk_count", prepared.chunkCount],
            ["started_at", parsed.startedAt],
            ["updated_at", parsed.updatedAt],
            ["parent_source_dialogue_id", lineage?.parentSourceDialogueId],
            ["agent_depth", lineage?.depth],
            ["agent_nickname", lineage?.nickname],
            ["agent_role", lineage?.role],
            ["created_at", new Date()],
          ])
          .split(", "),
      ].join(", ") +
      `).id;`,
  );
  createTx.add("COMMIT;");
  createTx.add(`RETURN { dialogue: $dlgId, revision: $revId };`);
  const createResult = await db.query<unknown[]>(createTx.statements.join("\n"), createTx.vars);
  const created = createResult.at(-1) as { dialogue?: RecordId; revision?: RecordId } | undefined;
  if (!created?.dialogue || !created.revision) {
    throw new Error(
      `staged dialogue create transaction оборвалась: RETURN не выполнен (получено ${createResult.length} результатов из ${createTx.statements.length} statements)`,
    );
  }

  await insertRowsInBatches(
    db,
    "message",
    messageRows(parsed, input, prepared.revisionKey, prepared.dialogueRid, prepared.revisionRid),
  );
  await insertRowsInBatches(
    db,
    "chunk",
    chunkRows(parsed, prepared.revisionKey, prepared.dialogueRid, prepared.revisionRid),
  );

  const finalTx = new TxBuilder();
  finalTx.add("BEGIN;");
  finalTx.add(`LET $dlgId = ${finalTx.param(prepared.dialogueRid)};`);
  finalTx.add(`LET $revId = ${finalTx.param(prepared.revisionRid)};`);
  finalTx.add("LET $oldRev = (SELECT VALUE current_revision FROM ONLY $dlgId);");
  finalTx.add("IF $oldRev != NONE AND $oldRev != $revId {");
  addProjectionDelete(finalTx, "$oldRev", input.embeddingTables);
  finalTx.add("};");
  const jobCount = addSearchProjection(
    finalTx,
    prepared.docs,
    input,
    prepared.revisionKey,
    prepared.dialogueRid,
    prepared.revisionRid,
    (seq) => new RecordId("message", messageRecordId(prepared.revisionKey, seq)),
  );
  finalTx.add(`UPDATE ONLY $revId SET status = "ready";`);
  finalTx.add(
    `UPDATE ONLY $dlgId SET ` +
      finalTx.assignments([
        ["current_revision", prepared.revisionRid],
        ["updated_at", parsed.updatedAt],
        ["last_seen_at", new Date()],
      ]) +
      `, primary_model = ${prepared.primaryModel ? finalTx.param(prepared.primaryModel) : "NONE"};`,
  );
  finalTx.add("COMMIT;");
  finalTx.add(`RETURN { dialogue: $dlgId, revision: $revId };`);
  const finalResult = await db.query<unknown[]>(finalTx.statements.join("\n"), finalTx.vars);
  const returned = finalResult.at(-1) as { dialogue?: RecordId; revision?: RecordId } | undefined;
  if (!returned?.dialogue || !returned.revision) {
    throw new Error(
      `staged dialogue final transaction оборвалась: RETURN не выполнен (получено ${finalResult.length} результатов из ${finalTx.statements.length} statements)`,
    );
  }
  return {
    dialogueId: returned.dialogue,
    revisionId: returned.revision,
    created: true,
    switched: false,
    messageCount: prepared.messageCount,
    chunkCount: prepared.chunkCount,
    searchDocumentCount: prepared.docs.length,
    embeddingJobCount: jobCount,
  };
}

/**
 * Записать один ParsedDialogue в БД атомарно (§10.4).
 * Определение «уже записано» — до транзакции; оба пути идемпотентны.
 */
export async function writeDialogueRevision(
  db: Surreal,
  input: DialogueTxInput,
): Promise<DialogueWriteResult> {
  const parsed = input.parsed;
  const lineage = parsed.metadata.lineage as Record<string, unknown> | undefined;
  const canonicalHash = canonicalDialogueHash(parsed);
  const revisionKey = dialogueRevisionId(
    input.identityKey,
    input.parserName,
    input.parserVersion,
    canonicalHash,
  );
  const revisionRid = new RecordId("dialogue_revision", revisionKey);
  const docs = prepareSearchDocuments(parsed, revisionKey, input.extractors);
  const primaryKey = primaryModelKey(parsed);
  const primaryModel = primaryKey ? input.modelIds.get(primaryKey) : undefined;
  const messageCount = parsed.messages.length;
  const chunkCount = parsed.messages.reduce((n, m) => n + m.chunks.length, 0);
  const contentCharCount = parsed.messages.reduce((n, m) => n + messageContentChars(m), 0);
  const existingDialogue = await selectOne<{ id: RecordId; first_seen_at?: unknown }>(
    db,
    "SELECT id, first_seen_at FROM dialogue WHERE identity_key = $key LIMIT 1",
    { key: input.identityKey },
  );
  const dialogueRid =
    existingDialogue?.id ?? new RecordId("dialogue", deterministicId("dlg", input.identityKey));

  let existing = await selectOne<{ dialogue: RecordId; current?: RecordId; status?: string }>(
    db,
    "SELECT dialogue, dialogue.current_revision AS current, status FROM ONLY $rid",
    { rid: revisionRid },
  );

  if (existing && existing.status !== "ready") {
    if (existing.current && String(existing.current) === String(revisionRid)) {
      throw new Error(`dialogue revision ${revisionRid} имеет status=${existing.status} и уже current`);
    }
    await cleanupStagedRevision(db, input, {
      parsed,
      revisionKey,
      revisionRid,
      docs,
    });
    existing = undefined;
  }

  if (existing) {
    const dialogueId = existing.dialogue;
    const currentKey = existing.current ? String(existing.current) : undefined;
    if (currentKey === String(revisionRid)) {
      // Полностью идемпотентный повтор: только last_seen диалога.
      await db.query("UPDATE $id SET last_seen_at = $now", { id: dialogueId, now: new Date() });
      return {
        dialogueId,
        revisionId: revisionRid,
        created: false,
        switched: false,
        messageCount,
        chunkCount,
        searchDocumentCount: 0,
        embeddingJobCount: 0,
      };
    }
    // Файл вернулся к старому содержимому: revision существует, но её
    // projection была удалена при прошлой смене current — пересоздаём (§8.1).
    const tx = new TxBuilder();
    tx.add("BEGIN;");
    tx.add(`LET $dlgId = ${tx.param(dialogueId)};`);
    tx.add(`LET $revId = ${tx.param(revisionRid)};`);
    tx.add("LET $oldRev = (SELECT VALUE current_revision FROM ONLY $dlgId);");
    tx.add("IF $oldRev != NONE AND $oldRev != $revId {");
    addProjectionDelete(tx, "$oldRev", input.embeddingTables);
    tx.add("};");
    // Leftovers этой revision (на случай прошлого сбоя) — тоже пересоздаём.
    addProjectionDelete(tx, "$revId", input.embeddingTables);
    const jobCount = addSearchProjection(
      tx,
      docs,
      input,
      revisionKey,
      dialogueId,
      revisionRid,
      (seq) => new RecordId("message", messageRecordId(revisionKey, seq)),
    );
    tx.add(
      `UPDATE ONLY $dlgId SET ` +
        tx.assignments([
          ["current_revision", revisionRid],
          ["updated_at", parsed.updatedAt],
          ["last_seen_at", new Date()],
        ]) +
        // assignments() отбрасывает undefined, а primary_model обязан
        // очищаться: revision без модели → NONE, иначе сохраняется модель
        // прежней current revision.
        `, primary_model = ${primaryModel ? tx.param(primaryModel) : "NONE"};`,
    );
    tx.add("COMMIT;");
    tx.add(`RETURN { dialogue: $dlgId, revision: $revId };`);
    const result = await db.query<unknown[]>(tx.statements.join("\n"), tx.vars);
    const returned = result.at(-1) as { dialogue?: RecordId; revision?: RecordId } | undefined;
    if (!returned || !returned.dialogue || !returned.revision) {
      // Та же защита от молчаливого обрыва транзакции, что в пути создания
      // ниже: SDK 2.0.8 может вернуть усечённый массив результатов без
      // исключения — switched:true здесь означал бы ложный «успех» sync.
      throw new Error(
        `dialogue switch transaction оборвалась: RETURN не выполнен (получено ${result.length} результатов из ${tx.statements.length} statements)`,
      );
    }
    return {
      dialogueId,
      revisionId: revisionRid,
      created: false,
      switched: true,
      messageCount,
      chunkCount,
      searchDocumentCount: docs.length,
      embeddingJobCount: jobCount,
    };
  }

  if (
    chunkCount > STAGED_WRITE_CHUNK_THRESHOLD ||
    contentCharCount > STAGED_WRITE_CONTENT_CHARS_THRESHOLD
  ) {
    return await writeDialogueRevisionStaged(db, input, {
      canonicalHash,
      revisionKey,
      revisionRid,
      docs,
      primaryModel,
      messageCount,
      chunkCount,
      dialogueRid,
      firstSeenAt: existingDialogue?.first_seen_at,
    });
  }

  // Полная транзакция создания (§10.4).
  const tx = new TxBuilder();
  tx.add("BEGIN;");
  tx.add(
    dialogueUpsertByIdStatement(
      tx,
      input,
      dialogueRid,
      existingDialogue?.first_seen_at,
    ),
  );
  tx.add(
    `LET $revId = (CREATE ONLY type::record("dialogue_revision", ${tx.param(revisionKey)}) SET ` +
      [
        "dialogue = $dlgId",
        ...tx
          .assignments([
            ["source_revision", input.sourceRevision],
            ["source_dialogue_id", input.sourceDialogueId],
            ["parser_name", input.parserName],
            ["parser_version", String(input.parserVersion)],
            ["canonical_hash", canonicalHash],
            ["status", "ready"],
            ["message_count", messageCount],
            ["chunk_count", chunkCount],
            ["started_at", parsed.startedAt],
            ["updated_at", parsed.updatedAt],
            ["parent_source_dialogue_id", lineage?.parentSourceDialogueId],
            ["agent_depth", lineage?.depth],
            ["agent_nickname", lineage?.nickname],
            ["agent_role", lineage?.role],
            ["created_at", new Date()],
          ])
          .split(", "),
      ].join(", ") +
      `).id;`,
  );
  addBulkInsert(tx, "message", messageRows(parsed, input, revisionKey, dialogueRid, revisionRid));
  addBulkInsert(tx, "chunk", chunkRows(parsed, revisionKey, dialogueRid, revisionRid));
  const jobCount = addSearchProjection(
    tx,
    docs,
    input,
    revisionKey,
    dialogueRid,
    revisionRid,
    (seq) => new RecordId("message", messageRecordId(revisionKey, seq)),
  );
  tx.add("LET $oldRev = (SELECT VALUE current_revision FROM ONLY $dlgId);");
  tx.add("IF $oldRev != NONE AND $oldRev != $revId {");
  addProjectionDelete(tx, "$oldRev", input.embeddingTables);
  tx.add("};");
  tx.add(
    `UPDATE ONLY $dlgId SET ` +
      tx.assignments([
        ["current_revision", revisionRid],
        ["updated_at", parsed.updatedAt],
        ["last_seen_at", new Date()],
      ]) +
      // primary_model — явно (см. switch-путь выше): NONE при revision
      // без модели, undefined в assignments() поле бы не очистил.
      `, primary_model = ${primaryModel ? tx.param(primaryModel) : "NONE"};`,
  );
  tx.add("COMMIT;");
  tx.add("RETURN { dialogue: $dlgId, revision: $revId };");
  const result = await db.query<unknown[]>(tx.statements.join("\n"), tx.vars);
  const returned = result.at(-1) as { dialogue?: RecordId; revision?: RecordId } | undefined;
  if (!returned || !returned.dialogue || !returned.revision) {
    // Защита от молчаливого обрыва транзакции (см. dialogueUpsertStatement):
    // SDK 2.0.8 в таком случае не бросает ошибку, а возвращает усечённый
    // массив результатов — считаем это ошибкой записи.
    throw new Error(
      `dialogue transaction оборвалась: RETURN не выполнен (получено ${result.length} результатов из ${tx.statements.length} statements)`,
    );
  }
  return {
    dialogueId: returned.dialogue,
    revisionId: returned.revision,
    created: true,
    switched: false,
    messageCount,
    chunkCount,
    searchDocumentCount: docs.length,
    embeddingJobCount: jobCount,
  };
}

/**
 * Пересоздать search projection существующей revision (baka search:rebuild):
 * в одной транзакции удалить старые search_document + embedding_job revision
 * и создать новые из подготовленных docs. Canonical corpus не трогается
 * (search projection полностью производна, §8.1).
 */
export async function replaceSearchProjection(
  db: Surreal,
  input: {
    dialogueId: RecordId;
    revisionId: RecordId;
    /** Строковый ключ revision (id-часть record id) — база детерминированных id. */
    revisionKey: string;
    docs: PreparedSearchDoc[];
    extractors: HarnessExtractors;
    activeEmbeddingSpaces: RecordId[];
    enqueueEmbeddings: boolean;
    /** Физические vector-таблицы для каскадного удаления vectors (§8.1). */
    embeddingTables?: string[];
  },
): Promise<{ searchDocumentCount: number; embeddingJobCount: number }> {
  const tx = new TxBuilder();
  tx.add("BEGIN;");
  tx.add(`LET $dlgId = ${tx.param(input.dialogueId)};`);
  tx.add(`LET $revId = ${tx.param(input.revisionId)};`);
  addProjectionDelete(tx, "$revId", input.embeddingTables);
  const jobCount = addSearchProjection(
    tx,
    input.docs,
    input,
    input.revisionKey,
    input.dialogueId,
    input.revisionId,
    (seq) => new RecordId("message", messageRecordId(input.revisionKey, seq)),
  );
  tx.add("COMMIT;");
  tx.add("RETURN { revision: $revId };");
  const result = await db.query<unknown[]>(tx.statements.join("\n"), tx.vars);
  const returned = result.at(-1) as { revision?: RecordId } | undefined;
  if (!returned?.revision) {
    // Та же защита от молчаливого обрыва транзакции, что в writeDialogueRevision.
    throw new Error(
      `projection transaction оборвалась: RETURN не выполнен (получено ${result.length} результатов из ${tx.statements.length} statements)`,
    );
  }
  return { searchDocumentCount: input.docs.length, embeddingJobCount: jobCount };
}
