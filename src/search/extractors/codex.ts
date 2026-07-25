/**
 * Extractor'ы Codex (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - приоритет — текст из event_msg/user_message (metadata.userMessageText,
 *   «как набрано», без обёрток IDE/CLI) → метод codex_user_message_event;
 * - иначе text-чанки human-authored user message без авто-контекста
 *   (<environment_context> и т.п.) → codex_human_text_chunks;
 * - humanAuthored === "unknown" → fallback_visible_user_text.
 *
 * assistant_final:
 * - явный marker: последнее assistant message с metadata.phase ===
 *   "final_answer" (event_msg/agent_message) ПОСЛЕДНЕГО turn'а (после
 *   последнего user message, дающего промпт) → codex_final_answer_phase;
 *   marker предыдущего turn'а не подходит: если текущий turn оборвался,
 *   старый final_answer не должен выдаваться за ответ на новый промпт;
 * - иначе последнее видимое assistant message текущего turn'а → fallback.
 */

import type { ParsedMessage } from "../../domain/canonical-types.ts";
import {
  EXTRACTOR_VERSION,
  FALLBACK_ASSISTANT_FINAL_METHOD,
  FALLBACK_USER_PROMPT_METHOD,
  collectTextChunks,
  findLastTurnBoundary,
  type ExtractedDocument,
  type HarnessExtractors,
} from "./types.ts";

export const codexExtractors: HarnessExtractors = {
  harnessSlug: "codex",
  extractorVersion: EXTRACTOR_VERSION,

  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined {
    if (message.role !== "user") return undefined;
    if (message.humanAuthored === false) return undefined;

    const confirmed = message.metadata.userMessageText;
    if (typeof confirmed === "string" && confirmed.trim().length > 0) {
      return {
        content: confirmed,
        extractionMethod: "codex_user_message_event",
        sourceChunks: message.chunks
          .filter((chunk) => chunk.kind === "text")
          .map((chunk) => ({ messageSequence: message.sequence, chunkSequence: chunk.sequence })),
      };
    }

    const { content, sourceChunks } = collectTextChunks(
      message,
      (chunk) => chunk.metadata.autoContext !== true,
    );
    if (content.trim().length === 0) return undefined;
    return {
      content,
      extractionMethod:
        message.humanAuthored === true ? "codex_human_text_chunks" : FALLBACK_USER_PROMPT_METHOD,
      sourceChunks,
    };
  },

  extractAssistantFinal(messages: readonly ParsedMessage[]): ExtractedDocument | undefined {
    // Граница последнего turn'а: final_answer предыдущих turn'ов не
    // рассматривается — иначе при обрыве текущего turn'а extractor вернул
    // бы ответ на ПРЕДЫДУЩИЙ промпт.
    const boundary = findLastTurnBoundary(messages, (m) => this.extractUserPrompt(m));
    const assistants = messages.filter(
      (message, index) =>
        index > boundary && message.role === "assistant" && message.visibleToUser !== false,
    );

    // Явный final marker harness'а (§8.3 п.1).
    const marked = [...assistants].reverse().find((m) => m.metadata.phase === "final_answer");
    if (marked) {
      const { content, sourceChunks } = collectTextChunks(marked);
      if (content.trim().length > 0) {
        return { content, extractionMethod: "codex_final_answer_phase", sourceChunks };
      }
    }

    // Fallback: последнее видимое assistant message с текстом.
    for (let i = assistants.length - 1; i >= 0; i--) {
      const { content, sourceChunks } = collectTextChunks(assistants[i]!);
      if (content.trim().length > 0) {
        return { content, extractionMethod: FALLBACK_ASSISTANT_FINAL_METHOD, sourceChunks };
      }
    }
    return undefined;
  },
};
