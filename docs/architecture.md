# Архитектура (краткий обзор)

Здесь — технический обзор; полная спецификация — в [`plan.md`](plan.md).
Бизнес-решения, архитектурные подходы и причины их изменения — в [реестре ADR](adr/index.md).

Код и CLI этапов 9–12 реализованы (**CODE COMPLETE**), но это не утверждение
о завершённом cutover. Боевой legacy import, платный полный embeddings
backfill с принятой relevance evaluation, подтверждённая физическая
off-device копия, restore точного bundle, финальный `validate`, tag и решение
об удалении migration adapter — открытые **EXTERNAL OPERATOR GATES**. Legacy
SQLite остаётся read-only; автоматического удаления нет.

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
- normal BM25/vector/hybrid индексирует только каждый human-authored user
  message и финальные видимые assistant answers текущей revision;
- canonical chunks и historical revisions сохраняются без глобального
  `chunk_content` FULLTEXT; legacy forensic flags fail closed без DB scan;
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

## Физическая структура хранилища

Корень — `BAKA_ARCHIVE_ROOT`
(по умолчанию `/Volumes/Archive/Conversations`):

```text
Conversations/
├── .baka-archive.json        # sentinel: archiveId, formatVersion, expected NS/DB
├── db/                       # legacy/corrupt physical store; не runtime fallback
├── raw/<harness>/            # плоские immutable snapshots: <basename>__<sha256>.<ext>
├── staging/<sync-run-id>/    # тот же диск → atomic rename
├── migration-input/          # content-addressed SQLite snapshots + checkpoints
├── backups/surreal/          # logical exports .surql.zst/.surql.gz
├── backups/manifests/        # logical/raw manifests, private migration/restore evidence
├── backups/reports/          # optional operator reports; status умеет их читать
├── exports/
├── logs/
└── tmp/
```

Mutable production RocksDB живёт в `BAKA_DB_ROOT`, который compose монтирует
в `/data/db`. Если переменная не задана, effective path равен
`${HOME}/Library/Application Support/ai-baka/rocksdb`: persistent internal
default не зависит от secret `.env` и не откатывается молча на archive volume.
Override допускается только на другом абсолютном внутреннем APFS/POSIX пути.
ExFAT не поддерживается для live DB, recovery target/staging, reorder/temp и
recovery journal; под `BAKA_ARCHIVE_ROOT` остаются immutable raw, manifests и
logical/off-device backups. Большие временные файлы удаляются в `finally`.
Старый `archive/db` не копируется и не переименовывается: recovery — one-way
logical backup rebuild в fresh internal target, а corrupt store остаётся
нетронутым до acceptance. `recovery:rebuild` требует exact
`--export-sha256`, `--manifest-sha256`, effective internal
`BAKA_DB_ROOT` и `--confirm-rebuild`; он создаёт и проверяет fresh DB tree,
удаляет staging/temp, но не делает container-name cutover, promotion,
physical rollback или reverse migration. После success координатор
отдельно recreates Compose с тем же `BAKA_DB_ROOT`; точный порядок
описан в [`rocksdb-recovery.md`](rocksdb-recovery.md).

Content-addressed `migration-input/index__<sha256>.sqlite` — read-only input
legacy import, а не recovery artifact. Он сохраняется только до принятой
migration; recovery не оставляет отдельный retained large cache.

Off-device bundle публикуется отдельно как
`<destination>/<backupId>/{archive/,off-device-manifest.json,off-device-report.json}`.
Полная начальная схема 1 релиза 0.1.0 задаётся единственным файлом
`schema/0001_initial.surql`; последующие миграции — только для новых релизов.

## Изолированный restore acceptance

`baka restore:test` не использует production SurrealDB как restore target.
Maintenance wrapper exact-проверяет `baka-surrealdb` (pinned image,
loopback `8901`, health и mounts ровно: effective internal `BAKA_DB_ROOT` bind в
`/data/db` + anonymous local volumes `/data`, `/logs`), отсутствие
lock/clients, берёт собственный lock и снимает hash-baseline schema +
`dialogue.current_revision`. Затем:

```text
stop exact production ID
  → start pinned disposable (fresh named volume, loopback port ≠ 8901)
  → import + verify + build search_document_content
  → remove indexes → namespace
  → finalize disposable container → volume → prove absence
  → restart exact production ID → health → compare baseline
  → publish strict RestoreTestReport v5
```

Disposable target имеет hard profile 12 GiB/4 CPU, RocksDB cache 1 GiB,
threads/jobs 4/4, subcompactions 2, threshold 6 GiB и index resume 0.
`SURREAL_INDEXING_BATCH_SIZE` отсутствует в launch env: pinned CommonConfig
его не парсит. Durable report отдельно связывает exact image с compile-time
adaptive indexing (probe 16 records, soft target 8 388 608 raw bytes, clamp и
replay максимум 250 records). Эти значения, exact image digest, opaque data
identity, readiness `search_document_content`, отсутствие `chunk_content` для
schema 1 и cleanup входят в durable report.
OOM/ошибка не разрешает success: сохраняется только privacy-safe
stage/code/counters/cleanup evidence,
а production container всё равно перезапускается и проверяется. Same-server
fallback и mount production RocksDB запрещены.

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

Файловая система не входит в транзакцию SurrealDB. `baka doctor` работает как
inspect/dry-run по умолчанию и импортирует orphan raw только при однозначной
проверяемой provenance; ambiguous/SQLite случаи остаются manual. Удаление
staging, projection rebuild и manifest overwrite требуют явных
`--apply --allow-destructive`.

## Embeddings вне критического пути

`baka sync` только ставит `embedding_job` в очередь. Generic
`baka embeddings run` сохранён как fail-closed compatibility stub и никогда
не вызывает provider: paid API доступен только через bounded candidate или
accepted-production wrappers с exact plan/corpus/privacy hashes,
confirmation-фразой и `--allow-paid-api`. Сбой API, отсутствие ключа или rate
limit не делают structured sync неуспешным.

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
6. Embedding vector соответствует exact `search_document.content_sha256`,
   completed job и owning embedding space; одна physical table принадлежит
   ровно одному space, pending/error jobs не находятся в vector table.
7. Candidate/production paid calls связаны с immutable plan и normalized
   privacy; Stage 11 завершается только принятой full-corpus evaluation с
   независимо закреплённой identity judgment artifact.
8. Cached и reasoning tokens не double-counted.
9. Ни одна migration row не теряется без quarantine; повторный sync
   и миграция идемпотентны.
10. Migration writer недостижим до проверки exact signed approval, host-map,
    независимого trust key, свежих live evidence и backup/restore binding.
11. Архив восстанавливается из logical export + raw backup только через
    isolated pinned target; strict v5 report связан с exact
    export/manifest/raw hashes, durable resource profile, ready
    `search_document_content`, отсутствующим `chunk_content` для schema 1,
    полным target cleanup и неизменным production baseline.
12. Off-device checksums доказывают целостность, но не физическую provenance:
    `st_dev` показывает другой filesystem, а доверие к устройству/manifest
    подтверждает оператор вне самого bundle.
13. Structured sync не зависит от OpenAI.

Полный список — раздел 23 плана.
