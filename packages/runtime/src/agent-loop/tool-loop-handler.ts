import {
  awaitLlmRequest,
  createLlmRequestBudget,
  createLlmRequestScope,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  type LLMTargetIdentity,
} from "@covel/shared";
/**
 * LLM request machinery for the agent tool-call loop.
 *
 * One agent step issues exactly one LLM response. It goes through one of two
 * paths, chosen by `useStreaming` (see agent-loop-policy.ts):
 *   - streaming — with a non-stream fallback when the stream exhausts retries
 *     or finishes empty with tool_calls but no parsed calls. Only story
 *     runtimes forward the text deltas to the player;
 *   - non-streaming — with the shared transient-error retry policy.
 *
 * Extracted from `turn-agent-tool-loop.ts` so the main loop body reads as a
 * sequence of named steps rather than a 170-line branch.
 */

import type { LLMRequestDefaults, RuntimeManifest } from "@covel/shared";
import type { LLMMessage, LLMResponse } from "@covel/shared";
import {
  callLLMWithRetry,
  streamLLMWithRetry,
  type RetryInfo,
} from "../retry/llm-retry.js";
import { LLMRetryError, type RetryPolicy } from "../retry/retry-common.js";
import { isStreamRecoveryAllowed } from "../retry/retry-common.js";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";
import type { LLMToolDefinition, LLMResponseFormat } from "@covel/shared";
import { getTurnExecutionSignal } from "../turn-executor/turn-control.js";

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
  /** Cache-routing key of this runtime's requests in this session. */
  readonly promptCacheKey?: string;
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
  /**
   * A correction just asked the model to call a tool, so this request
   * requires one (`toolChoice: "required"`, as in the AI SDK) instead of
   * leaving the choice to a model that already answered in prose.
   */
  readonly requireToolCall?: boolean;
}

/**
 * The runtime's request defaults, with a tool call required when a
 * correction asked for one. A tool the manifest names stays the choice, and
 * the adapters still drop a required choice for a model that is thinking.
 */
function requestDefaults(
  manifest: RuntimeManifest,
  requireToolCall: boolean | undefined,
  toolDefs: readonly LLMToolDefinition[] | undefined,
): LLMRequestDefaults | undefined {
  if (!requireToolCall || !toolDefs?.length || manifest.llm?.toolChoice)
    return manifest.llm;
  return { ...manifest.llm, toolChoice: "required" };
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
    defaults: requestDefaults(manifest, opts.requireToolCall, toolDefs),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(opts.promptCacheKey ? { promptCacheKey: opts.promptCacheKey } : {}),
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
        : callLLMWithRetry(callParams),
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
  // after a cut at the output limit or a provider error that refuses the
  // request itself (401, 400), which a non-stream call would repeat.
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
      isStreamRecoveryAllowed(streamError) &&
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
