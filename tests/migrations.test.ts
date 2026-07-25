import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checksum,
  listMigrations,
  MigrationError,
  parseMigrationFileName,
  planPendingMigrations,
  type AppliedMigration,
  type MigrationFile,
} from "../src/db/migrations.ts";
import { withTempDir } from "./config.test.ts";

function appliedRow(version: number, name: string, sum: string): AppliedMigration {
  return {
    version,
    name,
    checksum: sum,
    applied_at: new Date(),
    baka_commit: "deadbeef",
    surrealdb_version: "surrealdb-3.2.3",
  };
}

function migrationFile(version: number, name: string, sum: string): MigrationFile & { checksum: string } {
  return { version, name, file: `${String(version).padStart(4, "0")}_${name}.surql`, path: `/x/${name}.surql`, checksum: sum };
}

describe("migrations (unit)", () => {
  test("checksum — sha256 содержимого", () => {
    expect(checksum("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(checksum("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("parseMigrationFileName", () => {
    expect(parseMigrationFileName("0001_initial.surql")).toEqual({ version: 1, name: "initial" });
    expect(parseMigrationFileName("0012_embedding_spaces.surql")).toEqual({
      version: 12,
      name: "embedding_spaces",
    });
    expect(parseMigrationFileName("notes.surql")).toBeNull();
    expect(parseMigrationFileName("0001.surql")).toBeNull();
    expect(parseMigrationFileName("0001_initial.sql")).toBeNull();
  });

  test("listMigrations сортирует по версии и игнорирует не-surql", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "0002_b.surql"), "-- b");
      await writeFile(path.join(dir, "0001_a.surql"), "-- a");
      await writeFile(path.join(dir, "notes.txt"), "не миграция");
      const migrations = await listMigrations(dir);
      expect(migrations.map((m) => m.version)).toEqual([1, 2]);
      expect(migrations[0]!.name).toBe("a");
    });
  });

  test("listMigrations отклоняет битые имена и дубликаты версий", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "broken.surql"), "--");
      expect(listMigrations(dir)).rejects.toThrow(MigrationError);
    });
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "0001_a.surql"), "--");
      await writeFile(path.join(dir, "0001_b.surql"), "--");
      expect(listMigrations(dir)).rejects.toThrow(/дубликат/);
    });
  });

  test("planPendingMigrations: пустая БД — все миграции к применению", () => {
    const files = [migrationFile(1, "a", "s1"), migrationFile(2, "b", "s2")];
    expect(planPendingMigrations(files, []).map((f) => f.version)).toEqual([1, 2]);
  });

  test("planPendingMigrations: применённые пропускаются", () => {
    const files = [migrationFile(1, "a", "s1"), migrationFile(2, "b", "s2")];
    const pending = planPendingMigrations(files, [appliedRow(1, "a", "s1")]);
    expect(pending.map((f) => f.version)).toEqual([2]);
  });

  test("planPendingMigrations: tampered checksum → ошибка", () => {
    const files = [migrationFile(1, "a", "s1"), migrationFile(2, "b", "s2")];
    expect(() =>
      planPendingMigrations(files, [appliedRow(1, "a", "TAMPERED")]),
    ).toThrow(/checksum/);
  });

  test("planPendingMigrations: неизвестная более новая версия → ошибка", () => {
    const files = [migrationFile(1, "a", "s1")];
    expect(() =>
      planPendingMigrations(files, [appliedRow(1, "a", "s1"), appliedRow(2, "future", "s2")]),
    ).toThrow(/новее всех известных/);
  });

  test("planPendingMigrations: применённая миграция без файла → ошибка", () => {
    const files = [migrationFile(1, "a", "s1"), migrationFile(3, "c", "s3")];
    expect(() =>
      planPendingMigrations(files, [appliedRow(1, "a", "s1"), appliedRow(2, "gone", "s2")]),
    ).toThrow(/файл отсутствует/);
  });
});
