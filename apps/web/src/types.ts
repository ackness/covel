import type { BlockEnvelope, BlockResponse, SseEnvelope } from "../../../modules/contracts/src/index.js";
import type { TraceRecord } from "../../../modules/domain/src/index.js";

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
