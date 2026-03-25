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

export interface PackageSummary {
  name: string;
  enabled: boolean;
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
  id: string;
  role: "assistant" | "user";
  content: string;
  streaming: boolean;
}

export interface WorkspaceState {
  timeline: TimelineItem[];
  pendingBlock: BlockEnvelope | null;
  lastTraceId: string | null;
}

export type { BlockEnvelope, BlockResponse, SseEnvelope, TraceRecord };
