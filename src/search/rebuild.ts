/**
 * Rebuild search projection (docs/plan.md §8.1, §17.4 — команда
 * `baka search:rebuild`, sync_run.kind = search_rebuild).
 *
 * Пересоздаёт search_document (+ embedding_job) для всех CURRENT revisions:
 * canonical messages/chunks читаются из БД, extractors + segmenter
 * прогоняются заново текущими версиями, projection заменяется атомарно
 * (транзакция replaceSearchProjection, src/db/repositories/corpus.ts).
 * Нужен после смены SEGMENTATION_VERSION / EXTRACTOR_VERSION.
 *
 * Известное ограничение: human_authored/visible_to_user хранятся bool —
 * исходное "unknown" parser contract'а при записи сводится к false
 * (см. corpus.ts), поэтому rebuild трактует его как false. На текущих
 * parser'ах humanAuthored === "unknown" не встречается; visibleToUser
 * "unknown" emits только opencode (data.format) — при смене
 * EXTRACTOR_VERSION для opencode projection корректнее пересоздать
 * полным re-parse из raw, а не rebuild'ом из БД.
 */

import type { RecordId, Surreal } from "surrealdb";
import type { ParsedDialogue, ParsedMessage } from "../domain/canonical-types.ts";
import { gitHead } from "../db/migrations.ts";
import {
  createSyncRun,
  finishSyncRun,
  listActiveEmbeddingSpaces,
} from "../db/repositories/provenance.ts";
import { selectAll } from "../db/repositories/helpers.ts";
import {
  prepareSearchDocuments,
  replaceSearchProjection,
} from "../db/repositories/corpus.ts";
import { HARNESS_TOOLS } from "../sync/harness-tools.ts";

export interface RebuildSummary {
  revisions: number;
  dialogues: number;
  searchDocuments: number;
  embeddingJobs: number;
  /** Revisions с неизвестным parser_name (projection не тронута). */
  skipped: number;
  syncRunId?: string;
}

interface RevisionRow {
  id: RecordId;
  dialogue: RecordId;
  parser_name: string;
}

interface MessageRow {
  id: RecordId;
  sequence: number;
  role: ParsedMessage["role"];
  raw_role?: string;
  human_authored: boolean;
  visible_to_user: boolean;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

interface ChunkRow {
  message: RecordId;
  sequence: number;
  kind: ParsedMessage["chunks"][number]["kind"];
  raw_kind?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

/** Восстановить parse-view диалога из canonical rows (только поля extractors). */
function reconstructedDialogue(messages: MessageRow[], chunks: ChunkRow[]): ParsedDialogue {
  const chunksByMessage = new Map<string, ChunkRow[]>();
  for (const chunk of chunks) {
    const key = String(chunk.message);
    const list = chunksByMessage.get(key) ?? [];
    list.push(chunk);
    chunksByMessage.set(key, list);
  }
  return {
    messages: messages.map((m) => ({
      sequence: m.sequence,
      role: m.role,
      rawRole: m.raw_role,
      humanAuthored: m.human_authored,
      visibleToUser: m.visible_to_user,
      timestamp: m.timestamp,
      usageEvents: [],
      chunks: (chunksByMessage.get(String(m.id)) ?? [])
        .sort((a, b) => a.sequence - b.sequence)
        .map((c) => ({
          sequence: c.sequence,
          kind: c.kind,
          rawKind: c.raw_kind,
          content: c.content,
          metadata: c.metadata ?? {},
        })),
      metadata: m.metadata ?? {},
    })),
    metadata: {},
  };
}

export async function rebuildSearchProjection(
  db: Surreal,
  opts: {
    host: RecordId;
    schemaVersion: number;
    enqueueEmbeddings: boolean;
    logger?: (event: Record<string, unknown>) => void;
  },
): Promise<RebuildSummary> {
  const log = opts.logger ?? (() => {});
  const summary: RebuildSummary = {
    revisions: 0,
    dialogues: 0,
    searchDocuments: 0,
    embeddingJobs: 0,
    skipped: 0,
  };
  const syncRun = await createSyncRun(db, {
    kind: "search_rebuild",
    host: opts.host,
    bakaCommit: gitHead(),
    schemaVersion: opts.schemaVersion,
  });
  summary.syncRunId = syncRun.toString();
  let runStatus = "completed";
  try {
    const revisions = await selectAll<RevisionRow>(
      db,
      "SELECT id, dialogue, parser_name FROM dialogue_revision WHERE id = dialogue.current_revision",
    );
    const activeSpaces = opts.enqueueEmbeddings
      ? (await listActiveEmbeddingSpaces(db)).map((s) => s.id)
      : [];

    for (const revision of revisions) {
      const tools = Object.values(HARNESS_TOOLS).find(
        (t) => t.parser.parserName === revision.parser_name,
      );
      if (!tools) {
        summary.skipped += 1;
        log({
          event: "rebuild_revision_skipped",
          revision: String(revision.id),
          reason: `неизвестный parser_name ${revision.parser_name}`,
        });
        continue;
      }
      const messages = await selectAll<MessageRow>(
        db,
        "SELECT id, sequence, role, raw_role, human_authored, visible_to_user, timestamp, metadata FROM message WHERE dialogue_revision = $rev ORDER BY sequence",
        { rev: revision.id },
      );
      const chunks = await selectAll<ChunkRow>(
        db,
        "SELECT message, sequence, kind, raw_kind, content, metadata FROM chunk WHERE dialogue_revision = $rev",
        { rev: revision.id },
      );
      const parsed = reconstructedDialogue(messages, chunks);
      // revisionKey — id-часть record id (rev_<sha256>); детерминированные
      // search_document id совпадают с теми, что создаёт sync.
      const revisionKey = revision.id.id as string;
      const docs = prepareSearchDocuments(parsed, revisionKey, tools.extractors);
      const result = await replaceSearchProjection(db, {
        dialogueId: revision.dialogue,
        revisionId: revision.id,
        revisionKey,
        docs,
        extractors: tools.extractors,
        activeEmbeddingSpaces: activeSpaces,
        enqueueEmbeddings: opts.enqueueEmbeddings,
      });
      summary.revisions += 1;
      summary.searchDocuments += result.searchDocumentCount;
      summary.embeddingJobs += result.embeddingJobCount;
      log({
        event: "rebuild_revision",
        revision: String(revision.id),
        searchDocuments: result.searchDocumentCount,
      });
    }
    summary.dialogues = summary.revisions; // одна current revision на диалог
  } catch (error) {
    runStatus = "failed";
    throw error;
  } finally {
    await finishSyncRun(db, syncRun, {
      status: runStatus,
      counters: { ...summary, syncRunId: undefined },
    }).catch(() => {});
  }
  return summary;
}
