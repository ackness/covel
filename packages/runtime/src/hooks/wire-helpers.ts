/**
 * Helpers that wire the HookPipeline into turn-executor.ts call sites.
 *
 * Plugin hook handlers are registered at bootstrap — see
 * `registerPluginHooks()` in `./register-plugin-hooks.ts`. The pipeline
 * itself is the on/off gate: when callers pass `pipeline: undefined`
 * (e.g. CLI tools that don't want hooks), all helpers short-circuit
 * to a no-op continue so the non-hook path stays byte-for-byte identical.
 *
 * Keeping these helpers here lets us extract pipeline-plumbing boilerplate
 * and HookContext construction out of turn-executor.ts to keep it
 * under the 1000-line budget.
 */

import type { EventBus } from '@covel/events';
import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';
import type { HookPipeline } from './pipeline.js';
import type { HookResult } from './types.js';

// ── Shared options ───────────────────────────────────────────────

interface BaseOpts {
  readonly pipeline: HookPipeline | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventBus?: EventBus;
}

// ── TurnStart ────────────────────────────────────────────────────

export interface TurnStartPayload {
  readonly playerMessage: string;
  readonly activeRuntimes: readonly string[];
}

export async function runTurnStartHook(
  opts: BaseOpts,
  payload: TurnStartPayload,
): Promise<HookResult<TurnStartPayload>> {
  if (!opts.pipeline) {
    return { action: 'continue' };
  }
  return opts.pipeline.run(
    'TurnStart',
    { event: 'TurnStart', sessionId: opts.sessionId, turnId: opts.turnId },
    payload,
    { eventBus: opts.eventBus },
  );
}

// ── TurnStop ─────────────────────────────────────────────────────

export async function runTurnStopHook(
  opts: BaseOpts,
  payload: { readonly runtimeResults: readonly RuntimeResult[]; readonly durationMs: number },
): Promise<void> {
  if (!opts.pipeline) return;
  await opts.pipeline.run(
    'TurnStop',
    { event: 'TurnStop', sessionId: opts.sessionId, turnId: opts.turnId },
    payload,
    { eventBus: opts.eventBus },
  );
}

// ── PreRuntime ───────────────────────────────────────────────────

export async function runPreRuntimeHook(
  opts: BaseOpts & { readonly manifest: RuntimeManifest; readonly input: TurnInput },
): Promise<HookResult<{ manifest: RuntimeManifest; input: TurnInput }>> {
  if (!opts.pipeline) {
    return { action: 'continue' };
  }
  return opts.pipeline.run(
    'PreRuntime',
    { event: 'PreRuntime', sessionId: opts.sessionId, turnId: opts.turnId, pluginId: opts.manifest.pluginId, runtimeId: opts.manifest.name },
    { manifest: opts.manifest, input: opts.input },
    { eventBus: opts.eventBus },
  );
}

// ── PostRuntime ──────────────────────────────────────────────────

export async function runPostRuntimeHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  result: RuntimeResult,
): Promise<RuntimeResult> {
  if (!opts.pipeline) return result;
  const hookResult = await opts.pipeline.run(
    'PostRuntime',
    { event: 'PostRuntime', sessionId: opts.sessionId, turnId: opts.turnId, pluginId: opts.pluginId, runtimeId: opts.runtimeId },
    { result },
    { eventBus: opts.eventBus },
  );
  if (hookResult.action === 'continue' && 'replace' in hookResult && hookResult.replace?.result) {
    return hookResult.replace.result as RuntimeResult;
  }
  return result;
}

// ── PreToolUse ───────────────────────────────────────────────────

export interface PreToolUsePayload {
  readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: string };
  readonly pluginId: string;
  readonly runtimeId: string;
}

export type PreToolUseOutcome =
  | { readonly skipped: false; readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: string } }
  | { readonly skipped: true; readonly reason: string };

export async function runPreToolUseHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  toolCall: { id: string; name: string; arguments: string },
): Promise<PreToolUseOutcome> {
  if (!opts.pipeline) return { skipped: false, toolCall };
  const payload: PreToolUsePayload = { toolCall, pluginId: opts.pluginId, runtimeId: opts.runtimeId };
  const hookResult = await opts.pipeline.run(
    'PreToolUse',
    { event: 'PreToolUse', sessionId: opts.sessionId, turnId: opts.turnId, pluginId: opts.pluginId, runtimeId: opts.runtimeId },
    payload,
    { eventBus: opts.eventBus },
  );
  if (hookResult.action === 'abort') return { skipped: true, reason: hookResult.reason };

  // Accumulate any toolCall replacement from the hook result
  let effectiveToolCall = toolCall;
  if (hookResult.action === 'continue' && 'replace' in hookResult && hookResult.replace?.toolCall) {
    effectiveToolCall = { ...effectiveToolCall, ...(hookResult.replace.toolCall as Partial<typeof toolCall>) };
  }
  return { skipped: false, toolCall: effectiveToolCall };
}

// ── PostToolUse ──────────────────────────────────────────────────

export interface PostToolUsePayload {
  readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: string };
  readonly result: unknown;
}

export async function runPostToolUseHook<R>(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  toolCall: { id: string; name: string; arguments: string },
  result: R,
): Promise<R> {
  if (!opts.pipeline) return result;
  const payload: PostToolUsePayload = { toolCall, result };
  const hookResult = await opts.pipeline.run(
    'PostToolUse',
    { event: 'PostToolUse', sessionId: opts.sessionId, turnId: opts.turnId, pluginId: opts.pluginId, runtimeId: opts.runtimeId },
    payload,
    { eventBus: opts.eventBus },
  );
  if (hookResult.action === 'continue' && 'replace' in hookResult && hookResult.replace?.result !== undefined) {
    return hookResult.replace.result as R;
  }
  return result;
}
