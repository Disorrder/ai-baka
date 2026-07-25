-- 0001_initial.surql
-- Этап 2, docs/plan.md §7: identity-таблицы, source provenance,
-- канонический корпус. Все таблицы SCHEMAFULL; metadata/raw object-поля —
-- FLEXIBLE. Связи — record links, option<> там, где поле может отсутствовать.

-- ============================================================
-- archive_meta — singleton archive_meta:main (план §7.1)
-- ============================================================
DEFINE TABLE IF NOT EXISTS archive_meta SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS archive_uuid ON TABLE archive_meta TYPE string;
DEFINE FIELD IF NOT EXISTS format_version ON TABLE archive_meta TYPE int;
DEFINE FIELD IF NOT EXISTS schema_version ON TABLE archive_meta TYPE int;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE archive_meta TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_opened_at ON TABLE archive_meta TYPE datetime;
DEFINE FIELD IF NOT EXISTS created_by_baka_commit ON TABLE archive_meta TYPE string;

-- ============================================================
-- host — одна физическая или логическая машина
-- ============================================================
DEFINE TABLE IF NOT EXISTS host SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS host_uuid ON TABLE host TYPE string;
DEFINE FIELD IF NOT EXISTS hostname ON TABLE host TYPE string;
DEFINE FIELD IF NOT EXISTS label ON TABLE host TYPE option<string>;
DEFINE FIELD IF NOT EXISTS platform ON TABLE host TYPE string;
DEFINE FIELD IF NOT EXISTS arch ON TABLE host TYPE string;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE host TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE host TYPE datetime;
-- host_uuid — стабильная identity машины (hostname identity не является)
DEFINE INDEX IF NOT EXISTS host_uuid_unique ON TABLE host FIELDS host_uuid UNIQUE;

-- ============================================================
-- os_account — пользовательская сущность на конкретном host
-- ============================================================
DEFINE TABLE IF NOT EXISTS os_account SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS host ON TABLE os_account TYPE record<host>;
DEFINE FIELD IF NOT EXISTS os_username ON TABLE os_account TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE os_account TYPE option<string>;
DEFINE FIELD IF NOT EXISTS home_path ON TABLE os_account TYPE string;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE os_account TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE os_account TYPE datetime;
DEFINE INDEX IF NOT EXISTS os_account_host_username ON TABLE os_account FIELDS host, os_username UNIQUE;

-- ============================================================
-- vendor — производитель модели (openai, anthropic, ...)
-- ============================================================
DEFINE TABLE IF NOT EXISTS vendor SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS slug ON TABLE vendor TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE vendor TYPE string;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE vendor TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE vendor TYPE datetime;
DEFINE INDEX IF NOT EXISTS vendor_slug_unique ON TABLE vendor FIELDS slug UNIQUE;

-- ============================================================
-- harness — тип приложения (codex, claude-code, ...)
-- ============================================================
DEFINE TABLE IF NOT EXISTS harness SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS slug ON TABLE harness TYPE string;
DEFINE FIELD IF NOT EXISTS display_name ON TABLE harness TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON TABLE harness TYPE string;
DEFINE INDEX IF NOT EXISTS harness_slug_unique ON TABLE harness FIELDS slug UNIQUE;

-- ============================================================
-- harness_installation — конкретный harness на конкретной машине
-- ============================================================
DEFINE TABLE IF NOT EXISTS harness_installation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS host ON TABLE harness_installation TYPE record<host>;
DEFINE FIELD IF NOT EXISTS harness ON TABLE harness_installation TYPE record<harness>;
DEFINE FIELD IF NOT EXISTS installed ON TABLE harness_installation TYPE bool;
DEFINE FIELD IF NOT EXISTS detected_version ON TABLE harness_installation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE harness_installation TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_detected_at ON TABLE harness_installation TYPE datetime;
DEFINE INDEX IF NOT EXISTS harness_installation_host_harness ON TABLE harness_installation FIELDS host, harness UNIQUE;

-- ============================================================
-- model — базовая модель без reasoning effort
-- ============================================================
DEFINE TABLE IF NOT EXISTS model SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS vendor ON TABLE model TYPE record<vendor>;
DEFINE FIELD IF NOT EXISTS canonical_name ON TABLE model TYPE string;
DEFINE FIELD IF NOT EXISTS aliases ON TABLE model TYPE array<string>;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE model TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE model TYPE datetime;
DEFINE INDEX IF NOT EXISTS model_vendor_canonical_name ON TABLE model FIELDS vendor, canonical_name UNIQUE;

-- ============================================================
-- workspace — логический проект
-- ============================================================
DEFINE TABLE IF NOT EXISTS workspace SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON TABLE workspace TYPE string;
DEFINE FIELD IF NOT EXISTS repository_identity ON TABLE workspace TYPE option<string>;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE workspace TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE workspace TYPE datetime;

