# Аналитический экспорт в SQLite

`baka export:sqlite` читает canonical-корпус SurrealDB и создаёт один переносимый
`.sqlite`. Это не основной storage, не legacy recovery, не raw backup и не
исследование диалогов. Поиск и прежний `export-thread` не меняются.

## Первый запуск

Настройте обычное подключение ai-baka к **уже существующей** базе. Команда не
запускает Docker, миграции, sync, reparse, embeddings или внешние API.
Каталог назначения должен существовать и находиться вне архива, live DB и
source roots. Не используйте symlink в пути назначения.
Дополнительные индексы и изменения production-схемы не нужны. Для большого
потокового чтения используются системные `curl` и `mkfifo` (штатные на macOS;
на Linux — curl и coreutils). Временный каталог должен вмещать зашифрованные
выбранные данные одновременно с итоговым файлом.

```bash
mkdir -p ./exports
bun run baka export:sqlite --discover
bun run baka export:sqlite --config ./examples/sqlite-export.json --dry-run
bun run baka export:sqlite --preset qa-analysis --out ./exports/qa.sqlite

# Независимые измерения: приложение и машина.
bun run baka export:sqlite --harness codex --host 'host:HOST_ID' \
  --out ./exports/codex-host.sqlite

# Сохранить вопросы вместе с подходящим исполнением.
bun run baka export:sqlite --vendor openai --match-scope turn \
  --out ./exports/openai.sqlite

bun run baka export:sqlite --preset tools --harness claude-code \
  --out ./exports/tools.sqlite
bun run baka export:sqlite --instructions separate \
  --out ./exports/qa-with-instructions.sqlite
bun run baka export:sqlite --unknown-policy separate \
  --out ./exports/qa-review.sqlite
bun run baka export:sqlite --preset instructions \
  --out ./exports/instructions.sqlite
```

Существующий результат сохраняется; `--force` разрешает замену **только после
проверки нового файла**. Symlink, hardlinked output и не-regular file отклоняются.
Один JSON-отчёт — в stdout, progress — в stderr. В TTY используется общий с sync
renderer: одна строка со стадией, прошедшим временем и счётчиками. Сбор manifest
и чтение исходного потока показывают spinner без выдуманного total; обработка
зафиксированных ревизий — bar. Проверка SQLite/SHA-256 и публикация — отдельные
стадии. Строка и таймер очищаются перед результатом, ошибкой или отменой.
Без TTY (или при `TERM=dumb`) — JSONL при смене стадии, завершении счётчика и
не чаще раза в пять секунд внутри стадии, без ANSI и строки на каждый batch.
Ошибка показывает стадию, безопасный код причины и число обработанных ревизий
(например, `export/read_chunk; QUERY_TIMEOUT; ревизий 0/100`), а не общую заглушку.
Исходные сообщения SDK/файлов не публикуются целиком: они могут содержать тексты,
пути и bindings. Программному вызывающему исходная ошибка доступна через `cause`.

## Профили и классификация

| Профиль | Содержимое |
| --- | --- |
| `qa-analysis` (default) | Подтверждённый ввод человека и подтверждённые финальные ответы каждого turn |
| `conversation` | Человеческий ввод и весь доступный видимый assistant text, включая progress/fallback |
| `tools` | Только части `tool_call`/`tool_result` и структурные связи |
| `instructions` | Наблюдавшиеся инструкции, автоматически включает `instructions=separate` |
| `full-canonical` | Все категории canonical; инструкции отдельно, неоднозначности и optional fields по общей политике |

`--categories` заменяет список категорий профиля: `human_input`,
`assistant_final`, `assistant_other`, `thought`, `tool_call`, `tool_result`,
`instructions`, `usage`, `attachment`, `object`, `unknown`. `reasoning` — алиас
`thought`, не новый тип. Role и chunk kind не взаимозаменяемы.

`--instructions exclude|separate`:

- `exclude` — служебное содержимое не записывается вообще, включая исходную
  смешанную копию, metadata и review. Это default, кроме двух явно инструкционных
  профилей выше. Явная категория `instructions` при `exclude` — ошибка.
