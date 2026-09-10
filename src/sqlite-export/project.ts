import { HARNESS_TOOLS } from "../sync/harness-tools.ts";
import type { HarnessSlug } from "../sources/adapters/harnesses.ts";
import type { ContentCategory, ExportConfig, ExportMessage, ExportRevision, ProjectedItem, RevisionProjection } from "./types.ts";

export const CLASSIFIER_VERSION = 1;
const EXECUTION_FILTERS = ["vendor", "model", "serviceProvider", "reasoningEffort"] as const;
const USAGE_NUMBERS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokensReported", "totalTokensNormalized"];
function normalizedUsageContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = Object.fromEntries(Object.entries(value).filter(([key, v]) => USAGE_NUMBERS.includes(key) && (typeof v === "bigint" || typeof v === "number" && Number.isSafeInteger(v))));
  return Object.keys(usage).length ? JSON.stringify(usage, (_, v) => typeof v === "bigint" ? v.toString() : v) : undefined;
}
export function matchesExecution(message: ExportMessage, config: ExportConfig): boolean {
  const values = { vendor: message.model?.vendor, model: message.model?.canonicalName, serviceProvider: message.serviceProvider ?? message.model?.serviceProvider, reasoningEffort: message.reasoningEffort ?? message.model?.reasoningEffort };
  return EXECUTION_FILTERS.every(key => {
    const wanted = config.filters[key], denied = config.excludeFilters[key], value = values[key];
    return (!wanted?.length || value !== undefined && wanted.includes(value)) && (!denied?.length || value === undefined || !denied.includes(value));
  });
}
export function hasExecutionFilters(config: ExportConfig): boolean {
  return EXECUTION_FILTERS.some(k => config.filters[k]?.length || config.excludeFilters[k]?.length);
}
function isInjection(message: ExportMessage, chunk: ExportMessage["chunks"][number]): boolean {
  if (message.role === "system" || message.role === "developer" || chunk.kind === "system" || chunk.kind === "developer") return true;
  if (chunk.kind === "tool_call" || chunk.kind === "tool_result") return false;
  if (message.rawRole === "compacted" || message.metadata.isMeta === true) return true;
  if (chunk.metadata.autoContext === true && message.metadata.userMessageText !== chunk.content) return true;
  return message.role === "user" && (
    typeof message.metadata.originKind === "string" && message.metadata.originKind !== "human" ||
    message.metadata.parentToolUseId !== undefined || message.metadata.subagentId !== undefined
  );
}
function human(message: ExportMessage, harness: string): boolean {
  return message.role === "user" && (message.humanAuthored === true || message.metadata.originKind === "human" || harness === "codex" && typeof message.metadata.userMessageText === "string");
}
/** Establish conservative boundaries before filtering, including legacy ambiguous user text. */
export function projectRevision(revision: ExportRevision, config: ExportConfig, matchedDialogue?: boolean): RevisionProjection {
  const { manifest } = revision;
  const messages = [...revision.messages].sort((a, b) => a.sequence - b.sequence);
  const extractor = HARNESS_TOOLS[manifest.harness as HarnessSlug]?.extractors;
  const counts: Record<string, number> = {};
  const count = (reason: string) => { counts[reason] = (counts[reason] ?? 0) + 1; };
  const turns: ExportMessage[][] = [];
  for (const message of messages) {
    const boundary = message.role === "user" && message.chunks.some(c => c.kind === "text" && !isInjection(message, c));
    if (!turns.length || boundary) turns.push([]);
    turns.at(-1)!.push(message);
    if (!message.timestamp) count("messages_missing_timestamp");
  }
  const executionFilter = hasExecutionFilters(config);
  const dialogueMatch = matchedDialogue ?? messages.some(m => matchesExecution(m, config) && (m.role === "assistant" || m.model !== undefined));
  const items: ProjectedItem[] = [];
  for (const turn of turns) {
    const turnId = `${manifest.id}:turn:${turn[0]!.id}`;
    const turnMatch = turn.some(m => matchesExecution(m, config) && (m.role === "assistant" || m.model !== undefined));
    const selected = (m: ExportMessage) => {
      const values = { vendor: m.model?.vendor, model: m.model?.canonicalName, serviceProvider: m.serviceProvider ?? m.model?.serviceProvider, reasoningEffort: m.reasoningEffort ?? m.model?.reasoningEffort };
      if (EXECUTION_FILTERS.some(k => values[k] !== undefined && config.excludeFilters[k]?.includes(values[k]!))) return false;
      return !executionFilter || (config.matchScope === "message" ? matchesExecution(m, config) : config.matchScope === "dialogue" ? dialogueMatch : turnMatch);
    };
    const inTime = (m: ExportMessage) => (!config.after && !config.before) || !!m.timestamp && (!config.after || m.timestamp.toISOString() >= config.after) && (!config.before || m.timestamp.toISOString() < config.before);
    const cleanTurn = turn.map(m => ({
      ...m,
      humanAuthored: human(m, manifest.harness) ? true as const : m.humanAuthored === false && m.role === "user" ? "unknown" as const : m.humanAuthored,
      visibleToUser: m.visibleToUser === false && m.metadata.sidechain !== true && m.metadata.parentToolUseId === undefined && m.metadata.subagentId === undefined ? "unknown" as const : m.visibleToUser,
      chunks: m.chunks.filter(c => !isInjection(m, c)),
    }));
    const final = extractor?.extractAssistantFinal(cleanTurn);
    const messagesBySequence = new Map<number, ExportMessage>();
    if (final) for (const message of turn) {
      if (!messagesBySequence.has(message.sequence)) messagesBySequence.set(message.sequence, message);
    }
    const chunksByMessage = new Map<number, Map<number, ExportMessage["chunks"][number]>>();
    const finalSources = final?.sourceChunks.flatMap(s => {
      const m = messagesBySequence.get(s.messageSequence);
      let sourceChunks = chunksByMessage.get(s.messageSequence);
      if (m && !sourceChunks) {
        sourceChunks = new Map();
        for (const chunk of m.chunks) if (!sourceChunks.has(chunk.sequence)) sourceChunks.set(chunk.sequence, chunk);
        chunksByMessage.set(s.messageSequence, sourceChunks);
      }
      const c = sourceChunks?.get(s.chunkSequence);
      return m && c ? [{ m, c }] : [];
    }) ?? [];
    const finalSourceIds = new Set(finalSources.map(s => s.c.id));
    const emit = (m: ExportMessage, chunks: ExportMessage["chunks"], category: ContentCategory, content: string | undefined, confirmed: boolean, reason: string, method = "canonical_chunk", kind: string = chunks[0]?.kind ?? "text") => {
      if (!selected(m)) { count("items_excluded_execution"); return; }
      if (!inTime(m)) { count("items_excluded_time"); return; }
      if (category === "instructions" ? config.instructions !== "separate" : !config.categories.includes(category)) { count("items_excluded_category"); return; }
      if (category === "usage" && !config.fields.includes("messages.usage")) { count("items_excluded_fields"); return; }
      const layer = category === "instructions" ? "instructions" : confirmed || config.unknownPolicy === "include" ? "main" : config.unknownPolicy === "separate" ? "review" : "metadata";
      const first = chunks[0];
      items.push({ id: `${m.id}:${category}:${first?.sequence ?? "derived"}`, messageId: m.id, sourceChunkIds: chunks.map(c => c.id), sequence: m.sequence, chunkSequence: first?.sequence ?? 0, role: m.role, kind, category, origin: category === "instructions" ? "harness_injection" : category === "human_input" && confirmed ? "human_input" : category === "tool_result" ? "tool_output" : category.startsWith("assistant") ? "assistant_output" : category === "attachment" ? "attachment" : "unknown", ...(layer === "metadata" ? {} : { content }), layer, classification: confirmed ? "confirmed" : "unknown", reason, extractionMethod: method, turnId, matched: !executionFilter || matchesExecution(m, config), context: executionFilter && !matchesExecution(m, config), toolCallId: first?.toolCallId, toolName: first?.toolName });
      count(`items_${layer}`);
      if (!confirmed) count("items_ambiguous");
    };
    for (const m of turn) {
      const humanChunks = m.chunks.filter(c => c.kind === "text" && !isInjection(m, c));
      const confirmedHuman = human(m, manifest.harness);
      if (m.role === "user" && humanChunks.length) {
        const normalized = cleanTurn.find(x => x.id === m.id)!;
        const doc = extractor?.extractUserPrompt(normalized);
        emit(m, humanChunks, "human_input", doc?.content ?? humanChunks.map(c => c.content ?? "").join("\n"), confirmedHuman, confirmedHuman ? "human_structural_evidence" : "legacy_ambiguous_authorship", doc?.extractionMethod ?? "canonical_text_chunks");
        if (manifest.harness === "codex" && doc?.extractionMethod === "codex_user_message_event") {
          const original = humanChunks.map(c => c.content ?? "").join("\n");
          const at = original.indexOf(doc.content);
          if (original !== doc.content && at >= 0 && at === original.lastIndexOf(doc.content)) {
            const wrapper = original.slice(0,at) + original.slice(at + doc.content.length);
            emit(m, humanChunks, "instructions", wrapper, true, "codex_confirmed_input_remainder", "codex_user_message_event_difference");
          } else if (original !== doc.content) count("mixed_wrapper_not_recoverable");
        }
      }
      for (const c of m.chunks) {
        if (isInjection(m, c)) { emit(m, [c], "instructions", c.content, true, "structural_instruction"); continue; }
        if (c.kind === "text" && m.role === "user") continue;
        if (c.kind === "text" && m.role === "assistant") {
          if (finalSourceIds.has(c.id)) continue;
          emit(m, [c], "assistant_other", c.content, m.visibleToUser === true, m.visibleToUser === true ? "visible_assistant_text" : "legacy_ambiguous_visibility");
          continue;
        }
        const category: ContentCategory = c.kind === "text" ? "unknown" : c.kind as ContentCategory;
        if (category === "usage") {
          let parsed: unknown;
          try { parsed = JSON.parse(c.content ?? "null"); } catch { parsed = undefined; }
          const content = normalizedUsageContent(parsed);
          if (content === undefined) count("usage_payload_unavailable");
          emit(m, [c], "usage", content, true, content === undefined ? "usage_payload_unavailable" : "normalized_usage_allowlist", "normalized_usage");
          continue;
        }
        const confirmed = category !== "unknown" && category !== "object";
        emit(m, [c], category, c.content, confirmed, confirmed ? "canonical_kind" : "unclassified_canonical_kind");
      }
      // A normalized numeric usage object is selectable; raw usage events are never disclosed.
      if (m.usage && !m.chunks.some(c => c.kind === "usage")) {
        const content = normalizedUsageContent(m.usage);
        if (content !== undefined) emit(m, [], "usage", content, true, "normalized_usage_allowlist", "normalized_usage", "usage");
        else count("usage_payload_unavailable");
      }
    }
    if (final && finalSources.length) {
      const first = finalSources[0]!;
      // A derived document cannot carry forbidden portions from another timestamp/model.
      if (finalSources.every(s => selected(s.m) && inTime(s.m))) {
        const visible = finalSources.every(s => s.m.visibleToUser === true);
        const confirmedFinal = !final.extractionMethod.startsWith("fallback_") && visible;
        const visibleProjection = !confirmedFinal && visible && config.categories.includes("assistant_other");
        emit(first.m, finalSources.map(s => s.c), visibleProjection ? "assistant_other" : "assistant_final", final.content, confirmedFinal || visibleProjection, confirmedFinal ? "harness_final_evidence" : visibleProjection ? "visible_assistant_text_fallback" : "ambiguous_final_or_visibility", final.extractionMethod, "text");
      } else count("items_excluded_derived_scope");
    }
  }
  const relations: RevisionProjection["relations"] = [];
  const tools = items.filter(i => i.category === "tool_call" || i.category === "tool_result");
  const groups = new Map<string, ProjectedItem[]>();
  for (const item of tools) {
    if (!item.toolCallId) { relations.push({ kind: "tool_call_result", fromId: item.id, status: "unpaired" }); continue; }
    const key = `${manifest.id}\0${item.toolCallId}`;
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const calls = group.filter(i => i.category === "tool_call"), results = group.filter(i => i.category === "tool_result");
    if (calls.length === 1 && results.length === 1) relations.push({ kind: "tool_call_result", fromId: calls[0]!.id, toId: results[0]!.id, status: "confirmed" });
    else for (const item of group) relations.push({ kind: "tool_call_result", fromId: item.id, status: calls.length > 1 || results.length > 1 ? "ambiguous" : "unpaired" });
  }
  return { items, relations, counts };
}
