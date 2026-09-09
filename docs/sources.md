# Источники данных (harness'ы)

Восемь поддерживаемых harness'ов. Пути по умолчанию относятся к macOS;
фактические корни задаются конфигурацией и фиксируются в `source_root`.

| Harness | Slug | Источник по умолчанию | source_kind | snapshot_strategy |
| --- | --- | --- | --- | --- |
| Codex | `codex` | `~/.codex/archived_sessions`, `~/.codex/sessions`, `~/.codex/sqlite`, `~/Library/Application Support/orca/codex-runtime-home/home/sessions` | JSONL file tree | `copy` |
| Claude Code | `claude-code` | `~/.claude/projects`, `~/.claude/history.jsonl` | JSONL file tree | `copy` |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/local-agent-mode-sessions`, `IndexedDB`, `Session Storage` | JSON/JSONL file tree (+ LevelDB fallback) | `copy` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db`, `storage/session_diff` | SQLite | `sqlite_backup` / `vacuum_into` |
| Cursor | `cursor` | `~/Library/Application Support/Cursor/User/workspaceStorage`, `globalStorage/state.vscdb` | SQLite + files | `sqlite_backup` / `vacuum_into` |
| Qwen Code | `qwen-code` | `~/.qwen/projects` | JSONL file tree | `copy` |
| Kimi Code | `kimi-code` | `~/.kimi-code/sessions`, `~/.kimi-code/session_index.jsonl` | JSONL file tree + JSON metadata | `copy` |
| OMP | `omp` | `~/.omp/agent/sessions` | JSONL file tree | `copy` |

## Важные правила

- Живые SQLite-базы (`opencode.db`, `state.vscdb`) нельзя архивировать
  обычным копированием: в WAL mode транзакции могут находиться в `-wal`.
  Snapshot делается через SQLite Online Backup API или `VACUUM INTO`.
- Один transcript-файл обычно соответствует одному диалогу; SQLite-источники
  (OpenCode, Cursor) содержат много диалогов в одном snapshot, и единицей
  транзакции записи является отдельный dialogue revision.
- `session_index.jsonl` Kimi Code — индекс (sessionId, sessionDir, workDir),
  а не сам диалог; контент — в `wire.jsonl` каждой сессии.
- OMP хранит один JSONL transcript на сессию в `~/.omp/agent/sessions`;
  дочерние agent transcripts тоже импортируются как самостоятельные диалоги.
- Orca Codex pane хранит те же Codex rollout JSONL в собственном runtime home:
  `~/Library/Application Support/orca/codex-runtime-home/home/sessions`.
  Это импортируется как harness `codex`; Orca здесь только оболочка, не
  отдельный vendor/harness для аналитики. При sync exact SHA-256 дубли из
  Orca runtime пропускаются, если такой же transcript уже найден в нативных
  Codex roots (`~/.codex/sessions` или `~/.codex/archived_sessions`).

## Cursor: неполная история промптов

Parser version 4 извлекает `ItemTable/aiService.prompts` из `state.vscdb`,
а также непустые `textDescription` событий `chat`, `composer`, `cmdk` из
`aiService.generations`. Описания генераций без совпавшего промпта имеют
`humanAuthored = "unknown"`: это может быть UI-описание, не дословный ввод.
`apply`/`bugbot` — операции, а не пользовательские сообщения.

Эти массивы не содержат ответов и идентификаторов диалогов. Они сохраняются
как отдельный контейнер истории источника (`metadata.historyOnly = true`,
`responsesAvailable = false`), без выдуманных assistant messages, времён,
моделей и usage. Точные повторы текста внутри контейнера объединяются;
исходные вхождения сохраняются в `historyOccurrences`. Контейнер использует
source-location identity, не имя immutable snapshot. Composer-диалоги
по-прежнему извлекаются отдельно. Пустые строки пропускаются, повреждённые
массивы и неизвестные записи дают ошибки, а не молчаливое игнорирование.

## Codex: служебные SQLite

Parser version 10 распознаёт проверенные схемы баз state, logs, memories,
goals и Codex Desktop. Это raw-only источники: `raw_only_metadata` с
уровнем `info`, ноль диалогов, успешный parse без замечания
«неподдерживаемый формат». Raw snapshot сохраняется как прежде.

Классификация основана на таблицах и обязательных колонках, не имени файла.
Неизвестные таблицы/схемы остаются `unsupported_file`, повреждённая SQLite —
ошибкой разбора. Для Desktop дополнительно проверяется отсутствие
`automation_runs.archived_user_message`/`archived_assistant_message` и строк
`thread_timeline_ledger`: при наличии таких данных база не игнорируется.
Служебные summaries, цели, настройки автоматизаций и каталоги тредов не
выдаются за исходные сообщения; основной источник диалогов — rollout JSONL.

Уже сохранённые revisions обновляются явно, без изменения raw:
`baka reparse --harness cursor --only-outdated` и
`baka reparse --harness codex --only-outdated`.
Для предварительного просмотра selection добавляется `--dry-run`;
для узкого применения вместо harness используются `--source-location <ids...>`.

## Kimi Code (Kimi CLI)

Kimi Code CLI хранит все данные в `$KIMI_CODE_HOME` (по умолчанию `~/.kimi-code/`,
переопределяется переменной окружения `KIMI_CODE_HOME`).

Структура сессий:

```text
~/.kimi-code/
├── session_index.jsonl          # индекс: sessionId, sessionDir, workDir
└── sessions/
    └── <workDirKey>/            # wd_<slug>_<12 chars sha256(workDir)>
        └── <sessionId>/
            ├── state.json       # title, lastPrompt, timestamps, forkedFrom
            └── agents/
                ├── main/
                │   └── wire.jsonl   # полный event stream основного агента
                └── agent-0/
                    └── wire.jsonl   # wire-файлы субагентов
```

Особенности parser'а `kimi-code`:

- один каталог `<sessionId>/` = один диалог; `external_id` = sessionId;
- `wire.jsonl` — поток событий агента, включая request trace (tool schemas,
  параметры запросов, MCP-листинги) — служебные события не эмбеддятся;
- `state.json` даёт заголовок и временные метки; `forkedFrom` связывает
  форкнутые сессии (хранится в metadata диалога);
- `workDirKey` позволяет восстановить `workspace` из `session_index.jsonl`;
- wire-файлы субагентов (`agents/agent-*/`) относятся к тому же диалогу
  и архивируются вместе с ним;
- discovery должен учитывать `KIMI_CODE_HOME`, если переменная задана.

Источники: [Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html),
[Sessions and context](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html).

## OMP

OMP session JSONL содержит события `session`, `model_change`,
`thinking_level_change`, `message`, `custom`, `custom_message` и `compaction`.
Parser сохраняет user/assistant/tool messages, reasoning chunks, tool calls,
tool results, `usage`, `duration`, `ttft` и cost payload в raw usage/metadata.
