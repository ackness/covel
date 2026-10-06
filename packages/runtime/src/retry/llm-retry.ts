import type { LLMProviderContinuation } from "@covel/shared";
import type { LLMProviderRequest } from "@covel/shared";
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
  LLMTargetIdentity,
  LLMToolCall,
  LLMToolDefinition,
} from "../llm/llm-adapter.js";
import {
  emitLlmCalling,
  emitLlmRespondedError,
  emitLlmRespondedSuccess,
} from "../llm/llm-telemetry.js";
import { AiProviderError } from "@covel/ai-provider";
import {
  assertLlmRequestBudget,
  awaitLlmRequest,
  createLlmRequestBudget,
  createLlmRequestScope,
  iterateLlmRequest,
  LLMRequestBudgetError,
  noteLlmRequestProgress,
  type LLMRequestBudget,
} from "@covel/shared";
import { TurnAbortedError } from "../turn-executor/turn-control.js";
import { acquireLLMSlot } from "./llm-slots.js";
import {
  LLMRetryError,
  assertDeadlineNotReached,
  computeAttemptBudget,
  computeDeadlineBudget,
  exhaustedError,
  extractMessage,
  isTransientError,
  isTerminalLlmRequestError,
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
  /** Session locale: retry hints and adapter instructions follow it. */
  readonly locale?: string;
  /** Hard per-attempt provider generation limit. */
  readonly maxOutputTokens?: number;
  readonly defaults?: import("@covel/shared").LLMRequestDefaults;
  readonly policy: RetryPolicy;
  /**
   * Called with the queue wait (ms) each time an attempt had to wait for an
   * LLM concurrency slot. The loop already extends its OWN deadline by the
   * wait; callers holding an enclosing deadline (the agent tool loop) use
   * this to extend theirs too — otherwise queue time still burns the loop
   * budget and a late step dies with its calls never attempted. The separate
   * logical request deadline stays fixed and includes time spent queued.
   */
  readonly onQueueWait?: (waitedMs: number) => void;
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
  /** Actual target, including gateway fallback, for response validation errors. */
  readonly onTargetAttempt?: (target: LLMTargetIdentity) => void;
  /** Emitter for llm.calling / llm.responded trace events. */
  readonly emitter?: import("../trace/turn-emitter.js").TurnEmitter;
  /** Identity for trace payload enrichment. */
  readonly runtimeId?: string;
  readonly pluginId?: string;
  /** Provider model resolved from `model`, which remains the requested slot. */
  readonly resolvedModel?: string;
  /** Provider label for trace payload (e.g. 'deepseek', 'openai'). Optional. */
  readonly provider?: string;
  /**
   * Player/turn-level abort. Non-retriable: fires
   * {@link TurnAbortedError} immediately — including after an adapter returns, so a player abort never commits content.
   */
  readonly abortSignal?: AbortSignal;
  /** Shared transport/time ceiling across every retry and fallback target. */
  readonly requestBudget?: LLMRequestBudget;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly reason: RetryReason;
  readonly error: unknown;
}

function createAttemptTrace(
  params: CallLLMWithRetryParams,
  messages: readonly LLMMessage[],
  attempt: number,
  startedAt: string,
  streaming = false,
  queueWaitMs?: number,
): {
  readonly onTargetAttempt: (target: LLMTargetIdentity) => void;
  readonly onProviderRequest: (request: LLMProviderRequest) => void;
  readonly ensureCalling: () => Promise<void>;
} {
  let target: LLMTargetIdentity | undefined =
    params.provider && params.resolvedModel
      ? { provider: params.provider, model: params.resolvedModel }
      : undefined;
  const providerRequests: LLMProviderRequest[] = [];
  let callingEmitted = false;
  return {
    onProviderRequest(request) {
      providerRequests.push(request);
    },
    onTargetAttempt(nextTarget) {
      target = nextTarget;
      params.onTargetAttempt?.(nextTarget);
    },
    async ensureCalling() {
      if (callingEmitted) return;
      callingEmitted = true;
      await emitLlmCalling(params.emitter, {
        runtimeId: params.runtimeId,
        pluginId: params.pluginId,
        slot: params.model,
        model: target?.model ?? params.resolvedModel ?? params.model,
        provider: target?.provider ?? params.provider,
        messages,
        responseFormat: params.responseFormat,
        defaults: params.defaults,
        maxOutputTokens: params.maxOutputTokens,
        providerRequests,
        tools: params.tools,
        attempt,
        queueWaitMs,
        startedAt,
        ...(streaming ? { streaming: true } : {}),
      });
    },
  };
}

