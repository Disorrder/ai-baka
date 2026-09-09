/**
 * Exact token-count workflow for Stage 11 (docs/plan.md §13.2, §20 этап 11).
 *
 * Existing search_document.token_count remains the chars/3.5 heuristic used
 * by segmentation and embeddingsPlan. This module adds an explicit exact
 * seam: a trusted tokenizer receives batches locally, counts are tied to
 * content SHA-256, and a private reproducible report is produced before a
 * paid/full backfill. No tokenizer/model price is guessed in this module.
 */

import { createHash } from "node:crypto";
import type { RecordId, Surreal } from "surrealdb";
import { writePrivateFileAtomic } from "../backup/safety.ts";
import { selectAll } from "../db/repositories/helpers.ts";
import { MAX_TOKENS, TARGET_TOKENS } from "../search/segmenter.ts";
import { EMPTY_PRIVACY_POLICY, privacyExclusion, type PrivacyPolicy } from "./privacy.ts";

export const EXACT_TOKEN_REPORT_FORMAT_VERSION = 1;
/** API limit is 8192; valid inputs must be strictly smaller (§13.2/§13.4). */
export const EMBEDDING_MODEL_TOKEN_LIMIT = 8192;
export const EXACT_TOKENIZER_ID =
  "ai-baka-exact-tokenizer/1+script@1+tiktoken@0.14.0";

export interface EligibleCorpusDocument {
  id: string;
  contentSha256: string;
}

export interface EligibleCorpusFingerprint {
  algorithm: "sha256";
  sha256: string;
  documents: number;
}

export interface ExactTokenCounter {
  /** Stable implementation/version id, e.g. "tiktoken@0.8.0/cl100k_base". */
  readonly id: string;
  /** Embedding model whose tokenizer is used. */
  readonly model: string;
  countBatch(texts: readonly string[]): Promise<readonly number[]>;
}

export interface TokenCountDocument {
  id: string;
  content: string;
  contentSha256?: string;
}

export interface ExactTokenDocumentResult {
  id: string;
  contentSha256: string;
  tokens: number;
}

export interface ExactTokenCountReport {
  formatVersion: 1;
  method: "exact";
  generatedAt: string;
  tokenizer: {
    id: string;
    model: string;
  };
  corpus: {
    documents: number;
    fingerprintSha256: string;
  };
  counts: {
    totalTokens: number;
    maximumDocumentTokens: number;
    overTarget: number;
    overSegmentationMax: number;
    atOrOverModelLimit: number;
  };
  price?: {
    configuredPricePer1MTokens: number;
    exactPriceUsd: number;
  };
  documents: ExactTokenDocumentResult[];
}

export interface ExactTokenCountOptions {
  batchSize?: number;
  pricePer1MTokens?: number;
  now?: () => Date;
  onProgress?: (progress: { documents: number; tokens: number }) => void;
}

export interface ExactTokenCountSummary {
  totalTokens: number;
  maximumDocumentTokens: number;
  overTarget: number;
  overSegmentationMax: number;
  atOrOverModelLimit: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonical Stage 11 corpus identity shared by evaluation, exact counting and
 * paid backfill. Eligibility/privacy filtering happens before this function;
 * only stable document ids and verified content hashes enter the digest.
 */
export function eligibleCorpusFingerprint(
  documents: readonly EligibleCorpusDocument[],
): EligibleCorpusFingerprint {
  const hash = createHash("sha256");
  const ids = new Set<string>();
  for (const doc of [...documents].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!doc.id.trim() || ids.has(doc.id) || !/^[0-9a-f]{64}$/.test(doc.contentSha256)) {
      throw new Error("eligible corpus fingerprint: invalid/duplicate document binding");
    }
    ids.add(doc.id);
    hash.update(`${doc.id}\0${doc.contentSha256}\n`);
  }
  return { algorithm: "sha256", sha256: hash.digest("hex"), documents: documents.length };
}

async function* toAsync<T>(source: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
  for await (const value of source) yield value;
}

/**
 * Scale-safe aggregate for large corpora. A loop is deliberate: spreading a
 * production-sized document array into Math.max can exceed the engine's
 * argument limit even though the report itself fits in memory.
 */
