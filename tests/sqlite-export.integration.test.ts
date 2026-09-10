import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Surreal } from "surrealdb";
import type { BoundQuery } from "surrealdb";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureHost, ensureHarness, ensureHarnessInstallation, ensureModel, ensureVendor } from "../src/db/repositories/identity.ts";
import { createSyncRun, ensureSourceRoot, ensureSourceLocation, ensureSourceRevision, updateSourceRevisionParse } from "../src/db/repositories/provenance.ts";
import { writeDialogueRevision } from "../src/db/repositories/corpus.ts";
import { codexExtractors } from "../src/search/extractors/codex.ts";
import { createSurrealExportSource } from "../src/sqlite-export/source.ts";
import { resolveExportConfig } from "../src/sqlite-export/config.ts";
import { exportSqlite } from "../src/sqlite-export/index.ts";
import { syntheticRevision } from "./fixtures/sqlite-export.ts";

class ObservedSurreal extends Surreal {
  observing = false;
  reads: Array<{sql:string;bindings?:Record<string,unknown>}> = [];
  override query<R extends unknown[] = unknown[]>(sql: string | BoundQuery<R>, bindings?: Record<string,unknown>) {
    if (this.observing && typeof sql === "string") this.reads.push({sql,bindings});
    return typeof sql === "string" ? super.query<R>(sql,bindings) : super.query(sql);
  }
}

