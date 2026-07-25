/**
 * Реестр harness tools для sync (этап 5): parser + extractors + гранулярность
 * parse unit'а.
 *
 * parseUnit:
 * - "file" — один source file = независимый parse (codex, claude-code,
 *   claude-desktop, opencode, cursor, qwen-code; SQLite snapshot даёт
 *   поток диалогов — каждый пишется своей транзакцией, §10.4);
 * - "kimi-session" — диалог kimi-code = каталог сессии (state.json +
 *   agents/<*>/wire.jsonl, docs/sources.md); sync собирает parse-view
 *   каталога из immutable raw-файлов (hardlink'и) и парсит его целиком.
 */

import type { HarnessSlug } from "../sources/adapters/harnesses.ts";
import type { HarnessParser } from "../parsers/shared/parser.ts";
import type { HarnessExtractors } from "../search/extractors/types.ts";
import { codexParser } from "../parsers/codex/index.ts";
import { claudeCodeParser } from "../parsers/claude-code/index.ts";
import { claudeDesktopParser } from "../parsers/claude-desktop/index.ts";
import { openCodeParser } from "../parsers/opencode/index.ts";
import { cursorParser } from "../parsers/cursor/index.ts";
import { qwenCodeParser } from "../parsers/qwen-code/index.ts";
import { kimiCodeParser } from "../parsers/kimi-code/index.ts";
import { codexExtractors } from "../search/extractors/codex.ts";
import { claudeCodeExtractors } from "../search/extractors/claude-code.ts";
import { claudeDesktopExtractors } from "../search/extractors/claude-desktop.ts";
import { openCodeExtractors } from "../search/extractors/opencode.ts";
import { cursorExtractors } from "../search/extractors/cursor.ts";
import { qwenCodeExtractors } from "../search/extractors/qwen-code.ts";
import { kimiCodeExtractors } from "../search/extractors/kimi-code.ts";

export type ParseUnit = "file" | "kimi-session";

export interface HarnessTools {
  parser: HarnessParser;
  extractors: HarnessExtractors;
  parseUnit: ParseUnit;
}

export const HARNESS_TOOLS: Record<HarnessSlug, HarnessTools> = {
  codex: { parser: codexParser, extractors: codexExtractors, parseUnit: "file" },
  "claude-code": { parser: claudeCodeParser, extractors: claudeCodeExtractors, parseUnit: "file" },
  "claude-desktop": {
    parser: claudeDesktopParser,
    extractors: claudeDesktopExtractors,
    parseUnit: "file",
  },
  opencode: { parser: openCodeParser, extractors: openCodeExtractors, parseUnit: "file" },
  cursor: { parser: cursorParser, extractors: cursorExtractors, parseUnit: "file" },
  "qwen-code": { parser: qwenCodeParser, extractors: qwenCodeExtractors, parseUnit: "file" },
  "kimi-code": { parser: kimiCodeParser, extractors: kimiCodeExtractors, parseUnit: "kimi-session" },
};

/**
 * Сессионный каталог kimi-code по relative path файла
 * (`<wdKey>/<sessionId>/state.json`, `<wdKey>/<sessionId>/agents/<agent>/wire.jsonl`);
 * undefined — файл вне структуры сессии (session_index.jsonl и т.п.).
 */
export function kimiSessionDir(relativePath: string): string | undefined {
  const wire = /^(.+)\/agents\/[^/]+\/wire\.jsonl$/.exec(relativePath);
  if (wire) return wire[1];
  const state = /^(.+)\/state\.json$/.exec(relativePath);
  if (state) return state[1];
  return undefined;
}
