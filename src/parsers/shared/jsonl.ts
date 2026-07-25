/**
 * Чтение JSONL-файлов для parser'ов.
 *
 * Повреждённые строки не роняют разбор (план §11.2 corrupted/truncated
 * fixture): они возвращаются в errors и попадают в diagnostics parser'а.
 */

import { readFile } from "node:fs/promises";

export interface JsonlReadError {
  line: number;
  error: string;
  /** Обрезанное начало строки для диагностики (не полное содержимое). */
  excerpt: string;
}

export interface JsonlReadResult {
  records: Array<{ line: number; value: Record<string, unknown> }>;
  errors: JsonlReadError[];
}

export async function readJsonlFile(path: string): Promise<JsonlReadResult> {
  const text = await readFile(path, "utf8");
  const records: JsonlReadResult["records"] = [];
  const errors: JsonlReadError[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    if (raw.trim().length === 0) continue;
    const line = index + 1;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        records.push({ line, value: value as Record<string, unknown> });
      } else {
        errors.push({ line, error: "not a JSON object", excerpt: raw.slice(0, 120) });
      }
    } catch (error) {
      errors.push({
        line,
        error: error instanceof Error ? error.message : String(error),
        excerpt: raw.slice(0, 120),
      });
    }
  }
  return { records, errors };
}

/** Типобезопасные мелкие геттеры для сырых payload'ов. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** ISO-строка или epoch ms → Date; невалидное → undefined. */
export function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}
