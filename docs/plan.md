# План перевода архива AI-диалогов `baka` с SQLite на SurrealDB

**Статус:** целевая версия плана
**Дата фиксации:** 24 июля 2026 года
**Проект:** `/path/to/ai-baka` (новый репозиторий, строится с нуля)
**Основано на опыте:** legacy-проект `/path/to/legacy-project`

Ниже собрана цельная редакция исходного плана с учётом архитектурного ревью
и технических поправок. Сохраняются главные исходные решения: отдельный
SurrealDB, полная изоляция от External System, сначала проверка на живых
источниках, затем импорт истории, отсутствие dual-write и сохранение старого
SQLite-архива нетронутым до ручного удаления.

Отличия этой редакции от исходного плана:

- проект строится с нуля в новом репозитории `ai-baka`, а не веткой в `baka`;
- добавлен седьмой harness — Kimi Code (Kimi CLI);
- legacy-архив перенесён из `/Volumes/Archive/Conversations` в
  `/Volumes/Archive/Legacy Conversations/`; новый архив начинается с чистой
  папки `/Volumes/Archive/Conversations`.

---

## 1. Контекст

`baka` — локальный Bun/TypeScript CLI, архивирующий диалоги:

* Codex;
* Claude Code;
* Claude Desktop;
* OpenCode;
* Cursor;
* Qwen Code;
* Kimi Code.

Текущее состояние legacy-архива:

Размер архива, количество диалогов, сообщений и удалённых записей
определяются preflight и хранятся только в приватном migration report.

Текущая SQLite-система уже умеет инкрементальную неразрушающую
синхронизацию, включая сохранение диалогов после удаления исходника. Новая
реализация должна сохранить эти свойства и дополнить их:

1. полноценным provenance исходных файлов;
2. историей ревизий;
3. нормализованной сущностной моделью;
4. полнотекстовым поиском;
5. векторным поиском;
6. корректной переносимостью между ноутбуками;
7. строгой проверкой миграции без тихой потери строк.

---

# 2. Цели и границы проекта

## 2.1. Основные цели

Новая система должна:

1. Полностью заменить SQLite как рабочий persistence layer `baka`.
2. Использовать отдельный экземпляр SurrealDB.
3. Хранить физические данные SurrealDB непосредственно на archive volume.
4. Архивировать каждую обнаруженную версию исходного файла как неизменяемый raw snapshot.
5. Различать:

   * физические машины;
   * OS-аккаунты;
   * harness’ы;
   * проекты;
   * модели;
   * reasoning effort;
   * диалоги;
   * ревизии диалогов;
   * сообщения;
   * чанки.
6. Никогда не удалять raw-архив или канонические данные из-за удаления живого источника.
7. Векторизовать только:

   * пользовательские промпты;
   * финальные видимые ответы ассистента.
8. Не отправлять в embeddings:

   * reasoning/thought;
   * tool calls;
   * tool results;
   * системные и служебные сообщения.
9. Сначала построить и проверить live-sync с нуля.
10. После проверки импортировать историю из `index.sqlite`.
11. Обеспечить точное reconciliation миграции.
12. Поддерживать восстановление из logical backup.

## 2.2. Что не входит в эту задачу

Не входят:

* изменение External System или проекта `other-project`;
* извлечение evolving facts, architectural decisions и predicate-графа из диалогов;
* multi-user web-интерфейс;
* облачный хостинг SurrealDB;
* автоматическая синхронизация archive volume между ноутбуками;
* генерация ответов поверх архива;
* автоматическое объединение OS-аккаунтов разных машин в одну глобальную личность;
* эмбеддинг reasoning и tool-данных;
* автоматическое физическое удаление старых ревизий.

---

# 3. Итоговые архитектурные решения

## 3.1. SurrealDB полностью отделён от External System

Поднимается самостоятельный SurrealDB:

* отдельный `docker-compose.yml`;
* отдельный порт;
* отдельные credentials;
* отдельный namespace и database;
* отдельный bind mount;
* без external API;
* без tenant-модели External System;
* без общих schema migrations.

External System и его SurrealDB остаются без изменений.

## 3.2. Используется SurrealDB 3.2.3

На 24 июля 2026 года последним стабильным patch-релизом является SurrealDB
**3.2.3 от 21 июля 2026 года**. Новый проект следует начинать с него, а не с
3.1.5, используемой старым независимым стеком `other-project`. Docker image
фиксируется не только тегом, но и digest.

Фиксируются вместе:

```text
SurrealDB server: surrealdb/surrealdb:v3.2.3@sha256:...
SurrealDB JS SDK: точная версия в bun.lock
Schema version: целое число
baka git commit: commit SHA
```

Обновление SurrealDB выполняется только после:

1. logical backup;
2. тестового restore;
3. прогона integration-тестов;
4. smoke-теста на копии RocksDB.

## 3.3. Трёхслойная модель архива

Главное архитектурное разделение:

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

Следствия:

* raw snapshot никогда не изменяется;
* старая ревизия диалога не уничтожается;
* текущая ревизия выбирается указателем;
* поисковую проекцию можно удалить и пересоздать;
* embeddings можно полностью перестроить без изменения архива;
* исправление parser’а не требует доверять старым нормализованным данным.

## 3.4. Embeddings не входят в критический путь sync

Обычный `sync`:

* обнаруживает источники;
* архивирует raw;
* парсит;
* записывает структурированные данные;
* создаёт поисковые документы;
* ставит embedding jobs в очередь.

Сам OpenAI API вызывается отдельной командой.

Сбой OpenAI, отсутствие API key или rate limit не делают structured sync неуспешным.

## 3.5. Никакого dual-write

После переключения:

* новая ветка пишет только в SurrealDB;
* старый SQLite больше не обновляется;
* legacy-файлы лежат рядом в исходном виде;
* SQLite importer существует только как временный read-only migration adapter;
* после подтверждённой миграции importer удаляется из основной ветки и остаётся в git history/tag.

---

# 4. Физическая структура архива

Корень задаётся через переменную окружения:

```dotenv
BAKA_ARCHIVE_ROOT=/Volumes/Archive/Conversations
```

Никаких захардкоженных путей внутри compose или TypeScript-кода.

Рекомендуемая структура:

```text
Conversations/
├── .baka-archive.json
├── db/                             # RocksDB
├── raw/
│   ├── codex/
│   ├── claude-code/
│   ├── claude-desktop/
│   ├── opencode/
│   ├── cursor/
│   ├── qwen-code/
│   └── kimi-code/
├── staging/
│   └── <sync-run-id>/
├── backups/
│   ├── surreal/
│   └── manifests/
├── exports/
├── logs/
└── tmp/
```

## 4.1. Sentinel-файл

`.baka-archive.json` создаётся один раз:

```json
{
  "archiveId": "UUID",
  "formatVersion": 1,
  "createdAt": "ISO-8601",
  "expectedNamespace": "baka",
  "expectedDatabase": "archive"
}
```

Перед любой операцией записи `baka` проверяет:

1. `BAKA_ARCHIVE_ROOT` задан;
2. путь существует;
3. sentinel существует;
4. archive UUID совпадает с конфигурацией;
5. директория writable;
6. путь действительно находится на ожидаемом смонтированном диске;
7. свободного места достаточно;
8. не запущен другой `baka sync`;
9. версия SurrealDB совместима со schema version.

Это защищает от ситуации, когда archive volume не смонтирован, а macOS создаёт
обычную локальную директорию `/Volumes/Archive`.

## 4.2. Имена raw-файлов

Каждая raw-ревизия получает неизменяемое имя:

```text
<sanitized-original-basename>__<full-sha256>.<extension>
```

Например:

```text
rollout-2026-07-24-abc123__\
<sha256>.jsonl
```

Правила:

* SHA-256 добавляется всегда, а не только при коллизии;
* используется полный hash;
* basename обрезается по байтам так, чтобы итоговое имя не превышало безопасный предел файловой системы;
* расширение сохраняется;
* существующий файл с тем же hash повторно не копируется;
* файл с тем же basename, но другим hash создаёт новую raw-ревизию;
* raw-файл никогда не перезаписывается.

`head_hash` может использоваться только как быстрая оптимизация обнаружения
изменений. Identity определяется полным SHA-256.

## 4.3. Staging находится на том же диске

