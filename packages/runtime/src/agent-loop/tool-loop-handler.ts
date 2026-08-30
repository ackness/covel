/**
 * LLM request machinery for the agent tool-call loop.
 *
 * One agent step issues exactly one LLM response. Depending on the runtime it
 * goes through one of three paths:
 *   - streaming (story runtimes) — with a non-stream fallback when the stream
 *     exhausts retries or finishes with tool_calls but no parsed calls;
 *   - non-streaming — with a narrow secondary retry for DeepSeek's malformed
 *     tool-arguments error.
 *
 * Extracted from `turn-agent-tool-loop.ts` so the main loop body reads as a
 * sequence of named steps rather than a 170-line branch.
 */

import type { RuntimeManifest } from "@covel/shared";
import type { LLMMessage, LLMResponse } from "../llm/llm-adapter.js";
import {
  callLLMWithRetry,
  streamLLMWithRetry,
  LLMRetryError,
  type RetryInfo,
  type RetryPolicy,
} from "../retry/llm-retry.js";
import {
  emitLlmCalling,
  emitLlmRespondedError,
  emitLlmRespondedSuccess,
} from "../llm/llm-telemetry.js";
import { shouldRetryMalformedToolArguments } from "../turn-executor/turn-output-helpers.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import type {
  LLMToolDefinition,
  LLMResponseFormat,
} from "../llm/llm-adapter.js";
import {
  combineAbortSignals,
  getTurnExecutionSignal,
} from "../turn-executor/turn-control.js";

export interface RequestLLMResponseOptions {
  readonly manifest: RuntimeManifest;
  readonly deps: AgentLoopDeps;
  readonly messages: LLMMessage[];
  readonly effectiveModel: string | undefined;
  readonly toolDefs: readonly LLMToolDefinition[] | undefined;
  readonly responseFormat: LLMResponseFormat | undefined;
  readonly maxOutputTokens?: number;
  readonly retryPolicy: RetryPolicy;
  readonly deadline: number;
  readonly useStreaming: boolean;
  readonly reportRetry: (info: RetryInfo) => void;
  /** Forwards LLM-slot queue waits so the tool loop can extend its deadline. */
  readonly onQueueWait?: (waitedMs: number) => void;
  /** Called once per forwarded text delta; the DeltaForwarder owns the count. */
  readonly onStreamDelta: (textDelta: string) => Promise<void>;
}

/**
 * Issue one LLM response for the current agent step. Throws on unrecoverable
 * errors; the caller's outer try/catch maps those to a failed RuntimeResult.
 */
export async function requestLLMResponse(
  opts: RequestLLMResponseOptions,
): Promise<LLMResponse> {
  const {
    manifest,
    deps,
    messages,
    effectiveModel,
    toolDefs,
    responseFormat,
    maxOutputTokens,
    retryPolicy,
    deadline,
    useStreaming,
    reportRetry,
    onStreamDelta,
    onQueueWait,
  } = opts;
  // Target resolution enriches telemetry only. A custom resolver failure must
  // not bypass the normal retry/error path of the actual LLM request.
  let resolvedTarget: ReturnType<NonNullable<typeof deps.llm.resolveTarget>>;
  try {
    resolvedTarget = deps.llm.resolveTarget?.(effectiveModel);
  } catch {
    resolvedTarget = undefined;
  }

  const callParams = {
    llm: deps.llm,
    model: effectiveModel,
    messages,
    tools: toolDefs,
    responseFormat,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    policy: retryPolicy,
    deadline,
    onQueueWait,
    onRetry: reportRetry,
    emitter: deps.emitter,
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    ...(resolvedTarget
      ? {
          resolvedModel: resolvedTarget.model,
          provider: resolvedTarget.provider,
        }
      : {}),
    // Player aborts and parent execution deadlines both cut the in-flight call.
    abortSignal: getTurnExecutionSignal(deps.turnControl),
  } as const;

  if (useStreaming) {
    return requestStreaming(opts, callParams, onStreamDelta);
  }
  return requestNonStreaming(opts, callParams);
}

type CallParams = Parameters<typeof callLLMWithRetry>[0];

