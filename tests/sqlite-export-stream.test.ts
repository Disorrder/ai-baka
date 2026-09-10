import { expect, test } from "bun:test";
import { streamExportRecords, STREAM_TABLES } from "../src/sqlite-export/export-stream.ts";

function document(message: string, chunk: string) {
  return STREAM_TABLES.map(table=>`-- TABLE: ${table}\nDEFINE TABLE ${table} SCHEMAFULL;\n-- TABLE DATA: ${table}\nINSERT [ ${table==="message"?message:table==="chunk"?chunk:table==="model"?"{ id: model:a, vendor: vendor:a, canonical_name: 'model-a' }":"{ id: vendor:a, slug: 'openai' }"} ];\n\n`).join("");
}
async function* packets(text:string,size:number) {
  const data=Buffer.from(text);
  for(let offset=0;offset<data.length;offset+=size)yield data.subarray(offset,offset+size);
}
test("native records survive arbitrary UTF-8 boundaries and exclude unselected metadata", async () => {
  const content="😀 東京 ' \\\n } ]; -- TABLE DATA: message\nINSERT [ { id: message:fake } ];";
  const text=document(`{ id: message:a, dialogue_revision: dialogue_revision:r, sequence: 9223372036854775807, timestamp: d'2026-01-01T00:00:00Z', metadata: {userMessageText: ${JSON.stringify(content)}, systemPrompt: 'PRIVATE_METADATA', origin: {kind:'human',private:'DROP'}} }`,
    `{ content: ${JSON.stringify(content)}, id: chunk:a, dialogue_revision: dialogue_revision:r, message: message:a, metadata: {autoContext:true,private:'DROP'}, sequence:0, kind:'text' }`);
  for(const size of [1,7,64,65536]) {
    const records=[];for await(const row of streamExportRecords(packets(text,size),1<<20))records.push(row);
    expect(records.length).toBe(4);
    expect(records[0]!.value.content).toBe(content);
    const message=records.find(r=>r.table==="message")!.value;
    expect(message.sequence).toBe(9223372036854775807n);
    expect(message.metadata).toEqual({userMessageText:content,origin:{kind:"human"}});
    expect(records[0]!.value.metadata).toEqual({autoContext:true});
  }
});
test("quoted strings, typed IDs and escapes are data, never statements", async () => {
  const text=document("{ id: message:⟨odd:id⟩, dialogue_revision: dialogue_revision:r, metadata: {userMessageText:'It\\'s \\u{1F600} \\u0041', turnResult: {content:'PRIVATE'}} }", "{id:chunk:a,dialogue_revision:dialogue_revision:r,message:message:⟨odd:id⟩,content:'ok'}");
  const records=[];for await(const row of streamExportRecords(packets(text,2),4096))records.push(row);
  expect(records.find(r=>r.table==="message")!.value.metadata).toEqual({userMessageText:"It's 😀 A",turnResult:true});
});
test("truncated streams and oversized records cannot become successful scans", async () => {
  const complete=document("{id:message:a,dialogue_revision:dialogue_revision:r}","{id:chunk:a,dialogue_revision:dialogue_revision:r,content:'"+"x".repeat(10000)+"'}");
  const scan=async(text:string,limit:number)=>{for await(const _ of streamExportRecords(packets(text,31),limit)){};};
  await expect(scan(complete.slice(0,complete.indexOf("content:")+20),20000)).rejects.toThrow("truncated");
  await expect(scan(complete,1000)).rejects.toThrow("exceeds maxRevisionBytes");
});

test("quote skipping preserves odd/even backslashes across packet boundaries",async()=>{
  const content=Array.from({length:9},(_,n)=>"\\".repeat(n)+'"'+ "\\".repeat(n)+"' \0\n東京").join("|");
  const text=document("{id:message:a,metadata:{userMessageText:'a''b \"\" c'}}",`{id:chunk:a,content:${JSON.stringify(content)}}`);
  for(const size of [1,2,3,5,13,64]) {
    const rows=[];for await(const row of streamExportRecords(packets(text,size),8192))rows.push(row);
    expect(rows[0]!.value.content).toBe(content);
    expect(rows[1]!.value.metadata).toEqual({userMessageText:"a'b \"\" c"});
  }
});