`staging/` должен находиться внутри `BAKA_ARCHIVE_ROOT`, чтобы финальный
rename выполнялся в пределах одной файловой системы и мог быть атомарным.

---

# 5. Runtime и Docker Compose

## 5.1. Сервис

Один сервис:

```text
surrealdb
```

Параметры:

| Параметр         | Значение                                |
| ---------------- | --------------------------------------- |
| Image            | `surrealdb/surrealdb:v3.2.3@sha256:...` |
| Host binding     | `127.0.0.1:8901`                        |
| Container port   | `8000`                                  |
| Storage          | RocksDB                                 |
| Container path   | `/data/db`                              |
| Host path        | `${BAKA_ARCHIVE_ROOT}/db`               |
| Namespace        | `baka`                                  |
| Database         | `archive`                               |
| Network exposure | только loopback                         |
| Restart policy   | `unless-stopped`                        |

Для single-node server SurrealDB рекомендует RocksDB; HNSW и другие индексы
работают поверх того же storage layer.

Compose остаётся совместимым с Docker CLI. На текущем Mac используется
OrbStack, но проект не должен зависеть от OrbStack-specific API.

## 5.2. Credentials

**Решение владельца от 24.07.2026:** инстанс чисто локальный, single-user,
доступен только через loopback, репозиторий никуда не пушится — поэтому
используется `root/root`. Если инстанс когда-либо будет exposed за пределы
loopback, вернуться к random-generated secret.

В `.env`, исключённом из Git:

```dotenv
SURREAL_USER=root
SURREAL_PASS=root
SURREAL_URL=ws://127.0.0.1:8901/rpc
SURREAL_NAMESPACE=baka
SURREAL_DATABASE=archive
```

OpenAI key хранится только в окружении:

```dotenv
OPENAI_API_KEY=...
```

Он:

* не сохраняется в SurrealDB;
* не записывается в логи;
* не попадает в backup manifest;
* не нужен для обычного `sync`.

## 5.3. Команды инфраструктуры

```text
bun run db:preflight
bun run db:up
bun run db:down
bun run db:status
bun run db:logs
bun run db:backup
bun run db:restore:test
bun run disk:eject
```

`disk:eject`:

1. проверяет отсутствие активного sync;
2. останавливает SurrealDB;
3. ждёт завершения контейнера;
4. проверяет отсутствие открытых файлов;
5. при необходимости создаёт logical backup;
6. размонтирует archive volume.

---

# 6. Версионирование схемы

Схема не хранится одной строкой в `db.ts`.

```text
schema/
├── 0001_initial.surql
├── 0002_search_documents.surql
├── 0003_embedding_spaces.surql
└── 0004_legacy_migration_metadata.surql
```

В базе хранится:

```text
schema_migration
  version
  name
  checksum
  applied_at
  baka_commit
  surrealdb_version
```

На старте приложение:

1. читает текущую schema version;
2. проверяет checksums уже применённых migrations;
3. применяет недостающие migrations последовательно;
4. отказывается работать при неизвестной более новой версии;
5. не изменяет схему неявно.

Тестируются два сценария:

* создание пустой базы с нуля;
* обновление базы с каждой поддерживаемой предыдущей версии.

---

# 7. Сущностная модель

Все таблицы объявляются `SCHEMAFULL`, кроме специально выделенных
metadata/raw object-полей.

Большинство связей реализуются обычными record links. Graph relation records
не используются без необходимости: они нужны только там, где сама связь имеет
собственные поля и жизненный цикл.

---

## 7.1. Идентичность и инфраструктура

### `archive_meta`

Singleton `archive_meta:main`.

| Поле                     | Смысл                          |
| ------------------------ | ------------------------------ |
| `archive_uuid`           | UUID sentinel-архива           |
| `format_version`         | версия файловой структуры      |
| `schema_version`         | версия SurrealQL-схемы         |
| `created_at`             | дата создания                  |
| `last_opened_at`         | последнее успешное подключение |
| `created_by_baka_commit` | commit при создании            |

### `host`

Одна физическая или логическая машина.

| Поле            | Смысл                                           |
| --------------- | ----------------------------------------------- |
| `host_uuid`     | стабильный UUID                                 |
| `hostname`      | текущее имя машины                              |
| `label`         | пользовательское имя, например `macbook-m1-max` |
| `platform`      | macOS/Linux/Windows                             |
| `arch`          | arm64/x64                                       |
| `first_seen_at` | первое обнаружение                              |
| `last_seen_at`  | последнее обнаружение                           |

UUID хранится локально:

```text
${XDG_CONFIG_HOME:-~/.config}/baka/host-id
```

Hostname не является identity: его можно изменить или повторить на другой машине.

### `os_account`

Это пользовательская сущность первой версии.

| Поле            | Смысл                 |
| --------------- | --------------------- |
| `host`          | link на `host`        |
| `os_username`   | username              |
| `display_name`  | опциональное имя      |
| `home_path`     | локальный home path   |
| `first_seen_at` | первое обнаружение    |
| `last_seen_at`  | последнее обнаружение |

Уникальность:

```text
(host, os_username)
```

Два ноутбука с пользователем `example` создают две разные записи. Позже их можно
связать через необязательную глобальную сущность `person`, но в первой версии
этого не требуется.

### `vendor`

Производитель модели:

```text
openai
anthropic
alibaba
google
meta
moonshot
unknown
```

Поля:

```text
slug
display_name
first_seen_at
last_seen_at
```

### `harness`

Тип приложения:

```text
codex
claude-code
claude-desktop
opencode
cursor
qwen-code
kimi-code
```

Поля:

```text
slug
display_name
kind
```

Глобальные поля `installed` и `last_detected_at` здесь не хранятся,
поскольку установка относится к конкретному host.

### `harness_installation`

Конкретный harness на конкретной машине.

| Поле               | Смысл                 |
| ------------------ | --------------------- |
| `host`             | машина                |
| `harness`          | тип harness           |
| `installed`        | обнаружен сейчас      |
| `detected_version` | версия, если доступна |
| `first_seen_at`    | первое обнаружение    |
| `last_detected_at` | последнее обнаружение |

Уникальность:

```text
(host, harness)
```

### `model`

Базовая модель, не смешанная с reasoning effort.

| Поле             | Смысл                         |
| ---------------- | ----------------------------- |
| `vendor`         | link на vendor                |
| `canonical_name` | например `gpt-5.6-sol`        |
| `aliases`        | исходные встреченные названия |
| `first_seen_at`  | первое появление              |
| `last_seen_at`   | последнее появление           |

Уникальность:

```text
(vendor, canonical_name)
```

Reasoning effort хранится на уровне вызова/message:

```text
raw_model_name
reasoning_effort
service_provider
```

Например:

```text
model                = model:gpt-5_6_sol
raw_model_name       = "gpt-5.6-sol-xhigh"
reasoning_effort     = "xhigh"
service_provider     = "openai"
```

Это позволяет агрегировать как по базовой модели, так и по конкретному effort.

### `workspace`

Логический проект:

| Поле                  | Смысл                                 |
| --------------------- | ------------------------------------- |
| `name`                | отображаемое имя                      |
| `repository_identity` | нормализованный git remote, если есть |
| `first_seen_at`       | первое обнаружение                    |
| `last_seen_at`        | последнее обнаружение                 |

### `workspace_location`

Физическое расположение проекта:

| Поле              | Смысл                                  |
| ----------------- | -------------------------------------- |
| `workspace`       | логический проект                      |
| `host`            | машина                                 |
| `path`            | локальный путь                         |
| `normalized_path` | нормализованный путь                   |
| `git_remote`      | remote                                 |
| `bindings`        | external project IDs разных harness’ов |
| `first_seen_at`   | первое обнаружение                     |
| `last_seen_at`    | последнее обнаружение                  |

Проект не привязывается к одному harness.

---

## 7.2. Source provenance

### `source_root`

Корень, сканируемый конкретным harness’ом.

| Поле                   | Смысл                                  |
| ---------------------- | -------------------------------------- |
| `harness_installation` | установка harness                      |
| `path`                 | корневой путь                          |
| `source_kind`          | `file_tree`, `sqlite`, `json`, другое  |
| `parser_name`          | parser                                 |
| `snapshot_strategy`    | `copy`, `sqlite_backup`, `vacuum_into` |
| `enabled`              | участвует ли в sync                    |
| `first_seen_at`        | первое обнаружение                     |
| `last_seen_at`         | последнее обнаружение                  |