const url = process.env.BAKA_SQLITE_TEST_URL;
const liveTest = url ? test : test.skip;
liveTest("real schema, paginated SELECTs, fixed current revision and zero source mutations", async () => {
  if (!url || !/^ws:\/\/127\.0\.0\.1:18905\/rpc$/.test(url)) throw new Error("Only disposable SQLite-export acceptance server on 18905 is allowed");
  const db=new ObservedSurreal();const ns=`sqlite_export_${randomUUID().replaceAll("-","")}`;
  const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),"baka-sqlite-live-"));
  const selection=createSurrealExportSource(db,url);
  try {
    await db.connect(url);await db.signin({username:"root",password:"root"});await db.use({namespace:ns,database:"test"});
    await db.query(await Bun.file(new URL("../schema/0001_initial.surql",import.meta.url)).text());
    const host=await ensureHost(db,{hostUuid:"export-fixture",hostname:"PRIVATE_HOST",platform:"darwin",arch:"arm64"});
    const harness=await ensureHarness(db,{slug:"codex",displayName:"Codex",kind:"file_tree"});
    const installation=await ensureHarnessInstallation(db,{host,harness,installed:true});
    const root=await ensureSourceRoot(db,{harnessInstallation:installation,path:"/private/fixture",sourceKind:"file_tree",parserName:"codex",snapshotStrategy:"copy",enabled:true});
    const run=await createSyncRun(db,{kind:"fixture",host,bakaCommit:"test",schemaVersion:1});
    const location=await ensureSourceLocation(db,{sourceRoot:root,relativePath:"fixture.jsonl",originalPath:"/private/fixture.jsonl",basename:"fixture.jsonl"});
    const source=await ensureSourceRevision(db,{sourceLocation:location.id,sha256:"a".repeat(64),sizeBytes:17,mtimeMs:1,rawArchivePath:"raw/fixture.jsonl",snapshotKind:"regular_copy",parserName:"codex",parserVersion:2,syncRun:run});
    await updateSourceRevisionParse(db,source.id,{parseStatus:"parsed",dialoguesDiscovered:1,canonicalHash:"b".repeat(64)});
    const vendor=await ensureVendor(db,"openai");const model=await ensureModel(db,{vendor,canonicalName:"model-a"});
    const fixture=syntheticRevision();
    const written=await writeDialogueRevision(db,{identityKey:`${installation}:fixture`,harnessInstallation:installation,sourceRevision:source.id,sourceDialogueId:"fixture",parserName:"codex",parserVersion:2,parsed:{externalId:"fixture",messages:fixture.messages,metadata:{}},extractors:codexExtractors,modelIds:new Map([["openai/model-a",model]]),activeEmbeddingSpaces:[],enqueueEmbeddings:false});
    const baseline=JSON.stringify(await db.query("SELECT * FROM dialogue; SELECT * FROM dialogue_revision; SELECT * FROM message; SELECT * FROM chunk; SELECT * FROM search_document"));
    db.observing = true;
    const out=path.join(dir,"result.sqlite");
    const report=await exportSqlite(createSurrealExportSource(db,url),resolveExportConfig({batchSize:2,filters:{host:[host.toString()],harness:["codex"],vendor:["openai"]}}),{out});
    db.observing = false;
    expect(report.counts.source_records).toBe(19);
    // RPC only reads the small manifest and checks frozen revision metadata.
    // Canonical payload must come from the one native HTTP export.
    for (const read of db.reads) {
      expect(/^(SELECT |INFO FOR TABLE )/.test(read.sql.trim())).toBe(true);
      expect(read.sql).not.toMatch(/FROM (?:message|chunk)\b/);
      if(read.sql.startsWith("INFO FOR TABLE ")) continue;
      const plan=JSON.stringify(await db.query(read.sql.endsWith("EXPLAIN") ? read.sql : `${read.sql} EXPLAIN`,read.bindings));
      if(plan.includes('"operator":"TableScan"')) {
        expect(read.sql.startsWith("SELECT id FROM ")).toBe(true);
        expect(plan).toContain('"limit":"2"');
      }
      expect(plan).not.toMatch(/"record_id":"[^"]*\.\./);
    }
    expect(report.counts.read_messages).toBe(7);
    const sqlite=new Database(out,{readonly:true});try{expect(sqlite.query("SELECT content FROM v_qa ORDER BY sequence").all()).toEqual(["исправь функцию","Первый ответ — 東京","да","Второй ответ"].map(content=>({content})));}finally{sqlite.close();}
    const cli = Bun.spawn(["bun","src/cli.ts","export:sqlite","--batch-size","2","--out",path.join(dir,"cli.sqlite")], {
      env:{...process.env,SURREAL_URL:url,SURREAL_NAMESPACE:ns,SURREAL_DATABASE:"test",SURREAL_USER:"root",SURREAL_PASS:"root",BAKA_ARCHIVE_ROOT:path.join(dir,"archive"),BAKA_DB_ROOT:path.join(dir,"storage")},
      stdout:"pipe",stderr:"pipe",
    });
    const cliStdout=await new Response(cli.stdout).text();
    const cliStderr=await new Response(cli.stderr).text();
    expect(await cli.exited).toBe(0);
    expect(JSON.parse(cliStdout).counts.written_analysis_items).toBe(5);
    expect(cliStderr).not.toContain("DENIED_");
    // Run the exact package script in a disposable cwd, not the user's reports/.
    const packageJson=await readFile(new URL("../package.json",import.meta.url));
    const sourceDirectory=path.resolve(import.meta.dir,"../src");
    await writeFile(path.join(dir,"package.json"),packageJson);
    await symlink(sourceDirectory,path.join(dir,"src"),"dir");
    const runCli=async(args:string[],cwd=dir,archiveRoot=path.join(dir,"archive"))=>{
      const child=Bun.spawn(["bun","export:sqlite","--batch-size","2",...args],{
        cwd,
        env:{...process.env,SURREAL_URL:url,SURREAL_NAMESPACE:ns,SURREAL_DATABASE:"test",SURREAL_USER:"root",SURREAL_PASS:"root",BAKA_ARCHIVE_ROOT:archiveRoot,BAKA_DB_ROOT:path.join(dir,"storage")},
        stdout:"pipe",stderr:"pipe",
      });
      const stdout=await new Response(child.stdout).text();
      const stderr=await new Response(child.stderr).text();
      return {code:await child.exited,stdout,stderr};
    };
    const defaultOutput=path.join(dir,"reports","ai-conversations.sqlite");
    const preview=await runCli(["--dry-run"]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout).status).toBe("dry_run");
    expect(await Bun.file(defaultOutput).exists()).toBe(false);
    await expect(lstat(path.join(dir,"reports"))).rejects.toMatchObject({code:"ENOENT"});
    const created=await runCli([]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout).outputPath).toBe(defaultOutput);
    const replaced=await runCli([]);
    expect(replaced.code).toBe(0);
    expect(JSON.parse(replaced.stdout).counts.written_analysis_items).toBe(5);
    const previous=await readFile(defaultOutput);
    const explicitExisting=await runCli(["--out","reports/ai-conversations.sqlite"]);
    expect(explicitExisting.code).toBe(1);
    expect(await readFile(defaultOutput)).toEqual(previous);
    const failed=await runCli(["--max-revision-bytes","1"]);
    expect(failed.code).toBe(1);
    expect(await readFile(defaultOutput)).toEqual(previous);
    const custom=await runCli(["--out","custom.sqlite"]);
    expect(custom.code).toBe(0);
    expect(JSON.parse(custom.stdout).outputPath).toBe(path.join(dir,"custom.sqlite"));
    expect(await readFile(defaultOutput)).toEqual(previous);
    const forced=await runCli(["--out","custom.sqlite","--force"]);
    expect(forced.code).toBe(0);
    await rename(path.join(dir,"reports"),path.join(dir,"reports-real"));
    await symlink(path.join(dir,"reports-real"),path.join(dir,"reports"),"dir");
    const linked=await runCli([]);
    expect(linked.code).toBe(1);
    expect(await readFile(path.join(dir,"reports-real","ai-conversations.sqlite"))).toEqual(previous);
    const protectedCwd=path.join(dir,"protected");
    await mkdir(protectedCwd);
    await writeFile(path.join(protectedCwd,"package.json"),packageJson);
    await symlink(sourceDirectory,path.join(protectedCwd,"src"),"dir");
    const protectedResult=await runCli([],protectedCwd,protectedCwd);
    expect(protectedResult.code).toBe(1);
    expect(await Bun.file(path.join(protectedCwd,"reports","ai-conversations.sqlite")).exists()).toBe(false);
    await expect(lstat(path.join(protectedCwd,"reports"))).rejects.toMatchObject({code:"ENOENT"});
    expect(JSON.stringify(await db.query("SELECT * FROM dialogue; SELECT * FROM dialogue_revision; SELECT * FROM message; SELECT * FROM chunk; SELECT * FROM search_document"))).toBe(baseline);
    const malicious=await exportSqlite(createSurrealExportSource(db,url),resolveExportConfig({filters:{host:["host:x']; DELETE message; --"]}}),{dryRun:true});
    expect(malicious.counts.manifest_revisions).toBe(0);
    const config=resolveExportConfig({batchSize:2});
    const entries=[];for await(const batch of selection.manifest(config))entries.push(...batch);
    await db.query("UPDATE $dialogue SET current_revision=NONE",{dialogue:written.dialogueId});
    await db.query("UPDATE message SET sequence=sequence+9007199254740993 WHERE dialogue_revision=$revision; UPDATE chunk SET sequence=sequence+9007199254740993 WHERE dialogue_revision=$revision", {revision:written.revisionId});
    await selection.prepare?.(entries,config);
    const wide=await selection.readRevision(entries[0]!,config);
    expect(wide.messages[0]!.sourceSequence).toBe(9007199254740993n);
    expect(wide.messages[0]!.chunks[0]!.sourceSequence).toBe(9007199254740993n);
    await db.query("UPDATE message SET sequence=sequence-9007199254740993 WHERE dialogue_revision=$revision; UPDATE chunk SET sequence=sequence-9007199254740993 WHERE dialogue_revision=$revision", {revision:written.revisionId});
    expect((await selection.readRevision(entries[0]!,config)).messages.length).toBe(7);
    await db.query("UPDATE $revision SET canonical_hash='drift'",{revision:written.revisionId});
    await expect(selection.readRevision(entries[0]!,config)).rejects.toThrow("changed or unavailable");
  } finally {
    await selection.close?.();
    await db.query(`REMOVE NAMESPACE ${ns}`).catch(()=>{});await db.close();await rm(dir,{recursive:true,force:true});
  }
},30000);
