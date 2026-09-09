# ai-baka

Локальный Bun/TypeScript CLI для архивации диалогов с AI-агентами в SurrealDB.

Переписывание legacy-проекта [`baka`](/path/to/legacy-project) (SQLite-first архив)
с нуля: SurrealDB становится канонической моделью и индексом поверх неизменяемого
raw-архива, а не местом, куда напрямую перекладываются прежние таблицы SQLite.

**Статус реализации:** код и CLI этапов 0–12 реализованы. Этапы 0–8 прошли
зафиксированный live acceptance; parser/extractor имеют версию 2,
`segmentation_version = "2"`. Для этапов 9–12 важно различать готовность кода
и завершение эксплуатации:

| Статус | Что входит |
| --- | --- |
| **CODE COMPLETE** | migration preflight/import/retry/status и schema 5; ограниченный Stage 11 candidate/relevance/backfill/full-corpus workflow; logical/off-device backup и строгий restore drill; validate/doctor/status/observability |
| **EXTERNAL OPERATOR GATES — открыты** | свежий подписанный migration approval и live import; приватная relevance acceptance и платный полный backfill; копия на подтверждённом отдельном физическом устройстве с внешне доверенной provenance; restore точного bundle; финальные validate/cutover/tag и решение об удалении adapter |

Ни миграция legacy, ни платный Stage 11, ни off-device provenance, ни
окончательный cutover этим статусом не объявляются выполненными. Legacy SQLite
остаётся read-only и не удаляется программой; физическое удаление возможно
только вручную после периода эксплуатации. Схема БД — миграции в
[`schema/`](schema/) (0001–0005, `bun run db:migrate`, runner —
`src/db/migrations.ts`). Авторитетный источник требований и операторских gates —
[`docs/plan.md`](docs/plan.md).

## CLI

- `baka sync [--harness <slug>] [--full-rescan]
  [--deletion-confirmations <n>] [--no-enqueue-embeddings] [--dry-run] [--json]` —
  structured sync: discovery → scan → immutable raw snapshot → parse →
  транзакции диалогов → search_documents → embedding jobs (только при
  active embedding space; сам OpenAI не вызывается). `bun sync` запускает
  ту же команду. В интерактивном терминале stderr показывает живой индикатор:
  1/5 — preflight, блокировка и БД; 2/5 — discovery; 3/5 — дедупликация;
  4/5 — обработка источников; 5/5 — финализация. Для каждого источника видны
  текущая операция и счётчики файлов (для kimi parse — сессий). Пока дерево
  обходится, показано только «найдено N»: точный total известен после обхода,
  дополнительного прохода ради подсчёта нет. Полоса относится к текущей
  операции, а не к оценке оставшегося времени всего sync.
  `--json`, перенаправленный stderr и `TERM=dumb` сохраняют JSONL-лог событий
  в stderr с периодическими `sync_progress`; итоговый stdout не смешивается
  с прогрессом. `NO_COLOR` отключает цвет; ошибки остаются видимыми;
- `baka search <query> [--mode <text|vector|hybrid>] [--harness <slug>]
  [--host <label|hostname>] [--user <os-username>] [--workspace <name>]
  [--vendor <slug>] [--model <name>] [--reasoning-effort <value>]
  [--role <user|assistant|system|developer|tool|unknown>]
  [--document-type <type>] [--from <date>] [--to <date>] [--deleted-only]
  [--include-reasoning] [--include-tools] [--include-system] [--all-revisions]
  [--limit <n>] [--json]` — BM25 по `search_document`: каждый human-authored
  user message и финальные видимые assistant answers текущей revision.
  Legacy forensic-флаги в schema 5 fail closed до DB query; canonical chunks
  и historical revisions при этом сохранены (§12.1);
  vector — ANN по active embedding space (HNSW), hybrid — BM25 top 50 +
  vector top 50 → RRF k=60 → dedup по message → top 20 (§14). Без active
  space или OPENAI_API_KEY vector сообщает о недоступности, hybrid
  деградирует в text с предупреждением;