### `sync_run`

Один запуск операции:

```text
kind:
  live_sync
  migration
  search_rebuild
  embedding_backfill
  validation

status:
  running
  completed
  completed_with_errors
  failed
  cancelled
```

Поля:

```text
started_at
finished_at
host
baka_commit
schema_version
configuration_fingerprint
counters
error_summary
```

### `source_scan`

Результат обхода одного `source_root` в рамках `sync_run`.

```text
status:
  complete
  partial
  unavailable
  permission_denied
  failed
```

Поля:

```text
sync_run
source_root
status
files_seen
files_new
files_changed
files_missing
errors
started_at
finished_at
```

Отсутствие файла учитывается только после `complete`-scan.

### `source_location`

Конкретный путь внутри source root.

| Поле                       | Смысл                                        |
| -------------------------- | -------------------------------------------- |
| `source_root`              | корень                                       |
| `relative_path`            | путь относительно root                       |
| `original_path`            | полный исходный путь                         |
| `basename`                 | исходное имя                                 |
| `presence_status`          | `active`, `missing`, `deleted_in_source`     |
| `missing_complete_scans`   | число последовательных полных scan без файла |
| `current_revision`         | последняя увиденная revision                 |
| `last_successful_revision` | последняя успешно распарсенная revision      |
| `renamed_from`             | подтверждённый старый location               |
| `first_seen_at`            | первое обнаружение                           |
| `last_seen_at`             | последнее обнаружение                        |
| `missing_since_at`         | первое отсутствие                            |
| `deleted_at`               | подтверждённое удаление                      |

Уникальность:

```text
(source_root, relative_path)
```

### `source_revision`

Неизменяемая версия содержимого.

| Поле                   | Смысл                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `source_location`      | исходный путь                                                |
| `sha256`               | полный SHA-256                                               |
| `size_bytes`           | размер                                                       |
| `mtime_ms`             | mtime источника                                              |
| `head_hash`            | быстрый fingerprint, не identity                             |
| `raw_archive_path`     | immutable raw path                                           |
| `snapshot_kind`        | `regular_copy`, `sqlite_backup`, `vacuum_into`, `legacy_raw` |
| `captured_at`          | дата snapshot                                                |
| `parser_name`          | parser                                                       |
| `parser_version`       | версия parser                                                |
| `parse_status`         | `pending`, `parsed`, `partial`, `parse_error`, `unsupported` |
| `dialogues_discovered` | число извлечённых диалогов                                   |
| `canonical_hash`       | hash нормализованного результата                             |
| `sync_run`             | run, создавший revision                                      |

Уникальность:

```text
(source_location, sha256)
```

После создания запись `source_revision` не редактируется, кроме полей
состояния обработки и статистики. Hash, raw path и snapshot metadata
неизменяемы.

### `ingest_error`

Карантин для всего, что не удалось обработать.

| Поле                | Смысл                                                  |
| ------------------- | ------------------------------------------------------ |
| `sync_run`          | запуск                                                 |
| `source_revision`   | source revision                                        |
| `source_record_key` | ID строки/события/диалога                              |
| `stage`             | `snapshot`, `parse`, `normalize`, `write`, `migration` |
| `error_code`        | машинный код                                           |
| `error_message`     | сообщение                                              |
| `raw_payload`       | исходный object, когда безопасно                       |
| `raw_payload_path`  | путь к отдельному dump                                 |
| `parser_version`    | версия parser                                          |
| `first_failed_at`   | первая ошибка                                          |
| `last_failed_at`    | последняя ошибка                                       |
| `resolved_at`       | дата исправления                                       |
| `resolution`        | описание                                               |

Никаких молчаливых `skip`.

---

## 7.3. Канонический корпус

### `dialogue`

Стабильная identity диалога.

| Поле                   | Смысл                               |
| ---------------------- | ----------------------------------- |
| `identity_key`         | детерминированный domain key        |
| `harness_installation` | harness + host                      |
| `os_account`           | OS-аккаунт                          |
| `workspace`            | проект                              |
| `external_id`          | ID harness’а                        |
| `title`                | заголовок                           |
| `current_revision`     | текущая успешная ревизия            |
| `primary_model`        | производный cache                   |
| `started_at`           | начало                              |
| `updated_at`           | последнее содержательное обновление |
| `first_seen_at`        | первое обнаружение                  |
| `last_seen_at`         | последнее обнаружение               |

При наличии external ID:

```text
identity_key =
  <harness-installation-uuid>:<external-id>
```

Fallback:

```text
<harness-installation-uuid>:<source-dialogue-id-or-fingerprint>
```

Одинаковый external ID на разных машинах не мержится.

`primary_model` — только производный cache:

1. наиболее часто встречающаяся модель assistant messages текущей ревизии;
2. при равенстве — модель последнего assistant message.

### `dialogue_revision`

Неизменяемая нормализованная версия диалога.

| Поле                 | Смысл                             |
| -------------------- | --------------------------------- |
| `dialogue`           | стабильный диалог                 |
| `source_revision`    | источник                          |
| `source_dialogue_id` | ID внутри source snapshot         |
| `parser_name`        | parser                            |
| `parser_version`     | версия                            |
| `canonical_hash`     | hash нормализованного содержимого |
| `status`             | `ready`, `quarantined`            |
| `message_count`      | число сообщений                   |
| `chunk_count`        | число чанков                      |
| `started_at`         | начало диалога в этой версии      |
| `updated_at`         | обновление                        |
| `created_at`         | время импорта                     |

Старая ревизия остаётся в базе. `dialogue.current_revision` переключается
только после полного успешного сохранения новой ревизии.

### `message`

| Поле                | Смысл                                         |
| ------------------- | --------------------------------------------- |
| `dialogue`          | диалог                                        |
| `dialogue_revision` | конкретная ревизия                            |
| `external_id`       | исходный ID                                   |
| `sequence`          | порядок                                       |
| `role`              | нормализованная роль                          |
| `raw_role`          | исходная роль                                 |
| `human_authored`    | действительно ли текст создан человеком       |
| `visible_to_user`   | является ли сообщение пользовательским output |
| `timestamp`         | время                                         |
| `model`             | базовая модель                                |
| `raw_model_name`    | исходное имя                                  |
| `reasoning_effort`  | low/medium/high/xhigh/...                     |
| `service_provider`  | OpenAI/OpenRouter/Cursor/...                  |
| `usage`             | нормализованный usage object                  |
| `raw_usage_events`  | исходные usage events                         |
| `metadata`          | harness-specific metadata                     |

Нормализованный `usage`:

```text
scope:
  request
  turn
  session_cumulative
  unknown

input_tokens
cached_input_tokens
output_tokens
reasoning_output_tokens
total_tokens_reported
total_tokens_normalized
is_estimated
source
normalization_version
```

Правила:

* cached input не прибавляется повторно к input;
* reasoning output не прибавляется повторно к output;
* cumulative events не суммируются как независимые turns;
* `total_tokens_reported` сохраняется отдельно;
* исходные usage payloads не теряются;
* parser для каждого harness имеет отдельные fixtures и тесты.

### `chunk`

| Поле                   | Смысл                                    |
| ---------------------- | ---------------------------------------- |
| `dialogue`             | денормализованная ссылка                 |
| `dialogue_revision`    | ревизия                                  |
| `message`              | сообщение                                |
| `sequence`             | порядок                                  |
| `kind`                 | нормализованный тип                      |
| `raw_kind`             | исходный тип                             |
| `role`                 | денормализованная роль                   |
| `content`              | полный текст                             |
| `content_sha256`       | hash текста                              |
| `content_bytes`        | UTF-8 bytes                              |
| `token_count_reported` | только если источник дал per-chunk usage |
| `source_locator`       | line/index/JSON pointer                  |
| `tool_call_id`         | связь tool call/result                   |
| `tool_name`            | имя инструмента                          |
| `raw_event_type`       | исходный event type                      |
| `metadata`             | исходные дополнительные поля             |

Типы `kind`:

```text
text
thought
tool_call
tool_result
system
developer
usage
object
attachment
unknown
```

Неизвестное событие сохраняется как `unknown`, а не вызывает потерю всего диалога.

Вектор в `chunk` не хранится.

---