- `separate` — доступные инструкции добавляются в отдельный слой независимо от
  QA-категорий, но с соблюдением execution/time filters. Они не попадают в QA view.
  Связь означает наблюдение в сообщении, а не доказательство действия инструкции
  на каждый последующий turn или её актуальности сейчас.

Классификатор использует role/kind, `autoContext`, подтверждённый человеческий
origin, `isMeta`, признаки subagent и harness-specific extractors. Codex
`userMessageText` имеет приоритет над mixed text. Когда человеческий текст
встречается в исходном тексте ровно один раз, остаток можно отдельно сохранить
как wrapper; иначе отмечается `mixed_wrapper_not_recoverable`, исходная смесь
не раскрывается. Произвольные Markdown/XML-блоки из человеческих цитат не вырезаются.

Старое `human_authored=false`/`visible_to_user=false` не восстанавливает утраченное
`unknown`. Сохраняются исходные флаги и отдельная интерпретация. Fallback extractor
без надёжного final marker не становится подтверждённым финальным ответом:
**default QA может исключать значительную часть ответов**, например у харнесса
без final markers. Для исследования таких случаев выберите `--unknown-policy
separate`; для всего видимого текста — `conversation`.

`--unknown-policy metadata|separate|include`:

- `metadata` — только идентификаторы, статусы и причины; неоднозначный текст отсутствует;
- `separate` — выбранный неоднозначный текст в `review_items`, вне основных views;
- `include` — текст в основном слое с `classification=unknown`.

Политика unknown не возвращает запрещённые категории. `full-canonical` с default
`metadata` поэтому не означает выгрузку всех payload. Отсутствующий в canonical
сырой event или prompt восстановить нельзя. Исходные данные не меняются.

## Фильтры и приоритет

Порядок: defaults → выбранный preset → JSON config → явные CLI overrides.
Массив заменяется, а не накапливается; `filters`/`excludeFilters` объединяются
по имени параметра, список каждого параметра заменяется отдельно. `--fields`
заменяет optional whitelist; `--exclude-fields` применяется после него.

| CLI | JSON `filters` / `excludeFilters` | Значение |
| --- | --- | --- |
| `--harness` | `harness` | slug приложения |
| `--harness-installation` | `harnessInstallation` | полный RecordId установки |
| `--vendor` | `vendor` | производитель модели |
| `--model` | `model` | canonical model name, не dialogue primary-model cache |
| `--service-provider` | `serviceProvider` | фактический сервис исполнения |
| `--reasoning-effort` | `reasoningEffort` | фактический effort |
| `--host` | `host` | полный RecordId машины, не hostname/label |
| `--platform`, `--arch` | `platform`, `arch` | сохранённые значения host |
| `--workspace`, `--dialogue`, `--revision` | одноимённые | полные RecordId |

Несколько CLI значений — через запятую, OR внутри одного фильтра, AND между
фильтрами. Для идентификатора с запятой используйте JSON-массив. Каждому фильтру
соответствует `--exclude-<имя>`. Corpus exclusions запрещают соответствующие
ревизии; execution exclusions запрещают совпавшие сообщения даже при расширении
контекста. Неизвестное значение identity даёт пустой срез; неизвестное имя
параметра или поля — ошибка. CPU/GPU/RAM в текущей схеме не наблюдаются и как
фильтры не поддерживаются; железо не угадывается по имени машины.

`--match-scope` относится к vendor/model/provider/effort:

- `turn` (default): подходит исполнение → сохраняются связанные обращения и
  выбранные категории этого turn, включая контекст других моделей;
- `dialogue`: совпадение в любой зафиксированной выбранной ревизии диалога →
  сохраняется выбранный контекст всех таких ревизий;
- `message`: только совпавшие сообщения; вопросы без model не добавляются.

Границы устанавливаются **до фильтрации**: новое user text, включая legacy
неоднозначность, начинает turn. Tool-result-only и подтверждённая инъекция его
не начинают. Это границы анализа, не доказанные reply-to связи. При неоднозначном
происхождении границы сохраняется uncertainty. Прерванный turn не получает
final предыдущего. Модель вопросу не приписывается; `context_included` отличает
контекст. У документа из нескольких сообщений view возвращает NULL для общей
модели/provider/effort и `attribution_status=multiple_sources_see_item_sources`;
реальная атрибуция остаётся в исходных `messages` через `item_sources`.

