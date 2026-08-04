-- 0006_content_character_counts.surql
-- Cached character counts for analytics. These are derived from canonical
-- chunk.content and do not affect dialogue_revision.canonical_hash.

DEFINE FIELD IF NOT EXISTS content_chars ON TABLE chunk TYPE int;
DEFINE FIELD IF NOT EXISTS content_chars ON TABLE message TYPE int;

-- Historical rows are backfilled by an explicit batched maintenance command/run.
-- A full-table UPDATE here can keep too much state in memory on the live corpus.
