/**
 * Базовый интерфейс harness parser'а (docs/plan.md §11, §11.1).
 *
 * Parser — чистая функция от raw snapshot'а: читает файлы с диска и
 * возвращает DTO (src/domain/canonical-types.ts). В SurrealDB не пишет.
 *
 * Изменение логики нормализации повышает parserVersion — старые raw
 * ревизии перепарсиваются `baka reparse` в новые canonical revisions.
 */

import type {
  ParsedDialogue,
  ParsedSourceSnapshot,
} from "../../domain/canonical-types.ts";

export interface ParseContext {
  /**
   * Подсказка workspace (cwd/workDir), если sync-слой знает её из внешнего
   * индекса (например, session_index.jsonl kimi-code). Parser предпочитает
   * собственные метаданные snapshot'а; hint — fallback.
   */
  workspaceHint?: string;
}

export interface HarnessParser {
  readonly parserName: string;
  readonly parserVersion: number;
  /** Версии формата источника, которые parser понимает. */
  readonly sourceFormatVersions: readonly string[];
  parse(snapshotPath: string, context?: ParseContext): Promise<ParsedSourceSnapshot>;
}

/** Собрать AsyncIterable диалогов в массив (sync-слой и тесты). */
export async function collectDialogues(
  snapshot: ParsedSourceSnapshot,
): Promise<ParsedDialogue[]> {
  const out: ParsedDialogue[] = [];
  for await (const dialogue of snapshot.dialogues) out.push(dialogue);
  return out;
}
