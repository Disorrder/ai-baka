# План перевода архива AI-диалогов `baka` с SQLite на SurrealDB

**Статус:** целевая версия плана; implementation/CLI этапов 0–12 —
**CODE COMPLETE**, внешние операторские gates этапов 9–12 — открыты
**Дата фиксации:** 24 июля 2026 года; статус обновлён 26 июля 2026 года
**Проект:** `/path/to/ai-baka` (новый репозиторий, строится с нуля)
**Основано на опыте:** legacy-проект `/path/to/legacy-project`

Ниже собрана цельная редакция исходного плана с учётом архитектурного ревью
и технических поправок. Сохраняются главные исходные решения: отдельный
SurrealDB, полная изоляция от External System, сначала проверка на живых
источниках, затем импорт истории, отсутствие dual-write и сохранение старого
SQLite-архива нетронутым до ручного удаления.

Бизнес-решения, архитектурные подходы и причины их изменения — в [ADR](adr/index.md),
соглашения по документации — в [AGENTS.md](../AGENTS.md#документация).

`CODE COMPLETE` ниже означает готовность реализационных и fail-closed CLI
контрактов, а не завершение боевой операции. До отдельного подтверждения
оператора не считаются выполненными: live migration, платная relevance
evaluation и полный embeddings backfill, физическая off-device provenance,
restore точного bundle, финальные `validate`/cutover/tag, удаление migration
adapter и физическое удаление legacy. Legacy SQLite всегда read-only;
автоматического удаления нет.

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

Состояние legacy-архива определяется перед импортом:

Размер snapshot, количество диалогов, сообщений и удалённых записей
определяются свежим preflight. Эти показатели хранятся только в приватном
отчёте; `expectedDeletedCount` берётся из подписанного evidence.

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
3. Хранить mutable физические данные SurrealDB в effective internal
   `BAKA_DB_ROOT`; archive volume остаётся архивом raw/manifests/backups.
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

## 3.2. Используется SurrealDB 3.2.4

На 9 сентября 2026 года закреплён стабильный [SurrealDB 3.2.4](https://github.com/surrealdb/surrealdb/releases/tag/v3.2.4).
Docker image фиксируется тегом и digest
`sha256:51baed8709f57f67dcf04b30e3177db846803fa9342dae2be58c6fa5f8d59843`.
Обновление pin в исходниках не означает обновления или приёмки production.

Фиксируются вместе:

```text
SurrealDB server: surrealdb/surrealdb:v3.2.4@sha256:...
SurrealDB JS SDK: точная версия в bun.lock
Schema version: целое число
baka git commit: commit SHA
```

Обновление production SurrealDB выполняется только после:

1. logical backup;
2. тестового restore;
3. прогона integration-тестов;
4. smoke-теста на копии RocksDB.

При смене exact pin прежнее restore evidence не принимается как доказательство
проверки нового образа. Для 3.2.4 сохраняется bounded resource profile ниже;
полный Docker restore и приёмка боевого архива выполняются отдельно.
Зависимости инструментов: TypeScript 7.0.2, `@types/bun` 1.4.2 и tiktoken 0.14.0.
Изменение tokenizer identity требует новых exact-token отчётов и связанных планов.

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
# BAKA_DB_ROOT=/absolute/internal/APFS/path
```

`BAKA_DB_ROOT` — optional override. Без него effective live dbRoot равен
`${HOME}/Library/Application Support/ai-baka/rocksdb` на внутреннем диске.
`BAKA_ARCHIVE_ROOT` не зашивается в compose или TypeScript-код; override DB
также всегда задаётся явно.

Рекомендуемая структура:

```text
Conversations/
├── .baka-archive.json
├── db/                             # старый/corrupt store; не runtime fallback
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
├── migration-input/                 # read-only input pending legacy import
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
| Image            | `surrealdb/surrealdb:v3.2.4@sha256:...` |
| Host binding     | `127.0.0.1:8901`                        |
| Container port   | `8000`                                  |
| Storage          | RocksDB                                 |
| Container path   | `/data/db`                              |
| Host path        | effective internal `BAKA_DB_ROOT`; default `${HOME}/Library/Application Support/ai-baka/rocksdb` |
| Namespace        | `baka`                                  |
| Database         | `archive`                               |
| HTTP `/import`   | `34359738368` bytes (32 GiB, bounded)   |
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
SURREAL_HTTP_MAX_IMPORT_BODY_SIZE=34359738368
```

`SURREAL_HTTP_MAX_IMPORT_BODY_SIZE` — целое число байт, которое compose
передаёт с bounded default 32 GiB. Лимит ограничивает размер import-тела
и не отключает server-side проверку. Это допустимо только при loopback
binding и обязательной аутентификации `/import`; повышать значение можно
лишь после проверки exact SHA/size аутентифицированного backup и измерения
его фактического распакованного/reordered тела.

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

Для релиза приложения **0.1.0** задана одна начальная миграция и числовая
версия схемы **1**:

```text
schema/
└── 0001_initial.surql
```

Файл сразу создаёт полный актуальный набор таблиц, полей и индексов:
canonical corpus, search projection, embedding spaces/jobs, durable legacy
import/quarantine, `content_chars`, response timing и Codex lineage.
`source_revision.raw_archive_path = NONE` допускается только для намеренного
`snapshot_kind = legacy_missing_raw`. Глобальный FULLTEXT `chunk_content`
не создаётся; canonical chunks и historical revisions сохраняются.

Новые numbered migrations добавляются только при переходе на последующие
релизы. После публикации применённые файлы не редактируются.
Версия приложения, версия схемы и `formatVersion` файлов/отчётов — разные
контракты; свёртка схемы не меняет форматы отчётов.

Дорелизная история миграций `0001`–`0009` свёрнута, не является поддерживаемой
цепочкой обновления и несовместима по номерам/checksum с этой начальной схемой.
Существующие БД и backup artifacts не перенумеровываются автоматически.
Для переноса такого архива требуется отдельная явно согласованная процедура;
удалять `schema_migration`, подменять checksum или очищать рабочую БД нельзя.

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

По явной команде `baka db migrate` приложение:

1. читает текущую schema version;
2. проверяет checksums уже применённых migrations;
3. применяет недостающие migrations последовательно;
4. отказывается работать при неизвестной более новой версии;
5. не изменяет схему неявно.

Проверяются создание пустой базы, повторный запуск без изменений и отказ
при несовпадении checksum или неизвестной версии. При появлении следующего
релиза проверяется также обновление с поддерживаемой предыдущей версии.

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
| `parent_source_dialogue_id` | parent thread ID для Codex subagent |
| `agent_depth`        | глубина Codex subagent            |
| `agent_nickname`     | nickname Codex subagent           |
| `agent_role`         | роль Codex subagent               |

Старая ревизия остаётся в базе. `dialogue.current_revision` переключается
только после полного успешного сохранения новой ревизии.

Codex lineage-поля — производный backfillable cache из первичного
`session_meta` immutable raw snapshot. Они нужны для точной дедупликации
унаследованного `last_token_usage` prefix: собственный suffix subagent
остаётся отдельной работой и не вычитается.

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
| `content_chars`     | cached число символов всех chunks сообщения   |
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
cache_write_input_tokens
output_tokens
reasoning_output_tokens
total_tokens_reported
total_tokens_normalized
is_estimated
source
normalization_version
```

Правила:

* cache read и cache write не прибавляются повторно к input;
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
| `content_chars`        | число символов                           |
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

Отдельный logical `user_prompt` строится для **каждого** user message текущей
ревизии, если оно действительно создано человеком. В него входят текстовые
chunks этого message, которые:

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


Повторный sync хранит наблюдённое состояние **исходника** отдельно от raw:
`<dirname(BAKA_DB_ROOT)>/sync-cache/<sha256>.json` — удаляемый локальный
кэш, не часть canonical corpus или backup. Ключ файла включает archive root,
URL/namespace/database; запись привязана к location, текущей revision,
parse status и версиям parser/extractor/segmenter. Файл публикуется атомарно
под sync lock после capture-фазы и после обработки каждого source root.
Перед parse сохраняется только доказательство capture со статусом `pending`,
не отметка успешного разбора. Поэтому прерывание во время повторного parse
текущей revision не теряет уже проверенный raw. Для новой revision, которая
ещё не стала current, после прерывания возможен повторный capture.
Dry-run кэш не изменяет. Потеря/повреждение кэша означает холодную проверку,
не потерю данных. Ошибка сохранения логируется.

Fingerprint включает dev/inode, size/mtime/ctime и первые 64 КиБ исходника;
для SQLite — также состояние и полный SHA-256 WAL. Активный rollback journal,
ошибка чтения или изменение во время наблюдения запрещают reuse. Snapshot
получает наблюдение только при совпадении состояний до и после capture.
Размер/head hash результата `VACUUM INTO` больше не служат доказательством
неизменности исходной SQLite. Без валидного наблюдения SQLite переснимается.
Старые метаданные immutable revision не переписываются при прежнем SHA.
Если capture observation привязан к текущей revision и fingerprint исходника
совпал, `partial`/`parse_error`/`pending` или смена pipeline требуют только
parse из существующего immutable raw, без нового копирования/`VACUUM INTO`.
Raw должен существовать и иметь сохранённый размер; иначе выполняется capture.
Статус успешной обработки проверяется отдельно: неуспешный parse нельзя
превратить в «unchanged» и пропустить. Поле `source_revision.parser_version`
остаётся provenance первоначального capture, а не версией последнего parse.
При наличии capture observation reconciler не читает head hash второй раз:
решение принимает последующая полная проверка source fingerprint с WAL/race guards.

Повторный parse пропускается только для уже обработанной текущей file revision
с прежним pipeline; исторический SHA, partial/parse_error/pending и session
parse-view не обходятся. Неподдерживаемый неизменный файл не разбирается снова,
но существующий quarantine не закрывается этим пропуском. Presence updates
группируются по одинаковым переходам, максимум 250 locations на запрос,
с прежними правилами complete/partial scan и reappearance.

Поиск дублей Codex/Orca сначала строит индекс dev/inode/size/mtime/ctime
нативных файлов. Два стабильных пути к одному inode — одни и те же байты:
проверяются stat обоих путей, без чтения содержимого. Только при встрече
копии с другим inode лениво строится полный SHA-индекс с проверкой состояния
нативного файла до и после хеширования. Изменение после первоначального
индекса запрещает dedup по этому наблюдению. Межзапускового кэша SHA нет.
Журнал `source_duplicate_filter` содержит `fullHashes`/`bytesHashed`;
`source_duplicate_index.physicalFiles` — число уникальных физических состояний.

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

Текущие зарегистрированные версии parser: 2 для исходных семи harness'ов,
1 для OMP;
`EXTRACTOR_VERSION = 3`: каждый извлечённый реальный user message задаёт
отдельный turn-window и получает собственный `assistant_final`, если в этом
turn есть видимый ответ ассистента.

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

## 12.1. Основной индекс и canonical forensic data

### Обычный поиск

Работает по `search_document`:

* пользовательские промпты;
* финальные ответы;
* только текущие dialogue revisions.

Canonical `chunk` по-прежнему хранит reasoning, tool results, system context и
все historical dialogue revisions. Однако глобальный FULLTEXT по каждой
физической `chunk`-записи не является частью production search: он индексирует
также historical revisions, не нужные обычному поиску, и усложняет восстановление.

Legacy-флаги `--include-reasoning`, `--include-tools`, `--include-system` и
`--all-revisions` сохранены только как fail-closed CLI compatibility contract:
они возвращают понятную ошибку **до DB query** и никогда не деградируют в
полный scan таблицы `chunk`. Для точечного forensic-разбора используется
`export-thread`; если полнотекстовый forensic снова понадобится, он должен
быть отдельной ограниченной derived projection с собственным lifecycle, а не
индексом canonical `chunk`.

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
```

Начальная схема создаёт только `search_document_content`. Глобальный
`chunk_content` не создаётся: canonical chunks и historical revisions
сохраняются без производного forensic FULLTEXT-индекса.

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
Текущая `segmentation_version = "2"`; изменение алгоритма требует bump.

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

Library worker:

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

Generic CLI entrypoint намеренно закрыт:

```text
baka embeddings run --limit <1..64> --space <slug> --allow-paid-api
```

Это fail-closed compatibility stub: даже с указанными flags он не вызывает
provider, потому что не имеет Stage 11 authorization. Платные вызовы доступны
только через bounded candidate и accepted-production workflows:

```text
baka embeddings plan
baka embeddings exact-tokens --model <name> --report <private.json>
baka embeddings candidates plan --judgments <path> --spaces <three-csv> \
  --max-documents <1..1000> --max-jobs-per-space <1..200> \
  --selection-seed-sha256 <sha256> --report <private.json>
baka embeddings candidates run --plan <path> --judgments <same-path> \
  --confirm <exact-phrase> --allow-paid-api
baka embeddings backfill plan --space <slug> --exact-report <path> \
  --accepted-relevance <path> --max-jobs <n>
baka embeddings backfill run --space <slug> --exact-report <path> \
  --accepted-relevance <same-path> --confirm <exact-phrase> --max-jobs <n> \
  --allow-paid-api
baka embeddings audit --space <slug>
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

`exact-tokens` запускает pinned `uv` script только offline, сверяет identity
script/package и сохраняет private report без неявного overwrite. Цена не
зашита в код: используется только
`OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS`; без неё стоимость не угадывается.
Candidate plan ограничен 1000 documents и 200 jobs на space, причём jobs не
больше documents; provider batch — не более 64. Каждый paid run требует exact
plan/corpus/privacy hashes, literal confirmation и `--allow-paid-api`.

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
--deleted-only
```

Legacy forensic flags перечислены в §12.1 и намеренно fail closed; они не
являются фильтрами normal/vector/hybrid search.

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

Отдельно проверяется coverage всех `thread_records.payload` и reconciliation
по каждой legacy table. Runtime-критерий — полная сверка со свежим preflight,
а не опубликованное историческое число.

Команда:

```text
baka migration plan [--legacy-db <read-only-index.sqlite>] [--report <private.json>] \
  [--skip-live] [--json]
```

План не изменяет SurrealDB и legacy, но создаёт в новом archive
content-addressed snapshot, analysis checkpoint и private report. Для
production approval `--skip-live` недопустим: live duplicate probe должен быть
свежим и доступным.

## 15.3. Snapshot legacy SQLite

Даже если старая база больше не обновляется, importer работает не с
оригиналом, а с консистентной snapshot-копией:

```text
legacy index.sqlite
    ↓ SQLite backup
migration-input/index__<sha256>.sqlite
```

Оригинал остаётся нетронутым. `migration-input` сохраняется только пока
legacy import и его reconciliation не приняты; это не долгоживущий
recovery artifact.

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

До writer оператор отдельно утверждает exact mapping artifact для всего
snapshot. Неполный, конфликтующий, изменённый или заново самоподписанный map
отклоняется; один OS username никогда не является достаточным host identity.

## 15.7. Deduplication

Автоматический merge выполняется только по надёжным ключам:

1. одинаковые `harness_installation + external_id`;
2. одинаковый source revision SHA и source dialogue ID;
3. заранее сохранённый legacy identity mapping.

Canonical content fingerprint используется только для отчёта о возможных
дублях, а не для автоматического merge.

## 15.8. Deleted legacy entries

Каждый production run берёт число ранее удалённых записей из свежего
подписанного `expectedDeletedCount` и заново сверяет snapshot/live evidence.

Все одобренные deleted records импортируются:

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
migration report. Пара `snapshot_kind = legacy_missing_raw` и
`raw_archive_path = NONE` намеренна; `NONE` при любом другом snapshot kind —
ошибка validation.

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

Документированные исключения ограничены двумя классами: active-original
legacy thread, для которого оператор запретил создавать canonical dialogue
и при этом нет exact существующего dialogue, и удалённый в источнике thread
без сообщений/chunks, который невозможно восстановить. Исходный
`migration_meta`, reconciliation
report и `migration_row_commit(category = "quarantined")` при этом **не
переписываются**: исторический результат остаётся
`completed_with_errors`, `lost = 0`, `accounted = legacyTotal`. Финальная
приёмка показывает отдельное состояние
`accepted_with_operator_exclusions`, а не выдаёт quarantine за canonical
успех или matched target.

Если это невозможно, каждая quarantined record имеет:

* исходный primary key;
* raw payload;
* причину;
* parser version;
* возможность повторного запуска после исправления.

`baka validate` проверяет unresolved rows именно в `migration_quarantine`
(и legacy migration `ingest_error`), а retry закрывает прежнюю запись durable
resolution, не удаляя audit trail.

### 15.9.1. Signed operator exclusions v1

Lifecycle выполняется отдельными командами:

```text
baka migration exclusions plan --legacy-db <read-only-index.sqlite> \
  --source-migration <migration_meta:id> --artifact <new-private.json> [--json]

baka migration exclusions apply --legacy-db <read-only-index.sqlite> \
  --artifact <exact-reviewed.json> \
  --exclusion-attestation <detached-ed25519-v1.json> \
  --approval-public-key <independently-configured-ed25519-spki.pem> \
  --approval-key-sha256 <lowercase-spki-der-sha256> \
  --report <private-no-clobber-report.json> --apply [--json]

baka migration exclusions status [--json]
```

`plan` аутентифицирует content-addressed legacy snapshot, exact report и
durable `completed_with_errors` source migration, затем заново выводит exact
row set из snapshot и живого corpus. Допустимы только machine codes:

* `active_original_without_exact_dialogue` — сам active-original thread без
  exact canonical dialogue;
* `deleted_original_unrecoverable_no_messages` — thread без messages/chunks,
  все связанные source rows которого аутентифицированно удалены;
* `canonical_child_of_excluded_active_thread` — его `messages` и
  `message_chunks`;
* `source_less_record_of_excluded_active_thread` — только его
  `thread_records.source_file_id IS NULL`.

`thread_record` с non-null `source_file_id` исключать нельзя: для обоих классов
его durable mapping обязан точно указывать на единственный `source_revision`
с source-location mapping этого source row и exact snapshot SHA; missing или
conflicting mapping оставляет thread unresolved. Несколько source rows одного
thread проверяются независимо, без синтетического общего mapping.
Причины quarantine и свободный текст никогда не выбирают строки. Artifact
содержит exact quarantine/migration/lineage identities, SHA причины и raw
payload, parser identity, attempts/last_failed_at, canonical row-set SHA и
semantic artifact SHA; неизвестные поля/codes и любое расхождение fail closed.

`apply` до writer'а проверяет detached Ed25519 по независимо закреплённому
fingerprint (ключ exclusion может отличаться от source-import signer),
отдельную аутентификацию source migration/report, свежий live re-derive,
schema **ровно 5**, process lock, archive containment новых artifacts и
no-clobber report. Source report читается по exact `migration_meta.report_path`
и связывается с сохранёнными path/SHA/size даже вне archiveRoot; snapshot и
новые exclusion artifacts остаются внутри archiveRoot. Записи идут детерминированными
optimistic batches не более 500 и изменяют у `migration_quarantine` только
`resolved_at`/`resolution`; canonical tables, identity map и исходный ledger
не меняются. Повтор после crash принимает только exact уже записанные
resolution/report и завершает тот же deterministic acceptance; другой retry
создаёт новую попытку или durable mapping. Все одновременно unresolved
попытки одного snapshot входят в exact signed set, а их source reports
аутентифицируются независимо; поэтому прежнее acceptance
становится `superseded`, а новая unresolved строка снова блокирует validate.

`status`, `validate` и `doctor` перепроверяют persisted artifact, подпись,
exact membership и source report bytes/binding. Удаление временного
content-addressed migration-input snapshot после приёмки не ломает эту
persisted проверку. Verified documented exclusions —
информация; unresolved, malformed/unknown resolution, missing/changed
artifact, forged signature или stale membership — ошибка. Поэтому final
diagnostics могут честно иметь `unresolved = 0` и одновременно показывать
ненулевое точное число документированных исключений без поддельных canonical
records или matched targets.

Backup+restore выполняется только один раз на финальной приёмке архива и не
является входом или промежуточным шагом exclusion plan/apply.

## 15.10. Authorization, запуск и идемпотентность

### CODE COMPLETE

`migration run` и `retry` имеют один строгий CLI contract:

```text
baka migration run|retry [--legacy-db <read-only-index.sqlite>] \
  --approval <exact-approved-preflight.json> \
  --attestation <detached-ed25519-attestation.json> \
  --host-mapping-approval <exact-host-map.json> \
  --restore-report <strict-restore-test-v4.json> \
  --approval-public-key <independently-configured-ed25519-spki.pem> \
  --approval-key-sha256 <lowercase-spki-der-sha256> \
  --report <new-exclusive-reconciliation.json> --apply [--json]

baka migration status [--json]
baka migration exclusions plan|apply|status ...
```

Writer не создаётся до проверки exact snapshot SHA/size, table totals,
problem set, deleted count, свежего live probe, полного host mapping,
detached signature и независимого key fingerprint, schema >= 5, нового
no-clobber report target и точного fresh backup/restore binding. Backup должен
быть создан после attestation, restore — после backup и не старше 24 часов.
Любой drift path/SHA/size/schema/namespace/database/time блокирует запуск.

Повторный run или retry:

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

### EXTERNAL OPERATOR GATES

CLI сознательно не создаёт approval, host-map approval и подпись. Оператор
вне принимаемого evidence независимо проверяет snapshot SHA/size, все table
totals/problems, live probe, `expectedDeletedCount`, assignments; затем
подписывает exact approval Ed25519 key, публичный SPKI и SHA которого приходят
по независимому trust channel.

После `approvedAt`/`issuedAt` обязательна последовательность:

```text
baka backup --json
baka restore:test <fresh-export> --raw-archive-root <archive-root> --json
baka migration run <все обязательные flags выше>
baka migration status --json
baka validate --json
```

Migration считается принятой только при `status=completed`, `lost=0`,
`quarantined=0`, `accounted=legacyTotal`, exact per-table accounting и полном
совпадении фактических assignments с approval. До этого migration adapter
нужен для retry/status/audit и не удаляется.

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
  2026-07-26T120000Z__schema-1__surreal-3.2.3.surql.zst
```

Связанный manifest хранится в `backups/manifests/`:

```json
{
  "createdAt": "...",
  "surrealdbVersion": "3.2.3",
  "schemaVersion": 1,
  "bakaCommit": "...",
  "namespace": "baka",
  "database": "archive",
  "recordCounts": {},
  "rawManifestSha256": "...",
  "exportSha256": "...",
  "exportBytes": 123,
  "compression": "zstd"
}
```

Export и manifest публикуются атомарно; incomplete `.part` не считается
backup. Status признаёт только полностью существующую пару с повторно
проверенными SHA/size и обязательным `rawManifestSha256` для schema 1.

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

CLI:

```text
baka backup off-device plan --destination <path> \
  [--export <path>]... [--raw-manifest <path>] \
  [--migration-report <path>]... [--json]
baka backup off-device run --destination <path> \
  [--export <path>]... [--raw-manifest <path>] \
  [--migration-report <path>]... --confirm-physical-device [--json]
baka backup off-device verify <bundle> [--json]
```

`plan` полностью хэширует inputs без публикации. `run` использует resume,
`.part` + fsync + rename, no-clobber и итоговую verify; destination должен быть
на другом filesystem. `st_dev` не доказывает отдельное физическое устройство,
поэтому run требует ручную durable аттестацию
`--confirm-physical-device`. Manifest/report и payload hashes доказывают
самосогласованную целостность, но совместная подмена остаётся за внешней trust
boundary: provenance bundle должна быть закреплена вне самого устройства
(trusted copy/signature).

## 16.4. Restore drill

```text
baka restore:test [export] [--raw-archive-root <path>] [--json]
```

Restore drill никогда не импортирует в production server и не имеет
same-server fallback. Перед maintenance window он fail-closed проверяет:

* production endpoint ровно `ws://127.0.0.1:8901/rpc`;
* container ровно `baka-surrealdb`, exact pinned image, healthy state и
  loopback bind `127.0.0.1:8901`;
* mounts ровно: rw bind effective internal `BAKA_DB_ROOT` → `/data/db` и два Docker local
  anonymous volume с безопасными identity → `/data` и `/logs`; extras и
  любые другие path mounts запрещены;
* отсутствие активного archive lock и established clients. После этого
  команда атомарно берёт собственный maintenance process lock, считывает и
  закрывает read-only baseline-client и повторно проверяет identity перед
  остановкой только immutable ID exact `baka-surrealdb`.

При остановленном production container создаётся disposable SurrealDB из
того же exact `v3.2.4@sha256:…`: уникальные allowlisted container/named-volume
identity, новый Docker local volume, случайный `127.0.0.1` port (8901
запрещён), никакого production/archive path mount. Сохранённый bounded профиль:

```text
memory/swap       12 GiB / 12 GiB
CPU / pids        4 / 512
RocksDB cache     1 GiB
RocksDB threads/jobs/subcompactions  4 / 4 / 2
HNSW cache        256 MiB
memory threshold  6 GiB
HTTP import max   32 GiB
index resume      0 (disabled)
```

Размер FULLTEXT batch не является launch-конфигурацией. Release binary
`3.2.4+20260803.93ab219` соответствует `surrealdb-core 3.2.4` commit
`93ab219d69f09d8f999851b0359c80ebe6726102`: `CommonConfig` не парсит
`indexing_batch_size`, поэтому `SURREAL_INDEXING_BATCH_SIZE` не передаётся и
не включается в resource profile. В core начальный scan использует compile-time
probe 16 records, затем adaptive размер стремится к soft target 8 388 608 raw
bytes и ограничивается максимумом 250 records; replay также читает максимум
250. Restore evidence аттестует эти три pinned значения отдельным immutable
объектом, не выдавая их за настройку запуска.

`SURREAL_MEMORY_THRESHOLD` здесь — process-wide query guard, а не Docker
hard cap. Threshold задан как exact 6 GiB: на 1 GiB
SurrealDB 3.2.3 прерывал concurrent FULLTEXT build при здоровом контейнере;
hard memory/swap cap остаётся 12/12 GiB и сохраняет 6 GiB headroom. Strict
RestoreTestReport v5 обязателен; v4 с обязательным глобальным
`chunk_content`, v3 со старым threshold 1 GiB или ложным утверждением
`indexing batch 64` больше не принимаются.

Credentials передаются Docker только значениями environment наследуемого
процесса (`--env NAME` без value), а HTTP import — через stdin-config curl;
они не могут появляться в argv, логах или report. До любого DB mutation drill
проверяет exact export/manifest SHA и size, затем импортирует schema 1
export в уникальный namespace `baka_restore_test_<32 hex>` disposable
server. Проверяются:

1. record counts, включая все owned physical vector tables;
2. referential, current/source/search ownership и vector invariants;
3. authenticated BM25 probe по `search_document.content`;
4. raw references и `rawManifestSha256` относительно `--raw-archive-root`;
5. exact FULLTEXT index `search_document_content` в terminal `ready`, а
   `chunk_content` отсутствует для schema 1;
6. cleanup в строгом порядке: started FULLTEXT indexes в обратном порядке,
   exact attempt namespace, затем explicit idempotent finalize disposable
   container и named volume с повторной проверкой их отсутствия.

После target finalize production container всегда запускается снова тем же
immutable ID; bounded health wait, повторная schema version и SHA-256
канонического набора `dialogue.id/current_revision` обязаны точно совпасть с
baseline, clients — снова отсутствовать. Maintenance lock освобождается
последним. Только после этого success сохраняется как private no-clobber
RestoreTestReport v5, связанный с exact export/manifest/raw hashes, unique
namespace, schema/database/root, exact image/version, opaque data identity,
ready `search_document_content`, подтверждённым отсутствием `chunk_content`,
durable resource profile и полным cleanup.
Failure/OOM сохраняет только privacy-safe stage/code, counters и cleanup
flags: без container/volume names, ports, paths, query/content и credentials.
Для off-device bundle передаются export из
`<bundle>/archive/backups/surreal/` и `--raw-archive-root <bundle>/archive`.
Production RocksDB не монтируется disposable target и не изменяется.

Для multi-GiB restore compose задаёт bounded
`SURREAL_HTTP_MAX_IMPORT_BODY_SIZE=34359738368` (32 GiB, значение в байтах).
Это server-side admission limit, отдельный от streaming/backpressure клиента;
без него валидный upload может быть отклонён HTTP 413 до полного чтения.

Restore test обязателен до migration и до любого решения о legacy retirement,
но сам успешный локальный report не доказывает внешнюю provenance bundle.

## 16.5. One-way rebuild повреждённого RocksDB

`baka recovery:rebuild` принимает exact independently pinned schema-1
export/manifest и требует все fail-closed gates:

```text
baka recovery:rebuild <internal-export> \
  --export-sha256 <lowercase-sha256> \
  --manifest-sha256 <lowercase-sha256> \
  --db-root <fresh-effective-internal-BAKA_DB_ROOT> \
  [--work-root <separate-internal-path>] \
  --confirm-rebuild [--json]
```

Команда аттестует остановленную corrupt production identity,
создаёт fresh DB/work roots на одном внутреннем APFS/POSIX device,
стримит decompression напрямую в один fsynced reordered import без plaintext
sibling, импортирует и строит только core FULLTEXT, затем проверяет counts,
referential/current/raw/embedding invariants и BM25. В `finally` exact staging
container, sole reordered import и server temp удаляются. Остаются
только verified fresh `BAKA_DB_ROOT` и private journal/report; отдельный
retained large cache не создаётся.

Rebuild не переименовывает containers и не выполняет promotion, physical
rollback или reverse migration. После проверенного success-report
координатор отдельно recreates Compose service с тем же exact effective
`BAKA_DB_ROOT`, после чего повторяет status/validate/raw acceptance.
Corrupt `${BAKA_ARCHIVE_ROOT}/db` не открывается, не копируется, не
переименовывается и остаётся нетронутым до принятого acceptance.

`migration-input/index__<sha256>.sqlite` — read-only input ещё не принятого
legacy import, а не часть recovery. Его сохраняют только до принятой
legacy-миграции. Точная процедура зафиксирована в
[`rocksdb-recovery.md`](rocksdb-recovery.md).

## 16.6. Шифрование

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
baka migration plan|run|retry|status
baka relevance evaluate|full-corpus
baka embeddings exact-tokens|candidates|backfill|audit
baka backup off-device plan|run|verify
baka recovery:rebuild
```

## 17.1. `baka sync`

По умолчанию:

* выполняет structured sync;
* создаёт embedding jobs;
* не вызывает OpenAI;
* не удаляет canonical данные;
* не изменяет legacy SQLite.

Текстовая сводка показывает статус и ошибки первыми, затем исходные файлы,
детали сканирования, диалоги/содержимое и поиск. Названия показателей слева,
числа с разделителями тысяч выровнены вправо в общей второй колонке.
Заголовки разделов заканчиваются двоеточием и выделены жирным в TTY
(кроме `NO_COLOR`/`TERM=dumb`). На узком экране текст переносится без
усечения; без TTY используется ширина 80. Технический счётчик новых raw
revisions скрыт из текстовой сводки; `--json` сохраняет исходные имена и
структуру всех счётчиков.
«Изменённых файлов» включает также назначенный повтор обработки по ошибке
или смене pipeline. При неизменном capture это не означает новый snapshot:
в журнале появляется `snapshot_skipped` с `reason=stable_raw_for_reparse`,
а `source_observations.parseOnly` показывает число таких повторов.
«Обработано диалогов» включает повторную обработку существующих диалогов,
а не только новые; «Отсутствует в источниках» не означает удаление из
архива. «Заданий на векторизацию» — поставленные задания, не готовые
векторы и не вызовы OpenAI. Пробный запуск помечается «без записи данных».

В JSONL-журнале stderr (`baka sync --json`, также вывод без TTY) события
`sync_timing` содержат `scope` (`sync`/`root`), `stage`, `durationMs`,
`status`, `dryRun`; для root — также `root` и `harness`. Длительности
измеряются монотонными часами, отдельно для preflight/lock, подключения/
схемы/identity, discovery, metadata embeddings, индекса дублей, обхода,
фильтра дублей, загрузки locations, reconcile, source fingerprints, snapshot,
parse/write, разрешения ошибок, presence, rename, чтения/записи локального
кэша и финализации. `total` — итог scope,
а `sync.roots` включает все root-этапы: складывать их повторно нельзя.
Незавершённый этап при ошибке также логируется. Dry-run не измеряет
snapshot/parse/write/presence: его время не заменяет замер полного sync.
Интерактивный progress не превращает технические тайминги в предупреждения.

Внутри обработки одной SQLite-базы progress показывает число завершённых
диалогов относительно обнаруженных: чтение → подготовка identity → запись.
В журнале добавлены вложенные `sync_timing`: `scope=source` с этапами
`parse`, `dialogues`, `diagnostics`; `scope=dialogue` с этапами `identity`,
`write`. Эти события содержат `sourceRevision` и `harness`; для диалога —
также порядковый номер `dialogue` (с 1) и общее число `dialogues`, без
названий и содержимого диалогов. Итог записи — `created`, `switched`,
`unchanged` или `failed`. Длительности вложены в root `parse_and_write`,
поэтому их нельзя прибавлять к родительскому времени. Сохранение кэша
измеряется root-этапами `source_capture_save` и `source_cache_save`.

Опции:

```text
--harness <slug>
--full-rescan
--deletion-confirmations <n>
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
last successful complete live sync
last fully verified logical backup
last strict successful restore test of that exact latest backup
latest persisted migration reconciliation
exact local backup → restore → raw manifest → off-device recovery chain
```

`status` не принимает hardcoded placeholders. Он повторно проверяет durable
artifacts и выводит trust отдельно: `integrity=verified` не означает внешнюю
provenance, а recovery chain всегда сообщает `cutover=not_asserted`, пока
оператор не завершил внешний gate.

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
* job/vector `input_sha256` не совпадает с `search_document.content_sha256`;
* vector `embedding_space` не совпадает с owning space;
* одна physical vector table назначена более чем одному space;
* completed job без vector;
* vector без completed job;
* dangling/cross-dialogue/cross-revision ownership links;
* unknown schema version;
* unresolved `migration_quarantine` и legacy migration `ingest_error`.

`raw_archive_path = NONE` считается намеренным только при
`snapshot_kind = legacy_missing_raw`; это schema 1 migration contract, а не
missing-file ошибка.

## 17.4. `baka doctor`

Дополнительно умеет исправлять безопасные состояния:

```text
--apply
--allow-destructive
--import-orphan-raw
--remove-stale-staging
--requeue-stuck-embeddings
--rebuild-search-projection
--recalculate-primary-models
--repair-manifest
--manifest-path <path>
--no-enqueue-embeddings
--json
```

Inspect/dry-run — default. Orphan импортируется только при однозначной
проверяемой provenance; иначе report содержит manual action. Apply paths
берут preflight + process lock. Удаление staging, projection rebuild и
manifest overwrite требуют одновременно `--apply --allow-destructive`;
`--manifest-path` требует `--repair-manifest`.

## 17.5. Search, export и reparse

```text
baka search <query> [--mode <text|vector|hybrid>] [--harness <slug>]
  [--host <label|hostname>] [--user <os-username>] [--workspace <name>]
  [--vendor <slug>] [--model <name>] [--reasoning-effort <value>]
  [--role <user|assistant|system|developer|tool|unknown>]
  [--document-type <type>] [--from <date>] [--to <date>]
  [--deleted-only] [--include-reasoning] [--include-tools]
  [--include-system] [--all-revisions] [--limit <n>] [--json]

baka export-thread <dialogue-id> [-o|--output <path>]
  [--include-relative-source-paths] [--force] [--json]

baka export:sqlite [--preset <qa-analysis|conversation|tools|instructions|full-canonical>]
  [--config <json>] [--out <sqlite>] [--dry-run] [--force] [--discover]
  [--instructions <exclude|separate>] [--unknown-policy <metadata|separate|include>]
  [--match-scope <turn|dialogue|message>] [--revisions <current|all>]
  [--harness <slug>] [--host <record-id>] [--vendor <slug>] [--model <name>]
  [--after <UTC>] [--before <UTC>] [--fields <list>] [--exclude-fields <list>]

baka reparse
  (--source-revision <id>|--source-location <id>|--harness <slug>|--all)
  [--parser-version <latest|n>] [--only-outdated] [--dry-run]
  [--no-enqueue-embeddings] [--no-verify-raw] [--json]
```

Search выдаёт enriched provenance. В schema 1 legacy forensic flags вместо
DB query дают fail-closed сообщение о выключенном глобальном индексе.
Vector/hybrid используют privacy-safe query embedding и hybrid явно
деградирует в text при недоступном provider. `export-thread` исключает paths
по умолчанию, абсолютные paths — всегда; overwrite требует `--force`.
`reparse` принимает ровно один selector, а `--dry-run` ничего не пишет.

`bun export:sqlite` запускает ту же команду. Без `--out` используется
`reports/ai-conversations.sqlite` с созданием каталога и атомарной заменой после
успешных проверок. Для явного `--out` overwrite требует `--force`;
`--dry-run` без `--out` не создаёт стандартный каталог/файл. Профиль остаётся QA.

`export:sqlite` — отдельный аналитический формат, не raw backup и не замена
SurrealDB. Полные фильтры, классификация, обязательные поля, пять профилей,
read-only manifest-последовательность и критерии приёмки описаны в
[sqlite-export.md](sqlite-export.md). Приёмка включает физическое отсутствие
исключённого текста, неоднозначности legacy flags, все turn'ы, scoped tool связи,
переносимость Python SQLite, отмену/no-clobber и неизменность источника.
Реальный production export требует отдельного выбора среза и destination.

## 17.6. Paid и destructive operator workflows

Все exact Stage 11 flags перечислены в §21, migration — в §15.10,
off-device/restore — в §16. Ни один paid/destructive action не следует выводить
из общего `--json`: требуется собственный literal confirmation, bounded limit
и соответствующий `--allow-paid-api`, `--apply` или
`--confirm-physical-device`.

---

# 18. Структура TypeScript-кода

```text
src/
├── cli.ts
├── config.ts
├── observability.ts
├── doctor.ts
├── export-thread.ts
├── reparse.ts
├── status.ts
├── validate.ts
├── db/
│   ├── client.ts
│   ├── repositories/
│   └── migrations.ts
├── sources/
│   ├── discovery/
│   ├── scanning/
│   ├── snapshot/
│   ├── adapters/
│   └── types.ts
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
│   ├── hybrid.ts
│   └── evaluation.ts
├── embeddings/
│   ├── provider.ts
│   ├── openai-provider.ts
│   ├── jobs.ts
│   ├── spaces.ts
│   ├── token-count.ts
│   └── backfill.ts
├── migration/
│   ├── preflight.ts
│   ├── authorization.ts
│   ├── legacy-reader.ts
│   ├── legacy-writer.ts
│   ├── reconciliation.ts
│   ├── store.ts
│   └── run.ts
└── backup/
    ├── backup.ts
    ├── raw-verify.ts
    ├── off-device.ts
    ├── restore-test.ts
    └── safety.ts
```

CLI намеренно собран в одном `src/cli.ts`; каталогов
`src/cli/commands`/`src/cli/output` нет. Дерево выше показывает основные
операционные seams, а не исчерпывающий список всех helper files.

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
31. Orphan raw после rename до DB commit repairable только при однозначной
    provenance; ambiguous и SQLite cases остаются manual, dry-run не пишет.
32. `legacy_missing_raw + NONE` принимается, любой другой snapshot kind без
    raw path отклоняется.
33. Migration approval с self-hash/`approvedBy` без detached Ed25519 signature
    и independently pinned public-key fingerprint отклоняется до writer.
34. Изменённые snapshot path/SHA/size, table totals, problem set,
    `expectedDeletedCount`, live probe или host assignments отклоняются.
35. Foreign namespace/database, forged `ok:true`, mismatch export/manifest/raw
    SHA/path/size/schema и restore старше 24 часов отклоняются до writer.
36. Migration report публикуется no-clobber; concurrent или повторный target
    не перезаписывается.
37. Retry закрывает resolved quarantine с audit trail, но не удаляет старую
    запись; per-table `accounted=total`, `lost=0` проверяется заново.
38. Generic `embeddings run`, mock-labelled/delegating/mutated provider не
    может вызвать provider вне specialized confirmed wrappers.
39. Candidate plan с удалёнными blockers, изменённым corpus/privacy/selection
    или пересчитанными outer hashes отклоняется до paid call.
40. Privacy exclusion связывает exact category/code/job/document/evidence;
    перестановка excluded и eligible/cancelled identities отклоняется.
41. Judgment tamper snippet-only и dialogue+snippet отклоняется даже после
    пересчёта judgment/report/evidence/canonical outer hashes: validator
    нормализует authenticated authoritative corpus bytes самостоятельно.
42. Добавление, удаление или перестановка content/proof/document/corpus
    bindings и fresh DB drift отклоняются.
43. Full-corpus acceptance требует независимо переданные exact judgment
    resolved path/SHA/size; identity нельзя получить из evidence. Missing,
    copied, changed, symlink/inode replacement, same-size rewrite и race fail.
44. Stage11 completion создаётся только full-corpus acceptance после полного
    eligible backfill; candidate dialogue coverage не заменяет completion.
45. Restore attempts используют разные unique namespaces; cleanup одного
    attempt не может удалить namespace другого, success требует полный cleanup.
46. Restore failure до/после import сохраняет privacy-safe stage/code report;
    corrupt/same-size export и partial/fixed-namespace report не считаются
    successful evidence.
47. Off-device publication проверяет traversal/symlink/unexpected files,
    resume `.part`, concurrent no-clobber, payload/manifest/report tamper и
    current `st_dev`; повреждённый final bundle не перезаписывается.
48. Status строит только exact latest backup→strict restore→raw→verified
    off-device chain и всегда оставляет external provenance/cutover отдельным
    operator gate.

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

* закреплённая SurrealDB 3.2.4 запускается;
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

* все восемь harness’ов проходят fixtures;
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
* fail-closed compatibility для прежних forensic flags без table scan.

Критерий:

* известные фразы находятся;
* фильтры работают;
* старые ревизии не загрязняют обычную выдачу;
* reasoning/tool/system/history сохранены в canonical data, но не попадают в
  основной индекс.

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

**Статус: CODE COMPLETE; свежий production approval — EXTERNAL OPERATOR
GATE.**

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

Перед live import оператор обязан повторить preflight без `--skip-live`
и независимо утвердить exact evidence. Количества, reconciliation и
quarantine проверяются по свежему signed report, а не историческим цифрам.

## Этап 10. Миграция истории

**Статус: implementation/CLI CODE COMPLETE; live import не выполнен и остаётся
EXTERNAL OPERATOR GATE.**

Работы:

* импорт raw;
* импорт source provenance;
* импорт dialogues;
* дедупликация с live corpus;
* импорт ранее удалённых записей; runtime authority — свежий
  signed `expectedDeletedCount`;
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
До accepted live report migration adapter сохраняется для retry/status/audit.

## Этап 11. Полный embeddings backfill

**Статус: bounded/paid workflow CODE COMPLETE; private judgment review,
provider spend, выбор production space, полный backfill и final acceptance —
EXTERNAL OPERATOR GATES.**

Работы:

1. выбрать embedding space по relevance evaluation;
2. выполнить точный token count;
3. показать объём и стоимость;
4. запустить backfill;
5. повторить failed jobs;
6. проверить index;
7. выполнить full-corpus hybrid relevance evaluation;
8. принять её только с независимо закреплённой exact judgment identity.

Критерий:

* все eligible documents имеют completed vector либо документированную permanent error;
* отсутствуют vectors неправильной dimension;
* exact privacy exclusions связаны с job/document/code/evidence;
* search quality принята на реальных запросах;
* `Stage11Completion` создан только `relevance full-corpus accept`.

## Этап 12. Backup/restore и окончательный cutover

**Статус: backup/off-device/restore/status contracts CODE COMPLETE; физическая
копия, externally trusted provenance, restore exact bundle, final validate,
cutover/tag и adapter retirement — EXTERNAL OPERATOR GATES.**

Работы:

* final logical export;
* raw manifest;
* off-device backup;
* restore drill;
* final validation;
* после принятого cutover отдельно решить, можно ли удалить migration adapter;
* создать tag:

  ```text
  surrealdb-cutover
  ```

Создание tag — отдельная git-операция только по явному решению оператора.
Legacy-файлы остаются на диске без изменений.

Их физическое удаление выполняется пользователем отдельно после периода
эксплуатации новой системы.

---

# 21. Проверка качества поиска

Stage 11 code/CLI готов, но все действия с private judgments и paid provider
остаются operator gates. До выбора final embedding space оператор создаёт и
независимо ревьюит private набор из 50–100 реальных запросов:

```text
query
expected dialogues
expected snippets
must-not-match examples
query language
query type
```

Каждый query содержит expected dialogue, expected snippet и must-not-match;
набор покрывает все десять классов ниже и языки RU/EN/mixed. Query text по
умолчанию не включается в отчёты.

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

## 21.1. Bounded candidate evaluation

Создаются ровно три candidate spaces, затем immutable bounded plan:

```text
baka embeddings candidates plan --judgments <private.json> \
  --spaces <slug1,slug2,slug3> --max-documents <1..1000> \
  --max-jobs-per-space <1..min(max-documents,200)> \
  --selection-seed-sha256 <sha256> --report <private.json> \
  [--overwrite] [--json]

baka embeddings candidates run --plan <path> --judgments <same-path> \
  --confirm <exact-plan-phrase> [--batch-size <1..64>] \
  --allow-paid-api [--json]

baka relevance evaluate --judgments <path> --report <path> \
  --candidate-plan <path> --confirm <exact-plan-phrase> \
  --spaces <same-three-csv> --resource-measurements <path> \
  --documented-exclusions <path> [--modes text,vector,hybrid] \
  --allow-paid-api [--include-query-text] [--overwrite] [--json]
```

Plan связывает exact normalized privacy, selection seed, required dialogues,
documents/jobs и blockers. Удаление blockers, изменение corpus/privacy/plan,
подмена provider или пересчёт только outer hashes не даёт authorization.
Documented exclusions содержат не count, а exact stable
`category/code/jobId/documentId/evidence`; swap исключённой и eligible row
отклоняется.

Отчёт хранит authenticated ordered hit identities и минимальное private
content evidence. Для judgment проверки validator читает authoritative corpus
bytes, проверяет их SHA и самостоятельно нормализует; сохранённые snippet/proof
claims не могут аутентифицировать сами себя. Добавление, удаление, перестановка
proof/document/corpus bindings или DB drift отклоняются.

Принятие candidate metrics и выпуск `AcceptedRelevanceEvidence` formatVersion
2 — ручное решение оператора, не автоматический результат собственного report.

## 21.2. Exact count и production backfill

```text
baka embeddings exact-tokens --model <selected-model> \
  --report <private.json> [--batch-size <n>] [--overwrite] [--json]

baka embeddings backfill plan --space <selected-slug> \
  --exact-report <path> --accepted-relevance <accepted-v2.json> \
  --max-jobs <n> [--json]

baka embeddings backfill run --space <selected-slug> \
  --exact-report <same-path> --accepted-relevance <same-accepted-v2.json> \
  --confirm <exact-plan-phrase> --max-jobs <n> \
  [--batch-size <1..64>] --allow-paid-api [--json]

baka embeddings audit --space <selected-slug> \
  [--page-size <1..1000>] [--json]
```

Exact tokenizer запускается pinned `uv run --quiet --offline --script` и
сверяет version/package/script identity. Цена существует только при явно
настроенном `OPENAI_EMBEDDING_PRICE_PER_1M_TOKENS`. Каждый run — один
ограниченный paid batch; retry/status сами provider не вызывают. Production
plan обязан быть без blockers, соответствовать accepted candidate evidence,
exact corpus/space/model/privacy и документировать permanent exclusions.

## 21.3. Mandatory full-corpus acceptance

Candidate evaluation не завершает Stage 11. После полного eligible backfill:

```text
baka relevance full-corpus plan --space <selected-slug> \
  --exact-report <path> [--json]

baka relevance full-corpus evaluate --space <selected-slug> \
  --exact-report <path> --judgments <private.json> \
  --resource-measurements <path> --documented-exclusions <path> \
  --confirm <exact-full-corpus-phrase> --report <private.json> \
  --allow-paid-api [--include-query-text] [--overwrite] [--json]

baka relevance full-corpus accept --evidence <accepted-v1.json> \
  --exact-report <path> --space <selected-slug> \
  --judgments <exact-reviewed-file> \
  --judgments-sha256 <externally-pinned-sha256> \
  --judgments-size-bytes <exact-positive-size> [--json]
```

Expected judgment resolved path, exact-byte SHA и size поступают извне и не
могут быть выведены из evidence или текущего файла. Missing identity,
copied/altered identity, symlink/inode replacement, same-size rewrite и race
fail closed. Изменение snippet-only или dialogue+snippet judgment отклоняется,
даже если атакующий пересчитал judgment/report/evidence/canonical hashes и не
изменил authoritative corpus bytes. Единственный constructor
`Stage11Completion` — успешный `full-corpus accept` над exact выбранным space,
corpus/privacy/exclusions и independently reviewed judgment artifact.

---

# 22. Observability

Операционные команды используют общий privacy-safe logger из
`src/observability.ts` там, где есть run lifecycle. Формат JSONL:

```json
{
  "level": "info",
  "event": "source_revision_parsed",
  "runId": "sync_run:...",
  "sourceRevisionId": "...",
  "harness": "codex",
  "dialogues": 1,
  "messages": 42,
  "chunks": 137,
  "durationMs": 218
}
```

Logger разрешает только stable identifiers/codes, counters, bytes/tokens и
timings; неизвестные/nested fields отбрасываются. Не логируются:

* полный prompt;
* полный assistant response;
* tool result;
* OpenAI API key;
* raw payload;
* DB password;
* абсолютные/относительные paths и report/output paths;
* arbitrary error text или provider response body.

Каждый run получает безопасный `runId`; если существует durable operation
record, используется его ID, иначе генерируется operation-scoped UUID. По нему
можно связать:

* console output;
* logs;
* `sync_run`;
* `source_scan`;
* `ingest_error`;
* migration report.

Private reports хранятся отдельно с mode 0600/no-clobber и не становятся
log payload. Fail-closed outer errors сообщают stable stage/code, а private
cause/path/content остаётся внутри локальной ошибки/report boundary.

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
11. Embedding vector соответствует exact `search_document.content_sha256`,
    completed job `input_sha256` и owning `embedding_space`.
12. Completed job имеет ровно соответствующий vector, а pending/error job —
    нет; vector без completed job запрещён.
13. В одной physical vector table находится только одно embedding space.
14. Cached и reasoning tokens не double-counted.
15. Ни одна migration row не теряется без durable quarantine; exact per-table
    `accounted=total`, а accepted production run имеет `lost=0` и
    `quarantined=0`.
16. Migration writer недостижим до signed approval/host-map/trust key и exact
    fresh backup/restore validation; повторный sync/migration идемпотентен.
17. Paid embeddings доступны только bounded/accepted workflows; permanent
    privacy exclusions связаны с exact job/document/code/evidence.
18. Stage 11 завершается только full-corpus acceptance с independently pinned
    exact-byte judgment identity и authoritative corpus evidence.
19. Archive может быть восстановлен из logical export + raw backup; strict
    restore report связан с exact export/manifest/raw hashes и cleanup.
20. Off-device integrity не заменяет external physical/provenance trust.
21. Работа structured sync не зависит от OpenAI.

---

# 24. Definition of Done

Проект завершён только когда одновременно выполнены обе группы ниже.
Готовность кода не закрывает операторские evidence gates.

### CODE COMPLETE / проверяемые implementation contracts

* SurrealDB 3.2.4 и JS SDK pinned; sentinel, loopback,
  `db:up/down/status/preflight` и `disk:eject` реализованы.
* Все восемь harness’ов, immutable/hash-addressed raw, consistent SQLite
  snapshots, revision history, deletion state machine и host identity
  реализованы; live sync идемпотентен.
* Full-text/vector/hybrid по curated search projection, fail-closed legacy
  forensic flags, segmentation v2 и HNSW audit реализованы; reasoning/tool
  content не индексируется глобально и не эмбеддится.
* Schema 1, migration/retry/reconciliation и fail-closed signed authorization
  contracts реализованы.
* Candidate/full-corpus paid gates, exact offline tokenizer и vector audit
  реализованы; generic embeddings worker закрыт.
* Logical/off-device backup, unique-namespace restore, validate/doctor/status и
  privacy-safe observability contracts реализованы.
* Legacy SQLite не изменяется и не удаляется автоматически; External System и
  `other-project` не изменены.

### EXTERNAL OPERATOR GATES — пока не закрыты

* Подтверждено, что live bind mount действительно расположен на ожидаемом
  archive volume в момент финальной операции.
* Создан свежий signed migration approval с exact snapshot/live/host evidence;
  выполнен live `migration run`.
* Все legacy rows учтены в accepted durable report; все ранее удалённые
  entries сохранены, причём runtime authority — signed
  `expectedDeletedCount`; `lost=0`, `quarantined=0`, retry не создаёт дублей.
* Старые диалоги, отсутствующие в live sources, найдены через search.
* Оператор принял private candidate relevance, цену и production space;
  выполнен полный eligible paid backfill и independently pinned full-corpus
  acceptance. Semantic/hybrid quality принята на реальных запросах.
* Созданы final logical export и raw manifest, опубликован и проверен bundle на
  подтверждённом отдельном физическом устройстве, а его provenance закреплена
  вне bundle.
* Выполнен strict restore exact off-device bundle; `status` показывает exact
  recovery chain, при этом external trust подтверждён оператором.
* Финальный `baka validate` не показывает критических ошибок; оператор принял
  cutover и отдельно разрешил tag.
* Только после периода эксплуатации отдельно решено, удалять ли migration
  adapter и legacy files. Удаление legacy всегда ручное и не является
  автоматическим шагом `baka`.

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
