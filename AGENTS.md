# AGENTS.md

## Статус проекта

Реализованы этапы 0–8 из [`docs/plan.md`](docs/plan.md) (раздел «Порядок
реализации»): инфраструктура, schema migrations, source snapshot layer
(discovery `baka discover`, complete/partial scan, immutable raw snapshots,
SQLite через `VACUUM INTO`, deletion/rename/reconcile-логика), parser
contract + parsers/extractors всех 7 harness'ов (parser_version = 1,
EXTRACTOR_VERSION = 1), SurrealDB writer и structured sync
(`baka sync` / `baka status` / `baka validate`): репозитории
`src/db/repositories/`, транзакция диалога по §10.4
(`src/db/repositories/corpus.ts`), orchestrator `src/sync/sync-run.ts`.
Этап 6: segmenter длинных документов (`src/search/segmenter.ts`,
segmentation_version = "1", target 6000–7000 / hard < 8192 токенов,
эвристика chars/3.5 с seam под точный tokenizer), BM25 full-text
поиск (`src/search/fulltext.ts`, CLI `baka search`) и forensic search по
chunk.content (--include-reasoning/--include-tools/--all-revisions),
пересоздание projection — `baka search:rebuild` (`src/search/rebuild.ts`).
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
(§16.1/§16.2/§16.4). Полный backup-модуль с rawManifestSha256 — этап 12.
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
  search_document (post-filter top-50 ANN, без over-fetch);
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
- orphan raw-файлы в raw:verify — предупреждение, не failure (их разбор —
  validate/doctor).

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
  Cursor state.vscdb неактивных workspace) — нужен `create: false`.

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
