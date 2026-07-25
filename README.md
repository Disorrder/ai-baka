# ai-baka

Локальный Bun/TypeScript CLI для архивации диалогов с AI-агентами в SurrealDB.

Переписывание legacy-проекта [`baka`](/path/to/legacy-project) (SQLite-first архив)
с нуля: SurrealDB становится канонической моделью и индексом поверх неизменяемого
raw-архива, а не местом, куда напрямую перекладываются прежние таблицы SQLite.

**Статус:** этап 6 плана (search documents и full-text) завершён:
segmenter длинных документов (§13.4, segmentation_version = "1"),
BM25-поиск по search_document с highlights, forensic search по chunk
(reasoning/tools/all-revisions), `baka search` / `baka search:rebuild`.
Ранее — этап 5: репозитории поверх SDK, атомарная транзакция диалога
(§10.4), immutable dialogue revisions с current pointers, quarantine через
ingest_error, `baka sync` / `baka status` / `baka validate`. Живой sync по
kimi-code пройден на боевой базе; повторный sync идемпотентен. Схема БД —
миграции в [`schema/`](schema/) (применяются `bun run db:migrate`, runner —
`src/db/migrations.ts`). Авторитетным источником требований остаётся
[`docs/plan.md`](docs/plan.md).

## CLI

- `baka sync [--harness <slug>] [--source-root <path>] [--full-rescan]
  [--deletion-confirmations <n>] [--no-enqueue-embeddings] [--dry-run] [--json]` —
  structured sync: discovery → scan → immutable raw snapshot → parse →
  транзакции диалогов → search_documents → embedding jobs (только при
  active embedding space; сам OpenAI не вызывается). Лог событий — JSON
  lines в stderr;
- `baka search <query> [--mode text] [--harness] [--host] [--workspace]
  [--model] [--document-type] [--from] [--to] [--deleted-only] [--limit]
  [--include-reasoning] [--include-tools] [--all-revisions] [--json]` —
  BM25 по search_document (только current revisions) с highlights;
  forensic-флаги переключают поиск на chunk.content (§12.1); режимы
  vector/hybrid — этап 7;
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