-- ============================================================
-- workspace_location — физическое расположение проекта
-- ============================================================
DEFINE TABLE IF NOT EXISTS workspace_location SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE workspace_location TYPE record<workspace>;
DEFINE FIELD IF NOT EXISTS host ON TABLE workspace_location TYPE record<host>;
DEFINE FIELD IF NOT EXISTS path ON TABLE workspace_location TYPE string;
DEFINE FIELD IF NOT EXISTS normalized_path ON TABLE workspace_location TYPE string;
DEFINE FIELD IF NOT EXISTS git_remote ON TABLE workspace_location TYPE option<string>;
-- bindings: external project IDs разных harness'ов (гибкая структура)
DEFINE FIELD IF NOT EXISTS bindings ON TABLE workspace_location TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE workspace_location TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE workspace_location TYPE datetime;

-- ============================================================
-- source_root — корень, сканируемый конкретным harness'ом (план §7.2)
-- ============================================================
DEFINE TABLE IF NOT EXISTS source_root SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS harness_installation ON TABLE source_root TYPE record<harness_installation>;
DEFINE FIELD IF NOT EXISTS path ON TABLE source_root TYPE string;
DEFINE FIELD IF NOT EXISTS source_kind ON TABLE source_root TYPE string;
DEFINE FIELD IF NOT EXISTS parser_name ON TABLE source_root TYPE string;
DEFINE FIELD IF NOT EXISTS snapshot_strategy ON TABLE source_root TYPE string;
DEFINE FIELD IF NOT EXISTS enabled ON TABLE source_root TYPE bool;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE source_root TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE source_root TYPE datetime;

-- ============================================================
-- sync_run — один запуск операции
-- ============================================================
DEFINE TABLE IF NOT EXISTS sync_run SCHEMAFULL;
-- kind: live_sync | migration | search_rebuild | embedding_backfill | validation
DEFINE FIELD IF NOT EXISTS kind ON TABLE sync_run TYPE string;
-- status: running | completed | completed_with_errors | failed | cancelled
DEFINE FIELD IF NOT EXISTS status ON TABLE sync_run TYPE string;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE sync_run TYPE datetime;
DEFINE FIELD IF NOT EXISTS finished_at ON TABLE sync_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS host ON TABLE sync_run TYPE record<host>;
DEFINE FIELD IF NOT EXISTS baka_commit ON TABLE sync_run TYPE string;
DEFINE FIELD IF NOT EXISTS schema_version ON TABLE sync_run TYPE int;
DEFINE FIELD IF NOT EXISTS configuration_fingerprint ON TABLE sync_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS counters ON TABLE sync_run TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS error_summary ON TABLE sync_run TYPE option<string>;

-- ============================================================
-- source_scan — результат обхода одного source_root в рамках sync_run
-- ============================================================
DEFINE TABLE IF NOT EXISTS source_scan SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sync_run ON TABLE source_scan TYPE record<sync_run>;
DEFINE FIELD IF NOT EXISTS source_root ON TABLE source_scan TYPE record<source_root>;
-- status: complete | partial | unavailable | permission_denied | failed
DEFINE FIELD IF NOT EXISTS status ON TABLE source_scan TYPE string;
DEFINE FIELD IF NOT EXISTS files_seen ON TABLE source_scan TYPE int;
DEFINE FIELD IF NOT EXISTS files_new ON TABLE source_scan TYPE int;
DEFINE FIELD IF NOT EXISTS files_changed ON TABLE source_scan TYPE int;
DEFINE FIELD IF NOT EXISTS files_missing ON TABLE source_scan TYPE int;
DEFINE FIELD IF NOT EXISTS errors ON TABLE source_scan TYPE int;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE source_scan TYPE datetime;
DEFINE FIELD IF NOT EXISTS finished_at ON TABLE source_scan TYPE option<datetime>;

-- ============================================================
-- source_location — конкретный путь внутри source root
-- ============================================================
DEFINE TABLE IF NOT EXISTS source_location SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS source_root ON TABLE source_location TYPE record<source_root>;
DEFINE FIELD IF NOT EXISTS relative_path ON TABLE source_location TYPE string;
DEFINE FIELD IF NOT EXISTS original_path ON TABLE source_location TYPE string;
DEFINE FIELD IF NOT EXISTS basename ON TABLE source_location TYPE string;
-- presence_status: active | missing | deleted_in_source
DEFINE FIELD IF NOT EXISTS presence_status ON TABLE source_location TYPE string;
DEFINE FIELD IF NOT EXISTS missing_complete_scans ON TABLE source_location TYPE int;
DEFINE FIELD IF NOT EXISTS current_revision ON TABLE source_location TYPE option<record<source_revision>>;
DEFINE FIELD IF NOT EXISTS last_successful_revision ON TABLE source_location TYPE option<record<source_revision>>;
DEFINE FIELD IF NOT EXISTS renamed_from ON TABLE source_location TYPE option<record<source_location>>;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE source_location TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE source_location TYPE datetime;
DEFINE FIELD IF NOT EXISTS missing_since_at ON TABLE source_location TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS deleted_at ON TABLE source_location TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS source_location_root_path ON TABLE source_location FIELDS source_root, relative_path UNIQUE;

