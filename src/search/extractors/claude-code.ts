/**
 * Extractor'ы Claude Code (docs/plan.md §8.2–8.3).
 *
 * user_prompt:
 * - user message с origin.kind === "human" (parser кладёт в
 *   metadata.originKind, humanAuthored === true) → claude_code_origin_human;
 * - tool_result-only записи, isMeta и авто-контекст (<command-name>,
 *   Caveat:, <local-command-*>) — НЕ human-authored, в user_prompt
 *   не попадают;
 * - humanAuthored === "unknown" (старые транскрипты без origin) →
 *   fallback_visible_user_text.
 *
 * assistant_final:
 * Явных final markers в транскрипте нет (stop_reason относится к одному
 * API-вызову, а не к итоговому ответу) → fallback по §8.3: все text-чанки
 * видимых assistant-сообщений ПОСЛЕДНЕГО turn'а основной цепочки (после
 * последнего human-authored user message), в исходном порядке — включая
 * текст до и после tool activity (§8.3 п.5). Без thinking/tool/unknown.
 * Sidechain-сообщения субагентов (metadata.sidechain) не входят: их вывод
 * возвращается в основную цепочку как tool result. Метод фиксируется как
 * fallback_visible_assistant_text.
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

export const claudeCodeExtractors: HarnessExtractors = {
  harnessSlug: "claude-code",
  extractorVersion: EXTRACTOR_VERSION,

  extractUserPrompt(message: ParsedMessage): ExtractedDocument | undefined {
    if (message.role !== "user") return undefined;
    if (message.humanAuthored === false) return undefined;

    const { content, sourceChunks } = collectTextChunks(
      message,
      (chunk) => chunk.metadata.autoContext !== true,
    );
    if (content.trim().length === 0) return undefined;
    return {
      content,
      extractionMethod:
        message.humanAuthored === true && message.metadata.originKind === "human"
          ? "claude_code_origin_human"
          : FALLBACK_USER_PROMPT_METHOD,
      sourceChunks,
    };
  },

  extractAssistantFinal(messages: readonly ParsedMessage[]): ExtractedDocument | undefined {
    // Граница последнего turn'а: последний видимый user message, который
    // не отвергнут как не-человеческий (origin human ИЛИ unknown — старые
    // транскрипты без origin тоже разделяют turn'ы).
    let boundary = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (
        message.role === "user" &&
        message.humanAuthored !== false &&
        message.visibleToUser === true
      ) {
        boundary = i;
        break;
      }
    }

    const candidates = messages.filter(
      (message, index) =>
        index > boundary &&
        message.role === "assistant" &&
        message.visibleToUser !== false &&
        message.metadata.sidechain !== true,
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