export function summarizeExactTokenCounts(
  counts: Iterable<number>,
): ExactTokenCountSummary {
  let totalTokens = 0;
  let maximumDocumentTokens = 0;
  let overTarget = 0;
  let overSegmentationMax = 0;
  let atOrOverModelLimit = 0;
  for (const tokens of counts) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error("exact token aggregate: count должен быть целым числом >= 0");
    }
    totalTokens += tokens;
    if (!Number.isSafeInteger(totalTokens)) {
      throw new Error("exact token aggregate: totalTokens превышает safe integer");
    }
    maximumDocumentTokens = Math.max(maximumDocumentTokens, tokens);
    if (tokens > TARGET_TOKENS) overTarget += 1;
    if (tokens > MAX_TOKENS) overSegmentationMax += 1;
    if (tokens >= EMBEDDING_MODEL_TOKEN_LIMIT) atOrOverModelLimit += 1;
  }
  return {
    totalTokens,
    maximumDocumentTokens,
    overTarget,
    overSegmentationMax,
    atOrOverModelLimit,
  };
}

/**
 * Считает exact tokens пакетами и никогда не сохраняет content в report.
 * Переданный contentSha256 перепроверяется, чтобы report нельзя было
 * случайно привязать к другой revision корпуса.
 */
export async function countExactTokens(
  source: Iterable<TokenCountDocument> | AsyncIterable<TokenCountDocument>,
  counter: ExactTokenCounter,
  options: ExactTokenCountOptions = {},
): Promise<ExactTokenCountReport> {
  if (!counter.id.trim() || !counter.model.trim()) {
    throw new Error("exact tokenizer должен иметь непустые id и model");
  }
  const batchSize = options.batchSize ?? 64;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error(`некорректный exact token batchSize: ${batchSize}`);
  }
  if (
    options.pricePer1MTokens !== undefined &&
    (!Number.isFinite(options.pricePer1MTokens) || options.pricePer1MTokens < 0)
  ) {
    throw new Error("pricePer1MTokens должен быть конечным числом >= 0");
  }

  const seen = new Set<string>();
  const documents: ExactTokenDocumentResult[] = [];
  let batch: TokenCountDocument[] = [];
  let runningTokens = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const counts = await counter.countBatch(batch.map((doc) => doc.content));
    if (counts.length !== batch.length) {
      throw new Error(
        `exact tokenizer ${counter.id} вернул ${counts.length} counts для ${batch.length} inputs`,
      );
    }
    counts.forEach((rawCount, index) => {
      if (!Number.isSafeInteger(rawCount) || rawCount < 0) {
        throw new Error(`exact tokenizer ${counter.id}: некорректный count[${index}] = ${rawCount}`);
      }
      const doc = batch[index]!;
      const actualHash = sha256(doc.content);
      if (doc.contentSha256 && doc.contentSha256 !== actualHash) {
        throw new Error(`content SHA-256 не совпадает для search_document ${doc.id}`);
      }
      documents.push({ id: doc.id, contentSha256: actualHash, tokens: rawCount });
      runningTokens += rawCount;
    });
    batch = [];
    options.onProgress?.({ documents: documents.length, tokens: runningTokens });
  };

  for await (const doc of toAsync(source)) {
    if (!doc.id.trim()) throw new Error("search_document id не может быть пустым");
    if (seen.has(doc.id)) throw new Error(`дубликат search_document id ${doc.id}`);
    seen.add(doc.id);
    batch.push(doc);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  if (documents.length === 0) throw new Error("exact token count: корпус пуст");
  documents.sort((a, b) => a.id.localeCompare(b.id));

  const counts = summarizeExactTokenCounts(documents.map((doc) => doc.tokens));
  const price = options.pricePer1MTokens;
  return {
    formatVersion: EXACT_TOKEN_REPORT_FORMAT_VERSION,
    method: "exact",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    tokenizer: { id: counter.id, model: counter.model },
    corpus: {
      documents: documents.length,
      fingerprintSha256: eligibleCorpusFingerprint(documents).sha256,
    },
    counts,
    price:
      price === undefined
        ? undefined
        : {
            configuredPricePer1MTokens: price,
            exactPriceUsd: (counts.totalTokens / 1_000_000) * price,
          },
    documents,
  };
}

interface SearchDocumentTokenRow {
  id: RecordId;
  content: string;
  content_sha256?: string;
  document_type: string;
  harness?: string;
  workspace?: string;
}

/**
 * Lazy DB source: deterministic order + bounded batches. Content существует
 * только в текущем batch и не попадает в report/logs.
 */
