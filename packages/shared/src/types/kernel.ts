import type {
  RuntimeBudget,
  RuntimeIsolationSpec,
  RuntimeTriggerEvent,
  SlotTag,
} from "./common.js";
import type { CharacterCard } from "./character.js";

export type SessionPhase = "init" | "character_creation" | "playing" | "ended";

/** Kernel input contract */
export interface KernelInput {
  runId: string;
  branchId: string;
  actorId: string;
  /** Input type. Known values are listed; `(string & {})` allows plugin-defined custom types while preserving autocomplete. */
  type: "user.input" | "system.event" | "session_start" | "manual_action" | "interval_tick" | (string & {});
  locale?: string;
  payload: Record<string, unknown>;
}

/** Background task info included in turn result */
export interface BackgroundTaskInfo {
  taskId: string;
  runtimeId: string;
  pluginId: string;
  status: "pending" | "running" | "completed" | "failed";
  description: string;
}

/**
 * Post-commit state snapshot — full game state after all proposals are applied.
 * Used for persistence: T1/T2 → client IdbStore, T3 → server PgStore.
 */
export interface TurnStateSnapshot {
  /** Full game state after commit. */
  state: Record<string, unknown>;
  /** Events emitted during this turn. */
  events: Array<{ type: string; payload: unknown; timestamp: string }>;
  /** Records upserted during this turn (key → value). */
  records: Record<string, unknown>;
}

/** Kernel turn result */
export interface KernelTurnResult {
  runId: string;
  branchId: string;
  turnId: string;
  traceId: string;
  locale: string;
  proposals: KernelProposalEnvelope[];
  commit?: CommitResult;
  render: RenderResult;
  followUpEvents: RuntimeTriggerEvent[];
  /** Background tasks that were spawned but not awaited during this turn. */
  backgroundTasks?: BackgroundTaskInfo[];
  /**
   * Post-commit state snapshot for persistence.
   * Contains the full game state, events, and records after all proposals
   * have been committed. Absent when commit was blocked by hooks.
   */
  stateSnapshot?: TurnStateSnapshot;
}

/** Kernel proposal envelope */
export interface KernelProposalEnvelope {
  proposalId: string;
  runId: string;
  branchId: string;
  turnId: string;
  runtimeId: string;
  pluginId: string;
  traceId: string;
  items: KernelProposalItem[];
}

/** Single proposal item */
export interface KernelProposalItem {
  kind:
    | "narrative.append"
    | "state.patch"
    | "event.emit"
    | "record.upsert"
    | "ui.render"
    | "asset.generate";
  payload: unknown;
}

/** Validated proposal envelope */
export interface ValidatedProposalEnvelope extends KernelProposalEnvelope {
  validatedAt: string;
}

/** Commit result */
export interface CommitResult {
  commitId: string;
  turnId: string;
  branchId: string;
  committedAt: string;
  snapshotId?: string;
}

/** Render result */
export interface RenderResult {
  blocks: RenderBlock[];
}

/** Render block */
export interface RenderBlock {
  type: string;
  content: unknown;
  source?: {
    runtimeId: string;
    pluginId: string;
  };
}

/** Runtime context view — read-only context provided to runtimes */
export interface RuntimeContextView {
  run: {
    runId: string;
    worldId?: string;
    branchId: string;
    turnId: string;
    status?: string;
    phase?: string;
    defaultLocale?: string;
    activeBranchId?: string;
  };
  locale: string;
  /** The specific event that triggered this runtime, when applicable. */
  event?: RuntimeTriggerEvent;
  world?: unknown;
  chat?: unknown;
  characters?: CharacterCard[];
  state?: unknown;
  record?: unknown[];
  events?: RuntimeTriggerEvent[];
  runtimeSettings?: {
    flat?: Record<string, unknown>;
    byPlugin?: Record<string, Record<string, unknown>>;
  };
  narrative?: {
    content: string;
    messageId?: string;
  };
  archive?: {
    activeVersion?: number;
    latestVersion?: number;
    summary?: string;
  };
  runtime: {
    runtimeId: string;
    pluginId: string;
    kind: string;
    priority: number;
    allowedTools: string[];
    providerTag?: SlotTag;
    budget?: RuntimeBudget;
    isolation?: RuntimeIsolationSpec;
  };
}
