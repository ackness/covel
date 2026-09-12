/**
 * Process-wide LLM call concurrency gate.
 *
 * A turn's post-turn stage can fan out many agent runtimes at once; firing
 * all their LLM calls concurrently congests slower providers/proxies until
 * every call times out. This FIFO counting semaphore caps in-flight LLM
 * attempts; queued callers report their wait time so the retry loops can
 * extend the runtime deadline by it (queue time is the framework's doing,
 * not the runtime's budget).
 *
 * Cap resolution: COVEL_LLM_MAX_CONCURRENT env (0 or negative disables the
 * gate) → default 4.
 */
// ponytail: process-wide cap; split into per-provider buckets if parallel
// multi-provider sessions ever make a shared gate too coarse.

const DEFAULT_MAX_CONCURRENT = 4;

let capOverride: number | undefined;
let active = 0;
const waiters: Array<{ grant: () => void }> = [];

function resolveCap(): number {
  if (capOverride !== undefined) return capOverride;
  const raw = Number.parseInt(process.env.COVEL_LLM_MAX_CONCURRENT ?? "", 10);
  if (Number.isNaN(raw)) return DEFAULT_MAX_CONCURRENT;
  return raw <= 0 ? Number.POSITIVE_INFINITY : raw;
}

export interface LLMSlot {
  /** How long this caller waited in the queue before getting the slot. */
  readonly waitedMs: number;
  /** Idempotent release; must be called exactly once per acquire (finally). */
  readonly release: () => void;
}

function releaseSlot(): void {
  active--;
  // Reserve capacity synchronously before waking a caller. A newcomer must
  // not take the slot between resolve() and the queued caller's continuation.
  while (active < resolveCap() && waiters.length > 0) {
    waiters.shift()!.grant();
  }
}

export async function acquireLLMSlot(signal?: AbortSignal): Promise<LLMSlot> {
  signal?.throwIfAborted();
  const start = Date.now();
  if (active >= resolveCap() || waiters.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal?.reason);
      };
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          active++;
          resolve();
        },
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // Cancellation can race the handoff after the abort listener is removed.
    if (signal?.aborted) {
      releaseSlot();
      signal.throwIfAborted();
    }
  } else {
    active++;
  }
  let released = false;
  return {
    waitedMs: Date.now() - start,
    release: () => {
      if (released) return;
      released = true;
      releaseSlot();
    },
  };
}

/** Test hook: force a cap (0 or negative = unlimited); undefined restores env/default. */
export function setLLMSlotCapForTests(cap?: number): void {
  capOverride =
    cap === undefined ? undefined : cap <= 0 ? Number.POSITIVE_INFINITY : cap;
}
