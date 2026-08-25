/**
 * `HandlerResult` — the plugin-facing return contract, plus the effect types
 * it carries.
 *
 * Every function handler returns this contract directly. Agent runtimes use
 * their own structured-output path and are materialized by the kernel. Four
 * discriminated outcomes on `outcome`.
 *
 * The persisted shape is `RuntimeResult` (`execution.ts`) — a parallel
 * "v2" persisted contract was drafted here and never wired, so it is gone.
 */

import type { JsonValue } from "./runtime-scheduling.js";
import type { JobStatusState } from "./runtime-lifecycle.js";

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
 * writes. The kernel materializes these keys onto its internal runtime output
 * before proposal normalization.
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
