import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExportConfig } from "../src/sqlite-export/config.ts";
import { projectRevision } from "../src/sqlite-export/project.ts";
import { exportSqlite } from "../src/sqlite-export/index.ts";
import { syntheticRevision, syntheticSource } from "./fixtures/sqlite-export.ts";
import type { ExportRevision, ExportSource } from "../src/sqlite-export/types.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function output() {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), "baka-sqlite-test-")); dirs.push(dir);
  return path.join(dir, "result.sqlite");
}
function recount(revision: ExportRevision) {
  revision.manifest.messageCount = revision.messages.length;
  revision.manifest.chunkCount = revision.messages.reduce((n,m) => n+m.chunks.length,0);
}
function mainTexts(revision: ExportRevision, config: unknown = {}) {
  return projectRevision(revision, resolveExportConfig(config)).items.filter(i => i.layer === "main").sort((a,b) => a.sequence-b.sequence).map(i => i.content);
}
test("QA preserves every turn, repeated short replies and an interrupted final turn", () => {
  expect(mainTexts(syntheticRevision())).toEqual(["исправь функцию", "Первый ответ — 東京", "да", "Второй ответ", "да"]);
});
test("presets filter mixed chunks; tools retain assistant calls and scoped pairs", () => {
  const r = syntheticRevision();
  const tools = projectRevision(r, resolveExportConfig({ preset: "tools" }));
  expect(tools.items.map(i => i.category)).toEqual(["tool_call", "tool_result"]);
  expect(tools.relations.map(r => r.status)).toEqual(["confirmed"]);
  expect(mainTexts(r, { preset: "conversation" })).toEqual(mainTexts(r));
  const full = projectRevision(r, resolveExportConfig({ preset: "full-canonical" }));
  expect(full.items.some(i => i.category === "thought" && i.content === "DENIED_THOUGHT")).toBe(true);
  expect(projectRevision(r, resolveExportConfig({ preset: "instructions" })).items.every(i => i.layer === "instructions")).toBe(true);
});
test("forbidden content is physically absent including nested metadata, source text and private filter values", async () => {
  const out = await output();
  const report = await exportSqlite(syntheticSource([syntheticRevision()]), resolveExportConfig({ filters: { host: ["host:one"], workspace: ["workspace:private"] } }), { out });
  const bytes = await readFile(out);
  for (const marker of ["DENIED_", "host:one", "workspace:private", "message:one_"]) expect(bytes.includes(Buffer.from(marker))).toBe(false);
  const db = new Database(out, { readonly: true });
  try {
    expect(db.query("SELECT content FROM v_qa ORDER BY sequence").all()).toEqual(["исправь функцию","Первый ответ — 東京","да","Второй ответ","да"].map(content=>({content})));
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(report.counts.written_analysis_items).toBe(5);
  } finally { db.close(); }
});
test("instruction separation never blends instructions with QA or stores mixed originals", async () => {
  const out = await output();
  await exportSqlite(syntheticSource([syntheticRevision()]), resolveExportConfig({ instructions: "separate" }), { out });
  const db = new Database(out, { readonly: true });
  try {
    expect(db.query("SELECT content FROM instructions ORDER BY content").all()).toEqual([{content:"DENIED_AUTOCONTEXT_AGENTS"},{content:"DENIED_MIXED_WRAPPER\n"},{content:"DENIED_SYSTEM_CONTEXT"}]);
    expect(db.query("SELECT content FROM v_qa WHERE content LIKE '%DENIED%'").all()).toEqual([]);
    expect((await readFile(out)).includes(Buffer.from("DENIED_MIXED_WRAPPER\nисправь функцию"))).toBe(false);
  } finally { db.close(); }
});
test("human quotations of system prompts and AGENTS are preserved", () => {
  const r = syntheticRevision();
  r.messages[4]!.chunks[0]!.content = "Измени AGENTS.md: <system>quoted instruction</system>";
  expect(mainTexts(r)).toContain("Измени AGENTS.md: <system>quoted instruction</system>");
});
test("legacy false and unknown require evidence; metadata/separate/include do not override categories", async () => {
  const r = syntheticRevision(); const m = r.messages[4]!;
  m.humanAuthored = false; m.visibleToUser = false; m.chunks[0]!.content = "LEGACY_UNCERTAIN";
  expect(mainTexts(r)).not.toContain("LEGACY_UNCERTAIN");
  const separate = projectRevision(r, resolveExportConfig({ unknownPolicy: "separate" }));
  expect(separate.items.find(i => i.content === "LEGACY_UNCERTAIN")?.layer).toBe("review");
  expect(mainTexts(r, { unknownPolicy: "include" })).toContain("LEGACY_UNCERTAIN");
  expect(mainTexts(r, { preset: "tools", unknownPolicy: "include" })).not.toContain("LEGACY_UNCERTAIN");
  m.humanAuthored = "unknown";
  const out = await output(); await exportSqlite(syntheticSource([r]), resolveExportConfig(), { out });
  expect((await readFile(out)).includes(Buffer.from("LEGACY_UNCERTAIN"))).toBe(false);
});
test("execution scopes retain questions without inventing their model and differ across model changes", () => {
  const r = syntheticRevision(); r.messages[5]!.model = { canonicalName: "model-b", rawModelName: "model-b", vendor: "anthropic", serviceProvider: "provider-b" };
  const filters = { vendor: ["openai"], serviceProvider: ["provider-a"] };
  expect(mainTexts(r, { filters, matchScope:"turn" })).toEqual(["исправь функцию","Первый ответ — 東京"]);
  expect(mainTexts(r, { filters, matchScope:"dialogue" })).toEqual(mainTexts(r));
  expect(mainTexts(r, { filters, matchScope:"message" })).toEqual(["Первый ответ — 東京"]);
  expect(r.messages[1]!.model).toBeUndefined();
  const items = projectRevision(r, resolveExportConfig({ filters }));
  expect(items.items.find(i=>i.category === "human_input")?.context).toBe(true);
});
test("host identity and independent harness filters do not infer hardware", async () => {
  const a = syntheticRevision("a", "host:a"), b = syntheticRevision("b", "host:b");
  a.manifest.hostLabel = b.manifest.hostLabel = "same-label";
  const out = await output(); const report = await exportSqlite(syntheticSource([a,b]), resolveExportConfig({filters:{host:["host:a"],harness:["codex"],arch:["arm64"]}}), {out});
  expect(report.counts.manifest_revisions).toBe(1);
  expect(() => resolveExportConfig({ filters: { cpu: ["M1"] } })).toThrow();
});
test("current/all revisions remain separate and dialogue scope expands across fixed revisions", async () => {
  const old = syntheticRevision("old"), current = syntheticRevision("current"); old.manifest.current=false;
  old.manifest.dialogueId = current.manifest.dialogueId;
  current.messages.filter(m=>m.model).forEach(m=>{m.model!.vendor="anthropic";});
  const source = syntheticSource([old,current]);
  const dry = await exportSqlite(source, resolveExportConfig(), {dryRun:true}); expect(dry.counts.manifest_revisions).toBe(1);
  const out = await output();
  const report = await exportSqlite(source, resolveExportConfig({revisions:"all",filters:{vendor:["openai"]},matchScope:"dialogue"}),{out});
  expect(report.counts.written_dialogue_revisions).toBe(2); expect(report.counts.written_analysis_items).toBe(10); expect(report.counts.proven_duplicates).toBe(0);
});
test("tool IDs never pair across dialogues; duplicate IDs within scope are ambiguous", () => {
  const a=syntheticRevision("a"), b=syntheticRevision("b");
  a.messages[3]!.chunks=[]; b.messages[2]!.chunks=b.messages[2]!.chunks.filter(c=>c.kind!=="tool_call");
  const config=resolveExportConfig({preset:"tools"});
  expect(projectRevision(a,config).relations[0]!.status).toBe("unpaired"); expect(projectRevision(b,config).relations[0]!.status).toBe("unpaired");
  a.messages[2]!.chunks.push({...a.messages[2]!.chunks.at(-1)!,id:"chunk:duplicate",sequence:99});
  expect(projectRevision(a,config).relations.every(r=>r.status==="ambiguous")).toBe(true);
});
test("time boundaries exclude missing timestamps without adjacent-answer reassignment; long unicode remains exact", async () => {
  const r=syntheticRevision(); const text="😀東京привет".repeat(50000); r.messages[5]!.chunks[0]!.content=text;
  const config=resolveExportConfig({after:"2026-09-01T00:00:00Z",before:"2026-09-02T00:00:00Z"});
  const projection=projectRevision(r,config); expect(projection.counts.messages_missing_timestamp).toBe(1);
  expect(projection.items.filter(i=>i.category==="human_input").length).toBe(2);
  const out=await output(); await exportSqlite(syntheticSource([r]),config,{out});
  const db=new Database(out,{readonly:true});try{expect(db.query<{content:string},[]>("SELECT content FROM v_qa WHERE sequence=50").get()!.content).toBe(text);}finally{db.close();}
});
test("field projection is stable and mandatory keys/invalid config cannot be silently dropped", async () => {
  expect(()=>resolveExportConfig({excludeFields:["messages.id"]})).toThrow();
  expect(()=>resolveExportConfig({categories:["instructions"],instructions:"exclude"})).toThrow();
  expect(()=>resolveExportConfig({fields:["metadata.*"]})).toThrow();
  const config=resolveExportConfig({preset:"tools",fields:["messages.model"]},{fields:[]});
  const out=await output(); await exportSqlite(syntheticSource([syntheticRevision()]),config,{out});
  const db=new Database(out,{readonly:true});try{expect(db.query("SELECT model_id FROM messages WHERE model_id IS NOT NULL").all()).toEqual([]);expect(db.query("SELECT tool_name FROM chunks WHERE tool_name IS NOT NULL").all()).toEqual([]);}finally{db.close();}
});
test("manifest is frozen before payload; errors and cancellation preserve existing output", async () => {
  const out=await output(); await writeFile(out,"original");
  await expect(exportSqlite(syntheticSource([syntheticRevision()]),resolveExportConfig(),{out})).rejects.toThrow();
  const revision=syntheticRevision();
  const changed=syntheticSource([revision], r=>{r.manifest.canonicalHash="changed";});
  await expect(exportSqlite(changed,resolveExportConfig(),{out,force:true})).rejects.toThrow("frozen manifest");
  expect(await readFile(out,"utf8")).toBe("original");
  const abort=new AbortController();const source=syntheticSource([syntheticRevision()],()=>abort.abort());
  await expect(exportSqlite(source,resolveExportConfig(),{out,force:true,signal:abort.signal})).rejects.toThrow();
  expect(await readFile(out,"utf8")).toBe("original");
  expect(await readdir(path.dirname(out))).toEqual(["result.sqlite"]);
});
test("symlink outputs and protected storage are rejected before source access", async () => {
  const out=await output();const source=syntheticSource([syntheticRevision()]);
  await symlink(path.join(path.dirname(out),"elsewhere"),out);
  await expect(exportSqlite(source,resolveExportConfig(),{out,force:true})).rejects.toThrow();
  await rm(out);await expect(exportSqlite(source,resolveExportConfig(),{out,protectedPaths:[path.dirname(out)]})).rejects.toThrow("protected");
});
test("several manifest batches preserve fixed IDs under current pointer changes", async () => {
  const revisions=Array.from({length:7},(_,i)=>syntheticRevision(`r${i}`));let manifestFinished=false;
  const base=syntheticSource(revisions);const source:ExportSource={
    async *manifest(c,s){for await(const b of base.manifest(c,s))yield b;manifestFinished=true;},
    async readRevision(e,c,s){expect(manifestFinished).toBe(true);revisions.forEach(r=>{r.manifest.current=false;});return {...await base.readRevision(e,c,s),manifest:e};},
  };
  const report=await exportSqlite(source,resolveExportConfig({batchSize:2}),{out:await output()});expect(report.counts.written_analysis_items).toBe(35);
});
test("single-file relocation opens in Python sqlite3 with exact counts and foreign keys", async () => {
  const out=await output();const report=await exportSqlite(syntheticSource([syntheticRevision()]),resolveExportConfig(),{out});
  const clean=await output();await writeFile(clean,await readFile(out));
  const p=Bun.spawn(["python3","-c","import sqlite3,sys,json; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps([c.execute('pragma integrity_check').fetchall(), c.execute('pragma foreign_key_check').fetchall(), c.execute('select count(*) from v_qa').fetchone()]))",clean],{stdout:"pipe",stderr:"pipe"});
  expect(await p.exited).toBe(0);expect(JSON.parse(await new Response(p.stdout).text())).toEqual([[['ok']],[],[5]]);
  expect(report.bytes).toBe((await readFile(out)).length);expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
});
test("external parent is explicit and has no dangling internal foreign key", async () => {
  const r=syntheticRevision();r.manifest.metadata={sourceDialogueId:"child",parentSourceDialogueId:"private-parent"};recount(r);
  const out=await output();await exportSqlite(syntheticSource([r]),resolveExportConfig(),{out});
  const db=new Database(out,{readonly:true});try{expect(db.query("SELECT status,to_revision FROM relations WHERE kind='parent'").all()).toEqual([{status:"outside_export",to_revision:null}]);expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);}finally{db.close();}
});

