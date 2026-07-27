/**
 * SurrealDB export places FULLTEXT indexes before table data. Restore strips
 * both legacy migration-owned definitions before bulk import, but defers only
 * `search_document_content` for rebuilding. `chunk_content` is an optional
 * forensic accelerator, not part of core backup recovery acceptance.
 */

import { once } from "node:events";
import { createReadStream, type WriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { withDecompressedStream } from "./compress.ts";
import {
  assertOpenAuthenticatedRegularFileUnchanged,
  openAuthenticatedRegularFile,
  type AuthenticatedRegularFileIdentity,
} from "./safety.ts";

export const RESTORE_STRIPPED_FULLTEXT_INDEXES = [
  "search_document_content",
  "chunk_content",
] as const;

export const RESTORE_FULLTEXT_INDEXES = ["search_document_content"] as const;

const RESTORE_FULLTEXT_TABLES = ["search_document", "chunk"] as const;
const RESTORE_FULLTEXT_INDEX_TABLES: Record<
  (typeof RESTORE_STRIPPED_FULLTEXT_INDEXES)[number],
  (typeof RESTORE_FULLTEXT_TABLES)[number]
> = {
  search_document_content: "search_document",
  chunk_content: "chunk",
};

interface DeferredIndex {
  name: string;
  table: string;
  statement: string;
}

function isStrippedFulltextIndex(
  name: string,
): name is (typeof RESTORE_STRIPPED_FULLTEXT_INDEXES)[number] {
  return (RESTORE_STRIPPED_FULLTEXT_INDEXES as readonly string[]).includes(name);
}

/** Masks literals/comments without changing offsets in the source string. */
function sqlCodeMask(input: string): string {
  const masked: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (lineComment) {
      masked.push(char === "\n" ? "\n" : " ");
      if (char === "\n") lineComment = false;
    } else if (blockComment) {
      masked.push(char === "\n" ? "\n" : " ");
      if (char === "*" && next === "/") {
        masked.push(" ");
        blockComment = false;
        i += 1;
      }
    } else if (quote) {
      masked.push(char === "\n" ? "\n" : " ");
      if (char === "\\") {
        if (next !== undefined) masked.push(next === "\n" ? "\n" : " ");
        i += 1;
      } else if (char === quote && next === quote) {
        masked.push(" ");
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === "-" && next === "-") {
      masked.push(" ", " ");
      lineComment = true;
      i += 1;
    } else if (char === "/" && next === "*") {
      masked.push(" ", " ");
      blockComment = true;
      i += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      masked.push(" ");
      quote = char;
    } else {
      masked.push(char);
    }
  }

  return masked.join("");
}

/** Offset immediately after the terminating semicolon, or -1 if incomplete. */
function statementEnd(input: string): number {
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\" || (char === quote && next === quote)) {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === ";") {
      return i + 1;
    }
  }

  return -1;
}

function fulltextIndexDefinition(
  statement: string,
): Pick<DeferredIndex, "name" | "table"> | undefined {
  const code = sqlCodeMask(statement);
  if (!/\bFULLTEXT\s+ANALYZER\b/iu.test(code)) return undefined;
  const name = /^\s*DEFINE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_][a-z0-9_]*)\b/iu
    .exec(code);
  const table = /\bON(?:\s+TABLE)?\s+([a-z_][a-z0-9_]*)\b/iu.exec(code);
  if (!name || !table) throw new Error("restore FULLTEXT DDL has an unsupported identity");
  return { name: name[1]!.toLowerCase(), table: table[1]!.toLowerCase() };
}

function restoreTableName(statement: string): string | undefined {
  const match = /^\s*DEFINE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(search_document|chunk)\b/iu
    .exec(sqlCodeMask(statement));
  return match?.[1]?.toLowerCase();
}

function validateDeferredIndexes(
  deferred: DeferredIndex[],
  restoreTables: ReadonlySet<string>,
  requireExpectedIndexes: boolean,
): void {
  // Small synthetic exports used by failure-path tests may not contain the
  // search schema at all. A real schema export contains both tables, and then
  // the expected FULLTEXT set is strict and fail-closed.
  if (!requireExpectedIndexes && restoreTables.size === 0 && deferred.length === 0) return;

  const expectedTables = new Set<string>(RESTORE_FULLTEXT_TABLES);
  const actualDefinitions = deferred.map((index) => `${index.name}@${index.table}`);
  const requiredDefinition =
    `search_document_content@${RESTORE_FULLTEXT_INDEX_TABLES.search_document_content}`;
  const allowedDefinitions = new Set(
    RESTORE_STRIPPED_FULLTEXT_INDEXES.map(
      (name) => `${name}@${RESTORE_FULLTEXT_INDEX_TABLES[name]}`,
    ),
  );
  const tablesMatch = restoreTables.size === expectedTables.size &&
    [...expectedTables].every((table) => restoreTables.has(table));
  const indexesMatch = actualDefinitions.includes(requiredDefinition) &&
    new Set(actualDefinitions).size === actualDefinitions.length &&
    actualDefinitions.every((definition) => allowedDefinitions.has(definition));

  if (!tablesMatch || !indexesMatch) {
    throw new Error(
      `restore FULLTEXT schema mismatch: expected tables ${[...expectedTables].join(",")} ` +
        `and required core index ${requiredDefinition} (optional chunk_content@chunk); got tables ` +
        `${[...restoreTables].join(",") || "none"} and indexes ` +
        `${actualDefinitions.join(",") || "none"}`,
    );
  }
}

