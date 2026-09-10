import { Database } from "bun:sqlite";
import type { SQLQueryBindings, Statement } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { link, lstat, mkdtemp, open, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hashFile } from "../sources/snapshot/hashing.ts";
import { EXTRACTOR_VERSION } from "../search/extractors/types.ts";
import { resolveExportConfig, safeExportConfig } from "./config.ts";
import { CLASSIFIER_VERSION, hasExecutionFilters, matchesExecution, projectRevision } from "./project.ts";
import { DICTIONARY, EXPORT_SCHEMA, SQLITE_EXPORT_FORMAT, SQLITE_EXPORT_VERSION } from "./schema.ts";
import type { ExportConfig, ExportOptions, ExportSource, RevisionManifestEntry, SqliteExportProgress, SqliteExportReport } from "./types.ts";
import { SqliteExportFailure } from "./errors.ts";
import { PayloadVerifier } from "./payload-verification.ts";

const LIMITATIONS = [
  "Fixed ready-revision manifest collected over an interval; not a point-in-time database snapshot. Current pointers are not re-read for selection.",
  "Canonical export, not raw backup. Events omitted by parsers and unobserved prompts cannot be recovered; instructions not observed does not prove absence.",
  "Legacy false may have originated as unknown. Ambiguous authorship, visibility and fallback finals are reported, not guessed.",
  "Turns are pre-filter canonical user-text boundaries, not proven reply-to edges. Unknown user text also starts a boundary.",
  "No cross-revision event deduplication without evidence; repeated occurrences are not independent proven human events.",
  "Free text can contain secrets and personal data. Filtering and per-export pseudonyms are not semantic anonymization or permission to publish.",
  "Bounded per-revision assembly; oversized revisions fail explicitly. No truncation. Exact int64 sequences are preserved; extractor-only ordinals do not replace exported source order.",
  "Source timestamp resolution is the canonical SDK Date resolution (milliseconds). No timestamps are invented.",
];

