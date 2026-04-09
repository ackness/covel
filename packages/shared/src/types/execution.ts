/**
 * Execution types for turns, runtime results, and tool calls.
 */

// ── Runtime execution status ─────────────────────────────────────

export type RuntimeStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped';

// ── Tool call record ─────────────────────────────────────────────

export type ApprovalStatus =
  | 'auto-allowed'
  | 'user-allowed'
  | 'user-denied';

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
}

export interface TurnResult {
  readonly turnId: string;
  readonly sessionId: string;
  readonly runtimeResults: readonly RuntimeResult[];
  readonly conflicts?: readonly WriteConflict[];
  readonly auditResult?: RuntimeResult;
  /** Forms requiring player input before next turn (collected from runtime outputs). */
  readonly pendingInputs?: readonly PendingInputInfo[];
  readonly durationMs: number;
  readonly timestamp: string;
}

// ── Interaction protocol ────────────────────────────────────────

/**
 * Interaction types for the return-value protocol.
 * Tools declare interactivity by returning { interaction: InteractionPayload }.
 */

export type InteractionType = 'form' | 'choice' | 'confirmation';

interface BaseInteraction {
  readonly interactionId: string;
  readonly type: InteractionType;
  /** Narrative template with placeholders — filled after player responds. */
  readonly narrativeTemplate?: string;
}

export interface FormInteraction extends BaseInteraction {
  readonly type: 'form';
  readonly title: string;
  readonly fields: readonly Record<string, unknown>[];
  readonly submitLabel: string;
}

export interface ChoiceInteraction extends BaseInteraction {
  readonly type: 'choice';
  readonly prompt: string;
  readonly choices: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
}

export interface ConfirmationInteraction extends BaseInteraction {
  readonly type: 'confirmation';
  readonly prompt: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export type InteractionPayload = FormInteraction | ChoiceInteraction | ConfirmationInteraction;

// ── Pending input info ──────────────────────────────────────────

export interface PendingInputInfo {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly interaction: InteractionPayload;
  /** @deprecated Use interaction fields instead. Kept for backward compatibility. */
  readonly form?: Readonly<Record<string, unknown>>;
  /** @deprecated Use interaction.narrativeTemplate instead. */
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
