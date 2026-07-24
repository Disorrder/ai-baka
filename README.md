# ai-baka

Локальный Bun/TypeScript CLI для архивации диалогов с AI-агентами в SurrealDB.

Переписывание legacy-проекта [`baka`](/path/to/legacy-project) (SQLite-first архив)
с нуля: SurrealDB становится канонической моделью и индексом поверх неизменяемого
raw-архива, а не местом, куда напрямую перекладываются прежние таблицы SQLite.

**Статус:** этап документации. Код ещё не написан — авторитетным источником
является [`docs/plan.md`](docs/plan.md).

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
| Архив (RocksDB + raw + backups) | `/Volumes/Archive/Conversations/surreal-archive` (задаётся `BAKA_ARCHIVE_ROOT`) |
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
