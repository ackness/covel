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
} from './llm-adapter.js';
import {
  buildLlmCallingPayload,
  buildLlmRespondedErrorPayload,
  buildLlmRespondedSuccessPayload,
} from './llm-trace-payload.js';

// ── Config ──────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Total retries (not including the first attempt). */
  readonly maxRetries: number;
  /** Per-call total timeout in ms. */
  readonly callTimeoutMs: number;
  /** Streaming first-token timeout in ms. */
  readonly firstTokenTimeoutMs: number;
  /** Tool-loop threshold (0 disables detection). */
  readonly loopDetectionThreshold: number;
}

/** Default threshold constants, also exported so tests can align. */
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30_000;
export const DEFAULT_LOOP_THRESHOLD = 3;
export const DEFAULT_CALL_TIMEOUT_CAP_MS = 60_000;
export const MIN_CALL_TIMEOUT_MS = 5_000;

/**
 * Derive a retry policy from manifest fields. The defaults split the
 * runtime budget across (maxRetries + 1) attempts, capped at
 * {@link DEFAULT_CALL_TIMEOUT_CAP_MS} so a single attempt never monopolises
 * a very large budget.
 */
export function buildRetryPolicy(input: {
  maxRetries?: number;
  callTimeoutMs?: number;
  firstTokenTimeoutMs?: number;
  loopDetectionThreshold?: number;
  runtimeTimeoutMs: number;
}): RetryPolicy {
  const maxRetries = clamp(input.maxRetries ?? DEFAULT_MAX_RETRIES, 0, 5);
  const perAttemptShare = Math.floor(input.runtimeTimeoutMs / (maxRetries + 1));
  // Derived default is capped by DEFAULT_CALL_TIMEOUT_CAP_MS and floored by
  // MIN_CALL_TIMEOUT_MS so small budgets stay usable. An explicit user value
  // is honoured verbatim (minimum 1ms) — the caller may need very short
  // timeouts for tests or ultra-fast health probes.
  const derivedCall = Math.max(MIN_CALL_TIMEOUT_MS, Math.min(DEFAULT_CALL_TIMEOUT_CAP_MS, perAttemptShare));
  const callTimeoutMs = input.callTimeoutMs !== undefined
    ? Math.max(1, input.callTimeoutMs)
    : derivedCall;
  const firstTokenTimeoutMs = Math.max(
    1_000,
    input.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  );
  const loopDetectionThreshold = Math.max(
    0,
    input.loopDetectionThreshold ?? DEFAULT_LOOP_THRESHOLD,
  );
  return { maxRetries, callTimeoutMs, firstTokenTimeoutMs, loopDetectionThreshold };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Error classification ────────────────────────────────────────────

/** Internal marker so turn-executor can tell "retry exhausted" apart. */
export class LLMRetryError extends Error {
  readonly cause: unknown;
  readonly reason: RetryReason;
  readonly attempts: number;
  constructor(args: { reason: RetryReason; attempts: number; cause: unknown; message?: string }) {
    // Surface the underlying cause message in the wrapper error so test
    // assertions (and user-facing traces) can still match on provider
    // keywords like "rate limited" or "fetch failed" without having to
    // unwrap `.cause`.
    const causeMsg = extractMessage(args.cause);
    const base = `LLM retry exhausted after ${args.attempts} attempt(s) (${args.reason})`;
    super(args.message ?? (causeMsg ? `${base}: ${causeMsg}` : base));
    this.name = 'LLMRetryError';
    this.reason = args.reason;
    this.attempts = args.attempts;
    this.cause = args.cause;
  }
}

export type RetryReason =
  | 'first-token-timeout'
  | 'call-timeout'
  | 'transient-error'
  | 'tool-loop-detected'
  | 'unknown';

/**
 * Decide whether an error is worth retrying. Errs on the side of retry for
 * timeouts / network / 5xx; never retries client-side (4xx) or schema
 * violations (those will fail identically on retry).
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof LLMRetryError) return true;
  const msg = extractMessage(err).toLowerCase();

  // Abort / timeout variants across Node, undici, browser fetch.
  if (msg.includes('abort') || msg.includes('timeout') || msg.includes('timed out')) {
    return true;
  }
  // Network / connection errors.
  if (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  ) {
    return true;
  }
  // Provider error payloads that bubble through ai-provider's gateway.
  // gateway.ts:normalizeError() stringifies retriable flag + statusCode.
  if (msg.includes('rate_limited') || msg.includes('rate limit')) return true;
  if (msg.includes('provider_error')) return true;
  // 5xx upstream.
  const statusMatch = msg.match(/\bhttp (\d{3})\b/);
  if (statusMatch) {
    const code = Number.parseInt(statusMatch[1], 10);
    if (code >= 500 && code < 600) return true;
  }
  return false;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

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
  return tail.every((c) => c.name === first.name && c.arguments === first.arguments);
}

// ── Perturbation ────────────────────────────────────────────────────

/**
 * Append a tiny retry hint to break deterministic KV-cache hits. The hint
 * is a `system` message so it does not leak into assistant output; the
 * trailing spaces scale with the attempt number to guarantee a unique byte
 * string per retry even when the provider has aggressive caching.
 *
 * Attempt 0 is the first attempt and produces no perturbation — only the
 * second attempt onward injects a hint.
 */
export function perturbMessages(
  messages: readonly LLMMessage[],
  attempt: number,
  reason?: RetryReason,
): readonly LLMMessage[] {
  if (attempt <= 0) return messages;
  const padding = ' '.repeat(attempt);
  const hint =
    reason === 'tool-loop-detected'
      ? `[retry ${attempt}] The previous attempt called the same tool repeatedly. Vary your approach or finish with runtime-done.${padding}`
      : `[retry ${attempt}] The previous attempt did not complete. Produce a concise reply; call runtime-done when finished.${padding}`;
  return [...messages, { role: 'system' as const, content: hint }];
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
  readonly emitter?: import('./turn-emitter.js').TurnEmitter;
  /** Identity for trace payload enrichment. */
  readonly runtimeId?: string;
  readonly pluginId?: string;
  /** Provider label for trace payload (e.g. 'deepseek', 'openai'). Optional. */
  readonly provider?: string;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly reason: RetryReason;
  readonly error: unknown;
}

export async function callLLMWithRetry(params: CallLLMWithRetryParams): Promise<LLMResponse> {
  const { llm, model, messages, tools, policy, deadline, onRetry } = params;
  let lastError: unknown = new Error('retry loop did not execute');
  let lastReason: RetryReason = 'unknown';

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (Date.now() >= deadline) {
      throw new LLMRetryError({
        reason: 'call-timeout',
        attempts: attempt,
        cause: lastError,
        message: 'Runtime deadline reached before LLM call could be attempted',
      });
    }

    const budget = Math.min(policy.callTimeoutMs, Math.max(1_000, deadline - Date.now()));
    const signal = AbortSignal.timeout(budget);
    const attemptMessages = perturbMessages(messages, attempt, lastReason);

    const callStart = Date.now();
    try {
      if (params.emitter) {
        await params.emitter.emit('llm.calling', buildLlmCallingPayload({
          runtimeId: params.runtimeId,
          pluginId: params.pluginId,
          slot: params.model,
          model: params.model,
          provider: params.provider,
          messages: attemptMessages,
          tools: params.tools,
          attempt,
        }));
      }
      const response = await llm.generate({
        model,
        messages: attemptMessages,
        tools,
        responseFormat: params.responseFormat,
        signal,
      });
      if (params.emitter) {
        await params.emitter.emit('llm.responded', buildLlmRespondedSuccessPayload({
          runtimeId: params.runtimeId,
          pluginId: params.pluginId,
          response,
          durationMs: Date.now() - callStart,
          attempt,
        }));
      }
      return response;
    } catch (err) {
      if (params.emitter) {
        await params.emitter.emit('llm.responded', buildLlmRespondedErrorPayload({
          runtimeId: params.runtimeId,
          pluginId: params.pluginId,
          error: err,
          durationMs: Date.now() - callStart,
          attempt,
        }));
      }
      lastError = err;
      lastReason = isCallTimeout(err, signal) ? 'call-timeout' : isTransientError(err) ? 'transient-error' : 'unknown';
      if (attempt >= policy.maxRetries || lastReason === 'unknown') {
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
  throw new LLMRetryError({ reason: lastReason, attempts: policy.maxRetries + 1, cause: lastError });
}

function isCallTimeout(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? '');
    if (msg.toLowerCase().includes('timeout')) return true;
  }
  const text = extractMessage(err).toLowerCase();
  return text.includes('timeout') || text.includes('timed out');
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
  const { llm, model, messages, tools, policy, deadline, onDelta, onRetry } = params;
  if (!llm.stream) {
    // No streaming support — fall back to non-streaming retry so callers can
    // use the same entrypoint uniformly.
    const response = await callLLMWithRetry(params);
    return { response, attempt: 0 };
  }

  let lastError: unknown = new Error('stream retry loop did not execute');
  let lastReason: RetryReason = 'unknown';

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (Date.now() >= deadline) {
      throw new LLMRetryError({
        reason: 'call-timeout',
        attempts: attempt,
        cause: lastError,
        message: 'Runtime deadline reached before LLM call could be attempted',
      });
    }

    const budget = Math.min(policy.callTimeoutMs, Math.max(1_000, deadline - Date.now()));
    // Compose three abort sources into one per-attempt signal:
    //   1. overall call budget (per-attempt)
    //   2. first-token (TTFB) guard — armed on attempt start, disarmed on first event
    //   3. cancellation from the outer caller (none today, but easy to add)
    const callAborter = new AbortController();
    const callTimeoutHandle = setTimeout(() => {
      callAborter.abort(new DOMException('call timeout', 'TimeoutError'));
    }, budget);
    const ttfbHandle = setTimeout(() => {
      if (!firstTokenSeen) {
        callAborter.abort(new DOMException('first-token timeout', 'TimeoutError'));
      }
    }, policy.firstTokenTimeoutMs);

    let firstTokenSeen = false;
    const streamedToolCalls: LLMToolCall[] = [];
    let streamedContent = '';
    let streamedReasoningContent = '';
    let streamFinishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    const attemptMessages = perturbMessages(messages, attempt, lastReason);
    const forwardDeltas = attempt === 0; // avoid duplicate text on retry
    const streamStart = Date.now();
    if (params.emitter) {
      await params.emitter.emit('llm.calling', buildLlmCallingPayload({
        runtimeId: params.runtimeId,
        pluginId: params.pluginId,
        slot: params.model,
        model: params.model,
        provider: params.provider,
        messages: attemptMessages,
        tools: params.tools,
        attempt,
        streaming: true,
      }));
    }

    try {
      for await (const event of llm.stream({
        model,
        messages: attemptMessages,
        tools,
        signal: callAborter.signal,
      })) {
        if (event.type === 'text-delta') {
          firstTokenSeen = true;
          streamedContent += event.textDelta;
          if (forwardDeltas) await onDelta?.(event.textDelta);
        } else if (event.type === 'tool-call') {
          firstTokenSeen = true;
          streamedToolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        } else if (event.type === 'done') {
          streamFinishReason = event.finishReason as 'stop' | 'tool_calls' | 'length' | 'error';
          if (event.reasoningContent) streamedReasoningContent = event.reasoningContent;
        }
      }

      clearTimeout(callTimeoutHandle);
      clearTimeout(ttfbHandle);

      const finalResponse: LLMResponse = {
        content: streamedContent || null,
        toolCalls: streamedToolCalls,
        finishReason: streamFinishReason,
        usage: { inputTokens: 0, outputTokens: 0 },
        ...(streamedReasoningContent ? { reasoningContent: streamedReasoningContent } : {}),
      };
      if (params.emitter) {
        await params.emitter.emit('llm.responded', buildLlmRespondedSuccessPayload({
          runtimeId: params.runtimeId,
          pluginId: params.pluginId,
          response: finalResponse,
          durationMs: Date.now() - streamStart,
          attempt,
          streaming: true,
        }));
      }
      return {
        response: finalResponse,
        attempt,
      };
    } catch (err) {
      clearTimeout(callTimeoutHandle);
      clearTimeout(ttfbHandle);
      lastError = err;
      lastReason = classifyStreamError(err, callAborter.signal, firstTokenSeen);

      // Pair every `llm.calling` with an `llm.responded` on the error path.
      // Without this, a streamed turn that fails mid-flight leaves a dangling
      // `llm.calling` in trace_events and breaks trace-viewer pairing.
      if (params.emitter) {
        await params.emitter.emit('llm.responded', buildLlmRespondedErrorPayload({
          runtimeId: params.runtimeId,
          pluginId: params.pluginId,
          error: err,
          durationMs: Date.now() - streamStart,
          attempt,
          streaming: true,
        }));
      }

      // Salvage path: stream died mid-flight but we already received useful
      // content. Always prefer salvaging over retry — perturbation on a
      // retry would duplicate the partial text to the user, and partial
      // content is signal a provider-level retry cannot reproduce.
      if (streamedContent.length > 0 || streamedToolCalls.length > 0) {
        return {
          response: {
            content: streamedContent || null,
            toolCalls: streamedToolCalls,
            finishReason: 'error',
            usage: { inputTokens: 0, outputTokens: 0 },
            ...(streamedReasoningContent ? { reasoningContent: streamedReasoningContent } : {}),
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
      if (lastReason === 'unknown') {
        throw new LLMRetryError({
          reason: lastReason,
          attempts: attempt + 1,
          cause: err,
        });
      }
      onRetry?.({ attempt: attempt + 1, reason: lastReason, error: err });
    }
  }

  throw new LLMRetryError({
    reason: lastReason,
    attempts: policy.maxRetries + 1,
    cause: lastError,
  });
}

function classifyStreamError(err: unknown, signal: AbortSignal, firstTokenSeen: boolean): RetryReason {
  if (signal.aborted) {
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? '');
    const lower = msg.toLowerCase();
    if (lower.includes('first-token')) return 'first-token-timeout';
    if (lower.includes('timeout')) return !firstTokenSeen ? 'first-token-timeout' : 'call-timeout';
  }
  if (isTransientError(err)) return 'transient-error';
  return 'unknown';
}
