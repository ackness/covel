/**
 * Shared primitives for the non-streaming and streaming LLM retry loops in
 * `llm-retry.ts`.
 *
 * Both loops share: the retry policy shape + defaults, the {@link LLMRetryError}
 * marker, error classification, message perturbation, a per-attempt deadline
 * guard, and per-attempt budget computation. Centralising them here keeps the
 * two paths in `llm-retry.ts` focused on their transport differences (one-shot
 * generate vs SSE stream). `llm-retry.ts` re-exports these so existing import
 * sites stay unchanged.
 */

import { AiProviderError } from "@covel/ai-provider";
import { instructionLocaleFor, LLMRequestBudgetError } from "@covel/shared";
import type { LLMMessage } from "../llm/llm-adapter.js";

// ── Config ──────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Total retries (not including the first attempt). */
  readonly maxRetries: number;
  /** Per-call total timeout in ms. */
  readonly callTimeoutMs: number;
  /**
   * Longest wait for the first output of a streamed call, in ms. The wait of
   * one attempt is shorter when the runtime's remaining time has to cover
   * later attempts too; see {@link firstTokenWaitMs}.
   */
  readonly firstTokenTimeoutMs: number;
  /** The author set `firstTokenTimeoutMs`: every attempt waits exactly that long. */
  readonly firstTokenTimeoutFixed: boolean;
  /** Longest silence of a stream that has started to write, in ms. */
  readonly idleTimeoutMs: number;
  /** Tool-loop threshold (0 disables detection). */
  readonly loopDetectionThreshold: number;
}

/** Default threshold constants, also exported so tests can align. */
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_LOOP_THRESHOLD = 3;
const DEFAULT_CALL_TIMEOUT_CAP_MS = 60_000;
const MIN_CALL_TIMEOUT_MS = 5_000;

/** Minimum per-attempt budget floor (ms). */
const MIN_ATTEMPT_BUDGET_MS = 1_000;
/**
 * What an attempt that can be repeated may wait for a silent model when its
 * equal share of the remaining time is shorter. Most models that answer at
 * all start within this time.
 */
const STALL_WAIT_FLOOR_MS = 60_000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

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
  idleTimeoutMs?: number;
  loopDetectionThreshold?: number;
  runtimeTimeoutMs: number;
}): RetryPolicy {
  const maxRetries = clamp(input.maxRetries ?? DEFAULT_MAX_RETRIES, 0, 5);
  const perAttemptShare = Math.floor(input.runtimeTimeoutMs / (maxRetries + 1));
  // Derived default is capped by DEFAULT_CALL_TIMEOUT_CAP_MS and floored by
  // MIN_CALL_TIMEOUT_MS so small budgets stay usable. An explicit user value
  // is honoured verbatim (minimum 1ms) — the caller may need very short
  // timeouts for tests or ultra-fast health probes.
  const derivedCall = Math.max(
    MIN_CALL_TIMEOUT_MS,
    Math.min(DEFAULT_CALL_TIMEOUT_CAP_MS, perAttemptShare),
  );
  const callTimeoutMs =
    input.callTimeoutMs !== undefined
      ? Math.max(1, input.callTimeoutMs)
      : derivedCall;
  const firstTokenTimeoutMs = Math.max(
    1_000,
    input.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  );
  const idleTimeoutMs = Math.max(
    1_000,
    input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  );
  const loopDetectionThreshold = Math.max(
    0,
    input.loopDetectionThreshold ?? DEFAULT_LOOP_THRESHOLD,
  );
  return {
    maxRetries,
    callTimeoutMs,
    firstTokenTimeoutMs,
    firstTokenTimeoutFixed: input.firstTokenTimeoutMs !== undefined,
    idleTimeoutMs,
    loopDetectionThreshold,
  };
}

/**
 * How long one attempt may wait for a model that sends nothing, so that the
 * attempts after it still fit into `remainingMs`.
 *
 * The last attempt may use all that is left. An earlier one gets its equal
 * share, or {@link STALL_WAIT_FLOOR_MS} when the share is shorter, but never
 * more than half of what is left: a stalled attempt always leaves room for
 * the next one. With 120s and four attempts the waits are 60s, 30s, 15s, 15s.
 */
export function stallWaitMs(remainingMs: number, attemptsLeft: number): number {
  if (attemptsLeft <= 1) return remainingMs;
  return Math.max(
    remainingMs / attemptsLeft,
    Math.min(STALL_WAIT_FLOOR_MS, remainingMs / 2),
  );
}

/**
 * The first-token wait of one streamed attempt. A value the author set is
 * used as written. The default is the policy's limit, shortened to what
 * {@link stallWaitMs} leaves for the attempts that may follow.
 */
