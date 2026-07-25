/**
 * Extractor'ы Cursor (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - user bubble — набранный человеком промпт (приложенный контекст Cursor
 *   хранит в отдельных полях bubble, в text он не попадает) →
 *   cursor_user_bubble_text;
 * - humanAuthored === "unknown" → fallback_visible_user_text.
 *
 * assistant_final:
 * Явных final markers в формате Cursor нет (bubbles без phase/timestamps)
 * → fallback по §8.3: все text-чанки assistant-сообщений ПОСЛЕДНЕГО turn'а
 * (после последнего human-authored user message), в исходном порядке —
 * включая текст до и после tool activity (§8.3 п.5; у Cursor текст до/после
 * вызова инструмента — отдельные assistant bubbles). Thought (isThought /
 * allThinkingBlocks), tool_call и tool_result исключаются по kind.
 * Метод фиксируется как fallback_visible_assistant_text.
 */

import type { ParsedMessage } from "../../domain/canonical-types.ts";
import {
  EXTRACTOR_VERSION,
  FALLBACK_ASSISTANT_FINAL_METHOD,
  FALLBACK_USER_PROMPT_METHOD,
  collectTextChunks,
  type ExtractedDocument,
  type HarnessExtractors,
} from "./types.ts";

export const cursorExtractors: HarnessExtractors = {
  harnessSlug: "cursor",
  extractorVersion: EXTRACTOR_VERSION,

  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined {
    if (message.role !== "user") return undefined;
    if (message.humanAuthored === false) return undefined;

    const { content, sourceChunks } = collectTextChunks(message);
    if (content.trim().length === 0) return undefined;
    return {
      content,
      extractionMethod:
        message.humanAuthored === true ? "cursor_user_bubble_text" : FALLBACK_USER_PROMPT_METHOD,
      sourceChunks,
    };
  },

  extractAssistantFinal(messages: readonly ParsedMessage[]): ExtractedDocument | undefined {
    // Граница последнего turn'а: последний human-authored user message.
    let boundary = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role === "user" && message.humanAuthored === true) {
        boundary = i;
        break;
      }
    }

    const candidates = messages.filter(
      (message, index) =>
        index > boundary && message.role === "assistant" && message.visibleToUser !== false,
    );

    const contentParts: string[] = [];
    const sourceChunks: ExtractedDocument["sourceChunks"] = [];
    for (const message of candidates) {
      const { content, sourceChunks: refs } = collectTextChunks(message);
      if (content.trim().length === 0) continue;
      contentParts.push(content);
      sourceChunks.push(...refs);
    }

    const content = contentParts.join("\n");
    if (content.trim().length === 0) return undefined;
    return { content, extractionMethod: FALLBACK_ASSISTANT_FINAL_METHOD, sourceChunks };
  },
};
