/**
 * Транзакции SurrealDB (docs/plan.md §10.4).
 *
 * Проверено на живом SurrealDB 3.2.3 + SDK 2.0.8 (WS):
 * - транзакция НЕ сохраняется между отдельными query-вызовами
 *   (`BEGIN;` в одном вызове, `COMMIT;` в другом → «Cannot COMMIT without
 *   starting a transaction»);
 * - поэтому вся транзакция — ОДИН query-вызов вида
 *   `BEGIN; ...; COMMIT; RETURN ...`;
 * - ошибка любого statement внутри откатывает всю транзакцию
 *   (проверено integration-тестом rollback);
 * - `CANCEL;` тоже откатывает, но сам вызов при этом завершается
 *   QueryError — отдельный вызов CANCEL не нужен: ошибка = rollback.
 *
 * Детерминированные record id (sha256 от доменного ключа) дают
 * идемпотентность повторных sync (план §19.2 сценарий 1): повторный
 * CREATE того же id невозможен, а существование проверяется до транзакции.
 */

import { createHash } from "node:crypto";

export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Детерминированный string-id записи: буквенный prefix + sha256 ключа. */
export function deterministicId(prefix: string, key: string): string {
  return `${prefix}_${sha256hex(key)}`;
}
