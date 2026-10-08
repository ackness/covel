import {
  assertLlmRequestBudget,
  awaitLlmRequest,
  createLlmRequestBudget,
  createLlmRequestScope,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  type LLMProviderRequest,
  type LLMRequestBudget,
  type LLMTargetIdentity,
} from "@covel/shared";
/**
 * LLM request machinery for the agent tool-call loop.
 *
 * One agent step issues exactly one LLM response. Depending on the runtime it
 * goes through one of three paths:
 *   - streaming (story runtimes) — with a non-stream fallback when the stream
 *     exhausts retries or finishes empty with tool_calls but no parsed calls;
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
import { isTerminalLlmRequestError } from "../retry/retry-common.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import type {
  LLMToolDefinition,
  LLMResponseFormat,
} from "../llm/llm-adapter.js";
import {
  combineAbortSignals,
  getTurnExecutionSignal,
  throwIfTurnExecutionAborted,
} from "../turn-executor/turn-control.js";

export interface RequestLLMResponseOptions {
  readonly manifest: RuntimeManifest;
  readonly deps: AgentLoopDeps;
  readonly messages: LLMMessage[];
  readonly effectiveModel: string | undefined;
  readonly toolDefs: readonly LLMToolDefinition[] | undefined;
  readonly responseFormat: LLMResponseFormat | undefined;
  /** Session locale, for the instructions the retry layer and adapter add. */
  readonly locale?: string;
  readonly maxOutputTokens?: number;
  readonly retryPolicy: RetryPolicy;
  readonly deadline: number;
  readonly useStreaming: boolean;
  readonly reportRetry: (info: RetryInfo) => void;
  /** Forwards LLM-slot queue waits so the tool loop can extend its deadline. */
  readonly onQueueWait?: (waitedMs: number) => void;
  /** Forwards the time a stream spent writing, for the same extension. */
  readonly onStreamTime?: (streamedMs: number) => void;
  /** Called once per forwarded text delta; the DeltaForwarder owns the count. */
  readonly onStreamDelta: (textDelta: string) => Promise<void>;
  /** Whether `onStreamDelta` shows text to the player (story runtimes). */
  readonly deliversDeltas: boolean;
}

/**
 * Issue one LLM response for the current agent step. Throws on unrecoverable
 * errors; the caller's outer try/catch maps those to a failed RuntimeResult.
 */
