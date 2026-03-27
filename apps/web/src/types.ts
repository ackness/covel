import type { BlockEnvelope, BlockResponse, SseEnvelope } from "../../../modules/contracts/src/index.js";
import type { TaskBindings, TraceRecord } from "../../../modules/domain/src/index.js";

export interface WorldRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  worldId: string;
  status: string;
  createdAt: string;
  presetId?: string;
  taskBindings?: TaskBindings;
}

export interface MessageRecord {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt?: string;
}

export interface ArchiveRecord {
  id: string;
  sessionId: string;
  turnCutoff: number;
  createdAt: string;
}

export interface PackageStateRecord {
  scope: "world" | "session";
  ownerId: string;
  packageName: string;
  collection: string;
  key: string;
  value: Record<string, unknown>;
  updatedAt: string;
}

export interface WorkflowSnapshotRecord {
  runId: string;
  stepId: string;
  sessionId: string;
  status: "running" | "suspended" | "completed" | "failed";
  suspendPayload?: Record<string, unknown>;
  resumeData?: Record<string, unknown>;
  updatedAt: string;
}

export interface PackageSummary {
  name: string;
  enabled: boolean;
}

export interface CommandFlagHint {
  name: string;
  description: string;
  takesValue: boolean;
}

export interface CommandSummary {
  name: string;
  description: string;
  usage: string;
  examples?: string[];
  positionalHints?: string[];
  flagHints?: CommandFlagHint[];
}

export interface PresetSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
}

export interface TimelineItem {
  kind: "message";
  id: string;
  role: "assistant" | "user";
  content: string;
  streaming: boolean;
}

export interface TimelineBlockItem {
  kind: "block";
  id: string;
  block: BlockEnvelope;
  pending: boolean;
}

export interface RuntimeArtifactItem {
  id: string;
  kind: string;
  mediaType?: string;
  uri?: string;
  title?: string;
  status?: string;
  traceId?: string | null;
}

export interface StatePatchEvent {
  id: string;
  target: string;
  summary: string;
  scopeLabel?: string;
  traceId?: string | null;
  packageName?: string;
}

export interface WorkflowRunItem {
  id: string;
  workflowId?: string;
  status: "suspended" | "running" | "completed";
  currentStep?: string;
  summary: string;
  traceId?: string | null;
}

export interface WorkspaceState {
  timeline: Array<TimelineItem | TimelineBlockItem>;
  pendingBlock: BlockEnvelope | null;
  lastTraceId: string | null;
  recentArtifacts: RuntimeArtifactItem[];
  recentStatePatches: StatePatchEvent[];
  workflowRuns: WorkflowRunItem[];
}

export type { BlockEnvelope, BlockResponse, SseEnvelope, TraceRecord };
