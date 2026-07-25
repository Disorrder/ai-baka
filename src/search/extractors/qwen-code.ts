/**
 * Extractor'ы Qwen Code (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - user message без subtype (обычный промпт) или subtype
 *   "mid_turn_user_message" — человек набрал сам → qwen_code_user_prompt;
 * - subtype "notification" (task-notification субагента) и "cron"
 *   (expansion слэш-команды/skill'а) — НЕ human-authored, не извлекаются;
 * - вложения (inlineData) в промпт не входят — только text-чанки;
 * - humanAuthored === "unknown" → fallback_visible_user_text.
 *
 * assistant_final:
 * Явных final markers у qwen-code chat JSONL нет (usageMetadata и
 * ui_telemetry — не маркеры конца ответа) → fallback по §8.3:
 * все text-чанки видимых assistant-сообщений ПОСЛЕДНЕГО turn'а (после
 * последнего human-authored user message, включая mid_turn), в исходном
 * порядке — текст до и после tool activity сохраняется (§8.3 п.5).
 * Без thought/tool_call/tool_result. Метод — fallback_visible_assistant_text.
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

export const qwenCodeExtractors: HarnessExtractors = {
  harnessSlug: "qwen-code",
  extractorVersion: EXTRACTOR_VERSION,

  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined {
    if (message.role !== "user") return undefined;
    if (message.humanAuthored === false) return undefined;

    const { content, sourceChunks } = collectTextChunks(message);
    if (content.trim().length === 0) return undefined;
    const subtype = message.metadata.subtype;
    return {
      content,
      extractionMethod:
        message.humanAuthored === true &&
        (subtype === undefined || subtype === "mid_turn_user_message")
          ? "qwen_code_user_prompt"
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

    const contentParts: string[] = [];
    const sourceChunks: ExtractedDocument["sourceChunks"] = [];
    for (const [index, message] of messages.entries()) {
      if (index <= boundary) continue;
      if (message.role !== "assistant" || message.visibleToUser !== true) continue;
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
