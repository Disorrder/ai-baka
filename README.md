# ai-baka

Локальный Bun/TypeScript CLI для архивации диалогов с AI-агентами в SurrealDB.

Переписывание legacy-проекта [`baka`](/path/to/legacy-project) (SQLite-first архив)
с нуля: SurrealDB становится канонической моделью и индексом поверх неизменяемого
raw-архива, а не местом, куда напрямую перекладываются прежние таблицы SQLite.

**Статус:** этап 8 плана (live acceptance) завершён: backup tooling
(§16.1/§16.2/§16.4) — logical backup через HTTP /export с manifest'ом,
restore drill в отдельный namespace `baka_restore_test` без второго
контейнера, `baka raw:verify` — и полный acceptance-прогон по всем 7
harness'ам на боевой базе (sync ×2 идемпотентен, backup → restore:test →
raw:verify пройдены; детали validate хранятся в приватном отчёте).
Ранее — этап 7: embedding pipeline: embedding spaces
с физическими vector-таблицами и HNSW (динамический DDL, §13.1–13.3),
jobs worker с lease/retry/backoff и приватность-фильтрами (§13.5–13.7),
OpenAI provider (batch, dimensions, retry на 429/5xx) + mock provider для
тестов, vector search и hybrid RRF (§14) с деградацией в lexical.
Ранее — этап 6: segmenter длинных документов (§13.4,
segmentation_version = "1"), BM25-поиск по search_document с highlights,
forensic search по chunk (reasoning/tools/all-revisions),
`baka search` / `baka search:rebuild`. Ранее — этап 5: репозитории поверх
SDK, атомарная транзакция диалога (§10.4), immutable dialogue revisions с
current pointers, quarantine через ingest_error, `baka sync` /
`baka status` / `baka validate`. Живой sync по kimi-code пройден на боевой
базе; повторный sync идемпотентен. Схема БД — миграции в
[`schema/`](schema/) (применяются `bun run db:migrate`, runner —
`src/db/migrations.ts`). Авторитетным источником требований остаётся
[`docs/plan.md`](docs/plan.md).

## CLI

- `baka sync [--harness <slug>] [--source-root <path>] [--full-rescan]
  [--deletion-confirmations <n>] [--no-enqueue-embeddings] [--dry-run] [--json]` —
  structured sync: discovery → scan → immutable raw snapshot → parse →
  транзакции диалогов → search_documents → embedding jobs (только при
  active embedding space; сам OpenAI не вызывается). Лог событий — JSON
  lines в stderr;
- `baka search <query> [--mode text|vector|hybrid] [--harness] [--host]
  [--workspace] [--model] [--document-type] [--from] [--to] [--deleted-only]
  [--limit] [--include-reasoning] [--include-tools] [--all-revisions]
  [--json]` — BM25 по search_document (только current revisions) с
  highlights; forensic-флаги переключают поиск на chunk.content (§12.1);
  vector — ANN по active embedding space (HNSW), hybrid — BM25 top 50 +
  vector top 50 → RRF k=60 → dedup по message → top 20 (§14). Без active
  space или OPENAI_API_KEY vector сообщает о недоступности, hybrid
  деградирует в text с предупреждением;
