/**
 * Общие helper'ы репозиториев: typed query-обёртки и sanitize значений.
 * Тонкий слой поверх SurrealDB SDK, без ORM-надстроек (KISS).
 */

import type { Surreal } from "surrealdb";

/** Первая строка первого statement'а или undefined. */
export async function selectOne<T>(
  db: Surreal,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T | undefined> {
  const [rows] = await db.query<[T[] | T]>(sql, vars);
  // SELECT → массив; CREATE ONLY/UPSERT ONLY → одиночный объект.
  if (Array.isArray(rows)) return rows[0];
  return rows ?? undefined;
}

/** Все строки первого statement'а. */
export async function selectAll<T>(
  db: Surreal,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T[]> {
  const [rows] = await db.query<[T[]]>(sql, vars);
  return rows ?? [];
}

/**
 * JSON-санитизация произвольных payload'ов (metadata, usage events):
 * убирает undefined, функции и прочее, что SurrealDB не хранит.
 * Date превращается в ISO-строку — допустимо для metadata-полей.
 */
export function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