export async function callLLMWithRetry(
  params: CallLLMWithRetryParams,
): Promise<LLMResponse> {
  const { llm, model, messages, tools, policy, deadline, onRetry } = params;
  let effectiveDeadline = deadline;
  let lastError: unknown = new Error("retry loop did not execute");
  let lastReason: RetryReason = "unknown";
  throwIfTurnAborted(params.abortSignal);
  assertDeadlineNotReached(effectiveDeadline, 0, lastError);
  const requestScope = createLlmRequestScope({
    budget: params.requestBudget ?? createLlmRequestBudget(),
    signal: params.abortSignal,
  });

  try {
    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
      throwIfTurnAborted(params.abortSignal);
      assertLlmRequestBudget(requestScope.budget, {
        signal: requestScope.signal,
        requireAttempt: true,
      });
      assertDeadlineNotReached(effectiveDeadline, attempt, lastError);
      // Queue before arming per-attempt timers. Queue time credits the runtime
      // deadline, while the logical request deadline remains a hard ceiling.
      const slot = await acquireLLMSlot(requestScope.signal).catch(
        (error: unknown) => {
          throwIfTurnAborted(params.abortSignal);
          throw error;
        },
      );
      if (params.abortSignal?.aborted) {
        slot.release();
        throwIfTurnAborted(params.abortSignal);
      }
      try {
        effectiveDeadline += slot.waitedMs;
        if (slot.waitedMs > 0) params.onQueueWait?.(slot.waitedMs);

        const budget = computeAttemptBudget(
          policy,
          Math.min(effectiveDeadline, requestScope.budget.deadline),
        );
        const timeoutSignal = AbortSignal.timeout(budget);
        const signal = AbortSignal.any([timeoutSignal, requestScope.signal]);
        const attemptMessages = perturbMessages(
          messages,
          attempt,
          lastReason,
          params.locale,
        );

        const callStart = Date.now();
        const trace = createAttemptTrace(
          params,
          attemptMessages,
          attempt,
          new Date(callStart).toISOString(),
          false,
          slot.waitedMs,
        );
        try {
          throwIfTurnAborted(params.abortSignal);
          const response = await awaitLlmRequest(
            llm.generate({
              model,
              messages: attemptMessages,
              tools,
              responseFormat: params.responseFormat,
              ...(params.locale ? { locale: params.locale } : {}),
              ...(params.defaults ? { defaults: params.defaults } : {}),
              ...(params.maxOutputTokens !== undefined
                ? { maxOutputTokens: params.maxOutputTokens }
                : {}),
              signal,
              requestBudget: requestScope.budget,
              onTargetAttempt: trace.onTargetAttempt,
              ...(params.emitter
                ? { onProviderRequest: trace.onProviderRequest }
                : {}),
            }),
            signal,
          );
          throwIfTurnAborted(params.abortSignal);
          if (response.finishReason === "error") {
            throw new Error(
              "PROVIDER_ERROR: model generation ended with an error",
            );
          }
          await trace.ensureCalling();
          await emitLlmRespondedSuccess(params.emitter, {
            runtimeId: params.runtimeId,
            pluginId: params.pluginId,
            response,
            durationMs: Date.now() - callStart,
            attempt,
          });
          return response;
        } catch (err) {
          await trace.ensureCalling();
          await emitLlmRespondedError(params.emitter, {
            runtimeId: params.runtimeId,
            pluginId: params.pluginId,
            error: err,
            durationMs: Date.now() - callStart,
            attempt,
          });
          throwIfTurnAborted(params.abortSignal);
          requestScope.signal.throwIfAborted();
          if (isTerminalLlmRequestError(err)) throw err;
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
          assertLlmRequestBudget(requestScope.budget, {
            signal: requestScope.signal,
            requireAttempt: true,
          });
          onRetry?.({ attempt: attempt + 1, reason: lastReason, error: err });
        }
      } finally {
        slot.release();
      }
    }

    // Unreachable; the loop either returns or throws.
    throw exhaustedError(policy, lastReason, lastError);
  } finally {
    requestScope.dispose();
  }
}

function throwIfTurnAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new TurnAbortedError();
  }
}

function isCallTimeout(err: unknown, signal: AbortSignal): boolean {
  if (
    err instanceof LLMRequestBudgetError ||
    (err instanceof AiProviderError &&
      (err.code === "REQUEST_BUDGET_EXCEEDED" || err.code === "REFUSAL"))
  )
    return false;
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? "");
    if (msg.toLowerCase().includes("timeout")) return true;
  }
  // Provider classifications remain authoritative when our own deadline did
  // not fire; e.g. a 400 mentioning an invalid timeout option is not a timeout.
  if (err instanceof AiProviderError) return false;
  const text = extractMessage(err).toLowerCase();
  return text.includes("timeout") || text.includes("timed out");
}

// ── Streaming retry (with first-token guard) ────────────────────────

export interface StreamLLMWithRetryParams extends CallLLMWithRetryParams {
  /** Optional sink for text deltas so streaming can keep its UX. */
  readonly onDelta?: (delta: string) => void | Promise<void>;
  /**
   * Called with the time (ms) a completed stream spent delivering output. The
   * loop extends its OWN deadline by it, and a caller holding an enclosing
   * deadline (the agent tool loop) extends its deadline too: a model that
   * keeps writing does not spend the runtime's time. Silence still does.
   */
  readonly onStreamTime?: (streamedMs: number) => void;
}

export interface StreamLLMResult {
  readonly response: LLMResponse;
  readonly attempt: number;
}

