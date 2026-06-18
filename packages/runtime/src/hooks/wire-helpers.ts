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

import type { EventBus } from "@covel/events";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { HookPipeline } from "./pipeline.js";
import type { HookResult } from "./types.js";
import type { TurnEmitter } from "../turn-emitter.js";
import type {
  LLMMessage,
  LLMResponse,
  LLMToolDefinition,
} from "../llm-adapter.js";

// ── Shared options ───────────────────────────────────────────────

interface BaseOpts {
  readonly pipeline: HookPipeline | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventBus?: EventBus;
  readonly emitter?: TurnEmitter;
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
    return { action: "continue" };
  }
  return opts.pipeline.run(
    "TurnStart",
    { event: "TurnStart", sessionId: opts.sessionId, turnId: opts.turnId },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
}

// ── TurnStop ─────────────────────────────────────────────────────

export async function runTurnStopHook(
  opts: BaseOpts,
  payload: {
    readonly runtimeResults: readonly RuntimeResult[];
    readonly durationMs: number;
  },
): Promise<void> {
  if (!opts.pipeline) return;
  await opts.pipeline.run(
    "TurnStop",
    { event: "TurnStop", sessionId: opts.sessionId, turnId: opts.turnId },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
}

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
  if (!opts.pipeline) return { skip: false };
  const hookResult = await opts.pipeline.run(
    "PreCompaction",
    { event: "PreCompaction", sessionId: opts.sessionId, turnId: opts.turnId },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  return { skip: hookResult.action === "abort" };
}

export interface PostCompactionPayload {
  readonly compacted: boolean;
  readonly summaryId?: string;
}

/** Observe the compaction outcome (parallel; return value is trace-only). */
export async function runPostCompactionHook(
  opts: BaseOpts,
  payload: PostCompactionPayload,
): Promise<void> {
  if (!opts.pipeline) return;
  await opts.pipeline.run(
    "PostCompaction",
    { event: "PostCompaction", sessionId: opts.sessionId, turnId: opts.turnId },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
}

// ── PreRuntime ───────────────────────────────────────────────────

export async function runPreRuntimeHook(
  opts: BaseOpts & {
    readonly manifest: RuntimeManifest;
    readonly input: TurnInput;
  },
): Promise<HookResult<{ manifest: RuntimeManifest; input: TurnInput }>> {
  if (!opts.pipeline) {
    return { action: "continue" };
  }
  return opts.pipeline.run(
    "PreRuntime",
    {
      event: "PreRuntime",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      pluginId: opts.manifest.pluginId,
      runtimeId: opts.manifest.name,
    },
    { manifest: opts.manifest, input: opts.input },
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
}

// ── PostRuntime ──────────────────────────────────────────────────

export async function runPostRuntimeHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  result: RuntimeResult,
): Promise<RuntimeResult> {
  if (!opts.pipeline) return result;
  const hookResult = await opts.pipeline.run(
    "PostRuntime",
    {
      event: "PostRuntime",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      pluginId: opts.pluginId,
      runtimeId: opts.runtimeId,
    },
    { result },
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  if (
    hookResult.action === "continue" &&
    "replace" in hookResult &&
    hookResult.replace?.result
  ) {
    return hookResult.replace.result as RuntimeResult;
  }
  return result;
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
}

export interface PostContextAssemblyPayload extends AssembledContextView {
  readonly pluginId: string;
  readonly runtimeId: string;
}

export async function runPostContextAssemblyHook(
  opts: BaseOpts & { readonly pluginId: string; readonly runtimeId: string },
  assembled: AssembledContextView,
): Promise<AssembledContextView> {
  if (!opts.pipeline) return assembled;
  const payload: PostContextAssemblyPayload = {
    systemPrompt: assembled.systemPrompt,
    messages: assembled.messages,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await opts.pipeline.run(
    "PostContextAssembly",
    {
      event: "PostContextAssembly",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      pluginId: opts.pluginId,
      runtimeId: opts.runtimeId,
    },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  if (
    hookResult.action === "continue" &&
    "replace" in hookResult &&
    hookResult.replace
  ) {
    const r = hookResult.replace;
    return {
      systemPrompt: r.systemPrompt ?? assembled.systemPrompt,
      messages: r.messages ?? assembled.messages,
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
  if (!opts.pipeline) return request;
  const payload: PreLLMCallPayload = {
    ...request,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await opts.pipeline.run(
    "PreLLMCall",
    {
      event: "PreLLMCall",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      pluginId: opts.pluginId,
      runtimeId: opts.runtimeId,
    },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  // Transform-only: only `replace` is honoured (abort has no meaning here and
  // is treated as "no change", matching pi's non-destructive `context`).
  if (
    hookResult.action === "continue" &&
    "replace" in hookResult &&
    hookResult.replace
  ) {
    const r = hookResult.replace;
    return {
      messages: r.messages ?? request.messages,
      model: r.model ?? request.model,
      tools: r.tools ?? request.tools,
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
  if (!opts.pipeline) return response;
  const payload: PostLLMResponsePayload = {
    response,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await opts.pipeline.run(
    "PostLLMResponse",
    {
      event: "PostLLMResponse",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      pluginId: opts.pluginId,
      runtimeId: opts.runtimeId,
    },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  if (
    hookResult.action === "continue" &&
    "replace" in hookResult &&
    hookResult.replace?.response
  ) {
    return hookResult.replace.response;
  }
  return response;
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
  if (!opts.pipeline) return { skipped: false, toolCall };
  const payload: PreToolUsePayload = {
    toolCall,
    pluginId: opts.pluginId,
    runtimeId: opts.runtimeId,
  };
  const hookResult = await opts.pipeline.run(
    "PreToolUse",
    {
      event: "PreToolUse",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      pluginId: opts.pluginId,
      runtimeId: opts.runtimeId,
    },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  if (hookResult.action === "abort")
    return { skipped: true, reason: hookResult.reason };

  // Accumulate any toolCall replacement from the hook result
  let effectiveToolCall = toolCall;
  if (
    hookResult.action === "continue" &&
    "replace" in hookResult &&
    hookResult.replace?.toolCall
  ) {
    effectiveToolCall = {
      ...effectiveToolCall,
      ...(hookResult.replace.toolCall as Partial<typeof toolCall>),
    };
  }
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
  if (!opts.pipeline) return { result, terminate: false };
  const payload: PostToolUsePayload = { toolCall, result };
  const hookResult = await opts.pipeline.run(
    "PostToolUse",
    {
      event: "PostToolUse",
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      pluginId: opts.pluginId,
      runtimeId: opts.runtimeId,
    },
    payload,
    { eventBus: opts.eventBus, emitter: opts.emitter },
  );
  if (
    hookResult.action === "continue" &&
    "replace" in hookResult &&
    hookResult.replace
  ) {
    const replace = hookResult.replace;
    return {
      result: replace.result !== undefined ? (replace.result as R) : result,
      terminate: replace.terminate === true,
    };
  }
  return { result, terminate: false };
}
