import { Surreal, RecordId } from "surrealdb";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportSqlite } from "../src/sqlite-export/index.ts";
import { createSurrealExportSource } from "../src/sqlite-export/source.ts";
import { resolveExportConfig } from "../src/sqlite-export/config.ts";
import { createSqliteExportProgress } from "../src/sqlite-export/progress.ts";
import { createProgressLogger } from "../src/cli-progress.ts";

const url=process.env.BAKA_SQLITE_TEST_URL;
if(url!=="ws://127.0.0.1:18905/rpc")throw new Error("Only disposable source-smoke server on 18905 is allowed");
const db=new Surreal();
await db.connect(url);await db.signin({username:"root",password:"root"});
if(process.argv[2]==="--read") {
  const namespace=process.argv[3]!,out=process.argv[4]!;
  if(!/^sqlite_stream_[a-f0-9]{32}$/.test(namespace)||!out)throw new Error("Invalid isolated reader target");
  await db.use({namespace,database:"test"});
  const config=resolveExportConfig({batchSize:64}),ui=createSqliteExportProgress(config),start=performance.now();
  let peakClientRssBytes=process.memoryUsage.rss();
  const stagePeaks:Record<string,{rss:number;heapUsed:number;external:number}>={};
  try {
    const report=await exportSqlite(createSurrealExportSource(db,url),config,{out,progress:p=>{
      ui.update(p);const memory=process.memoryUsage();peakClientRssBytes=Math.max(peakClientRssBytes,memory.rss);
      if(!stagePeaks[p.stage]||memory.rss>stagePeaks[p.stage]!.rss)stagePeaks[p.stage]={rss:memory.rss,heapUsed:memory.heapUsed,external:memory.external};
    }});
    ui.stop();console.log(JSON.stringify({messages:report.counts.read_messages,analysisItems:report.counts.written_analysis_items,sourceRecords:report.counts.source_records,outputBytes:report.bytes,elapsedMs:performance.now()-start,timingsMs:report.timingsMs,peakClientRssBytes,stagePeaks,checks:report.checks}));
  } finally {ui.stop();await db.close();}
} else {
  const count=Number(process.argv[2]??8192),chars=Number(process.argv[3]??65536);
  if(!Number.isSafeInteger(count)||count<64||count%64||!Number.isSafeInteger(chars)||chars<1)throw new Error("count must be a positive multiple of 64; chars must be positive");
  const namespace=`sqlite_stream_${randomUUID().replaceAll("-","")}`;
  const directory=await mkdtemp(path.join(await realpath(os.tmpdir()),"baka-source-smoke-"));
  const payload="a".repeat(chars)+"\n'東京 } ]; \\\"";
  const seedProgress=createProgressLogger("source_smoke_seed");
  try {
    await db.use({namespace,database:"test"});
    await db.query("CREATE host:load SET platform='test',arch='test'; CREATE harness:load SET slug='codex'; CREATE harness_installation:load SET host=host:load,harness=harness:load; CREATE vendor:load SET slug='openai'; CREATE model:load SET vendor=vendor:load,canonical_name='synthetic-model';");
    for(let start=0;start<count;start+=64) {
      const name=`load_${start/64}`,dialogue=new RecordId("dialogue",name),revision=new RecordId("dialogue_revision",name);
      await db.query("CREATE $dialogue SET harness_installation=harness_installation:load,current_revision=$revision; CREATE $revision SET dialogue=$dialogue,status='ready',message_count=64,chunk_count=64,canonical_hash=$hash,parser_name='codex',parser_version='synthetic';",{dialogue,revision,hash:"a".repeat(64)});
      const messages=[],chunks=[];
      for(let i=0;i<64;i++) {
        const id=new RecordId("message",`${name}_${i}`),assistant=i%2===1,content=assistant?payload:`prompt ${i}`;
        messages.push({id,dialogue,dialogue_revision:revision,sequence:i,role:assistant?"assistant":"user",human_authored:!assistant,visible_to_user:true,model:assistant?new RecordId("model","load"):undefined,metadata:{phase:assistant?"final_answer":undefined,private:"PRIVATE_META_MUST_NOT_LEAK"}});
        chunks.push({id:new RecordId("chunk",`${name}_${i}`),dialogue,dialogue_revision:revision,message:id,sequence:0,kind:"text",content,content_bytes:Buffer.byteLength(content),metadata:{}});
      }
      await db.query("INSERT INTO message $messages RETURN NONE; INSERT INTO chunk $chunks RETURN NONE;",{messages,chunks});
      seedProgress({stage:1,detail:"Синтетический корпус",completed:start+64,total:count,unit:"сообщений"});
    }
    // Measure a fresh process: fixture construction must not inflate reader RSS.
    const child=Bun.spawn([process.execPath,import.meta.path,"--read",namespace,path.join(directory,"result.sqlite")],{env:process.env,stdout:"pipe",stderr:"inherit"});
    const result=JSON.parse(await new Response(child.stdout).text());
    if(await child.exited!==0||result.messages!==count||result.analysisItems!==count)throw new Error("source smoke failed");
    console.log(JSON.stringify({...result,canonicalTextBytes:count/2*Buffer.byteLength(payload)},null,2));
  } finally {
    await db.query(`REMOVE NAMESPACE ${namespace}`).catch(()=>{});await db.close();await rm(directory,{recursive:true,force:true});
  }
}
