/** One mutable budget shared by every transport attempt in a logical LLM call. */
export interface LLMRequestBudget {
  readonly maxAttempts: number;
  attempts: number;
  /** Moves later while a stream delivers output; never past `ceiling`. */
  deadline: number;
  /**
   * Longest silence of a stream that has started to write. Absent means the
   * deadline is fixed.
   */
  readonly idleTimeoutMs?: number;
  /** Latest time `deadline` may reach. */
  readonly ceiling: number;
}

export const DEFAULT_LLM_REQUEST_ATTEMPTS = 8;
/** Longest wait for the first output, with every retry and backoff. */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;
/** Longest silence of a stream that has started to write. */
export const DEFAULT_LLM_REQUEST_IDLE_TIMEOUT_MS = 120_000;
/** Ends a model that never stops writing. */
export const DEFAULT_LLM_REQUEST_CEILING_MS = 30 * 60_000;

export class LLMRequestBudgetError extends Error {
  readonly code = "REQUEST_BUDGET_EXCEEDED";
  readonly retriable = false;

  constructor(
    readonly reason: "attempts" | "deadline",
    readonly budget: LLMRequestBudget,
  ) {
    super(
      reason === "attempts"
        ? `LLM request exhausted its ${budget.maxAttempts} transport attempts`
        : "LLM request deadline exceeded",
    );
    this.name = "LLMRequestBudgetError";
  }
}

/**
 * A budget with no explicit `timeoutMs` or `deadline` is limited by silence:
 * output of a stream moves its deadline (see {@link noteLlmRequestProgress}).
 * An explicit limit stays fixed unless the caller also gives `idleTimeoutMs`.
 * `deadline` is an absolute limit that output never moves.
 */
export function createLlmRequestBudget(
  options: {
    maxAttempts?: number;
    timeoutMs?: number;
    deadline?: number;
    idleTimeoutMs?: number;
    ceilingMs?: number;
  } = {},
): LLMRequestBudget {
  const maxAttempts = options.maxAttempts ?? DEFAULT_LLM_REQUEST_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const fixed =
    options.timeoutMs !== undefined || options.deadline !== undefined;
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (fixed ? undefined : DEFAULT_LLM_REQUEST_IDLE_TIMEOUT_MS);
  const ceilingMs = options.ceilingMs ?? DEFAULT_LLM_REQUEST_CEILING_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("LLM request maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("LLM request timeoutMs must be finite and positive");
  }
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
    throw new RangeError("LLM request deadline must be finite");
  }
  if (
    idleTimeoutMs !== undefined &&
    (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0)
  ) {
    throw new RangeError(
      "LLM request idleTimeoutMs must be finite and positive",
    );
  }
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) {
    throw new RangeError("LLM request ceilingMs must be finite and positive");
  }
  const now = Date.now();
  const limit = options.deadline ?? Infinity;
  const deadline = Math.min(now + timeoutMs, limit);
  return {
    maxAttempts,
    attempts: 0,
    deadline,
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ceiling:
      idleTimeoutMs === undefined
        ? deadline
        : Math.max(deadline, Math.min(now + ceilingMs, limit)),
  };
}

/**
 * Record that a stream delivered output. A model that keeps writing is not
 * cut off: the deadline moves to one idle timeout from now. Silence and the
 * ceiling still end the request.
 */
export function noteLlmRequestProgress(budget: LLMRequestBudget): void {
  if (budget.idleTimeoutMs === undefined) return;
  const next = Math.min(Date.now() + budget.idleTimeoutMs, budget.ceiling);
  if (next > budget.deadline) budget.deadline = next;
}

/** Guards do not spend attempts; only a transport about to send consumes one. */
export function assertLlmRequestBudget(
  budget: LLMRequestBudget,
  options: {
    signal?: AbortSignal;
    requireAttempt?: boolean;
    consumeAttempt?: boolean;
  } = {},
): void {
  options.signal?.throwIfAborted();
  if (Date.now() >= budget.deadline) {
    throw new LLMRequestBudgetError("deadline", budget);
  }
  if (
    (options.requireAttempt || options.consumeAttempt) &&
    budget.attempts >= budget.maxAttempts
  ) {
    throw new LLMRequestBudgetError("attempts", budget);
  }
  if (options.consumeAttempt) budget.attempts++;
}

/** Arms the logical deadline while an operation owns the request/response body. */
export function createLlmRequestScope(
  options: {
    budget?: LLMRequestBudget;
    signal?: AbortSignal;
  } = {},
): {
  budget: LLMRequestBudget;
  signal: AbortSignal;
  dispose(): void;
} {
  const budget = options.budget ?? createLlmRequestBudget();
  assertLlmRequestBudget(budget, { signal: options.signal });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0) {
      controller.abort(new LLMRequestBudgetError("deadline", budget));
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  };
  schedule();
  return {
    budget,
    signal: options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** Stop awaiting an uncooperative observer/adapter while observing late failures. */
export function awaitLlmRequest<T>(
  task: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(task);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    Promise.resolve(task).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A hung iterator cannot extend a request's deadline or delay cancellation. */
export async function* iterateLlmRequest<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let done = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await awaitLlmRequest(iterator.next(), signal);
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done && iterator.return) {
      const closing = Promise.resolve().then(() => iterator.return!());
      if (signal.aborted) void closing.catch(() => undefined);
      else await awaitLlmRequest(closing, signal);
    }
  }
}
