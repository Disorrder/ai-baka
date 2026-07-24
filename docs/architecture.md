# Архитектура (краткий обзор)

Полная редакция — в [`plan.md`](plan.md). Здесь только опорные схемы.

## Трёхслойная модель

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Source provenance                                       │
│ source_location → source_revision → immutable raw snapshot │
└──────────────────────────────┬─────────────────────────────┘
                               │ parser
┌──────────────────────────────▼─────────────────────────────┐
│ 2. Canonical corpus                                        │
│ dialogue → dialogue_revision → message → chunk             │
└──────────────────────────────┬─────────────────────────────┘
                               │ extractor / segmenter
┌──────────────────────────────▼─────────────────────────────┐
│ 3. Search projection                                       │
│ search_document → embedding_job → vector table             │
└────────────────────────────────────────────────────────────┘
```

- raw snapshot никогда не изменяется;
- старая ревизия диалога не уничтожается; текущая выбирается указателем
  `dialogue.current_revision`;
- search projection полностью производна — её можно удалить и пересоздать;
- embeddings перестраиваются без изменения архива.

## Итоговая формула

```text
Stable host identity
        ↓
Complete source scans
        ↓
Immutable source revisions
        ↓
Versioned canonical dialogues
        ↓
Replaceable search documents
        ↓
Retryable, versioned embedding spaces
        ↓
BM25 + HNSW + RRF
```

## Физическая структура архива

Корень — `BAKA_ARCHIVE_ROOT`
(по умолчанию `/Volumes/Archive/Conversations`):

```text
Conversations/
├── .baka-archive.json        # sentinel: archiveId, formatVersion, expected NS/DB
├── db/                       # RocksDB (bind mount контейнера SurrealDB)
├── raw/<harness>/            # плоские immutable snapshots: <basename>__<sha256>.<ext>
├── staging/<sync-run-id>/    # тот же диск → atomic rename
├── backups/surreal/          # logical exports .surql.zst + manifests
├── exports/
├── logs/
└── tmp/
```

## Crash-safe порядок записи

```text
1. Raw snapshot в staging
2. fsync
3. Atomic rename в immutable raw
4. Parse и validation
5. SurrealDB transaction (одна на dialogue revision)
6. Search-document creation
7. Embedding-job enqueue
```

Файловая система не входит в транзакцию SurrealDB; orphan raw после сбоя
дочищается `baka doctor`.

## Embeddings вне критического пути

`baka sync` только ставит `embedding_job` в очередь. OpenAI вызывается
отдельной командой `baka embeddings run`. Сбой API, отсутствие ключа
или rate limit не делают structured sync неуспешным.

Векторизуются только пользовательские промпты и финальные видимые ответы
ассистента. Reasoning, tool calls/results, системные сообщения в embeddings
не отправляются. Каждое embedding space — отдельная физическая таблица
с собственным HNSW-индексом.

## Ключевые инварианты

1. Raw snapshot после создания никогда не изменяется.
2. `source_revision.sha256` соответствует raw-файлу.
3. Ошибка новой ревизии не разрушает предыдущую (`current_revision` —
   только на `ready`).
4. Удаление исходника не удаляет raw или canonical data; `missing` /
   `deleted_in_source` выставляются только после complete-scan.
5. Search projection содержит только текущие ревизии.
6. Embedding vector всегда соответствует content hash и embedding space;
   pending/error jobs не находятся в vector table.
7. Cached и reasoning tokens не double-counted.
8. Ни одна migration row не теряется без quarantine; повторный sync
   и миграция идемпотентны.
9. Архив восстанавливается из logical export + raw backup.
10. Structured sync не зависит от OpenAI.

Полный список — раздел 23 плана.
