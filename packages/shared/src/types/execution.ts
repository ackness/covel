/**
 * Execution types for turns, runtime results, and tool calls.
 */

// ── Runtime execution status ─────────────────────────────────────

export type RuntimeStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  /** S4-T4: runtime suspended, waiting for player input via resume API. */
  | "suspended";

// ── Tool call record ─────────────────────────────────────────────

export type ApprovalStatus = "auto-allowed" | "user-allowed" | "user-denied";

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly turnId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: unknown;
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
   * PR-6: Per-runtime model slot overrides snapshotted from the session
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
  };
  /**
   * Player-authored plugin settings, keyed by pluginId. Each plugin's bucket
   * holds the values the user has saved under `plugin.<pluginId>.<key>` in
   * the unified SettingsStore; the server merges these with the per-runtime
   * `manifest.userSettings[].default` before invoking function handlers so
   * plugins can rely on every declared key being present (audit F7).
   *
   * Absent on programmatic / test callers that don't carry player context.
   */
  readonly userSettings?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
}

export interface TurnResult {
  readonly turnId: string;
  readonly sessionId: string;
  readonly runtimeResults: readonly RuntimeResult[];
  /**
   * Runtime results produced by nested `ctx.recursiveCall` executions,
   * flattened across depths (2026-07-20 audit H-08). They are NOT part of
   * `runtimeResults` (which persistTurnResult snapshots — nested turns
   * persist their own turn_results rows) but the commit-owning caller MUST
   * process them through the same proposal pipeline as the top-level
   * results; previously their proposals were silently dropped.
   */
  readonly nestedRuntimeResults?: readonly RuntimeResult[];
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
   * caller can schedule them as `_jobs` and return immediately (audit F1).
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
   * Turn-completion barrier (commit consistency, audit R-06/R-09). Present on
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
  readonly priority: number;
  readonly newValue: unknown;
  readonly reason?: string;
}

export interface WriteConflict {
  readonly table: string;
  readonly field: string;
  readonly originalValue: unknown;
  readonly writes: readonly WriteConflictEntry[];
}
