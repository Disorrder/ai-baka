/**
 * Сжатие export'ов. План §16.1 предписывает zstd; если бинаря нет —
 * fallback на gzip (.surql.gz), что фиксируется в manifest'е полем compression.
 */

import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

export type Compression = "zstd" | "gzip";

class CompressError extends Error {}

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
  if (input.endsWith(".zst")) {
    await run("zstd", ["-q", "-d", "-c", input], output);
  } else if (input.endsWith(".gz")) {
    await run("gzip", ["-d", "-c", input], output);
  } else {
    throw new CompressError(`неизвестный формат сжатия: ${input}`);
  }
}
