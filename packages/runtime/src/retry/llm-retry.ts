/**
 * Smart LLM retry helpers used by turn-executor.
 *
 * Failures that burn an entire runtime budget in one shot — hung HTTP
 * requests, streaming connections that never emit a first token, providers
 * complicating into 5xx / rate-limit — are retried here in a bounded loop
 * that respects the outer runtime deadline. The retry strategy adds a tiny
 * perturbation to the messages on each attempt so that any provider-side KV
 * cache cannot trivially reproduce the same hang.
 *
 * Four retry triggers:
 *   - first-token-timeout: streaming call produced no text/tool event before
 *     `firstTokenTimeoutMs` (default 30s) — provider socket alive but model
 *     stuck.
 *   - call-timeout: whole call exceeded `callTimeoutMs` (derived from the
 *     runtime budget + retry count) — uses AbortSignal.timeout.
 *   - transient-error: AbortError / timeout / network / 5xx / RATE_LIMITED /
 *     PROVIDER_ERROR bubbling from the adapter.
 *   - tool-loop-detected: the caller reports `N` consecutive tool calls with
 *     identical `name + arguments`. Detection lives outside this module (the
 *     tool-call loop in turn-executor owns it), but a perturbation on retry
 *     is what actually breaks the loop.
 *
 * All retry errors surface as {@link LLMRetryError} so the caller can
 * distinguish "exhausted" from an unrecoverable client error.
 */

import type {
  LLMAdapter,
  LLMMessage,
  LLMResponseFormat,
  LLMResponse,
  LLMStreamEvent,
  LLMToolCall,
  LLMToolDefinition,
} from "../llm/llm-adapter.js";
import {
  emitLlmCalling,
  emitLlmRespondedError,
  emitLlmRespondedSuccess,
} from "../llm/llm-telemetry.js";
import { TurnAbortedError } from "../turn-executor/turn-control.js";
import {
  LLMRetryError,
  assertDeadlineNotReached,
  buildRetryPolicy,
  computeAttemptBudget,
  exhaustedError,
  extractMessage,
  isTransientError,
  perturbMessages,
  type RetryPolicy,
  type RetryReason,
} from "./retry-common.js";

// Re-export the shared retry primitives so existing import sites that pull
// these from `llm-retry.js` keep working unchanged.
export {
  LLMRetryError,
  buildRetryPolicy,
  isTransientError,
  perturbMessages,
  DEFAULT_MAX_RETRIES,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DEFAULT_LOOP_THRESHOLD,
  DEFAULT_CALL_TIMEOUT_CAP_MS,
  MIN_CALL_TIMEOUT_MS,
} from "./retry-common.js";
export type { RetryPolicy, RetryReason } from "./retry-common.js";

// ── Tool-loop detection ─────────────────────────────────────────────

/**
 * Detect when the last `threshold` tool calls are identical. Identity is
 * `name + arguments` (arguments are JSON strings; trivial whitespace diffs
 * would count as different — that is the desired behaviour).
 *
 * `threshold` of 0 disables detection.
 */
export function detectToolLoop(
  calls: readonly { readonly name: string; readonly arguments: string }[],
  threshold: number,
): boolean {
  if (threshold <= 0) return false;
  if (calls.length < threshold) return false;
  const tail = calls.slice(-threshold);
  const first = tail[0];
  return tail.every(
    (c) => c.name === first.name && c.arguments === first.arguments,
  );
}

// ── Non-streaming retry ─────────────────────────────────────────────

export interface CallLLMWithRetryParams {
  readonly llm: LLMAdapter;
  readonly model?: string;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMToolDefinition[];
  readonly responseFormat?: LLMResponseFormat;
  readonly policy: RetryPolicy;
  /**
   * Absolute runtime deadline (ms since epoch). The retry loop aborts once
   * this is reached even if retries remain.
   */
  readonly deadline: number;
  /**
   * Optional callback fired before each retry attempt (after the first).
   * Useful for logging / tracing.
   */
  readonly onRetry?: (info: RetryInfo) => void;
  /** Emitter for llm.calling / llm.responded trace events. */
  readonly emitter?: import("../trace/turn-emitter.js").TurnEmitter;
  /** Identity for trace payload enrichment. */
  readonly runtimeId?: string;
  readonly pluginId?: string;
  /** Provider label for trace payload (e.g. 'deepseek', 'openai'). Optional. */
  readonly provider?: string;
  /**
   * Player/turn-level abort (roadmap W4). Non-retriable: fires
   * {@link TurnAbortedError} immediately — including out of the streaming
   * salvage path, so a player abort never commits partial content.
   */
  readonly abortSignal?: AbortSignal;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly reason: RetryReason;
  readonly error: unknown;
}

