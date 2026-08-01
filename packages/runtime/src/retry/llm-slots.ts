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
const waiters: Array<() => void> = [];

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

export async function acquireLLMSlot(): Promise<LLMSlot> {
  const start = Date.now();
  // FIFO: newcomers queue behind existing waiters instead of barging.
  if (active >= resolveCap() || waiters.length > 0) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  active++;
  let released = false;
  return {
    waitedMs: Date.now() - start,
    release: () => {
      if (released) return;
      released = true;
      active--;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

/** Test hook: force a cap (0 or negative = unlimited); undefined restores env/default. */
export function setLLMSlotCapForTests(cap?: number): void {
  capOverride =
    cap === undefined ? undefined : cap <= 0 ? Number.POSITIVE_INFINITY : cap;
}
