-- 0004_legacy_migration_metadata.surql
-- Этап 2, docs/plan.md §15.5–15.7: metadata для миграции legacy SQLite-архива.
-- Минимально необходимое (KISS): identity mapping legacy → новая модель
-- (используется при дедупликации, план §15.7 п.3) и reconciliation metadata.

-- ============================================================
-- legacy_identity_map — mapping legacy SQLite entity → новая запись.
-- Один из надёжных ключей автоматического merge при дедупликации
-- (план §15.7). Соответствие таблиц — план §15.5.
-- ============================================================
DEFINE TABLE IF NOT EXISTS legacy_identity_map SCHEMAFULL;
-- legacy_table: agent_systems | projects | source_files | raw_backups | threads | messages | message_chunks
DEFINE FIELD IF NOT EXISTS legacy_table ON TABLE legacy_identity_map TYPE string;
-- PK записи в legacy SQLite (строкой: legacy id могут быть нечисловыми)
DEFINE FIELD IF NOT EXISTS legacy_id ON TABLE legacy_identity_map TYPE string;
-- record новой модели; bare record, т.к. целевая таблица зависит от legacy_table
DEFINE FIELD IF NOT EXISTS target ON TABLE legacy_identity_map TYPE record;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE legacy_identity_map TYPE datetime;
DEFINE INDEX IF NOT EXISTS legacy_identity_map_unique ON TABLE legacy_identity_map FIELDS legacy_table, legacy_id UNIQUE;

-- ============================================================
-- migration_meta — reconciliation metadata миграции истории.
-- Один record на запуск миграции; счётчики гибкие (сверка «ни одной
-- тихо потерянной строки», план §15.2/§15.10).
-- ============================================================
DEFINE TABLE IF NOT EXISTS migration_meta SCHEMAFULL;
-- status: preflight | running | completed | completed_with_errors | failed
DEFINE FIELD IF NOT EXISTS status ON TABLE migration_meta TYPE string;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE migration_meta TYPE datetime;
DEFINE FIELD IF NOT EXISTS finished_at ON TABLE migration_meta TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS legacy_db_path ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS legacy_db_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS sync_run ON TABLE migration_meta TYPE option<record<sync_run>>;
-- counters: счётчики legacy → новая модель для reconciliation-отчёта
DEFINE FIELD IF NOT EXISTS counters ON TABLE migration_meta TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS notes ON TABLE migration_meta TYPE option<string>;
