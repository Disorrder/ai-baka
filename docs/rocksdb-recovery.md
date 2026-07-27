# Runbook: one-way rebuild production RocksDB

Этот runbook применяется при переносе live RocksDB с внешнего archive volume на
внутренний APFS/POSIX storage и при восстановлении после SST corruption.
Поддерживаемый production-маршрут — authenticated logical backup rebuild в
fresh target. In-place repair повреждённого RocksDB не используется.
`baka recovery:rebuild` создаёт и проверяет новое дерево DB, но не
меняет Compose или production container. Для уже работающей internal
production используется `--current-db-root`, после чего отдельная
`baka recovery:promote` атомарно сохраняет прежнее дерево в quarantine и
продвигает проверенное. Ни одна из команд не запускает production.

## Storage contract

| Путь | Содержимое | Filesystem |
| --- | --- | --- |
| `${BAKA_DB_ROOT:-${HOME:?HOME must be set}/Library/Application Support/ai-baka/rocksdb}` | final mutable production RocksDB | внутренний APFS (предпочтительно APFS Encrypted) или другой локальный POSIX filesystem |
| internal recovery root | staging/temp и private journal/report; staging/temp удаляются, evidence остаются | тот же внутренний APFS/POSIX; отдельный каталог от final DB |
| `BAKA_ARCHIVE_ROOT` | sentinel, immutable raw, manifests, logical/off-device backups и exports | архивный archive volume |
| `${BAKA_ARCHIVE_ROOT}/db` | старый/corrupt physical store | остаётся нетронутым; не runtime fallback |

HOME-derived `BAKA_DB_ROOT` устойчив между обычными `baka db up`
без изменения или печати secret `.env`. Override разрешён
только как абсолютный путь к другому внутреннему APFS/POSIX каталогу. ExFAT
**не поддерживается** для live DB, recovery target, streamed import temp
или recovery journal. Старый `archive/db` не копируется, не переименовывается и
не открывается recovery target.

Важно для существующей инсталляции: обновлённый compose больше не читает
`archive/db` по умолчанию. Не запускайте его до выполнения rebuild: Docker
может создать пустой HOME-derived каталог, но это не восстановленная база.
`migration-input/index__<sha256>.sqlite` — это read-only
вход ещё не выполненного legacy import, а не recovery artifact. Его
сохраняют только до принятой legacy-миграции; recovery не копирует
его и не создаёт ещё одну крупную постоянную копию.

## Стоп-условия

- `baka-surrealdb` должен быть остановлен, а все sync/migration/embeddings и
  внешние клиенты закрыты.
- Нельзя запускать `surreal fix rocksdb:///data/db`, `ldb repair`, custom
  `DB::repair`, удалять/подменять `.sst`, `MANIFEST` или `CURRENT` на
  production-копии. `surreal fix` — не SST repair; native RocksDB RepairDB —
  lossy salvage без гарантии time-consistent state.
- Recovery принимает только exact-pinned SurrealDB image, committed logical
  export и соответствующий manifest с совпавшими size/SHA-256, schema 5,
  namespace/database и `rawManifestSha256`.
- Final `BAKA_DB_ROOT` и recovery work root должны быть fresh real directories
  без symlink traversal. Final DB и work root не должны совпадать.
- Physical copy не заменяет logical export, raw manifest и off-device backup.
- Legacy-архив `Legacy Conversations` остаётся read-only и не участвует.

## Capacity gate

На внутреннем диске одновременно должны помещаться:

1. проверенная локальная копия compressed logical export;
2. один fsynced reordered SurrealQL import; отдельный decompressed sibling
   не создаётся;
3. final RocksDB и временный amplification FULLTEXT/HNSW/compaction;
4. recovery journal/report и обычный резерв ОС.

Используйте измеренный peak последнего restore drill, а не только размер
compressed backup. До recovery проверьте внутренний parent:

```bash
set -euo pipefail
export INTERNAL_BASE="${HOME}/Library/Application Support/ai-baka"
export CURRENT_DB_ROOT="$INTERNAL_BASE/rocksdb"
export RECOVERY_DB_ROOT="$INTERNAL_BASE/rocksdb-fresh"
export RECOVERY_WORK_ROOT="$INTERNAL_BASE/recovery-work"

case "$RECOVERY_DB_ROOT" in /*) ;; *) echo "DB root must be absolute" >&2; exit 1;; esac
case "$RECOVERY_WORK_ROOT" in /*) ;; *) echo "work root must be absolute" >&2; exit 1;; esac
test "$CURRENT_DB_ROOT" != "$RECOVERY_DB_ROOT"
test "$RECOVERY_DB_ROOT" != "$RECOVERY_WORK_ROOT"
test -d "$INTERNAL_BASE"
test ! -L "$INTERNAL_BASE"
test ! -e "$RECOVERY_DB_ROOT"
diskutil info "$INTERNAL_BASE"
df -h "$INTERNAL_BASE"
```

