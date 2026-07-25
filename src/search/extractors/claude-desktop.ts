/**
 * Extractor'ы Claude Desktop (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - user message основной цепочки (humanAuthored === true) →
 *   claude_desktop_audit_user_prompt; обёртка <uploaded_files> уже
 *   вынесена parser'ом в attachment chunk, сюда попадает только текст;
 * - sidechain-промпты субагентов (metadata.parentToolUseId) и
 *   system-reminder в user_prompt не попадают (humanAuthored === false);
 * - humanAuthored === "unknown" → fallback_visible_user_text.
 *
 * assistant_final:
 * - явный marker harness'а: result-событие завершения turn'а — parser
 *   ставит metadata.turnResult на последнее assistant-сообщение turn'а
 *   (§8.3 п.1) → claude_desktop_turn_result;
 * - граница последнего turn'а — последний human-authored user message;
 *   в ответ идут все text-чанки видимых assistant-сообщений turn'а в
 *   исходном порядке, включая текст до и после tool activity (§8.3 п.5);
 *   thinking/tool_use/tool_result исключаются;
 * - turn не завершён (result отсутствует, truncated source) →
 *   fallback_visible_assistant_text.
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

export const claudeDesktopExtractors: HarnessExtractors = {
  harnessSlug: "claude-desktop",
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
          ? "claude_desktop_audit_user_prompt"
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
        index > boundary &&
        message.role === "assistant" &&
        message.visibleToUser !== false &&
        message.metadata.parentToolUseId === undefined,
    );

    const contentParts: string[] = [];
    const sourceChunks: ExtractedDocument["sourceChunks"] = [];
    let sawTurnResult = false;
    for (const message of candidates) {
      const { content, sourceChunks: refs } = collectTextChunks(message);
      if (content.trim().length > 0) {
        contentParts.push(content);
        sourceChunks.push(...refs);
      }
      if (message.metadata.turnResult !== undefined) sawTurnResult = true;
    }

    const content = contentParts.join("\n");
    if (content.trim().length === 0) return undefined;
    return {
      content,
      extractionMethod: sawTurnResult
        ? "claude_desktop_turn_result"
        : FALLBACK_ASSISTANT_FINAL_METHOD,
      sourceChunks,
    };
  },
};
