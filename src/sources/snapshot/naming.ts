/**
 * Плоские имена raw-файлов (docs/plan.md §4.2):
 *
 *   <sanitized-original-basename>__<full-sha256>.<ext>
 *
 * Правила:
 * - SHA-256 добавляется всегда, полный (64 hex);
 * - расширение (последняя точка) сохраняется;
 * - недопустимые символы basename заменяются на `_`;
 * - итоговое имя обрезается по UTF-8 байтам до MAX_RAW_NAME_BYTES —
 *   безопасный лимит ниже файловых 255 (APFS и пр.).
 * - файл с тем же basename, но другим hash — новая raw-ревизия;
 *   raw-файл никогда не перезаписывается.
 */

export const MAX_RAW_NAME_BYTES = 200;

const HASH_SUFFIX_BYTES = 2 + 64; // "__" + sha256 hex

function sanitizeStem(stem: string): string {
  let s = stem.replace(/[^A-Za-z0-9._-]/g, "_");
  s = s.replace(/^\.+/, ""); // не скрытые файлы
  if (s.length === 0) s = "file";
  return s;
}

/** Обрезка строки до maxBytes UTF-8 байт без разрыва code points. */
export function truncateUtf8Bytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  let end = maxBytes;
  // Не режем посередине многобайтовой последовательности.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function rawFileName(originalBasename: string, sha256: string): string {
  const dot = originalBasename.lastIndexOf(".");
  const hasExt = dot > 0 && dot < originalBasename.length - 1;
  const ext = hasExt ? originalBasename.slice(dot) : "";
  const stem = sanitizeStem(hasExt ? originalBasename.slice(0, dot) : originalBasename);
  const extBytes = Buffer.byteLength(ext, "utf8");
  const stemBudget = Math.max(1, MAX_RAW_NAME_BYTES - HASH_SUFFIX_BYTES - extBytes);
  const trimmed = truncateUtf8Bytes(stem, stemBudget);
  return `${trimmed}__${sha256}${ext}`;
}
