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
import type { HarnessExtractors } from "../../search/extractors/types.ts";
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
import { sha256hex } from "../transactions.ts";
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
 * Детерминированный id включает documentType + порядковый номер документа
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

  let userPromptIndex = 0;
  for (const message of parsed.messages) {
    const extracted = extractors.extractUserPrompt(message);
    if (!extracted || extracted.content.trim().length === 0) continue;
    pushDoc("user_prompt", userPromptIndex++, message.sequence, extracted);
  }
  const final = extractors.extractAssistantFinal(parsed.messages);
  if (final && final.content.trim().length > 0) {
    pushDoc("assistant_final", 0, final.sourceChunks[0]?.messageSequence, final);
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
    ["usage", usage ? clean(usage) : undefined],
    ["raw_usage_events", message.usageEvents.length > 0 ? clean(message.usageEvents) : undefined],
    ["metadata", Object.keys(message.metadata).length > 0 ? clean(message.metadata) : undefined],
  ];
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
  messageRef: (sequence: number) => string,
): number {
  let jobCount = 0;
  let k = 0;
  for (const doc of docs) {
    const docVar = `$sd${k++}`;
    const messageLink =
      doc.messageSequence !== undefined ? `message = ${messageRef(doc.messageSequence)}` : undefined;
    tx.add(
      `LET ${docVar} = (CREATE ONLY type::record("search_document", ${tx.param(doc.recordKey)}) SET ` +
        [
          "dialogue = $dlgId",
          "dialogue_revision = $revId",
          messageLink,
          ...[
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
          ].map(([field, value]) => `${field} = ${tx.param(value)}`),
        ]
          .filter(Boolean)
          .join(", ") +
        `).id;`,
    );
    if (!input.enqueueEmbeddings) continue;
    for (const space of input.activeEmbeddingSpaces) {
      const jobKey = embeddingJobRecordId(doc.recordKey, String(space));
      tx.add(
        `CREATE ONLY type::record("embedding_job", ${tx.param(jobKey)}) SET ` +
          `search_document = ${docVar}, embedding_space = ${tx.param(space)}, ` +
          `input_sha256 = ${tx.param(doc.contentSha256)}, status = "pending", attempts = 0, ` +
          `created_at = ${tx.param(new Date())};`,
      );
      jobCount += 1;
    }
  }
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

/**
 * Записать один ParsedDialogue в БД атомарно (§10.4).
 * Определение «уже записано» — до транзакции; оба пути идемпотентны.
 */
export async function writeDialogueRevision(
  db: Surreal,
  input: DialogueTxInput,
): Promise<DialogueWriteResult> {
  const parsed = input.parsed;
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

  const existing = await selectOne<{ dialogue: RecordId; current?: RecordId }>(
    db,
    "SELECT dialogue, dialogue.current_revision AS current FROM ONLY $rid",
    { rid: revisionRid },
  );

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
    const jobCount = addSearchProjection(tx, docs, input, revisionKey, (seq) =>
      tx.param(new RecordId("message", messageRecordId(revisionKey, seq))),
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

  // Полная транзакция создания (§10.4).
  const tx = new TxBuilder();
  tx.add("BEGIN;");
  tx.add(dialogueUpsertStatement(tx, input));
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
            ["created_at", new Date()],
          ])
          .split(", "),
      ].join(", ") +
      `).id;`,
  );
  for (const message of parsed.messages) {
    const mKey = messageRecordId(revisionKey, message.sequence);
    tx.add(
      `LET $m${message.sequence} = (CREATE ONLY type::record("message", ${tx.param(mKey)}) SET ` +
        ["dialogue = $dlgId", "dialogue_revision = $revId", ...tx.assignments(messageFields(message, input.modelIds)).split(", ")].join(", ") +
        `).id;`,
    );
    for (const chunk of message.chunks) {
      const content = chunk.content ?? "";
      tx.add(
        `CREATE ONLY type::record("chunk", ${tx.param(chunkRecordId(revisionKey, message.sequence, chunk.sequence))}) SET ` +
          [
            "dialogue = $dlgId",
            "dialogue_revision = $revId",
            `message = $m${message.sequence}`,
            ...tx
              .assignments([
                ["sequence", chunk.sequence],
                ["kind", chunk.kind],
                ["raw_kind", chunk.rawKind],
                ["role", message.role],
                ["content", content],
                ["content_sha256", sha256hex(content)],
                ["content_bytes", Buffer.byteLength(content, "utf8")],
                ["source_locator", chunk.sourceLocator],
                ["tool_call_id", chunk.toolCallId],
                ["tool_name", chunk.toolName],
                ["raw_event_type", chunk.rawEventType],
                ["metadata", Object.keys(chunk.metadata).length > 0 ? clean(chunk.metadata) : undefined],
              ])
              .split(", "),
          ].join(", ") +
          `;`,
      );
    }
  }
  const jobCount = addSearchProjection(tx, docs, input, revisionKey, (seq) => `$m${seq}`);
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
  const jobCount = addSearchProjection(tx, input.docs, input, input.revisionKey, (seq) =>
    tx.param(new RecordId("message", messageRecordId(input.revisionKey, seq))),
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