export function firstTokenWaitMs(
  policy: RetryPolicy,
  attemptsLeft: number,
  remainingMs: number,
): number {
  if (policy.firstTokenTimeoutFixed) return policy.firstTokenTimeoutMs;
  return Math.max(
    MIN_ATTEMPT_BUDGET_MS,
    Math.min(
      policy.firstTokenTimeoutMs,
      Math.floor(stallWaitMs(remainingMs, attemptsLeft)),
    ),
  );
}

// ── Error classification ────────────────────────────────────────────

export type RetryReason =
  | "first-token-timeout"
  | "idle-timeout"
  | "call-timeout"
  | "transient-error"
  | "tool-loop-detected"
  | "output-truncated"
  | "unknown";

/** Internal marker so turn-executor can tell "retry exhausted" apart. */
export class LLMRetryError extends Error {
  override readonly cause: unknown;
  readonly reason: RetryReason;
  readonly attempts: number;
  /** A failed stream produced output; retry/fallback must not replace it. */
  readonly hasPartialOutput: boolean;
  constructor(args: {
    reason: RetryReason;
    attempts: number;
    cause: unknown;
    message?: string;
    hasPartialOutput?: boolean;
  }) {
    // Surface the underlying cause message in the wrapper error so test
    // assertions (and user-facing traces) can still match on provider
    // keywords like "rate limited" or "fetch failed" without having to
    // unwrap `.cause`.
    const causeMsg = extractMessage(args.cause);
    const base = `LLM retry exhausted after ${args.attempts} attempt(s) (${args.reason})`;
    super(args.message ?? (causeMsg ? `${base}: ${causeMsg}` : base));
    this.name = "LLMRetryError";
    this.reason = args.reason;
    this.attempts = args.attempts;
    this.cause = args.cause;
    this.hasPartialOutput = args.hasPartialOutput ?? false;
  }
}

const TRANSIENT_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * What the fields of an error from outside the gateway say: the AI SDK's
 * `isRetryable` and `statusCode`, the official SDKs' `status`, the platform's
 * error names and Node's transport codes. Undefined when it has none of them.
 */
function structuredTransience(err: unknown): boolean | undefined {
  if (!(err instanceof Error)) return undefined;
  const fields = err as Error & {
    isRetryable?: unknown;
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
  };
  if (typeof fields.isRetryable === "boolean") return fields.isRetryable;
  const status =
    typeof fields.statusCode === "number" ? fields.statusCode : fields.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  if (TRANSIENT_ERROR_NAMES.has(err.name)) return true;
  if (typeof fields.code === "string" && TRANSIENT_ERROR_CODES.has(fields.code))
    return true;
  return undefined;
}

/**
 * Decide whether an error is worth retrying. Errs on the side of retry for
 * timeouts / network / 5xx; never retries client-side (4xx) or schema
 * violations (those will fail identically on retry).
 */
export function isTransientError(err: unknown): boolean {
  if (isTerminalLlmRequestError(err)) return false;
  if (err instanceof LLMRetryError)
    return !isTerminalLlmRequestError(err.cause);
  if (err instanceof AiProviderError) {
    if (
      err.code === "CONFIG_ERROR" ||
      err.code === "SCHEMA_VALIDATION_FAILED" ||
      err.code === "REFUSAL" ||
      err.code === "REQUEST_BUDGET_EXCEEDED"
    ) {
      return false;
    }
    if (err.statusCode === 429) return true;
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return false;
    }
    return err.code === "RATE_LIMITED" || err.retriable;
  }

  const structured = structuredTransience(err);
  if (structured !== undefined) return structured;

  // Fallback: an adapter outside the gateway may expose only a message.
  // Gateway errors above retain their structured classification even if their
  // prose contains words such as "network" or omits recognizable rate-limit
  // wording.
  const msg = extractMessage(err).toLowerCase();

  // Abort / timeout variants across Node, undici, browser fetch.
  if (
    msg.includes("abort") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  ) {
    return true;
  }
  // Network / connection errors.
  if (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  ) {
    return true;
  }
  // Unstructured provider errors from third-party adapters.
  if (msg.includes("rate_limited") || msg.includes("rate limit")) return true;
  if (msg.includes("provider_error")) return true;
  // 5xx upstream.
  const statusMatch = msg.match(/\bhttp (\d{3})\b/);
  if (statusMatch) {
    const code = Number.parseInt(statusMatch[1]!, 10);
    if (code >= 500 && code < 600) return true;
  }
  return false;
}

/**
 * Whether a stream that failed without output may be repeated as a non-stream
 * call. An error with no structure still may (an endpoint whose streaming is
 * broken can answer a plain call); a provider error that says the request
 * itself is refused (401, 400, a config or schema error) would fail the same
 * way again, wherever it sits in the cause chain.
 */