test("exact int64 source order and normalized usage survive SQLite and unknown usage metadata does not", async () => {
  const r=syntheticRevision();
  r.messages.forEach((m,i)=>{m.sourceSequence=9007199254740993n+BigInt(i);m.chunks.forEach((c,j)=>{c.sourceSequence=9007199254740993n+BigInt(j);});});
  r.messages[2]!.usage={inputTokens:9007199254740993n,cachedInputTokens:17,systemPrompt:"DENIED_USAGE_INSTRUCTION"};
  const out=await output();
  await exportSqlite(syntheticSource([r]),resolveExportConfig({categories:["human_input","assistant_final","usage"],fields:["messages.usage"]}),{out});
  const db=new Database(out,{readonly:true,safeIntegers:true});
  try {
    expect(db.query<{sequence:bigint},[]>("SELECT min(sequence) AS sequence FROM messages").get()!.sequence).toBe(9007199254740994n);
    const row=db.query<{content:string},[]>("SELECT content FROM v_analysis_messages WHERE category='usage'").get()!;
    expect(JSON.parse(row.content)).toEqual({inputTokens:"9007199254740993",cachedInputTokens:17});
  } finally { db.close(); }
  expect((await readFile(out)).includes(Buffer.from("DENIED_USAGE_INSTRUCTION"))).toBe(false);
});

