/**
 * Нормализованные перечисления канонической модели (docs/plan.md §7.3).
 *
 * Значения соответствуют строковым полям схемы БД (schema/0001_initial.surql):
 * message.role, chunk.kind, vendor.slug.
 */

/** message.role — нормализованная роль сообщения. */
export type NormalizedRole =
  | "user"
  | "assistant"
  | "system"
  | "developer"
  | "tool"
  | "unknown";

/** chunk.kind — нормализованный тип чанка (план §7.3 `chunk`). */
export type NormalizedChunkKind =
  | "text"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "system"
  | "developer"
  | "usage"
  | "object"
  | "attachment"
  | "unknown";

/** vendor.slug — известные производители моделей (план §7.1 `vendor`). */
export type VendorSlug =
  | "openai"
  | "anthropic"
  | "alibaba"
  | "google"
  | "meta"
  | "moonshot"
  | "unknown";

/** Scope нормализованного usage (план §7.3 `message.usage`). */
export type UsageScope = "request" | "turn" | "session_cumulative" | "unknown";
