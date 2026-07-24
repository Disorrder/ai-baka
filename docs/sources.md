# Источники данных (harness'ы)

Семь поддерживаемых harness'ов. Пути по умолчанию относятся к macOS;
фактические корни задаются конфигурацией и фиксируются в `source_root`.

| Harness | Slug | Источник по умолчанию | source_kind | snapshot_strategy |
| --- | --- | --- | --- | --- |
| Codex | `codex` | `~/.codex/archived_sessions`, `~/.codex/sessions`, `~/.codex/sqlite` | JSONL file tree | `copy` |
| Claude Code | `claude-code` | `~/.claude/projects`, `~/.claude/history.jsonl` | JSONL file tree | `copy` |
| Claude Desktop | `claude-desktop` | `~/Library/Application Support/Claude/IndexedDB`, `Session Storage` | file-backed | `copy` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db`, `storage/session_diff` | SQLite | `sqlite_backup` / `vacuum_into` |
| Cursor | `cursor` | `~/Library/Application Support/Cursor/User/workspaceStorage`, `globalStorage/state.vscdb` | SQLite + files | `sqlite_backup` / `vacuum_into` |
| Qwen Code | `qwen-code` | `~/.qwen/projects` | JSONL file tree | `copy` |
| Kimi Code | `kimi-code` | `~/.kimi-code/sessions`, `~/.kimi-code/session_index.jsonl` | JSONL file tree + JSON metadata | `copy` |

## Важные правила

- Живые SQLite-базы (`opencode.db`, `state.vscdb`) нельзя архивировать
  обычным копированием: в WAL mode транзакции могут находиться в `-wal`.
  Snapshot делается через SQLite Online Backup API или `VACUUM INTO`.
- Один transcript-файл обычно соответствует одному диалогу; SQLite-источники
  (OpenCode, Cursor) содержат много диалогов в одном snapshot, и единицей
  транзакции записи является отдельный dialogue revision.
- `session_index.jsonl` Kimi Code — индекс (sessionId, sessionDir, workDir),
  а не сам диалог; контент — в `wire.jsonl` каждой сессии.

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
