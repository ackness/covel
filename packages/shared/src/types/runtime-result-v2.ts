/**
 * Result-layering contract types for the runtime-scheduling redesign (docs
 * 02 §4).
 *
 * Two layers:
 *  - `HandlerResult` — the PLUGIN return face. A function handler returns it
 *    directly (envelope-v1) or via the legacy adapter; an agent's finalizer
 *    normalizes into it. Four discriminated outcomes on `outcome`.
 *  - `RuntimeResultV2` — the PERSISTED result. `RuntimeResultBase` (identity +
 *    telemetry) intersected with `RuntimeOutcome` (four discriminated statuses).
 *
 * These are declared alongside — not replacing — the in-flight `RuntimeResult`
 * (`execution.ts`). The executors still produce `RuntimeResult`; the switch to
 * `RuntimeResultV2` and the store/serializer projection land in a later step
 * (docs 02 §4, "Step 6"). Naming stays `*V2` until then to avoid a collision.
 */

import type { JsonValue } from "./runtime-scheduling.js";
import type { JobStatusState } from "./runtime-lifecycle.js";
import type { ToolCallRecord } from "./execution.js";

/** A JSON Schema object (resume-form schema). Not structurally validated here. */
export type JsonSchema = Readonly<Record<string, unknown>>;

// ── Observability effects ────────────────────────────────────────

/**
 * The job business fields a handler reports through the observability channel.
 * A field subset of `JobStatusRecord` (docs 02 §4.1): the kernel injects the
 * identity (session / scope / plugin / runtime) and timestamp, so a handler
 * cannot forge another plugin's or runtime's job. Structurally identical to the
 * plugin-loader `ProgressEffect` (the live `ctx.progress.report` argument).
 */
export interface JobStatusEffect {
  readonly jobId: string;
  readonly state: JobStatusState;
  readonly progress?: number;
  readonly message?: string;
  readonly data?: JsonValue;
  readonly sequence: number;
}

/** One structured diagnostic surfaced by normalization / finalization. */
export interface RuntimeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly data?: JsonValue;
}

/**
 * Effects a non-success outcome may carry. `skipped` / `failed` accept ONLY
 * these observation channels — any domain write in a non-success envelope is
 * stripped by the finalizer (docs 02 §4.1).
 */
export interface ObservabilityEffects {
  readonly jobStatus?: readonly JobStatusEffect[];
  readonly diagnostics?: readonly RuntimeDiagnostic[];
}

/**
 * Effects a `success` outcome may carry: the observation channels plus domain
 * writes. During the legacy compat period the domain keys mirror the known
 * control keys the runtime output normalizer already understands (docs 02
 * §4.3); the legacy adapter copies present keys here for observability, while
 * the actual commit still re-derives proposals from the preserved `value`.
 */
export interface RuntimeEffects extends ObservabilityEffects {
  readonly statePatches?: readonly JsonValue[];
  readonly events?: readonly JsonValue[];
  readonly interactions?: readonly JsonValue[];
  readonly ui?: readonly JsonValue[];
  readonly assetGenerations?: readonly JsonValue[];
  readonly pluginData?: readonly JsonValue[];
  readonly notifications?: readonly JsonValue[];
}

// ── Handler result (plugin return face) ──────────────────────────

/** Plugin return face: function returns directly; agent finalizer normalizes. */
export type HandlerResult =
  | {
      readonly outcome: "success";
      readonly value?: JsonValue;
      readonly effects?: RuntimeEffects;
      readonly completion?: "done" | "pending";
    }
  | {
      readonly outcome: "suspended";
      readonly reason: string;
      readonly resumeSchema?: JsonSchema;
    }
  | {
      readonly outcome: "skipped";
      readonly skipReason: string;
      readonly effects?: ObservabilityEffects;
    }
  | {
      readonly outcome: "failed";
      readonly error: string;
      readonly effects?: ObservabilityEffects;
    };

// ── Persisted runtime result ─────────────────────────────────────

export interface RuntimeResultBase {
  readonly resultId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly logicalTurnId?: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly durationMs: number;
  readonly tokenUsage?: { readonly input: number; readonly output: number };
  readonly timestamp: string;
}

/**
 * `pending` / `running` are in-memory execution states and never enter a
 * persisted outcome. `suspended` carries a `suspensionId` + `resumeMode` the
 * `HandlerResult` suspend branch does not (the finalizer assigns them).
 */
export type RuntimeOutcome =
  | {
      readonly status: "success";
      readonly value?: JsonValue;
      readonly effects?: RuntimeEffects;
      readonly completion?: "done" | "pending";
    }
  | {
      readonly status: "suspended";
      readonly suspensionId: string;
      readonly resumeMode: "continuation" | "approval-replay";
      readonly reason: string;
      readonly resumeSchema?: JsonSchema;
    }
  | {
      readonly status: "skipped";
      readonly skipReason: string;
      readonly effects?: ObservabilityEffects;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly effects?: ObservabilityEffects;
    };

export type RuntimeResultV2 = Readonly<RuntimeResultBase & RuntimeOutcome>;