async function requestStreaming(
  opts: RequestLLMResponseOptions,
  callParams: CallParams,
  onStreamDelta: (textDelta: string) => Promise<void>,
): Promise<LLMResponse> {
  const { manifest, deadline, toolDefs } = opts;
  let response: LLMResponse;

  // Streaming path: helper enforces per-attempt call-timeout + first-token
  // (TTFB) guard, retries on transient failures, and forwards text deltas to
  // the caller on the first attempt. If streaming exhausts its retries with a
  // transient failure, fall back to a single non-stream call.
  try {
    const streamed = await streamLLMWithRetry({
      ...callParams,
      onDelta: onStreamDelta,
    });
    response = streamed.response;
  } catch (streamError) {
    if (streamError instanceof LLMRetryError && Date.now() < deadline) {
      console.warn(
        `[stream-recovery] ${manifest.name} streaming exhausted (reason=${streamError.reason}); falling back to non-stream generate()`,
      );
      response = await callLLMWithRetry(callParams);
    } else {
      throw streamError;
    }
  }

  // If the stream finished with tool_calls but our adapter could not parse
  // structured calls out of delta chunks (some providers don't deliver them on
  // SSE), fall back to a non-stream call to get the structured payload.
  if (
    response.finishReason === "tool_calls" &&
    response.toolCalls.length === 0 &&
    toolDefs
  ) {
    response = await callLLMWithRetry(callParams);
  }
  return response;
}

async function requestNonStreaming(
  opts: RequestLLMResponseOptions,
  callParams: CallParams,
): Promise<LLMResponse> {
  const {
    manifest,
    deps,
    messages,
    effectiveModel,
    toolDefs,
    responseFormat,
    maxOutputTokens,
    retryPolicy,
    deadline,
  } = opts;

  // Non-streaming path: helper handles transient-error + call-timeout retry. A
  // narrow secondary retry covers the DeepSeek-specific "function.arguments
  // JSON format" error which isTransientError does not classify as retriable.
  try {
    return await callLLMWithRetry(callParams);
  } catch (error) {
    const cause = error instanceof LLMRetryError ? error.cause : error;
    if (!toolDefs || !shouldRetryMalformedToolArguments(cause)) {
      throw error;
    }
    return malformedToolArgsFallback({
      manifest,
      deps,
      messages,
      effectiveModel,
      toolDefs,
      responseFormat,
      maxOutputTokens,
      retryPolicy,
      deadline,
      resolvedModel: callParams.resolvedModel,
      provider: callParams.provider,
    });
  }
}

async function malformedToolArgsFallback(args: {
  manifest: RuntimeManifest;
  deps: AgentLoopDeps;
  messages: LLMMessage[];
  effectiveModel: string | undefined;
  toolDefs: readonly LLMToolDefinition[];
  responseFormat: LLMResponseFormat | undefined;
  maxOutputTokens: number | undefined;
  retryPolicy: RetryPolicy;
  deadline: number;
  resolvedModel: string | undefined;
  provider: string | undefined;
}): Promise<LLMResponse> {
  const {
    manifest,
    deps,
    messages,
    effectiveModel,
    toolDefs,
    responseFormat,
    maxOutputTokens,
    retryPolicy,
    deadline,
    resolvedModel,
    provider,
  } = args;
  const fallbackCallStart = Date.now();
  let actualTarget =
    provider && resolvedModel ? { provider, model: resolvedModel } : undefined;
  let callingEmitted = false;
  const ensureCalling = async (): Promise<void> => {
    if (callingEmitted) return;
    callingEmitted = true;
    await emitLlmCalling(deps.emitter, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      slot: effectiveModel,
      model: actualTarget?.model ?? resolvedModel ?? effectiveModel,
      provider: actualTarget?.provider ?? provider,
      messages,
      tools: toolDefs,
      attempt: 0,
      startedAt: new Date(fallbackCallStart).toISOString(),
    });
  };
  let response: LLMResponse;
  try {
    response = await deps.llm.generate({
      model: effectiveModel,
      messages,
      tools: toolDefs,
      responseFormat,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      onTargetAttempt: (target) => {
        actualTarget = target;
      },
      signal: combineAbortSignals(
        getTurnExecutionSignal(deps.turnControl),
        AbortSignal.timeout(
          Math.max(
            1000,
            Math.min(retryPolicy.callTimeoutMs, deadline - Date.now()),
          ),
        ),
      ),
    });
    await ensureCalling();
  } catch (fallbackErr) {
    // Pair every `llm.calling` with an `llm.responded` on the error path so
    // trace-viewer pairing stays intact when this fallback generate throws.
    await ensureCalling();
    await emitLlmRespondedError(deps.emitter, {
      runtimeId: manifest.name,
      pluginId: manifest.pluginId,
      error: fallbackErr,
      durationMs: Date.now() - fallbackCallStart,
      attempt: 0,
    });
    throw fallbackErr;
  }
  await emitLlmRespondedSuccess(deps.emitter, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    response,
    durationMs: Date.now() - fallbackCallStart,
    attempt: 0,
  });
  return response;
}
