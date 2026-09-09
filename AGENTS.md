# AGENTS.md

## Версия релиза и схемы

Для ai-baka **0.1.0** существует ровно одна начальная миграция:
`schema/0001_initial.surql`, числовая версия схемы **1**. В неё включён весь
актуальный DDL; новые миграции добавляются только при переходе на следующий
релиз. Версии файлов/отчётов (`formatVersion`) от версии схемы независимы.
Дорелизная цепочка 0001–0009 несовместима по номерам/checksum и не
перенумеровывается автоматически; рабочую БД и старые backup artifacts
нельзя переобозначать как schema 1. Исторические live-измерения ниже относятся
к прежним development-схемам, не к текущему baseline.
Legacy SQLite import остаётся отдельной функцией. Порядок обновления —
в README, раздел «Обновление».

## Статус проекта

Реализованы этапы 0–8 из [`docs/plan.md`](docs/plan.md) (раздел «Порядок
реализации»): инфраструктура, schema migrations, source snapshot layer
(discovery `baka discover`, complete/partial scan, immutable raw snapshots,
SQLite через `VACUUM INTO`, deletion/rename/reconcile-логика), parser
contract + parsers/extractors всех 7 harness'ов (parser_version = 2,
EXTRACTOR_VERSION = 3), SurrealDB writer и structured sync
(`baka sync` / `baka status` / `baka validate`): репозитории
`src/db/repositories/`, транзакция диалога по §10.4
(`src/db/repositories/corpus.ts`), orchestrator `src/sync/sync-run.ts`.
Этап 6: segmenter длинных документов (`src/search/segmenter.ts`,
segmentation_version = "2", target 6000–7000 / hard < 8192 токенов,
эвристика chars/3.5 с seam под точный tokenizer), BM25 full-text
поиск (`src/search/fulltext.ts`, CLI `baka search`) по curated
`search_document`; глобальный forensic index `chunk_content` не создаётся в
начальной схеме 1, а legacy flags fail closed до DB query. Canonical chunks/history
сохранены. Пересоздание projection — `baka search:rebuild`
(`src/search/rebuild.ts`).
Этап 7: embedding pipeline (`src/embeddings/`) — provider abstraction +
OpenAI provider (batch, dimensions, retry/backoff на 429/5xx) + mock
provider для тестов; embedding spaces с физическими vector-таблицами
`search_embedding_<slug>` и HNSW (динамический DDL рантаймом, schema-файлы
не меняются); jobs worker с lease/retry/backoff и приватность-фильтрами
(§13.7, env `EMBEDDINGS_EXCLUDE_*`/`EMBEDDINGS_MAX_DOCUMENT_BYTES`);
vector search и hybrid RRF (`src/search/hybrid.ts`, CLI
`baka search --mode vector|hybrid`) с деградацией по §14; команды
`baka embeddings plan|run|status|retry|cancel|space:create|space:activate|
space:list|rebuild`. Решение о боевом space и полный backfill — этап 11
(после relevance evaluation).
Этап 8: backup tooling (`src/backup/`) и live acceptance — logical backup
через HTTP /export (заголовки `surreal-ns`/`surreal-db`; legacy `NS`/`DB`
в 3.x не работают) в `backups/surreal/` + manifest JSON (recordCounts,
exportSha256) в `backups/manifests/`, zstd с fallback на gzip; restore
drill `baka restore:test` — отдельный exact-pinned disposable SurrealDB 3.2.3
с fresh named volume и loopback-портом не 8901, импорт в уникальный namespace
`baka_restore_test_<32 hex>`, сверка counts/инвариантов/двух BM25 probes,
REMOVE INDEX/NAMESPACE, затем exact cleanup container+volume; production
`baka-surrealdb` останавливается только внутри maintenance window и всегда
перезапускается с проверкой неизменных schema/current-revision hash;
`baka raw:verify` — raw manifest по source_revision + сверка файлов
(§16.1/§16.2/§16.4); rawManifestSha256 в manifest'е backup заполняется
(hashRawManifest по живой БД в том же lock-окне, что и export).
Off-device backup и полный backup-модуль — этап 12.
Этап 9 (частично): legacy snapshot (`src/migration/legacy-snapshot.ts`)
и preflight migration report (`src/migration/preflight.ts`,
`baka migration plan`) с построчной reconciliation §15.9 по всем
legacy-таблицам; `migration run` — этап 10.
Авторитетный источник требований — `docs/plan.md`; при расхождении кода
с планом сначала сверяйся с ним.

