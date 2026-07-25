/**
 * Extractor'ы Kimi Code (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - user message с origin.kind === "user" (turn.prompt, человек набрал
 *   сам) → kimi_code_turn_prompt_user;
 * - origin system_trigger/background_task/subagent — НЕ human-authored,
 *   в user_prompt не попадает;
 * - humanAuthored === "unknown" → fallback_visible_user_text.
 *
 * assistant_final:
 * Явных final markers у kimi-code wire нет → fallback по §8.3:
 * все text-чанки assistant-сообщений ПОСЛЕДНЕГО turn'а основного агента
 * (после последнего user message, дающего промпт, — включая промпт с
 * humanAuthored "unknown", прошедший fallback: он тоже граница turn'а),
 * в исходном порядке — включая текст до и после tool activity (§8.3 п.5).
 * Без think/tool.
 * Сообщения субагентов (metadata.subagentId) в финальный ответ основного
 * диалога не входят: их вывод свёрнут в tool result основного агента.
 * Метод фиксируется как fallback_visible_assistant_text.
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

export const kimiCodeExtractors: HarnessExtractors = {
  harnessSlug: "kimi-code",
  extractorVersion: EXTRACTOR_VERSION,

  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined {
    if (message.role !== "user") return undefined;
    if (message.humanAuthored === false) return undefined;

    const originKind =
      typeof message.metadata.origin === "object" && message.metadata.origin !== null
        ? (message.metadata.origin as Record<string, unknown>).kind
        : undefined;

    const { content, sourceChunks } = collectTextChunks(message);
    if (content.trim().length === 0) return undefined;
    return {
      content,
      extractionMethod:
        message.humanAuthored === true && originKind === "user"
          ? "kimi_code_turn_prompt_user"
          : FALLBACK_USER_PROMPT_METHOD,
      sourceChunks,
    };
  },

  extractAssistantFinal(messages: readonly ParsedMessage[]): ExtractedDocument | undefined {
    // Граница последнего turn'а: последний user message, дающий промпт
    // (human-authored или unknown, прошедший fallback).
    const boundary = findLastTurnBoundary(messages, (m) => this.extractUserPrompt(m));

    const candidates = messages.filter(
      (message, index) =>
        index > boundary &&
        message.role === "assistant" &&
        message.visibleToUser !== false &&
        message.metadata.subagentId === undefined,
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
