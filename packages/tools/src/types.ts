/**
 * Tool system types.
 */

import type { z, ZodType } from "zod";
import type { Proposal } from "@covel/shared";
import type { ToolExecutionEnvelope } from "./result.js";

// ── Tool execution context ───────────────────────────────────────

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  /**
   * Proposal writes buffered earlier in the same tool loop.
   * Tools can consult this view to read same-turn plugin-data updates
   * before the session kernel commits them at runtime end.
   */
  readonly pendingProposals?: readonly Proposal[];
  /**
   * Authoritative logical turn number (count of player messages so far).
   *
   * Tools that record "when" something happened need this: without it a
   * plugin has only `turnId` (a UUID) and resorts to proxies like "how many
   * rows exist", which does not advance with the story and makes anything
   * derived from it — relationship decay, recency ranking — meaningless.
   * Absent for callers outside a turn (bare tool harnesses).
   */
  readonly turnNumber?: number;
  /**
   * Topics already emitted via `emit-event` earlier in the same tool loop
   * (accumulated by the agent tool loop, see turn-agent-tool-loop.ts).
   * Lets `emit-event` no-op a same-turn duplicate instead of producing a
   * second `event.emit` proposal/SSE for a topic that already fired.
   */
  readonly emittedEventTopics?: readonly string[];
}

// ── Tool module (result of tool() call) ──────────────────────────

export interface ToolModule<
  TParams extends ZodType = ZodType,
  TOutput = unknown,
> {
  readonly _type: "covel-tool";
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: TParams;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  execute(
    params: z.infer<TParams>,
    context: ToolExecutionContext,
  ): Promise<TOutput | ToolExecutionEnvelope<TOutput>>;
}

// ── Tool definition input (passed to tool()) ─────────────────────

export interface ToolDefinitionInput<
  TParams extends ZodType = ZodType,
  TOutput = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParams;
  execute(
    params: z.infer<TParams>,
    context: ToolExecutionContext,
  ): Promise<TOutput | ToolExecutionEnvelope<TOutput>>;
}

// ── Tool provenance ──────────────────────────────────────────────

export type ToolSource = "builtin" | "local";

// ── Output validation ────────────────────────────────────────────

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[];
}
