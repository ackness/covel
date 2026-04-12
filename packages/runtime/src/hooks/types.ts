/**
 * Hook lifecycle pipeline types.
 *
 * Defines the 8 hook events, handler contracts, and registration structures
 * for the HookPipeline. All types are framework-level — no plugin IDs here.
 */

import type { EventBus } from '@covel/events';

// ── Hook event names ─────────────────────────────────────────────

export type HookEvent =
  | 'TurnStart'
  | 'PreRuntime'
  | 'PostRuntime'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreStateCommit'
  | 'PostStateCommit'
  | 'TurnStop';

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
 * - `continue` — pipeline proceeds; optional `replace` is shallow-merged into the payload.
 * - `abort` — pipeline stops; for Pre* hooks the operation is prevented.
 *   For Post* hooks the abort is logged only (operation already happened).
 */
export type HookResult<P> =
  | { readonly action: 'continue' }
  | { readonly action: 'continue'; readonly replace: Partial<P> }
  | { readonly action: 'abort'; readonly reason: string };

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
}

// ── Hook pipeline interface ──────────────────────────────────────

export interface HookPipelineRun<P> {
  /**
   * Run all registered handlers for the given event in order.
   * Returns the final HookResult (with accumulated `replace` payload).
   */
  run<Q extends P>(
    event: HookEvent,
    ctx: HookContext,
    payload: Q,
    opts?: { readonly eventBus?: EventBus },
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
}