# 8. Search projection

## 8.1. `search_document`

Производная единица поиска.

| Поле                   | Смысл                               |
| ---------------------- | ----------------------------------- |
| `dialogue`             | диалог                              |
| `dialogue_revision`    | текущая ревизия                     |
| `message`              | исходное сообщение                  |
| `document_type`        | `user_prompt` или `assistant_final` |
| `segment_no`           | номер сегмента                      |
| `content`              | поисковый текст                     |
| `content_sha256`       | hash                                |
| `token_count`          | токены embedding model              |
| `source_chunks`        | ссылки на исходные chunks           |
| `extraction_method`    | способ извлечения                   |
| `extraction_version`   | версия extractor                    |
| `segmentation_version` | версия segmenter                    |
| `created_at`           | время                               |

В основной search projection хранятся документы только для
`dialogue.current_revision`.

Когда текущая ревизия меняется:

1. canonical старая ревизия остаётся;
2. старые `search_document` этого диалога удаляются;
3. связанные embedding jobs и vectors удаляются;
4. новые search documents создаются заново.

Это допустимо, потому что search projection полностью производна.

## 8.2. Извлечение пользовательского промпта

`user_prompt` строится из текстовых chunks user message, которые:

* являются human-authored;
* не являются автоматически вставленным контекстом;
* не являются tool output;
* не являются служебным metadata block.

Все подходящие части объединяются в исходном порядке.

Parser может выставить:

```text
human_authored:
  true
  false
  unknown
```

При `unknown` extractor использует harness-specific fallback и фиксирует это
в `extraction_method`.

## 8.3. Извлечение финального ответа

Не использовать правило «последний текстовый chunk».

Алгоритм:

1. Использовать явные final-output markers harness’а, когда они есть.
2. Собрать все текстовые части, видимые пользователю в финальном assistant output.
3. Не включать скрытый reasoning.
4. Не включать tool calls и tool results как самостоятельные блоки.
5. Сохранить текст до и после tool activity, если он является частью итогового видимого ответа.
6. При неоднозначности применить fallback:

   ```text
   extraction_method = fallback_visible_assistant_text
   ```

Extractor реализуется отдельно для каждого harness.

---

# 9. Получение консистентного raw snapshot

## 9.1. Обычные файлы JSON/JSONL

Алгоритм:

1. Считать исходные `size`, `mtime`, inode/file ID, если доступен.
2. Скопировать файл в:

   ```text
   staging/<run-id>/<temporary-name>
   ```
3. Во время копирования вычислить полный SHA-256.
4. Выполнить flush/fsync временного файла.
5. Повторно проверить source stat.
6. Если файл изменился во время копирования:

   * удалить staging;
   * повторить до заданного лимита;
   * после лимита записать `ingest_error`.
7. Сформировать финальный raw path.
8. Если raw с таким hash уже существует, проверить размер/hash и переиспользовать.
9. Иначе выполнить atomic rename из staging в raw.
10. Только после этого создавать `source_revision`.

## 9.2. SQLite-источники

`opencode.db` и `state.vscdb` нельзя архивировать обычным копированием одного `.db`.

В WAL mode успешные транзакции могут находиться в `-wal`, не будучи
перенесёнными в основной файл. Для snapshot живой SQLite-базы используется:

* SQLite Online Backup API;
* либо `VACUUM INTO`.

Оба способа создают консистентную копию живой базы; обычный filesystem copy
такой гарантии не даёт.

Pipeline:

```text
live SQLite
    ↓ online backup / VACUUM INTO
temporary consistent SQLite snapshot
    ↓ full SHA-256
immutable raw/<harness>/...__<sha256>.db
    ↓ parser
canonical data
```

Snapshot strategy задаётся на уровне `source_root`.

## 9.3. Crash-safe граница файловой системы и БД

SurrealDB поддерживает транзакции для нескольких database statements, но
файловая система не входит в эту транзакцию.

Поэтому порядок фиксированный:

```text
1. Raw snapshot в staging.
2. fsync.
3. Atomic rename в immutable raw.
4. Parse и validation.
5. SurrealDB transaction.
6. Search-document creation.
7. Embedding-job enqueue.
```

Возможные сбои:

| Момент сбоя                | Результат                                              |
| -------------------------- | ------------------------------------------------------ |
| До atomic rename           | staging удаляется или дочищается `doctor`              |
| После rename, до DB commit | остаётся orphan raw; `doctor` импортирует или помечает |
| Во время DB transaction    | transaction rollback                                   |
| После commit, до embedding | structured sync успешен, job остаётся pending          |
| Во время embedding         | job retry, canonical данные не затрагиваются           |

---

# 10. Алгоритм live sync

## 10.1. Начало запуска

1. Выполнить archive preflight.
2. Проверить SurrealDB readiness.
3. Проверить schema version.
4. Получить process lock:

   ```text
   <archive-root>/.baka-sync.lock
   ```
5. Создать `sync_run`.
6. Определить текущий `host` и `os_account`.
7. Обнаружить harness installations и source roots.

## 10.2. Сканирование каждого source root

Для каждого root:

1. Создать `source_scan`.
2. Выполнить полный обход.
3. Если root недоступен:

   ```text
   status = unavailable
   ```
4. Если часть дерева не прочиталась:

   ```text
   status = partial
   ```
5. Только при полном успешном обходе:

   ```text
   status = complete
   ```

`missing` и `deleted_in_source` обновляются только после `complete`.

## 10.3. Обработка найденного location

Для каждого файла:

1. Найти `source_location` по `(source_root, relative_path)`.
2. Сравнить:

   * size;
   * mtime;
   * head hash;
   * последнюю revision.
3. Если быстрый fingerprint совпал, считать файл неизменённым.
4. Если есть сомнение — создать полный snapshot и SHA-256.
5. Если SHA совпал с current revision:

   * обновить `last_seen_at`;
   * не парсить повторно.
6. Если SHA новый:

   * создать raw snapshot;
   * создать `source_revision`;
   * распарсить;
   * нормализовать;
   * записать dialogue revisions.

## 10.4. Atomicity unit

Для обычного JSONL, содержащего один диалог, единицей транзакции является
весь dialogue revision.

Для SQLite snapshot, содержащего много диалогов:

* одна огромная transaction не используется;
* каждый dialogue revision записывается отдельной транзакцией;
* `source_revision.parse_status` может временно быть `partial`;
* повторный запуск идемпотентно продолжает работу;
* текущая старая ревизия конкретного диалога остаётся активной, пока новая
  полностью не записана.

Транзакция одного диалога:

```text
BEGIN;

1. Создать dialogue, если его ещё нет.
2. Создать dialogue_revision.
3. Создать все message.
4. Создать все chunk.
5. Создать search_document.
6. Создать embedding_job.
7. Обновить dialogue.current_revision.
8. Пересчитать dialogue.primary_model.
9. Удалить устаревшую search projection предыдущей current revision.

COMMIT;
```

При ошибке выполняется rollback, а прежняя current revision остаётся действующей.

## 10.5. Укоротившийся или переписанный файл

Никаких upsert по старым sequence.

Новая версия создаёт новый `dialogue_revision`, поэтому:

* старые сообщения не остаются частью текущей версии;
* старая ревизия сохраняется;
* текущий указатель переключается целиком;
* stale tail невозможен.

## 10.6. Отсутствующие файлы

Состояния:

```text
active
missing
deleted_in_source
```

Рекомендуемая политика:

* первый последовательный complete-scan без файла:

  ```text
  active → missing
  ```
* второй последовательный complete-scan:

  ```text
  missing → deleted_in_source
  ```

Количество подтверждений конфигурируется:

```dotenv
BAKA_DELETION_CONFIRMATIONS=2
```

При `partial`, `unavailable` или `failed` scan счётчик отсутствия не изменяется.

При повторном появлении файла:

```text
missing/deleted_in_source → active
```

Ни raw, ни dialogue, ни revisions, ни messages не удаляются.

## 10.7. Rename detection

Переименование подтверждается только когда:

1. старый location отсутствует в complete-scan;
2. появился ровно один новый location с тем же полным SHA-256;
3. нет второго активного кандидата с тем же содержимым;
4. оба location принадлежат одному source root или однозначно связанным roots.

Тогда:

```text
new_location.renamed_from = old_location
```

Во всех неоднозначных случаях создаются два независимых `source_location`.