/**
 * Drive a streaming LLM call limited by silence: a first-token (TTFB) guard
 * until the model writes, then an idle guard between its outputs. There is no
 * limit on the total time of a stream that keeps writing; the request budget's
 * ceiling ends a model that never stops. Returns the fully reassembled
 * response once the stream completes.
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
  let effectiveDeadline = deadline;
  if (!llm.stream) {
    // No streaming support — fall back to non-streaming retry so callers can
    // use the same entrypoint uniformly.
    const response = await callLLMWithRetry(params);
    return { response, attempt: 0 };
  }

  let lastError: unknown = new Error("stream retry loop did not execute");
  let lastReason: RetryReason = "unknown";
  throwIfTurnAborted(params.abortSignal);
  assertDeadlineNotReached(effectiveDeadline, 0, lastError);
  const requestScope = createLlmRequestScope({
    budget: params.requestBudget ?? createLlmRequestBudget(),
    signal: params.abortSignal,
  });

  try {
    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
      throwIfTurnAborted(params.abortSignal);
      assertLlmRequestBudget(requestScope.budget, {
        signal: requestScope.signal,
        requireAttempt: true,
      });
      assertDeadlineNotReached(effectiveDeadline, attempt, lastError);
      // Queue before arming per-attempt timers. Queue time credits the runtime
      // deadline, while the logical request deadline remains a hard ceiling.
      const slot = await acquireLLMSlot(requestScope.signal).catch(
        (error: unknown) => {
          throwIfTurnAborted(params.abortSignal);
          throw error;
        },
      );
      if (params.abortSignal?.aborted) {
        slot.release();
        throwIfTurnAborted(params.abortSignal);
      }
      try {
        effectiveDeadline += slot.waitedMs;
        if (slot.waitedMs > 0) params.onQueueWait?.(slot.waitedMs);

        // `callTimeoutMs` is the total limit of a non-streaming call. A stream
        // reports its progress, so only the runtime deadline bounds the wait
        // for its first output.
        const budget = computeDeadlineBudget(
          Math.min(effectiveDeadline, requestScope.budget.deadline),
        );
        // Compose four abort sources into one per-attempt signal:
        //   1. runtime deadline — armed on attempt start, disarmed on first output
        //   2. first-token (TTFB) guard — armed on attempt start, disarmed on first output
        //   3. idle guard — armed on first output, restarted by every output
        //   4. player turn abort — forwarded from params.abortSignal below
        const callAborter = new AbortController();
        const onExternalAbort = (): void => {
          callAborter.abort(requestScope.signal.reason);
        };
        requestScope.signal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
        const callTimeoutHandle = setTimeout(() => {
          callAborter.abort(new DOMException("call timeout", "TimeoutError"));
        }, budget);
        const armFirstTokenGuard = () =>
          setTimeout(() => {
            if (!firstTokenSeen) {
              callAborter.abort(
                new DOMException("first-token timeout", "TimeoutError"),
              );
            }
          }, policy.firstTokenTimeoutMs);
        let ttfbHandle = armFirstTokenGuard();
        // A rate-limited or failed transport attempt is followed by a backoff
        // the provider asked for (`retry-after`); the model has not been asked
        // yet, so the guard pauses and restarts when a later attempt is
        // answered. The call timeout still bounds the whole wait.
        let firstTokenGuardPaused = false;
        const onProviderRequest = (request: LLMProviderRequest): void => {
          trace.onProviderRequest(request);
          if (firstTokenSeen) return;
          if (request.failed || (request.statusCode ?? 200) >= 400) {
            clearTimeout(ttfbHandle);
            firstTokenGuardPaused = true;
          } else if (firstTokenGuardPaused) {
            firstTokenGuardPaused = false;
            ttfbHandle = armFirstTokenGuard();
          }
        };

        let firstTokenSeen = false;
        let firstOutputAt: number | undefined;
        let idleHandle: ReturnType<typeof setTimeout> | undefined;
        const noteOutput = (): void => {
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            firstOutputAt = Date.now();
            clearTimeout(callTimeoutHandle);
            clearTimeout(ttfbHandle);
          }
          noteLlmRequestProgress(requestScope.budget);
          clearTimeout(idleHandle);
          idleHandle = setTimeout(() => {
            callAborter.abort(
              new DOMException(
                `idle timeout: no model output for ${Math.round(policy.idleTimeoutMs / 1000)}s`,
                "TimeoutError",
              ),
            );
          }, policy.idleTimeoutMs);
        };
        const streamedToolCalls: LLMToolCall[] = [];
        let streamedContent = "";
        let streamedReasoningContent = "";
        let providerContinuation: LLMProviderContinuation | undefined;
        let diagnostics: LLMResponse["diagnostics"];
        let streamedUsage = { inputTokens: 0, outputTokens: 0 };
        let streamFinishReason:
          "stop" | "tool_calls" | "length" | "error" | undefined;
        const attemptMessages = perturbMessages(
          messages,
          attempt,
          lastReason,
          params.locale,
        );
        const forwardDeltas = attempt === 0; // avoid duplicate text on retry
        const streamStart = Date.now();
        const trace = createAttemptTrace(
          params,
          attemptMessages,
          attempt,
          new Date(streamStart).toISOString(),
          true,
          slot.waitedMs,
        );

        try {
          throwIfTurnAborted(params.abortSignal);
          requestScope.signal.throwIfAborted();
          for await (const event of iterateLlmRequest(
            llm.stream({
              model,
              messages: attemptMessages,
              tools,
              responseFormat: params.responseFormat,
              ...(params.locale ? { locale: params.locale } : {}),
              ...(params.defaults ? { defaults: params.defaults } : {}),
              ...(params.maxOutputTokens !== undefined
                ? { maxOutputTokens: params.maxOutputTokens }
                : {}),
              signal: callAborter.signal,
              requestBudget: requestScope.budget,
              onTargetAttempt: trace.onTargetAttempt,
              onProviderRequest,
            }),
            callAborter.signal,
          )) {
            if (event.type === "text-delta") {
              if (event.textDelta.length > 0) noteOutput();
              streamedContent += event.textDelta;
              if (event.textDelta.length > 0) {
                await trace.ensureCalling();
                if (forwardDeltas) await onDelta?.(event.textDelta);
              }
            } else if (event.type === "reasoning-delta") {
              if (event.reasoningDelta.length > 0) noteOutput();
              streamedReasoningContent += event.reasoningDelta;
            } else if (event.type === "tool-call") {
              noteOutput();
              await trace.ensureCalling();
              streamedToolCalls.push({
                id: event.id,
                name: event.name,
                arguments: event.arguments,
              });
            } else if (event.type === "done") {
              await trace.ensureCalling();
              streamFinishReason = event.finishReason as
                "stop" | "tool_calls" | "length" | "error";
              if (streamFinishReason === "error") {
                throw new Error(
                  "PROVIDER_ERROR: model stream ended with an error",
                );
              }
              if (event.reasoningContent)
                streamedReasoningContent = event.reasoningContent;
              if (event.usage) streamedUsage = event.usage;
              if (event.providerContinuation)
                providerContinuation = event.providerContinuation;
              if (event.diagnostics) diagnostics = event.diagnostics;
            }
          }

          throwIfTurnAborted(params.abortSignal);
          if (streamFinishReason === undefined) {
            throw new Error(
              "PROVIDER_ERROR: model stream ended without a terminal event",
            );
          }
          clearTimeout(callTimeoutHandle);
          clearTimeout(ttfbHandle);
          clearTimeout(idleHandle);
          requestScope.signal.removeEventListener("abort", onExternalAbort);
          if (firstOutputAt !== undefined) {
            const streamedMs = Date.now() - firstOutputAt;
            effectiveDeadline += streamedMs;
            if (streamedMs > 0) params.onStreamTime?.(streamedMs);
          }
          await trace.ensureCalling();

          const finalResponse: LLMResponse = {
            content: streamedContent || null,
            toolCalls: streamedToolCalls,
            finishReason: streamFinishReason,
            usage: streamedUsage,
            ...(diagnostics ? { diagnostics } : {}),
            ...(providerContinuation ? { providerContinuation } : {}),
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
          clearTimeout(idleHandle);
          requestScope.signal.removeEventListener("abort", onExternalAbort);
          lastError = err;
          lastReason = classifyStreamError(
            err,
            callAborter.signal,
            firstTokenSeen,
          );

          // Pair every `llm.calling` with an `llm.responded` on the error path.
          // Without this, a streamed turn that fails mid-flight leaves a dangling
          // `llm.calling` in trace_events and breaks trace-viewer pairing. This
          // must run BEFORE the abort throw below so a player abort still emits
          // the paired `llm.responded`.
          await trace.ensureCalling();
          await emitLlmRespondedError(params.emitter, {
            runtimeId: params.runtimeId,
            pluginId: params.pluginId,
            error: err,
            durationMs: Date.now() - streamStart,
            attempt,
            streaming: true,
          });

          // Partial output must never become a successful response or be spliced
          // into a retry. Empty transient failures retain the normal retry policy.
          throwIfTurnAborted(params.abortSignal);
          requestScope.signal.throwIfAborted();
          if (isTerminalLlmRequestError(err)) throw err;
          if (firstTokenSeen) {
            throw new LLMRetryError({
              reason: lastReason,
              attempts: attempt + 1,
              cause: err,
              hasPartialOutput: true,
            });
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
          assertLlmRequestBudget(requestScope.budget, {
            signal: requestScope.signal,
            requireAttempt: true,
          });
          onRetry?.({ attempt: attempt + 1, reason: lastReason, error: err });
        }
      } finally {
        slot.release();
      }
    }

    throw exhaustedError(policy, lastReason, lastError);
  } finally {
    requestScope.dispose();
  }
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
    if (lower.includes("idle timeout")) return "idle-timeout";
    if (lower.includes("timeout"))
      return !firstTokenSeen ? "first-token-timeout" : "call-timeout";
  }
  if (isTransientError(err)) return "transient-error";
  return "unknown";
}
