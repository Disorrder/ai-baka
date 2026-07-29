import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { RecordId, Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { HARNESS_ORDER } from "../src/sources/adapters/harnesses.ts";

type QueryVariant = "verbatim" | "keywords";
type DocumentType = "user_prompt" | "assistant_final";
type Strategy = "literal_phrase" | "distinctive_token" | "token_or";

interface SourceDocument {
  id: RecordId;
  dialogue_id: RecordId;
  content: string;
  content_sha256: string;
  harness: string;
  document_type: DocumentType;
}

interface BenchmarkQuery {
  id: string;
  query: string;
  sourceContent: string;
  querySha256: string;
  sourceDocumentId: string;
  expectedDialogueId: string;
  harness: string;
  documentType: DocumentType;
  variant: QueryVariant;
}

const WORD_RE = /[\p{L}\p{N}_./:+#@-]{3,}/gu;
const DOCUMENT_TYPES: readonly DocumentType[] = ["user_prompt", "assistant_final"];
const STRATEGIES: readonly Strategy[] = ["literal_phrase", "distinctive_token", "token_or"];
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "between", "could",
  "does", "from", "have", "into", "more", "only", "other", "should", "some", "such",
  "than", "that", "their", "then", "there", "these", "they", "this", "those", "through",
  "using", "very", "want", "what", "when", "where", "which", "while", "with", "would",
  "без", "более", "быть", "будет", "вот", "всего", "где", "для", "если", "есть", "ещё",
  "как", "какие", "когда", "который", "между", "может", "можно", "надо", "нужно", "после",
  "почему", "при", "про", "сделать", "так", "также", "только", "уже", "чтобы", "этого", "это",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokens(content: string): string[] {
  return (content.match(WORD_RE) ?? []).map((token) => token.toLowerCase());
}

function deterministicOffset(id: string, range: number): number {
  if (range <= 0) return 0;
  return Number.parseInt(sha256(id).slice(0, 8), 16) % range;
}

function verbatimQuery(document: SourceDocument): string | undefined {
  const all = tokens(document.content);
  const width = 12;
  if (all.length < width) return undefined;
  const start = deterministicOffset(String(document.id), all.length - width + 1);
  return all.slice(start, start + width).join(" ");
}

function keywordQuery(document: SourceDocument): string | undefined {
  const candidates = tokens(document.content)
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.length >= 5 && !STOP_WORDS.has(token));
  const unique = new Map<string, { token: string; index: number }>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.token)) unique.set(candidate.token, candidate);
  }
  const selected = [...unique.values()]
    .sort((a, b) => {
      const aSignal = Number(/[0-9_./:+#@-]/.test(a.token));
      const bSignal = Number(/[0-9_./:+#@-]/.test(b.token));
      return bSignal - aSignal || b.token.length - a.token.length || a.index - b.index;
    })
    .slice(0, 6)
    .sort((a, b) => a.index - b.index);
  return selected.length >= 5 ? selected.map(({ token }) => token).join(" ") : undefined;
}

async function selectQueries(db: Surreal): Promise<BenchmarkQuery[]> {
  const selected: BenchmarkQuery[] = [];
  for (const harness of HARNESS_ORDER) {
    for (const documentType of DOCUMENT_TYPES) {
      const rows = await selectAll<SourceDocument>(
        db,
        `SELECT id, dialogue.id AS dialogue_id, content, content_sha256,
           dialogue.harness_installation.harness.slug AS harness, document_type
         FROM search_document
         WHERE document_type = $documentType
           AND dialogue.harness_installation.harness.slug = $harness
           AND string::len(content) >= 80
         ORDER BY id LIMIT 100`,
        { harness, documentType },
      );
      let accepted = 0;
      for (const row of rows) {
        const variant: QueryVariant = accepted % 2 === 0 ? "verbatim" : "keywords";
        const query = variant === "verbatim" ? verbatimQuery(row) : keywordQuery(row);
        if (!query || query.length > 500) continue;
        selected.push({
          id: `q_${sha256(`${row.id}:${variant}:${accepted}`).slice(0, 16)}`,
          query,
          sourceContent: row.content,
          querySha256: sha256(query),
          sourceDocumentId: String(row.id),
          expectedDialogueId: String(row.dialogue_id),
          harness: row.harness,
          documentType: row.document_type,
          variant,
        });
        accepted += 1;
        if (accepted === 2) break;
      }
      if (accepted !== 2) throw new Error(`${harness}/${documentType}: insufficient queries`);
    }
  }
  return selected;
}

function flattened(content: string): string {
  return content.replace(/[\r\n\u2028\u2029]+/g, " ");
}

function patterns(query: BenchmarkQuery, strategy: Strategy): string[] {
  const all = [...new Set(tokens(query.query))];
  if (strategy === "literal_phrase") return [query.query];
  if (strategy === "token_or") return all;
  return [[...all].sort((a, b) => {
    const aSignal = Number(/[0-9_./:+#@-]/.test(a));
    const bSignal = Number(/[0-9_./:+#@-]/.test(b));
    return bSignal - aSignal || b.length - a.length || a.localeCompare(b);
  })[0]!];
}

function sourceMatches(query: BenchmarkQuery, strategy: Strategy): boolean {
  const haystack = flattened(query.sourceContent).toLowerCase();
  const selected = patterns(query, strategy);
  return strategy === "token_or"
    ? selected.some((pattern) => haystack.includes(pattern.toLowerCase()))
    : haystack.includes(selected[0]!.toLowerCase());
}

async function rgCount(bundlePath: string, selected: readonly string[]): Promise<{ count: number; latencyMs: number }> {
  const started = performance.now();
  const process = Bun.spawn([
    "rg", "--count", "--fixed-strings", "--ignore-case", "--no-messages",
    ...selected.flatMap((pattern) => ["-e", pattern]), bundlePath,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const latencyMs = performance.now() - started;
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`ripgrep failed (${exitCode}): ${stderr.slice(0, 500)}`);
  }
  return { count: stdout.trim() ? Number(stdout.trim()) : 0, latencyMs };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

async function writeJsonExclusive(filePath: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const source = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, source, { flag: "wx", mode: 0o600 });
  return sha256(source);
}

async function main(): Promise<void> {
  const [bundleArg, privateArg, aggregateArg] = process.argv.slice(2);
  if (!bundleArg || !privateArg || !aggregateArg) {
    throw new Error("usage: file-bundle-benchmark <bundle> <private-output> <aggregate-output>");
  }
  const bundlePath = path.resolve(bundleArg);
  const privateOutput = path.resolve(privateArg);
  const aggregateOutput = path.resolve(aggregateArg);
  const db = await connectDb(loadConfig());
  try {
    const queries = await selectQueries(db);
    const documents = await selectAll<Pick<SourceDocument, "id" | "content">>(
      db,
      "SELECT id, content FROM search_document ORDER BY id",
    );
    const buildStarted = performance.now();
    const bundle = documents.map((document) => `${flattened(document.content)}\n`).join("");
    await mkdir(path.dirname(bundlePath), { recursive: true, mode: 0o700 });
    await writeFile(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    const buildMs = performance.now() - buildStarted;

    for (const query of queries) {
      for (const strategy of STRATEGIES) await rgCount(bundlePath, patterns(query, strategy));
    }
    const measurements: Array<Record<string, unknown>> = [];
    for (let repeat = 1; repeat <= 2; repeat += 1) {
      for (const query of queries) {
        for (const strategy of STRATEGIES) {
          const result = await rgCount(bundlePath, patterns(query, strategy));
          measurements.push({
            queryId: query.id,
            strategy,
            repeat,
            latencyMs: result.latencyMs,
            matchedDocuments: result.count,
            expectedSourceDocumentFound: sourceMatches(query, strategy),
          });
        }
      }
    }
    const aggregates = STRATEGIES.flatMap((strategy) => ["all", "verbatim", "keywords"].map((slice) => {
      const group = measurements.filter((row) => row.strategy === strategy &&
        (slice === "all" || queries.find((query) => query.id === row.queryId)?.variant === slice));
      return {
        slice,
        strategy,
        samples: group.length,
        queries: new Set(group.map((row) => row.queryId)).size,
        sourceDocumentRecall: round(mean(group.map((row) => Number(row.expectedSourceDocumentFound)))),
        latencyP50Ms: round(percentile(group.map((row) => Number(row.latencyMs)), 0.5), 1),
        latencyP95Ms: round(percentile(group.map((row) => Number(row.latencyMs)), 0.95), 1),
        matchedDocumentsMedian: round(percentile(group.map((row) => Number(row.matchedDocuments)), 0.5), 1),
        matchedDocumentsP95: round(percentile(group.map((row) => Number(row.matchedDocuments)), 0.95), 1),
      };
    }));
    const generatedAt = new Date().toISOString();
    const configuration = {
      queries: queries.length,
      corpusDocuments: documents.length,
      bundleBytes: Buffer.byteLength(bundle),
      bundleBuildMs: round(buildMs, 1),
      repeats: 2,
      layout: "one flattened UTF-8 line per search_document in one bundle file",
      ranking: "none; ripgrep returns an unranked candidate set",
    };
    const privateArtifact = {
      formatVersion: 1,
      generatedAt,
      configuration,
      queryBindings: queries.map(({ query: _query, sourceContent: _sourceContent, ...binding }) => binding),
      measurements,
      aggregates,
    };
    const aggregateArtifact = {
      formatVersion: 1,
      generatedAt,
      status: "partial",
      configuration,
      aggregates,
      privateArtifactFileSha256: "",
    };
    aggregateArtifact.privateArtifactFileSha256 = await writeJsonExclusive(privateOutput, privateArtifact);
    await writeJsonExclusive(aggregateOutput, aggregateArtifact);
    console.log(JSON.stringify({ configuration, aggregates: aggregates.filter((row) => row.slice === "all") }, null, 2));
  } finally {
    await db.close();
  }
}

await main();