Ключевые решения этапа 5 (подробности — комментарии в коде):

- транзакция SurrealDB = ОДИН query-вызов `BEGIN; ...; COMMIT;`
  (транзакция не живёт между вызовами SDK 2.x); мульти-statement IF/ELSE
  внутри транзакции не использовать (молча биндит null) — upsert dialogue
  через `UPSERT ONLY ... WHERE`;
- dialogue_revision id детерминирован: sha256(identity_key + parser@version
  + canonical_hash) — идемпотентность повторных sync;
- kimi-code: диалог = каталог сессии; sync собирает parse-view из immutable
  raw-файлов (hardlink'и в staging) и парсит его целиком; session_index.jsonl
  архивируется, но не парсится (parse_status = unsupported).

Ключевые решения этапа 6:

- синтаксис BM25 в SurrealDB 3.2.3: `content @0@ $q` в WHERE +
  `search::score(0)` / `search::highlight('<em>', '</em>', 0)` в SELECT
  (0 — номер matches-предиката); highlight возвращает ВЕСЬ контент,
  snippet усечётся клиентом вокруг первого матча;
- search_document id детерминирован: sha256(revision + document_type +
  doc_index + segment_no); source_chunks каждого сегмента = все chunks
  исходного извлечённого документа;
- rebuild пересоздаёт projection из canonical messages/chunks в БД;
  human_authored/visible_to_user хранятся bool, поэтому исходное
  "unknown" при rebuild трактуется как false (см. комментарий в
  src/search/rebuild.ts).
- `search_document` содержит отдельный `user_prompt` для каждого
  human-authored user message и финальные видимые assistant answers только
  current revisions; начальная схема не создаёт глобальный
  `chunk_content` FULLTEXT, сохраняя canonical `chunk` records. Legacy forensic
  flags fail closed без query/table scan.

Ключевые решения этапа 7:

- синтаксис KNN/HNSW в SurrealDB 3.2.3 (проверено на живой базе):
  `WHERE vector <|K, EF|> $q` (без EF оператор `<|K|>` отвергается как
  legacy KTree/M-Tree) + `vector::distance::knn()` в SELECT; EXPLAIN FULL
  показывает operator "KnnScan" с именем индекса — это проверка сценария
  №24; brute-force без индекса — `<|K, COSINE|>` (KnnTopK);
- физические vector-таблицы создаются DDL рантаймом в space:create
  (`DEFINE TABLE ... SCHEMAFULL` + `DEFINE INDEX ... HNSW DIMENSION n
  TYPE F32 DIST COSINE`); смены current revision каскадно удаляют vectors
  (§8.1): corpus.ts получает список таблиц через listEmbeddingTables;
- worker (src/embeddings/jobs.ts): lease одним BEGIN/LET/UPDATE/COMMIT
  (UPDATE — третий результат query), backoff base 10s × 2^(n-1) (потолок
  1ч), MAX_ATTEMPTS 8, lease timeout 5 мин; dimension каждого вектора
  проверяется worker'ом до записи (№23); id vector-записи
  детерминирован (vec_<sha256(doc:space)>) → повторный run идемпотентен;
- приватность (§13.7) проверяется worker'ом в момент вызова API:
  исключённый job → cancelled ("privacy_excluded: ..."), в provider не
  уходит; конфиг — env (EMBEDDINGS_EXCLUDE_*, см. .env.example);
- RRF — клиентский (k=60, src/search/hybrid.ts), не search::rrf():
  проще и детерминированно; vector-фильтры §14 применяются при гидратации
  search_document, но при активных фильтрах ANN делает over-fetch
  (K = min(max(50×4, 200), 1000), EF = max(200, K)) — HNSW в SurrealDB не
  поддерживает partial WHERE, иначе редкий harness/workspace давал бы
  ложный пустой результат; pipeline §14: RRF → dedup по message →
  diversification (≤3 hits на dialogue) → limit;
- provider worker'а создаётся по space.provider через
  defaultProviderFactory (src/embeddings/jobs.ts) ДО lease — ошибка (нет
  ключа, неизвестный provider) оставляет jobs в pending; activateSpace
  догоняет missing jobs (идемпотентный enqueue); stale job — по всем
  факторам §13.5 (content hash, extraction/segmentation versions,
  provider, model, dimensions);
- цена для `embeddings plan` — только из env
  OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS, в коде не захардкожена.

Ключевые решения этапа 8:

- HTTP /export и /import SurrealDB 3.2.3 требуют заголовки `surreal-ns`/
  `surreal-db` + basic auth; /import сам создаёт namespace и database,
  явный DEFINE не нужен (синтаксиса `DEFINE DATABASE ... ON NAMESPACE`
  нет); операции уровня сервера (REMOVE NAMESPACE) — через /sql без
  ns-заголовков (`sqlRoot` в src/backup/http.ts);
- compose явно передаёт `SURREAL_HTTP_MAX_IMPORT_BODY_SIZE` с bounded default
  `34359738368` bytes (32 GiB): ограничение применяется к authenticated
  import; повышать только после измерения проверенного backup,
  unlimited не использовать;
- restore drill обязан использовать второй isolated container; same-server
  fallback запрещён. Exact профиль: memory/swap 12/12 GiB, CPU/pids 4/512,
  RocksDB/HNSW cache 1 GiB/256 MiB, memory threshold 6 GiB, HTTP import 32 GiB,
  RocksDB threads/jobs/subcompactions 4/4/2,
  `--index-build-resume-interval 0`; `SURREAL_INDEXING_BATCH_SIZE` не
  передаётся: exact pinned core не парсит такой CommonConfig key. Вместо
  ложной настройки report отдельно аттестует compile-time adaptive indexing:
  первый probe 16 records, soft target 8 388 608 raw bytes, максимум 250
  records (replay также максимум 250); credentials передаются только через
  env/stdin и не попадают в argv/log/report;
- production maintenance preflight принимает только `baka-surrealdb` exact
  pinned image, healthy loopback `127.0.0.1:8901` и mounts ровно
  `{rw bind effective internal BAKA_DB_ROOT→/data/db, local anonymous volumes
  /data и /logs}`; persistent default —
  `<HOME>/Library/Application Support/ai-baka/rocksdb`, override допускает
  другой абсолютный внутренний APFS/POSIX path, но не archive volume ExFAT;
  проверяет отсутствие чужого lock/client, затем держит собственный process
  lock до restart и сравнения schema/current baseline;
- lifecycle ordering: production stop → isolated start → restore → reverse
  cleanup FULLTEXT indexes → REMOVE NAMESPACE → explicit idempotent target
  finalize (container, затем volume, с доказанной отсутствующей identity) →
  production restart/health/baseline → только после этого RestoreTestReport v5;
- `recovery:rebuild` — отдельный one-way production flow: authenticated
  schema-1 export → fresh final `BAKA_DB_ROOT` + отдельный internal work root →
  staged import/index/verification → exact staging-container removal + temp cleanup →
  private durable journal/report. Вход требует exact independently pinned
  `--export-sha256`, `--manifest-sha256`, effective internal
  `BAKA_DB_ROOT` и `--confirm-rebuild`. Команда не делает container-name
  cutover/promotion, physical rollback или reverse migration; после success
  координатор отдельно recreates Compose с тем же `BAKA_DB_ROOT`.
  Corrupt `archive/db` не открывается/не копируется/не переименовывается
  и остаётся нетронутым до acceptance; `migration-input`
  сохраняется только как read-only input до pending legacy import, а не
  как retained recovery cache;
- `baka backup` берёт preflight + lock (консистентный snapshot относительно
  sync), `restore:test` берёт отдельный maintenance lock, `raw:verify` остаётся
  read-only по архиву без lock'а;
- тело /export стримится на диск (`Bun.write(tmp, response)`), НЕ
  arrayBuffer в память; export и manifest пишутся атомарно: tmp-файл с
  суффиксом `.part` (не матчится latestExportPath) + fsync + rename;
- recordCounts и rawManifestSha256 (`hashRawManifest`, src/backup/raw-verify.ts)
  собираются сразу после export'а при открытом SDK-соединении — то же
  lock-окно; оставшееся допущение: HTTP /export и SELECT count() — не одна
  транзакция, drift возможен только от writer'ов мимо baka;
- restore drill: exportSha256/exportBytes из manifest'а проверяются ДО
  импорта (несовпадение — ошибка); referential-проверки — dangling
  references через `record::exists()` (3.2.3) с критерием НОЛЬ нарушений в
  restored (боевая база — только informational, не критерий); шаг
  §16.4 п.7 — raw references: verifyRawFiles по restored source_revision +
  сверка rawManifestSha256, если поле есть;
- orphan raw-файлы в raw:verify — предупреждение, не failure (их разбор —
  validate/doctor).

Ключевые решения этапа 9 (migration preflight):

- reconciliation §15.9 «ни одна исходная строка не потеряна» — построчная
  по ВСЕМ legacy-таблицам: threads читаются БЕЗ join'а с agent_systems
  (тред с битым agent_id не теряется — orphan с record ID в problems),
  orphan-строки thread_records/messages/message_chunks/raw_backups/projects
  перечисляются с record ID; per-table {total, accounted, withProblems,
  lost}, ok = (lost == 0 по всем таблицам), legacyTotal — полное число
  строк до всякой фильтрации (accounted == legacyTotal);
- null_file (thread_record без source_file_id) блокирует классификацию
  from_raw — связь тред→raw backup неполная; threads вообще без
  thread_records попадают в threadsUncovered;
- quarantine-записи preflight'а: table/recordId/reason; raw payload,
  parser version и retry — зона этапа 10 (migration run);
- checkpoint анализа — formatVersion 2 (checkpoint'ы v1 пересчитываются).

Фиксы код-ревью (приватные отчёты в reports/reviews/):

- head_hash (§10.3): при совпавших size/mtime с прежней revision scanner
  сверяет быстрый fingerprint (sha256 первых 64 КБ + size,
  src/sync/head-hash.ts); читается ТОЛЬКО при совпадении size/mtime;
- process lock атомарен: open(2) с флагом "wx" (O_EXCL; том архива НЕ
  поддерживает hardlink — ENOTSUP), нечитаемый lock перечитывается с
  паузами прежде чем считаться stale, stale-takeover — unlink+wx до 5
  попыток (сценарий №29);
- last_successful_revision (§23.3): partial ≠ успех; при переводе
  revision в parse_error указатель очищается (один UPDATE с IF);
  `baka validate` проверяет указатель (last_successful_not_parsed);
- canonical hash покрывает message/chunk metadata и usageEvents.raw
  (детерминированная нормализация ключей) — иначе revision id коллидирует
  при различиях только в этих полях;
- primary_model = NONE при revision без модели (assignments() отбрасывал
  undefined); dry-run sync НИЧЕГО не пишет в БД;
- kimi-code: snapshot failure любого файла сессии → сессия не
  пересобирается и не переключается (§9.3/§23.4), retry на следующем sync;
- rename detection: 2+ отсутствующих источника с тем же SHA →
  неоднозначность, новый файл — независимый location (§10.7);
- unknown-события сохраняются ПОЛНОСТЬЮ (без slice(0, 4000)) во всех 7
  parser'ах (§7.3) — parser_version = 2 у всех; EXTRACTOR_VERSION = 3:
  каждый извлечённый реальный user message образует отдельный turn-window
  и получает свой assistant_final; harness-specific fallback сохраняет
  реальные prompts с humanAuthored=unknown, но исключает false/system-generated;
  codex final_answer ищется только внутри turn-window; kimi raw role →
  role="unknown" + rawRole; cachedInputTokens =
  ТОЛЬКО cache read (cache creation — в raw события); claude-desktop
  дедуплицирует streaming-записи по message.id;
- segmenter: packBlocks учитывает разделители "\n\n", splitOversized
  режет по переданному counter'у (hard limit < 8192 соблюдается);
- integration-тесты без живой БД — явный skip (dbTest() в
  tests/db-test-utils.ts), не молчаливый pass;
- замечено на живой 3.2.3: HNSW-граф вырождается на большом числе
  идентичных векторов (ANN недетерминированно теряет точки) — учесть при
  relevance evaluation (этап 11).

Отложено осознанно (не входит в фиксы ревью):

- уникальные индексы workspace/workspace_location не добавлены: на боевой
  базе возможны существующие дубли, UNIQUE-миграция упала бы; защита —
  process lock + транзакционный ensureWorkspace (repository_identity
  побеждает path);
- snapshot provider/model/dimensions на embedding_job невозможен без
  новой миграции схемы: recorded-сторона stale-проверки — текущие поля
  space (по конвенции §13.1 они неизменны в рамках space);
- `migration run` и поля quarantine raw payload/parser version/retry —
  этап 10.

Найденные live acceptance баги (исправлены с тестами):

- токен сессии SurrealDB живёт ~1 час: длинный sync падал с "Anonymous
  access not allowed"; connectDb пере-signin'ивается каждые 30 минут
  (src/db/client.ts);
- codex/cursor/opencode parser'ы пытались разбирать sqlite/json файлы
  не своего формата (state_5.sqlite как JSONL —
  jsonl_parse_error; workspace.json/session_diff как SQLite —
  parser_exception): ранняя классификация по magic header
  (src/parsers/shared/sqlite.ts) → одна диагностика unsupported_file;
- snapshotSqlite: bun:sqlite `{readonly: true}` (с неявным create) не
  открывает закрытую WAL-базу без -shm ("unable to open database file",
  Cursor state.vscdb неактивных workspace) — нужен `create: false`;
- CLI-hang после фатальной ошибки: открытый WS SurrealDB держал event
  loop, зомби-процесс удерживал sync lock. `handle()` в cli.ts теперь
  делает жёсткий `process.exit(1)` на путях ошибок, а connectDb закрывает
  сокет, если signin/use упали после connect;
- restore drill на боевом объёме: тело /import буфером (`readFile`), затем
  `Bun.file`/Bun node:http не обеспечили надёжный multi-GiB transport;
  текущий путь — native curl/libcurl upload-file с exact Content-Length,
  backpressure и credentials через stdin config. Побочные находки 3.2.3:
  SELECT по неопределённой таблице — ошибка "The table ... does not
  exist", а не 0 строк; /import применяет поток по мере поступления
  (ns/db могут быть частично созданы даже при оборванном upload);
- import-тело сверх server default отклоняется через HTTP 413; `SURREAL_HTTP_MAX_IMPORT_BODY_SIZE=34359738368`
  снимает этот admission blocker, сохраняя конечный лимит;
- повторный parse revision (после фикса parser'а) закрывает её прежние
  unresolved ingest_errors (`resolveStaleIngestErrors`, resolution
  `reparse:<status>`): иначе исправленные ошибки копились бы вечно.

Фиксы производительности 2026-07-26 (с regression-тестами):

- `--full-rescan` не читает head_hash и не запускает snapshot для
  файлов с неизменными size/mtime — большой архив не перехэшируется
  целиком на каждом прогоне; changed/new по-прежнему переснимаются;
- restore drill вырезает FULLTEXT DDL из export'а, сначала импортирует
  данные, затем строит BM25/HIGHLIGHTS один раз — без дорогого
  инкрементального обновления индекса на каждом INSERT-батче.
- начальная схема не строит FULLTEXT по всем physical `chunk` revisions:
  production/restore требуют только `search_document_content`; canonical
  chunks и historical revisions остаются сохранены без глобального индекса.

Фиксы token usage 2026-08-03 (parser + lineage, с тестом и live-проверкой):

- codex пишет `token_count` по разу на каждый rate-limit bucket
  (`rate_limits.limit_id`: "codex", "codex_bengalfox", ...) с ИДЕНТИЧНЫМ
  `info` — parser складывал каждую копию как отдельный вызов, завышая usage. CODEX_PARSER_VERSION = 8: копия с info, идентичным предыдущему
  token_count, отбрасывается (eventCounts
  `event_msg.token_count_bucket_duplicate`); кумулятивный счётчик растёт
  только от новых вызовов, поэтому повтор info — всегда копия. Сумма request-событий должна совпадать с session cumulative;
- subagent lineage: при позднем spawn codex пишет в child rollout не всю
  историю parent, а текущий хвост контекста после compaction'ов — strict
  prefix matching пропускал такой replay, создавая двойной счёт. `replayMatch` в scripts/analyze-codex-lineage.ts ищет
  максимальный префикс child в непрерывном участке parent с любого offset
  (минимум 3 события; `replayParentOffset` в details), raw-потоки перед
  матчингом дедуплицируются по info так же, как parser; mapper
  canonical-событий дополнительно вычитает bucket-копии уже заматченных
  replay-событий (актуально до репарса с v8);
- forked/subagent rollout: replay истории parent несёт task_complete с
  ИСХОДНЫМИ payload.started_at/completed_at/duration_ms (до момента fork'а,
  envelope timestamp при этом spawn-time) — parser засчитывал часы parent
  как свои.
  CODEX_PARSER_VERSION = 9: explicit duration_ms отбрасывается, если turn
  завершился до старта файла (tolerance 5s на округление payload epoch до
  секунд; иначе собственный turn fork'а ловит false positive),
  eventCounts `event_msg.task_complete.inherited_duration`.

## Стек

- Bun + TypeScript, CLI `baka`.
- SurrealDB 3.2.3 (image pinned tag + digest), RocksDB, отдельный
  docker-compose, только `127.0.0.1:8901`.
- Архив на внешнем диске: `BAKA_ARCHIVE_ROOT`
  (по умолчанию `/Volumes/Archive/Conversations`) содержит raw, manifests,
  exports и backups. Mutable RocksDB задаётся `BAKA_DB_ROOT`; persistent
  default — `<HOME>/Library/Application Support/ai-baka/rocksdb`
  на внутреннем APFS/POSIX storage. ExFAT для live RocksDB и recovery temp/
  staging/journal не поддерживается; старый archive/db не runtime fallback.
- Схема БД — единственная `schema/0001_initial.surql` (версия схемы 1,
  по `docs/plan.md` §7/§8/§12/§13/§15); migration runner —
  `src/db/migrations.ts` (`baka db migrate`, версия схемы видна в
  `baka db status`).

## Жёсткие ограничения

- Legacy-архив `/Volumes/Archive/Legacy Conversations/` — read-only.
  Никогда не изменять и не удалять; физическое удаление — только вручную
  пользователем после периода эксплуатации новой системы.
- Никакого dual-write: новая ветка пишет только в SurrealDB.
- External System и проект `other-project` не изменяются.
- Raw snapshots неизменяемы; identity — полный SHA-256.
- `BAKA_DB_ROOT` меняет только live RocksDB mount; raw/backups остаются под
  `BAKA_ARCHIVE_ROOT`. Recovery — one-way logical backup rebuild на internal
  APFS с cleanup крупных временных файлов в `finally`; corrupt archive volume DB не
  копируется, не переименовывается и остаётся нетронутой до acceptance.
  Rebuild не пересоздаёт Compose: coordinator recreation и acceptance идут
  отдельно по `docs/rocksdb-recovery.md`, без dual-write, physical rollback,
  reverse migration и in-place repair.
- Embeddings не входят в критический путь sync; OpenAI key только в окружении.
- `.env`, secrets, приватные диалоги и полные raw-файлы не коммитятся;
  в Git — только обезличенные golden fixtures.
- Документация — на русском; код, комментарии и commit messages — по
  конвенциям проекта (код появится позже, следуем стилю Bun/TS).
- Любые git-мутации (commit/push/reset/rebase) — только по явному запросу
  пользователя.