-- ============================================================
-- source_revision — неизменяемая версия содержимого
-- ============================================================
DEFINE TABLE IF NOT EXISTS source_revision SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS source_location ON TABLE source_revision TYPE record<source_location>;
-- полный SHA-256, identity определяется только им
DEFINE FIELD IF NOT EXISTS sha256 ON TABLE source_revision TYPE string;
DEFINE FIELD IF NOT EXISTS size_bytes ON TABLE source_revision TYPE int;
DEFINE FIELD IF NOT EXISTS mtime_ms ON TABLE source_revision TYPE int;
-- быстрый fingerprint, НЕ identity
DEFINE FIELD IF NOT EXISTS head_hash ON TABLE source_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS raw_archive_path ON TABLE source_revision TYPE string;
-- snapshot_kind: regular_copy | sqlite_backup | vacuum_into | legacy_raw
DEFINE FIELD IF NOT EXISTS snapshot_kind ON TABLE source_revision TYPE string;
DEFINE FIELD IF NOT EXISTS captured_at ON TABLE source_revision TYPE datetime;
DEFINE FIELD IF NOT EXISTS parser_name ON TABLE source_revision TYPE string;
DEFINE FIELD IF NOT EXISTS parser_version ON TABLE source_revision TYPE string;
-- parse_status: pending | parsed | partial | parse_error | unsupported
DEFINE FIELD IF NOT EXISTS parse_status ON TABLE source_revision TYPE string;
DEFINE FIELD IF NOT EXISTS dialogues_discovered ON TABLE source_revision TYPE option<int>;
DEFINE FIELD IF NOT EXISTS canonical_hash ON TABLE source_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS sync_run ON TABLE source_revision TYPE record<sync_run>;
DEFINE INDEX IF NOT EXISTS source_revision_location_sha ON TABLE source_revision FIELDS source_location, sha256 UNIQUE;

-- ============================================================
-- ingest_error — карантин для всего, что не удалось обработать
-- ============================================================
DEFINE TABLE IF NOT EXISTS ingest_error SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sync_run ON TABLE ingest_error TYPE record<sync_run>;
DEFINE FIELD IF NOT EXISTS source_revision ON TABLE ingest_error TYPE option<record<source_revision>>;
DEFINE FIELD IF NOT EXISTS source_record_key ON TABLE ingest_error TYPE option<string>;
-- stage: snapshot | parse | normalize | write | migration
DEFINE FIELD IF NOT EXISTS stage ON TABLE ingest_error TYPE string;
DEFINE FIELD IF NOT EXISTS error_code ON TABLE ingest_error TYPE string;
DEFINE FIELD IF NOT EXISTS error_message ON TABLE ingest_error TYPE string;
DEFINE FIELD IF NOT EXISTS raw_payload ON TABLE ingest_error TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS raw_payload_path ON TABLE ingest_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS parser_version ON TABLE ingest_error TYPE option<string>;
DEFINE FIELD IF NOT EXISTS first_failed_at ON TABLE ingest_error TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_failed_at ON TABLE ingest_error TYPE datetime;
DEFINE FIELD IF NOT EXISTS resolved_at ON TABLE ingest_error TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS resolution ON TABLE ingest_error TYPE option<string>;

-- ============================================================
-- dialogue — стабильная identity диалога (план §7.3)
-- ============================================================
DEFINE TABLE IF NOT EXISTS dialogue SCHEMAFULL;
-- identity_key: <harness-installation-uuid>:<external-id> (или fallback fingerprint)
DEFINE FIELD IF NOT EXISTS identity_key ON TABLE dialogue TYPE string;
DEFINE FIELD IF NOT EXISTS harness_installation ON TABLE dialogue TYPE record<harness_installation>;
DEFINE FIELD IF NOT EXISTS os_account ON TABLE dialogue TYPE option<record<os_account>>;
DEFINE FIELD IF NOT EXISTS workspace ON TABLE dialogue TYPE option<record<workspace>>;
DEFINE FIELD IF NOT EXISTS external_id ON TABLE dialogue TYPE option<string>;
DEFINE FIELD IF NOT EXISTS title ON TABLE dialogue TYPE option<string>;
DEFINE FIELD IF NOT EXISTS current_revision ON TABLE dialogue TYPE option<record<dialogue_revision>>;
-- primary_model — только производный cache
DEFINE FIELD IF NOT EXISTS primary_model ON TABLE dialogue TYPE option<record<model>>;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE dialogue TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE dialogue TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS first_seen_at ON TABLE dialogue TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON TABLE dialogue TYPE datetime;
DEFINE INDEX IF NOT EXISTS dialogue_identity_key_unique ON TABLE dialogue FIELDS identity_key UNIQUE;

