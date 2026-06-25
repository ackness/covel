/**
 * Hook lifecycle pipeline types.
 *
 * Defines the 8 hook events, handler contracts, and registration structures
 * for the HookPipeline. All types are framework-level — no plugin IDs here.
 */

import type { EventBus } from "@covel/events";

// ── Hook event names ─────────────────────────────────────────────

export type HookEvent =
  | "SessionStart"
  | "TurnStart"
  | "PreCompaction"
  | "PostCompaction"
  | "PreSchedule"
  | "PreRuntime"
  | "PostContextAssembly"
  | "PreLLMCall"
  | "PostLLMResponse"
  | "PostRuntime"
  | "PreToolUse"
  | "PostToolUse"
  | "PreStateCommit"
  | "PostStateCommit"
  | "TurnStop"
  | "SessionEnd";

export type HookSemantic = "first" | "sequential" | "parallel" | "stream";

export const HOOK_SEMANTICS: Record<HookEvent, HookSemantic> = {
  // Session lifecycle (no turn): observe session creation. Parallel; the
  // session is already persisted, so handlers cannot veto creation.
  SessionStart: "parallel",
  // Sequential so `abort` can veto the whole turn before any runtime runs
  // (access control / rate limit). Parallel discarded abort, leaving the
  // turn-executor's abort branch dead.
  TurnStart: "sequential",
  // Veto gate before history compaction: `abort` skips compaction this turn.
  PreCompaction: "sequential",
  // Observe the compaction outcome (compacted? summaryId?).
  PostCompaction: "parallel",
  // Observe / filter the set of runtimes that will run this turn, after
  // trigger selection and before scheduling. Chained via `replace.triggered`.
  PreSchedule: "sequential",
  PreRuntime: "sequential",
  // Turn-level (once per runtime): rewrite the assembled system prompt /
  // projected history after buildContext, before the loop. Chained.
  PostContextAssembly: "sequential",
  // Non-destructively rewrite the request sent to the LLM on each call;
  // chained so each handler sees the previous handler's edits.
  PreLLMCall: "sequential",
  // Inspect / patch the LLM response before tool dispatch; chained.
  PostLLMResponse: "sequential",
  // Sequential so `replace.result` can rewrite the RuntimeResult. Parallel
  // discarded replace, leaving runPostRuntimeHook's rewrite path dead.
  PostRuntime: "sequential",
  PreToolUse: "sequential",
  // Sequential so handlers can patch-accumulate the tool result and signal
  // `terminate` to end the loop. (Parallel discards `replace`, which made the
  // prior result-patch path a no-op.)
  PostToolUse: "sequential",
  PreStateCommit: "sequential",
  PostStateCommit: "parallel",
  TurnStop: "parallel",
  // Session lifecycle (no turn): observe session end. Parallel; cleanup only.
  SessionEnd: "parallel",
};

export type HookEnforce = "pre" | "normal" | "post";

// ── Hook context (read-only metadata about the current hook site) ──

export interface HookContext {
  readonly event: HookEvent;
  readonly sessionId: string;
  readonly turnId: string;
  /** Owning plugin if plugin-scoped hook. */
  readonly pluginId?: string;
  /** Populated for PreRuntime / PostRuntime. */
  readonly runtimeId?: string;
}

// ── Hook result ──────────────────────────────────────────────────

/**
 * Result returned by a hook handler.
 *
 * - `continue` — pipeline proceeds.
 * - `continue` + `replace` — sequential hooks shallow-merge into the next payload.
 * - `abort` — sequential hooks stop the pipeline; parallel hooks record the abort.
 */
export type HookResult<P> =
  | { readonly action: "continue" }
  | { readonly action: "continue"; readonly replace: Partial<P> }
  | { readonly action: "abort"; readonly reason: string };

// ── Hook handler ─────────────────────────────────────────────────

export type HookHandler<P = unknown> = (
  ctx: HookContext,
  payload: P,
) => Promise<HookResult<P>>;

// ── Hook registration ────────────────────────────────────────────

export interface HookRegistration<P = unknown> {
  /** Unique ID, e.g. `${pluginId}:${event}:${index}` or `global:${event}:${index}`. */
  readonly id: string;
  readonly event: HookEvent;
  /** undefined = global/framework hook. */
  readonly pluginId?: string;
  /** Optional filter — only invoke this handler when match returns true. */
  readonly match?: (payload: P) => boolean;
  readonly handler: HookHandler<P>;
  /** Per-handler timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
  /** Ordering group. Default normal. */
  readonly enforce?: HookEnforce;
}

// ── Hook pipeline interface ──────────────────────────────────────

export interface HookPipelineRun<P> {
  /**
   * Run all registered handlers for the given event using HOOK_SEMANTICS.
   * Sequential hooks return accumulated `replace`; parallel hooks return continue.
   */
  run<Q extends P>(
    event: HookEvent,
    ctx: HookContext,
    payload: Q,
    opts?: { readonly eventBus?: EventBus; readonly emitter?: unknown },
  ): Promise<HookResult<Q>>;
}

// ── Hook declaration (for PLUGIN.md frontmatter) ─────────────────

/**
 * Hook declaration as it appears in a plugin's PLUGIN.md frontmatter.
 * Handler resolution is deferred (lazy import on first invocation).
 */
export interface HookDeclaration {
  readonly event: HookEvent;
  /** Relative path to the handler module inside the plugin package. */
  readonly handler: string;
  /** Optional simple equality filter: { tool: "create-character" } etc. */
  readonly match?: Readonly<Record<string, string | number>>;
  /** Per-handler timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
  /** Ordering group. Default normal. */
  readonly enforce?: HookEnforce;
}