test("confirmed machine origin and isMeta remain instructions even through user wrappers", () => {
  const r=syntheticRevision();r.messages[4]!.metadata={isMeta:true};r.messages[4]!.chunks[0]!.content="MACHINE_INJECTION";
  r.messages[6]!.metadata={originKind:"agent"};r.messages[6]!.chunks[0]!.content="AGENT_TASK";
  expect(mainTexts(r)).not.toContain("MACHINE_INJECTION");expect(mainTexts(r)).not.toContain("AGENT_TASK");
  const items=projectRevision(r,resolveExportConfig({instructions:"separate"})).items;
  expect(items.find(i=>i.content==="AGENT_TASK")?.layer).toBe("instructions");
});

test("execution exclusions veto context and combined documents never claim one model", async () => {
  const r=syntheticRevision();r.manifest.harness="opencode";
  r.messages=r.messages.filter(m=>[10,20,50].includes(m.sequence));
  r.messages[0]!.humanAuthored=true;r.messages[0]!.metadata={};r.messages[0]!.chunks=r.messages[0]!.chunks.slice(0,1);
  r.messages[1]!.chunks=r.messages[1]!.chunks.slice(0,1);
  r.messages[2]!.model!.vendor="anthropic";r.messages[2]!.model!.canonicalName="model-b";r.messages[2]!.metadata={finish:"stop"};
  recount(r);
  const out=await output();await exportSqlite(syntheticSource([r]),resolveExportConfig(),{out});
  const db=new Database(out,{readonly:true});
  try { expect(db.query("SELECT model,source_message_count FROM v_qa WHERE category='assistant_final'").all()).toEqual([{model:null,source_message_count:2}]); }
  finally { db.close(); }
  const projected=projectRevision(r,resolveExportConfig({excludeFilters:{vendor:["anthropic"]},matchScope:"dialogue"}));
  expect(projected.items.some(i=>i.content?.includes("Второй ответ"))).toBe(false);
});

