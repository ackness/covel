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
 *     or finishes with tool_calls but no parsed calls. All output stays
 *     internal until a complete response is accepted and committed;
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
  /**
   * A correction just asked the model to call a tool, so this request
   * requires one (`toolChoice: "required"`, as in the AI SDK) instead of
   * leaving the choice to a model that already answered in prose.
   */
  readonly requireToolCall?: boolean;
  /** The loop requests submission: due output, resubmission or its sole reserve. */
  readonly submissionRequested?: boolean;
  /**
   * This step's tool choice from a PreStep hook. It replaces the manifest's
   * `llm.toolChoice` for the request; `"auto"` sends none. A correction's
   * `requireToolCall` still forces a call over `"auto"`.
   */
  readonly toolChoice?: "auto" | "required" | { readonly name: string };
}

/**
 * The runtime's request defaults, with a tool call required when a
 * correction asked for one. Submission can replace a named business tool;
 * adapters narrow the requested choice to the target's thinking capabilities.
 */
export function requestDefaults(
  manifest: RuntimeManifest,
  requireToolCall: boolean | undefined,
  toolDefs: readonly LLMToolDefinition[] | undefined,
  stepToolChoice?: RequestLLMResponseOptions["toolChoice"],
  submissionRequested = false,
): LLMRequestDefaults | undefined {
  let defaults = manifest.llm;
  if (stepToolChoice === "auto") {
    if (defaults?.toolChoice !== undefined) {
      const { toolChoice: _manifestChoice, ...rest } = defaults;
      defaults = rest;
    }
  } else if (stepToolChoice !== undefined && toolDefs?.length) {
    defaults = { ...defaults, toolChoice: stepToolChoice };
  }
  const submission = toolDefs?.find((tool) => tool.name === "submit-output");
  if (submission && (submissionRequested || toolDefs?.length === 1))
    return { ...defaults, toolChoice: { name: submission.name } };
  if (!requireToolCall || !toolDefs?.length || defaults?.toolChoice)
    return defaults;
  return { ...defaults, toolChoice: "required" };
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
    defaults: requestDefaults(
      manifest,
      opts.requireToolCall,
      toolDefs,
      opts.toolChoice,
      opts.submissionRequested,
    ),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(opts.promptCacheKey ? { promptCacheKey: opts.promptCacheKey } : {}),
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
        ? requestStreaming(opts, callParams)
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
): Promise<LLMResponse> {
  const { manifest, deadline, toolDefs } = opts;
  let response: LLMResponse;
  let usedNonStreamFallback = false;

  // The helper preserves silence guards, usage and bounded retries while
  // discarding each failed attempt. A transient exhausted stream may use
  // non-stream recovery; a truncated or refused request must fail.
  try {
    const streamed = await streamLLMWithRetry({
      ...callParams,
      onStreamTime: opts.onStreamTime,
    });
    response = streamed.response;
  } catch (streamError) {
    if (
      streamError instanceof LLMRetryError &&
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

  // Some providers omit structured calls on SSE. The response has reached
  // nobody, so discard it and use a single non-stream recovery request.
  if (
    response.finishReason === "tool_calls" &&
    response.toolCalls.length === 0 &&
    toolDefs
  ) {
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
