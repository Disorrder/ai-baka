import { RecordId, StringRecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import { selectAll } from "../db/repositories/helpers.ts";
import type { ExportMessage, ExportSource, RevisionManifestEntry } from "./types.ts";
import type { NormalizedChunkKind, NormalizedRole, VendorSlug } from "../domain/enums.ts";
import { CanonicalSpool, readIdPage } from "./source-spool.ts";

interface Row {
  id: RecordId | string; dialogue: RecordId; source_revision?: RecordId; current_revision?: RecordId;
  installation: RecordId; host: RecordId; workspace?: RecordId; message: RecordId | string; model?: RecordId | string;
  harness: string; host_label?: string; platform?: string; arch?: string; title?: string;
  parser_name: string; parser_version: string; canonical_hash: string; status: string;
  message_count: number | bigint; chunk_count: number | bigint; sequence: number | bigint; bytes?: number | bigint;
  started_at?: Date; updated_at?: Date; timestamp?: Date; source_dialogue_id?: string; parent_source_dialogue_id?: string;
  role: NormalizedRole; raw_role?: string; human_authored: boolean | "unknown"; visible_to_user: boolean | "unknown";
  raw_model_name?: string; reasoning_effort?: string; service_provider?: string;
  response_status?: ExportMessage["responseStatus"]; response_turn_id?: string; response_wait_ms?: number | bigint; response_completed_at?: Date;
  usage?: Record<string, unknown>; metadata?: Record<string,unknown>;
  kind: NormalizedChunkKind; raw_kind?: string; content?: string; source_locator?: string; tool_call_id?: string; tool_name?: string; raw_event_type?: string;
}
function id(value: unknown): string {
  if (value instanceof RecordId || typeof value === "string") return value.toString();
  throw new Error("sqlite export: отсутствует canonical identity");
}
function date(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(d.getTime())) throw new Error("sqlite export: некорректный timestamp источника");
  return d.toISOString();
}
function integer(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error("sqlite export: canonical sequence/count exceeds supported safe integer range");
  return n;
}
const MANIFEST_COLUMNS = `id, dialogue, source_revision, parser_name, parser_version, canonical_hash, status,
  message_count, chunk_count, started_at, updated_at, source_dialogue_id, parent_source_dialogue_id,
  dialogue.current_revision AS current_revision, dialogue.title AS title,
  dialogue.harness_installation AS installation,
  dialogue.harness_installation.harness.slug AS harness,
  dialogue.harness_installation.host AS host,
  dialogue.harness_installation.host.label AS host_label,
  dialogue.harness_installation.host.platform AS platform,
  dialogue.harness_installation.host.arch AS arch,
  dialogue.workspace AS workspace`;