async function* searchDocuments(
  db: Surreal,
  pageSize: number,
  privacy: PrivacyPolicy,
): AsyncIterable<TokenCountDocument> {
  let start = 0;
  for (;;) {
    const rows = await selectAll<SearchDocumentTokenRow>(
      db,
      `SELECT id, content, content_sha256, document_type,
         dialogue.harness_installation.harness.slug AS harness,
         dialogue.workspace.name AS workspace
       FROM search_document
       ORDER BY id LIMIT $limit START $start`,
      { limit: pageSize, start },
    );
    for (const row of rows) {
      if (privacyExclusion({
        harness: row.harness,
        workspace: row.workspace,
        documentType: row.document_type,
        contentBytes: Buffer.byteLength(row.content, "utf8"),
      }, privacy)) continue;
      yield {
        id: String(row.id),
        content: row.content,
        contentSha256: row.content_sha256,
      };
    }
    if (rows.length < pageSize) return;
    start += rows.length;
  }
}

export interface ExactEmbeddingsPlanOptions extends ExactTokenCountOptions {
  pageSize?: number;
  privacy?: PrivacyPolicy;
}

/** Read-only exact plan по живому search_document corpus. */
export async function exactEmbeddingsPlan(
  db: Surreal,
  counter: ExactTokenCounter,
  options: ExactEmbeddingsPlanOptions = {},
): Promise<ExactTokenCountReport> {
  const pageSize = options.pageSize ?? 250;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 2000) {
    throw new Error(`некорректный token count pageSize: ${pageSize}`);
  }
  return countExactTokens(
    searchDocuments(db, pageSize, options.privacy ?? EMPTY_PRIVACY_POLICY),
    counter,
    options,
  );
}

export interface CommandTokenCounterOptions {
  executable: string;
  args?: readonly string[];
  /** Override when the executable consumes argv itself (for example bun -e). */
  versionArgs?: readonly string[];
  id: string;
  model: string;
  env?: Record<string, string>;
  /** Require uv's no-network mode after dependencies/encoding are cached. */
  requireOffline?: boolean;
}

interface CommandTokenizerVersion {
  id: "ai-baka-exact-tokenizer";
  protocolVersion: 1;
  scriptVersion: 1;
  package: { name: "tiktoken"; version: "0.14.0" };
  resolver: "encoding_for_model";
}

const EXPECTED_COMMAND_TOKENIZER_VERSION: CommandTokenizerVersion = {
  id: "ai-baka-exact-tokenizer",
  protocolVersion: 1,
  scriptVersion: 1,
  package: { name: "tiktoken", version: "0.14.0" },
  resolver: "encoding_for_model",
};

/**
 * Adapter для локального exact tokenizer без package dependency.
 *
 * Protocol одного batch:
 * stdin  = {"model":"...","texts":["..."]}\n
 * stdout = {"counts":[1,2,...]}\n
 *
 * Команда запускается argv-массивом (без shell). Вызывающий код явно
 * выбирает доверенный executable; adapter сам сеть не использует.
 */
export function createCommandTokenCounter(options: CommandTokenCounterOptions): ExactTokenCounter {
  if (!options.executable.trim()) throw new Error("tokenizer executable не задан");
  if (options.requireOffline && !(options.args ?? []).includes("--offline")) {
    throw new Error("exact tokenizer offline mode requires --offline in argv");
  }
  // Не передаём tokenizer-процессу OPENAI_API_KEY и другие случайные secrets.
  // Дополнительное окружение разрешается только явно через options.env.
  const safeEnv = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR"]
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const invoke = async (args: readonly string[], stdin?: string): Promise<string> => {
    const child = Bun.spawn({
      cmd: [options.executable, ...args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...safeEnv, ...options.env },
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `exact tokenizer ${options.id} завершился с code ${exitCode} (stderr bytes: ${new TextEncoder().encode(stderr).byteLength})`,
      );
    }
    return stdout;
  };
  let versionCheck: Promise<void> | undefined;
  const verifyVersion = (): Promise<void> => {
    versionCheck ??= (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await invoke(options.versionArgs ?? [...(options.args ?? []), "--version"]),
        );
      } catch {
        throw new Error("exact tokenizer version verification failed");
      }
      if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_COMMAND_TOKENIZER_VERSION)) {
        throw new Error("exact tokenizer version identity mismatch");
      }
    })();
    return versionCheck;
  };
  return {
    id: EXACT_TOKENIZER_ID,
    model: options.model,
    async countBatch(texts: readonly string[]): Promise<readonly number[]> {
      await verifyVersion();
      const stdout = await invoke(
        options.args ?? [],
        JSON.stringify({ model: options.model, texts }),
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`exact tokenizer ${options.id} вернул невалидный JSON`);
      }
      const counts =
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length === 1 &&
        Object.hasOwn(parsed, "counts") &&
        Array.isArray((parsed as { counts?: unknown }).counts)
          ? (parsed as { counts: unknown[] }).counts
          : undefined;
      if (!counts) throw new Error(`exact tokenizer ${options.id}: в JSON нет массива counts`);
      if (counts.length !== texts.length) {
        throw new Error(
          `exact tokenizer ${options.id}: counts length ${counts.length} != inputs ${texts.length}`,
        );
      }
      if (
        counts.some(
          (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
        )
      ) {
        throw new Error(`exact tokenizer ${options.id}: counts должны быть целыми JSON numbers >= 0`);
      }
      return counts as number[];
    },
  };
}

