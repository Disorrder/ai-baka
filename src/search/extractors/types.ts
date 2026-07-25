/**
 * Extractor'ы поисковой проекции (docs/plan.md §8.2–8.3).
 *
 * Из парсенного диалога извлекаются только два типа документов:
 * - user_prompt — реальный промпт человека;
 * - assistant_final — финальный видимый ответ ассистента.
 *
 * Reasoning, tool calls/results, system/developer контекст в поисковую
 * проекцию НЕ попадают (план §2.1).
 *
 * Интерфейс общий: остальные harness'ы добавляют свою реализацию.
 */

import type { ParsedMessage } from "../../domain/canonical-types.ts";

/** Версия логики извлечения (search_document.extraction_version). */
export const EXTRACTOR_VERSION = 1;

export interface ExtractedDocument {
  content: string;
  /** Способ извлечения (search_document.extraction_method). */
  extractionMethod: string;
  /** Ссылки на исходные chunks (message sequence + chunk sequence). */
  sourceChunks: Array<{ messageSequence: number; chunkSequence: number }>;
}

export interface HarnessExtractors {
  readonly harnessSlug: string;
  readonly extractorVersion: number;
  /** user_prompt из одного user message; undefined — извлекать нечего. */
  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined;
  /**
   * assistant_final по всем сообщениям диалога.
   * Правила §8.3: явные final markers когда есть; НЕ «последний text
   * chunk»; без reasoning/tool; текст до и после tool activity сохраняется;
   * при неоднозначности — fallback_visible_assistant_text.
   */
  extractAssistantFinal(messages: readonly ParsedMessage[]): ExtractedDocument | undefined;
}

/** Общий сборщик text-чанков сообщения. */
export function collectTextChunks(
  message: ParsedMessage,
  filter?: (chunk: ParsedMessage["chunks"][number]) => boolean,
): { content: string; sourceChunks: ExtractedDocument["sourceChunks"] } {
  const chunks = message.chunks.filter(
    (chunk) => chunk.kind === "text" && (chunk.content ?? "").length > 0 && (filter?.(chunk) ?? true),
  );
  return {
    content: chunks.map((chunk) => chunk.content ?? "").join("\n"),
    sourceChunks: chunks.map((chunk) => ({
      messageSequence: message.sequence,
      chunkSequence: chunk.sequence,
    })),
  };
}

export const FALLBACK_USER_PROMPT_METHOD = "fallback_visible_user_text";
export const FALLBACK_ASSISTANT_FINAL_METHOD = "fallback_visible_assistant_text";