const CORPUS_FILTERS: Record<string, string> = {
  harness: "dialogue.harness_installation.harness.slug", harnessInstallation: "dialogue.harness_installation",
  host: "dialogue.harness_installation.host", platform: "dialogue.harness_installation.host.platform", arch: "dialogue.harness_installation.host.arch", workspace: "dialogue.workspace", dialogue: "dialogue", revision: "id",
};
const RECORD_FILTERS = ["harnessInstallation", "host", "workspace", "dialogue", "revision"];
export function createSurrealExportSource(db: Surreal, endpoint: string): ExportSource {
  const spool = new CanonicalSpool(db, endpoint);
  return {
    prepare: (entries, config, signal, progress) => spool.build(entries, config, signal, progress),
    close: () => spool.close(),
    async *manifest(config, signal) {
      const clauses = ["status = 'ready'"];
      if (config.revisions === "current") clauses.push("id = dialogue.current_revision");
      const bindings: Record<string, unknown> = { limit: config.batchSize };
      for (const [index, filters] of [config.filters, config.excludeFilters].entries()) {
        for (const [name, values] of Object.entries(filters)) {
          const expression = CORPUS_FILTERS[name];
          if (!expression || !values?.length) continue;
          const parameter = `filter_${index}_${name}`;
          bindings[parameter] = values;
          const field = RECORD_FILTERS.includes(name) ? `type::string(${expression})` : expression;
          clauses.push(index === 0 ? `${field} IN $${parameter}` : `(${expression} = NONE OR ${field} NOT IN $${parameter})`);
        }
      }
      let cursor: RecordId | undefined;
      while (true) {
        signal?.throwIfAborted();
        const ids = await readIdPage(db, "dialogue_revision", cursor, config.batchSize);
        if (!ids.length) break;
        const rows = await selectAll<Row>(db, `SELECT ${MANIFEST_COLUMNS} FROM $ids WHERE ${clauses.join(" AND ")} TIMEOUT 30s`, { ...bindings, ids });
        yield rows.map((r): RevisionManifestEntry => ({ id: id(r.id), dialogueId: id(r.dialogue), harness: r.harness, harnessInstallation: id(r.installation), host: id(r.host), hostLabel: r.host_label, platform: r.platform, arch: r.arch, workspace: r.workspace ? id(r.workspace) : undefined, title: r.title, sourceRevision: r.source_revision ? id(r.source_revision) : undefined, parserName: r.parser_name, parserVersion: r.parser_version, canonicalHash: r.canonical_hash, messageCount: integer(r.message_count), chunkCount: integer(r.chunk_count), current: r.current_revision ? id(r.current_revision) === id(r.id) : false, startedAt: date(r.started_at), updatedAt: date(r.updated_at), metadata: { sourceDialogueId: r.source_dialogue_id, parentSourceDialogueId: r.parent_source_dialogue_id } }));
        cursor = ids.at(-1)!;
      }
    },
    async readRevision(entry, config, signal) {
      const revision = entry.id;
      const check = async () => {
        const rows = await selectAll<Row>(db, "SELECT id, canonical_hash, message_count, chunk_count, status FROM $revision", { revision: new StringRecordId(revision) });
        const r = rows[0];
        if (!r || r.status !== "ready" || r.canonical_hash !== entry.canonicalHash || integer(r.message_count) !== entry.messageCount || integer(r.chunk_count) !== entry.chunkCount) throw new Error("sqlite export: frozen revision changed or unavailable");
      };
      signal?.throwIfAborted();
      await check();
      const budget = {remaining:config.maxRevisionBytes};
      const rows = [...spool.rows<Row>("message", revision, budget)];
      const chunks = [...spool.rows<Row>("chunk", revision, budget)];
      if(rows.length!==entry.messageCount||chunks.length!==entry.chunkCount)throw new Error("sqlite export: incomplete frozen revision stream");
      const byMessage = new Map<string, ExportMessage["chunks"]>();
      const exactSequence = (value: number | bigint) => {
        if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("sqlite export: SDK returned imprecise canonical integer");
        return BigInt(value);
      };
      rows.sort((a,b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
      chunks.sort((a,b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
      const wideMessages = rows.some(r => !Number.isSafeInteger(Number(r.sequence)));
      const wideChunks = chunks.some(r => !Number.isSafeInteger(Number(r.sequence)));
      let bytes = 0;
      for (const c of chunks) {
        bytes += Buffer.byteLength(c.content ?? "");
        const owner = id(c.message), list = byMessage.get(owner) ?? [];
        list.push({ id: id(c.id), sequence: wideChunks ? list.length : integer(c.sequence), sourceSequence: wideChunks ? exactSequence(c.sequence) : undefined, kind: c.kind, rawKind: c.raw_kind, content: c.content, sourceLocator: c.source_locator, toolCallId: c.tool_call_id, toolName: c.tool_name, rawEventType: c.raw_event_type, metadata: { autoContext: c.metadata?.autoContext } });
        byMessage.set(owner, list);
      }
      if (bytes > config.maxRevisionBytes) throw new Error("sqlite export: revision exceeds maxRevisionBytes");
      const messages: ExportMessage[] = rows.map((m, index) => {
        const key = id(m.id), messageChunks = byMessage.get(key) ?? [];
        byMessage.delete(key);
        const model=m.model?spool.get<{canonical_name:string;vendor:string}>("model",id(m.model)):undefined;
        const vendor=model?.vendor?spool.get<{slug:VendorSlug}>("vendor",model.vendor):undefined;
        const metadata=m.metadata??{};
        const origin=metadata.origin;
        const originKind=typeof metadata.originKind==="string"?metadata.originKind:
          origin&&typeof origin==="object"&&"kind"in origin&&typeof origin.kind==="string"?origin.kind:undefined;
        return {
          id: key, sequence: wideMessages ? index : integer(m.sequence), sourceSequence: wideMessages ? exactSequence(m.sequence) : undefined, role: m.role, rawRole: m.raw_role,
          humanAuthored: m.human_authored, visibleToUser: m.visible_to_user,
          timestamp: m.timestamp ? new Date(date(m.timestamp)!) : undefined,
          serviceProvider: m.service_provider, reasoningEffort: m.reasoning_effort,
          modelId: m.model ? id(m.model) : undefined,
          model: m.model ? { canonicalName: model?.canonical_name ?? "unknown", rawModelName: m.raw_model_name ?? model?.canonical_name ?? "unknown", vendor: vendor?.slug ?? "unknown", reasoningEffort: m.reasoning_effort, serviceProvider: m.service_provider } : undefined,
          responseStatus: m.response_status, responseTurnId: m.response_turn_id,
          responseWaitMs: m.response_wait_ms === undefined ? undefined : integer(m.response_wait_ms),
          responseCompletedAt: m.response_completed_at ? new Date(date(m.response_completed_at)!) : undefined,
          usageEvents: [], usage: m.usage, chunks: messageChunks,
          metadata: { ...metadata, originKind },
        };
      });
      if (byMessage.size) throw new Error("sqlite export: orphan canonical chunks");
      await check();
      return { manifest: entry, messages };
    },
  };
}
