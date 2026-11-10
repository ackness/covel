/**
 * Hook lifecycle pipeline types.
 *
 * Defines handler contracts and registration structures for the HookPipeline
 * across the 18 hook events. All types are framework-level — no plugin IDs here.
 *
 * The event names themselves are NOT defined here: `HookEvent` is re-derived
 * from the single source of truth `HOOK_EVENTS` in `@covel/shared`, so the
 * runtime and the plugin-facing `HookEventName` can never drift apart.
 */

import type { HookEnforce, HookEventName } from "@covel/shared";

// ── Hook event names ─────────────────────────────────────────────

/**
 * The 18 framework hook events. Alias of `@covel/shared`'s `HookEventName`,
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
  // Per step, before the model call: narrow the step's tools, change its tool
  // choice, lower the remaining steps or end the loop. Not a guard: a failed
  // handler is skipped and `abort` means "no change".
  PreStep: "sequential",
  // Non-destructively rewrite the request sent to the LLM on each call;
  // chained so each handler sees the previous handler's edits.
  PreLLMCall: "sequential",
  // Inspect / patch the LLM response before tool dispatch; chained.
  PostLLMResponse: "sequential",
  ReviewAgentOutput: "sequential",
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

/**
 * What a failed guard handler stops: one that throws, times out or returns
 * an invalid result. A failure never lets through what the handler judged.
 *
 * - `closed`: the guarded operation does not happen. TurnStart aside, that
 *   is one unit: the compaction, the runtime (skipped with `hook-failed`),
 *   the tool call, the reviewed output, or the proposal (rejected with
 *   `hook-failed`). What a skipped runtime or a rejected proposal then
 *   costs follows the commit rules: next to a committed story, a unit that
 *   holds no story drops alone, and a story that hard-depends on a skipped
 *   runtime is refused.
 * - `own-runtimes`: TurnStart judges the whole execution, so a failure fails
 *   it, unless the caller confines it (`confinable` on the pipeline run):
 *   then the handler's plugin sits the execution out, its runtimes skipped
 *   with `hook-failed`, and the chain goes on. The turn executor confines
 *   only a plugin without a story runtime that has runtimes scheduled in an
 *   execution with a story; a plugin of hooks alone may exist only to gate
 *   input, so its failure fails the execution.
 *
 * A framework hook's failure always fails closed.
 */
export type GuardFailureScope = "own-runtimes" | "closed";

export const GUARD_FAILURE_SCOPE: Readonly<
  Partial<Record<HookEvent, GuardFailureScope>>
> = {
  TurnStart: "own-runtimes",
  PreCompaction: "closed",
  PreRuntime: "closed",
  PreToolUse: "closed",
  ReviewAgentOutput: "closed",
  PreStateCommit: "closed",
};

/**
 * Sequential events whose call site acts on `abort`: it vetoes the turn, the
 * compaction, the runtime, the tool call or the proposal. A handler of one of
 * these that throws, times out or returns a malformed result fails closed —
 * the pipeline answers `abort`, since a broken policy must not let the guarded
 * operation through — within the scope `GUARD_FAILURE_SCOPE` gives it. Every
 * other sequential event only transforms its payload and reads `abort` as
 * "no change", so a failed handler there is skipped and the replacements of
 * the handlers before it are kept.
 */
export const GUARD_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set(
  Object.keys(GUARD_FAILURE_SCOPE) as HookEvent[],
);

// ── Hook context (read-only metadata about the current hook site) ──

export interface HookContext {
  /** Pipeline-provided cancellation: parent execution abort or this hook's timeout. */
  readonly signal?: AbortSignal;
  readonly event: HookEvent;
  readonly sessionId: string;
  /** Empty for the session events, which fire outside any turn. */
  readonly turnId: string;
  /**
   * The session's content locale. The pipeline fills it from the session
   * hook scope; absent only when the scope carries no locale.
   */
  readonly locale?: string;
  /** Frozen logical number of the originating input, when run in an execution. */
  readonly logicalTurn?: number;
  /**
   * Plugin of the runtime the event is about — not the plugin that
   * registered the handler. Set, with `runtimeId`, for every event that
   * concerns one runtime: PreRuntime, PostContextAssembly, PreStep, PreLLMCall,
   * PostLLMResponse, ReviewAgentOutput, PreToolUse, PostToolUse, PostRuntime, and the two
   * commit events (the proposal's source). Absent for session and turn events.
   * This is the one place for the identity: payloads do not repeat it.
   */
  readonly pluginId?: string;
  /** Runtime the event is about; see `pluginId`. */
  readonly runtimeId?: string;
  /**
   * Plugin ids active in this session. Populated by the pipeline from the
   * session hook scope (AsyncLocalStorage). Lets a handler reason about the
   * active set; the pipeline already filters out hooks of inactive plugins.
   */
  readonly activePluginIds?: ReadonlySet<string>;
  /**
   * Read-only accessor for the handler's *own* plugin settings for this operation.
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
   * - Always set on the context a handler receives: the pipeline refuses to
   *   run outside a hook scope (`MissingHookScopeError`). It stays optional
   *   in the type because callers build the context without it, so
   *   `ctx.getOwnSettings?.() ?? {}` keeps working.
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
 * The pipeline validates this envelope at runtime. `replace` must be a data
 * record for shallow merging; malformed results follow handler-error semantics.
 */
export type HookResult<P> =
  | { readonly action: "continue" }
  | { readonly action: "continue"; readonly replace: Partial<P> }
  | {
      readonly action: "abort";
      readonly reason: string;
      readonly handlerFailed?: true;
    };

/** A failed TurnStart handler whose plugin sits the execution out. */
export interface ConfinedHookFailure {
  /** The plugin that registered the failed handler. */
  readonly pluginId: string;
  readonly reason: string;
}

/**
 * What `HookPipeline.run` answers: the chain's result, plus the failed
 * handlers it went on without because the caller confined them (see
 * `GUARD_FAILURE_SCOPE`). The caller sits each listed plugin out.
 */
export type HookRunResult<P> = HookResult<P> & {
  readonly confined?: readonly ConfinedHookFailure[];
};

// ── Hook handler ─────────────────────────────────────────────────

/** Receives a private data snapshot; publish changes only through `replace`. */
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
  /** Optional filter with its own snapshot; only invoke the handler when true. */
  readonly match?: (payload: P) => boolean;
  readonly handler: HookHandler<P>;
  /** Per-handler timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
  /** Ordering group. Default normal. */
  readonly enforce?: HookEnforce;
  /**
   * A hook players must not read ahead of (see `DRAFT_HOLDING_HOOK_EVENTS`):
   * story drafts wait for it. Taken from the manifest, never from code.
   */
  readonly holdsDrafts?: boolean;
  /**
   * Whether the handler takes part in a session at all, when that depends on
   * more than the session's plugins: a community hook waiting for the
   * player's approval answers `continue` without running. Defaults to yes.
   */
  readonly runsFor?: (sessionId: string) => boolean | Promise<boolean>;
}
