/**
 * Deletion state machine (docs/plan.md §10.6) — чистая логика без I/O.
 *
 *   active → missing            — после первого complete-scan без файла
 *   missing → deleted_in_source — после N подряд complete-scan без файла
 *                                 (N = deletionConfirmations, по умолчанию 2)
 *   * → active                  — файл снова появился в scan
 *
 * При partial/unavailable/permission_denied/failed scan счётчик отсутствия
 * НЕ изменяется. Ни raw, ни canonical данные не удаляются никогда.
 */

export type PresenceStatus = "active" | "missing" | "deleted_in_source";

export interface PresenceState {
  status: PresenceStatus;
  /** Число последовательных complete-scan без файла. */
  missingCompleteScans: number;
}

export const INITIAL_PRESENCE: PresenceState = {
  status: "active",
  missingCompleteScans: 0,
};

export interface PresenceEvent {
  /** Файл присутствует в текущем scan. */
  seen: boolean;
  /** Scan полный (status = complete); только он двигает счётчик отсутствия. */
  scanComplete: boolean;
}

export function advancePresence(
  state: PresenceState,
  event: PresenceEvent,
  deletionConfirmations: number,
): PresenceState {
  if (event.seen) {
    return { status: "active", missingCompleteScans: 0 };
  }
  if (!event.scanComplete) {
    return state;
  }
  const n = state.missingCompleteScans + 1;
  const confirmations = Math.max(1, deletionConfirmations);
  return {
    status: n >= confirmations ? "deleted_in_source" : "missing",
    missingCompleteScans: n,
  };
}
