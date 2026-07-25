/**
 * Быстрый fingerprint «head hash» живого файла (docs/plan.md §10.3):
 * sha256(size + первые HEAD_HASH_BYTES). Формат совместим с head_hash
 * snapshot'ов (src/sources/snapshot/hashing.ts).
 *
 * Вычисляется ТОЛЬКО когда size/mtime совпали с прежней revision —
 * изменение файла с сохранёнными size/mtime не должно теряться; на
 * обычном пути (size/mtime различаются) файл и так считается changed,
 * лишних чтений нет.
 */

import { open } from "node:fs/promises";
import { HEAD_HASH_BYTES, headHashOf } from "../sources/snapshot/hashing.ts";

/**
 * head_hash первых HEAD_HASH_BYTES файла; null — файл не прочитался
 * (sync трактует такой файл как изменённый: полный snapshot зафиксирует
 * настоящую ошибку).
 */
export async function headFileHash(filePath: string): Promise<string | null> {
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, HEAD_HASH_BYTES));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return headHashOf(buffer.subarray(0, offset), size);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
