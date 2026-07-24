# AGENTS.md

## Статус проекта

Репозиторий содержит только документацию. Код появится по этапам из
[`docs/plan.md`](docs/plan.md) (раздел «Порядок реализации», этапы 0–12).
Авторитетный источник требований — `docs/plan.md`; при расхождении кода
с планом сначала сверяйся с ним.

## Стек

- Bun + TypeScript, CLI `baka`.
- SurrealDB 3.2.3 (image pinned tag + digest), RocksDB, отдельный
  docker-compose, только `127.0.0.1:8901`.
- Архив на внешнем диске: `BAKA_ARCHIVE_ROOT`
  (по умолчанию `/Volumes/Archive/Conversations/surreal-archive`).

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
