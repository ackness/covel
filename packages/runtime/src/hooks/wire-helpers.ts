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
 *
 * Boilerplate convergence (T10): every helper used to repeat the same
 * `if (!opts.pipeline) … pipeline.run(event, { event, sessionId, turnId, … },
 * payload, { eventBus, emitter })` block. That plumbing now lives once in
 * `runHook()` (+ `buildHookCtx`/`hookReplace`); each helper only keeps its
 * distinct *result interpretation*. The four observe-only events that share an
 * identical shape are produced by the generic `makeObserveHook` factory. The
 * HookPipeline engine itself (semantic dispatch, enforce ordering, per-handler
 * timeout, session-scope filtering) is untouched — see `./pipeline.ts`.
 */

import type { EventBus } from "@covel/events";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { HookPipeline } from "./pipeline.js";
import type { HookContext, HookEvent, HookResult } from "./types.js";
import type { TurnEmitter } from "../trace/turn-emitter.js";
import type {
  LLMMessage,
  LLMResponse,
  LLMToolDefinition,
} from "../llm/llm-adapter.js";

// ── Shared options ───────────────────────────────────────────────

interface BaseOpts {
  readonly pipeline: HookPipeline | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventBus?: EventBus;
  readonly emitter?: TurnEmitter;
}

/** Optional per-runtime identity threaded into the HookContext. */
interface HookCtxExtra {
  readonly pluginId?: string;
  readonly runtimeId?: string;
}

// ── Pipeline plumbing (single source of the run() boilerplate) ───

/** Build the per-call HookContext from the shared options + event identity. */
function buildHookCtx(
  opts: BaseOpts,
  event: HookEvent,
  extra?: HookCtxExtra,
): HookContext {
  return {
    event,
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    ...extra,
  };
}

/**
 * Run the pipeline for `event` with a freshly-built HookContext, or return
 * `undefined` when the caller opted out of hooks (`pipeline: undefined`).
 *
 * This is the one place that constructs the HookContext and forwards
 * eventBus/emitter, so the no-op gate and the `pipeline.run(...)` call stay
 * byte-identical across every event.
 */
async function runHook<P>(
  opts: BaseOpts,
  event: HookEvent,
  payload: P,
  extra?: HookCtxExtra,
): Promise<HookResult<P> | undefined> {
  if (!opts.pipeline) return undefined;
  return opts.pipeline.run(event, buildHookCtx(opts, event, extra), payload, {
    eventBus: opts.eventBus,
    emitter: opts.emitter,
  });
}

/**
 * Extract the accumulated `replace` patch from a sequential hook result, or
 * `undefined` when the pipeline was absent or no handler rewrote the payload.
 */
function hookReplace<P>(
  result: HookResult<P> | undefined,
): Partial<P> | undefined {
  if (result && result.action === "continue" && "replace" in result) {
    return result.replace;
  }
  return undefined;
}

/**
 * Factory for observe-only wire-helpers — the parallel, fire-and-forget events
 * whose (continue-only) result carries no payload rewrite. SessionStart /
 * SessionEnd / TurnStop / PostCompaction share this exact shape and differ only
 * in event name + payload type, so one generic factory replaces four
 * near-identical bodies with zero behaviour change.
 */
function makeObserveHook<P>(
  event: HookEvent,
): (opts: BaseOpts, payload: P) => Promise<void> {
  return async (opts, payload) => {
    await runHook(opts, event, payload);
  };
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
  return (await runHook(opts, "TurnStart", payload)) ?? { action: "continue" };
}

// ── TurnStop ─────────────────────────────────────────────────────

interface TurnStopPayload {
  readonly runtimeResults: readonly RuntimeResult[];
  readonly durationMs: number;
}

export const runTurnStopHook = makeObserveHook<TurnStopPayload>("TurnStop");

// ── SessionStart / SessionEnd ────────────────────────────────────
// Session-lifecycle hooks fire outside any turn, so callers pass an empty
// `turnId` in BaseOpts. Both are observe-only (parallel): SessionStart cannot
// veto creation, SessionEnd is cleanup only.

export interface SessionStartPayload {
  readonly sessionId: string;
  readonly worldId?: string;
}

export const runSessionStartHook =
  makeObserveHook<SessionStartPayload>("SessionStart");

export interface SessionEndPayload {
  readonly sessionId: string;
  readonly reason: "ended" | "deleted";
}

export const runSessionEndHook =
  makeObserveHook<SessionEndPayload>("SessionEnd");

// ── PreCompaction / PostCompaction ───────────────────────────────

