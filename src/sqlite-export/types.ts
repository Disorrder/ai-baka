import type { ParsedMessage } from "../domain/canonical-types.ts";

export type ExportPreset = "qa-analysis" | "conversation" | "tools" | "instructions" | "full-canonical";
export type ContentCategory = "human_input" | "assistant_final" | "assistant_other" | "thought" | "tool_call" | "tool_result" | "instructions" | "usage" | "attachment" | "object" | "unknown";
export type FilterName = "harness" | "harnessInstallation" | "vendor" | "model" | "serviceProvider" | "reasoningEffort" | "host" | "platform" | "arch" | "workspace" | "dialogue" | "revision";
export interface ExportConfig {
  preset: ExportPreset;
  categories: ContentCategory[];
  instructions: "exclude" | "separate";
  unknownPolicy: "metadata" | "separate" | "include";
  matchScope: "turn" | "dialogue" | "message";
  revisions: "current" | "all";
  filters: Partial<Record<FilterName, string[]>>;
  excludeFilters: Partial<Record<FilterName, string[]>>;
  after?: string;
  before?: string;
  fields: string[];
  batchSize: number;
  maxRevisionBytes: number;
}
export interface ExportMessage extends ParsedMessage {
  id: string;
  /** Exact source order when SDK int64 cannot be represented by extractor number sequence. */
  sourceSequence?: bigint;
  modelId?: string;
  serviceProvider?: string;
  reasoningEffort?: string;
  usage?: Record<string, unknown>;
  chunks: Array<ParsedMessage["chunks"][number] & { id: string; sourceSequence?: bigint }>;
}
export interface RevisionManifestEntry {
  id: string;
  dialogueId: string;
  harness: string;
  harnessInstallation: string;
  host: string;
  hostLabel?: string;
  platform?: string;
  arch?: string;
  workspace?: string;
  title?: string;
  sourceRevision?: string;
  parserName: string;
  parserVersion: string;
  canonicalHash: string;
  messageCount: number;
  chunkCount: number;
  current: boolean;
  startedAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}
export interface ExportRevision {
  manifest: RevisionManifestEntry;
  messages: ExportMessage[];
}
/** Implementations must freeze the manifest before reading payloads. */
export interface ExportSource {
  manifest(config: ExportConfig, signal?: AbortSignal): AsyncIterable<RevisionManifestEntry[]>;
  /** Optional bounded source scan after the revision manifest has been frozen. */
  prepare?(entries: Iterable<RevisionManifestEntry>, config: ExportConfig, signal?: AbortSignal, progress?: (completed: number) => void): Promise<void>;
  close?(): Promise<void>;
  readRevision(entry: RevisionManifestEntry, config: ExportConfig, signal?: AbortSignal): Promise<ExportRevision>;
}
export interface ProjectedItem {
  id: string;
  messageId: string;
  sourceChunkIds: string[];
  sequence: number;
  chunkSequence: number;
  role: string;
  kind: string;
  category: ContentCategory;
  origin: string;
  content?: string;
  layer: "main" | "instructions" | "review" | "metadata";
  classification: "confirmed" | "unknown";
  reason: string;
  extractionMethod: string;
  turnId?: string;
  matched: boolean;
  context: boolean;
  toolCallId?: string;
  toolName?: string;
}
export interface ProjectedRelation {
  kind: string;
  fromId: string;
  toId?: string;
  externalRef?: string;
  status: "confirmed" | "ambiguous" | "unpaired" | "outside_export";
}
export interface RevisionProjection {
  items: ProjectedItem[];
  relations: ProjectedRelation[];
  counts: Record<string, number>;
}
export interface SqliteExportProgress {
  stage: "manifest" | "source_scan" | "matching" | "export" | "verify" | "publish";
  completed?: number;
  total?: number;
  counts: Readonly<Record<string, number>>;
}

export interface ExportOptions {
  out?: string;
  protectedPaths?: string[];
  force?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  exporterCommit?: string;
  progress?: (progress: SqliteExportProgress) => void;
}
export interface SqliteExportReport {
  status: "success" | "dry_run";
  format: string;
  formatVersion: number;
  outputPath?: string;
  bytes?: number;
  sha256?: string;
  counts: Record<string, number>;
  /** Completed data-phase measurements; verification/publication are outside these totals. */
  timingsMs: { manifest: number; sourceScan: number; matching: number; sourceRead: number; projection: number; sqliteWrite: number };
  checks: string[];
  limitations: string[];
  config: unknown;
  startedAt: string;
  completedAt: string;
}
