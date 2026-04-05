import type { ModelParameterOverrides } from "@covel/ai-provider";
import type { KernelInput, RuntimeTriggerEvent } from "@covel/shared";
import type { RegisteredRuntime } from "@covel/plugin-runtime";

/** Default runtime priority (midpoint of 0-1000 scale). */
export const DEFAULT_RUNTIME_PRIORITY = 500;
/** Runtimes at or above this priority run as background tasks. */
export const DEFAULT_BACKGROUND_THRESHOLD = 800;
/** Default max tool-calling steps for runtimes with tools. */
export const DEFAULT_MAX_STEPS = 10;
/** Default max steps for runtimes without tools (single LLM call). */
export const DEFAULT_MAX_STEPS_NO_TOOLS = 1;
/** Default max total tool invocations per runtime execution. */
export const DEFAULT_MAX_TOOL_CALLS = 20;
/** Default per-tool-call timeout in milliseconds (10 seconds). */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

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

/** Per-runtime model binding map: qualifiedRuntimeId → slotName. */
export type RuntimeBindingMap = Record<string, string>;
/** Per-slot preset override map: slotName → presetId. */
export type SlotPresetOverrideMap = Record<string, string>;
/** Per-slot generation parameter override map: slotName → overrides. */
export type SlotParameterOverrideMap = Record<string, ModelParameterOverrides>;

/** Progress event emitted during kernel execution for real-time UI feedback. */
export interface KernelProgressEvent {
  type:
    | "runtime.started"
    | "runtime.completed"
    | "runtime.failed"
    | "llm.calling"
    | "llm.responded"
    | "tool.calling"
    | "tool.completed"
    | "message.delta";
  runtimeId: string;
  pluginId: string;
  /** Human-readable label (runtime kind or tool name). */
  label?: string;
  /** Extra detail (e.g. preset name, tool name, or text delta content). */
  detail?: string;
  /** Structured payload for rich trace data (prompt messages, tool results, etc.). */
  data?: Record<string, unknown>;
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
  /** Per-runtime model bindings from the frontend (qualifiedRuntimeId → slotName). */
  runtimeBindings?: RuntimeBindingMap;
  /** Per-slot preset overrides from the frontend (slotName → presetId). */
  slotPresetOverrides?: SlotPresetOverrideMap;
  /** Per-slot generation parameter overrides from the frontend. */
  slotParameterOverrides?: SlotParameterOverrideMap;
  /**
   * Per-turn runtime priority overrides keyed by qualified runtime ID
   * ("pluginId:runtimeId"). Merged on top of session-level overrides.
   */
  runtimePriorityOverrides?: Record<string, number>;
  /** Called during execution to stream progress events to the client. */
  onProgress?: (event: KernelProgressEvent) => void | Promise<void>;
  /** Priority threshold for background execution (default: 800). Runtimes with priority >= this value run asynchronously. */
  backgroundThreshold?: number;
  /** Called when a background task completes or fails. */
  onBackgroundTaskDone?: (task: BackgroundTask) => void | Promise<void>;
  /**
   * Retry from a specific runtime. All runtimes with priority < this runtime's
   * priority group will replay cached results; runtimes at >= this priority re-execute.
   * Requires a previous turn's cache (populated automatically after each executeTurn).
   */
  retryFromRuntimeId?: string;
}

/** Cached result of a single runtime execution (for retry). */
export interface CachedRuntimeResult {
  runtimeId: string;
  pluginId: string;
  priority: number;
  narrative: string;
  proposals: Array<{ kind: string; payload: unknown }>;
}

/** Cache of a complete turn execution (for retry). */
export interface TurnCache {
  turnId: string;
  input: KernelInput;
  /** Runtime results ordered by execution sequence. */
  runtimeResults: CachedRuntimeResult[];
  /** The original execution options (minus callbacks). */
  apiKeys?: Record<string, string>;
  runtimeBindings?: RuntimeBindingMap;
  slotPresetOverrides?: SlotPresetOverrideMap;
  slotParameterOverrides?: SlotParameterOverrideMap;
  /** Snapshot of kernelContext.state before proposals were committed (for retry state revert). */
  preCommitState: Record<string, unknown>;
}