-- ============================================================
-- dialogue_revision — неизменяемая нормализованная версия диалога
-- ============================================================
DEFINE TABLE IF NOT EXISTS dialogue_revision SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS dialogue ON TABLE dialogue_revision TYPE record<dialogue>;
DEFINE FIELD IF NOT EXISTS source_revision ON TABLE dialogue_revision TYPE option<record<source_revision>>;
DEFINE FIELD IF NOT EXISTS source_dialogue_id ON TABLE dialogue_revision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS parser_name ON TABLE dialogue_revision TYPE string;
DEFINE FIELD IF NOT EXISTS parser_version ON TABLE dialogue_revision TYPE string;
DEFINE FIELD IF NOT EXISTS canonical_hash ON TABLE dialogue_revision TYPE string;
-- status: ready | quarantined
DEFINE FIELD IF NOT EXISTS status ON TABLE dialogue_revision TYPE string;
DEFINE FIELD IF NOT EXISTS message_count ON TABLE dialogue_revision TYPE int;
DEFINE FIELD IF NOT EXISTS chunk_count ON TABLE dialogue_revision TYPE int;
DEFINE FIELD IF NOT EXISTS started_at ON TABLE dialogue_revision TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at ON TABLE dialogue_revision TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON TABLE dialogue_revision TYPE datetime;

-- ============================================================
-- message — сообщение внутри ревизии диалога
-- ============================================================
DEFINE TABLE IF NOT EXISTS message SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS dialogue ON TABLE message TYPE record<dialogue>;
DEFINE FIELD IF NOT EXISTS dialogue_revision ON TABLE message TYPE record<dialogue_revision>;
DEFINE FIELD IF NOT EXISTS external_id ON TABLE message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS sequence ON TABLE message TYPE int;
-- role — нормализованная роль, raw_role — исходная
DEFINE FIELD IF NOT EXISTS role ON TABLE message TYPE string;
DEFINE FIELD IF NOT EXISTS raw_role ON TABLE message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS human_authored ON TABLE message TYPE bool;
DEFINE FIELD IF NOT EXISTS visible_to_user ON TABLE message TYPE bool;
DEFINE FIELD IF NOT EXISTS timestamp ON TABLE message TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS model ON TABLE message TYPE option<record<model>>;
DEFINE FIELD IF NOT EXISTS raw_model_name ON TABLE message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reasoning_effort ON TABLE message TYPE option<string>;
DEFINE FIELD IF NOT EXISTS service_provider ON TABLE message TYPE option<string>;
-- usage: нормализованный usage object (структура — план §7.3, гибкая)
DEFINE FIELD IF NOT EXISTS usage ON TABLE message TYPE option<object> FLEXIBLE;
-- raw_usage_events: исходные usage payloads, не теряются
DEFINE FIELD IF NOT EXISTS raw_usage_events ON TABLE message TYPE option<array<object>> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS metadata ON TABLE message TYPE option<object> FLEXIBLE;

-- ============================================================
-- chunk — типизированная часть сообщения; вектор в chunk не хранится
-- ============================================================
DEFINE TABLE IF NOT EXISTS chunk SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS dialogue ON TABLE chunk TYPE record<dialogue>;
DEFINE FIELD IF NOT EXISTS dialogue_revision ON TABLE chunk TYPE record<dialogue_revision>;
DEFINE FIELD IF NOT EXISTS message ON TABLE chunk TYPE record<message>;
DEFINE FIELD IF NOT EXISTS sequence ON TABLE chunk TYPE int;
-- kind: text | thought | tool_call | tool_result | system | developer | usage | object | attachment | unknown
DEFINE FIELD IF NOT EXISTS kind ON TABLE chunk TYPE string;
DEFINE FIELD IF NOT EXISTS raw_kind ON TABLE chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS role ON TABLE chunk TYPE string;
DEFINE FIELD IF NOT EXISTS content ON TABLE chunk TYPE string;
DEFINE FIELD IF NOT EXISTS content_sha256 ON TABLE chunk TYPE string;
DEFINE FIELD IF NOT EXISTS content_bytes ON TABLE chunk TYPE int;
DEFINE FIELD IF NOT EXISTS token_count_reported ON TABLE chunk TYPE option<int>;
DEFINE FIELD IF NOT EXISTS source_locator ON TABLE chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tool_call_id ON TABLE chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tool_name ON TABLE chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS raw_event_type ON TABLE chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS metadata ON TABLE chunk TYPE option<object> FLEXIBLE;