- `baka embeddings plan [--json]` — read-only оценка backfill: документы,
  сегменты, токены (эвристика segmenter'а), over-target, pending jobs,
  vector storage, цена из `OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS` (§13.6);
- `baka embeddings run --limit <1..64> --space <slug> --allow-paid-api` —
  fail-closed compatibility stub: generic worker намеренно всегда отказывает,
  потому что не имеет Stage 11 authorization. Платный provider вызывается
  только через подтверждённые `embeddings candidates run` и
  `embeddings backfill run`;
- `baka embeddings exact-tokens --model <name> --report <private.json>
  [--batch-size <n>] [--overwrite] [--json]` — точный token count через
  pinned offline `uv` script; цена берётся только из
  `OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS`;
- `baka embeddings candidates plan --judgments <private.json>
  --spaces <slug1,slug2,slug3> --max-documents <1..1000>
  --max-jobs-per-space <1..200> --selection-seed-sha256 <sha256>
  --report <private.json> [--overwrite] [--json]` и
  `baka embeddings candidates run --plan <path> --judgments <same-path>
  --confirm <exact-phrase> [--batch-size <1..64>] --allow-paid-api [--json]` —
  ограниченная candidate-выборка; `max-jobs-per-space` также не превышает
  `max-documents`;
- `baka relevance evaluate --judgments <path> --report <path>
  --candidate-plan <path> --confirm <exact-phrase>
  --spaces <slug1,slug2,slug3> --resource-measurements <path>
  --documented-exclusions <path> [--modes text,vector,hybrid]
  --allow-paid-api [--include-query-text] [--overwrite] [--json]` — полная
  BM25/vector/hybrid matrix с authenticated hit evidence;
- `baka embeddings backfill plan --space <slug> --exact-report <path>
  --accepted-relevance <path> --max-jobs <n> [--json]` и
  `baka embeddings backfill run --space <slug> --exact-report <path>
  --accepted-relevance <same-path> --confirm <exact-phrase> --max-jobs <n>
  [--batch-size <1..64>] --allow-paid-api [--json]` — только выбранный и
  принятый production space; `baka embeddings audit --space <slug>
  [--page-size <1..1000>] [--json]` проверяет dimensions и HNSW `KnnScan`;
- `baka relevance full-corpus plan|evaluate|accept` — обязательная финальная
  post-backfill acceptance. `accept` требует независимо закреплённые
  `--judgments <path> --judgments-sha256 <sha256>
  --judgments-size-bytes <n>`, которые нельзя выводить из принимаемого evidence;
- `baka embeddings status [--json]`; `baka embeddings retry [--space
  <slug>]`; `baka embeddings cancel [--space <slug>]`; `baka embeddings
  space:create [--slug <slug>] [--provider <name>] [--model <name>]
  [--dimensions <n>] [--activate]`; `baka embeddings space:activate <slug>`;
  `baka embeddings space:list [--json]`; `baka embeddings rebuild --space
  <slug>` (stale jobs → pending после смены extraction/segmentation
  versions, их vectors удаляются, §13.5);
- `baka search:rebuild [--no-enqueue-embeddings] [--json]` — пересоздать
  search projection для всех current revisions (после смены
  segmenter/extractor versions, §8.1);
- `baka status [--json]` — сводка архива: последний successful complete live
  sync, полностью проверенный logical backup, strict restore именно этого
  backup, migration reconciliation и exact recovery chain. `integrity=verified`
  не доказывает внешнее происхождение bundle и не утверждает cutover;
- `baka validate [--json]` — проверка инвариантов (§17.3): orphan raw,
  missing/hash mismatch raw, dialogue без current / current не ready,
  duplicate identity keys, ownership/sequence collisions, search_document не из
  current revision, embedding dimension/input SHA/owning space, completed↔vector
  в обе стороны, одна physical table на space, unresolved migration quarantine,
  unknown schema version. `legacy_missing_raw` + `raw_archive_path=NONE` —
  намеренное migration-состояние schema 5;
- `baka discover [--json]` — обнаруженные harness installations и source roots
  (переопределение путей — `BAKA_SOURCES__<SLUG>`, см. `.env.example`);
- `baka backup [--json]` — logical backup (§16.1): HTTP /export боевой базы
  в `backups/surreal/<timestamp>__schema-<v>__surreal-<ver>.surql.zst`
  (gzip fallback, если нет zstd) + manifest JSON в `backups/manifests/`
  (версии, bakaCommit, recordCounts, export bytes/SHA, rawManifestSha256);
- `baka backup off-device plan --destination <path> [--export <path>]...
  [--raw-manifest <path>] [--migration-report <path>]... [--json]`, затем
  `baka backup off-device run` с теми же входами и обязательным
  `--confirm-physical-device`; `baka backup off-device verify <bundle> [--json]`
  проверяет checksum/metadata. Самопроверяемые hashes доказывают целостность,
  но provenance требует внешнего trust anchor;
- `baka restore:test [export] [--raw-archive-root <path>] [--json]` — import
  schema 4/5 export в уникальный `baka_restore_test_<32 hex>` namespace
  отдельного disposable SurrealDB 3.2.3 с exact tag+digest, свежим named
  volume и случайным loopback-портом (никогда не 8901). Перед drill команда
  под maintenance lock проверяет exact production container, три ожидаемых
  mount'а, health и отсутствие клиентов, закрывает baseline-client и
  останавливает только `baka-surrealdb`; после cleanup индексов/namespace
  disposable container+volume удаляются, production всегда запускается
  обратно, а schema/current-revision hash обязан совпасть. Только затем
  сохраняется strict private RestoreTestReport v5 с ready
  `search_document_content`, подтверждённым отсутствием глобального
  `chunk_content` для schema 5 и exact bounded resource profile (memory/swap 12/12 GiB,
  CPU/pids 4/512, RocksDB/HNSW cache 1 GiB/256 MiB, threads/jobs/
  subcompactions 4/4/2, threshold 6 GiB, HTTP import 32 GiB, index resume 0).
  `SURREAL_INDEXING_BATCH_SIZE` не передаётся: pinned core 3.2.3 не читает
  такой CommonConfig key. Отдельная immutable-аттестация фиксирует реальное
  adaptive-поведение binary: первый probe 16 records, soft target 8 388 608
  raw bytes, максимум 250 records; replay тоже читает максимум 250. Same-server
  fallback отсутствует; failure/OOM сохраняет
  privacy-safe no-clobber cleanup evidence без имён, портов и credentials;
- `baka recovery:rebuild <export> --export-sha256 <sha256>
  --manifest-sha256 <sha256> --db-root <internal-path>
  --work-root <internal-path> --confirm-rebuild [--json]` — one-way rebuild
  authenticated schema-5 backup в fresh effective internal `BAKA_DB_ROOT`.
  Команда проверяет новое DB tree, удаляет exact staging container
  и sole streamed import temp, но не пересоздаёт Compose service и не выполняет
  container-name cutover, promotion, physical rollback или reverse migration.
  Координатор отдельно recreates Compose с тем же `BAKA_DB_ROOT`
  только после success-report;
- `baka raw:verify [--manifest] [--json]` — raw manifest по БД (все
  source_revision: путь, SHA-256, size, harness) и сверка с файловой
  системой (§16.2); orphan-файлы — предупреждение;
- `baka migration plan [--legacy-db <path>] [--report <path>] [--skip-live]
  [--json]` — snapshot/preflight без записи в legacy или SurrealDB; для
  production approval `--skip-live` недопустим. `migration run|retry` требуют
  точные signed approval/attestation/host-map/restore artifacts, независимый
  public-key fingerprint, новый `--report`, `--apply`; `migration status
  [--json]` читает durable reconciliation. Для единственного fail-closed
  набора irreducible quarantine rows есть отдельный
  signed lifecycle: `baka migration exclusions plan --source-migration <id>
  --artifact <path>`, затем внешняя detached Ed25519 подпись,
  `baka migration exclusions apply --artifact <path>
  --exclusion-attestation <path>
  --approval-public-key <pem> --approval-key-sha256 <sha256> --report <path>
  --apply`, `baka migration exclusions status [--json]`. Он не меняет
  original reconciliation/ledger и не создаёт canonical mappings; verified
  exact exclusions показываются отдельно от unresolved/forged/stale. Отдельный
  backup+restore выполняется только при финальной приёмке архива;
- `baka doctor [--apply] [--allow-destructive] [--import-orphan-raw]
  [--remove-stale-staging] [--requeue-stuck-embeddings]
  [--rebuild-search-projection] [--recalculate-primary-models]
  [--repair-manifest] [--manifest-path <path>]
  [--no-enqueue-embeddings] [--json]` — inspect/dry-run по умолчанию;
  ambiguous orphan raw остаётся manual;
- `baka export-thread <dialogue-id> [-o|--output <path>]
  [--include-relative-source-paths] [--force] [--json]` — privacy-safe export,
  пути по умолчанию исключены;
- `baka reparse` требует ровно один selector из `--source-revision <id>`,
  `--source-location <id>`, `--harness <slug>`, `--all`; дополнительные flags:
  `--parser-version <latest|n> --only-outdated --dry-run
  --no-enqueue-embeddings --no-verify-raw --json`;
- `baka archive:init`, `baka db up/down/status/migrate/preflight/logs`,
  `baka disk eject` — инфраструктура (см. `package.json` scripts).

## Что архивируется

Восемь harness'ов:

- Codex
- Claude Code
- Claude Desktop
- OpenCode
- Cursor
- Qwen Code
- Kimi Code (Kimi CLI)
- OMP

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
| Raw, manifests, exports и backups | `/Volumes/Archive/Conversations` (задаётся `BAKA_ARCHIVE_ROOT`) |
| Live RocksDB | `BAKA_DB_ROOT`; persistent default `${HOME}/Library/Application Support/ai-baka/rocksdb` на внутреннем диске |
| Legacy-архив SQLite (read-only, не трогаем) | `/Volumes/Archive/Legacy Conversations/` |
| Legacy migration input | `${BAKA_ARCHIVE_ROOT}/migration-input/`; только до принятого pending import |
| SurrealDB | отдельный Docker-контейнер, `127.0.0.1:8901`, image `surrealdb/surrealdb:v3.2.3` (tag + digest) |

### Раздельное хранение live RocksDB и архива

Compose монтирует
`${BAKA_DB_ROOT:-${HOME:?HOME must be set}/Library/Application Support/ai-baka/rocksdb}` в
`/data/db`. HOME-derived default устойчив между обычными `baka db up` /
`docker compose up` и не требует печатать или изменять secret `.env`.
`BAKA_DB_ROOT` может выбрать другой абсолютный внутренний APFS
(предпочтительно APFS Encrypted) или POSIX path. ExFAT **не поддерживается для
live RocksDB**, recovery staging, streamed import temp и recovery journal. Raw
snapshots, manifests и logical/off-device backups остаются под
`BAKA_ARCHIVE_ROOT` на внешнем archive volume.

Старый `${BAKA_ARCHIVE_ROOT}/db` не является runtime fallback и не
перемещается автоматически: существующая инсталляция сначала проходит
one-way backup-rebuild по runbook, а повреждённый archive volume store остаётся
нетронутым до acceptance. Нельзя запускать обновлённый compose до подготовки
и проверки internal target — иначе SurrealDB создаст новую пустую DB в
HOME-derived каталоге.
Команда rebuild не пересоздаёт Compose container: это отдельный
координаторский шаг после успешного report и проверки exact
effective `BAKA_DB_ROOT`.

`migration-input/index__<sha256>.sqlite` — read-only input ещё не принятого
legacy import, а не recovery artifact. Его сохраняют только до принятой
миграции; отдельного retained large cache recovery не оставляет.

Внутренний диск должен одновременно вместить fresh DB tree,
один streamed reordered import, recovery journal, временный space amplification
compaction/index rebuild и системный резерв. Все крупные временные файлы
удаляются в `finally`. Для rebuild используется консервативный входной gate:
свободно не меньше измеренного recovery peak плюс обычный резерв ОС; physical
copy не заменяет logical и off-device backup. Точная процедура rebuild,
проверки, cleanup и отдельного Compose recreation —
[`docs/rocksdb-recovery.md`](docs/rocksdb-recovery.md).

### Лимит HTTP restore

Compose передаёт SurrealDB
`SURREAL_HTTP_MAX_IMPORT_BODY_SIZE=${SURREAL_HTTP_MAX_IMPORT_BODY_SIZE:-34359738368}`.
Значение задаётся в **байтах**; `34359738368` — ограниченные 32 GiB.
Import-тело сверх лимита отклоняется через HTTP 413 до полного чтения.
Безлимитное значение намеренно не используется. Имя переменной, byte-unit
и тип `usize` зафиксированы в официальном
[справочнике environment variables SurrealDB](https://surrealdb.com/docs/reference/cli/surrealdb-cli/environment-variables).

Увеличенный лимит приемлем только внутри существующей границы безопасности:
порт опубликован на loopback `127.0.0.1`, а `/import` требует аутентификацию.
Если сервер когда-либо станет доступен не только локально, сначала нужно
пересмотреть credentials и HTTP exposure. Повышать лимит дальше можно только
после проверки SHA/size конкретного аутентифицированного backup и измерения
его фактического streamed decompressed-and-reordered import-тела; выбирается новый
конечный минимум с запасом, после чего контейнер пересоздаётся.

## Зафиксированные live observations этапа 8

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
- Restore drill отправляет multi-GiB `/import` нативным curl/libcurl с
  backpressure, точным `Content-Length` и без credentials в argv; compose
  отдельно задаёт bounded 32 GiB server-side limit, чтобы такой поток не был
  отклонён HTTP 413 до импорта.

## Документация

- [`docs/plan.md`](docs/plan.md) — целевая редакция плана: архитектура,
  сущностная модель, алгоритмы sync, миграция legacy, этапы 0–12,
  Definition of Done.
- [`docs/architecture.md`](docs/architecture.md) — краткий обзор архитектуры
  и ключевых инвариантов.
- [`docs/rocksdb-recovery.md`](docs/rocksdb-recovery.md) — production-runbook
  для one-way rebuild fresh internal RocksDB, cleanup и отдельного
  Compose recreation без in-place repair и reverse migration.
- [`docs/sources.md`](docs/sources.md) — источники данных восьми harness'ов:
  пути, форматы, стратегии snapshot.

## Границы проекта

Не входит: изменение External System и `other-project`, web-интерфейс, облачный хостинг,
автосинхронизация диска между ноутбуками, генерация ответов поверх архива,
эмбеддинг reasoning/tool-данных, автоматическое удаление legacy-файлов.
