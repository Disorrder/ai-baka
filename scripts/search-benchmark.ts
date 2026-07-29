import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { RecordId, Surreal } from "surrealdb";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/db/client.ts";
import { selectAll } from "../src/db/repositories/helpers.ts";
import { OpenAIEmbeddingProvider } from "../src/embeddings/openai-provider.ts";
import type { EmbedResult, EmbeddingProvider } from "../src/embeddings/provider.ts";
import { getActiveSpace, type EmbeddingSpace } from "../src/embeddings/spaces.ts";
import { HARNESS_ORDER } from "../src/sources/adapters/harnesses.ts";
import { searchText, type SearchFilters, type SearchHit } from "../src/search/fulltext.ts";
import {
  searchHybridInSpace,
  searchVectorInSpace,
} from "../src/search/hybrid.ts";

type SearchMode = "text" | "vector" | "hybrid";
type QueryVariant = "verbatim" | "keywords";
type DocumentType = "user_prompt" | "assistant_final";

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
  querySha256: string;
  sourceDocumentId: string;
  sourceContentSha256: string;
  expectedDialogueId: string;
  harness: string;
  documentType: DocumentType;
  variant: QueryVariant;
  queryCharacters: number;
  queryTokensApprox: number;
}

interface RetrievalMeasurement {
  queryId: string;
  mode: SearchMode;
  latencyMs: number;
  providerMs: number;
  returnedDocuments: number;
  returnedDialogues: number;
  expectedDialogueRank: number | null;
  reciprocalRankAt10: number;
  hitAt1: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  topDialogueIds: string[];
}

interface EndToEndMeasurement extends RetrievalMeasurement {
  repeat: number;
  providerPromptTokens: number;
}

type FileSearchStrategy = "literal_phrase" | "token_or";

interface FileSearchMeasurement {
  queryId: string;
  strategy: FileSearchStrategy;
  repeat: number;
  latencyMs: number;
  matchedFiles: number;
  matchedDialogues: number;
  expectedSourceDocumentFound: boolean;
  expectedDialogueFound: boolean;
}

interface CliOptions {
  privateOutput: string;
  aggregateOutput: string;
  perHarness: number;
  resultLimit: number;
  e2eRepeats: number;
  fileCorpusDir: string | null;
  fileRepeats: number;
}