Одинаковый SHA может означать копию, sync между ноутбуками или повторный
export; поэтому hash сам по себе не доказывает rename.

---

# 11. Parser contract

Parser’ы не должны напрямую писать в SurrealDB.

Общий контракт:

```ts
interface ParsedSourceSnapshot {
  sourceKind: string;
  dialogues: AsyncIterable<ParsedDialogue>;
  diagnostics: ParsedDiagnostic[];
}

interface ParsedDialogue {
  externalId?: string;
  title?: string;
  workspace?: ParsedWorkspace;
  startedAt?: Date;
  updatedAt?: Date;
  messages: ParsedMessage[];
  metadata: Record<string, unknown>;
}

interface ParsedMessage {
  externalId?: string;
  sequence: number;
  role: NormalizedRole;
  rawRole?: string;
  humanAuthored: boolean | "unknown";
  visibleToUser: boolean | "unknown";
  timestamp?: Date;
  model?: ParsedModelInvocation;
  usageEvents: ParsedUsageEvent[];
  chunks: ParsedChunk[];
  metadata: Record<string, unknown>;
}

interface ParsedChunk {
  sequence: number;
  kind: NormalizedChunkKind;
  rawKind?: string;
  content?: string;
  sourceLocator?: string;
  toolCallId?: string;
  toolName?: string;
  rawEventType?: string;
  metadata: Record<string, unknown>;
}
```

## 11.1. Версии parser’ов

У каждого parser:

```text
parser_name
parser_version
source_format_versions[]
```

Изменение логики нормализации повышает `parser_version`.

Если raw revision уже распарсена старой версией, команда:

```text
baka reparse --harness codex --parser-version latest
```

создаёт новую canonical revision из прежнего immutable raw.

## 11.2. Golden fixtures

Для каждого harness сохраняются небольшие обезличенные fixtures:

* обычный диалог;
* диалог с tool calls;
* reasoning;
* model switch;
* usage events;
* cumulative usage;
* пустое сообщение;
* неизвестный event;
* длинный финальный ответ;
* несколько text chunks после tool calls;
* corrupted/truncated source.

Fixtures коммитятся в Git. Полные приватные диалоги не коммитятся.

Особенности parser'а `kimi-code` описаны в [`sources.md`](sources.md):
диалог — это каталог `<sessionId>/` с `state.json` и `agents/*/wire.jsonl`;
`session_index.jsonl` связывает сессию с workspace.

---

# 12. Full-text search

## 12.1. Два режима

### Обычный поиск

Работает по `search_document`:

* пользовательские промпты;
* финальные ответы;
* только текущие dialogue revisions.

### Forensic search

Работает по `chunk.content` и может включать:

* reasoning;
* tool results;
* system context;
* старые dialogue revisions.

Включается явно:

```text
--include-reasoning
--include-tools
--all-revisions
```

## 12.2. Analyzer

Стартовый analyzer должен быть нейтральным для:

* русского языка;
* английского языка;
* кода;
* camelCase;
* цифр;
* путей;
* названий моделей.

```surrealql
DEFINE ANALYZER archive_mixed
TOKENIZERS class, camel
FILTERS lowercase;
```

SurrealDB поддерживает Snowball stemming, включая русский, но глобально
применять `snowball(russian)` к смешанному русско-английскому корпусу с кодом
не следует без relevance-тестов.

Перед фиксацией analyzer проверяется через `search::analyze()` на примерах:

```text
переносимость
переносимый
TypeScript
parseThreadRecord
gpt-5.6-sol-xhigh
/path/to/legacy-project
source_file
UUID
```

## 12.3. Индексы

В SurrealDB 3.x используется `FULLTEXT ANALYZER`, а не старый
`SEARCH ANALYZER`. Векторные индексы — HNSW или DISKANN; MTREE удалён.
Грамматика HNSW не поддерживает partial-index `WHERE`, поэтому векторы
физически отделяются от pending jobs.

```surrealql
DEFINE INDEX search_document_content
ON TABLE search_document
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25 HIGHLIGHTS;

DEFINE INDEX chunk_content
ON TABLE chunk
FIELDS content
FULLTEXT ANALYZER archive_mixed
BM25 HIGHLIGHTS;
```

---

# 13. Embeddings

## 13.1. Embedding spaces

Векторы разных моделей или размерностей нельзя смешивать в одном ANN-индексе.

Metadata:

```text
embedding_space
  slug
  provider
  model
  dimensions
  distance
  vector_type
  segmentation_version
  active
  physical_table
  created_at
```

Каждое embedding space получает отдельную физическую таблицу:

```text
search_embedding_openai_te3l_1024_v1
search_embedding_openai_te3s_1536_v1
```

Это обеспечивает:

* фиксированную dimension;
* отдельный ANN index;
* безопасное A/B-тестирование;
* переключение active space без уничтожения старого;
* отсутствие смешивания vector spaces.

## 13.2. Начальная конфигурация

Начальный кандидат:

```text
provider: OpenAI
model: text-embedding-3-large
dimensions: 1024
distance: COSINE
vector type: F32
index: HNSW
```

Перед полным backfill сравниваются:

| Вариант                  | Dimensions |
| ------------------------ | ---------: |
| `text-embedding-3-small` |       1536 |
| `text-embedding-3-large` |       1024 |
| `text-embedding-3-large` |       3072 |

OpenAI по умолчанию возвращает 1536 dimensions для `text-embedding-3-small`
и 3072 для `text-embedding-3-large`, но `dimensions` позволяет уменьшить
размер. Максимальный input одного embedding составляет 8192 токена.

Полный backfill запускается только после оценки качества на реальных запросах.

## 13.3. Vector index

Пример для пространства 1024/F32:

```surrealql
DEFINE INDEX embedding_vector
ON TABLE search_embedding_openai_te3l_1024_v1
FIELDS vector
HNSW DIMENSION 1024 TYPE F32 DIST COSINE;
```

`TYPE F32` указывается явно.

HNSW используется сначала. DISKANN рассматривается только после измерений,
если HNSW требует неприемлемо много памяти. SurrealDB позиционирует HNSW для
low-latency поиска, когда граф помещается в память, а DISKANN — для
существенно более крупных корпусов, где граф приходится подгружать из
key-value storage.

## 13.4. Сегментация длинных документов

Документы не обрезаются и не пропускаются.

Target:

```text
6000–7000 embedding tokens на segment
```

Hard limit:

```text
< 8192 tokens
```

Границы разбиения:

1. Markdown headings;
2. абзацы;
3. целые code fences;
4. diff/file sections;
5. списки;
6. только затем token-based split.

Каждый segment получает собственный `search_document`.

Оригинальный message и chunks остаются цельными.

## 13.5. `embedding_job`

```text
status:
  pending
  processing
  retryable_error
  permanent_error
  completed
  cancelled
```

Поля:

```text
search_document
embedding_space
input_sha256
status
attempts
next_attempt_at
locked_by
locked_at
last_error
created_at
completed_at
```

Уникальность:

```text
(search_document, embedding_space)
```

Job становится устаревшим и переходит обратно в `pending`, если изменились:

* content hash;
* extraction version;
* segmentation version;
* provider;
* model;
* dimensions.

## 13.6. Поведение worker

```text
baka embeddings run
```

Worker:

1. получает lease на pending jobs;
2. группирует inputs в batch;
3. вызывает OpenAI;
4. проверяет размер каждого вектора;
5. в транзакции:

   * вставляет vector;
   * сохраняет фактический input token usage;
   * переводит job в completed;
6. при временной ошибке применяет exponential backoff;
7. при постоянной ошибке переводит job в `permanent_error`;
8. не затрагивает canonical corpus.

Команды:

```text
baka embeddings plan
baka embeddings run
baka embeddings status
baka embeddings retry
baka embeddings cancel
baka embeddings space:create
baka embeddings space:activate
baka embeddings rebuild
```

`embeddings plan` показывает:

```text
documents
segments
estimated tokens
documents over target size
pending jobs
estimated vector storage
configured price formula
```

Цена не должна быть жёстко зашита в код: она задаётся конфигурацией или
выводится отдельно от гарантированных расчётов.

## 13.7. Политика приватности

В OpenAI отправляется только `search_document.content`.

Поддерживаются исключения:

