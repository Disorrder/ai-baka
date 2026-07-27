/**
 * Сжатие export'ов. План §16.1 предписывает zstd; если бинаря нет —
 * fallback на gzip (.surql.gz), что фиксируется в manifest'е полем compression.
 */

import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { PassThrough, type Readable } from "node:stream";

export type Compression = "zstd" | "gzip";

class CompressError extends Error {}

function decompressionCommand(
  input: string,
  readFromStdin = false,
): { cmd: string; args: string[] } {
  if (input.endsWith(".zst")) {
    return { cmd: "zstd", args: ["-q", "-d", "-c", ...(readFromStdin ? [] : [input])] };
  }
  if (input.endsWith(".gz")) {
    return { cmd: "gzip", args: ["-d", "-c", ...(readFromStdin ? [] : [input])] };
  }
  throw new CompressError(`неизвестный формат сжатия: ${input}`);
}

async function run(cmd: string, args: string[], stdoutPath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const outFd = stdoutPath ? openSync(stdoutPath, "w") : "ignore";
    const child = spawn(cmd, args, { stdio: ["ignore", outFd, "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (stdoutPath) closeSync(outFd as number);
      reject(new CompressError(`${cmd} не найден: ${error.message}`));
    });
    child.on("close", (code) => {
      if (stdoutPath) closeSync(outFd as number);
      if (code === 0) resolve();
      else reject(new CompressError(`${cmd} завершился с кодом ${code}: ${stderr.trim()}`));
    });
  });
}

async function hasBinary(name: string): Promise<boolean> {
  try {
    await run(name, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** zstd предпочтительно (план §16.1); gzip — переносимый fallback. */
export async function detectCompression(): Promise<Compression> {
  return (await hasBinary("zstd")) ? "zstd" : "gzip";
}

export async function compressFile(
  input: string,
  output: string,
  kind: Compression,
): Promise<void> {
  if (kind === "zstd") {
    await run("zstd", ["-q", "-f", "-o", output, input]);
  } else {
    await run("gzip", ["-c", input], output);
  }
}

export async function decompressFile(input: string, output: string): Promise<void> {
  const command = decompressionCommand(input);
  await run(command.cmd, command.args, output);
}

/**
 * Gives a consumer the decompressor stdout without materializing an
 * intermediate plaintext file. Success requires both the consumer and the
 * decompressor process to finish successfully; a consumer failure terminates
 * the producer and the original error is preserved.
 */
export async function withDecompressedStream<T>(
  input: string,
  consume: (stream: Readable) => Promise<T>,
  options: { inputFd?: number } = {},
): Promise<T> {
  if (options.inputFd !== undefined &&
      (!Number.isSafeInteger(options.inputFd) || options.inputFd < 0)) {
    throw new CompressError("невалидный дескриптор входного файла");
  }
  const { cmd, args } = decompressionCommand(input, options.inputFd !== undefined);
  const child = spawn(cmd, args, {
    stdio: [options.inputFd ?? "ignore", "pipe", "pipe"],
  });
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdout || !childStderr) {
    child.kill("SIGTERM");
    throw new CompressError(`${cmd}: потоки декомпрессора недоступны`);
  }
  // Do not expose EOF until the process exit status is known. Otherwise a
  // corrupt stream can make the SQL consumer report a misleading validation
  // error in the short interval between stdout EOF and a non-zero close.
  const output = new PassThrough();
  output.setEncoding("utf8");
  childStdout.pipe(output, { end: false });

  let stderr = "";
  childStderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const completed = new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: CompressError): void => {
      if (settled) return;
      settled = true;
      output.destroy(error);
      reject(error);
    };
    child.once("error", (error) => {
      fail(new CompressError(`${cmd} не найден: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        output.end();
        resolve();
        return;
      }
      const status = code === null ? `сигналом ${signal ?? "unknown"}` : `с кодом ${code}`;
      const error = new CompressError(`${cmd} завершился ${status}: ${stderr.trim()}`);
      output.destroy(error);
      reject(error);
    });
  });
  let consumerError: unknown;
  const consumed = Promise.resolve()
    .then(() => consume(output))
    .catch((error) => {
      consumerError = error;
      childStdout.unpipe(output);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      throw error;
    });

  try {
    const [result] = await Promise.all([consumed, completed]);
    return result;
  } catch (error) {
    childStdout.unpipe(output);
    childStdout.destroy();
    output.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    // Both promises already have handlers through Promise.all. Await them here
    // so the subprocess and consumer cannot outlive the failed recovery step.
    await Promise.allSettled([consumed, completed]);
    throw consumerError ?? error;
  }
}