test("provider filtering is independent of an unavailable model identity", () => {
  const r=syntheticRevision();r.messages[2]!.model=undefined;r.messages[2]!.serviceProvider="provider-a";
  r.messages[5]!.model!.serviceProvider="provider-b";
  expect(mainTexts(r,{filters:{serviceProvider:["provider-a"]}})).toEqual(["исправь функцию","Первый ответ — 東京"]);
});

test("force replaces only with a verified database; discovery needs no source connection", async () => {
  const out=await output();await writeFile(out,"old output");
  await exportSqlite(syntheticSource([syntheticRevision()]),resolveExportConfig(),{out,force:true});
  expect((await readFile(out)).subarray(0,16).toString()).toBe("SQLite format 3\0");
  const cli=Bun.spawn(["bun","src/cli.ts","export:sqlite","--discover"],{env:{...process.env,SURREAL_URL:"ws://127.0.0.1:1/rpc"},stdout:"pipe",stderr:"pipe"});
  const text=await new Response(cli.stdout).text();
  expect(await cli.exited).toBe(0);expect(JSON.parse(text).optionalFields).toContain("messages.timestamp");
  expect(()=>resolveExportConfig({after:"2026-02-30T00:00:00Z"})).toThrow();
  expect(()=>resolveExportConfig({batchSize:true})).toThrow();
});