```yaml
embeddings:
  excludeHarnesses: []
  excludeWorkspaces: []
  excludeDocumentTypes: []
  maxDocumentBytes: ...
```

Логи не содержат полный отправленный текст по умолчанию.

---

# 14. Hybrid search

Pipeline:

```text
1. BM25 top 50
2. Vector ANN top 50
3. Reciprocal Rank Fusion
4. Deduplication по message/dialogue
5. Diversification
6. Top 20
```

SurrealDB предоставляет full-text search, vector search и `search::rrf()` для
объединения rankings.

По умолчанию:

```text
RRF k = 60
```

Результат содержит:

```text
dialogue title
document type
snippet
score/rank
harness
host
workspace
model
reasoning effort
timestamp
source path
dialogue revision
```

Поддерживаемые фильтры:

```text
--mode text|vector|hybrid
--harness
--host
--user
--workspace
--vendor
--model
--reasoning-effort
--from
--to
--role
--document-type
--include-tools
--include-reasoning
--all-revisions
--deleted-only
```

Если active embedding space отсутствует или OpenAI key не настроен:

* text search продолжает работать;
* vector mode сообщает о недоступности;
* hybrid mode деградирует до lexical search с явным предупреждением.

ANN-запросы проверяются через `EXPLAIN FULL`, чтобы integration-тест
подтверждал реальное использование HNSW, а не brute-force.

> Примечание по реализации (2026-07-25): грамматика HNSW в SurrealDB 3.2.3
> не поддерживает partial-index `WHERE`, поэтому фильтры §14 применяются
> после ANN при гидратации `search_document`. Чтобы фильтр по редкому
> harness/workspace/model не давал ложный пустой результат, при активных
> фильтрах выполняется over-fetch: ANN запрашивает
> `min(max(K×4, 200), 1000)` кандидатов (EF = max(200, K)), затем
> post-filter и slice до K. Diversification: не более 3 hits на dialogue.

---

# 15. Миграция legacy SQLite

## 15.1. Принцип

Фраза «тем же кодом» означает:

```text
LiveSourceAdapter ─────┐
                      ├─→ Canonical DTO → Validator → SurrealDB writer
LegacySQLiteAdapter ──┘
```

Legacy SQLite не обязан имитировать файловый scanner. Общими являются:

* canonical DTO;
* normalizer;
* model resolver;
* usage normalizer;
* dialogue identity resolver;
* SurrealDB writer;
* search-document extractor;
* validation;
* deduplication.

## 15.2. Preflight migration report

До импорта создаётся отчёт:

```text
legacy source files
legacy raw backups
legacy dialogues
legacy messages
legacy chunks
thread_records rows
payload present
payload missing
valid JSON payload
invalid JSON payload
reconstructable from raw
reconstructable from payload
reconstructable only from normalized tables
deleted_in_source
missing raw backup
potential duplicates
```

Отдельно проверяется, действительно ли `thread_records.payload` покрывает
все диалоги.

Команда:

```text
baka migration plan --legacy-db "/Volumes/Archive/Legacy Conversations/index.sqlite"
```

План не изменяет SurrealDB.

## 15.3. Snapshot legacy SQLite

Даже если старая база больше не обновляется, importer работает не с
оригиналом, а с консистентной snapshot-копией:

```text
legacy index.sqlite
    ↓ SQLite backup
migration-input/index__<sha256>.sqlite
```

Оригинал остаётся нетронутым.

## 15.4. Приоритет источников восстановления

Для каждой legacy-записи:

1. raw backup — предпочтительно;
2. `thread_records.payload`;
3. старые `messages` и `message_chunks`;
4. quarantine, если восстановление невозможно.

Raw backup пропускается через тот же harness parser, что live source.

## 15.5. Mapping

| Legacy                     | Новая модель                          |
| -------------------------- | ------------------------------------- |
| `agent_systems`            | `harness`                             |
| installation/path metadata | `harness_installation`, `source_root` |
| `projects`                 | `workspace`, `workspace_location`     |
| `source_files`             | `source_location`                     |
| `raw_backups`              | `source_revision` + raw file          |
| `threads`                  | `dialogue`                            |
| parsed version             | `dialogue_revision`                   |
| `messages`                 | `message`                             |
| `message_chunks`           | `chunk`                               |
| payload usage              | `message.usage`, `raw_usage_events`   |

## 15.6. Host mapping

Legacy-записи нельзя объединять по одному OS username.

Правила:

1. Если original path однозначно принадлежит текущему host — использовать текущий host.
2. Если legacy metadata содержит идентификатор машины — создать соответствующий host.
3. Иначе создать:

   ```text
   host:legacy-<stable-fingerprint>
   ```
4. Записать uncertainty в migration report.
5. Не объединять неизвестные host автоматически.

## 15.7. Deduplication

Автоматический merge выполняется только по надёжным ключам:

1. одинаковые `harness_installation + external_id`;
2. одинаковый source revision SHA и source dialogue ID;
3. заранее сохранённый legacy identity mapping.

Canonical content fingerprint используется только для отчёта о возможных
дублях, а не для автоматического merge.

## 15.8. Deleted legacy entries

Все ранее удалённые записи импортируются:

```text
source_location.presence_status = deleted_in_source
```

Raw и canonical данные сохраняются.

Если raw backup отсутствует:

```text
source_revision.raw_archive_path = NONE
source_revision.snapshot_kind = legacy_missing_raw
```

Canonical данные всё равно импортируются, а отсутствие raw фиксируется в
migration report.

## 15.9. Quarantine вместо skip

Каждая исходная строка должна попасть ровно в одну категорию:

```text
source records
=
matched existing
+ inserted
+ quarantined
```

Категории `skipped` нет.

Целевое состояние:

```text
quarantined = 0
```

Если это невозможно, каждая quarantined record имеет:

* исходный primary key;
* raw payload;
* причину;
* parser version;
* возможность повторного запуска после исправления.

## 15.10. Идемпотентность

Повторный:

```text
baka migration run
```

не создаёт:

* новых dialogue duplicates;
* повторных source revisions;
* повторных messages;
* повторных chunks;
* повторных embedding jobs.

Каждый migration run сохраняет собственный reconciliation report.

---

# 16. Backup и восстановление

archive volume — переносимое хранилище, но не backup. Поломка одного диска может
одновременно уничтожить:

* RocksDB;
* raw archive;
* legacy SQLite;
* local backups на том же диске.

## 16.1. Logical backup

SurrealDB поддерживает logical export в SurrealQL и последующий import. Это
основной переносимый backup-формат.

```text
backups/surreal/
  2026-07-24T120000Z__schema-4__surreal-3.2.3.surql.zst
```

Рядом manifest:

```json
{
  "createdAt": "...",
  "surrealdbVersion": "3.2.3",
  "schemaVersion": 4,
  "bakaCommit": "...",
  "namespace": "baka",
  "database": "archive",
  "recordCounts": {},
  "rawManifestSha256": "...",
  "exportSha256": "..."
}
```

## 16.2. Raw manifest

Для каждого raw-файла:

```text
relative archive path
sha256
size
harness
source revision ID
```

Команда:

```text
baka raw:verify
```

проверяет фактические файлы против manifest и SurrealDB.

## 16.3. Off-device backup

Минимум одна копия должна находиться на другом физическом устройстве.

В backup входят:

* logical Surreal export;
* raw files;
* raw manifest;
* `.baka-archive.json`;
* schema migrations;
* migration reports.

RocksDB physical copy не считается единственным backup.

## 16.4. Restore drill

```text
bun run db:restore:test
```

Действия:

1. поднять временный пустой SurrealDB;
2. применить schema;
3. импортировать последний export;
4. проверить record counts;
5. проверить referential invariants;
6. выполнить несколько известных search queries;
7. проверить raw references;
8. удалить test instance.

Restore test должен выполняться до удаления legacy SQLite.

## 16.5. Шифрование

Так как архив содержит приватный код, пути, промпты и ответы, предпочтительный
формат Mac-only диска:

```text
APFS Encrypted
```

Credentials SurrealDB не заменяют шифрование физического носителя.

---

# 17. CLI

Основные команды:

```text
baka discover
baka sync
baka status
baka validate
baka search <query>
baka export-thread <dialogue-id>
baka reparse
baka doctor
```

## 17.1. `baka sync`

По умолчанию:

