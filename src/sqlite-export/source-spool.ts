import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { serialize, deserialize } from "node:v8";
import os from "node:os";
import path from "node:path";
import { RecordId } from "surrealdb";
import type { Surreal } from "surrealdb";
import { selectAll } from "../db/repositories/helpers.ts";
import type { ExportConfig, RevisionManifestEntry } from "./types.ts";
import { STREAM_TABLES, streamExportRecords } from "./export-stream.ts";
import type { StreamTable } from "./export-stream.ts";
import { SqliteExportFailure } from "./errors.ts";
import { httpBaseUrl } from "../backup/http.ts";
import { streamHttpPostResponse } from "../backup/http-stream.ts";

/** Only the small manifest uses RPC pages. Canonical payload is read by native HTTP export. */
export async function readIdPage(db: Surreal, table: "dialogue_revision", cursor: RecordId | undefined, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("sqlite export: invalid record page size");
  const rows = await selectAll<{id:RecordId}>(db,
    `SELECT id FROM ${table}${cursor ? " WHERE id > $cursor" : ""} ORDER BY id ASC LIMIT ${limit} TIMEOUT 30s`, {cursor});
  if (rows.length > limit || rows.some(row=>!(row.id instanceof RecordId) || row.id.table.name !== table)) throw new Error("sqlite export: invalid bounded record page");
  return rows.map(row=>row.id);
}

/** External-memory grouping: only authenticated ciphertext touches temporary payload pages. */
export class CanonicalSpool {
  private db?: Database;
  private directory?: string;
  private key?: Buffer;
  private readonly catalogCache = new Map<string, unknown>();
  constructor(private readonly source: Surreal, private readonly endpoint: string) {}

