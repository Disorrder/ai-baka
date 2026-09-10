import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportSqlite } from "../src/sqlite-export/index.ts";
import { resolveExportConfig } from "../src/sqlite-export/config.ts";
import { syntheticRevision } from "../tests/fixtures/sqlite-export.ts";
import { gitHead } from "../src/db/migrations.ts";
import type { ExportSource } from "../src/sqlite-export/types.ts";

const out = path.resolve(process.argv[2] ?? "exports/sqlite-export-smoke.sqlite");
const revisionCount = Number(process.argv[3] ?? 32);
const textChars = Number(process.argv[4] ?? 32768);
if (!Number.isSafeInteger(revisionCount) || revisionCount < 1 || !Number.isSafeInteger(textChars) || textChars < 1) throw new Error("Usage: bun examples/sqlite-export-smoke.ts output.sqlite [revisions] [textChars]");
await mkdir(path.dirname(out), { recursive: true });
const output = path.join(await realpath(path.dirname(out)), path.basename(out));
const config = resolveExportConfig({batchSize:16});
const revision = (name:string) => {
  const r=syntheticRevision(name);r.messages[5]!.chunks[0]!.content="Ж".repeat(textChars);
  return r;
};
const source: ExportSource = {
  async *manifest(c) {
    for(let start=0;start<revisionCount;start+=c.batchSize) {
      yield Array.from({length:Math.min(c.batchSize,revisionCount-start)},(_,i)=>revision(`load_${start+i}`).manifest);
    }
  },
  async readRevision(entry) { return revision(entry.id.slice("dialogue_revision:".length)); },
};
const start=performance.now();
let sampledPeakRssBytes = process.memoryUsage.rss();
const report=await exportSqlite(source,config,{out:output,exporterCommit:gitHead(),progress:()=>{sampledPeakRssBytes=Math.max(sampledPeakRssBytes,process.memoryUsage.rss());}});
sampledPeakRssBytes=Math.max(sampledPeakRssBytes,process.memoryUsage.rss());
console.log(JSON.stringify({report,measurement:{revisionCount,textCharsPerRevision:textChars,batchSize:config.batchSize,elapsedMs:performance.now()-start,sampledPeakRssBytes,bun:Bun.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length}},null,2));