async function writeChunk(output: WriteStream, chunk: string): Promise<void> {
  if (!output.write(chunk, "utf8")) await once(output, "drain");
}

const OUTPUT_BUFFER_CHARS = 64 * 1024;
const OPTION_IMPORT_SCAN_BYTES = 1024 * 1024;

async function assertActiveOptionImport(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    const prefix = Buffer.allocUnsafe(OPTION_IMPORT_SCAN_BYTES);
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0);
    const code = sqlCodeMask(prefix.subarray(0, bytesRead).toString("utf8"));
    if (!/(?:^|;)\s*OPTION\s+IMPORT\s*;/iu.test(code)) {
      throw new Error(
        "restore import is missing an active OPTION IMPORT directive in its bounded prefix",
      );
    }
  } finally {
    await handle.close();
  }
}

/**
 * Writes a byte-preserving stream without FULLTEXT DDL and returns that DDL.
 * The destination is created here with O_EXCL and mode 0600; callers must
 * remove it after successful use. A failed transformation removes the file it
 * created. Memory is bounded by one statement (or one export line) plus a
 * fixed output buffer, not by the size of the multi-gigabyte dump.
 */
export async function reorderImportStream(
  input: AsyncIterable<string | Uint8Array>,
  outputPath: string,
  options: { requireExpectedIndexes?: boolean } = {},
): Promise<string[]> {
  const outputHandle = await open(outputPath, "wx", 0o600);
  const output = outputHandle.createWriteStream({ encoding: "utf8", autoClose: false });
  const outputClosed = new Promise<void>((resolve) => output.once("close", resolve));
  let outputError: unknown;
  output.on("error", (error) => {
    outputError ??= error;
  });
  const deferred: DeferredIndex[] = [];
  const restoreTables = new Set<string>();
  let pendingLine = "";
  let pendingDefine = "";
  let pendingOutput: string[] = [];
  let pendingOutputChars = 0;
  const decoder = new StringDecoder("utf8");

  const flushOutput = async (): Promise<void> => {
    if (pendingOutputChars === 0) return;
    const chunk = pendingOutput.join("");
    pendingOutput = [];
    pendingOutputChars = 0;
    await writeChunk(output, chunk);
  };

  const bufferOutput = async (text: string): Promise<void> => {
    pendingOutput.push(text);
    pendingOutputChars += text.length;
    // Bun batches consecutive small WriteStream writes into one writev call.
    // A populated Surreal export can exceed the platform iovec limit before
    // backpressure fires, so coalesce lines into one bounded write ourselves.
    if (pendingOutputChars >= OUTPUT_BUFFER_CHARS) await flushOutput();
  };

  const consume = async (text: string): Promise<void> => {
    if (pendingDefine.length === 0) {
      if (!/^[\t ]*DEFINE\b/iu.test(text)) {
        await bufferOutput(text);
        return;
      }
      pendingDefine = text;
    } else {
      pendingDefine += text;
    }

    const end = statementEnd(pendingDefine);
    if (end < 0) return;

    const statement = pendingDefine.slice(0, end);
    const remainder = pendingDefine.slice(end);
    pendingDefine = "";
    const table = restoreTableName(statement);
    if (table) restoreTables.add(table);
    const index = fulltextIndexDefinition(statement);
    if (index) {
      if (!isStrippedFulltextIndex(index.name)) {
        throw new Error(`restore FULLTEXT DDL has an unexpected index identity ${index.name}`);
      }
      deferred.push({ ...index, statement });
    } else {
      await bufferOutput(statement);
    }
    if (remainder.length > 0) await consume(remainder);
  };

  try {
    for await (const chunk of input) {
      pendingLine += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pendingLine.indexOf("\n")) >= 0) {
        const line = pendingLine.slice(0, newline + 1);
        pendingLine = pendingLine.slice(newline + 1);
        await consume(line);
      }
    }
    pendingLine += decoder.end();
    if (pendingLine.length > 0) await consume(pendingLine);
    if (pendingDefine.length > 0) await bufferOutput(pendingDefine);
    await flushOutput();
    if (outputError) throw outputError;
    const finished = once(output, "finish");
    output.end();
    await finished;
    await outputHandle.sync();
    output.destroy();
    await outputClosed;
  } catch (error) {
    output.destroy();
    await outputClosed;
    await outputHandle.close().catch(() => {});
    await unlink(outputPath).catch((cleanupError) => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
  await outputHandle.close();

  try {
    // OPTION IMPORT is an executable safety/performance contract, not a
    // comment. Validate the actual fsynced output so a reorder regression
    // fails before any bytes are sent to SurrealDB.
    await assertActiveOptionImport(outputPath);
    validateDeferredIndexes(
      deferred,
      restoreTables,
      options.requireExpectedIndexes ?? true,
    );
    return deferred
      .filter((index) => index.name === "search_document_content")
      .map((index) => index.statement);
  } catch (error) {
    await unlink(outputPath).catch((cleanupError) => {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

/** Reorders a plaintext export while retaining the legacy restore:test seam. */
export async function reorderImportFile(
  inputPath: string,
  outputPath: string,
  options: { requireExpectedIndexes?: boolean } = {},
): Promise<string[]> {
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error("inputPath and outputPath for reorderImportFile must differ");
  }
  const input = createReadStream(inputPath, { encoding: "utf8" });
  try {
    return await reorderImportStream(input, outputPath, options);
  } finally {
    input.destroy();
  }
}

/**
 * Streams zstd/gzip plaintext directly through the validated reorder pass.
 * The authenticated compressed source is read-only and the sole plaintext
 * artifact is the fsynced import file at outputPath.
 */
export async function reorderCompressedImportFile(
  inputPath: string,
  outputPath: string,
  options: { requireExpectedIndexes?: boolean } = {},
): Promise<string[]> {
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error("inputPath and outputPath for reorderCompressedImportFile must differ");
  }
  let completedOutput = false;
  try {
    return await withDecompressedStream(inputPath, async (input) => {
      const statements = await reorderImportStream(input, outputPath, options);
      completedOutput = true;
      return statements;
    });
  } catch (error) {
    // A decompressor can emit syntactically valid bytes and only then report a
    // checksum/trailer failure. Remove the already-fsynced output in that case;
    // reorderImportStream owns cleanup for failures before it returns.
    if (completedOutput) {
      await unlink(outputPath).catch((cleanupError) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      });
    }
    throw error;
  }
}

export interface AuthenticatedCompressedImportOptions {
  requireExpectedIndexes?: boolean;
  /** Deterministic race seam used only by filesystem identity regressions. */
  afterSourceOpened?: () => void | Promise<void>;
}

/**
 * Recovery-only variant that binds the authenticated compressed inode to the
 * decompressor through an already-open descriptor. The exact pathname,
 * dev/ino/size/mode and SHA-256 are revalidated before and after preparation.
 */
export async function reorderAuthenticatedCompressedImportFile(
  identity: AuthenticatedRegularFileIdentity,
  outputPath: string,
  options: AuthenticatedCompressedImportOptions = {},
): Promise<string[]> {
  if (path.resolve(identity.resolvedPath) === path.resolve(outputPath)) {
    throw new Error(
      "authenticated input and output for reorderAuthenticatedCompressedImportFile must differ",
    );
  }
  const source = await openAuthenticatedRegularFile(identity, "recovery compressed export");
  let completedOutput = false;
  let statements: string[] | undefined;
  let preparationError: unknown;
  try {
    await options.afterSourceOpened?.();
    statements = await withDecompressedStream(
      identity.resolvedPath,
      async (input) => {
        const result = await reorderImportStream(input, outputPath, options);
        completedOutput = true;
        return result;
      },
      { inputFd: source.descriptor.fd },
    );
  } catch (error) {
    preparationError = error;
  }

  let identityError: unknown;
  try {
    await assertOpenAuthenticatedRegularFileUnchanged(
      source,
      "recovery compressed export",
    );
  } catch (error) {
    identityError = error;
  }
  let closeError: unknown;
  await source.descriptor.close().catch((error) => {
    closeError = error;
  });

  if (preparationError !== undefined || identityError !== undefined || closeError !== undefined) {
    let cleanupError: unknown;
    // Revalidation can fail after a syntactically valid output was fsynced.
    // The untrusted output is never retained for upload in that case.
    if (completedOutput) {
      await unlink(outputPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupError = error;
        }
      });
    }
    const failures = [preparationError, identityError, closeError, cleanupError]
      .filter((error) => error !== undefined);
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      "recovery compressed import preparation or source revalidation failed",
    );
  }
  if (!statements) throw new Error("recovery compressed import produced no statements");
  return statements;
}
