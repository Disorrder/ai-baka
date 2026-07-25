-- 0002_search_documents.surql
-- Этап 2, docs/plan.md §8.1 (search_document) и §12.2–12.3
-- (analyzer archive_mixed + fulltext-индексы BM25 HIGHLIGHTS).

-- ============================================================
-- search_document — производная единица поиска (план §8.1)
-- Полностью производна: при смене dialogue.current_revision старые
-- search_document удаляются и создаются заново.
-- ============================================================
DEFINE TABLE IF NOT EXISTS search_document SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS dialogue ON TABLE search_document TYPE record<dialogue>;
DEFINE FIELD IF NOT EXISTS dialogue_revision ON TABLE search_document TYPE record<dialogue_revision>;
DEFINE FIELD IF NOT EXISTS message ON TABLE search_document TYPE option<record<message>>;
-- document_type: user_prompt | assistant_final
DEFINE FIELD IF NOT EXISTS document_type ON TABLE search_document TYPE string;
DEFINE FIELD IF NOT EXISTS segment_no ON TABLE search_document TYPE int;
DEFINE FIELD IF NOT EXISTS content ON TABLE search_document TYPE string;
DEFINE FIELD IF NOT EXISTS content_sha256 ON TABLE search_document TYPE string;
DEFINE FIELD IF NOT EXISTS token_count ON TABLE search_document TYPE option<int>;
DEFINE FIELD IF NOT EXISTS source_chunks ON TABLE search_document TYPE array<record<chunk>>;
DEFINE FIELD IF NOT EXISTS extraction_method ON TABLE search_document TYPE string;
DEFINE FIELD IF NOT EXISTS extraction_version ON TABLE search_document TYPE string;
DEFINE FIELD IF NOT EXISTS segmentation_version ON TABLE search_document TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE search_document TYPE datetime;

-- ============================================================
-- Analyzer archive_mixed (план §12.2)
-- Нейтрален для русского/английского/кода/camelCase/путей; stemming
-- не применяем без relevance-тестов.
-- ============================================================
DEFINE ANALYZER IF NOT EXISTS archive_mixed
TOKENIZERS class, camel
FILTERS lowercase;

-- ============================================================
-- Fulltext-индексы (план §12.3). Синтаксис SurrealDB 3.x:
-- FULLTEXT ANALYZER (не SEARCH ANALYZER).
-- ============================================================
DEFINE INDEX IF NOT EXISTS search_document_content
ON TABLE search_document
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25 HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS chunk_content
ON TABLE chunk
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25 HIGHLIGHTS;
