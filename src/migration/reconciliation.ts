/** Построчная классификация legacy import (§15.9, §15.10). */

import type { LegacySqlRow, LegacyTable } from "./legacy-reader.ts";
import type { LegacyHostAttributionReport } from "./store.ts";

export type MigrationCategory = "matched" | "inserted" | "quarantined";

export interface MigrationTableCounters {
  total: number;
  matched: number;
  inserted: number;
  quarantined: number;
  accounted: number;
  lost: number;
}

export interface MigrationReconciliation {
  legacyTotal: number;
  matched: number;
  inserted: number;
  quarantined: number;
  accounted: number;
  lost: number;
  ok: boolean;
  tables: Record<LegacyTable, MigrationTableCounters>;
}

export interface MigrationRecoveryCounters {
  raw: number;
  payload: number;
  normalized: number;
}

export interface MigrationRunReport {
  formatVersion: 1;
  createdAt: string;
  status: "completed" | "completed_with_errors" | "failed";
  snapshotPath: string;
  snapshotSha256: string;
  syncRunId?: string;
  migrationId?: string;
  reportPath?: string;
  approvalArtifactSha256?: string;
  approvalFileSha256?: string;
  approvalAttestationSha256?: string;
  approvalKeyFingerprint?: string;
  hostMappingArtifactSha256?: string;
  backupArtifactSha256?: string;
  restoreArtifactSha256?: string;
  reconciliation: MigrationReconciliation;
  recovery: MigrationRecoveryCounters;
  hostAttribution: LegacyHostAttributionReport;
  /** False makes the report ineligible for the production CLI success gate. */
  assignmentCoverageOk: boolean;
  error?: string;
}

/**
 * Не допускает ни двойной классификации, ни тихо потерянной строки.
 * Missing rows остаются lost > 0 в persisted reconciliation даже при
 * аварийном завершении run.
 */
export class RowReconciler {
  private readonly seen = new Map<LegacyTable, Set<string>>();
  private readonly counts = new Map<LegacyTable, Record<MigrationCategory, number>>();

  constructor(private readonly totals: Record<LegacyTable, number>) {
    for (const table of Object.keys(totals) as LegacyTable[]) {
      this.seen.set(table, new Set());
      this.counts.set(table, { matched: 0, inserted: 0, quarantined: 0 });
    }
  }

  classify(table: LegacyTable, legacyId: string | number, category: MigrationCategory): void {
    const key = String(legacyId);
    const seen = this.seen.get(table)!;
    if (seen.has(key)) {
      throw new Error(`legacy row классифицирована повторно: ${table}:${key}`);
    }
    seen.add(key);
    this.counts.get(table)![category] += 1;
  }

  classifyRow(row: LegacySqlRow, table: LegacyTable, category: MigrationCategory): void {
    this.classify(table, row.id, category);
  }

  report(): MigrationReconciliation {
    const tables = {} as Record<LegacyTable, MigrationTableCounters>;
    let legacyTotal = 0;
    let matched = 0;
    let inserted = 0;
    let quarantined = 0;
    let accounted = 0;
    for (const table of Object.keys(this.totals) as LegacyTable[]) {
      const total = this.totals[table];
      const count = this.counts.get(table)!;
      const tableAccounted = count.matched + count.inserted + count.quarantined;
      tables[table] = {
        total,
        ...count,
        accounted: tableAccounted,
        lost: total - tableAccounted,
      };
      legacyTotal += total;
      matched += count.matched;
      inserted += count.inserted;
      quarantined += count.quarantined;
      accounted += tableAccounted;
    }
    const lost = legacyTotal - accounted;
    return {
      legacyTotal,
      matched,
      inserted,
      quarantined,
      accounted,
      lost,
      ok: lost === 0,
      tables,
    };
  }
}
