import type {
  RuntimeBudget,
  RuntimeIsolationSpec,
  RuntimeTriggerEvent,
} from "./common.js";
import type { CharacterCard } from "./character.js";

export type SessionPhase = "init" | "character_creation" | "playing" | "ended";

/** Kernel input contract */
export interface KernelInput {
  runId: string;
  branchId: string;
  actorId: string;
  type: "user.input" | "system.event" | "session_start" | "manual_action" | "interval_tick" | (string & {});
  locale?: string;
  payload: Record<string, unknown>;
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
    phase: string;
    allowedTools: string[];
    providerBinding?: string;
    budget?: RuntimeBudget;
    isolation?: RuntimeIsolationSpec;
  };
}