export function isStreamRecoveryAllowed(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (isTerminalLlmRequestError(cause)) return false;
    if (cause instanceof AiProviderError && !isTransientError(cause))
      return false;
    cause = cause.cause;
  }
  return true;
}

/** The model ran past its output limit before the response was usable. */
export function isOutputTruncated(err: unknown): boolean {
  return (
    err instanceof AiProviderError && err.details?.finishReason === "length"
  );
}

/** These logical outcomes must never enter a fresh retry or recovery budget. */
export function isTerminalLlmRequestError(error: unknown): boolean {
  return (
    error instanceof LLMRequestBudgetError ||
    (error instanceof AiProviderError &&
      (error.code === "REFUSAL" || error.code === "REQUEST_BUDGET_EXCEEDED"))
  );
}

export function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ── Perturbation ────────────────────────────────────────────────────

/**
 * Append a tiny retry hint to break deterministic KV-cache hits. The hint
 * is a `system` message so it does not leak into assistant output; the
 * trailing spaces scale with the attempt number to guarantee a unique byte
 * string per retry even when the provider has aggressive caching.
 *
 * Attempt 0 is the first attempt and produces no perturbation — only the
 * second attempt onward injects a hint. The hint is in the instruction
 * language of the session locale.
 */
export function perturbMessages(
  messages: readonly LLMMessage[],
  attempt: number,
  reason?: RetryReason,
  locale?: string,
): readonly LLMMessage[] {
  if (attempt <= 0) return messages;
  const content = retryHint(attempt, reason, locale);
  return [...messages, { role: "system" as const, content }];
}

/** The text of the hint {@link perturbMessages} appends. */
export function retryHint(
  attempt: number,
  reason?: RetryReason,
  locale?: string,
): string {
  const padding = " ".repeat(attempt);
  // The hint does not say how to finish: a story runtime ends with its text
  // and the others with a tool, and the instructions above say which.
  const zh = instructionLocaleFor(locale) === "zh";
  if (reason === "tool-loop-detected")
    return zh
      ? `[retry ${attempt}] 上一次尝试反复调用了同一个工具。换一种做法，或按指令的要求结束。${padding}`
      : `[retry ${attempt}] The previous attempt called the same tool repeatedly. Vary your approach, or finish as the instructions say.${padding}`;
  if (reason === "output-truncated")
    return zh
      ? `[retry ${attempt}] 上一次尝试写到输出上限也没有完成。只写任务需要的内容，然后按指令的要求结束。${padding}`
      : `[retry ${attempt}] The previous attempt reached the output limit before it finished. Write only what the task needs, then finish as the instructions say.${padding}`;
  return zh
    ? `[retry ${attempt}] 上一次尝试没有完成。重新完成任务，并按指令的要求结束。${padding}`
    : `[retry ${attempt}] The previous attempt did not complete. Do the task again and finish as the instructions say.${padding}`;
}

// ── Loop scaffolding ────────────────────────────────────────────────

/**
 * Guard the start of an attempt against the runtime deadline. Throws an
 * "exhausted" call-timeout {@link LLMRetryError} when the deadline has passed,
 * matching the inline guard both loops used.
 */
export function assertDeadlineNotReached(
  deadline: number,
  attempt: number,
  lastError: unknown,
): void {
  if (Date.now() >= deadline) {
    throw new LLMRetryError({
      reason: "call-timeout",
      attempts: attempt,
      cause: lastError,
      message: "Runtime deadline reached before LLM call could be attempted",
    });
  }
}

/**
 * Time remaining until the runtime deadline, floored at
 * {@link MIN_ATTEMPT_BUDGET_MS}.
 */
export function computeDeadlineBudget(deadline: number): number {
  const remainingMs = deadline - Date.now();
  // Past the deadline: no budget. Granting the 1s floor here would let an
  // attempt run ~1s beyond the runtime deadline. assertDeadlineNotReached
  // usually throws first; this guards races and direct callers.
  if (remainingMs <= 0) return 0;
  return Math.max(MIN_ATTEMPT_BUDGET_MS, remainingMs);
}

/**
 * Compute the time budget of one non-streaming attempt: the smaller of the
 * policy's `callTimeoutMs` and the time remaining until the runtime deadline.
 */
export function computeAttemptBudget(
  policy: RetryPolicy,
  deadline: number,
): number {
  return Math.min(policy.callTimeoutMs, computeDeadlineBudget(deadline));
}

/**
 * Build the terminal "retry exhausted" error thrown after a loop falls
 * through without returning.
 */
export function exhaustedError(
  policy: RetryPolicy,
  lastReason: RetryReason,
  lastError: unknown,
): LLMRetryError {
  return new LLMRetryError({
    reason: lastReason,
    attempts: policy.maxRetries + 1,
    cause: lastError,
  });
}
