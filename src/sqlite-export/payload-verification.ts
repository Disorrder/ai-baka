import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import type { Database } from "bun:sqlite";

const PAYLOADS: Record<string,{idColumn:string;contentIndex:number}> = {
  chunks:{idColumn:"id",contentIndex:8},
  analysis_items:{idColumn:"item_id",contentIndex:1},
  instructions:{idColumn:"id",contentIndex:2},
  review_items:{idColumn:"item_id",contentIndex:2},
};
interface DigestState { hash: Hash; rows: number }
export interface PayloadDigest { rows: number; sha256: string }

function append(hash:Hash,id:string,content:string|null):void {
  hash.update(`${id.length}:`).update(id);
  if(content===null)hash.update("N;");
  else hash.update(`S${content.length}:`).update(content).update(";");
}

/** Checks stored text against the pre-write projection, including NULL vs empty text. */
export class PayloadVerifier {
  private expected:Record<string,DigestState> = Object.fromEntries(Object.keys(PAYLOADS).map(table=>[table,{hash:createHash("sha256"),rows:0}]));

  record(table:string,values:readonly unknown[]):void {
    const descriptor=PAYLOADS[table];
    if(!descriptor)return;
    const id=values[0],content=values[descriptor.contentIndex];
    if(typeof id!=="string"||(content!==null&&typeof content!=="string"))throw new Error("sqlite export: invalid payload binding");
    const state=this.expected[table]!;
    append(state.hash,id,content);state.rows++;
  }

  verify(db:Database):Record<string,PayloadDigest> {
    const result:Record<string,PayloadDigest>={};
    for(const [table,descriptor] of Object.entries(PAYLOADS)) {
      const actual=createHash("sha256");let rows=0;
      for(const row of db.query<{id:string;content:string|null},[]>(`SELECT ${descriptor.idColumn} AS id,content FROM ${table} ORDER BY rowid`).iterate()) {
        append(actual,row.id,row.content);rows++;
      }
      const expected=this.expected[table]!;
      const sha256=actual.digest("hex");
      if(rows!==expected.rows||sha256!==expected.hash.digest("hex"))throw new Error(`sqlite export: payload verification failed for ${table}`);
      result[table]={rows,sha256};
    }
    return result;
  }
}
