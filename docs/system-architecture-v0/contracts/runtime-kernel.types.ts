import type {
  FailurePolicy,
  HookLifecyclePoint,
  KernelInputType,
  LocaleCode,
  ProposalKind,
  RuntimeBudget,
  RuntimeIsolationSpec,
  RuntimeKind,
  RuntimePhase,
  RuntimeTriggerEvent,
} from "./common.types";

export interface KernelInput {
  runId: string;
  branchId: string;
  actorId: string;
  type: KernelInputType;
  locale?: LocaleCode;
  /** For system events, eventType bridges to RuntimeTriggerEvent.type */
  eventType?: string;
  payload: Record<string, unknown>;
}

export interface RunDescriptor {
  runId: string;
  worldId?: string;
  status?: "active" | "paused" | "ended";
  phase?: "init" | "character_creation" | "playing" | "ended";
  defaultLocale?: LocaleCode;
  activeBranchId?: string;
}

export interface BranchDescriptor {
  branchId: string;
  runId: string;
  parentBranchId?: string;
  headSnapshotId?: string;
}

export interface SnapshotDescriptor {
  snapshotId: string;
  runId: string;
  branchId: string;
  turnId?: string;
  createdAt?: string;
}

export interface ArchiveSummary {
  version: number;
  title?: string;
  summary?: string;
  trigger?: string;
  turn?: number;
  active?: boolean;
}

export interface RuntimeContextView {
  run: RunDescriptor & {
    branchId: string;
    turnId: string;
  };
  locale: LocaleCode;
  world?: Record<string, unknown>;
  chat?: Record<string, unknown>;
  characters?: Array<Record<string, unknown>>;
  state?: Record<string, unknown>;
  record?: Array<Record<string, unknown>>;
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
    kind: RuntimeKind;
    phase: RuntimePhase;
    allowedTools: string[];
    providerBinding?: string;
    budget?: RuntimeBudget;
    isolation?: RuntimeIsolationSpec;
  };
}

// ── Typed proposal payloads ────────────────────────────────────────

export interface NarrativeAppendPayload {
  content: string;
  format?: "plain" | "markdown";
  [key: string]: unknown;
}

export interface StatePatchPayload {
  /** Scoped state namespace, e.g. "plugin.combat" */
  scope: string;
  /** JSON Merge Patch – keys present are set, explicit null deletes */
  patch: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EventEmitPayload {
  eventType: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RecordUpsertPayload {
  recordId?: string;
  recordType: string;
  fields: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UiRenderPayload {
  slot: string;
  component?: string;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AssetGeneratePayload {
  assetKind: string;
  prompt?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export type KernelProposalItem =
  | { kind: "narrative.append"; payload: NarrativeAppendPayload }
  | { kind: "state.patch"; payload: StatePatchPayload }
  | { kind: "event.emit"; payload: EventEmitPayload }
  | { kind: "record.upsert"; payload: RecordUpsertPayload }
  | { kind: "ui.render"; payload: UiRenderPayload }
  | { kind: "asset.generate"; payload: AssetGeneratePayload };

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

export interface ValidatedProposalEnvelope extends KernelProposalEnvelope {
  validatedAt: string;
}

export interface CommitResult {
  runId: string;
  branchId: string;
  turnId: string;
  snapshotId?: string;
  persistedStateKeys: string[];
  emittedEventIds: string[];
  updatedRecordIds: string[];
}

export interface RenderResult {
  messageBlocks: Array<Record<string, unknown>>;
  worldPanelUpdates: Array<Record<string, unknown>>;
  sideEffects: Array<Record<string, unknown>>;
}

export interface KernelTurnResult {
  runId: string;
  branchId: string;
  turnId: string;
  traceId: string;
  locale: LocaleCode;
  proposals: KernelProposalEnvelope[];
  commit?: CommitResult;
  render: RenderResult;
  followUpEvents: RuntimeTriggerEvent[];
}

export interface ScheduledRuntime {
  runtimeId: string;
  pluginId: string;
  kind: RuntimeKind;
  phase: RuntimePhase;
  topologyLayer?: number;
  triggerReason?: string;
  triggerMode?: "always" | "interval" | "manual" | "event";
  priority?: number;
  budget?: RuntimeBudget;
}

export interface SchedulerRequest {
  runId: string;
  branchId: string;
  turnId: string;
  event: RuntimeTriggerEvent;
}

export interface ContextAssemblyRequest {
  runId: string;
  branchId: string;
  turnId: string;
  runtimeId: string;
  pluginId: string;
}

export interface RuntimeRunRequest {
  runId: string;
  branchId: string;
  turnId: string;
  traceId: string;
  runtimeId: string;
  pluginId: string;
  context: RuntimeContextView;
}

export interface HookDispatchRequest {
  runId: string;
  branchId: string;
  turnId: string;
  traceId: string;
  runtimeId?: string;
  pluginId?: string;
  toolId?: string;
  event?: RuntimeTriggerEvent;
  proposal?: KernelProposalEnvelope;
}

export interface HookDecision {
  point: HookLifecyclePoint;
  hookId: string;
  effect: "allow" | "deny" | "patch" | "audit";
  patch?: Record<string, unknown>;
  reason?: string;
}

export interface CommitRequest {
  validatedProposal: ValidatedProposalEnvelope;
  actorId: string;
  baseSnapshotId?: string;
}

export interface RuntimeKernel {
  handleInput(input: KernelInput): Promise<KernelTurnResult>;
  handleEvent(event: RuntimeTriggerEvent): Promise<KernelTurnResult>;
}

export interface RuntimeScheduler {
  selectRuntimes(request: SchedulerRequest): Promise<ScheduledRuntime[]>;
}

export interface ContextAssembler {
  build(input: ContextAssemblyRequest): Promise<RuntimeContextView>;
}

export interface RuntimeRunner {
  run(input: RuntimeRunRequest): Promise<KernelProposalEnvelope>;
}

export interface HookEngine {
  execute(point: HookLifecyclePoint, input: HookDispatchRequest): Promise<HookDecision[]>;
}

export interface CommitService {
  commit(input: CommitRequest): Promise<CommitResult>;
}

export interface RuntimeFailureResult {
  runtimeId: string;
  pluginId: string;
  failurePolicy: FailurePolicy;
  reason: string;
}

export type KernelProposalSummary = {
  kind: ProposalKind;
  count: number;
};
