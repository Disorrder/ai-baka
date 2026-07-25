/**
 * Генератор обезличенных SQLite fixtures формата Cursor state.vscdb.
 *
 * Реальный формат (cursorDiskKV / ItemTable / composerHeaders) собирается из
 * декларативных спек (specs.ts) во временную БД в os.tmpdir() — бинарные .db
 * в Git не коммитятся, fixtures полностью текстовые и ревьюабельные.
 */

import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CursorBubbleSpec {
  bubbleId: string;
  /** Объект bubble или сырая строка (corrupted JSON). */
  value: Record<string, unknown> | string;
}

export interface CursorComposerSpec {
  composerId: string;
  /** Объект composerData, сырая строка (corrupted) или отсутствует. */
  composerData?: Record<string, unknown> | string;
  /** Строка таблицы composerHeaders (новый формат). */
  header?: {
    workspaceId?: string;
    createdAt?: number;
    lastUpdatedAt?: number;
    isArchived?: boolean;
    isSubagent?: boolean;
    /** JSON value-строки composerHeaders (workspaceIdentifier и т.п.). */
    value?: Record<string, unknown>;
  };
  bubbles?: CursorBubbleSpec[];
}

export interface CursorFixtureSpec {
  composers: CursorComposerSpec[];
  /** ItemTable composer.composerHeaders ({allComposers: [...]}). */
  itemTableComposerHeaders?: Record<string, unknown>;
  /** Дополнительные ItemTable ключи (aiService.* и т.п.). */
  itemTable?: Record<string, unknown>;
  /** Дополнительные cursorDiskKV ключи (checkpointId:* и т.п.). */
  extraKv?: Record<string, string>;
}

export interface CursorFixtureDb {
  path: string;
  cleanup: () => Promise<void>;
}

export async function makeCursorDb(spec: CursorFixtureSpec): Promise<CursorFixtureDb> {
  const dir = await mkdtemp(join(tmpdir(), "baka-cursor-fixture-"));
  const path = join(dir, "state.vscdb");
  const db = new Database(path);
  try {
    db.run("CREATE TABLE ItemTable (key TEXT, value BLOB)");
    db.run("CREATE TABLE cursorDiskKV (key TEXT, value BLOB)");
    db.run(
      "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT)",
    );

    const insertKv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const insertItem = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    const insertHeader = db.prepare(
      "INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    for (const composer of spec.composers) {
      if (composer.composerData !== undefined) {
        insertKv.run(
          `composerData:${composer.composerId}`,
          typeof composer.composerData === "string"
            ? composer.composerData
            : JSON.stringify(composer.composerData),
        );
      }
      for (const bubble of composer.bubbles ?? []) {
        insertKv.run(
          `bubbleId:${composer.composerId}:${bubble.bubbleId}`,
          typeof bubble.value === "string" ? bubble.value : JSON.stringify(bubble.value),
        );
      }
      if (composer.header) {
        const header = composer.header;
        insertHeader.run(
          composer.composerId,
          header.workspaceId ?? null,
          header.createdAt ?? null,
          header.lastUpdatedAt ?? null,
          header.isArchived ? 1 : 0,
          header.isSubagent ? 1 : 0,
          header.lastUpdatedAt ?? header.createdAt ?? null,
          null,
          header.value ? JSON.stringify(header.value) : null,
        );
      }
    }

    if (spec.itemTableComposerHeaders !== undefined) {
      insertItem.run("composer.composerHeaders", JSON.stringify(spec.itemTableComposerHeaders));
    }
    for (const [key, value] of Object.entries(spec.itemTable ?? {})) {
      insertItem.run(key, JSON.stringify(value));
    }
    for (const [key, value] of Object.entries(spec.extraKv ?? {})) {
      insertKv.run(key, value);
    }
  } finally {
    db.close();
  }
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// --- общие строительные блоки спек ---

export function workspaceIdentifier(fsPath: string): Record<string, unknown> {
  return {
    id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    uri: {
      $mid: 1,
      fsPath,
      external: `file://${fsPath}`,
      path: fsPath,
      scheme: "file",
    },
  };
}

export function composerDataSpec(input: {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  bubbleRefs: Array<{ bubbleId: string; type: 1 | 2 | number }>;
  usageData?: Record<string, { costInCents: number; amount: number }>;
  unifiedMode?: string;
  isAgentic?: boolean;
}): Record<string, unknown> {
  return {
    _v: 3,
    composerId: input.composerId,
    richText: "",
    hasLoaded: true,
    text: "",
    fullConversationHeadersOnly: input.bubbleRefs,
    status: "completed",
    lastUpdatedAt: input.lastUpdatedAt,
    createdAt: input.createdAt,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.usageData !== undefined ? { usageData: input.usageData } : {}),
    unifiedMode: input.unifiedMode ?? "agent",
    isAgentic: input.isAgentic ?? false,
  };
}

export function userBubble(
  bubbleId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _v: 2,
    type: 1,
    bubbleId,
    text,
    images: [],
    relevantFiles: [],
    contextPieces: [],
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    ...extra,
  };
}

export function assistantBubble(
  bubbleId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _v: 2,
    type: 2,
    bubbleId,
    text,
    isThought: false,
    allThinkingBlocks: [],
    toolResults: [],
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    capabilitiesRan: {},
    ...extra,
  };
}

export function toolBubble(input: {
  bubbleId: string;
  toolCallId: string;
  name: string;
  rawArgs: Record<string, unknown>;
  result: Record<string, unknown> | string;
  text?: string;
  tokenCount?: { inputTokens: number; outputTokens: number };
}): Record<string, unknown> {
  return assistantBubble(input.bubbleId, input.text ?? "", {
    capabilityType: 15,
    usageUuid: "11111111-2222-3333-4444-555555555555",
    ...(input.tokenCount !== undefined ? { tokenCount: input.tokenCount } : {}),
    toolFormerData: {
      tool: 5,
      toolCallId: input.toolCallId,
      status: "completed",
      rawArgs: JSON.stringify(input.rawArgs),
      name: input.name,
      params: JSON.stringify(input.rawArgs),
      additionalData: {},
      result:
        typeof input.result === "string" ? input.result : JSON.stringify(input.result),
    },
  });
}