export async function requestLLMResponse(
  opts: RequestLLMResponseOptions,
): Promise<LLMResponse & { readonly target?: LLMTargetIdentity }> {
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

  // One logical call may use the runtime's remaining time, so each retry the
  // policy allows can run. It is never less than the default: time queued for
  // a model slot counts here, while the runtime deadline is credited for it.
  // Output of a stream moves the limit.
  const requestScope = createLlmRequestScope({
    budget: createLlmRequestBudget({
      timeoutMs: Math.max(
        DEFAULT_LLM_REQUEST_TIMEOUT_MS,
        deadline - Date.now(),
      ),
      idleTimeoutMs: retryPolicy.idleTimeoutMs,
    }),
  });
  const callParams = {
    llm: deps.llm,
    model: effectiveModel,
    messages,
    tools: toolDefs,
    responseFormat,
    ...(opts.locale ? { locale: opts.locale } : {}),
    defaults: manifest.llm,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    // The player has read a story as it streamed. Cut at the output limit,
    // it is kept and marked `length`; any other output must be whole.
    allowTruncatedText: manifest.outputKind === "story",
    policy: retryPolicy,
    deadline,
    requestBudget: requestScope.budget,
    onQueueWait,
    onTargetAttempt: (target: LLMTargetIdentity) => {
      resolvedTarget = target;
    },
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

  try {
    const response = await awaitLlmRequest(
      useStreaming
        ? requestStreaming(opts, callParams, onStreamDelta)
        : requestNonStreaming(opts, callParams),
      requestScope.signal,
    );
    return { ...response, target: resolvedTarget };
  } finally {
    requestScope.dispose();
  }
}

type CallParams = Parameters<typeof callLLMWithRetry>[0];

async function requestStreaming(
  opts: RequestLLMResponseOptions,
  callParams: CallParams,
  onStreamDelta: (textDelta: string) => Promise<void>,
): Promise<LLMResponse> {
  const { manifest, deadline, toolDefs } = opts;
  let response: LLMResponse;
  let usedNonStreamFallback = false;

  // Streaming path: helper enforces the first-token (TTFB) and idle guards,
  // retries on transient failures, and forwards text deltas to
  // the caller on the first attempt. If streaming exhausts its retries
  // without output the player saw, fall back to a non-stream call — except
  // after a cut at the output limit, which a non-stream call would repeat.
  try {
    const streamed = await streamLLMWithRetry({
      ...callParams,
      onDelta: onStreamDelta,
      deliversDeltas: opts.deliversDeltas,
      onStreamTime: opts.onStreamTime,
    });
    response = streamed.response;
  } catch (streamError) {
    if (
      streamError instanceof LLMRetryError &&
      !streamError.hasPartialOutput &&
      streamError.reason !== "output-truncated" &&
      Date.now() < deadline
    ) {
      console.warn(
        `[stream-recovery] ${manifest.name} streaming exhausted (reason=${streamError.reason}); falling back to non-stream generate()`,
      );
      response = await callLLMWithRetry(callParams);
      usedNonStreamFallback = true;
    } else {
      throw streamError;
    }
  }

  // Some providers finish with tool_calls but omit the structured payload on
  // SSE. Only an entirely empty stream can be replaced: text has already been
  // forwarded to the player, and reasoning is part of this response's output.
  if (
    response.finishReason === "tool_calls" &&
    response.toolCalls.length === 0 &&
    toolDefs
  ) {
    if (response.content || response.reasoningContent) {
      throw new Error(
        "PROVIDER_ERROR: model stream ended with tool_calls but no structured calls after producing output",
      );
    }
    if (
      usedNonStreamFallback ||
      !opts.deps.llm.stream ||
      Date.now() >= deadline
    ) {
      throw new Error(
        "PROVIDER_ERROR: model response ended with tool_calls but no structured calls",
      );
    }
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
    if (
      isTerminalLlmRequestError(cause) ||
      !toolDefs ||
      !shouldRetryMalformedToolArguments(cause)
    ) {
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
      onTargetAttempt: callParams.onTargetAttempt,
      requestBudget: callParams.requestBudget!,
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
  onTargetAttempt?: (target: LLMTargetIdentity) => void;
  requestBudget: LLMRequestBudget;
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
  const providerRequests: LLMProviderRequest[] = [];
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
      responseFormat,
      defaults: manifest.llm,
      maxOutputTokens,
      providerRequests,
      attempt: 0,
      startedAt: new Date(fallbackCallStart).toISOString(),
    });
  };
  let response: LLMResponse;
  try {
    assertLlmRequestBudget(args.requestBudget, {
      requireAttempt: true,
      signal: getTurnExecutionSignal(deps.turnControl),
    });
    const signal = combineAbortSignals(
      getTurnExecutionSignal(deps.turnControl),
      AbortSignal.timeout(
        Math.max(
          1000,
          Math.min(
            retryPolicy.callTimeoutMs,
            deadline - Date.now(),
            args.requestBudget.deadline - Date.now(),
          ),
        ),
      ),
    );
    response = await awaitLlmRequest(
      deps.llm.generate({
        model: effectiveModel,
        messages,
        tools: toolDefs,
        responseFormat,
        defaults: manifest.llm,
        requestBudget: args.requestBudget,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(deps.emitter
          ? {
              onProviderRequest: (request: LLMProviderRequest) => {
                providerRequests.push(request);
              },
            }
          : {}),
        onTargetAttempt: (target) => {
          actualTarget = target;
          args.onTargetAttempt?.(target);
        },
        signal,
      }),
      signal,
    );
    throwIfTurnExecutionAborted(
      deps.turnControl,
      "malformed tool arguments fallback",
    );
    if (response.finishReason === "error") {
      throw new Error("PROVIDER_ERROR: model generation ended with an error");
    }
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
    throwIfTurnExecutionAborted(
      deps.turnControl,
      "malformed tool arguments fallback",
    );
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
