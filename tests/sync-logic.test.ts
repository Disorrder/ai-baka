import { describe, expect, test } from "bun:test";
import {
  advancePresence,
  INITIAL_PRESENCE,
  type PresenceState,
} from "../src/sync/deletion-detector.ts";
import {
  detectRenames,
  fingerprintMatches,
  reconcileLocations,
  type LocationState,
  type ScanFileInfo,
} from "../src/sync/location-reconciler.ts";

const N = 2; // deletionConfirmations по умолчанию

function loc(relativePath: string, extra: Partial<LocationState> = {}): LocationState {
  return {
    relativePath,
    presence: { ...INITIAL_PRESENCE },
    sizeBytes: 10,
    mtimeMs: 1000,
    ...extra,
  };
}

function file(relativePath: string, extra: Partial<ScanFileInfo> = {}): ScanFileInfo {
  return { relativePath, sizeBytes: 10, mtimeMs: 1000, ...extra };
}

describe("deletion state machine (§10.6)", () => {
  test("сценарий §19.2 №4: первый complete-scan без файла → missing", () => {
    const next = advancePresence(INITIAL_PRESENCE, { seen: false, scanComplete: true }, N);
    expect(next).toEqual({ status: "missing", missingCompleteScans: 1 });
  });

  test("сценарий §19.2 №5: N подряд complete-scan → deleted_in_source", () => {
    let state: PresenceState = INITIAL_PRESENCE;
    state = advancePresence(state, { seen: false, scanComplete: true }, N);
    state = advancePresence(state, { seen: false, scanComplete: true }, N);
    expect(state).toEqual({ status: "deleted_in_source", missingCompleteScans: 2 });
    // Дальше счётчик продолжает расти, статус не меняется.
    state = advancePresence(state, { seen: false, scanComplete: true }, N);
    expect(state.status).toBe("deleted_in_source");
    expect(state.missingCompleteScans).toBe(3);
  });

  test("deletionConfirmations=1: удаление подтверждается сразу", () => {
    const next = advancePresence(INITIAL_PRESENCE, { seen: false, scanComplete: true }, 1);
    expect(next.status).toBe("deleted_in_source");
  });

  test("сценарии §19.2 №2/№3: unavailable/partial scan не двигает счётчик", () => {
    const missing: PresenceState = { status: "missing", missingCompleteScans: 1 };
    expect(advancePresence(missing, { seen: false, scanComplete: false }, N)).toBe(missing);
    expect(advancePresence(INITIAL_PRESENCE, { seen: false, scanComplete: false }, N))
      .toBe(INITIAL_PRESENCE);
  });

  test("сценарий §19.2 №6: повторное появление → active из любого состояния", () => {
    for (const state of [
      { status: "missing", missingCompleteScans: 1 },
      { status: "deleted_in_source", missingCompleteScans: 5 },
    ] as PresenceState[]) {
      expect(advancePresence(state, { seen: true, scanComplete: true }, N)).toEqual(
        INITIAL_PRESENCE,
      );
    }
  });
});

describe("location reconciler (§10.3)", () => {
  test("fingerprint совпал → unchanged; размер/mtime изменились → changed", () => {
    const prev = [loc("a.jsonl")];
    const same = reconcileLocations(prev, { status: "complete", files: [file("a.jsonl")] }, { deletionConfirmations: N });
    expect(same.actions).toEqual([{ kind: "unchanged", relativePath: "a.jsonl" }]);

    const grown = reconcileLocations(
      prev,
      { status: "complete", files: [file("a.jsonl", { sizeBytes: 20 })] },
      { deletionConfirmations: N },
    );
    expect(grown.actions).toEqual([{ kind: "changed", relativePath: "a.jsonl" }]);
  });

  test("сценарий §19.2 №8: изменившийся файл требует новый snapshot (changed)", () => {
    const prev = [loc("a.jsonl", { currentSha256: "old" })];
    const result = reconcileLocations(
      prev,
      { status: "complete", files: [file("a.jsonl", { sizeBytes: 20, sha256: "new" })] },
      { deletionConfirmations: N },
    );
    expect(result.actions).toEqual([{ kind: "changed", relativePath: "a.jsonl" }]);
  });

  test("полный sha256 сильнее fingerprint'а", () => {
    const prev = [loc("a.jsonl", { currentSha256: "same" })];
    // mtime/size изменились, но hash совпал → unchanged (§10.3 п.5).
    const result = reconcileLocations(
      prev,
      {
        status: "complete",
        files: [file("a.jsonl", { sizeBytes: 99, mtimeMs: 99, sha256: "same" })],
      },
      { deletionConfirmations: N },
    );
    expect(result.actions).toEqual([{ kind: "unchanged", relativePath: "a.jsonl" }]);
    expect(fingerprintMatches(prev[0]!, file("a.jsonl", { sha256: "same" }))).toBe(true);
  });

  test("head_hash: равные size/mtime, но другое содержимое → changed (§10.3)", () => {
    const prev = [loc("a.jsonl", { headHash: "h1" })];
    const changed = reconcileLocations(
      prev,
      { status: "complete", files: [file("a.jsonl", { headHash: "h2" })] },
      { deletionConfirmations: N },
    );
    expect(changed.actions).toEqual([{ kind: "changed", relativePath: "a.jsonl" }]);
    const same = reconcileLocations(
      prev,
      { status: "complete", files: [file("a.jsonl", { headHash: "h1" })] },
      { deletionConfirmations: N },
    );
    expect(same.actions).toEqual([{ kind: "unchanged", relativePath: "a.jsonl" }]);
    expect(fingerprintMatches(prev[0]!, file("a.jsonl", { headHash: "h2" }))).toBe(false);
  });

  test("новый файл → new; состояние дополняется", () => {
    const result = reconcileLocations(
      [],
      { status: "complete", files: [file("new.jsonl", { sha256: "x" })] },
      { deletionConfirmations: N },
    );
    expect(result.actions).toEqual([{ kind: "new", relativePath: "new.jsonl", renamedFrom: undefined }]);
    expect(result.locations[0]).toMatchObject({
      relativePath: "new.jsonl",
      currentSha256: "x",
      presence: { status: "active", missingCompleteScans: 0 },
    });
  });

  test("сценарий §19.2 №2: unavailable scan — ни missing, ни deleted", () => {
    const prev = [loc("a.jsonl"), loc("b.jsonl")];
    for (const status of ["unavailable", "partial", "permission_denied", "failed"] as const) {
      const result = reconcileLocations(prev, { status, files: [] }, { deletionConfirmations: N });
      expect(result.actions).toEqual([]);
      expect(result.locations.map((l) => l.presence.status)).toEqual(["active", "active"]);
    }
  });

  test("полный цикл: active → missing → deleted → active", () => {
    let prev = [loc("a.jsonl")];
    const scan = { status: "complete" as const, files: [] };
    const r1 = reconcileLocations(prev, scan, { deletionConfirmations: N });
    expect(r1.actions).toEqual([{ kind: "missing", relativePath: "a.jsonl" }]);
    const r2 = reconcileLocations(r1.locations, scan, { deletionConfirmations: N });
    expect(r2.actions).toEqual([{ kind: "deleted", relativePath: "a.jsonl" }]);
    const r3 = reconcileLocations(
      r2.locations,
      { status: "complete", files: [file("a.jsonl")] },
      { deletionConfirmations: N },
    );
    expect(r3.actions).toEqual([{ kind: "unchanged", relativePath: "a.jsonl" }]);
    expect(r3.locations[0]?.presence).toEqual(INITIAL_PRESENCE);
  });
});

