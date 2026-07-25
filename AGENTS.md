# AGENTS.md

## Статус проекта

Реализованы этапы 0–8 из [`docs/plan.md`](docs/plan.md) (раздел «Порядок
реализации»): инфраструктура, schema migrations, source snapshot layer
(discovery `baka discover`, complete/partial scan, immutable raw snapshots,
SQLite через `VACUUM INTO`, deletion/rename/reconcile-логика), parser
contract + parsers/extractors всех 7 harness'ов (parser_version = 2,
EXTRACTOR_VERSION = 2), SurrealDB writer и structured sync
(`baka sync` / `baka status` / `baka validate`): репозитории
`src/db/repositories/`, транзакция диалога по §10.4
(`src/db/repositories/corpus.ts`), orchestrator `src/sync/sync-run.ts`.
Этап 6: segmenter длинных документов (`src/search/segmenter.ts`,
segmentation_version = "2", target 6000–7000 / hard < 8192 токенов,
эвристика chars/3.5 с seam под точный tokenizer), BM25 full-text
поиск (`src/search/fulltext.ts`, CLI `baka search`) и forensic search по
chunk.content (--include-reasoning/--include-tools/--include-system/
--all-revisions), пересоздание projection — `baka search:rebuild`
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
drill `baka restore:test` — импорт в отдельный namespace
`baka_restore_test` (import сам создаёт ns/db), сверка counts/инвариантов/
search-probes, REMOVE NAMESPACE в finally, боевой ns не трогается;
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
- restore drill не поднимает второй контейнер: импорт в
  `baka_restore_test` той же базы, REMOVE NAMESPACE в finally (идемпотентно
  — перед импортом тоже чистится, на случай прошлого упавшего drill'а);
  проверки сравнивают restored с manifest'ом и с боевой базой
  (инварианты, BM25 probes), а не с константами;
- `baka backup` берёт preflight + lock (консистентный snapshot относительно
  sync), `restore:test` и `raw:verify` — read-only по архиву, без lock'а;
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
- process lock атомарен: запись во временный файл + link(2) (EEXIST =
  занят), stale-takeover — unlink+link до 5 попыток (сценарий №29);
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
  parser'ах (§7.3) — parser_version = 2 у всех; EXTRACTOR_VERSION = 2:
  граница turn'а — последний user message с humanAuthored true/unknown
  (общий findLastTurnBoundary), codex final_answer ищется только после
  неё; kimi raw role → role="unknown" + rawRole; cachedInputTokens =
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
- restore drill большого export: тело /import буфером
  (`readFile`) обрывало upload, сервер применял усечённый поток —
  передаём `Bun.file(path)` (поток с диска). Побочные находки 3.2.3:
  SELECT по неопределённой таблице — ошибка "The table ... does not
  exist", а не 0 строк; /import применяет поток по мере поступления
  (ns/db могут быть частично созданы даже при оборванном upload);
- повторный parse revision (после фикса parser'а) закрывает её прежние
  unresolved ingest_errors (`resolveStaleIngestErrors`, resolution
  `reparse:<status>`): иначе исправленные ошибки копились бы вечно.

## Стек

- Bun + TypeScript, CLI `baka`.
- SurrealDB 3.2.3 (image pinned tag + digest), RocksDB, отдельный
  docker-compose, только `127.0.0.1:8901`.
- Архив на внешнем диске: `BAKA_ARCHIVE_ROOT`
  (по умолчанию `/Volumes/Archive/Conversations`).
- Схема БД — миграции в `schema/*.surql` (0001–0004, строго по
  `docs/plan.md` §7/§8/§12/§13/§15); migration runner —
  `src/db/migrations.ts` (`baka db migrate`, версия схемы видна в
  `baka db status`).

## Жёсткие ограничения

- Legacy-архив `/Volumes/Archive/Legacy Conversations/` — read-only.
  Никогда не изменять и не удалять; физическое удаление — только вручную
  пользователем после периода эксплуатации новой системы.
- Никакого dual-write: новая ветка пишет только в SurrealDB.
- External System и проект `other-project` не изменяются.
- Raw snapshots неизменяемы; identity — полный SHA-256.
- Embeddings не входят в критический путь sync; OpenAI key только в окружении.
- `.env`, secrets, приватные диалоги и полные raw-файлы не коммитятся;
  в Git — только обезличенные golden fixtures.
- Документация — на русском; код, комментарии и commit messages — по
  конвенциям проекта (код появится позже, следуем стилю Bun/TS).
- Любые git-мутации (commit/push/reset/rebase) — только по явному запросу
  пользователя.