const SEARCH_MODES: readonly SearchMode[] = ["text", "vector", "hybrid"];
const DOCUMENT_TYPES: readonly DocumentType[] = ["user_prompt", "assistant_final"];
const WORD_RE = /[\p{L}\p{N}_./:+#@-]{3,}/gu;
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "between", "could",
  "does", "from", "have", "into", "more", "only", "other", "should", "some", "such",
  "than", "that", "their", "then", "there", "these", "they", "this", "those", "through",
  "using", "very", "want", "what", "when", "where", "which", "while", "with", "would",
  "без", "более", "быть", "будет", "вот", "всего", "где", "для", "если", "есть", "ещё",
  "как", "какие", "когда", "который", "между", "может", "можно", "надо", "нужно", "после",
  "почему", "при", "про", "сделать", "так", "также", "только", "уже", "чтобы", "этого", "это",
]);

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label}: expected positive integer`);
  return parsed;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: search-benchmark --private-output <path> --aggregate-output <path>");
    }
    values.set(key, value);
  }
  const privateOutput = values.get("--private-output");
  const aggregateOutput = values.get("--aggregate-output");
  if (!privateOutput || !aggregateOutput) {
    throw new Error("--private-output and --aggregate-output are required");
  }
  return {
    privateOutput: path.resolve(privateOutput),
    aggregateOutput: path.resolve(aggregateOutput),
    perHarness: parsePositiveInteger(values.get("--per-harness"), 4, "--per-harness"),
    resultLimit: parsePositiveInteger(values.get("--result-limit"), 30, "--result-limit"),
    e2eRepeats: parsePositiveInteger(values.get("--e2e-repeats"), 2, "--e2e-repeats"),
    fileCorpusDir: values.get("--file-corpus-dir")
      ? path.resolve(values.get("--file-corpus-dir")!)
      : null,
    fileRepeats: parsePositiveInteger(values.get("--file-repeats"), 2, "--file-repeats"),
  };
}

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

function buildQuery(document: SourceDocument, variant: QueryVariant, ordinal: number): BenchmarkQuery | undefined {
  const query = variant === "verbatim" ? verbatimQuery(document) : keywordQuery(document);
  if (!query || query.length > 500) return undefined;
  return {
    id: `q_${sha256(`${document.id}:${variant}:${ordinal}`).slice(0, 16)}`,
    query,
    querySha256: sha256(query),
    sourceDocumentId: String(document.id),
    sourceContentSha256: document.content_sha256,
    expectedDialogueId: String(document.dialogue_id),
    harness: document.harness,
    documentType: document.document_type,
    variant,
    queryCharacters: query.length,
    queryTokensApprox: query.split(/\s+/).length,
  };
}

async function selectDocuments(db: Surreal, perHarness: number): Promise<BenchmarkQuery[]> {
  if (perHarness % DOCUMENT_TYPES.length !== 0) {
    throw new Error("--per-harness must be divisible by two to balance document types");
  }
  const perType = perHarness / DOCUMENT_TYPES.length;
  const selected: BenchmarkQuery[] = [];
  for (const harness of HARNESS_ORDER) {
    for (const documentType of DOCUMENT_TYPES) {
      const rows = await selectAll<SourceDocument>(
        db,
        `SELECT id, dialogue.id AS dialogue_id, content, content_sha256,
           dialogue.harness_installation.harness.slug AS harness,
           document_type
         FROM search_document
         WHERE document_type = $documentType
           AND dialogue.harness_installation.harness.slug = $harness
           AND string::len(content) >= 80
         ORDER BY id
         LIMIT 100`,
        { harness, documentType },
      );
      let accepted = 0;
      for (const row of rows) {
        const variant: QueryVariant = accepted % 2 === 0 ? "verbatim" : "keywords";
        const query = buildQuery(row, variant, accepted);
        if (!query) continue;
        selected.push(query);
        accepted += 1;
        if (accepted === perType) break;
      }
      if (accepted !== perType) {
        throw new Error(`${harness}/${documentType}: selected ${accepted}/${perType} benchmark queries`);
      }
    }
  }
  return selected;
}

class CachedProvider implements EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  constructor(
    source: EmbeddingProvider,
    private readonly vectors: ReadonlyMap<string, number[]>,
  ) {
    this.provider = source.provider;
    this.model = source.model;
    this.dimensions = source.dimensions;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return {
      vectors: texts.map((text) => {
        const vector = this.vectors.get(text);
        if (!vector) throw new Error(`cached embedding missing: ${sha256(text)}`);
        return vector;
      }),
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }
}

class TimedProvider implements EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  lastLatencyMs = 0;
  lastPromptTokens = 0;
  constructor(private readonly delegate: EmbeddingProvider) {
    this.provider = delegate.provider;
    this.model = delegate.model;
    this.dimensions = delegate.dimensions;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const started = performance.now();
    const result = await this.delegate.embed(texts);
    this.lastLatencyMs = performance.now() - started;
    this.lastPromptTokens = result.usage.promptTokens;
    return result;
  }
}

function defaultFilters(limit: number): SearchFilters {
  return {
    deletedOnly: false,
    includeReasoning: false,
    includeTools: false,
    includeSystem: false,
    allRevisions: false,
    limit,
  };
}

async function executeSearch(
  db: Surreal,
  space: EmbeddingSpace,
  provider: EmbeddingProvider,
  query: string,
  mode: SearchMode,
  limit: number,
): Promise<SearchHit[]> {
  const filters = defaultFilters(limit);
  if (mode === "text") return searchText(db, query, filters);
  if (mode === "vector") return searchVectorInSpace(db, provider, space, query, filters);
  return searchHybridInSpace(db, provider, space, query, filters);
}

function uniqueDialogueIds(hits: readonly SearchHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.dialogueId))];
}

function retrievalMeasurement(
  query: BenchmarkQuery,
  mode: SearchMode,
  latencyMs: number,
  providerMs: number,
  hits: readonly SearchHit[],
): RetrievalMeasurement {
  const dialogues = uniqueDialogueIds(hits);
  const index = dialogues.indexOf(query.expectedDialogueId);
  const rank = index >= 0 ? index + 1 : null;
  return {
    queryId: query.id,
    mode,
    latencyMs,
    providerMs,
    returnedDocuments: hits.length,
    returnedDialogues: dialogues.length,
    expectedDialogueRank: rank,
    reciprocalRankAt10: rank !== null && rank <= 10 ? 1 / rank : 0,
    hitAt1: rank === 1,
    hitAt5: rank !== null && rank <= 5,
    hitAt10: rank !== null && rank <= 10,
    topDialogueIds: dialogues.slice(0, 10),
  };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index]!;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function aggregateRetrieval(
  queries: readonly BenchmarkQuery[],
  rows: readonly RetrievalMeasurement[],
): Array<Record<string, unknown>> {
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const groups = new Map<string, RetrievalMeasurement[]>();
  for (const row of rows) {
    const query = queryById.get(row.queryId)!;
    for (const key of [`all:${row.mode}`, `${query.variant}:${row.mode}`, `${query.documentType}:${row.mode}`]) {
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  }
  return [...groups.entries()].map(([key, group]) => {
    const [slice, mode] = key.split(":") as [string, SearchMode];
    return {
      slice,
      mode,
      queries: group.length,
      hitAt1: round(mean(group.map((row) => Number(row.hitAt1)))),
      hitAt5: round(mean(group.map((row) => Number(row.hitAt5)))),
      hitAt10: round(mean(group.map((row) => Number(row.hitAt10)))),
      mrrAt10: round(mean(group.map((row) => row.reciprocalRankAt10))),
      latencyP50Ms: round(percentile(group.map((row) => row.latencyMs), 0.5), 1),
      latencyP95Ms: round(percentile(group.map((row) => row.latencyMs), 0.95), 1),
      returnedDialoguesMean: round(mean(group.map((row) => row.returnedDialogues)), 1),
    };
  }).sort((a, b) => String(a.slice).localeCompare(String(b.slice)) || String(a.mode).localeCompare(String(b.mode)));
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 1 : intersection / union;
}

function aggregateAgreement(rows: readonly RetrievalMeasurement[]): Array<Record<string, unknown>> {
  const byQuery = new Map<string, Map<SearchMode, RetrievalMeasurement>>();
  for (const row of rows) {
    const modes = byQuery.get(row.queryId) ?? new Map<SearchMode, RetrievalMeasurement>();
    modes.set(row.mode, row);
    byQuery.set(row.queryId, modes);
  }
  const pairs: Array<[SearchMode, SearchMode]> = [["text", "vector"], ["text", "hybrid"], ["vector", "hybrid"]];
  return pairs.map(([left, right]) => {
    const values = [...byQuery.values()].map((modes) =>
      jaccard(modes.get(left)?.topDialogueIds ?? [], modes.get(right)?.topDialogueIds ?? []));
    return { left, right, queries: values.length, top10DialogueJaccardMean: round(mean(values)) };
  });
}

function aggregateEndToEnd(rows: readonly EndToEndMeasurement[]): Array<Record<string, unknown>> {
  return SEARCH_MODES.map((mode) => {
    const group = rows.filter((row) => row.mode === mode);
    return {
      mode,
      samples: group.length,
      latencyP50Ms: round(percentile(group.map((row) => row.latencyMs), 0.5), 1),
      latencyP95Ms: round(percentile(group.map((row) => row.latencyMs), 0.95), 1),
      providerP50Ms: round(percentile(group.map((row) => row.providerMs), 0.5), 1),
      providerP95Ms: round(percentile(group.map((row) => row.providerMs), 0.95), 1),
      promptTokens: group.reduce((sum, row) => sum + row.providerPromptTokens, 0),
    };
  });
}

async function writeFileCorpus(
  db: Surreal,
  corpusDir: string,
): Promise<{
  documents: number;
  bytes: number;
  buildMs: number;
  fileByDocumentId: Map<string, string>;
  dialogueByFile: Map<string, string>;
}> {
  const started = performance.now();
  await mkdir(corpusDir, { recursive: true, mode: 0o700 });
  const documents = await selectAll<Pick<SourceDocument, "id" | "dialogue_id" | "content">>(
    db,
    "SELECT id, dialogue.id AS dialogue_id, content FROM search_document ORDER BY id",
  );
  const fileByDocumentId = new Map<string, string>();
  const dialogueByFile = new Map<string, string>();
  let bytes = 0;
  const concurrency = 64;
  for (let offset = 0; offset < documents.length; offset += concurrency) {
    await Promise.all(documents.slice(offset, offset + concurrency).map(async (document) => {
      const fileName = `doc_${sha256(String(document.id))}.txt`;
      const content = `${document.content}\n`;
      await writeFile(path.join(corpusDir, fileName), content, { flag: "wx", mode: 0o600 });
      fileByDocumentId.set(String(document.id), fileName);
      dialogueByFile.set(fileName, String(document.dialogue_id));
      bytes += Buffer.byteLength(content);
    }));
  }
  return {
    documents: documents.length,
    bytes,
    buildMs: performance.now() - started,
    fileByDocumentId,
    dialogueByFile,
  };
}

async function runRipgrep(
  corpusDir: string,
  query: BenchmarkQuery,
  strategy: FileSearchStrategy,
  repeat: number,
  fileByDocumentId: ReadonlyMap<string, string>,
  dialogueByFile: ReadonlyMap<string, string>,
): Promise<FileSearchMeasurement> {
  const patterns = strategy === "literal_phrase"
    ? [query.query]
    : [...new Set(tokens(query.query))];
  const args = [
    "rg",
    "--files-with-matches",
    "--fixed-strings",
    "--ignore-case",
    "--no-ignore",
    "--no-messages",
    "--glob",
    "*.txt",
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    ".",
  ];
  const started = performance.now();
  const process = Bun.spawn(args, { cwd: corpusDir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const latencyMs = performance.now() - started;
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`ripgrep failed (${exitCode}): ${stderr.slice(0, 500)}`);
  }
  const matchedFiles = stdout.trim()
    ? stdout.trim().split("\n").map((file) => path.basename(file))
    : [];
  const matchedDialogues = new Set(
    matchedFiles.map((file) => dialogueByFile.get(file)).filter((value): value is string => Boolean(value)),
  );
  return {
    queryId: query.id,
    strategy,
    repeat,
    latencyMs,
    matchedFiles: matchedFiles.length,
    matchedDialogues: matchedDialogues.size,
    expectedSourceDocumentFound: matchedFiles.includes(fileByDocumentId.get(query.sourceDocumentId) ?? ""),
    expectedDialogueFound: matchedDialogues.has(query.expectedDialogueId),
  };
}

function aggregateFileSearch(
  queries: readonly BenchmarkQuery[],
  rows: readonly FileSearchMeasurement[],
): Array<Record<string, unknown>> {
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const groups = new Map<string, FileSearchMeasurement[]>();
  for (const row of rows) {
    const query = queryById.get(row.queryId)!;
    for (const key of [`all:${row.strategy}`, `${query.variant}:${row.strategy}`]) {
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
  }
  return [...groups.entries()].map(([key, group]) => {
    const [slice, strategy] = key.split(":") as [string, FileSearchStrategy];
    return {
      slice,
      strategy,
      samples: group.length,
      queries: new Set(group.map((row) => row.queryId)).size,
      sourceDocumentRecall: round(mean(group.map((row) => Number(row.expectedSourceDocumentFound)))),
      dialogueRecall: round(mean(group.map((row) => Number(row.expectedDialogueFound)))),
      latencyP50Ms: round(percentile(group.map((row) => row.latencyMs), 0.5), 1),
      latencyP95Ms: round(percentile(group.map((row) => row.latencyMs), 0.95), 1),
      matchedFilesMedian: round(percentile(group.map((row) => row.matchedFiles), 0.5), 1),
      matchedFilesP95: round(percentile(group.map((row) => row.matchedFiles), 0.95), 1),
      matchedDialoguesMedian: round(percentile(group.map((row) => row.matchedDialogues), 0.5), 1),
    };
  }).sort((a, b) => String(a.slice).localeCompare(String(b.slice)) ||
    String(a.strategy).localeCompare(String(b.strategy)));
}

async function writeJsonExclusive(filePath: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const source = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, source, { flag: "wx", mode: 0o600 });
  return sha256(source);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY is required for vector benchmark");
  const db = await connectDb(cfg);
  try {
    const space = await getActiveSpace(db);
    if (!space) throw new Error("active embedding space is required");
    const queries = await selectDocuments(db, options.perHarness);
    const provider = new OpenAIEmbeddingProvider({
      apiKey: cfg.openaiApiKey,
      model: space.model,
      dimensions: space.dimensions,
    });

    const batchStarted = performance.now();
    const batch = await provider.embed(queries.map((query) => query.query));
    const batchEmbeddingMs = performance.now() - batchStarted;
    const cached = new CachedProvider(
      provider,
      new Map(queries.map((query, index) => [query.query, batch.vectors[index]!])),
    );

    // Warm database/index caches before latency measurements.
    const warm = queries[0]!;
    for (const mode of SEARCH_MODES) {
      await executeSearch(db, space, cached, warm.query, mode, options.resultLimit);
    }

    const retrieval: RetrievalMeasurement[] = [];
    for (const query of queries) {
      for (const mode of SEARCH_MODES) {
        const started = performance.now();
        const hits = await executeSearch(db, space, cached, query.query, mode, options.resultLimit);
        retrieval.push(retrievalMeasurement(query, mode, performance.now() - started, 0, hits));
      }
    }

    const speedQueries = HARNESS_ORDER.map((harness) =>
      queries.find((query) => query.harness === harness && query.variant === "keywords") ??
        queries.find((query) => query.harness === harness)!).filter(Boolean);
    const timedProvider = new TimedProvider(provider);
    const endToEnd: EndToEndMeasurement[] = [];
    for (let repeat = 1; repeat <= options.e2eRepeats; repeat += 1) {
      for (const [queryIndex, query] of speedQueries.entries()) {
        const rotation = (repeat + queryIndex) % SEARCH_MODES.length;
        const modeOrder = [...SEARCH_MODES.slice(rotation), ...SEARCH_MODES.slice(0, rotation)];
        for (const mode of modeOrder) {
          timedProvider.lastLatencyMs = 0;
          timedProvider.lastPromptTokens = 0;
          const started = performance.now();
          const hits = await executeSearch(db, space, timedProvider, query.query, mode, options.resultLimit);
          endToEnd.push({
            ...retrievalMeasurement(
              query,
              mode,
              performance.now() - started,
              timedProvider.lastLatencyMs,
              hits,
            ),
            repeat,
            providerPromptTokens: timedProvider.lastPromptTokens,
          });
        }
      }
    }

    const corpus = await selectAll<{ documents: number; dialogues: number }>(
      db,
      "SELECT count() AS documents, array::len(array::distinct(dialogue)) AS dialogues FROM search_document GROUP ALL",
    );
    let fileCorpus: Awaited<ReturnType<typeof writeFileCorpus>> | null = null;
    const fileSearch: FileSearchMeasurement[] = [];
    if (options.fileCorpusDir) {
      fileCorpus = await writeFileCorpus(db, options.fileCorpusDir);
      for (const query of queries) {
        for (const strategy of ["literal_phrase", "token_or"] as const) {
          await runRipgrep(
            options.fileCorpusDir,
            query,
            strategy,
            0,
            fileCorpus.fileByDocumentId,
            fileCorpus.dialogueByFile,
          );
        }
      }
      for (let repeat = 1; repeat <= options.fileRepeats; repeat += 1) {
        for (const query of queries) {
          for (const strategy of ["literal_phrase", "token_or"] as const) {
            fileSearch.push(await runRipgrep(
              options.fileCorpusDir,
              query,
              strategy,
              repeat,
              fileCorpus.fileByDocumentId,
              fileCorpus.dialogueByFile,
            ));
          }
        }
      }
    }
    const generatedAt = new Date().toISOString();
    const retrievalAggregate = aggregateRetrieval(queries, retrieval);
    const agreement = aggregateAgreement(retrieval);
    const endToEndAggregate = aggregateEndToEnd(endToEnd);
    const fileSearchAggregate = aggregateFileSearch(queries, fileSearch);
    const providerPromptTokens = batch.usage.promptTokens + endToEnd.reduce(
      (sum, row) => sum + row.providerPromptTokens,
      0,
    );
    const estimatedProviderCostUsd = cfg.embeddings.pricePer1MTokens === undefined
      ? null
      : providerPromptTokens * cfg.embeddings.pricePer1MTokens / 1_000_000;

    const method = {
      kind: "known_item_retrieval_proxy",
      queryPopulation: `${options.perHarness} deterministic queries per harness, balanced across user_prompt/assistant_final and verbatim/keywords variants`,
      expectedItem: "dialogue owning the source search_document",
      rankingGrain: "unique dialogue",
      accuracyMetrics: ["Hit@1", "Hit@5", "Hit@10", "MRR@10"],
      latency: {
        databaseOnly: "warm-cache search with precomputed/cached query embeddings",
        endToEnd: "normal search path including one OpenAI query-embedding request for vector/hybrid",
        fileSearch: "warm filesystem cache; one ripgrep process per query against one UTF-8 file per search_document",
      },
      limitation: "Proxy measures known-item recovery, not human relevance; it cannot replace a reviewed judgment set.",
    };
    const privateArtifact = {
      formatVersion: 1,
      generatedAt,
      method,
      configuration: {
        activeSpace: {
          slug: space.slug,
          provider: space.provider,
          model: space.model,
          dimensions: space.dimensions,
        },
        corpus: corpus[0] ?? null,
        queries: queries.length,
        resultLimit: options.resultLimit,
        e2eRepeats: options.e2eRepeats,
        fileRepeats: options.fileCorpusDir ? options.fileRepeats : 0,
      },
      queryBindings: queries.map(({ query: _query, ...binding }) => binding),
      batchEmbedding: {
        latencyMs: round(batchEmbeddingMs, 1),
        promptTokens: batch.usage.promptTokens,
      },
      providerUsage: {
        promptTokens: providerPromptTokens,
        pricePer1MTokens: cfg.embeddings.pricePer1MTokens ?? null,
        estimatedCostUsd: estimatedProviderCostUsd === null ? null : round(estimatedProviderCostUsd, 6),
      },
      retrieval,
      endToEnd,
      fileSearch,
      fileCorpus: fileCorpus ? {
        documents: fileCorpus.documents,
        bytes: fileCorpus.bytes,
        buildMs: round(fileCorpus.buildMs, 1),
        projection: "one UTF-8 content file per search_document",
        ranking: "none; ripgrep returns an unranked candidate set",
      } : null,
      aggregates: {
        retrieval: retrievalAggregate,
        agreement,
        endToEnd: endToEndAggregate,
        fileSearch: fileSearchAggregate,
      },
    };
    const aggregateArtifact = {
      formatVersion: 1,
      generatedAt,
      status: "partial",
      method,
      configuration: privateArtifact.configuration,
      queryComposition: [...new Set(queries.map((query) => `${query.harness}:${query.documentType}:${query.variant}`))]
        .map((key) => {
          const [harness, documentType, variant] = key.split(":");
          return {
            harness,
            documentType,
            variant,
            queries: queries.filter((query) =>
              query.harness === harness && query.documentType === documentType && query.variant === variant).length,
          };
        }),
      providerUsage: privateArtifact.providerUsage,
      batchEmbedding: privateArtifact.batchEmbedding,
      retrieval: retrievalAggregate,
      agreement,
      endToEnd: endToEndAggregate,
      fileSearch: fileSearchAggregate,
      fileCorpus: privateArtifact.fileCorpus,
      privateArtifactFileSha256: "",
    };

    aggregateArtifact.privateArtifactFileSha256 = await writeJsonExclusive(
      options.privateOutput,
      privateArtifact,
    );
    await writeJsonExclusive(options.aggregateOutput, aggregateArtifact);
    console.log(JSON.stringify({
      generatedAt,
      queries: queries.length,
      privateOutput: options.privateOutput,
      aggregateOutput: options.aggregateOutput,
      providerPromptTokens,
      estimatedProviderCostUsd,
      retrieval: retrievalAggregate.filter((row) => row.slice === "all"),
      endToEnd: endToEndAggregate,
      fileSearch: fileSearchAggregate.filter((row) => row.slice === "all"),
    }, null, 2));
  } finally {
    await db.close();
  }
}

await main();
