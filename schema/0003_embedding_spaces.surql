-- 0003_embedding_spaces.surql
-- Этап 2, docs/plan.md §13.1 (embedding_space metadata) и §13.5 (embedding_job).
-- Физические vector-таблицы (search_embedding_*) здесь НЕ создаются —
-- они создаются динамически на этапе 7 под каждое embedding space.

-- ============================================================
-- embedding_space — metadata векторного пространства (план §13.1)
-- Каждое space получает отдельную физическую таблицу (physical_table)
-- с фиксированной dimension и собственным ANN-индексом.
-- ============================================================
DEFINE TABLE IF NOT EXISTS embedding_space SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS slug ON TABLE embedding_space TYPE string;
DEFINE FIELD IF NOT EXISTS provider ON TABLE embedding_space TYPE string;
DEFINE FIELD IF NOT EXISTS model ON TABLE embedding_space TYPE string;
DEFINE FIELD IF NOT EXISTS dimensions ON TABLE embedding_space TYPE int;
DEFINE FIELD IF NOT EXISTS distance ON TABLE embedding_space TYPE string;
DEFINE FIELD IF NOT EXISTS vector_type ON TABLE embedding_space TYPE string;
DEFINE FIELD IF NOT EXISTS segmentation_version ON TABLE embedding_space TYPE string;
DEFINE FIELD IF NOT EXISTS active ON TABLE embedding_space TYPE bool;
DEFINE FIELD IF NOT EXISTS physical_table ON TABLE embedding_space TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE embedding_space TYPE datetime;
DEFINE INDEX IF NOT EXISTS embedding_space_slug_unique ON TABLE embedding_space FIELDS slug UNIQUE;

-- ============================================================
-- embedding_job — очередь векторизации (план §13.5)
-- Embeddings не входят в критический путь sync (план §3.4).
-- ============================================================
DEFINE TABLE IF NOT EXISTS embedding_job SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS search_document ON TABLE embedding_job TYPE record<search_document>;
DEFINE FIELD IF NOT EXISTS embedding_space ON TABLE embedding_job TYPE record<embedding_space>;
DEFINE FIELD IF NOT EXISTS input_sha256 ON TABLE embedding_job TYPE string;
-- status: pending | processing | retryable_error | permanent_error | completed | cancelled
DEFINE FIELD IF NOT EXISTS status ON TABLE embedding_job TYPE string;
DEFINE FIELD IF NOT EXISTS attempts ON TABLE embedding_job TYPE int;
DEFINE FIELD IF NOT EXISTS next_attempt_at ON TABLE embedding_job TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS locked_by ON TABLE embedding_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS locked_at ON TABLE embedding_job TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_error ON TABLE embedding_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE embedding_job TYPE datetime;
DEFINE FIELD IF NOT EXISTS completed_at ON TABLE embedding_job TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS embedding_job_document_space ON TABLE embedding_job FIELDS search_document, embedding_space UNIQUE;
