/**
 * Location reconciler (docs/plan.md §10.3, §10.6, §10.7) — чистая логика
 * принятия решений над plain-объектами, без БД и файловой системы.
 *
 * Вход: прежнее состояние source locations + результат scan одного
 * source root. Выход: действия (unchanged/new/changed/missing/deleted)
 * и новое состояние. Запись в SurrealDB и сами snapshot'ы — этап 5;
 * здесь только решения.
 *
 * Rename detection (§10.7): подтверждается только когда в complete-scan
 * старый location отсутствует и появился РОВНО ОДИН новый файл с тем же
 * полным SHA-256, и нет активного location с тем же содержимым. Иначе —
 * независимые location'ы. Reconciler работает в пределах одного source root,
 * поэтому условие «один root» выполнено по построению.
 */

import type { ScannedFile, ScanStatus } from "../sources/scanning/scanner.ts";
import {
  advancePresence,
  INITIAL_PRESENCE,
  type PresenceState,
} from "./deletion-detector.ts";

/** Fingerprint текущей revision, как он известен из прежнего состояния. */
export interface LocationState {
  relativePath: string;
  presence: PresenceState;
  currentSha256?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  headHash?: string;
  /** Подтверждённый прежний location (§10.7). */
  renamedFrom?: string;
}

/** Файл из scan; sha256/headHash заполняются, если уже посчитаны. */
export interface ScanFileInfo extends ScannedFile {
  sha256?: string;
  headHash?: string;
}

export interface ScanSummary {
  status: ScanStatus;
  files: ScanFileInfo[];
}

export type LocationAction =
  | { kind: "unchanged"; relativePath: string }
  | { kind: "new"; relativePath: string; renamedFrom?: string }
  | { kind: "changed"; relativePath: string }
  | { kind: "missing"; relativePath: string }
  | { kind: "deleted"; relativePath: string };

export interface ReconcileResult {
  actions: LocationAction[];
  /** Новое состояние всех locations (прежние + новые). */
  locations: LocationState[];
}

export interface RenameMatch {
  from: string;
  to: string;
  sha256: string;
}

/**
 * §10.7: rename подтверждается при ровно одном кандидате с тем же SHA-256
 * и отсутствии активного location с тем же содержимым.
 */
export function detectRenames(
  missing: LocationState[],
  newFiles: ScanFileInfo[],
  activeLocations: LocationState[],
): RenameMatch[] {
  const matches: RenameMatch[] = [];
  const claimed = new Set<string>();
  // Неоднозначность ИСТОЧНИКА: несколько отсутствующих locations с тем же
  // SHA — любой выбор «источника rename» был бы произвольным, поэтому
  // новый файл становится независимым location (§10.7).
  const missingBySha = new Map<string, number>();
  for (const loc of missing) {
    if (!loc.currentSha256) continue;
    missingBySha.set(loc.currentSha256, (missingBySha.get(loc.currentSha256) ?? 0) + 1);
  }
  for (const loc of missing) {
    if (!loc.currentSha256) continue;
    const sha = loc.currentSha256;
    if ((missingBySha.get(sha) ?? 0) > 1) continue;
    const hasActiveTwin = activeLocations.some((a) => a.currentSha256 === sha);
    if (hasActiveTwin) continue;
    const candidates = newFiles.filter(
      (f) => f.sha256 === sha && !claimed.has(f.relativePath),
    );
    if (candidates.length === 1) {
      const to = candidates[0]!.relativePath;
      claimed.add(to);
      matches.push({ from: loc.relativePath, to, sha256: sha });
    }
    // 0 или 2+ кандидатов — неоднозначность: независимые location'ы.
  }
  return matches;
}

/** Совпадает ли быстрый fingerprint файла с прежней revision (§10.3). */
export function fingerprintMatches(loc: LocationState, file: ScanFileInfo): boolean {
  // Полный hash сильнее любого fingerprint'а.
  if (loc.currentSha256 && file.sha256) {
    return loc.currentSha256 === file.sha256;
  }
  if (loc.sizeBytes !== undefined && loc.sizeBytes !== file.sizeBytes) return false;
  if (loc.mtimeMs !== undefined && loc.mtimeMs !== file.mtimeMs) return false;
  if (loc.headHash && file.headHash && loc.headHash !== file.headHash) return false;
  return loc.sizeBytes !== undefined || loc.headHash !== undefined;
}

export function reconcileLocations(
  previous: LocationState[],
  scan: ScanSummary,
  opts: { deletionConfirmations: number },
): ReconcileResult {
  const scanComplete = scan.status === "complete";
  const seen = new Map(scan.files.map((f) => [f.relativePath, f]));
  const actions: LocationAction[] = [];
  const locations: LocationState[] = [];
  const missingNow: LocationState[] = [];

  // 1. Прежние locations: seen → unchanged/changed; absent → presence machine.
  for (const prev of previous) {
    const file = seen.get(prev.relativePath);
    if (file) {
      const unchanged = fingerprintMatches(prev, file);
      if (!unchanged) {
        actions.push({ kind: "changed", relativePath: prev.relativePath });
      } else {
        actions.push({ kind: "unchanged", relativePath: prev.relativePath });
      }
      locations.push({
        ...prev,
        presence: advancePresence(prev.presence, { seen: true, scanComplete }, opts.deletionConfirmations),
      });
      continue;
    }
    const presence = advancePresence(
      prev.presence,
      { seen: false, scanComplete },
      opts.deletionConfirmations,
    );
    const next: LocationState = { ...prev, presence };
    if (presence.status === "missing" && prev.presence.status !== "missing") {
      actions.push({ kind: "missing", relativePath: prev.relativePath });
    } else if (
      presence.status === "deleted_in_source" &&
      prev.presence.status !== "deleted_in_source"
    ) {
      actions.push({ kind: "deleted", relativePath: prev.relativePath });
    }
    locations.push(next);
    if (scanComplete && presence.status !== "active") {
      missingNow.push(next);
    }
  }

  // 2. Новые файлы без прежнего location.
  const newFiles = scan.files.filter((f) => !previous.some((p) => p.relativePath === f.relativePath));

  // 3. Rename detection — только по complete-scan (§10.7).
  const activeLocations = locations.filter((l) => l.presence.status === "active");
  const renames = scanComplete ? detectRenames(missingNow, newFiles, activeLocations) : [];
  const renameByTo = new Map(renames.map((r) => [r.to, r.from]));

  for (const file of newFiles) {
    const renamedFrom = renameByTo.get(file.relativePath);
    actions.push({ kind: "new", relativePath: file.relativePath, renamedFrom });
    locations.push({
      relativePath: file.relativePath,
      presence: { ...INITIAL_PRESENCE },
      currentSha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      headHash: file.headHash,
      renamedFrom,
    });
  }

  return { actions, locations };
}