test("progress discovers an unknown total then uses the frozen total in every content pass", async () => {
  const events: Array<{stage:string;completed?:number;total?:number}> = [];
  const revisions = [syntheticRevision("progress-a"), syntheticRevision("progress-b")];
  await exportSqlite(syntheticSource(revisions),
    resolveExportConfig({batchSize:1,matchScope:"dialogue",filters:{vendor:["openai"]}}),
    {out:await output(),progress:({stage,completed,total})=>events.push({stage,completed,total})});
  expect(events.filter(e=>e.stage==="manifest").map(e=>[e.completed,e.total]))
    .toEqual([[0,undefined],[1,undefined],[2,undefined]]);
  for (const stage of ["matching","export"]) {
    expect(events.filter(e=>e.stage===stage).map(e=>[e.completed,e.total])).toEqual([[0,2],[1,2],[2,2]]);
  }
  expect(events.slice(-2).map(e=>[e.stage,e.total])).toEqual([["verify",undefined],["publish",undefined]]);
});

test("export failures identify the stage and safe cause without disclosing private payloads", async () => {
  const out=await output();
  const source=syntheticSource([syntheticRevision()]);
  source.readRevision=async()=>{
    throw Object.assign(new Error("PRIVATE_DIALOGUE_PAYLOAD /private/source.jsonl"),{code:"ENOSPC"});
  };
  let failure: unknown;
  try { await exportSqlite(source,resolveExportConfig(),{out}); } catch(error) { failure=error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("expected failure");
  expect(failure.message).toContain("export");
  expect(failure.message).toContain("ENOSPC");
  expect(failure.message).toContain("0/1");
  expect(failure.message).not.toContain("PRIVATE_DIALOGUE_PAYLOAD");
  expect(failure.message).not.toContain("/private/source.jsonl");
  expect(failure.cause).toBeInstanceOf(Error);
  expect(await Bun.file(out).exists()).toBe(false);
});

test("a late failure after write batches preserves the previous output",async()=>{
  const out=await output();await writeFile(out,"previous output");
  const revisions=Array.from({length:160},(_,i)=>syntheticRevision(`batch-${i}`));
  const source=syntheticSource(revisions,r=>{if(r.manifest.id===revisions.at(-1)!.manifest.id)throw new Error("late source failure");});
  await expect(exportSqlite(source,resolveExportConfig(),{out,force:true})).rejects.toThrow();
  expect(await readFile(out,"utf8")).toBe("previous output");
  expect(await readdir(path.dirname(out))).toEqual(["result.sqlite"]);
});
