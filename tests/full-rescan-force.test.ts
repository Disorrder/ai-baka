import { describe, expect, test } from "bun:test";
import { INITIAL_PRESENCE } from "../src/sync/deletion-detector.ts";
import type { LocationState, ScanSummary } from "../src/sync/location-reconciler.ts";
import { reconcileScannedFiles } from "../src/sync/sync-run.ts";

const previous: LocationState[] = [
  {
    relativePath: "session.jsonl",
    presence: { ...INITIAL_PRESENCE },
    currentSha256: "old-full-sha",
    sizeBytes: 100,
    mtimeMs: 1_234,
    headHash: "old-head-hash",
  },
];

function scan(sizeBytes = 100): ScanSummary {
  return {
    status: "complete",
    files: [
      {
        relativePath: "session.jsonl",
        sizeBytes,
        // Production нормализует stat.mtimeMs к целому значению из БД.
        mtimeMs: 1_234.4,
      },
    ],
  };
}

describe("--full-rescan fingerprint policy", () => {
  test("не читает head_hash и оставляет metadata-unchanged файл без snapshot", async () => {
    const reads: string[] = [];
    const result = await reconcileScannedFiles(previous, scan(), {
      fullRescan: true,
      deletionConfirmations: 2,
      resolvePath: (relativePath) => `/archive/${relativePath}`,
      readHeadHash: async (filePath) => {
        reads.push(filePath);
        return "different-head-hash";
      },
    });

    expect(reads).toEqual([]);
    expect(result.actions).toEqual([{ kind: "unchanged", relativePath: "session.jsonl" }]);
  });

  test("обычный sync читает head_hash и замечает изменение при тех же size/mtime", async () => {
    const reads: string[] = [];
    const result = await reconcileScannedFiles(previous, scan(), {
      fullRescan: false,
      deletionConfirmations: 2,
      resolvePath: (relativePath) => `/archive/${relativePath}`,
      readHeadHash: async (filePath) => {
        reads.push(filePath);
        return "different-head-hash";
      },
    });

    expect(reads).toEqual(["/archive/session.jsonl"]);
    expect(result.actions).toEqual([{ kind: "changed", relativePath: "session.jsonl" }]);
  });

  test("--full-rescan по-прежнему переснимает changed по метаданным", async () => {
    const result = await reconcileScannedFiles(previous, scan(101), {
      fullRescan: true,
      deletionConfirmations: 2,
      resolvePath: (relativePath) => `/archive/${relativePath}`,
      readHeadHash: async () => {
        throw new Error("head hash must not be read during --full-rescan");
      },
    });

    expect(result.actions).toEqual([{ kind: "changed", relativePath: "session.jsonl" }]);
  });
});