* выполняет structured sync;
* создаёт embedding jobs;
* не вызывает OpenAI;
* не удаляет canonical данные;
* не изменяет legacy SQLite.

Опции:

```text
--harness
--source-root
--full-rescan
--deletion-confirmations
--no-enqueue-embeddings
--dry-run
--json
```

## 17.2. `baka status`

Показывает:

```text
hosts
OS accounts
harness installations
source roots
active/missing/deleted locations
source revisions
parse errors
dialogues/current revisions
messages/chunks
search documents
embedding spaces
pending/retryable/permanent jobs
raw size
RocksDB size
last complete sync
last backup
last successful restore test
migration reconciliation
```

## 17.3. `baka validate`

Проверяет:

* отсутствующие raw files;
* hash mismatch;
* orphan raw files;
* source revision без raw;
* dialogue без current revision;
* current revision не в статусе `ready`;
* duplicate identity keys;
* message sequence collisions;
* chunk sequence collisions;
* search document не из current revision;
* embedding dimension mismatch;
* completed job без vector;
* vector без completed job;
* unknown schema version;
* unresolved migration quarantine.

## 17.4. `baka doctor`

Дополнительно умеет исправлять безопасные состояния:

```text
--import-orphan-raw
--remove-stale-staging
--requeue-stuck-embeddings
--rebuild-search-projection
--recalculate-primary-models
--repair-manifest
```

Любое destructive исправление требует явного флага.

---

# 18. Структура TypeScript-кода

```text
src/
├── cli/
│   ├── commands/
│   └── output/
├── config/
├── domain/
│   ├── canonical-types.ts
│   ├── enums.ts
│   └── identity.ts
├── db/
│   ├── client.ts
│   ├── transactions.ts
│   ├── repositories/
│   └── migrations.ts
├── sources/
│   ├── discovery/
│   ├── scanning/
│   ├── snapshot/
│   └── adapters/
├── parsers/
│   ├── codex/
│   ├── claude-code/
│   ├── claude-desktop/
│   ├── opencode/
│   ├── cursor/
│   ├── qwen-code/
│   └── kimi-code/
├── sync/
│   ├── sync-run.ts
│   ├── location-reconciler.ts
│   ├── revision-ingestor.ts
│   └── deletion-detector.ts
├── search/
│   ├── extractors/
│   ├── segmenter.ts
│   ├── fulltext.ts
│   └── hybrid.ts
├── embeddings/
│   ├── provider.ts
│   ├── openai-provider.ts
│   ├── jobs.ts
│   └── spaces.ts
├── migration/
│   ├── legacy-sqlite-adapter.ts
│   ├── reconciliation.ts
│   └── reports.ts
├── backup/
└── validation/
```

## 18.1. Что переиспользуется

Можно переиспользовать концептуально (из legacy-проекта
`/path/to/legacy-project`):

* hashing;
* часть file discovery;
* harness-specific parsing;
* current CLI UX;
* export formatting.

Но `scanner.ts` не остаётся неизменным: он должен возвращать статус полноты
scan и поддерживать stable snapshots.

## 18.2. Что заменяется

Полностью заменяются:

* SQLite repositories;
* SQLite schema;
* `staging-db.ts`;
* SQLite-specific sync transaction logic;
* old search implementation;
* path mirroring в raw.

Вместо staging DB используется:

```text
filesystem staging + SurrealDB transactions
```

---

# 19. Тестирование

## 19.1. Уровни тестов

### Unit tests

Без SurrealDB:

* path normalization;
* flat raw naming;
* hash;
* identity keys;
* parser fixtures;
* usage normalization;
* model normalization;
* final-answer extraction;
* segmentation;
* rename candidate selection;
* migration reconciliation calculations.

### Fast integration tests

Поднимается pinned SurrealDB binary:

```text
surreal start memory
```

Версия бинарника должна совпадать с Docker image.

### Production smoke tests

Используется тот же Docker image, compose и RocksDB backend, что в реальном архиве.

## 19.2. Обязательные сценарии

1. Второй идентичный sync не создаёт новых записей.
2. Недоступный source root не помечает файлы missing/deleted.
3. Partial scan не помечает непрочитанные файлы удалёнными.
4. После первого полного отсутствия location становится `missing`.
5. После подтверждения становится `deleted_in_source`.
6. Повторное появление возвращает `active`.
7. Rename и duplicate copy различаются.
8. Изменившийся файл создаёт новую source revision.
9. Укоротившийся файл не оставляет stale messages в current revision.
10. Parse error новой revision не меняет current revision.
11. Неизвестный event сохраняется как `unknown`.
12. Сбой после raw rename, но до DB commit обнаруживается `doctor`.
13. Активная SQLite WAL-база импортируется из консистентного snapshot.
14. Файл, изменившийся во время копирования, snapshot’ится повторно.
15. Два ноутбука с username `example` создают разные `os_account`.
16. Один external dialogue ID на разных host не мержится.
17. Tool call корректно связывается с tool result.
18. Cumulative usage не суммируется повторно.
19. Cached/reasoning tokens не double-counted.
20. Финальный ответ из нескольких chunks извлекается полностью.
21. OpenAI API failure не делает structured sync неуспешным.
22. Stuck embedding job возвращается в pending после lease timeout.
23. Vector неправильной dimension отклоняется.
24. ANN query использует HNSW по `EXPLAIN FULL`.
25. Legacy import можно запустить повторно без дублей.
26. Каждая legacy row попадает в matched/inserted/quarantined.
27. Logical export восстанавливается в пустую базу.
28. Raw manifest совпадает с файловой системой.
29. Конкурентный второй `sync` блокируется lock-файлом.
30. Два файла с одинаковым basename и разными hash не перезаписываются.

---

# 20. Порядок реализации

## Этап 0. Зафиксировать стартовое состояние

Работы:

1. Создать `.gitignore`.
2. Исключить:

   ```text
   index.sqlite
   db-backups/
   raw/
   logs/
   exports/
   .env
   ```
