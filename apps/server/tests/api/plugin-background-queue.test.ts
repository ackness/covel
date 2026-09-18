import { describe, expect, it, vi } from "vitest";
import { PluginBackgroundQueueClosedError } from "../../src/routes/api/plugin-rpc/background-queue.js";
import { createTestBackgroundQueue } from "./__helpers/background-queue.js";

function gate() {
  return Promise.withResolvers<void>();
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("plugin background queue ownership", () => {
  it("drains admission and terminal writes and rejects new work during close", async () => {
    const queue = createTestBackgroundQueue();
    const prepared = gate();
    const terminalStarted = gate();
    const terminal = gate();
    const run = vi.fn(async () => {});
    const reject = vi.fn(async () => {
      terminalStarted.resolve();
      await terminal.promise;
    });
    const registration = queue.schedule({
      sessionId: "s",
      jobId: "pending-registration",
      prepare: () => prepared.promise,
      run,
      reject,
    });
    let drained = false;
    const closing = queue.close();
    void closing.then(() => {
      drained = true;
    });
    const prepare = vi.fn(async () => {});
    try {
      await expect(
        queue.schedule({ sessionId: "s", jobId: "late", prepare, run, reject }),
      ).rejects.toBeInstanceOf(PluginBackgroundQueueClosedError);
      expect(prepare).not.toHaveBeenCalled();
      expect(drained).toBe(false);
      prepared.resolve();
      await terminalStarted.promise;
      expect(reject).toHaveBeenCalledWith("server-shutdown");
      expect(drained).toBe(false);
      expect(run).not.toHaveBeenCalled();
    } finally {
      prepared.resolve();
      terminal.resolve();
      await Promise.all([registration, closing]);
    }
    expect(drained).toBe(true);
  });

  it("aborts running work, rejects queued work, and waits for execution cleanup", async () => {
    const queue = createTestBackgroundQueue();
    const cleanup = gate();
    const signals: AbortSignal[] = [];
    const rejected: string[] = [];
    for (let i = 0; i < 6; i++) {
      await queue.schedule({
        sessionId: "s",
        jobId: String(i),
        prepare: async () => {},
        run: async (signal) => {
          signals.push(signal);
          await cleanup.promise;
        },
        reject: async (reason) => {
          rejected.push(`${i}:${reason}`);
        },
      });
    }
    await tick();
    let drained = false;
    const closing = queue.close();
    void closing.then(() => {
      drained = true;
    });
    try {
      await tick();
      expect(signals).toHaveLength(4);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(rejected).toEqual(["4:server-shutdown", "5:server-shutdown"]);
      expect(drained).toBe(false);
    } finally {
      cleanup.resolve();
      await closing;
    }
  });

  it("settles reserved callbacks without starting runtimes after shutdown", async () => {
    const queue = createTestBackgroundQueue();
    const run = vi.fn(async () => {});
    const reject = vi.fn(async () => {});
    await queue.schedule({
      sessionId: "s",
      jobId: "reserved",
      prepare: async () => {},
      run,
      reject,
    });
    await queue.close();
    expect(run).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledExactlyOnceWith("server-shutdown");
  });

  it("keeps instances independent and publishes an idempotent close before abort", async () => {
    const a = createTestBackgroundQueue();
    const b = createTestBackgroundQueue();
    let reentrant: Promise<void> | undefined;
    a.signal.addEventListener("abort", () => {
      reentrant = a.close();
    });
    const closing = a.close();
    expect(reentrant).toBe(closing);
    expect(a.close()).toBe(closing);
    expect(b.signal.aborted).toBe(false);
    const ran = gate();
    await b.schedule({
      sessionId: "s",
      jobId: "independent",
      prepare: async () => {},
      run: async () => {
        ran.resolve();
      },
      reject: async () => {},
    });
    await ran.promise;
    await Promise.all([closing, b.close()]);
  });

  it("caps admission and fairly drains sessions in FIFO order", async () => {
    const queue = createTestBackgroundQueue();
    const releases = Array.from({ length: 4 }, gate);
    const order: string[] = [];
    const finished = gate();
    for (let i = 0; i < 4; i++) {
      await queue.schedule({
        sessionId: "busy",
        jobId: `busy-${i}`,
        prepare: async () => {},
        run: () => releases[i]!.promise,
        reject: async () => {},
      });
    }
    const overflow = vi.fn(async () => {});
    for (let i = 0; i <= 1024; i++) {
      const sessionId = i % 2 ? "b" : "a";
      await queue.schedule({
        sessionId,
        jobId: `queued-${i}`,
        prepare: async () => {},
        run: async () => {
          order.push(`${sessionId}:${i}`);
          if (order.length === 1024) finished.resolve();
        },
        reject: overflow,
      });
    }
    try {
      expect(overflow).toHaveBeenCalledExactlyOnceWith("background-queue-full");
      // Keep three slots occupied to observe deterministic round-robin ordering.
      releases[0]!.resolve();
      await finished.promise;
      expect(order.slice(0, 6)).toEqual([
        "a:0",
        "b:1",
        "a:2",
        "b:3",
        "a:4",
        "b:5",
      ]);
      expect(order).toHaveLength(1024);
    } finally {
      releases.forEach((release) => release.resolve());
      await queue.close();
    }
  });

  it("reports escaped failures without provider content and continues queued work", async () => {
    const queue = createTestBackgroundQueue();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const finished = gate();
    try {
      for (let i = 0; i < 5; i++) {
        await queue.schedule({
          sessionId: "safe-session",
          jobId: `job-${i}`,
          prepare: async () => {},
          run: async () => {
            if (i < 4) throw new Error("private-provider-response");
            finished.resolve();
          },
          reject: async () => {},
        });
      }
      await finished.promise;
      await queue.close();
      expect(log).toHaveBeenCalledTimes(4);
      expect(log.mock.calls).toContainEqual([
        "[plugin-rpc] background task failed to settle",
        { sessionId: "safe-session", jobId: "job-0" },
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "private-provider-response",
      );
    } finally {
      await queue.close();
      log.mockRestore();
    }
  });
});
