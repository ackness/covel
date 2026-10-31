import type { PluginToolErrorCode as ToolErrorCode } from "@covel/plugin-handlers-utils";
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
  /** Private routing identity for a character actor. */
  readonly characterId?: string;
  readonly instruction?: string;
  /** Structured context appended to the brief as JSON (at most 32 KB). */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Narrows the provider's own limits; it never raises them. */
  readonly budget?: {
    readonly maxSteps?: number;
    readonly timeoutMs?: number;
  };
}

/**
 * Why a sub-agent produced no output. `unavailable` covers a depth or pool cap
 * and a provider paused in this session; the call is refused at once.
 */
export type SubagentErrorCode = Exclude<ToolErrorCode, "refused" | "conflict">;

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
