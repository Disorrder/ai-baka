import type { ExportConfig, ExportMessage, ExportRevision, ExportSource } from "../../src/sqlite-export/types.ts";

export function syntheticRevision(name = "one", host = "host:one"): ExportRevision {
  const messages: ExportMessage[] = [];
  const add = (role: ExportMessage["role"], content: string, extra: Partial<ExportMessage> = {}) => {
    const sequence = messages.length * 10;
    const id = `message:${name}_${sequence}`;
    const message: ExportMessage = { id, sequence, role, humanAuthored: role === "user", visibleToUser: role === "user" || role === "assistant", timestamp: new Date("2026-09-01T00:00:00Z"), usageEvents: [], chunks: [{ id: `chunk:${name}_${sequence}_0`, sequence: 0, kind: "text", content, metadata: {} }], metadata: role === "assistant" ? { phase: "final_answer" } : {}, ...extra };
    if (role === "assistant") message.model = { canonicalName: "model-a", rawModelName: "model-a", vendor: "openai", serviceProvider: "provider-a", reasoningEffort: "high" };
    messages.push(message); return message;
  };
  add("system", "DENIED_SYSTEM_CONTEXT");
  const user = add("user", "DENIED_MIXED_WRAPPER\nисправь функцию", { humanAuthored: false, metadata: { userMessageText: "исправь функцию", confirmedBy: "event_msg.user_message", nested: { systemPrompt: "DENIED_METADATA_SECRET" } } });
  user.chunks.push({ id: `chunk:${name}_auto`, sequence: 3, kind: "text", content: "DENIED_AUTOCONTEXT_AGENTS", metadata: { autoContext: true } });
  const assistant = add("assistant", "Первый ответ — 東京");
  assistant.chunks.push({ id: `chunk:${name}_thought`, sequence: 4, kind: "thought", content: "DENIED_THOUGHT", metadata: {} });
  assistant.chunks.push({ id: `chunk:${name}_call`, sequence: 8, kind: "tool_call", content: '{"command":"DENIED_TOOL_ARGS"}', toolCallId: "same-call", toolName: "shell", metadata: {} });
  const tool = add("tool", "");
  tool.chunks = [{ id: `chunk:${name}_result`, sequence: 1, kind: "tool_result", content: "DENIED_TOOL_RESULT", toolCallId: "same-call", metadata: {} }];
  add("user", "да");
  add("assistant", "Второй ответ");
  add("user", "да", { responseStatus: "aborted", timestamp: undefined });
  return { manifest: { id: `dialogue_revision:${name}`, dialogueId: `dialogue:${name}`, harness: "codex", harnessInstallation: "harness_installation:one", host, hostLabel: "DENIED_HOST_LABEL", workspace: "workspace:private", title: "DENIED_TITLE", platform: "darwin", arch: "arm64", parserName: "codex", parserVersion: "synthetic", canonicalHash: "a".repeat(64), sourceRevision: `source_revision:${name}`, messageCount: messages.length, chunkCount: messages.reduce((n,m) => n+m.chunks.length,0), current: true }, messages };
}
export function syntheticSource(revisions: ExportRevision[], onRead?: (revision: ExportRevision) => void): ExportSource {
  return {
    async *manifest(config: ExportConfig) {
      const values = (r: ExportRevision): Record<string, string | undefined> => ({ harness: r.manifest.harness, harnessInstallation: r.manifest.harnessInstallation, host: r.manifest.host, platform: r.manifest.platform, arch: r.manifest.arch, workspace: r.manifest.workspace, dialogue: r.manifest.dialogueId, revision: r.manifest.id });
      const corpus = revisions.filter(r => (config.revisions === "all" || r.manifest.current) && Object.entries(values(r)).every(([key,value]) => {
        const wanted = config.filters[key as keyof ExportConfig["filters"]], denied = config.excludeFilters[key as keyof ExportConfig["filters"]];
        return (!wanted?.length || value !== undefined && wanted.includes(value)) && (!denied?.length || value === undefined || !denied.includes(value));
      }));
      for (let i=0;i<corpus.length;i+=config.batchSize) yield corpus.slice(i,i+config.batchSize).map(r => structuredClone(r.manifest));
    },
    async readRevision(entry) {
      const revision = revisions.find(r => r.manifest.id === entry.id);
      if (!revision) throw new Error("sqlite export: synthetic frozen revision missing");
      onRead?.(revision);
      return structuredClone(revision);
    },
  };
}
