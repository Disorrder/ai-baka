/**
 * Disposable live SurrealDB proof for the exact deferred restore flow.
 * The database lives under the per-file test namespace and is always removed;
 * no configured production namespace or database is read or mutated.
 */

import { afterAll, describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { Surreal } from "surrealdb";
import {
  buildDeferredFulltextIndexes,
  removeStartedFulltextIndexes,
  RESTORE_FULLTEXT_INDEX_DEFINITIONS,
  type RestoreIndexBuildDiagnostic,
} from "../src/backup/restore-indexes.ts";
import { sqlRoot } from "../src/backup/http.ts";
import type { AppConfig } from "../src/config.ts";
import {
  dbTest,
  finishLiveTestFile,
  SURREAL_PASS,
  SURREAL_URL,
  SURREAL_USER,
} from "./db-test-utils.ts";

const testDb = await dbTest();

afterAll(async () => {
  await finishLiveTestFile();
});

const DEFERRED_INDEXES = [
  `DEFINE INDEX IF NOT EXISTS search_document_content
ON TABLE search_document
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25 HIGHLIGHTS;`,
] as const;

describe("deferred restore indexes on disposable SurrealDB", () => {
  testDb("CONCURRENTLY reaches ready and stable cleanup proves absence", async () => {
    const namespace = `baka_restore_test_${randomUUID().replaceAll("-", "")}`;
    const database = `test_${randomUUID().replaceAll("-", "")}`;
    const db = new Surreal();
    const cfg = {
      surrealUrl: SURREAL_URL,
      surrealUser: SURREAL_USER,
      surrealPass: SURREAL_PASS,
    } as AppConfig;
    try {
      await db.connect(SURREAL_URL);
      await db.signin({ username: SURREAL_USER, password: SURREAL_PASS });
      await db.query(`DEFINE NAMESPACE ${namespace}`);
      await db.use({ namespace });
      await db.query(`DEFINE DATABASE ${database}`);
      await db.use({ namespace, database });
      await db.query(`
        DEFINE TABLE search_document SCHEMAFULL;
        DEFINE FIELD content ON TABLE search_document TYPE string;
        DEFINE TABLE chunk SCHEMAFULL;
        DEFINE FIELD content ON TABLE chunk TYPE string;
        DEFINE ANALYZER archive_mixed TOKENIZERS class, camel FILTERS lowercase;
        CREATE |search_document:5000| SET content = "restore concurrent document " + <string>id;
        CREATE |chunk:5000| SET content = "restore concurrent chunk " + <string>id;
      `);

      const events: RestoreIndexBuildDiagnostic[] = [];
      const result = await buildDeferredFulltextIndexes(
        cfg,
        namespace,
        database,
        DEFERRED_INDEXES,
        {
          timeoutMs: 60_000,
          requestTimeoutMs: 5_000,
          pollIntervalMs: 10,
          onProgress: (event) => events.push(event),
        },
      );

      expect(result.map((item) => [item.ordinal, item.state, item.status])).toEqual([
        [1, "ready", "ready"],
      ]);
      const scheduled = events.filter((event) => event.state === "scheduled");
      expect(scheduled.map((event) => event.ordinal)).toEqual([1]);
      expect(scheduled.every((event) => event.indexElapsedMs < 5_000)).toBe(true);
      const firstReady = events.findIndex((event) => event.ordinal === 1 && event.state === "ready");
      expect(firstReady).toBeGreaterThanOrEqual(0);

      const [info] = await db.query<[unknown]>(
        "INFO FOR INDEX search_document_content ON TABLE search_document",
      );
      expect(info).toMatchObject({ building: { status: "ready" } });

      await removeStartedFulltextIndexes(
        cfg,
        namespace,
        database,
        RESTORE_FULLTEXT_INDEX_DEFINITIONS,
        {
          timeoutMs: 5_000,
          stabilizationMs: 20,
          pollIntervalMs: 10,
          requestTimeoutMs: 1_000,
        },
      );
      for (const table of ["search_document", "chunk"] as const) {
        const [info] = await db.query<[Record<string, unknown>]>(`INFO FOR TABLE ${table}`);
        expect(info.indexes).toEqual({});
      }
    } finally {
      await db.close().catch(() => {});
      await sqlRoot(cfg, `REMOVE NAMESPACE IF EXISTS ${namespace};`);
    }
  }, 60_000);
});