export async function callLLMWithRetry(
  params: CallLLMWithRetryParams,
): Promise<LLMResponse> {
  const { llm, model, messages, tools, policy, deadline, onRetry } = params;
  let lastError: unknown = new Error("retry loop did not execute");
  let lastReason: RetryReason = "unknown";

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    throwIfTurnAborted(params.abortSignal);
    assertDeadlineNotReached(deadline, attempt, lastError);

    const budget = computeAttemptBudget(policy, deadline);
    const timeoutSignal = AbortSignal.timeout(budget);
    const signal = params.abortSignal
      ? AbortSignal.any([timeoutSignal, params.abortSignal])
      : timeoutSignal;
    const attemptMessages = perturbMessages(messages, attempt, lastReason);

    const callStart = Date.now();
    try {
      await emitLlmCalling(params.emitter, {
        runtimeId: params.runtimeId,
        pluginId: params.pluginId,
        slot: params.model,
        model: params.model,
        provider: params.provider,
        messages: attemptMessages,
        tools: params.tools,
        attempt,
      });
      const response = await llm.generate({
        model,
        messages: attemptMessages,
        tools,
        responseFormat: params.responseFormat,
        signal,
      });
      await emitLlmRespondedSuccess(params.emitter, {
        runtimeId: params.runtimeId,
        pluginId: params.pluginId,
        response,
        durationMs: Date.now() - callStart,
        attempt,
      });
      return response;
    } catch (err) {
      await emitLlmRespondedError(params.emitter, {
        runtimeId: params.runtimeId,
        pluginId: params.pluginId,
        error: err,
        durationMs: Date.now() - callStart,
        attempt,
      });
      throwIfTurnAborted(params.abortSignal);
      lastError = err;
      lastReason = isCallTimeout(err, timeoutSignal)
        ? "call-timeout"
        : isTransientError(err)
          ? "transient-error"
          : "unknown";
      if (attempt >= policy.maxRetries || lastReason === "unknown") {
        throw new LLMRetryError({
          reason: lastReason,
          attempts: attempt + 1,
          cause: err,
        });
      }
      onRetry?.({ attempt: attempt + 1, reason: lastReason, error: err });
    }
  }

  // Unreachable; the loop either returns or throws.
  throw exhaustedError(policy, lastReason, lastError);
}

function throwIfTurnAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new TurnAbortedError();
  }
}

function isCallTimeout(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? "");
    if (msg.toLowerCase().includes("timeout")) return true;
  }
  const text = extractMessage(err).toLowerCase();
  return text.includes("timeout") || text.includes("timed out");
}

// ── Streaming retry (with first-token guard) ────────────────────────

export interface StreamLLMWithRetryParams extends CallLLMWithRetryParams {
  /** Optional sink for text deltas so streaming can keep its UX. */
  readonly onDelta?: (delta: string) => void | Promise<void>;
}

export interface StreamLLMResult {
  readonly response: LLMResponse;
  readonly attempt: number;
}

/**
 * Drive a streaming LLM call with TTFB and total-call guards. Returns the
 * fully reassembled response once the stream completes (or after we fall
 * back to a single non-stream call when the stream died with no content).
 *
 * The caller is responsible for replaying deltas via `onDelta` — we forward
 * every text-delta as it arrives on the first attempt. On retry we
 * intentionally stop forwarding so the user does not see duplicate text;
 * perturbation + a fresh retry means the second stream is treated as the
 * source of truth.
 */