export interface PreCompactionPayload {
  /** Number of stored messages eligible for compaction this turn. */
  readonly messageCount: number;
}

/**
 * Veto gate before history compaction. Returns `skip: true` when any handler
 * aborts — the turn pipeline then leaves history uncompacted this turn
 * (mirrors pi's `session_before_compact` cancel path).
 */
export async function runPreCompactionHook(
  opts: BaseOpts,
  payload: PreCompactionPayload,
): Promise<{ readonly skip: boolean }> {
  const result = await runHook(opts, "PreCompaction", payload);
  return { skip: result?.action === "abort" };
}

export interface PostCompactionPayload {
  readonly compacted: boolean;
  readonly summaryId?: string;
}

/** Observe the compaction outcome (parallel; return value is trace-only). */
export const runPostCompactionHook =
  makeObserveHook<PostCompactionPayload>("PostCompaction");

// ── PreSchedule ──────────────────────────────────────────────────

export interface PreSchedulePayload {
  /** Runtimes selected to run this turn, after trigger selection. */
  readonly triggered: readonly RuntimeManifest[];
}

/**
 * Observe / filter the set of runtimes scheduled this turn (after trigger
 * selection, before scheduling). Handlers may return `replace.triggered` to
 * narrow the set (e.g. conditional gating, cost control). Returning a runtime
 * not in the original set is the author's responsibility — the framework uses
 * the returned list as-is, consistent with other `replace`-based hooks.
 *
 * Filter-only: only `replace.triggered` is honoured. `abort` has no defined
 * meaning for PreSchedule and is treated as "no change" — the original
 * `triggered` set runs. To schedule no runtimes, return
 * `replace: { triggered: [] }`, not `abort`.
 */
export async function runPreScheduleHook(
  opts: BaseOpts,
  payload: PreSchedulePayload,
): Promise<readonly RuntimeManifest[]> {
  const result = await runHook(opts, "PreSchedule", payload);
  // `?? payload.triggered` covers both the no-pipeline path and the
  // `abort`/continue-without-replace paths. An explicit `replace: { triggered:
  // [] }` correctly returns the empty array (nullish, not falsy, coalescing).
  return hookReplace(result)?.triggered ?? payload.triggered;
}

// ── PreRuntime ───────────────────────────────────────────────────

export async function runPreRuntimeHook(
  opts: BaseOpts & {
    readonly manifest: RuntimeManifest;
    readonly input: TurnInput;
  },
): Promise<HookResult<{ manifest: RuntimeManifest; input: TurnInput }>> {
  return (
    (await runHook(
      opts,
      "PreRuntime",
      { manifest: opts.manifest, input: opts.input },
      { pluginId: opts.manifest.pluginId, runtimeId: opts.manifest.name },
    )) ?? { action: "continue" }
  );
}

// ── PostRuntime ──────────────────────────────────────────────────

export async function runPostRuntimeHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  result: RuntimeResult,
): Promise<RuntimeResult> {
  const hookResult = await runHook(
    opts,
    "PostRuntime",
    { result },
    { pluginId: opts.pluginId, runtimeId: opts.runtimeId },
  );
  return hookReplace(hookResult)?.result ?? result;
}

// ── PostContextAssembly ──────────────────────────────────────────

/**
 * Assembled context exposed to PostContextAssembly hooks. Turn-level (once
 * per runtime, after buildContext, before the agent loop): handlers may
 * rewrite the assembled system prompt and/or projected history. Distinct from
 * the per-call PreLLMCall — this shapes the assembled context a single time
 * (mirrors pi's `before_agent_start`).
 */
export interface AssembledContextView {
  readonly systemPrompt: string;
  readonly messages: readonly LLMMessage[];
  /**
   * Read-only `outputKind` of the runtime whose context was assembled
   * (`story` / `plugin` / `system`). Surfaced so PostContextAssembly handlers
   * can shape only the runtimes they care about (e.g. a narration director
   * that only touches story prompts) without hardcoding plugin ids — the
   * framework/plugin isolation rule. Optional and never rewritten by the hook;
   * purely informational. Absent when the caller does not supply it, keeping
   * the field a non-breaking addition.
   */
  readonly outputKind?: "story" | "plugin" | "system";
  /**
   * Resolved session locale for this turn. Surfaced so PostContextAssembly
   * handlers that inject prose (e.g. a narration director's preamble) can
   * localize it instead of hardcoding one language. Optional / non-breaking —
   * absent when the caller does not supply it; handlers fall back to a default.
   */
  readonly locale?: string;
}