`--after`/`--before`: UTC ISO с `Z`, интервал `[after,before)` применяется к
`message.timestamp`. Без временного фильтра NULL сохраняется; при фильтре
неизвестная дата исключается и учитывается счётчиком. Время экспорта не заменяет
исходное. Внешний временной контекст не добавляется. Если часть объединённого
документа вне разрешённого execution/time scope, документ исключается целиком,
а не получает текст из запрещённых источников.

`--revisions current|all`: только ready-ревизии, default — указанные current.
`all` не склеивает occurrences; одинаковые «да» остаются разными событиями.
Подтверждённая межревизионная идентичность события сейчас не устанавливается,
`proven_duplicates=0` — не доказательство отсутствия копий.

## Поля и приватность

Схема стабильна. Keys, sequence, role/kind, классификация, происхождение и связи
обязательны. Optional whitelist публикуется через `--discover`:

- `dialogues.title`, `hosts.label`;
- `messages.timestamp`, `messages.model`, `messages.service_provider`,
  `messages.reasoning_effort`, `messages.response_status`, `messages.raw_role`;
- `messages.usage`: дополнительно к категории `usage`, только известные числовые
  поля нормализованного usage, без raw events/nested metadata; широкие целые в JSON
  представлены десятичными строками;
- `chunks.tool_name`, `chunks.source_locator`, `chunks.raw_kind`.

Default: timestamp, model/provider/effort, response status, tool name (последнее
только у выбранных tools). Названия диалогов/машин требуют явного включения.
Source locator допускается лишь в безопасной форме номера строки/индекса;
абсолютные и относительные filesystem paths, env, raw snapshots, payload ошибок
и неизвестные metadata не экспортируются. Attachment/object payload требует
выбора соответствующей категории, а для неопределённого object — также unknown
policy. Аргументы/результаты tools доступны только при выборе этих категорий.

IDs и сохранённые filter values получают HMAC-псевдонимы с новым случайным ключом
на каждый экспорт. Ключ и приватный mapping не входят в результат. Ссылки внутри
файла согласованы; сравнивать aliases между отдельными выгрузками нельзя.
Путь/название/секрет в **самом разрешённом тексте** остаётся текстом: это фильтрация,
не автоматическое обезличивание. Перед передачей файла человеку/внешнему сервису
проверьте содержимое и собственное разрешение на раскрытие.

## Хранение, полнота и чтение

Временный private manifest на диске фиксирует revision IDs до чтения payload;
`corpus_manifest` результата содержит безопасные refs и counts, включая ревизии
без выбранного содержимого. Это набор, собранный **за интервал**, а не общий
point-in-time snapshot. Последующая смена current pointer его не меняет.
Перед/после загрузки проверяются ready status, canonical hash и counts; исчезновение
или drift завершает экспорт ошибкой. Гарантия опирается на неизменяемость ready
canonical-ревизий, не на удерживаемую общую транзакцию сервера.

Canonical-таблицы `message`, `chunk` и справочники `model`, `vendor` читаются
**одним HTTP `/export`**, через последовательный KV-проход сервера с ограниченной
очередью. Нет SQL-запросов к message/chunk для каждой ревизии, OFFSET-проходов,
проверки обязательных индексов или их автоматического создания. RPC остаётся
для небольшого manifest и точечных проверок неизменности revision metadata.

В установленном SDK `.stream()` сначала получает целый RPC-ответ. Кроме того,
Bun может буферизовать HTTP response и stdout subprocess при медленном потребителе.
Поэтому curl пишет в private OS FIFO, а клиент читает его только по мере обработки,
порциями до 64 KiB. Настройки и credentials передаются curl через stdin, не argv;
пользовательский curlrc и лишнее окружение не наследуются. Отмена закрывает pipe
и source connection.

Native SurrealQL export **не исполняется**: parser распознаёт только record data
и whitelist полей, пропуская DDL и неизвестные metadata. Строки диалогов не могут
стать командами. У chunk с сохранённым hash проверяется точность декодированного
содержимого. Оборванный поток, неверные counts/hash или неподдержанный критический
тип завершают выгрузку ошибкой, а не частичным success.

