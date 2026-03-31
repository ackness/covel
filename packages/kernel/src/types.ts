import type { RuntimePhase, RuntimeTriggerEvent } from "@covel/shared";
import type { RegisteredRuntime } from "@covel/plugin-runtime";

/** A runtime candidate selected by the trigger router. */
export interface CandidateRuntime {
  registered: RegisteredRuntime;
  triggerEvent: RuntimeTriggerEvent;
}

/** A runtime scheduled for execution with resolved ordering. */
export interface ScheduledRuntime {
  registered: RegisteredRuntime;
  triggerEvent: RuntimeTriggerEvent;
  phase: RuntimePhase;
  /** Topological layer within the phase (0 = first). */
  topoLayer: number;
}

/** Execution plan: ordered groups of runtimes to execute. */
export interface ExecutionPlan {
  /** Groups ordered by phase then topo layer. Same group runs in parallel. */
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

/** Options for kernel.executeTurn(). */
export interface KernelExecuteOptions {
  apiKeys?: Record<string, string>;
  traceId?: string;
}
