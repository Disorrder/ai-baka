/**
 * Extractor'ы OMP (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - message.role user + humanAuthored=true → omp_user_prompt;
 * - humanAuthored="unknown" → fallback_visible_user_text;
 * - tool/system/custom operational text не извлекается.
 *
 * assistant_final:
 * Явных final markers у OMP JSONL нет → fallback по §8.3:
 * все text-чанки видимых assistant-сообщений текущего turn'а. Reasoning,
 * tool calls/results и hidden custom/system messages не попадают в search.
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

export const ompExtractors: HarnessExtractors = {
  harnessSlug: "omp",
  extractorVersion: EXTRACTOR_VERSION,

  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined {
    if (message.role !== "user") return undefined;
    if (message.humanAuthored === false) return undefined;

    const { content, sourceChunks } = collectTextChunks(message);
    if (content.trim().length === 0) return undefined;
    return {
      content,
      extractionMethod:
        message.humanAuthored === true ? "omp_user_prompt" : FALLBACK_USER_PROMPT_METHOD,
      sourceChunks,
    };
  },

  extractAssistantFinal(messages: readonly ParsedMessage[]): ExtractedDocument | undefined {
    const boundary = findLastTurnBoundary(messages, (m) => this.extractUserPrompt(m));
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
