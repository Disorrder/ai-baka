/**
 * Общие helper'ы integration-тестов с живым SurrealDB (образец —
 * tests/migrations.integration.test.ts): namespace baka_test, уникальная
 * database на прогон, REMOVE DATABASE в teardown, скип без живой БД.
 */

import { Surreal } from "surrealdb";
import { applyMigrations } from "../src/db/migrations.ts";

export const SURREAL_URL = process.env.SURREAL_URL ?? "ws://127.0.0.1:8901/rpc";
export const SURREAL_USER = process.env.SURREAL_USER ?? "root";
export const SURREAL_PASS = process.env.SURREAL_PASS ?? "root";
export const TEST_NAMESPACE = "baka_test";

let dbAvailable: boolean | undefined;

export async function isDbAvailable(): Promise<boolean> {
  if (dbAvailable !== undefined) return dbAvailable;
  const probe = new Surreal();
  try {
    await Promise.race([
      probe.connect(SURREAL_URL),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connect timeout")), 2000),
      ),
    ]);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  } finally {
    await probe.close().catch(() => {});
  }
  if (!dbAvailable) console.warn("SKIP: SurrealDB недоступен (docker не поднят)");
  return dbAvailable;
}

export interface TestDb {
  db: Surreal;
  name: string;
}

/** Новая уникальная database с применёнными миграциями 0001–0004. */
export async function createTestDb(withSchema = true): Promise<TestDb> {
  const db = new Surreal();
  await db.connect(SURREAL_URL);
  await db.signin({ username: SURREAL_USER, password: SURREAL_PASS });
  await db.use({ namespace: TEST_NAMESPACE });
  const name = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.query(`DEFINE DATABASE ${name}`);
  await db.use({ namespace: TEST_NAMESPACE, database: name });
  if (withSchema) {
    await applyMigrations(db, { bakaCommit: "test", surrealdbVersion: "test" });
  }
  return { db, name };
}

export async function dropTestDb(t: TestDb): Promise<void> {
  try {
    await t.db.use({ namespace: TEST_NAMESPACE });
    await t.db.query(`REMOVE DATABASE ${t.name}`);
  } finally {
    await t.db.close();
  }
}
