import { createHash } from "node:crypto";
import { stat, open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isSqlitePath } from "../adapters/file-matchers.ts";
import { hashFile, HEAD_HASH_BYTES } from "./hashing.ts";

/** File identity plus mutation metadata; never a substitute for raw SHA-256. */
export function physicalFileState(s: Stats): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

async function part(file: string, full: boolean, optional = false): Promise<string | undefined> {
  let before: Stats;
  try {
    before = await stat(file);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!before.isFile()) return undefined;
  let digest: string;
  if (full) {
    digest = (await hashFile(file)).sha256;
  } else {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(before.size, HEAD_HASH_BYTES));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== buffer.length) return undefined;
      digest = createHash("sha256").update(buffer).digest("hex");
    } finally {
      await handle.close();
    }
  }
  const after = await stat(file);
  return physicalFileState(before) === physicalFileState(after)
    ? `${physicalFileState(after)}:${digest}` : undefined;
}

/** Fail closed on races/read failures. WAL contents matter even if main DB is unchanged. */
export async function readSourceFingerprint(file: string): Promise<string | undefined> {
  try {
    const before = await stat(file);
    const main = await part(file, false);
    if (!main) return undefined;
    const sqlite = isSqlitePath(file);
    const wal = sqlite ? await part(`${file}-wal`, true, true) : "absent";
    // A rollback journal can represent an in-flight transaction; never cache it.
    const journal = sqlite ? await part(`${file}-journal`, false, true) : "absent";
    if (!wal || journal !== "absent") return undefined;
    const after = await stat(file);
    if (physicalFileState(before) !== physicalFileState(after)) return undefined;
    // Recheck sidecar metadata after reading the main file and hashing the WAL.
    if (sqlite) {
      const walNow = await stat(`${file}-wal`).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (walNow ? !wal.startsWith(`${physicalFileState(walNow)}:`) : wal !== "absent") return undefined;
      const journalNow = await stat(`${file}-journal`).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (journalNow) return undefined;
    }
    return `source-v1:${createHash("sha256").update(`${main}|${wal}`).digest("hex")}`;
  } catch {
    return undefined;
  }
}