`diskutil info` должен показывать APFS, не ExFAT. При нехватке места остановите
процедуру; не переносите streamed import temp на archive volume.

## Подготовка backup и production identity

1. Выберите последний backup, созданный до corruption и имеющий manifest.
2. Проверьте его через `baka backup off-device verify` либо exact manifest
   size/SHA. Сохраните независимую проверенную пару compressed export +
   manifest в одном private backup-каталоге на внутреннем APFS; исходный
   архивный backup не изменяйте.
3. Убедитесь, что current/corrupt container остановлен. Recovery command
   fail closed проверяет полную stopped topology, а не только mount:

   - имя ровно `/baka-surrealdb`, ID — 64 lowercase hex, state — stopped;
   - image ID совпадает с digest, `Config.Image` — exact pinned tag+digest;
   - mounts ровно три: rw bind exact current `BAKA_DB_ROOT` → `/data/db`
     и два разных rw local anonymous volumes с 64-lowercase-hex
     identities в `/data` и `/logs`;
   - единственная port binding — `8000/tcp` → `127.0.0.1:8901` в одном
     экземпляре;
   - restart policy ровно `unless-stopped`.

   Любой extra/reused/foreign mount, другой port, policy, image, ID, name
   или running state блокирует rebuild до любой записи.
4. Проверьте compose без вывода credentials:

```bash
docker compose config --quiet
test "$(docker inspect -f '{{.State.Running}}' baka-surrealdb)" = "false"
```

Не используйте полный `docker compose config` в shared log: он может раскрыть
resolved secrets. `--quiet` проверяет только валидность.

## Rebuild fresh DB tree

Используйте command surface проекта; не собирайте вручную `curl /import` и не
передавайте credentials в argv:

```bash
export RECOVERY_EXPORT="$INTERNAL_BASE/recovery/BACKUP_ID/EXPORT_FILE.surql.zst"
export RECOVERY_EXPORT_SHA256="<independently-pinned-lowercase-sha256>"
export RECOVERY_MANIFEST_SHA256="<independently-pinned-lowercase-sha256>"
test -f "$RECOVERY_EXPORT"
baka recovery:rebuild "$RECOVERY_EXPORT" \
  --export-sha256 "$RECOVERY_EXPORT_SHA256" \
  --manifest-sha256 "$RECOVERY_MANIFEST_SHA256" \
  --db-root "$RECOVERY_DB_ROOT" \
  --current-db-root "$CURRENT_DB_ROOT" \
  --work-root "$RECOVERY_WORK_ROOT" \
  --confirm-rebuild \
  --json
```

`RECOVERY_EXPORT` должен указывать на точную проверенную internal backup copy.
`--export-sha256` и `--manifest-sha256` — обязательные
независимо закреплённые trust anchors. В current-internal flow
`--current-db-root` обязан точно совпадать с effective `BAKA_DB_ROOT`; rebuild
только аттестует это дерево и никогда его не меняет. `--confirm-rebuild` разрешает
только создание и проверку fresh DB tree. Effective `BAKA_DB_ROOT`
(`--db-root` или одноимённая environment variable) обязан быть fresh
абсолютным путём на внутреннем APFS/POSIX storage.
Команда выполняет один journaled flow под archive process lock:

```text
authenticate export + manifest
  → attest stopped corrupt production identity
  → create fresh internal DB/work roots
  → start exact-pinned staging container on 127.0.0.1:8901
  → stream decompress directly into one fsynced import while validating/removing FULLTEXT DDL
  → authenticated streaming import
  → build only search_document_content
  → verify counts + relational/current/raw/embedding invariants + BM25
  → stop staging cleanly
  → remove the exact staging container
  → remove the sole reordered import + server temp
  → persist recovery report
```

Единственный large reordered import и server temp удаляются в `finally` и не
переживают ни success, ни failure. Journal/report остаются как private durable
evidence на внутреннем APFS; их не коммитят. Единственный крупный
постоянный output — fresh `BAKA_DB_ROOT`; staging/temp к нему не дублируются. Corrupt archive volume
tree не открывается, не копируется, не переименовывается и остаётся
byte-for-byte нетронутым до принятого acceptance.

## Acceptance

Success требует одновременно:

