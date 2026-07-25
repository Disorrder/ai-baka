/**
 * Extractor'ы OpenCode (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - user message: все text-чанки в исходном порядке (file-вложения —
 *   attachment-чанки, в промпт не входят) → opencode_user_message_text;
 * - humanAuthored === "unknown" (data.format — structured output через
 *   SDK) → fallback_visible_user_text;
 * - humanAuthored === false → не извлекается.
 *
 * assistant_final:
 * - явный final marker harness'а: assistant message с finish === "stop"
 *   (у opencode finish: stop | tool-calls; «stop» = итоговый ответ,
 *   дальше tool activity нет);
 * - собираются ВСЕ text-чанки assistant-сообщений после последнего
 *   human-authored user message — включая текст до/после tool activity
 *   (§8.3 п.5: в opencode весь text показывается пользователю);
 * - reasoning (thought), tool_call/tool_result, object/attachment —
 *   не входят;
 * - если ни одного finish === "stop" в последнем turn'е нет (обрыв,
 *   ошибка API) → тот же сбор, метод fallback_visible_assistant_text.
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

export const openCodeExtractors: HarnessExtractors = {
  harnessSlug: "opencode",
  extractorVersion: EXTRACTOR_VERSION,

  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined {
    if (message.role !== "user") return undefined;
    if (message.humanAuthored === false) return undefined;

    const { content, sourceChunks } = collectTextChunks(message);
    if (content.trim().length === 0) return undefined;
    return {
      content,
      extractionMethod:
        message.humanAuthored === true
          ? "opencode_user_message_text"
          : FALLBACK_USER_PROMPT_METHOD,
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

    const hasFinalMarker = candidates.some((message) => message.metadata.finish === "stop");

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
    return {
      content,
      extractionMethod: hasFinalMarker
        ? "opencode_finish_stop_text"
        : FALLBACK_ASSISTANT_FINAL_METHOD,
      sourceChunks,
    };
  },
};