describe("rename detection (§10.7, сценарий §19.2 №7)", () => {
  const SHA = "c".repeat(64);

  test("ровно один кандидат с тем же sha256 → rename подтверждён", () => {
    const missing = [loc("old.jsonl", { currentSha256: SHA, presence: { status: "missing", missingCompleteScans: 1 } })];
    const matches = detectRenames(missing, [file("new.jsonl", { sha256: SHA })], []);
    expect(matches).toEqual([{ from: "old.jsonl", to: "new.jsonl", sha256: SHA }]);
  });

  test("два кандидата (duplicate copy) → rename не подтверждён", () => {
    const missing = [loc("old.jsonl", { currentSha256: SHA })];
    const matches = detectRenames(
      missing,
      [file("copy1.jsonl", { sha256: SHA }), file("copy2.jsonl", { sha256: SHA })],
      [],
    );
    expect(matches).toEqual([]);
  });

  test("несколько missing с тем же sha → неоднозначный источник, rename не подтверждён", () => {
    const missing = [
      loc("old1.jsonl", { currentSha256: SHA, presence: { status: "missing", missingCompleteScans: 1 } }),
      loc("old2.jsonl", { currentSha256: SHA, presence: { status: "missing", missingCompleteScans: 1 } }),
    ];
    // Один новый файл, но ДВА возможных источника — выбор был бы произвольным:
    // новый файл становится независимым location (§10.7).
    expect(detectRenames(missing, [file("new.jsonl", { sha256: SHA })], [])).toEqual([]);
  });

  test("активный location с тем же содержимым → rename не подтверждён", () => {
    const missing = [loc("old.jsonl", { currentSha256: SHA })];
    const active = [loc("twin.jsonl", { currentSha256: SHA })];
    expect(detectRenames(missing, [file("new.jsonl", { sha256: SHA })], active)).toEqual([]);
  });

  test("reconciler: rename vs duplicate copy в complete-scan", () => {
    // Rename: старый пропал, ровно один новый с тем же sha.
    const renameRun = reconcileLocations(
      [loc("old.jsonl", { currentSha256: SHA })],
      { status: "complete", files: [file("new.jsonl", { sha256: SHA })] },
      { deletionConfirmations: N },
    );
    expect(renameRun.actions).toEqual([
      { kind: "missing", relativePath: "old.jsonl" },
      { kind: "new", relativePath: "new.jsonl", renamedFrom: "old.jsonl" },
    ]);
    expect(renameRun.locations.find((l) => l.relativePath === "new.jsonl")?.renamedFrom)
      .toBe("old.jsonl");

    // Duplicate copy: два новых файла с тем же sha — два независимых location.
    const dupRun = reconcileLocations(
      [loc("old.jsonl", { currentSha256: SHA })],
      {
        status: "complete",
        files: [file("copy1.jsonl", { sha256: SHA }), file("copy2.jsonl", { sha256: SHA })],
      },
      { deletionConfirmations: N },
    );
    expect(dupRun.actions).toEqual([
      { kind: "missing", relativePath: "old.jsonl" },
      { kind: "new", relativePath: "copy1.jsonl", renamedFrom: undefined },
      { kind: "new", relativePath: "copy2.jsonl", renamedFrom: undefined },
    ]);
  });

  test("rename не определяется при partial scan", () => {
    const result = reconcileLocations(
      [loc("old.jsonl", { currentSha256: SHA })],
      { status: "partial", files: [file("new.jsonl", { sha256: SHA })] },
      { deletionConfirmations: N },
    );
    expect(result.actions).toEqual([
      { kind: "new", relativePath: "new.jsonl", renamedFrom: undefined },
    ]);
  });
});
