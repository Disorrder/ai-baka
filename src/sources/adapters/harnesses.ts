/**
 * Реестр поддерживаемых harness'ов (docs/sources.md, docs/plan.md §7.1).
 *
 * Здесь только статические описания: slug, дефолтные source roots,
 * source_kind и snapshot_strategy. Файловые matcher'ы — в file-matchers.ts,
 * обнаружение на диске — в ../discovery/.
 */

export type HarnessSlug =
  | "codex"
  | "claude-code"
  | "claude-desktop"
  | "opencode"
  | "cursor"
  | "qwen-code"
  | "kimi-code";

export type SourceKind =
  | "file_tree"
  | "sqlite"
  | "file_backed"
  | "sqlite_and_files";

export type SnapshotStrategy = "copy" | "vacuum_into";

export interface HarnessDefinition {
  slug: HarnessSlug;
  displayName: string;
  sourceKind: SourceKind;
  snapshotStrategy: SnapshotStrategy;
  /** Имя env-переменной для переопределения списка root'ов (через запятую). */
  envOverride: string;
  /** Дефолтные пути (docs/sources.md); зависят от home и окружения. */
  defaultRoots: (ctx: { home: string; env: NodeJS.ProcessEnv }) => string[];
}

function joinHome(home: string, ...parts: string[]): string {
  return [home, ...parts].join("/");
}

export const HARNESS_ORDER: HarnessSlug[] = [
  "codex",
  "claude-code",
  "claude-desktop",
  "opencode",
  "cursor",
  "qwen-code",
  "kimi-code",
];

export const HARNESSES: Record<HarnessSlug, HarnessDefinition> = {
  codex: {
    slug: "codex",
    displayName: "Codex",
    sourceKind: "file_tree",
    snapshotStrategy: "copy",
    envOverride: "BAKA_SOURCES__CODEX",
    defaultRoots: ({ home }) => [
      joinHome(home, ".codex/archived_sessions"),
      joinHome(home, ".codex/sessions"),
      joinHome(home, ".codex/sqlite"),
    ],
  },
  "claude-code": {
    slug: "claude-code",
    displayName: "Claude Code",
    sourceKind: "file_tree",
    snapshotStrategy: "copy",
    envOverride: "BAKA_SOURCES__CLAUDE_CODE",
    defaultRoots: ({ home }) => [
      joinHome(home, ".claude/projects"),
      joinHome(home, ".claude/history.jsonl"),
    ],
  },
  "claude-desktop": {
    slug: "claude-desktop",
    displayName: "Claude Desktop",
    sourceKind: "file_backed",
    snapshotStrategy: "copy",
    envOverride: "BAKA_SOURCES__CLAUDE_DESKTOP",
    defaultRoots: ({ home }) => [
      // Локальные транскрипты local agent mode (local_*.json + audit.jsonl)
      joinHome(home, "Library/Application Support/Claude/local-agent-mode-sessions"),
      joinHome(home, "Library/Application Support/Claude/IndexedDB"),
      joinHome(home, "Library/Application Support/Claude/Session Storage"),
    ],
  },
  opencode: {
    slug: "opencode",
    displayName: "OpenCode",
    sourceKind: "sqlite",
    snapshotStrategy: "vacuum_into",
    envOverride: "BAKA_SOURCES__OPENCODE",
    defaultRoots: ({ home }) => [
      joinHome(home, ".local/share/opencode/opencode.db"),
      joinHome(home, ".local/share/opencode/storage/session_diff"),
    ],
  },
  cursor: {
    slug: "cursor",
    displayName: "Cursor",
    sourceKind: "sqlite_and_files",
    snapshotStrategy: "vacuum_into",
    envOverride: "BAKA_SOURCES__CURSOR",
    defaultRoots: ({ home }) => [
      joinHome(home, "Library/Application Support/Cursor/User/workspaceStorage"),
      joinHome(
        home,
        "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
      ),
    ],
  },
  "qwen-code": {
    slug: "qwen-code",
    displayName: "Qwen Code",
    sourceKind: "file_tree",
    snapshotStrategy: "copy",
    envOverride: "BAKA_SOURCES__QWEN_CODE",
    defaultRoots: ({ home }) => [joinHome(home, ".qwen/projects")],
  },
  "kimi-code": {
    slug: "kimi-code",
    displayName: "Kimi Code",
    sourceKind: "file_tree",
    snapshotStrategy: "copy",
    envOverride: "BAKA_SOURCES__KIMI_CODE",
    // KIMI_CODE_HOME переопределяет дефолтный ~/.kimi-code (docs/sources.md).
    defaultRoots: ({ home, env }) => {
      const kimiHome = env.KIMI_CODE_HOME?.trim() || joinHome(home, ".kimi-code");
      return [
        joinHome(kimiHome, "sessions"),
        joinHome(kimiHome, "session_index.jsonl"),
      ];
    },
  },
};
