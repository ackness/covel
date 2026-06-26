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
import type { LLMMessage, LLMResponse } from "./llm-adapter.js";
import {
  callLLMWithRetry,
  streamLLMWithRetry,
  LLMRetryError,
  type RetryInfo,
  type RetryPolicy,
} from "./llm-retry.js";
import {
  emitLlmCalling,
  emitLlmRespondedError,
  emitLlmRespondedSuccess,
} from "./llm-telemetry.js";
import { shouldRetryMalformedToolArguments } from "./turn-output-helpers.js";
import type { AgentLoopDeps } from "./turn-executor-types.js";
import type { LLMToolDefinition, LLMResponseFormat } from "./llm-adapter.js";

export interface RequestLLMResponseOptions {
  readonly manifest: RuntimeManifest;
  readonly deps: AgentLoopDeps;
  readonly messages: LLMMessage[];
  readonly effectiveModel: string | undefined;
  readonly toolDefs: readonly LLMToolDefinition[] | undefined;
  readonly responseFormat: LLMResponseFormat | undefined;
  readonly retryPolicy: RetryPolicy;
  readonly deadline: number;
  readonly useStreaming: boolean;
  readonly reportRetry: (info: RetryInfo) => void;
  /** Called once per forwarded text delta; returns the running delta count. */
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
    retryPolicy,
    deadline,
    useStreaming,
    reportRetry,
    onStreamDelta,
  } = opts;

  const callParams = {
    llm: deps.llm,
    model: effectiveModel,
    messages,
    tools: toolDefs,
    responseFormat,
    policy: retryPolicy,
    deadline,
    onRetry: reportRetry,
    emitter: deps.emitter,
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
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
      retryPolicy,
      deadline,
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
  retryPolicy: RetryPolicy;
  deadline: number;
}): Promise<LLMResponse> {
  const {
    manifest,
    deps,
    messages,
    effectiveModel,
    toolDefs,
    responseFormat,
    retryPolicy,
    deadline,
  } = args;
  const fallbackCallStart = Date.now();
  // Malformed-tool-arguments fallback bypasses the retry helper, so provider
  // identity is not available here. Explicit `null` signals "provider unknown
  // at this call site" and survives JSON serialisation (unlike `undefined`,
  // which is dropped), keeping the payload schema uniform across emit sites.
  await emitLlmCalling(deps.emitter, {
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    slot: effectiveModel,
    model: effectiveModel,
    provider: null,
    messages,
    tools: toolDefs,
    attempt: 0,
  });
  let response: LLMResponse;
  try {
    response = await deps.llm.generate({
      model: effectiveModel,
      messages,
      tools: toolDefs,
      responseFormat,
      signal: AbortSignal.timeout(
        Math.max(
          1000,
          Math.min(retryPolicy.callTimeoutMs, deadline - Date.now()),
        ),
      ),
    });
  } catch (fallbackErr) {
    // Pair every `llm.calling` with an `llm.responded` on the error path so
    // trace-viewer pairing stays intact when this fallback generate throws.
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
