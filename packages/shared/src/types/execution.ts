/**
 * Execution types for turns, runtime results, and tool calls.
 */

import type { ExecutionContext, JsonValue } from "./runtime-scheduling.js";
import type {
  RanSetupRuntime,
  SetupRuntimeState,
} from "./runtime-lifecycle.js";

// ── Runtime execution status ─────────────────────────────────────

export type RuntimeStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  /** Runtime suspended, waiting for player input via resume API. */
  | "suspended";

// ── Tool call record ─────────────────────────────────────────────

export type ApprovalStatus = "auto-allowed" | "user-allowed" | "user-denied";

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly turnId: string;
  /**
   * JSON wire value only (docs 02 §2). Callers pass tool arguments / results
   * through the serialization boundary (`toJsonValueOrDiagnostic`) before
   * constructing the record, so a non-serialisable value collapses to a bounded
   * diagnostic string rather than an arbitrary object.
   */
  readonly input: JsonValue;
  readonly output: JsonValue;
  readonly durationMs: number;
  readonly approvalStatus: ApprovalStatus;
  readonly timestamp: string;
}

// ── Runtime result ───────────────────────────────────────────────

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
}

export interface RuntimeResult {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly status: RuntimeStatus;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly durationMs: number;
  readonly tokenUsage?: TokenUsage;
  readonly error?: string;
  readonly timestamp: string;
}

// ── Turn input / result ──────────────────────────────────────────

export interface TurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly playerMessage: string;
  readonly locale?: string;
  /** API-level model override. Takes highest priority over plugin config. */
  readonly modelOverride?: string;
  /**
   * Per-runtime model slot overrides snapshotted from the session
   * record. Maps runtime ID (`pluginId` or `pluginId/runtimeName`) → slot
   * name. Looked up by the resolver before falling back to `manifest.model`.
   */
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
  /**
   * Manual trigger descriptor. When set, the turn executor runs only the
   * targeted runtime (bypassing scheduling of auto/event runtimes), then
   * processes any events the runtime emitted as a chained mini-pipeline.
   * Used by `POST /api/sessions/:id/plugin-rpc` with a `runtimeId` body.
   *
   * `triggerEvent` is an optional event payload forwarded to the targeted
   * runtime via `FunctionHandlerContext.triggerEvent` — used by the
   * background follower path (audit P1) so a deferred follower runtime
   * receives the same `triggerEvent` shape it would have seen during the
   * synchronous event-chain fan-out. Independent of `payload`, which is
   * the manual click payload from the UI.
   */
  readonly manualTrigger?: {
    readonly runtimeId: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly triggerEvent?: {
      readonly topic: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
    /**
     * Retry seeding: the recorded runtime results of a PRIOR turn, loaded from
     * its persisted `turn_results` artifact. The executor pre-populates
     * `completedResults` with them (minus the target runtime) so the target's
     * `input.inject` / `needs` resolve against the original turn's outputs —
     * a plain manual trigger resolves them empty. Seeds are context, not
     * products: the executor drops any seed that was not re-executed before
     * finalizing, so the retry turn's artifact records only what actually ran.
     */
    readonly retrySeedResults?: readonly RuntimeResult[];
  };
  /**
   * Execution origin, stamped onto the persisted
   * `turn_results` row so turn accounting can distinguish a real player turn
   * from a manual RPC trigger, a deferred background follower, or a nested
   * recursiveCall. Defaults to `player` when omitted.
   */
  readonly origin?: "player" | "manual" | "follower" | "recursive";
  /**
   * Transition field: whether the session was still in the Pre-Game band when
   * the caller snapshotted it (before this execution ran). Only the player
   * actions route feeds it; other entries omit it (treated as `false`). Read
   * once at execution creation to fix `ExecutionContext.countPolicy`. Removed
   * once the persisted phase field lands and the kernel derives this itself.
   */
  readonly preGamePending?: boolean;
  /**
   * Identity of the player's logical turn, minted once at the player action
   * entry (actions route) and carried into `ExecutionContext.logicalTurnId`.
   * The finalizer keys the logical-turn completion ledger on it, so a retried
   * or duplicated execution of the same logical turn counts at most once. Only
   * the player path sets it; manual RPC / background follower / recursive
   * executions leave it unset (they never complete a player turn).
   */
  readonly logicalTurnId?: string;
  /** Parent turnId when this execution is a nested recursiveCall. */
  readonly parentTurnId?: string;
  /**
   * Player-authored plugin settings, keyed by pluginId. Each plugin's bucket
   * holds the values the user has saved under `plugin.<pluginId>.<key>` in
   * the unified SettingsStore; the server merges these with the per-runtime
   * `manifest.userSettings[].default` before invoking function handlers so
   * plugins can rely on every declared key being present.
   *
   * Absent on programmatic / test callers that don't carry player context.
   */
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
}

/**
 * Business-input subset a plugin may override on `ctx.recursiveCall()`.
 * Execution identity (`sessionId`, `turnId`, `origin`, `parentTurnId`) is
 * framework-generated and immutable: a nested call must stay inside the parent
 * session — otherwise an approved handler could read another session's context
 * and persist under it, bypassing the hosted session-owner boundary — and
 * reuses the parent `turnId` so its execution artifact settles together with
 * the parent turn.
 */
export type RecursiveCallDelta = Omit<
  Partial<TurnInput>,
  "sessionId" | "turnId" | "origin" | "parentTurnId"
>;

/**
 * Nested-turn view handed back to plugin code. Strips `completeTurn`: the
 * completion barrier belongs to the top-level framework control plane, and a
 * nested caller invoking it would emit an authoritative `turn.completed`
 * before the parent's proposals commit.
 */