export interface PostContextAssemblyPayload extends AssembledContextView {
  readonly pluginId: string;
  readonly runtimeId: string;
}

export async function runPostContextAssemblyHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  assembled: AssembledContextView,
): Promise<AssembledContextView> {
  const payload: PostContextAssemblyPayload = {
    systemPrompt: assembled.systemPrompt,
    messages: assembled.messages,
    outputKind: assembled.outputKind,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await runHook(opts, "PostContextAssembly", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  const replace = hookReplace(hookResult);
  if (replace) {
    return {
      systemPrompt: replace.systemPrompt ?? assembled.systemPrompt,
      messages: replace.messages ?? assembled.messages,
      outputKind: assembled.outputKind,
    };
  }
  return assembled;
}

// ── PreLLMCall ───────────────────────────────────────────────────

/**
 * Request shape exposed to PreLLMCall hooks. Handlers may non-destructively
 * rewrite the messages / model / tools sent on a single LLM call without
 * mutating the runtime's canonical transcript (mirrors pi's `context` event).
 */
export interface PreLLMCallRequest {
  readonly messages: readonly LLMMessage[];
  readonly model: string | undefined;
  readonly tools: readonly LLMToolDefinition[] | undefined;
}

export interface PreLLMCallPayload extends PreLLMCallRequest {
  readonly pluginId: string;
  readonly runtimeId: string;
}

export async function runPreLLMCallHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  request: PreLLMCallRequest,
): Promise<PreLLMCallRequest> {
  const payload: PreLLMCallPayload = {
    ...request,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await runHook(opts, "PreLLMCall", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  // Transform-only: only `replace` is honoured (abort has no meaning here and
  // is treated as "no change", matching pi's non-destructive `context`).
  const replace = hookReplace(hookResult);
  if (replace) {
    return {
      messages: replace.messages ?? request.messages,
      model: replace.model ?? request.model,
      tools: replace.tools ?? request.tools,
    };
  }
  return request;
}

// ── PostLLMResponse ──────────────────────────────────────────────

export interface PostLLMResponsePayload {
  readonly response: LLMResponse;
  readonly pluginId: string;
  readonly runtimeId: string;
}

export async function runPostLLMResponseHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  response: LLMResponse,
): Promise<LLMResponse> {
  const payload: PostLLMResponsePayload = {
    response,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await runHook(opts, "PostLLMResponse", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  return hookReplace(hookResult)?.response ?? response;
}

// ── PreToolUse ───────────────────────────────────────────────────

export interface PreToolUsePayload {
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  readonly pluginId: string;
  readonly runtimeId: string;
}

export type PreToolUseOutcome =
  | {
      readonly skipped: false;
      readonly toolCall: {
        readonly id: string;
        readonly name: string;
        readonly arguments: string;
      };
    }
  | { readonly skipped: true; readonly reason: string };

export async function runPreToolUseHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  toolCall: { id: string; name: string; arguments: string },
): Promise<PreToolUseOutcome> {
  const payload: PreToolUsePayload = {
    toolCall,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await runHook(opts, "PreToolUse", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  if (hookResult?.action === "abort") {
    return { skipped: true, reason: hookResult.reason };
  }

  // Accumulate any toolCall replacement from the hook result.
  const replace = hookReplace(hookResult);
  const effectiveToolCall = replace?.toolCall
    ? { ...toolCall, ...(replace.toolCall as Partial<typeof toolCall>) }
    : toolCall;
  return { skipped: false, toolCall: effectiveToolCall };
}

// ── PostToolUse ──────────────────────────────────────────────────

export interface PostToolUsePayload {
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
  };
  readonly result: unknown;
  /**
   * Hooks may set this via `replace` to end the agent tool loop after this
   * result is recorded (mirrors pi's `tool_result.terminate`). The result is
   * still pushed back to the transcript; the loop simply stops afterwards.
   */
  readonly terminate?: boolean;
}

export interface PostToolUseOutcome<R> {
  readonly result: R;
  readonly terminate: boolean;
}

export async function runPostToolUseHook<R>(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  toolCall: { id: string; name: string; arguments: string },
  result: R,
): Promise<PostToolUseOutcome<R>> {
  const payload: PostToolUsePayload = { toolCall, result };
  const hookResult = await runHook(opts, "PostToolUse", payload, {
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  });
  const replace = hookReplace(hookResult);
  if (replace) {
    return {
      result: replace.result !== undefined ? (replace.result as R) : result,
      terminate: replace.terminate === true,
    };
  }
  return { result, terminate: false };
}
