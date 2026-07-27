-- 0005_legacy_migration_run.surql
-- Этап 10, docs/plan.md §15.8–15.10: полный quarantine legacy-строк
-- и корректное представление source revision без сохранившегося raw.

-- §15.8 прямо требует NONE, когда raw backup отсутствует. В 0001 поле
-- ошибочно было обязательной строкой; OVERWRITE меняет только контракт
-- поля, существующие string-значения остаются валидными.
DEFINE FIELD OVERWRITE raw_archive_path ON TABLE source_revision TYPE option<string>;

-- created_by_run is immutable provenance, not permission to delete a shared
-- record. A migration transaction sets it only on records created by that
-- transaction; existing live/shared rows are never relabelled.
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE vendor TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE model TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE workspace TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE workspace_location TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE source_root TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE source_location TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE source_revision TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE dialogue TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE dialogue_revision TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE message TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE chunk TYPE option<record<migration_meta>>;
DEFINE FIELD IF NOT EXISTS created_by_run ON TABLE search_document TYPE option<record<migration_meta>>;

-- Append-only per-run classification ledger. Reconciliation and host
-- attribution read only this table: retrying a later run can never overwrite
-- the historical category/assignment of an earlier run.
DEFINE TABLE IF NOT EXISTS migration_row_commit SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS migration ON TABLE migration_row_commit TYPE record<migration_meta>;
DEFINE FIELD IF NOT EXISTS legacy_table ON TABLE migration_row_commit TYPE string;
DEFINE FIELD IF NOT EXISTS legacy_id ON TABLE migration_row_commit TYPE string;
DEFINE FIELD IF NOT EXISTS category ON TABLE migration_row_commit TYPE string
  ASSERT $value IN ["matched", "inserted", "quarantined"];
-- Quarantine rows point at migration_quarantine, successful rows at canonical
-- records. Keeping target mandatory makes every classification auditable.
DEFINE FIELD IF NOT EXISTS target ON TABLE migration_row_commit TYPE record;
DEFINE FIELD IF NOT EXISTS host_mapping_id ON TABLE migration_row_commit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS host_assignment_json ON TABLE migration_row_commit TYPE option<string>;
-- Exact before/after values for pointer/presence changes are captured by the
-- same transaction that mutates them. They are audit/recovery evidence only.
DEFINE FIELD IF NOT EXISTS previous_state ON TABLE migration_row_commit TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS written_state ON TABLE migration_row_commit TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS committed_at ON TABLE migration_row_commit TYPE datetime;
DEFINE INDEX IF NOT EXISTS migration_row_commit_run_row ON TABLE migration_row_commit
  FIELDS migration, legacy_table, legacy_id UNIQUE;
DEFINE INDEX IF NOT EXISTS migration_row_commit_run_category ON TABLE migration_row_commit
  FIELDS migration, legacy_table, category;

-- Одна запись на quarantined legacy row в конкретном migration run.
-- Детерминированный record id задаёт importer; повтор внутри одного run
-- обновляет диагностику, но не создаёт дубль.
DEFINE TABLE IF NOT EXISTS migration_quarantine SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS migration ON TABLE migration_quarantine TYPE record<migration_meta>;
DEFINE FIELD IF NOT EXISTS legacy_table ON TABLE migration_quarantine TYPE string;
DEFINE FIELD IF NOT EXISTS legacy_id ON TABLE migration_quarantine TYPE string;
DEFINE FIELD IF NOT EXISTS raw_payload ON TABLE migration_quarantine TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS reason ON TABLE migration_quarantine TYPE string;
-- Parser identity обязательна даже для ошибок до harness parser: importer
-- использует явный legacy-migration-adapter@1.
DEFINE FIELD OVERWRITE parser_name ON TABLE migration_quarantine TYPE string;
DEFINE FIELD OVERWRITE parser_version ON TABLE migration_quarantine TYPE string;
DEFINE FIELD IF NOT EXISTS retryable ON TABLE migration_quarantine TYPE bool;
DEFINE FIELD IF NOT EXISTS attempts ON TABLE migration_quarantine TYPE int;
-- lineage_key стабилен между migration run; previous_attempt связывает
-- исторические попытки, не удаляя audit trail после успешного retry.
DEFINE FIELD IF NOT EXISTS lineage_key ON TABLE migration_quarantine TYPE string;
DEFINE FIELD IF NOT EXISTS previous_attempt ON TABLE migration_quarantine TYPE option<record<migration_quarantine>>;
DEFINE FIELD IF NOT EXISTS first_failed_at ON TABLE migration_quarantine TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_failed_at ON TABLE migration_quarantine TYPE datetime;
DEFINE FIELD IF NOT EXISTS resolved_at ON TABLE migration_quarantine TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS resolution ON TABLE migration_quarantine TYPE option<string>;
DEFINE INDEX IF NOT EXISTS migration_quarantine_run_row ON TABLE migration_quarantine
  FIELDS migration, legacy_table, legacy_id UNIQUE;
DEFINE INDEX IF NOT EXISTS migration_quarantine_lineage ON TABLE migration_quarantine
  FIELDS lineage_key, last_failed_at;

-- Approval/lifecycle evidence для Stage 10. Строковые JSON assignments
-- канонизированы и их SHA хранится отдельно: это делает audit artifact
-- переносимым между версиями SurrealDB без FLEXIBLE array semantics.
DEFINE FIELD IF NOT EXISTS approval_artifact_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS approval_file_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS approval_attestation_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS approval_key_fingerprint ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS host_mapping_artifact_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS host_mapping_assignments_json ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS backup_artifact_path ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS backup_artifact_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS backup_manifest_path ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS backup_manifest_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS raw_manifest_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS restore_artifact_path ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS restore_artifact_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS restore_namespace ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS report_path ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS report_sha256 ON TABLE migration_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS report_size_bytes ON TABLE migration_meta TYPE option<int>;

-- Restore namespace — UUID-scoped attempt id, поэтому его повторное
-- использование означает replay старого safety evidence.
DEFINE INDEX IF NOT EXISTS migration_restore_namespace_unique ON TABLE migration_meta
  FIELDS restore_namespace UNIQUE;

-- Глобальный FULLTEXT по canonical chunk.content индексировал каждую
-- физическую ревизию (reasoning/tools/system/history) и превращал restore в
-- многочасовую перестройку производного forensic-индекса. Canonical chunks и
-- вся история остаются в таблице chunk; удаляется только необязательный index.
-- Обычный BM25/vector/hybrid продолжает работать по current-revision
-- search_document (user_prompt + assistant_final).
REMOVE INDEX IF EXISTS chunk_content ON TABLE chunk;