3. Подготовить репозиторий документации (этот план, README, AGENTS.md).
4. Добавить обезличенные golden fixtures (по мере появления parser'ов).
5. Создать tag стартового состояния:

   ```text
   docs-baseline
   ```

Критерий завершения:

* документация восстанавливается из Git;
* приватные archive files не попали в repository.

## Этап 1. Инфраструктура

Работы:

* compose;
* `.env.example`;
* credentials;
* bind mount;
* sentinel;
* preflight;
* readiness;
* `db:up/down/status`;
* process lock;
* graceful shutdown.

Критерий:

* SurrealDB 3.2.3 запускается;
* данные действительно создаются на archive volume;
* после restart записи сохраняются;
* запуск без archive volume блокируется.

## Этап 2. Schema migrations

Работы:

* identity tables;
* source provenance;
* canonical corpus;
* search projection;
* embedding metadata;
* indexes;
* migration runner.

Критерий:

* пустая база создаётся;
* повторное применение migrations идемпотентно;
* schema tests зелёные.

## Этап 3. Source snapshot layer

Работы:

* complete/partial scan;
* staging;
* full hash;
* flat raw naming;
* atomic rename;
* consistent SQLite backup;
* orphan detection;
* deletion state machine.

Критерий:

* raw snapshots неизменяемы;
* rename/copy/delete/reappear tests зелёные;
* обычный filesystem copy живой SQLite не используется.

## Этап 4. Canonical parser contract

Работы:

* общие DTO;
* parser versions;
* raw event preservation;
* model normalization;
* usage normalization;
* harness-specific final answer extractors;
* golden fixtures.

Критерий:

* все семь harness’ов проходят fixtures;
* неизвестные события не теряются;
* usage не double-counted.

## Этап 5. SurrealDB writer и structured sync

Работы:

* repositories;
* dialogue transactions;
* immutable dialogue revisions;
* current pointers;
* quarantine;
* status;
* validation.

Embeddings ещё не вызываются.

Критерий:

* реальный live sync проходит по всем harness’ам;
* повторный sync идемпотентен;
* parse error сохраняет last known-good revision;
* старый SQLite не изменяется.

## Этап 6. Search documents и full-text

Работы:

* `user_prompt`;
* `assistant_final`;
* segmentation;
* analyzer;
* BM25 indexes;
* text search;
* forensic search.

Критерий:

* известные фразы находятся;
* фильтры работают;
* старые ревизии не загрязняют обычную выдачу;
* reasoning доступен только через forensic mode.

## Этап 7. Embedding pipeline

Работы:

* embedding spaces;
* jobs;
* OpenAI provider;
* retry/backoff;
* vector tables;
* HNSW;
* vector search;
* hybrid RRF.

Сначала небольшой pilot.

Критерий:

* network/API failure не ломает sync;
* jobs идемпотентны;
* dimensions проверяются;
* HNSW реально используется;
* hybrid search выдаёт разумные результаты.

## Этап 8. Live acceptance

На актуальных живых источниках:

1. очистить только новую test-базу;
2. выполнить полный live sync;
3. проверить все harness’ы;
4. выполнить повторный sync;
5. протестировать rename/delete/reappear;
6. протестировать parse failure;
7. выполнить text/vector/hybrid queries;
8. создать logical backup;
9. выполнить test restore.

До успешного завершения этого этапа legacy import не запускается.

## Этап 9. Migration preflight

Работы:

* snapshot `index.sqlite`;
* coverage report;
* raw backup inventory;
* payload validation;
* host mapping;
* duplicate report;
* dry-run reconciliation.

Критерий:

```text
legacy total =
  reconstructable
  + quarantined
```

Каждая проблема имеет конкретный record ID.

## Этап 10. Миграция истории

Работы:

* импорт raw;
* импорт source provenance;
* импорт dialogues;
* дедупликация с live corpus;
* импорт ранее удалённых записей;
* quarantine;
* повторный идемпотентный run;
* reconciliation.

Критерий:

```text
source rows =
matched + inserted + quarantined
```

Цель:

```text
quarantined = 0
```

Число диалогов точно объясняется migration report.

## Этап 11. Полный embeddings backfill

Работы:

1. выбрать embedding space по relevance evaluation;
2. выполнить точный token count;
3. показать объём и стоимость;
4. запустить backfill;
5. повторить failed jobs;
6. проверить index;
7. выполнить hybrid relevance evaluation.

Критерий:

* все eligible documents имеют completed vector либо документированную permanent error;
* отсутствуют vectors неправильной dimension;
* search quality принята на реальных запросах.

## Этап 12. Backup/restore и окончательный cutover

Работы:

* final logical export;
* raw manifest;
* off-device backup;
* restore drill;
* final validation;
* удалить migration adapter из основной ветки;
* создать tag:

  ```text
  surrealdb-cutover
  ```

Legacy-файлы остаются на диске без изменений.

Их физическое удаление выполняется пользователем отдельно после периода
эксплуатации новой системы.

---

# 21. Проверка качества поиска

До выбора final embedding space создаётся набор из 50–100 реальных запросов:

```text
query
expected dialogues
expected snippets
must-not-match examples
query language
query type
```

Типы запросов:

* точная фраза;
* русская морфология;
* английская техническая формулировка;
* имя функции;
* модель;
* путь;
* semantic paraphrase;
* смешанный русский/английский;
* кодовая ошибка;
* старый удалённый диалог.

Метрики:

```text
Recall@5
Recall@10
MRR
nDCG@10
доля нерелевантных top-5
время запроса
размер vector index
пиковая RAM
время index build
```

Сравниваются:

```text
BM25 only
text-embedding-3-small / 1536
text-embedding-3-large / 1024
text-embedding-3-large / 3072
hybrid BM25 + each vector space
```

Решение принимается на основании собственного корпуса, а не общего benchmark.

---

# 22. Observability

Все операции используют structured logs:

```json
{
  "level": "info",
  "event": "source_revision_parsed",
  "syncRunId": "...",
  "sourceRevisionId": "...",
  "harness": "codex",
  "dialogues": 1,
  "messages": 42,
  "chunks": 137,
  "durationMs": 218
}
```

По умолчанию не логируются:

* полный prompt;
* полный assistant response;
* tool result;
* OpenAI API key;
* raw payload;
* DB password.

Каждый run получает ID, по которому можно связать:

* console output;
* logs;
* `sync_run`;
* `source_scan`;
* `ingest_error`;
* migration report.

---

# 23. Ключевые инварианты

Система считается корректной только при соблюдении следующих правил:

1. Raw snapshot после создания никогда не изменяется.
2. `source_revision.sha256` соответствует raw-файлу.
3. `source_location.last_successful_revision` указывает только на успешно распарсенную revision.
4. Ошибка новой revision не разрушает предыдущую.
5. `dialogue.current_revision` указывает только на `ready`.
6. Все message принадлежат конкретной dialogue revision.
7. Все chunk принадлежат конкретному message и revision.
8. Удаление исходника не удаляет raw или canonical data.
9. Недоступный root не вызывает массовый `deleted_in_source`.
10. Search projection содержит только текущие revisions.
11. Embedding vector всегда соответствует content hash и embedding space.
12. Pending/error jobs не находятся в vector table.
13. В одной vector table находится только одно embedding space.
14. Cached и reasoning tokens не double-counted.
15. Ни одна migration row не теряется без quarantine.
16. Повторный sync и migration идемпотентны.
17. Archive может быть восстановлен из logical export + raw backup.
18. Работа structured sync не зависит от OpenAI.

---

# 24. Definition of Done

Проект завершён, когда одновременно выполняются все условия:

### Инфраструктура

* SurrealDB 3.2.3 pinned tag + digest.
* JS SDK pinned.
* Bind mount действительно расположен на archive volume.
* Запуск без sentinel блокируется.
* API доступен только через loopback.
* `db:up/down/status/preflight` работают.
* `disk:eject` корректно останавливает БД.

### Данные

* Все семь harness’ов синхронизируются.
* Live sync идемпотентен.
* Raw snapshots плоские, immutable и hash-addressed.
* Активные SQLite-источники snapshot’ятся консистентно.
* Старые dialogue revisions сохраняются.
* Удалённые источники не приводят к потере архива.
* Два ноутбука с одинаковым username различаются.

### Поиск

* Full-text находит известные точные фразы.
* Semantic search находит релевантные paraphrases.
* Hybrid search объединяет rankings.
* Reasoning/tool content не эмбеддится.
* Длинные ответы сегментируются без обрезки.
* HNSW подтверждён через query plan.

### Миграция

* Все legacy rows учтены.
* Все ранее удалённые entries сохранены.
* Повторная миграция не создаёт дублей.
* Quarantine либо пуст, либо полностью документирован.
* Старые диалоги, отсутствующие в live sources, находятся через search.

### Надёжность

* Logical export создан.
* Test restore успешен.
* Raw manifest проверен.
* Есть off-device backup.
* `baka validate` не показывает критических ошибок.
* Legacy SQLite не удалён автоматически.
* External System и `other-project` не изменены.

---

## Итоговая формула архитектуры

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

Главное отличие этой версии от исходного плана: SurrealDB больше не
рассматривается как место, куда нужно напрямую переложить прежние таблицы
SQLite. Она становится индексом и канонической моделью поверх неизменяемого
raw-архива, причём provenance, содержимое и поисковые представления имеют
независимые жизненные циклы. Это обеспечивает безопасную повторную обработку,
миграцию без тихих потерь, смену embedding-модели, восстановление после сбоев
и корректную работу архива на нескольких ноутбуках.

## Ссылки

* [SurrealDB Release 3.2](https://surrealdb.com/releases/3.2)
* [SurrealDB performance best practices](https://surrealdb.com/docs/learn/querying/performance/performance-best-practices)
* [SQLite Write-Ahead Logging](https://sqlite.org/wal.html)
* [SurrealDB transactions](https://surrealdb.com/docs/reference/query-language/language-primitives/transactions)
* [SurrealDB DEFINE ANALYZER](https://surrealdb.com/docs/reference/query-language/statements/define/analyzer)
* [SurrealDB DEFINE INDEX](https://surrealdb.com/docs/reference/query-language/statements/define/indexes)
* [OpenAI vector embeddings](https://developers.openai.com/api/docs/guides/embeddings)
* [SurrealDB vector indexes](https://surrealdb.com/docs/learn/data-models/vector-search/vector-indexes)
* [SurrealDB hybrid search](https://surrealdb.com/docs/learn/data-models/vector-search/hybrid-search)
* [SurrealDB backups & recovery](https://surrealdb.com/docs/manage/self-hosted/backups-and-recovery)
* [Kimi Code data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
* [Kimi Code sessions and context](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
