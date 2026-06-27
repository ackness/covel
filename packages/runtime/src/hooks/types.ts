/**
 * Hook lifecycle pipeline types.
 *
 * Defines handler contracts and registration structures for the HookPipeline
 * across the 16 hook events. All types are framework-level — no plugin IDs here.
 *
 * The event names themselves are NOT defined here: `HookEvent` is re-derived
 * from the single source of truth `HOOK_EVENTS` in `@covel/shared`, so the
 * runtime and the plugin-facing `HookEventName` can never drift apart.
 */

import type { EventBus } from "@covel/events";
import type { HookEnforce, HookEventName } from "@covel/shared";

// ── Hook event names ─────────────────────────────────────────────

/**
 * The 16 framework hook events. Alias of `@covel/shared`'s `HookEventName`,
 * which is itself `typeof HOOK_EVENTS[number]` — keep this name local because
 * the runtime/pipeline code references `HookEvent` throughout.
 */
export type HookEvent = HookEventName;

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

// `HookEnforce` and `HookDeclaration` are owned by @covel/shared (single
// source of truth) and re-exported here so the runtime hooks barrel keeps a
// stable surface for existing importers.
export type { HookEnforce, HookDeclaration } from "@covel/shared";

// ── Hook context (read-only metadata about the current hook site) ──

export interface HookContext {
  readonly event: HookEvent;
  readonly sessionId: string;
  readonly turnId: string;
  /** Owning plugin if plugin-scoped hook. */
  readonly pluginId?: string;
  /** Populated for PreRuntime / PostRuntime. */
  readonly runtimeId?: string;
  /**
   * Plugin ids active in this session. Populated by the pipeline from the
   * session hook scope (AsyncLocalStorage). Lets a handler reason about the
   * active set; the pipeline already filters out hooks of inactive plugins.
   */
  readonly activePluginIds?: ReadonlySet<string>;
  /**
   * Read-only accessor for the handler's *own* plugin settings this turn.
   *
   * The pipeline injects this (from the same session hook scope that carries
   * `activePluginIds`) just before invoking each handler, bound to that
   * handler's `pluginId`. It returns a frozen snapshot of the plugin's
   * resolved `userSettings` (manifest defaults merged with the player's saved
   * values) — unlocking per-session-configurable hooks with no write path.
   *
   * Semantics:
   * - Frozen / read-only — never a mutable reference to shared state.
   * - Scoped to the handler's own plugin only — no cross-plugin reads.
   * - Returns `{}` for framework / global hooks (no `pluginId`), or when the
   *   plugin declared no settings, or when the scope carries no settings.
   * - Absent (`undefined`) when invoked outside an active hook scope (e.g.
   *   direct `pipeline.run` unit calls) — handlers should use
   *   `ctx.getOwnSettings?.() ?? {}`.
   */
  readonly getOwnSettings?: () => Readonly<Record<string, unknown>>;
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

// `HookDeclaration` (the PLUGIN.md frontmatter shape) is re-exported from
// @covel/shared at the top of this file — see the `export type` there.