Порядок исходных record IDs не группирует диалоги. Выбранные записи временно
группируются на диске в AES-256-GCM spool: ключ только в памяти процесса,
аутентификация связана с table/revision/id. Ни исходная смесь инструкций, ни tools
не записываются в этот рабочий файл открытым текстом. Одна ограниченная ревизия
расшифровывается для классификации; итоговый SQLite получает только разрешённую
проекцию. Spool и ключ удаляются при штатном завершении, ошибке или отмене.

Spool заполняется последовательно; unique grouping index строится одним проходом
после загрузки. Его `synchronous=OFF` относится **только к временному шифротексту**:
после сбоя без RAM-ключа он всё равно невосстановим. Итоговый файл сохраняет
`synchronous=FULL` и обязательный fsync перед публикацией. Размер ревизии проверяется
по мере чтения, без повторного сканирования BLOB ради counts; справочники моделей
имеют ограниченный кеш.

Default batch и лимит одной ревизии смотрите в resolved config. В памяти находятся
транспортная порция, один разбираемый record и одна обрабатываемая revision,
не весь корпус. `--max-revision-bytes` ограничивает record и суммарную подготовленную
нагрузку ревизии; превышение — ошибка без усечения.
Исходные int64 sequence сохраняются точно; безопасные внутренние ordinals нужны
лишь для number-based extractor API и не заменяют порядок в SQLite.

Фильтрация происходит до записи открытого payload в итоговый файл. Writer использует
prepared statements и ограниченные партии записей вместо durable-коммита каждой
ревизии. Дублирующие индексы, уже обеспеченные UNIQUE constraints, не создаются.
До публикации вычисленные **до записи** digests id/content сверяются с повторным
чтением `chunks`, `analysis_items`, `instructions`, `review_items` из SQLite:
различаются NULL/пустая строка, проверяются точный текст, привязка к id и число rows.
Результаты сохранены в `export_info.payload_digests`; это не hashes исходных raw bytes.

После закрытия — read-only reopen, schema version, integrity/FK checks, размер,
SHA-256 и атомарная публикация без обязательных WAL/SHM рядом. SHA-256 выводится
снаружи файла; размер записан и внутри. Ошибка, включая сбой после уже записанных
партий, не заменяет существующий output и не публикует partial-файл.

Основные таблицы: `corpus_manifest`, `hosts`, `models`, `dialogues`,
`dialogue_revisions`, `messages`, `chunks`, `items`, `item_sources`,
`analysis_items`, `instructions`, `instruction_applications`, `review_items`,
`relations`, `export_info`, `data_dictionary`. Очищенные/объединённые тексты —
аналитические документы со всеми source chunk refs, не выдуманные сообщения.

Tool pairs подтверждаются только при единственных call/result внутри одной
revision и call ID; повторные, отсутствующие и неоднозначные пары имеют явный
статус. Parent/fork/subagent lineage использует наблюдаемый
`parent_source_dialogue_id`; внешний parent — `outside_export`, несколько
возможных revision — `ambiguous`. Временная близость не создаёт lineage.

```sql
-- Подтверждённые человеческие occurrences, не deduplicated raw events.
SELECT count(DISTINCT message_id) FROM v_qa
WHERE category='human_input' AND classification='confirmed';

SELECT * FROM v_qa WHERE dialogue_id=?
ORDER BY revision_id, sequence, chunk_sequence, item_id;

SELECT m.sequence, c.sequence, c.kind, c.content
FROM chunks c JOIN messages m ON m.id=c.message_id
WHERE m.revision_id=? ORDER BY m.sequence,c.sequence;

SELECT * FROM review_items;
SELECT * FROM relations WHERE kind='tool_call_result';
SELECT a.*, i.content FROM instruction_applications a
JOIN instructions i ON i.id=a.instruction_id;
SELECT * FROM export_info;
SELECT * FROM data_dictionary;
```

`manifest_*` — точный corpus после corpus filters, до content/time/execution
projection; `read_*` — прочитанные canonical occurrences; `written_*` — физические
rows. `items_*`/причины исключения считают кандидатные документы, не сообщения:
сумма причин не обязана равняться числу исходных messages. Источники нескольких
документов могут пересекаться. `messages_missing_timestamp` считает сообщения.
Версии parser — по revision, extractor/classifier/формат — из констант реализации.
Commit описывает ревизию кода, не наличие незакоммиченных изменений. Успех означает
полную выгрузку **заданного среза**, не полноту логов и не чтение истории моделью.

