import {
  PINNED_RESTORE_TARGET_IMAGE_DIGEST,
  PINNED_RESTORE_TARGET_VERSION,
  type RestoreTargetEvidence,
} from "../src/backup/restore-test.ts";

/** Synthetic privacy-safe target evidence for strict report contract tests. */
export function isolatedRestoreTargetEvidence(): RestoreTargetEvidence {
  return {
    mode: "isolated_pinned_container",
    image: {
      version: PINNED_RESTORE_TARGET_VERSION,
      digest: PINNED_RESTORE_TARGET_IMAGE_DIGEST,
    },
    dataIdentitySha256: "d".repeat(64),
    resourceBounds: {
      memoryBytes: 12 * 1024 * 1024 * 1024,
      memorySwapBytes: 12 * 1024 * 1024 * 1024,
      nanoCpus: 4_000_000_000,
      pidsLimit: 512,
      rocksDbBlockCacheBytes: 1024 * 1024 * 1024,
      rocksDbThreadCount: 4,
      rocksDbJobsCount: 4,
      rocksDbMaxConcurrentSubcompactions: 2,
      hnswCacheBytes: 256 * 1024 * 1024,
      memoryThresholdBytes: 6 * 1024 * 1024 * 1024,
      httpMaxImportBodyBytes: 32 * 1024 * 1024 * 1024,
      indexBuildResumeIntervalSeconds: 0,
    },
    pinnedIndexingBehavior: {
      probeRecords: 16,
      targetBytes: 8_388_608,
      maxRecords: 250,
    },
    fulltextIndexes: [
      {
        ordinal: 1,
        name: "search_document_content",
        table: "search_document",
        field: "content",
        analyzer: "archive_mixed",
        state: "ready",
      },
    ],
    cleanup: {
      containerRemoved: true,
      dataVolumeRemoved: true,
    },
  };
}