/** Never include exception payloads from a database query in an export/report. */
export async function exportSqlite(source: ExportSource, input: ExportConfig, options: ExportOptions = {}): Promise<SqliteExportReport> {
  const config = resolveExportConfig(input);
  const startedAt = new Date().toISOString();
  const counts: Record<string, number> = { manifest_revisions: 0, manifest_messages: 0, manifest_chunks: 0, read_revisions: 0, read_messages: 0, read_chunks: 0, proven_duplicates: 0 };
  const timingsMs: SqliteExportReport["timingsMs"] = {manifest:0,sourceScan:0,matching:0,sourceRead:0,projection:0,sqliteWrite:0};
  let phaseStarted = performance.now();
  const checks: string[] = [];
  const key = randomBytes(32);
  const alias = (kind: string, value: string) => `${kind.replace(/[^a-z_]/gi, "_")}_${createHmac("sha256", key).update(kind).update("\0").update(value).digest("hex")}`;
  const safeConfig = safeExportConfig(config, alias);
  const output = options.out ? path.resolve(options.out) : undefined;
  if (!options.dryRun && (!output || path.extname(output) !== ".sqlite")) throw new Error("sqlite export: требуется --out с расширением .sqlite");
  const directory = output ? path.dirname(output) : os.tmpdir();
  // Resolve every existing ancestor before allocating files. Canonical /tmp may itself be a platform symlink.
  if (output) {
    let current = directory;
    while (true) {
      const s = await lstat(current);
      if (s.isSymbolicLink() || !s.isDirectory()) throw new Error("sqlite export: output ancestors must be real directories, not symlinks");
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    const protectedPaths = ["/Volumes/Archive/Legacy Conversations", ...(options.protectedPaths ?? [])];
    for (const p of protectedPaths) {
      const resolved = path.resolve(p);
      const physical = await realpath(resolved).catch(() => resolved);
      if (output === physical || output.startsWith(`${physical}${path.sep}`)) throw new Error("sqlite export: output is inside protected source storage");
    }
    const existing = await lstat(output).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) throw new Error("sqlite export: refusing non-regular, symlink or hardlinked output");
    if (existing && !options.force) throw new Error("sqlite export: output exists; use --force to replace after verification");
  }
  options.signal?.throwIfAborted();
  const work = await mkdtemp(path.join(directory, ".baka-sqlite-"));
  const scratchPath = path.join(work, "manifest.sqlite");
  const temp = path.join(work, "export.sqlite");
  let scratch: Database | undefined;
  let target: Database | undefined;
  let operation: SqliteExportProgress["stage"] = "manifest";
  try {
    const notify = (stage: SqliteExportProgress["stage"], completed?: number, total?: number) => {
      operation = stage;
      options.progress?.({ stage, completed, total, counts });
    };
    notify("manifest", 0);
    scratch = new Database(scratchPath, { create: true, strict: true });
    scratch.exec("PRAGMA journal_mode=DELETE; CREATE TABLE manifest(n INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, dialogue TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE matching_dialogues(id TEXT PRIMARY KEY);");
    const insertManifest = scratch.prepare("INSERT INTO manifest(id,dialogue,body) VALUES(?,?,?)");
    for await (const batch of source.manifest(config, options.signal)) {
      options.signal?.throwIfAborted();
      scratch.transaction(() => {
        for (const entry of batch) {
          if (!Number.isSafeInteger(entry.messageCount) || !Number.isSafeInteger(entry.chunkCount) || entry.messageCount < 0 || entry.chunkCount < 0) throw new Error("sqlite export: invalid manifest counts");
          const frozen: RevisionManifestEntry = {
            id: entry.id, dialogueId: entry.dialogueId, harness: entry.harness,
            harnessInstallation: entry.harnessInstallation, host: entry.host,
            platform: entry.platform, arch: entry.arch, workspace: entry.workspace,
            title: config.fields.includes("dialogues.title") ? entry.title : undefined,
            hostLabel: config.fields.includes("hosts.label") ? entry.hostLabel : undefined,
            sourceRevision: entry.sourceRevision, parserName: entry.parserName, parserVersion: entry.parserVersion,
            canonicalHash: entry.canonicalHash, messageCount: entry.messageCount, chunkCount: entry.chunkCount,
            current: entry.current, startedAt: entry.startedAt, updatedAt: entry.updatedAt,
            metadata: {
              sourceDialogueId: typeof entry.metadata?.sourceDialogueId === "string" ? entry.metadata.sourceDialogueId : undefined,
              parentSourceDialogueId: typeof entry.metadata?.parentSourceDialogueId === "string" ? entry.metadata.parentSourceDialogueId : undefined,
            },
          };
          insertManifest.run(entry.id, entry.dialogueId, JSON.stringify(frozen));
          counts.manifest_revisions!++; counts.manifest_messages! += entry.messageCount; counts.manifest_chunks! += entry.chunkCount;
        }
      })();
      notify("manifest", counts.manifest_revisions);
    }
    const manifestCompletedAt = new Date().toISOString();
    timingsMs.manifest = performance.now() - phaseStarted;
    counts.manifest_dialogues = scratch.query<{n:number}, []>("SELECT count(DISTINCT dialogue) AS n FROM manifest").get()!.n;
    const pages = function* () {
      let n = 0;
      while (true) {
        const rows = scratch!.query<{ n: number; body: string }, [number, number]>("SELECT n,body FROM manifest WHERE n>? ORDER BY n LIMIT ?").all(n, config.batchSize);
        if (!rows.length) break;
        for (const row of rows) { n = row.n; yield JSON.parse(row.body) as RevisionManifestEntry; }
      }
    };
    if (source.prepare) {
      phaseStarted = performance.now();
      notify("source_scan", 0);
      await source.prepare(pages(), config, options.signal, completed => {
        counts.source_records = completed;
        notify("source_scan", completed);
      });
      timingsMs.sourceScan = performance.now() - phaseStarted;
    }
    if (config.matchScope === "dialogue" && hasExecutionFilters(config)) {
      phaseStarted = performance.now();
      const match = scratch.prepare("INSERT OR IGNORE INTO matching_dialogues VALUES(?)");
      let completed = 0;
      notify("matching", completed, counts.manifest_revisions);
      for (const entry of pages()) {
        options.signal?.throwIfAborted();
        const revision = await source.readRevision(entry, config, options.signal);
        if (revision.messages.some(m => (m.role === "assistant" || m.model) && matchesExecution(m, config))) match.run(entry.dialogueId);
        notify("matching", ++completed, counts.manifest_revisions);
      }
      timingsMs.matching = performance.now() - phaseStarted;
    }
    notify("export", 0, counts.manifest_revisions);
    if (!options.dryRun) {
      const handle = await open(temp, "wx", 0o600); await handle.close();
      target = new Database(temp, { strict: true });
      target.exec(EXPORT_SCHEMA);
      target.exec("BEGIN");
      const dictionary = target.prepare("INSERT INTO data_dictionary VALUES(?,?)");
      for (const [name, description] of Object.entries(DICTIONARY)) dictionary.run(name, description);
    }
    const field = (name: string, value: SQLQueryBindings | undefined): SQLQueryBindings => config.fields.includes(name) ? value ?? null : null;
    const payloadVerifier = new PayloadVerifier();
    let pendingRows = 0, pendingBytes = 0;
    const statements = new Map<string, Statement>();
    const insert = (table: string, values: SQLQueryBindings[], ignore = false) => {
      const sql = `INSERT ${ignore ? "OR IGNORE " : ""}INTO ${table} VALUES(${values.map(() => "?").join(",")})`;
      let statement = statements.get(sql);
      if (!statement) { statement = target!.prepare(sql); statements.set(sql, statement); }
      payloadVerifier.record(table, values);
      statement.run(...values);
      pendingRows++;
      for (const value of values) if (typeof value === "string") pendingBytes += value.length * 3;
      // The output remains private until all checks and the final fsync succeed.
      // Keep FULL durability, but amortize commits across bounded groups of rows.
      if (pendingRows >= 4096 || pendingBytes >= 8 * 1024 * 1024) {
        target!.exec("COMMIT; BEGIN");
        pendingRows = 0; pendingBytes = 0;
      }
    };
    for (const entry of pages()) {
      options.signal?.throwIfAborted();
      const readStarted = performance.now();
      const revision = await source.readRevision(entry, config, options.signal);
      timingsMs.sourceRead += performance.now() - readStarted;
      if (revision.manifest.id !== entry.id || revision.manifest.canonicalHash !== entry.canonicalHash || revision.messages.length !== entry.messageCount || revision.messages.reduce((n,m) => n + m.chunks.length, 0) !== entry.chunkCount) throw new Error("sqlite export: source violated frozen manifest");
      const matchedDialogue = config.matchScope === "dialogue" && hasExecutionFilters(config) ? !!scratch.query("SELECT id FROM matching_dialogues WHERE id=?").get(entry.dialogueId) : undefined;
      const projectionStarted = performance.now();
      const projection = projectRevision(revision, config, matchedDialogue);
      timingsMs.projection += performance.now() - projectionStarted;
      counts.read_revisions!++; counts.read_messages! += entry.messageCount; counts.read_chunks! += entry.chunkCount;
      for (const [name, n] of Object.entries(projection.counts)) counts[name] = (counts[name] ?? 0) + n;
      const writeStarted = performance.now();
      if (target) insert("corpus_manifest", [alias("revision", entry.id), alias("dialogue", entry.dialogueId), entry.sourceRevision ? alias("source_revision", entry.sourceRevision) : null, entry.canonicalHash, entry.messageCount, entry.chunkCount, Number(entry.current)]);
      if (!target || !projection.items.length) { timingsMs.sqliteWrite += performance.now() - writeStarted; notify("export", counts.read_revisions, counts.manifest_revisions); continue; }
      const revisionId = alias("revision", entry.id), dialogueId = alias("dialogue", entry.dialogueId), hostId = alias("host", entry.host);
      const selectedMessages = new Set(projection.items.map(i => i.messageId));
      const selectedChunks = new Set(projection.items.flatMap(i => i.sourceChunkIds));
      for (const m of revision.messages) if (m.chunks.some(c => selectedChunks.has(c.id))) selectedMessages.add(m.id);
      const messageById = new Map(revision.messages.map(m => [m.id, m]));
      const chunkById = new Map(revision.messages.flatMap(m => m.chunks.map(c => [c.id, c] as const)));
      const itemsByChunk = new Map<string, typeof projection.items>();
      for (const item of projection.items) {
        for (const chunkId of item.sourceChunkIds) {
          const sourced = itemsByChunk.get(chunkId) ?? []; sourced.push(item); itemsByChunk.set(chunkId, sourced);
        }
      }
      {
        insert("hosts", [hostId, field("hosts.label", entry.hostLabel), entry.platform ?? null, entry.arch ?? null], true);
        insert("dialogues", [dialogueId, entry.harness, alias("installation", entry.harnessInstallation), hostId, entry.workspace ? alias("workspace", entry.workspace) : null, field("dialogues.title", entry.title)], true);
        const sourceRef = typeof entry.metadata?.sourceDialogueId === "string" ? alias("source_dialogue", `${entry.harnessInstallation}\0${entry.metadata.sourceDialogueId}`) : null;
        const parentRef = typeof entry.metadata?.parentSourceDialogueId === "string" ? alias("source_dialogue", `${entry.harnessInstallation}\0${entry.metadata.parentSourceDialogueId}`) : null;
        insert("dialogue_revisions", [revisionId, dialogueId, entry.sourceRevision ? alias("source_revision", entry.sourceRevision) : null, entry.parserName, entry.parserVersion, entry.canonicalHash, Number(entry.current), sourceRef, parentRef, projection.items.some(i => i.layer === "instructions") ? "observed" : config.instructions === "exclude" ? "excluded" : "not_observed"]);
        for (const m of revision.messages) {
          if (!selectedMessages.has(m.id)) continue;
          const messageId = alias("message", m.id);
          const modelId = m.model && config.fields.includes("messages.model") ? alias("model", m.modelId ?? `${m.model.vendor}\0${m.model.canonicalName}`) : null;
          if (modelId) insert("models", [modelId, m.model!.vendor, m.model!.canonicalName], true);
          insert("messages", [messageId, revisionId, m.sourceSequence ?? m.sequence, m.role, field("messages.raw_role", m.rawRole), field("messages.timestamp", m.timestamp?.toISOString()), modelId, field("messages.service_provider", m.serviceProvider ?? m.model?.serviceProvider), field("messages.reasoning_effort", m.reasoningEffort ?? m.model?.reasoningEffort), field("messages.response_status", m.responseStatus), String(m.humanAuthored), String(m.visibleToUser), Number(hasExecutionFilters(config) && !matchesExecution(m, config))]);
          for (const c of m.chunks) {
            if (!selectedChunks.has(c.id)) continue;
            const sourced = itemsByChunk.get(c.id) ?? [];
            const direct = sourced.find(i => i.layer === "main" && i.extractionMethod === "canonical_chunk" && i.sourceChunkIds.length === 1);
            const locator = c.sourceLocator && /^(?:line:\d+|index:\d+|L\d+|\d+)$/.test(c.sourceLocator) ? c.sourceLocator : null;
            const toolSelected = sourced.some(i => i.category === "tool_call" || i.category === "tool_result");
            insert("chunks", [alias("chunk", c.id), messageId, c.sourceSequence ?? c.sequence, c.kind, field("chunks.raw_kind", c.rawKind), field("chunks.source_locator", locator), toolSelected && c.toolCallId ? alias("call", `${entry.id}\0${c.toolCallId}`) : null, toolSelected ? field("chunks.tool_name", c.toolName) : null, direct?.content ?? null]);
          }
        }
        for (const item of projection.items) {
          const itemId = alias("item", item.id), messageId = alias("message", item.messageId);
          const owner = messageById.get(item.messageId)!;
          const firstChunk = item.sourceChunkIds[0] ? chunkById.get(item.sourceChunkIds[0]) : undefined;
          insert("items", [itemId, messageId, owner.sourceSequence ?? item.sequence, firstChunk?.sourceSequence ?? item.chunkSequence, item.role, item.kind, item.category, item.origin, item.layer, item.classification, item.reason, item.extractionMethod, item.turnId ? alias("turn", item.turnId) : null, Number(item.matched), Number(item.context)]);
          for (const chunkId of item.sourceChunkIds) insert("item_sources", [itemId, alias("chunk", chunkId)]);
          if (item.layer === "main") insert("analysis_items", [itemId, item.content ?? null]);
          else if (item.layer === "instructions") {
            insert("instructions", [itemId, item.kind, item.content ?? null, "historically_observed"]);
            insert("instruction_applications", [itemId, itemId, revisionId, messageId, "observed_message_context"]);
          } else insert("review_items", [itemId, item.reason, item.content ?? null]);
        }
        for (const relation of projection.relations) insert("relations", [null, relation.kind, alias("item", relation.fromId), relation.toId ? alias("item", relation.toId) : null, null, null, relation.externalRef ? alias("external", relation.externalRef) : null, relation.status]);
      }
      timingsMs.sqliteWrite += performance.now() - writeStarted;
      notify("export", counts.read_revisions, counts.manifest_revisions);
    }
    if (target) {
      const commitStarted = performance.now();
      target.exec("COMMIT");
      timingsMs.sqliteWrite += performance.now() - commitStarted;
    }
    const report: SqliteExportReport = { status: options.dryRun ? "dry_run" : "success", format: SQLITE_EXPORT_FORMAT, formatVersion: SQLITE_EXPORT_VERSION, counts, timingsMs, checks, limitations: LIMITATIONS, config: safeConfig, startedAt, completedAt: new Date().toISOString() };
    if (!target) { checks.push("frozen_manifest_read", "projection_evaluated", "no_final_file_created"); return report; }
    notify("verify");
    const payloadDigests = payloadVerifier.verify(target);
    checks.push("payload_readback_digests");
    // Parent identities are scoped to the harness installation; multiple revision matches remain ambiguous.
    target.exec(`INSERT INTO relations(kind,from_revision,to_revision,external_ref,status)
      SELECT 'parent', child.id,
        CASE WHEN count(parent.id)=1 THEN min(parent.id) ELSE NULL END,
        CASE WHEN count(parent.id)=1 THEN NULL ELSE child.parent_source_dialogue_ref END,
        CASE WHEN count(parent.id)=1 THEN 'confirmed' WHEN count(parent.id)>1 THEN 'ambiguous' ELSE 'outside_export' END
      FROM dialogue_revisions child LEFT JOIN dialogue_revisions parent ON parent.source_dialogue_ref=child.parent_source_dialogue_ref
      WHERE child.parent_source_dialogue_ref IS NOT NULL GROUP BY child.id;`);
    for (const table of ["corpus_manifest", "hosts", "models", "dialogues", "dialogue_revisions", "messages", "chunks", "items", "analysis_items", "instructions", "review_items", "relations"]) counts[`written_${table}`] = target.query<{n:number}, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
    counts.revision_occurrences = counts.read_revisions!;
    checks.push("frozen_manifest_read", "canonical_counts_checked");
    const info = target.prepare("INSERT INTO export_info VALUES(?,?)");
    const metadata = { ...report, versions: { parser: "per dialogue_revisions row", extractor: EXTRACTOR_VERSION, classifier: CLASSIFIER_VERSION, exporterCommit: options.exporterCommit && /^[a-f0-9]{40}$/.test(options.exporterCommit) ? options.exporterCommit : "not_available" }, manifest: { startedAt, completedAt: manifestCompletedAt, consistency: "fixed_immutable_revisions_manifest" } };
    for (const [name, value] of Object.entries(metadata)) info.run(name, JSON.stringify(value));
    info.run("payload_digests", JSON.stringify(payloadDigests));
    const integrity = target.query<{integrity_check:string}, []>("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok" || target.query("PRAGMA foreign_key_check").all().length) throw new Error("sqlite export: SQLite integrity/FK check failed");
    checks.push("integrity_check", "foreign_key_check", "schema_version");
    // Written before close; the read-only reopening is repeated after final metadata update.
    checks.push("read_only_reopen", "single_file_rollback_journal");
    target.prepare("UPDATE export_info SET value=? WHERE key='checks'").run(JSON.stringify(checks));
    info.run("bytes", "0");
    let recordedBytes = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const pages = target.query<{page_count:number}, []>("PRAGMA page_count").get()!.page_count;
      const size = target.query<{page_size:number}, []>("PRAGMA page_size").get()!.page_size;
      if (recordedBytes === pages * size) break;
      recordedBytes = pages * size;
      target.prepare("UPDATE export_info SET value=? WHERE key='bytes'").run(JSON.stringify(recordedBytes));
    }
    target.close(); target = undefined;
    const verify = new Database(temp, { readonly: true, strict: true });
    try {
      if (verify.query<{user_version:number}, []>("PRAGMA user_version").get()!.user_version !== SQLITE_EXPORT_VERSION || verify.query<{integrity_check:string}, []>("PRAGMA integrity_check").get()!.integrity_check !== "ok" || verify.query("PRAGMA foreign_key_check").all().length) throw new Error("sqlite export: read-only verification failed");
    } finally { verify.close(); }
    for (const suffix of ["-wal", "-shm", "-journal"]) if (await stat(`${temp}${suffix}`).catch(() => undefined)) throw new Error("sqlite export: unexpected sidecar after close");
    const handle = await open(temp, "r"); try { await handle.sync(); } finally { await handle.close(); }
    const digest = await hashFile(temp);
    if (digest.sizeBytes !== recordedBytes) throw new Error("sqlite export: file size changed after verification");
    options.signal?.throwIfAborted();
    notify("publish");
    if (options.force) {
      const existing = await lstat(output!).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) throw new Error("sqlite export: refusing unsafe output replacement");
      await rename(temp, output!);
    } else { await link(temp, output!); await unlink(temp); }
    const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
    return { ...report, outputPath: output, bytes: digest.sizeBytes, sha256: digest.sha256 };
  } catch (error) {
    throw new SqliteExportFailure(operation, error, counts);
  } finally {
    target?.close(); scratch?.close(); key.fill(0);
    try { await source.close?.(); }
    finally { await rm(work, { recursive: true, force: true }); }
  }
}