export async function streamLLMWithRetry(
  params: StreamLLMWithRetryParams,
): Promise<StreamLLMResult> {
  const { llm, model, messages, tools, policy, deadline, onDelta, onRetry } =
    params;
  if (!llm.stream) {
    // No streaming support — fall back to non-streaming retry so callers can
    // use the same entrypoint uniformly.
    const response = await callLLMWithRetry(params);
    return { response, attempt: 0 };
  }

  let lastError: unknown = new Error("stream retry loop did not execute");
  let lastReason: RetryReason = "unknown";

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    throwIfTurnAborted(params.abortSignal);
    assertDeadlineNotReached(deadline, attempt, lastError);

    const budget = computeAttemptBudget(policy, deadline);
    // Compose three abort sources into one per-attempt signal:
    //   1. overall call budget (per-attempt)
    //   2. first-token (TTFB) guard — armed on attempt start, disarmed on first event
    //   3. player turn abort (W4) — forwarded from params.abortSignal below
    const callAborter = new AbortController();
    const onExternalAbort = (): void => {
      callAborter.abort(new DOMException("turn aborted", "AbortError"));
    };
    params.abortSignal?.addEventListener("abort", onExternalAbort, {
      once: true,
    });
    const callTimeoutHandle = setTimeout(() => {
      callAborter.abort(new DOMException("call timeout", "TimeoutError"));
    }, budget);
    const ttfbHandle = setTimeout(() => {
      if (!firstTokenSeen) {
        callAborter.abort(
          new DOMException("first-token timeout", "TimeoutError"),
        );
      }
    }, policy.firstTokenTimeoutMs);

    let firstTokenSeen = false;
    const streamedToolCalls: LLMToolCall[] = [];
    let streamedContent = "";
    let streamedReasoningContent = "";
    let streamedUsage = { inputTokens: 0, outputTokens: 0 };
    let streamFinishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
    const attemptMessages = perturbMessages(messages, attempt, lastReason);
    const forwardDeltas = attempt === 0; // avoid duplicate text on retry
    const streamStart = Date.now();
    await emitLlmCalling(params.emitter, {
      runtimeId: params.runtimeId,
      pluginId: params.pluginId,
      slot: params.model,
      model: params.model,
      provider: params.provider,
      messages: attemptMessages,
      tools: params.tools,
      attempt,
      streaming: true,
    });

    try {
      for await (const event of llm.stream({
        model,
        messages: attemptMessages,
        tools,
        signal: callAborter.signal,
      })) {
        if (event.type === "text-delta") {
          firstTokenSeen = true;
          streamedContent += event.textDelta;
          if (forwardDeltas) await onDelta?.(event.textDelta);
        } else if (event.type === "tool-call") {
          firstTokenSeen = true;
          streamedToolCalls.push({
            id: event.id,
            name: event.name,
            arguments: event.arguments,
          });
        } else if (event.type === "done") {
          streamFinishReason = event.finishReason as
            | "stop"
            | "tool_calls"
            | "length"
            | "error";
          if (event.reasoningContent)
            streamedReasoningContent = event.reasoningContent;
          if (event.usage) streamedUsage = event.usage;
        }
      }

      clearTimeout(callTimeoutHandle);
      clearTimeout(ttfbHandle);
      params.abortSignal?.removeEventListener("abort", onExternalAbort);

      const finalResponse: LLMResponse = {
        content: streamedContent || null,
        toolCalls: streamedToolCalls,
        finishReason: streamFinishReason,
        usage: streamedUsage,
        ...(streamedReasoningContent
          ? { reasoningContent: streamedReasoningContent }
          : {}),
      };
      await emitLlmRespondedSuccess(params.emitter, {
        runtimeId: params.runtimeId,
        pluginId: params.pluginId,
        response: finalResponse,
        durationMs: Date.now() - streamStart,
        attempt,
        streaming: true,
      });
      return {
        response: finalResponse,
        attempt,
      };
    } catch (err) {
      clearTimeout(callTimeoutHandle);
      clearTimeout(ttfbHandle);
      params.abortSignal?.removeEventListener("abort", onExternalAbort);
      lastError = err;
      lastReason = classifyStreamError(err, callAborter.signal, firstTokenSeen);

      // Pair every `llm.calling` with an `llm.responded` on the error path.
      // Without this, a streamed turn that fails mid-flight leaves a dangling
      // `llm.calling` in trace_events and breaks trace-viewer pairing. This
      // must run BEFORE the abort throw below so a player abort still emits
      // the paired `llm.responded`.
      await emitLlmRespondedError(params.emitter, {
        runtimeId: params.runtimeId,
        pluginId: params.pluginId,
        error: err,
        durationMs: Date.now() - streamStart,
        attempt,
        streaming: true,
      });

      // Player abort is non-retriable AND must bypass the salvage path
      // below — salvaged partial narrative would otherwise be committed.
      throwIfTurnAborted(params.abortSignal);

      // Salvage path: stream died mid-flight but we already received useful
      // content. Always prefer salvaging over retry — perturbation on a
      // retry would duplicate the partial text to the user, and partial
      // content is signal a provider-level retry cannot reproduce.
      if (streamedContent.length > 0 || streamedToolCalls.length > 0) {
        return {
          response: {
            content: streamedContent || null,
            toolCalls: streamedToolCalls,
            finishReason: "error",
            usage: streamedUsage,
            ...(streamedReasoningContent
              ? { reasoningContent: streamedReasoningContent }
              : {}),
          },
          attempt,
        };
      }

      if (attempt >= policy.maxRetries) {
        throw new LLMRetryError({
          reason: lastReason,
          attempts: attempt + 1,
          cause: err,
        });
      }
      // Retry on transient failures; surface "unknown" errors immediately —
      // an unclassified error usually means a bug in our code, not something
      // a retry can fix.
      if (lastReason === "unknown") {
        throw new LLMRetryError({
          reason: lastReason,
          attempts: attempt + 1,
          cause: err,
        });
      }
      onRetry?.({ attempt: attempt + 1, reason: lastReason, error: err });
    }
  }

  throw exhaustedError(policy, lastReason, lastError);
}

function classifyStreamError(
  err: unknown,
  signal: AbortSignal,
  firstTokenSeen: boolean,
): RetryReason {
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? "");
    const lower = msg.toLowerCase();
    if (lower.includes("first-token")) return "first-token-timeout";
    if (lower.includes("timeout"))
      return !firstTokenSeen ? "first-token-timeout" : "call-timeout";
  }
  if (isTransientError(err)) return "transient-error";
  return "unknown";
}