- exact fresh internal `BAKA_DB_ROOT` создан и является единственным DB output;
- export bytes/SHA, manifest SHA и raw manifest SHA совпадают;
- record counts совпадают с authenticated manifest;
- schema version, referential/current/raw и embedding invariants проходят;
- `search_document_content` имеет terminal `ready`, запрещённого глобального
  `chunk_content` нет;
- два BM25 probes проходят;
- exact staging container удалён, sole streamed import payload удалён, recovery
  report записан.

На этом `recovery:rebuild` завершается. Он не переименовывает container,
не запускает production и не делает physical rollback или reverse migration.
Для current-internal flow после проверки report выполняется отдельный
`baka recovery:promote`: previous DB переименовывается в заранее отсутствующий
quarantine path, fresh tree — в exact `BAKA_DB_ROOT`; при сбое второго rename
первый rename откатывается. Quarantine не удаляется до final backup/restore
acceptance.

```bash
export RECOVERY_REPORT="<exact-recovery-report.json>"
export RECOVERY_REPORT_SHA256="<independently-pinned-lowercase-sha256>"
export QUARANTINE_DB_ROOT="$INTERNAL_BASE/rocksdb-partial-quarantine"
baka recovery:promote "$RECOVERY_REPORT" \
  --report-sha256 "$RECOVERY_REPORT_SHA256" \
  --current-db-root "$CURRENT_DB_ROOT" \
  --fresh-db-root "$RECOVERY_DB_ROOT" \
  --quarantine-db-root "$QUARANTINE_DB_ROOT" \
  --stopped-container-id "<exact-stopped-64-hex-container-id>" \
  --confirm-promote \
  --json
```

## Отдельное production recreation и acceptance

Только после проверки success-report и успешной `recovery:promote` координатор
запускает production service через guarded project command:

```bash
export BAKA_DB_ROOT="$CURRENT_DB_ROOT"
docker compose config --quiet
baka db up
RECOVERY_MOUNT_PROOF="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/db"}}{{.Source}}|{{.Destination}}|{{.RW}}{{end}}{{end}}' baka-surrealdb)"
test "$RECOVERY_MOUNT_PROOF" = "$BAKA_DB_ROOT|/data/db|true"
baka db status
baka status --json
baka validate --json
baka raw:verify --json
```

`baka db up` заново загружает `cfg.dbRoot` и до Compose start/recreate
проверяет, что он лексически отделён от `BAKA_ARCHIVE_ROOT/db`,
существующий путь/ближайший parent — real stable directory без symlink, а
файловая система — Internal APFS на macOS или allowlisted local POSIX на
Linux. Любая неопределённость блокирует Compose до запуска.

После `baka db up` проверьте, что exact mount source production
container равен resolved `cfg.dbRoot`/`BAKA_DB_ROOT` и смонтирован rw в
`/data/db`; монтирование `archive/db`, extra mount или другой path — blocker.
Дополнительно повторите exact image, health, sole loopback port и три
mounts из topology выше. Старое corrupt archive volume tree не удаляйте и не
изменяйте до принятого эксплуатационного acceptance и независимого backup.

## Failure и повторная попытка

Это one-way storage recovery: оператор не копирует данные обратно, не
переключает mount на corrupt archive volume и не запускает старую DB. При ошибке
команда останавливает и удаляет exact staging container, удаляет streamed import temp
поддерево и фиксирует failure в journal. Неполное fresh DB tree нельзя
запускать или переиспользовать; повторная попытка после анализа journal
использует новый fresh `BAKA_DB_ROOT` и новый attempt/work root.

Команда не реализует physical rollback или reverse migration и не создаёт
кэш для них. Если после Compose recreation понадобится ещё одно
восстановление, оно снова идёт из authenticated logical backup в другой
fresh internal target. Старое corrupt tree удаляется только вручную после
принятого периода эксплуатации. Отдельный `migration-input`
snapshot сохраняется только пока legacy import остаётся pending.

## Если нужен salvage RPO gap

Если после последнего проверенного backup есть незаменимые DB-only записи,
native RocksDB RepairDB рассматривается только как последний forensic salvage
на отдельном clone и после согласования с SurrealDB/vendor. Его physical output
нельзя продвигать в production: допустим только logical export salvage,
reconciliation и новый rebuild в fresh internal target. Это не меняет основной
маршрут backup-rebuild и не разрешает in-place repair.

Официальные ссылки:

- [SurrealDB: backups & recovery](https://surrealdb.com/docs/manage/self-hosted/backups-and-recovery)
- [SurrealDB: `surreal fix` — migration старого storage format](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/fix)
- [RocksDB Repairer: best-effort и data-loss ограничения](https://github.com/facebook/rocksdb/wiki/RocksDB-Repairer)