export type NestedTurnResult = Omit<TurnResult, "completeTurn">;

export interface TurnResult {
  readonly turnId: string;
  readonly sessionId: string;
  readonly runtimeResults: readonly RuntimeResult[];
  /**
   * Immutable identity of the scheduling run that produced this result,
   * created once at `executeTurn` entry. Carries the normalized
   * `ExecutionOrigin` and counting responsibility for the commit-owning caller
   * and later scheduling waves. Optional: entries not yet threaded through it
   * (e.g. approval-resume) omit it during the redesign.
   */
  readonly executionContext?: ExecutionContext;
  /**
   * Runtime results produced by nested `ctx.recursiveCall` executions,
   * flattened across depths. They are NOT part of
   * `runtimeResults` (which persistTurnResult snapshots — nested turns
   * persist their own turn_results rows) but the commit-owning caller MUST
   * process them through the same proposal pipeline as the top-level
   * results; previously their proposals were silently dropped.
   */
  readonly nestedRuntimeResults?: readonly RuntimeResult[];
  /**
   * Setup-band completion delta observed during this execution: the setup
   * runtimes that reported done for the first time (with their mirrored
   * `SetupRuntimeState`) and whether that leaves every active setup runtime
   * resolved. The commit-owning caller folds this into the session-clock write
   * inside the finalize transaction (phase flip + `setupRuntimes` mirror),
   * atomically with the turn's proposals. Absent on manual / non-player
   * executions, which skip setup-completion tracking.
   */
  readonly setupCompletion?: {
    readonly newlyDone: Readonly<Record<string, SetupRuntimeState>>;
    readonly allSetupDone: boolean;
  };
  /**
   * Setup runtimes that ran (entered guard/handler) in this execution. The
   * commit-owning caller passes them to `finalizeExecution`, which — AFTER the
   * commit outcome is known and OUTSIDE the transaction — terminalises each
   * attempt ledger entry and writes the pending/blocked mirror (a rolled-back
   * commit still burns an attempt). Absent when no setup runtime ran.
   */
  readonly setupRan?: readonly RanSetupRuntime[];
  readonly conflicts?: readonly WriteConflict[];
  readonly auditResult?: RuntimeResult;
  /** Forms requiring player input before next turn (collected from runtime outputs). */
  readonly pendingInputs?: readonly PendingInputInfo[];
  readonly durationMs: number;
  readonly timestamp: string;
  /**
   * Set when a TurnStart hook aborted the turn before any runtime ran.
   * Callers should surface this reason to the player / client.
   */
  readonly abortReason?: string;
  /**
   * Event-chain followers with `manifest.execution === 'background'` that
   * were matched in this turn but intentionally NOT executed, so the sync
   * caller can schedule them as `_jobs` and return immediately.
   *
   * Each entry carries the triggering event so the caller can re-enter the
   * runtime without reconstructing it. Empty / absent when no background
   * follower was in scope.
   */
  readonly deferredFollowers?: readonly {
    readonly runtimeId: string;
    readonly pluginId: string;
    readonly triggerEvent: {
      readonly topic: string;
      readonly data: Readonly<Record<string, unknown>>;
    };
  }[];
  /**
   * Turn-completion barrier (commit consistency, audit). Present on
   * results returned by `executeTurn`. The caller that owns the commit
   * boundary invokes it AFTER this turn's proposals have committed (and the
   * auto-snapshot is captured); it then emits the authoritative
   * `turn.completed` event and kicks off post-turn memory ingestion.
   * Idempotent — safe to call at most once per path. Never invoked when the
   * commit fails or the process crashes: no ghost completion event, no memory
   * derived from uncommitted state.
   */
  readonly completeTurn?: () => void;
}

// ── Interaction protocol ────────────────────────────────────────

/**
 * Interaction types for the return-value protocol.
 * Tools declare interactivity by returning { interaction: InteractionPayload }.
 */

export type InteractionType = "form" | "choice" | "confirmation";

export interface InteractionSubmitBehavior {
  /** Whether the filled narrative should appear as a visible player bubble. */
  readonly echoFilledNarrative?: boolean;
}

interface BaseInteraction {
  readonly interactionId: string;
  readonly type: InteractionType;
  /** Narrative template with placeholders — filled after player responds. */
  readonly narrativeTemplate?: string;
  /** Optional generic client-side submit behavior. */
  readonly submitBehavior?: InteractionSubmitBehavior;
}

export interface FormInteraction extends BaseInteraction {
  readonly type: "form";
  readonly title: string;
  readonly fields: readonly Record<string, unknown>[];
  readonly submitLabel: string;
}

export interface ChoiceInteraction extends BaseInteraction {
  readonly type: "choice";
  readonly prompt: string;
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
}

export interface ConfirmationInteraction extends BaseInteraction {
  readonly type: "confirmation";
  readonly prompt: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export type InteractionPayload =
  FormInteraction | ChoiceInteraction | ConfirmationInteraction;

// ── Pending input info ──────────────────────────────────────────

export interface PendingInputInfo {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly interaction: InteractionPayload;
  readonly form?: Readonly<Record<string, unknown>>;
  readonly narrativeTemplate?: string;
}

// ── Write conflict (imported from state) ─────────────────────────

export interface WriteConflictEntry {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly newValue: unknown;
  readonly reason?: string;
}

export interface WriteConflict {
  readonly table: string;
  readonly field: string;
  readonly originalValue: unknown;
  readonly writes: readonly WriteConflictEntry[];
}
