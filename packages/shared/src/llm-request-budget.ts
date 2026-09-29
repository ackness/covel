/** One mutable budget shared by every transport attempt in a logical LLM call. */
export interface LLMRequestBudget {
  readonly maxAttempts: number;
  attempts: number;
  readonly deadline: number;
}

export const DEFAULT_LLM_REQUEST_ATTEMPTS = 8;
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

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

export function createLlmRequestBudget(
  options: {
    maxAttempts?: number;
    timeoutMs?: number;
    deadline?: number;
  } = {},
): LLMRequestBudget {
  const maxAttempts = options.maxAttempts ?? DEFAULT_LLM_REQUEST_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("LLM request maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("LLM request timeoutMs must be finite and positive");
  }
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
    throw new RangeError("LLM request deadline must be finite");
  }
  return {
    maxAttempts,
    attempts: 0,
    deadline: Math.min(Date.now() + timeoutMs, options.deadline ?? Infinity),
  };
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
