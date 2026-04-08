import type { LoadedRuntime, RuntimeTrigger } from "@covel/plugin-manager";
import type { PublishedRecord, RecordStatus } from "@covel/services";
import type { ApprovalService } from "@covel/services";

// ── V1 Trigger Input ────────────────────────────────────────────────

export interface V1TriggerInput {
  type: "pre-game" | "turn" | "event" | "manual" | "approval-callback";
  sessionId: string;
  turnId: string;
  payload?: unknown;
  /** For event triggers: the domain event type. */
  eventType?: string;
  /** For manual triggers: the action ID. */
  actionId?: string;
  /** For approval-callback: the interactionId. */
  interactionId?: string;
}

// ── V1 Candidate ────────────────────────────────────────────────────

export interface V1Candidate {
  runtime: LoadedRuntime;
  triggerInput: V1TriggerInput;
}

// ── V1 Execution Plan ───────────────────────────────────────────────

export interface V1ExecutionPlan {
  /** Groups ordered by priority ascending (lower number first). */
  groups: V1PriorityGroup[];
}

export interface V1PriorityGroup {
  priority: number;
  runtimes: V1Candidate[];
}

// ── V1 Runtime Result ───────────────────────────────────────────────

export interface V1RuntimeResult {
  pluginId: string;
  runtimeId: string;
  status: RecordStatus;
  payload: unknown;
  failureReason?: string;
  record: PublishedRecord;
}

// ── V1 Turn Result ──────────────────────────────────────────────────

export interface V1TurnResult {
  turnId: string;
  traceId: string;
  records: PublishedRecord[];
  /** Domain events emitted during this turn (queued for next turn). */
  pendingEvents: string[];
}

// ── V1 Workflow ─────────────────────────────────────────────────────

export type WorkflowStatus = "queued" | "running" | "completed" | "failed";

export interface V1WorkflowState {
  workflowRunId: string;
  pluginId: string;
  actionId: string;
  status: WorkflowStatus;
  currentStep: string | null;
  failedAtStep?: string;
  steps: Array<{
    runtimeId: string;
    status: WorkflowStatus;
  }>;
  progressLabel?: string;
}

export interface V1RuntimeSummary {
  pluginId: string;
  runtimeId: string;
  priority: number;
  trigger: RuntimeTrigger;
  settings?: unknown[];
  systemTools?: string[];
  toolImports?: string[];
}

export interface V1ApprovalCallbackResult {
  interactionId: string;
  decision: "approved" | "denied";
  response?: unknown;
  status: "processed";
}

// ── V1 Session State ────────────────────────────────────────────────

export interface V1SessionState {
  sessionId: string;
  turnNumber: number;
  isPreGame: boolean;
  /** Set of runtime IDs that already ran in pre-game. */
  preGameCompleted: Set<string>;
  /** Per-runtime run counters for limits. Key: "pluginId:runtimeId". */
  runCounts: Map<string, { session: number; turn: number }>;
  /** Domain events queued during this turn, to be consumed in next turn. */
  eventQueue: string[];
  /** Published records from all turns. */
  records: PublishedRecord[];
}

// ── V1 KernelSession ────────────────────────────────────────────────

export interface V1KernelSession {
  executeTurn(input: V1TriggerInput): Promise<V1TurnResult>;
  executeRuntime(pluginId: string, runtimeId: string, payload?: unknown): Promise<V1RuntimeResult>;
  executeAction(pluginId: string, actionId: string, payload?: unknown): Promise<V1WorkflowState>;
  getWorkflow(workflowRunId: string): V1WorkflowState | undefined;
  listRuntimes(): V1RuntimeSummary[];
  getLastRecord(pluginId: string, runtimeId: string): PublishedRecord | undefined;
  handleApprovalCallback(
    interactionId: string,
    decision: "approved" | "denied",
    response?: unknown,
  ): Promise<V1ApprovalCallbackResult>;
  readonly state: V1SessionState;
}

export interface ApprovalIntegration {
  approvalService?: ApprovalService;
}
