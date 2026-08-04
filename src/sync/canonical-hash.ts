/**
 * canonical_hash диалога (docs/plan.md §7.3 `dialogue_revision`).
 *
 * Hash стабильной проекции ParsedDialogue: содержимое сообщений/чанков,
 * модели, usage (включая raw payload), metadata сообщений/чанков,
 * временные метки. Всё canonical-содержимое, которое writer сохраняет в БД,
 * покрыто hash'ем:
 * иначе два snapshot'а, различающиеся только metadata/raw usage,
 * получали бы одинаковый revision id — запись пропускалась, а в БД
 * оставались устаревшие данные. metadata ДИАЛОГА в hash не входит —
 * writer её не сохраняет. Производные кеш-поля (например response timing)
 * в hash не входят: их можно backfill'ить из raw event stream без
 * пересоздания immutable dialogue_revision.
 *
 * canonical_hash вместе с identity_key и parser name@version образует
 * детерминированный id dialogue_revision — одинаковое содержимое даёт
 * ту же revision (идемпотентность, §19.2 сценарий 1), изменённое —
 * новую (сценарий 9, §10.5).
 */

import type { ParsedDialogue } from "../domain/canonical-types.ts";
import { deterministicId, sha256hex } from "../db/transactions.ts";

/**
 * Детерминированная нормализация произвольных payload'ов для hash:
 * ключи объектов сортируются рекурсивно (порядок ключей в metadata/raw
 * не должен влиять на hash), Date → ISO, undefined → null.
 */
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => [key, stable(v)]);
    return Object.fromEntries(entries);
  }
  return value ?? null;
}

export function canonicalDialogueHash(dialogue: ParsedDialogue): string {
  const projection = {
    externalId: dialogue.externalId ?? null,
    title: dialogue.title ?? null,
    workspace: dialogue.workspace
      ? {
          path: dialogue.workspace.path ?? null,
          repositoryIdentity: dialogue.workspace.repositoryIdentity ?? null,
        }
      : null,
    startedAt: dialogue.startedAt?.toISOString() ?? null,
    updatedAt: dialogue.updatedAt?.toISOString() ?? null,
    messages: dialogue.messages.map((m) => ({
      sequence: m.sequence,
      externalId: m.externalId ?? null,
      role: m.role,
      rawRole: m.rawRole ?? null,
      humanAuthored: m.humanAuthored,
      visibleToUser: m.visibleToUser,
      timestamp: m.timestamp?.toISOString() ?? null,
      model: m.model
        ? {
            rawModelName: m.model.rawModelName,
            vendor: m.model.vendor,
            canonicalName: m.model.canonicalName,
            reasoningEffort: m.model.reasoningEffort ?? null,
            serviceProvider: m.model.serviceProvider ?? null,
          }
        : null,
      usageEvents: m.usageEvents.map((e) => ({
        scope: e.scope,
        inputTokens: e.inputTokens ?? null,
        cachedInputTokens: e.cachedInputTokens ?? null,
        cacheWriteInputTokens: e.cacheWriteInputTokens ?? null,
        outputTokens: e.outputTokens ?? null,
        reasoningOutputTokens: e.reasoningOutputTokens ?? null,
        totalTokensReported: e.totalTokensReported ?? null,
        isEstimated: e.isEstimated ?? null,
        source: e.source,
        raw: e.raw === undefined ? null : stable(e.raw),
      })),
      chunks: m.chunks.map((c) => ({
        sequence: c.sequence,
        kind: c.kind,
        rawKind: c.rawKind ?? null,
        content: c.content ?? null,
        sourceLocator: c.sourceLocator ?? null,
        toolCallId: c.toolCallId ?? null,
        toolName: c.toolName ?? null,
        rawEventType: c.rawEventType ?? null,
        metadata: stable(c.metadata),
      })),
      metadata: stable(m.metadata),
    })),
  };
  return sha256hex(JSON.stringify(projection));
}

/**
 * Детерминированный id dialogue_revision:
 * sha256(identity_key | parser@version | canonical_hash).
 */
export function dialogueRevisionId(
  identityKey: string,
  parserName: string,
  parserVersion: number,
  canonicalHash: string,
): string {
  return deterministicId("rev", `${identityKey}|${parserName}@${parserVersion}|${canonicalHash}`);
}

export function messageRecordId(revisionId: string, sequence: number): string {
  return deterministicId("msg", `${revisionId}:${sequence}`);
}

export function chunkRecordId(revisionId: string, messageSequence: number, chunkSequence: number): string {
  return deterministicId("chk", `${revisionId}:${messageSequence}:${chunkSequence}`);
}

export function searchDocumentRecordId(
  revisionId: string,
  documentType: string,
  docIndex: number,
  segmentNo: number,
): string {
  return deterministicId("sdoc", `${revisionId}:${documentType}:${docIndex}:${segmentNo}`);
}

export function embeddingJobRecordId(searchDocumentId: string, embeddingSpaceId: string): string {
  return deterministicId("job", `${searchDocumentId}:${embeddingSpaceId}`);
}