## Программный API и проверки

```ts
import { resolveExportConfig } from "./src/sqlite-export/config.ts";
import { createSurrealExportSource } from "./src/sqlite-export/source.ts";
import { exportSqlite } from "./src/sqlite-export/index.ts";

// db — уже подключённый Surreal; surrealUrl — URL этого же соединения.
const result = await exportSqlite(createSurrealExportSource(db, surrealUrl),
  resolveExportConfig({ preset: "qa-analysis" }),
  { out: "./exports/qa.sqlite", protectedPaths: [archiveRoot, dbRoot] });
```

API также принимает `ExportSource`, signal, progress, dryRun, force и exporterCommit.
Callback `progress` получает `{ stage, completed?, total?, counts }`; стадии:
`manifest`, необязательные `source_scan` и `matching`, `export`, `verify`, `publish`.
`total` отсутствует, пока объём неизвестен; `counts` содержит текущие счётчики.
`source_records` — все records, просмотренные в одном исходном HTTP-потоке;
это не число выбранных сообщений и не признак смыслового анализа.
`timingsMs` содержит завершённые фазы подготовки данных: `manifest`, `sourceScan`,
`matching`, `sourceRead`, `projection`, `sqliteWrite`. Проверка и публикация идут
после них и не включены в эти суммы; поле позволяет различать медленный источник,
классификацию и запись, а не судить по одному общему времени.
Свой адаптер обязан предоставлять immutable manifest, соблюдать filters и
возвращать точные числа/даты; `protectedPaths` задаёт вызывающая сторона.
`exportSqlite` вызывает optional `ExportSource.prepare` после фиксации manifest
и `close` в cleanup. При прямой работе с Surreal-адаптером нужно самостоятельно
вызвать `prepare(entries, config)` до `readRevision` и `close()` в `finally`.

```bash
bun run typecheck
bun test tests/sqlite-export.test.ts
# Только disposable memory server на отдельном порту, без production volumes:
BAKA_SQLITE_TEST_URL=ws://127.0.0.1:18905/rpc \
  bun test tests/sqlite-export.integration.test.ts
# Без SurrealDB: синтетическая переносимая база, повторный output не затирается.
bun examples/sqlite-export-smoke.ts ./exports/smoke.sqlite 32 32768
# Реальный HTTP transport, но только на disposable сервере порта 18905:
BAKA_SQLITE_TEST_URL=ws://127.0.0.1:18905/rpc \
  bun examples/sqlite-export-source-smoke.ts 16384 65536
```

Интеграционный тест использует реальную схему, проверяет CLI, точные int64,
инъекционные фильтры, смену current pointer, drift и неизменность source tables.
Unit regressions покрывают профили, mixed text, цитаты, legacy unknown,
execution scopes, машины, ревизии, tools, даты/Unicode/длинный текст, whitelist,
отмену/no-clobber, lineage и перенос файла в Python `sqlite3`.

Нагрузочный сценарий отделяет seeding от процесса экспорта и использует native
source stream без lookup indexes. Сравнение на Bun 1.3.14/macOS arm64, Apple M1 Max,
isolated RocksDB с hard limit 4 GiB:

| Синтетический корпус | До оптимизаций | После |
| --- | ---: | ---: |
| 65 536 messages + chunks, короткий текст | 41,65 s | 21,84 s |
| 16 384 messages + chunks, около 512 MiB текста | 25,86 s | 18,14 s |

В первом сценарии непосредственно SQLite write сократился с 28,73 до 11,46 s.
Пиковый sampled RSS оптимизированного клиента — около 203 MiB и 197 MiB
соответственно. Большое turn-window на 20 001 сообщение обрабатывается за 34,6 ms
вместо 303,9 ms с одинаковым digest всей проекции. Это измерения конкретных
синтетических сценариев, не гарантия времени production. Тесты отдельно защищают
pipe backpressure, отмену, Unicode/NUL, readback digests и отказ после write batches.
