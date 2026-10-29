/**
 * Sub-agents: an agent runtime another runtime runs inside its own execution
 * (`ctx.agents.run` in a function runtime, the `delegate` tool in an agent).
 * A sub-agent has its own transcript and budget and returns output only: no
 * proposals, no events, no top-level runtime result. The public SDK mirrors
 * these types (`PluginSubagent*` in `@covel/plugin-handlers-utils`).
 */

import type { StopReason } from "./execution.js";

/** Which runtime to run: a provider of a contract, or one of the caller's own package. */
export type SubagentTarget =
  { readonly contract: string } | { readonly runtimeId: string };

export interface SubagentRequest {
  readonly target: SubagentTarget;
  /** The task, as the sub-agent's only user message (1–20 000 characters). */
  readonly brief: string;
  /** Structured context appended to the brief as JSON (at most 32 KB). */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Narrows the provider's own limits; it never raises them. */
  readonly budget?: {
    readonly maxSteps?: number;
    readonly timeoutMs?: number;
  };
}

/**
 * Why a sub-agent produced no output. `unavailable` is a depth or pool cap:
 * the call is refused at once, never queued.
 */
export type SubagentErrorCode =
  | "invalid-input"
  | "not-found"
  | "ambiguous"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "internal";

export type SubagentResult =
  | {
      readonly ok: true;
      readonly output: Readonly<Record<string, unknown>>;
      readonly stopReason: StopReason;
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: SubagentErrorCode;
        readonly message: string;
      };
      readonly stopReason?: StopReason;
    };

/** `ctx.agents`: run sub-agents from a function runtime. */
export interface SubagentRunApi {
  /** Never throws for a sub-agent failure; it resolves with `ok: false`. */
  run(request: SubagentRequest): Promise<SubagentResult>;
}
