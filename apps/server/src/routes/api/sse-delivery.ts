import type { SSEStreamingApi } from "hono/streaming";

// Match the subscription's existing burst budget and transport gap grace.
// Observation must not consume the 30s session-lock/heartbeat budget.
export const SSE_WRITE_QUEUE_MAX = 256;
export const SSE_DELIVERY_DEADLINE_MS = 2000;

export interface BoundedSerialQueueOptions {
  readonly capacity: number;
  readonly onOverflow: () => void;
  readonly onError?: (error: unknown) => void;
}

/** One physical writer. A deadline stops intake, never starts a replacement writer. */
export function createBoundedSerialQueue(options: BoundedSerialQueueOptions) {
  const tasks: Array<{ run: () => Promise<void>; done: () => void }> = [];
  let running = false;
  let closed = false;
  let expired = false;
  let idle: { promise: Promise<void>; resolve: () => void } | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  function settleIdle() {
    if ((!running && tasks.length === 0) || expired) {
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = undefined;
      idle?.resolve();
      idle = undefined;
    }
  }
  function close() {
    closed = true;
    for (const task of tasks.splice(0)) task.done();
    settleIdle();
  }
  function fail(error: unknown) {
    if (expired) return;
    expired = true;
    close();
    options.onError?.(error);
  }
  function pump() {
    if (running || closed) return;
    const task = tasks.shift();
    if (!task) {
      settleIdle();
      return;
    }
    running = true;
    const timer = setTimeout(() => {
      task.done();
      fail(new Error("SSE delivery deadline exceeded"));
    }, SSE_DELIVERY_DEADLINE_MS);
    void Promise.resolve()
      .then(task.run)
      .catch(fail)
      .finally(() => {
        clearTimeout(timer);
        task.done();
        running = false;
        pump();
        settleIdle();
      });
  }
  function add(run: () => Promise<void>, done: () => void): boolean {
    if (closed) {
      done();
      return false;
    }
    if (tasks.length + Number(running) >= options.capacity) {
      close();
      done();
      options.onOverflow();
      return false;
    }
    tasks.push({ run, done });
    pump();
    return true;
  }
  return {
    enqueue(task: () => Promise<void>): boolean {
      return add(task, () => {});
    },
    // Replay/control writes may await observation; business callbacks only enqueue.
    write(task: () => Promise<void>): Promise<void> {
      return new Promise((resolve) => {
        add(task, resolve);
      });
    },
    close,
    drain(): Promise<void> {
      if (expired || (!running && tasks.length === 0)) return Promise.resolve();
      if (!idle) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        idle = { promise, resolve };
        drainTimer = setTimeout(
          () => fail(new Error("SSE drain deadline exceeded")),
          SSE_DELIVERY_DEADLINE_MS,
        );
      }
      return idle.promise;
    },
    pending(): number {
      return tasks.length + Number(running);
    },
  };
}

const closes = new WeakMap<SSEStreamingApi, Promise<void>>();

/** Close is observation too: abort the underlying reader if graceful close stalls. */
export function closeSseDelivery(stream: SSEStreamingApi): Promise<void> {
  let close = closes.get(stream);
  if (!close) {
    close = closeWithinDeadline(stream);
    closes.set(stream, close);
  }
  return close;
}

async function closeWithinDeadline(stream: SSEStreamingApi): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => stream.close())
        .catch(() => stream.abort()),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          stream.abort();
          resolve();
        }, SSE_DELIVERY_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
