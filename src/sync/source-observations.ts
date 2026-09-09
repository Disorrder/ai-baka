import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.ts";
import { writePrivateFileAtomic } from "../backup/safety.ts";

export interface SourceObservation {
  revision: string;
  pipeline: string;
  fingerprint: string;
  status: string;
}

/** Acceleration only: loss/corruption costs a scan, never corpus data. Held under sync lock. */
export class SourceObservations {
  private entries = new Map<string, SourceObservation>();
  private dirty = false;
  private constructor(private readonly file: string) {}

  static async load(cfg: AppConfig): Promise<SourceObservations> {
    const key = createHash("sha256").update(JSON.stringify([
      cfg.archiveRoot, cfg.surrealUrl, cfg.surrealNamespace, cfg.surrealDatabase,
    ])).digest("hex");
    const cache = new SourceObservations(path.join(path.dirname(cfg.dbRoot), "sync-cache", `${key}.json`));
    try {
      if ((await stat(cache.file)).size > 64 * 1024 * 1024) return cache;
      const data = JSON.parse(await readFile(cache.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.entries)) return cache;
      for (const row of data.entries) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string") continue;
        const value = row[1];
        if (value && typeof value.revision === "string" && typeof value.pipeline === "string" &&
            typeof value.fingerprint === "string" && value.fingerprint.startsWith("source-v1:") &&
            ["parsed", "unsupported", "partial", "parse_error", "pending"].includes(value.status)) cache.entries.set(row[0], value);
      }
    } catch { /* Missing or damaged cache is a cold scan. */ }
    return cache;
  }

  get(location: string, revision: string | undefined, pipeline: string, status: string | undefined): SourceObservation | undefined {
    const entry = this.getCapture(location, revision);
    return entry && (status === "parsed" || status === "unsupported") &&
      entry.pipeline === pipeline && entry.status === status ? entry : undefined;
  }

  /** Stable captured bytes can be reused even when parsing must be retried. */
  getCapture(location: string, revision: string | undefined): SourceObservation | undefined {
    const entry = this.entries.get(location);
    return entry?.revision === revision ? entry : undefined;
  }

  has(location: string): boolean {
    return this.entries.has(location);
  }

  set(location: string, observation: SourceObservation): void {
    this.entries.set(location, observation);
    this.dirty = true;
  }

  delete(location: string): void {
    if (this.entries.delete(location)) this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await writePrivateFileAtomic(this.file, JSON.stringify({version: 1, entries: [...this.entries]}), {overwrite: true});
    this.dirty = false;
  }
}
