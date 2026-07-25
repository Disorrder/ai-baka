# AGENTS.md

## Статус проекта

Реализованы этапы 0–5 из [`docs/plan.md`](docs/plan.md) (раздел «Порядок
реализации»): инфраструктура, schema migrations, source snapshot layer
(discovery `baka discover`, complete/partial scan, immutable raw snapshots,
SQLite через `VACUUM INTO`, deletion/rename/reconcile-логика), parser
contract + parsers/extractors всех 7 harness'ов (parser_version = 1,
EXTRACTOR_VERSION = 1), SurrealDB writer и structured sync
(`baka sync` / `baka status` / `baka validate`): репозитории
`src/db/repositories/`, транзакция диалога по §10.4
(`src/db/repositories/corpus.ts`), orchestrator `src/sync/sync-run.ts`.
Embeddings пока не вызываются: embedding jobs создаются только при
существовании active `embedding_space` (появится на этапе 7).
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
