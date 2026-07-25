/**
 * Хэширование источников (docs/plan.md §4.2, §9.1).
 *
 * Identity ревизии — ПОЛНЫЙ SHA-256 содержимого. `head_hash` (первые
 * HEAD_HASH_BYTES + размер) — только быстрый fingerprint для обнаружения
 * изменений; он НЕ является identity: два файла с одинаковым началом,
 * но разным хвостом имеют одинаковый head_hash и разный SHA-256.
 */

import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export const HEAD_HASH_BYTES = 64 * 1024;

export interface FileHashes {
  sha256: string;
  headHash: string;
  sizeBytes: number;
}

class HeadCollector {
  private chunks: Buffer[] = [];
  private collected = 0;

  push(chunk: Buffer): void {
    if (this.collected >= HEAD_HASH_BYTES) return;
    const rest = HEAD_HASH_BYTES - this.collected;
    this.chunks.push(chunk.subarray(0, rest));
    this.collected += Math.min(rest, chunk.length);
  }

  digest(sizeBytes: number): string {
    const hash = createHash("sha256");
    hash.update(`${sizeBytes}:`);
    for (const chunk of this.chunks) hash.update(chunk);
    return hash.digest("hex");
  }
}

/**
 * Читает `sourcePath` потоком, считает полный SHA-256 и head_hash.
 * Если задан `destPath`, одновременно пишет копию (с последующим fsync).
 */
export async function hashFile(
  sourcePath: string,
  destPath?: string,
): Promise<FileHashes> {
  const sha = createHash("sha256");
  const head = new HeadCollector();
  let sizeBytes = 0;

  const source = createReadStream(sourcePath);
  if (destPath) {
    const dest = createWriteStream(destPath);
    source.on("data", (chunk: Buffer) => {
      sha.update(chunk);
      head.push(chunk);
      sizeBytes += chunk.length;
    });
    await pipeline(source, dest);
    // fsync временного файла до повторного stat/rename (план §9.1 п.4).
    const handle = await open(destPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      sha.update(buf);
      head.push(buf);
      sizeBytes += buf.length;
    }
  }

  return {
    sha256: sha.digest("hex"),
    headHash: head.digest(sizeBytes),
    sizeBytes,
  };
}

/** head_hash для буфера (чистая функция, используется в тестах и reconciler). */
export function headHashOf(head: Buffer | Uint8Array, sizeBytes: number): string {
  const hash: Hash = createHash("sha256");
  hash.update(`${sizeBytes}:`);
  hash.update(head.subarray(0, HEAD_HASH_BYTES));
  return hash.digest("hex");
}
