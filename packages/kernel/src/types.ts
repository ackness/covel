import type { RuntimeTriggerEvent } from "@covel/shared";
import type { RegisteredRuntime } from "@covel/plugin-runtime";

/** Default runtime priority (midpoint of 0-1000 scale). */
export const DEFAULT_RUNTIME_PRIORITY = 500;
/** Runtimes at or above this priority run as background tasks. */
export const DEFAULT_BACKGROUND_THRESHOLD = 800;
/** Default max tool-calling steps for runtimes with tools. */
export const DEFAULT_MAX_STEPS = 10;
/** Default max steps for runtimes without tools (single LLM call). */
export const DEFAULT_MAX_STEPS_NO_TOOLS = 1;

/** A runtime candidate selected by the trigger router. */
export interface CandidateRuntime {
  registered: RegisteredRuntime;
  triggerEvent: RuntimeTriggerEvent;
}

/** A runtime scheduled for execution with resolved ordering. */
export interface ScheduledRuntime {
  registered: RegisteredRuntime;
  triggerEvent: RuntimeTriggerEvent;
  /** Effective execution priority (0 = highest = runs first). */
  priority: number;
}

/** Execution plan: ordered groups of runtimes to execute. */
export interface ExecutionPlan {
  /** Groups ordered by priority (ascending). Same group runs in parallel. */
  groups: ScheduledRuntime[][];
}

/** Mutable state accumulated during a turn. */
export interface TurnState {
  /** Key-value game state. */
  state: Record<string, unknown>;
  /** Appended events. */
  events: Array<{ type: string; payload: unknown; timestamp: string }>;
  /** Records (key → value). */
  records: Map<string, unknown>;
  /** Narrative text segments appended during this turn. */
  narrativeSegments: string[];
  /** UI render blocks. */
  renderBlocks: Array<{ type: string; content: unknown; source?: { runtimeId: string; pluginId: string } }>;
}

/** Per-request slot override from the frontend X-Slot-Config header. */
export interface SlotOverride {
  presetId: string;
}

/** Progress event emitted during kernel execution for real-time UI feedback. */
export interface KernelProgressEvent {
  type:
    | "runtime.started"
    | "runtime.completed"
    | "runtime.failed"
    | "llm.calling"
    | "tool.calling"
    | "tool.completed"
    | "message.delta";
  runtimeId: string;
  pluginId: string;
  /** Human-readable label (runtime kind or tool name). */
  label?: string;
  /** Extra detail (e.g. preset name, tool name, or text delta content). */
  detail?: string;
  timestamp: string;
}

/** A background task spawned for low-priority runtimes. */
export interface BackgroundTask {
  taskId: string;
  runtimeId: string;
  pluginId: string;
  status: "pending" | "running" | "completed" | "failed";
  description: string;
  result?: { text: string; proposals: Array<{ kind: string; payload: unknown }> };
  error?: string;
  startedAt: number;
  completedAt?: number;
}

/** Options for kernel.executeTurn(). */
export interface KernelExecuteOptions {
  apiKeys?: Record<string, string>;
  traceId?: string;
  /** Slot overrides from the frontend (maps slot name → preset ID). */
  slotOverrides?: Record<string, SlotOverride>;
  /** Called during execution to stream progress events to the client. */
  onProgress?: (event: KernelProgressEvent) => void | Promise<void>;
  /** Priority threshold for background execution (default: 800). Runtimes with priority >= this value run asynchronously. */
  backgroundThreshold?: number;
  /** Called when a background task completes or fails. */
  onBackgroundTaskDone?: (task: BackgroundTask) => void | Promise<void>;
}