  async build(entries: Iterable<RevisionManifestEntry>, config: ExportConfig, signal?: AbortSignal, progress?: (completed: number) => void): Promise<void> {
    await this.close();
    this.directory=await mkdtemp(path.join(os.tmpdir(),"baka-export-spool-"));
    const file=path.join(this.directory,"spool.sqlite");const handle=await open(file,"wx",0o600);await handle.close();
    this.key=randomBytes(32);
    this.db=new Database(file,{strict:true,safeIntegers:true});
    // This encrypted scratch file is unusable after a crash (the key is RAM-only).
    // Avoid durable fsyncs here; the separately published output remains FULL + fsynced.
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; CREATE TABLE revisions(id TEXT PRIMARY KEY); CREATE TABLE records(kind TEXT NOT NULL,revision TEXT NOT NULL,id TEXT NOT NULL,bytes INTEGER NOT NULL,payload BLOB NOT NULL);");
    const include=this.db.prepare("INSERT INTO revisions VALUES(?)");
    let revisionCount=0;
    this.db.transaction(()=>{for(const entry of entries){include.run(entry.id);revisionCount++;}})();
    if(!revisionCount)return;
    const selected=this.db.prepare("SELECT id FROM revisions WHERE id=?");
    const insert=this.db.prepare("INSERT INTO records VALUES(?,?,?,?,?)");
    await this.source.ready;
    if(!this.source.namespace||!this.source.database)throw new Error("sqlite export: source namespace/database not selected");
    const body=JSON.stringify({tables:[...STREAM_TABLES],records:true,versions:false,users:false,accesses:false,params:false,functions:false,analyzers:false,apis:false,buckets:false,modules:false,configs:false,sequences:false});
    const headers:Record<string,string>={"Content-Type":"application/json","surreal-ns":this.source.namespace,"surreal-db":this.source.database};
    if(this.source.accessToken)headers.Authorization=`Bearer ${this.source.accessToken}`;
    const input=streamHttpPostResponse({url:`${httpBaseUrl({surrealUrl:this.endpoint}).replace(/\/$/,"")}/export`,headers,body,signal});
    let count=0,pending=0;
    this.db.exec("BEGIN");
    try {
      for await(const {table,value} of streamExportRecords(input,config.maxRevisionBytes)) {
        signal?.throwIfAborted();count++;
        if(count%config.batchSize===0)progress?.(count);
        const revision=table==="model"||table==="vendor"?"":value.dialogue_revision;
        if(typeof revision!=="string")throw new Error("sqlite export: missing source revision reference");
        if(revision!==""&&!selected.get(revision))continue;
        if(table==="message"||table==="chunk") {
          if(typeof value.sequence!=="bigint"&&(typeof value.sequence!=="number"||!Number.isSafeInteger(value.sequence)))throw new Error("sqlite export: invalid source sequence");
          if(table==="chunk"&&(typeof value.kind!=="string"||typeof value.content!=="string"||typeof value.message!=="string"))throw new Error("sqlite export: incomplete source chunk");
          if(table==="message"&&(typeof value.role!=="string"||
            (value.human_authored!==true&&value.human_authored!==false&&value.human_authored!=="unknown")||
            (value.visible_to_user!==true&&value.visible_to_user!==false&&value.visible_to_user!=="unknown")))throw new Error("sqlite export: incomplete source message");
        }
        if(table==="chunk"&&typeof value.content==="string"&&typeof value.content_sha256==="string"&&
          createHash("sha256").update(value.content).digest("hex")!==value.content_sha256)throw new Error("sqlite export: source content hash mismatch");
        const plaintext=serialize(value);
        if(plaintext.byteLength>config.maxRevisionBytes)throw new Error("sqlite export: source record exceeds maxRevisionBytes");
        const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.key,nonce);
        cipher.setAAD(Buffer.from(`${table}\0${revision}\0${String(value.id)}`));
        const encrypted=Buffer.concat([nonce,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
        const bytes=typeof value.content==="string"?Buffer.byteLength(value.content):plaintext.byteLength;
        insert.run(table,revision,String(value.id),bytes,encrypted);
        if(++pending>=config.batchSize){this.db.exec("COMMIT; BEGIN");pending=0;progress?.(count);}
      }
      signal?.throwIfAborted();
      this.db.exec("COMMIT");
      // Append during the stream, then build the grouping index in one bounded sort.
      this.db.exec("CREATE UNIQUE INDEX records_revision_id ON records(kind,revision,id)");
      progress?.(count);
    } catch(error) {
      if(this.db.inTransaction)this.db.exec("ROLLBACK");
      throw new SqliteExportFailure("stream_source",error);
    }
  }


  private decode<T>(payload: Uint8Array, table: StreamTable, revision: string, id: string): T {
    if(!this.key)throw new Error("sqlite export: source spool closed");
    const data=Buffer.from(payload.buffer,payload.byteOffset,payload.byteLength);
    const decipher=createDecipheriv("aes-256-gcm",this.key,data.subarray(0,12));
    decipher.setAAD(Buffer.from(`${table}\0${revision}\0${id}`));
    decipher.setAuthTag(data.subarray(-16));
    const plaintext=Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]);
    // Authenticated bytes were produced exclusively by this process's serializer.
    return deserialize(plaintext) as T;
  }

  *rows<T>(table: StreamTable, revision: string, budget: {remaining:number}):Generator<T> {
    if(!this.db)throw new Error("sqlite export: source spool not prepared");
    const query=this.db.query<{id:string;bytes:bigint;payload:Uint8Array},[string,string]>("SELECT id,bytes,payload FROM records WHERE kind=? AND revision=? ORDER BY id");
    for(const row of query.iterate(table,revision)) {
      const bytes=Number(row.bytes);
      if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error("sqlite export: invalid spool size");
      budget.remaining-=bytes;
      if(budget.remaining<0)throw new Error("sqlite export: revision exceeds maxRevisionBytes; increase explicit limit");
      yield this.decode<T>(row.payload,table,revision,row.id);
    }
  }

  get<T>(table: "model" | "vendor", id: string):T|undefined {
    if(!this.db)throw new Error("sqlite export: source spool not prepared");
    const key=`${table}\0${id}`;
    if(this.catalogCache.has(key))return this.catalogCache.get(key) as T|undefined;
    const row=this.db.query<{payload:Uint8Array},[string,string]>("SELECT payload FROM records WHERE kind=? AND revision='' AND id=?").get(table,id);
    const value=row?this.decode<T>(row.payload,table,"",id):undefined;
    if(value&&typeof value==="object")Object.freeze(value);
    if(this.catalogCache.size>=256) {
      const oldest=this.catalogCache.keys().next();
      if(!oldest.done)this.catalogCache.delete(oldest.value);
    }
    this.catalogCache.set(key,value);
    return value;
  }

  async close():Promise<void> {
    this.db?.close();this.db=undefined;this.key?.fill(0);this.key=undefined;
    this.catalogCache.clear();
    const directory=this.directory;this.directory=undefined;
    if(directory)await rm(directory,{recursive:true,force:true});
  }
}
