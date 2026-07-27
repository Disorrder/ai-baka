import { describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import {
  assertForensicSearchDisabled,
  buildFilterClauses,
  ForensicSearchDisabledError,
  searchForensic,
  searchText,
  type SearchFilters,
  type SearchHit,
} from "../src/search/fulltext.ts";
import {
  compareSearchHitsByScore,
  hasSearchFilters,
  rrfFuse,
  searchVectorInSpace,
} from "../src/search/hybrid.ts";

function filters(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { limit: 20, ...overrides };
}

describe("search §14 filter contract", () => {
  test("legacy forensic flags fail closed without any DB query", async () => {
    let queries = 0;
    const db = {
      query: async () => {
        queries += 1;
        return [[]];
      },
    } as unknown as Surreal;

    expect(() =>
      assertForensicSearchDisabled(filters({ includeReasoning: true })),
    ).toThrow(ForensicSearchDisabledError);
    expect(
      searchForensic(db, "private query", filters({ allRevisions: true })),
    ).rejects.toThrow("глобальный индекс chunk.content удалён");
    expect(queries).toBe(0);
  });

  test("normal BM25 остаётся доступен без forensic flags", async () => {
    const db = { query: async () => [[]] } as unknown as Surreal;
    expect(() => assertForensicSearchDisabled(filters())).not.toThrow();
    expect(await searchText(db, "normal query", filters())).toEqual([]);
  });

  test("user/vendor/reasoning-effort/role use canonical relation paths and bound vars", () => {
    const built = buildFilterClauses(
      filters({
        user: "example",
        vendor: "moonshot",
        reasoningEffort: "high",
        role: "assistant",
      }),
    );
    expect(built.clause).toContain("dialogue.os_account.os_username = $f_user");
    expect(built.clause).toContain(
      "(message.model.vendor.slug ?? dialogue.primary_model.vendor.slug) = $f_vendor",
    );
    expect(built.clause).toContain("message.reasoning_effort = $f_reasoning_effort");
    expect(built.clause).toContain("message.role = $f_role");
    expect(built.vars).toEqual({
      f_user: "example",
      f_vendor: "moonshot",
      f_reasoning_effort: "high",
      f_role: "assistant",
    });
  });

  test("каждый новый post-ANN filter включает over-fetch", () => {
    expect(hasSearchFilters(filters())).toBe(false);
    expect(hasSearchFilters(filters({ includeReasoning: true }))).toBe(false);
    for (const filtered of [
      filters({ user: "example" }),
      filters({ vendor: "moonshot" }),
      filters({ reasoningEffort: "high" }),
      filters({ role: "assistant" }),
    ]) {
      expect(hasSearchFilters(filtered)).toBe(true);
    }
  });

  test("SearchHit exposes CLI-ready hydrated fields", () => {
    const hit: SearchHit = {
      id: "search_document:x",
      score: 1,
      snippet: "text",
      dialogueId: "dialogue:x",
      revisionId: "dialogue_revision:x",
      role: "assistant",
      reasoningEffort: "high",
      user: "example",
      vendor: "moonshot",
      sourcePath: "/private/source.jsonl",
    };
    expect(hit).toMatchObject({
      role: "assistant",
      reasoningEffort: "high",
      user: "example",
      vendor: "moonshot",
      sourcePath: "/private/source.jsonl",
    });
  });

  test("BM25 adds id tie-break in the database ordering", async () => {
    let sql = "";
    const db = {
      query: async (query: string) => {
        sql = query;
        return [[]];
      },
    } as unknown as Surreal;
    await searchText(db, "same score", filters());
    expect(sql).toContain("ORDER BY score DESC, id ASC");
  });

  test("equal vector and RRF scores are ordered by stable document id", async () => {
    expect([
      { ...({} as SearchHit), id: "doc:b", score: 1 },
      { ...({} as SearchHit), id: "doc:a", score: 1 },
    ].sort(compareSearchHitsByScore).map((row) => row.id)).toEqual(["doc:a", "doc:b"]);

    const make = (id: string): SearchHit => ({
      id,
      score: 1,
      snippet: id,
      dialogueId: `dialogue:${id}`,
      revisionId: `revision:${id}`,
    });
    expect(rrfFuse([[make("doc:b")], [make("doc:a")]]).map((row) => row.id)).toEqual([
      "doc:a",
      "doc:b",
    ]);

    const a = new RecordId("search_document", "a");
    const b = new RecordId("search_document", "b");
    let call = 0;
    const db = {
      query: async () => {
        call += 1;
        if (call === 1) {
          return [[
            { search_document: b, dist: 0.25 },
            { search_document: a, dist: 0.25 },
          ]];
        }
        return [[
          {
            id: b,
            content: "b",
            dialogue_id: new RecordId("dialogue", "b"),
            revision_id: new RecordId("dialogue_revision", "b"),
          },
          {
            id: a,
            content: "a",
            dialogue_id: new RecordId("dialogue", "a"),
            revision_id: new RecordId("dialogue_revision", "a"),
          },
        ]];
      },
    } as unknown as Surreal;
    const provider = {
      provider: "mock",
      model: "mock-model",
      dimensions: 2,
      embed: async () => ({
        vectors: [[0, 1]],
        usage: { promptTokens: 1, totalTokens: 1 },
      }),
    };
    const space = {
      id: new RecordId("embedding_space", "ties"),
      slug: "ties",
      provider: "mock",
      model: "mock-model",
      dimensions: 2,
      distance: "COSINE",
      vector_type: "F32",
      segmentation_version: "2",
      active: false,
      physical_table: "search_embedding_ties",
      created_at: new Date(0),
    };
    const tied = await searchVectorInSpace(db, provider, space, "query", filters({ limit: 2 }));
    expect(tied.map((row) => row.id)).toEqual(["search_document:a", "search_document:b"]);
  });
});
