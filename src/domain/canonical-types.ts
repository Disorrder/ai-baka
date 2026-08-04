/**
 * Parser contract — DTO канонического корпуса (docs/plan.md §11, §7.3).
 *
 * Parser'ы НЕ пишут в SurrealDB: они возвращают только эти структуры.
 * Поля отражают схему БД (schema/0001_initial.surql, таблицы
 * dialogue/dialogue_revision/message/chunk): writer (этап 5) отображает
 * DTO на записи БД почти один-в-один.
 */

import type {
  NormalizedChunkKind,
  NormalizedRole,
  UsageScope,
  VendorSlug,
} from "./enums.ts";

/** Результат разбора одного raw snapshot (план §11). */
export interface ParsedSourceSnapshot {
  /** source_kind источника (file_tree, sqlite, ...). */
  sourceKind: string;
  /** Диалоги snapshot'а; для SQLite-источников — поток из многих диалогов. */
  dialogues: AsyncIterable<ParsedDialogue>;
  /** Не фатальные проблемы разбора (corrupted lines, unknown events). */
  diagnostics: ParsedDiagnostic[];
}

export interface ParsedDialogue {
  /** external_id диалога в harness'е (session id и т.п.). */
  externalId?: string;
  title?: string;
  workspace?: ParsedWorkspace;
  startedAt?: Date;
  updatedAt?: Date;
  messages: ParsedMessage[];
  /** harness-specific metadata (originator, cli_version, forkedFrom, ...). */
  metadata: Record<string, unknown>;
}

export interface ParsedWorkspace {
  /** Локальный путь проекта (cwd/workDir). */
  path?: string;
  /** Отображаемое имя (обычно basename пути). */
  name?: string;
  /** Нормализованный git remote, если harness его сообщил. */
  repositoryIdentity?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedMessage {
  externalId?: string;
  /** Порядок внутри диалога (0-based, монотонный). */
  sequence: number;
  role: NormalizedRole;
  rawRole?: string;
  humanAuthored: boolean | "unknown";
  visibleToUser: boolean | "unknown";
  timestamp?: Date;
  /** Модель, которой сгенерировано сообщение (для assistant). */
  model?: ParsedModelInvocation;
  /**
   * Для human-authored user message: сколько пользователь ждал ответа в
   * рамках turn'а. Хранится на user message, потому что cancelled/aborted turn
   * может не иметь assistant message.
   */
  responseWaitMs?: number;
  responseStatus?: "completed" | "aborted" | "incomplete";
  responseCompletedAt?: Date;
  responseTurnId?: string;
  /** Исходные usage events; нормализованный usage выводится из них. */
  usageEvents: ParsedUsageEvent[];
  chunks: ParsedChunk[];
  metadata: Record<string, unknown>;
}

export interface ParsedChunk {
  /** Порядок внутри сообщения (0-based). */
  sequence: number;
  kind: NormalizedChunkKind;
  rawKind?: string;
  content?: string;
  /** line/index/JSON pointer на источник внутри raw snapshot. */
  sourceLocator?: string;
  /** Связка tool_call ↔ tool_result (план §19.2 сценарий 17). */
  toolCallId?: string;
  toolName?: string;
  /** Исходный event type harness'а (для unknown/object чанков). */
  rawEventType?: string;
  metadata: Record<string, unknown>;
}

/**
 * Вызов модели на уровне message (план §7.1 `model`):
 * базовая модель отделена от reasoning effort и service provider.
 */
export interface ParsedModelInvocation {
  /** Как назвал модель источник, например "gpt-5.6-sol-xhigh". */
  rawModelName: string;
  vendor: VendorSlug;
  /** Например "gpt-5.6-sol". */
  canonicalName: string;
  reasoningEffort?: string;
  /** OpenAI / kimi / OpenRouter / ... */
  serviceProvider?: string;
}

/**
 * Исходный usage event одного запроса/turn'а/сессии.
 * Правила сведения — в parsers/shared/usage-normalization.ts (план §7.3).
 */
export interface ParsedUsageEvent {
  scope: UsageScope;
  inputTokens?: number;
  /** Cache read/hit, подмножество input: НЕ прибавляется повторно. */
  cachedInputTokens?: number;
  /** Cache creation/write, подмножество input: НЕ прибавляется повторно. */
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  /** Подмножество output: НЕ прибавляется повторно к output. */
  reasoningOutputTokens?: number;
  /** total как сообщил источник — хранится отдельно. */
  totalTokensReported?: number;
  isEstimated?: boolean;
  /** Откуда взято, например "codex.token_count.last_token_usage". */
  source: string;
  /** Исходный payload (не теряется, план §7.3). */
  raw?: unknown;
}

/** Нормализованный usage object для message.usage (план §7.3). */
export interface NormalizedUsage {
  scope: UsageScope;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokensReported?: number;
  totalTokensNormalized?: number;
  isEstimated: boolean;
  source: string;
  normalizationVersion: number;
}

export interface ParsedDiagnostic {
  /** Машинный код, например "jsonl_parse_error", "unknown_event". */
  code: string;
  message: string;
  severity: "warning" | "error";
  /** Номер строки/путь внутри snapshot'а, если применимо. */
  sourceLocator?: string;
}
