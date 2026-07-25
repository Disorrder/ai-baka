/**
 * Magic header SQLite ("SQLite format 3\0") — надёжнее проверки расширения.
 * Parser'ы используют для ранней классификации не-sqlite файлов (JSON-дампы,
 * metadata) в unsupported_file вместо SQLiteError "file is not a database".
 *
 * Возвращает undefined, если файл не удалось открыть (нет прав/не существует)
 * — это отдельный случай, parser обрабатывает его как раньше.
 */

import { open } from "node:fs/promises";

export async function isSqliteFile(path: string): Promise<boolean | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return bytesRead === 16 && buffer.subarray(0, 15).toString("latin1") === "SQLite format 3";
  } finally {
    await handle.close();
  }
}