/** Stable private JSON report; content в нём отсутствует. */
export function serializeExactTokenCountReport(report: ExactTokenCountReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** mode 0600, overwrite только явно. */
export async function writeExactTokenCountReport(
  filePath: string,
  report: ExactTokenCountReport,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await writePrivateFileAtomic(
    filePath,
    serializeExactTokenCountReport(report),
    options,
  );
}

/**
 * Recomputes fingerprint from report rows and verifies its internal
 * consistency before a production gate consumes it.
 */
export function validateExactTokenCountReport(report: ExactTokenCountReport): void {
  if (!report || typeof report !== "object") {
    throw new Error("exact token report: ожидался object");
  }
  if (report.formatVersion !== EXACT_TOKEN_REPORT_FORMAT_VERSION || report.method !== "exact") {
    throw new Error("неподдерживаемый exact token report");
  }
  if (
    typeof report.generatedAt !== "string" ||
    report.generatedAt.trim() === "" ||
    Number.isNaN(Date.parse(report.generatedAt))
  ) {
    throw new Error("exact token report: generatedAt должен быть валидной датой");
  }
  if (
    !report.tokenizer ||
    typeof report.tokenizer.id !== "string" ||
    report.tokenizer.id.trim() === "" ||
    typeof report.tokenizer.model !== "string" ||
    report.tokenizer.model.trim() === ""
  ) {
    throw new Error("exact token report: tokenizer id/model не заданы");
  }
  if (
    !report.corpus ||
    !Number.isSafeInteger(report.corpus.documents) ||
    report.corpus.documents < 1 ||
    !/^[0-9a-f]{64}$/.test(report.corpus.fingerprintSha256)
  ) {
    throw new Error("exact token report: некорректный corpus metadata");
  }
  if (!Array.isArray(report.documents)) {
    throw new Error("exact token report: documents должен быть массивом");
  }
  if (report.documents.length !== report.corpus.documents || report.documents.length === 0) {
    throw new Error("exact token report: document count не совпадает");
  }
  const documentIds = new Set<string>();
  for (const doc of report.documents) {
    if (!doc || typeof doc !== "object" || typeof doc.id !== "string" || doc.id.trim() === "") {
      throw new Error("exact token report: document id не может быть пустым");
    }
    if (documentIds.has(doc.id)) throw new Error("exact token report: дубликаты document id");
    documentIds.add(doc.id);
    if (!/^[0-9a-f]{64}$/.test(doc.contentSha256)) {
      throw new Error(`exact token report: некорректный SHA-256 для ${doc.id}`);
    }
    if (!Number.isSafeInteger(doc.tokens) || doc.tokens < 0) {
      throw new Error(`exact token report: некорректный token count для ${doc.id}`);
    }
  }
  if (eligibleCorpusFingerprint(report.documents).sha256 !== report.corpus.fingerprintSha256) {
    throw new Error("exact token report: corpus fingerprint не совпадает");
  }
  if (!report.counts || typeof report.counts !== "object") {
    throw new Error("exact token report: counts не заданы");
  }
  const expected = summarizeExactTokenCounts(report.documents.map((doc) => doc.tokens));
  if (report.counts.totalTokens !== expected.totalTokens) {
    throw new Error("exact token report: totalTokens не совпадает с document counts");
  }
  if (
    report.counts.maximumDocumentTokens !== expected.maximumDocumentTokens ||
    report.counts.overTarget !== expected.overTarget ||
    report.counts.overSegmentationMax !== expected.overSegmentationMax ||
    report.counts.atOrOverModelLimit !== expected.atOrOverModelLimit
  ) {
    throw new Error("exact token report: aggregate counts не совпадают с document counts");
  }
  if (report.price !== undefined) {
    if (
      !report.price ||
      !Number.isFinite(report.price.configuredPricePer1MTokens) ||
      report.price.configuredPricePer1MTokens < 0 ||
      !Number.isFinite(report.price.exactPriceUsd) ||
      report.price.exactPriceUsd < 0 ||
      report.price.exactPriceUsd !==
        (report.counts.totalTokens / 1_000_000) * report.price.configuredPricePer1MTokens
    ) {
      throw new Error("exact token report: price не совпадает с configured formula");
    }
  }
}