- `baka embeddings plan [--json]` — read-only оценка backfill: документы,
  сегменты, токены (эвристика segmenter'а), over-target, pending jobs,
  vector storage, цена из `OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS` (§13.6);
- `baka embeddings run [--limit <n>] [--space <slug>]` — worker: lease
  pending jobs → provider → проверка dimension → транзакция vector + usage
  + job completed; retryable ошибки с exponential backoff, permanent —
  сразу; stuck jobs возвращаются в pending по lease timeout (§13.6);
- `baka embeddings status|retry|cancel [--space]`, `baka embeddings
  space:create [--slug --provider --model --dimensions --activate]`,
  `space:activate <slug>`, `space:list`, `baka embeddings rebuild --space
  <slug>` (stale jobs → pending после смены extraction/segmentation
  versions, их vectors удаляются, §13.5);
- `baka search:rebuild [--no-enqueue-embeddings] [--json]` — пересоздать
  search projection для всех current revisions (после смены
  segmenter/extractor versions, §8.1);
- `baka status [--json]` — сводка архива (§17.2);
- `baka validate [--json]` — проверка инвариантов (§17.3): orphan raw,
  missing/hash mismatch raw, dialogue без current / current не ready,
  duplicate identity keys, sequence collisions, search_document не из
  current revision, unknown schema version;
- `baka discover [--json]` — обнаруженные harness installations и source roots
  (переопределение путей — `BAKA_SOURCES__<SLUG>`, см. `.env.example`);
- `baka backup [--json]` — logical backup (§16.1): HTTP /export боевой базы
  в `backups/surreal/<timestamp>__schema-<v>__surreal-<ver>.surql.zst`
  (gzip fallback, если нет zstd) + manifest JSON в `backups/manifests/`
  (версии, bakaCommit, recordCounts, exportSha256);
- `baka restore:test [export] [--json]` — restore drill (§16.4) без второго
  контейнера: импорт в отдельный namespace `baka_restore_test`, сверка
  record counts с manifest'ом, referential-инварианты, search-probes,
  затем REMOVE NAMESPACE; боевой namespace не изменяется;
- `baka raw:verify [--manifest] [--json]` — raw manifest по БД (все
  source_revision: путь, SHA-256, size, harness) и сверка с файловой
  системой (§16.2); orphan-файлы — предупреждение;
- `baka archive:init`, `baka db up/down/status/migrate/preflight/logs`,
  `baka disk eject` — инфраструктура (см. `package.json` scripts).

## Что архивируется

Семь harness'ов:

- Codex
- Claude Code
- Claude Desktop
- OpenCode
- Cursor
- Qwen Code
- Kimi Code (Kimi CLI)

Ключевые свойства:

- инкрементальная неразрушающая синхронизация: удаление исходника никогда
  не удаляет архив;
- каждая обнаруженная версия исходного файла — неизменяемый raw snapshot
  с полным SHA-256 в имени;
- трёхслойная модель: source provenance → canonical corpus → search projection;
- полнотекстовый (BM25) и векторный (HNSW) поиск, гибрид через RRF;
- embeddings — вне критического пути sync; сбой OpenAI не ломает sync;
- полный provenance: машины, OS-аккаунты, harness'ы, проекты, модели,
  reasoning effort, диалоги, ревизии, сообщения, чанки.

## Хранилище

| Что | Где |
| --- | --- |
| Архив (RocksDB + raw + backups) | `/Volumes/Archive/Conversations` (задаётся `BAKA_ARCHIVE_ROOT`) |
| Legacy-архив SQLite (read-only, не трогаем) | `/Volumes/Archive/Legacy Conversations/` |
| SurrealDB | отдельный Docker-контейнер, `127.0.0.1:8901`, image `surrealdb/surrealdb:v3.2.3` (tag + digest) |

## Известные ограничения (live acceptance, этап 8)

- `~/.codex/sqlite` (`state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`,
  `memories_1.sqlite`, `codex-dev.db`, `codex-history-snapshots-dev.db`) —
  осознанный unsupported: файлы архивируются как raw, но parser читает
  только rollout-jsonl. Это метаданные-индексы, а не контент диалогов:
  `state_5.threads.rollout_path` ссылается на rollout JSONL в корнях
  `~/.codex/sessions` и `~/.codex/archived_sessions`, `logs_2` — telemetry-логи, goals/memories —
  вспомогательные таблицы app-server'а.
- OpenCode `storage/session_diff/*.json` и Cursor `<hash>/workspace.json` —
  unsupported (diff'ы и метаданные workspace, не диалоги); raw
  архивируется, parser пропускает с диагностикой `unsupported_file`.
- Claude Desktop IndexedDB blob, удалённый браузером из источника, —
  presence `missing` до подтверждений удаления; архив сохраняет его копию.
- Orphan raw-файлы (raw без source_revision) могут остаться после
  пересоздания БД; `raw:verify` помечает их
  предупреждением, не failure.
- Restore drill большого export может быть долгим: тело /import отправляется потоком (`Bun.file`), а не буфером
  в памяти.

## Документация

- [`docs/plan.md`](docs/plan.md) — целевая редакция плана: архитектура,
  сущностная модель, алгоритмы sync, миграция legacy, этапы 0–12,
  Definition of Done.
- [`docs/architecture.md`](docs/architecture.md) — краткий обзор архитектуры
  и ключевых инвариантов.
- [`docs/sources.md`](docs/sources.md) — источники данных семи harness'ов:
  пути, форматы, стратегии snapshot.

## Границы проекта

Не входит: изменение External System и `other-project`, web-интерфейс, облачный хостинг,
автосинхронизация диска между ноутбуками, генерация ответов поверх архива,
эмбеддинг reasoning/tool-данных, автоматическое удаление legacy-файлов.
