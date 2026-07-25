/**
 * Per-harness matcher'ы: какие файлы внутри source root являются источниками
 * диалогов (docs/sources.md). Используются scanner'ом при обходе дерева.
 *
 * AppleDouble-файлы (._*) scanner отсекает сам, до matcher'а.
 */

import type { HarnessSlug } from "./harnesses.ts";

export type FileMatcher = (relativePath: string, basename: string) => boolean;

/** Принимает все обычные файлы (для file-backed хранилищ без чётких расширений). */
export const matchAll: FileMatcher = () => true;

function extensions(...exts: string[]): FileMatcher {
  return (_relativePath, basename) =>
    exts.some((ext) => basename.toLowerCase().endsWith(ext));
}

export const HARNESS_FILE_MATCHERS: Record<HarnessSlug, FileMatcher> = {
  // JSONL transcripts (archived_sessions/sessions); ~/.codex/sqlite — см. ниже.
  codex: extensions(".jsonl", ".sqlite", ".sqlite3", ".db"),
  "claude-code": extensions(".jsonl"),
  // IndexedDB/Session Storage: leveldb-файлы (.log/.ldb/.sst/MANIFEST-*) без
  // единого расширения — берём всё.
  "claude-desktop": matchAll,
  // opencode.db + storage/session_diff (JSON-дампы).
  opencode: extensions(".db", ".json"),
  // state.vscdb / workspaceStorage (*.vscdb + JSON-метаданные).
  cursor: extensions(".vscdb", ".db", ".json"),
  "qwen-code": extensions(".jsonl"),
  // wire.jsonl, state.json, session_index.jsonl.
  "kimi-code": extensions(".jsonl", ".json"),
};

/** SQLite-файлы snapshot'ятся только через VACUUM INTO, никогда filesystem copy. */
const SQLITE_EXTENSIONS = [".db", ".sqlite", ".sqlite3", ".vscdb"];

export function isSqlitePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SQLITE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
