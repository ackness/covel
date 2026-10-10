/**
 * Unit tests for the in-process SessionLock.
 *
 * Validates the semantics documented on `createInProcessSessionLock`:
 *   - same-session calls are strictly serialized
 *   - different-session calls run concurrently
 *   - exceptions in `fn` release the slot so subsequent callers proceed
 *   - map entries are cleaned up when no successor is queued
 *
 * The PG advisory-lock variant is covered separately in
 * `tests/integration/pg-session-lock.test.ts` (skipped when DATABASE_URL
 * is not set).
 */

import { describe, it, expect, vi } from "vitest";
import {
  createInProcessSessionLock,
  withBackgroundSessionLock,
  SessionLockTimeoutError,
} from "../../src/lib/session-lock.js";

it("keeps a durable commit waiting after an acquire timeout, but never retries its callback", async () => {
  const base = createInProcessSessionLock();
  let attempts = 0;
  const lock = {
    ...base,
    withLock: async <T>(id: string, fn: () => Promise<T>) => {
      if (++attempts === 1) throw new SessionLockTimeoutError("busy");
      return base.withLock(id, fn);
    },
  };
  const signal = new AbortController().signal;
  await expect(
    withBackgroundSessionLock(lock, "session", async () => "committed", signal),
  ).resolves.toBe("committed");
  expect(attempts).toBe(2);
  await expect(
    withBackgroundSessionLock(
      lock,
      "session",
      async () => {
        throw new SessionLockTimeoutError("callback failure");
      },
      signal,
    ),
  ).rejects.toThrow("callback failure");
  expect(attempts).toBe(3);
});

it("rejects a late lock acquisition after the durable job has been cancelled", async () => {
  const control = new AbortController();
  const lock = createInProcessSessionLock();
  let called = false;
  const pending = withBackgroundSessionLock(
    lock,
    "session",
    async () => {
      called = true;
    },
    control.signal,
  );
  control.abort(new Error("lease expired"));
  await expect(pending).rejects.toThrow("lease expired");
  expect(called).toBe(false);
});

describe("createInProcessSessionLock", () => {
  it("does not queue a probe behind another owner and excludes new contenders", async () => {
    const lock = createInProcessSessionLock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = lock.tryWithLock("probe", () => gate);
    let ran = false;
    expect(
      await lock.tryWithLock("probe", async () => {
        ran = true;
      }),
    ).toEqual({ acquired: false });
    expect(ran).toBe(false);
    release();
    expect(await owner).toEqual({ acquired: true, value: undefined });
    expect(await lock.tryWithLock("probe", async () => 42)).toEqual({
      acquired: true,
      value: 42,
    });
    expect(lock._sizeForTests()).toBe(0);
  });

  it("reenters a live owner and releases a failed probe", async () => {
    const lock = createInProcessSessionLock();
    expect(
      await lock.withLock("probe", () =>
        lock.tryWithLock("probe", async () => 42),
      ),
    ).toEqual({ acquired: true, value: 42 });
    await expect(
      lock.tryWithLock("probe", async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");
    expect(await lock.tryWithLock("probe", async () => "recovered")).toEqual({
      acquired: true,
      value: "recovered",
    });
    expect(lock._sizeForTests()).toBe(0);
  });

  it("does not reuse a released owner from a detached probe", async () => {
    const lock = createInProcessSessionLock();
    let startProbe!: () => void;
    const gate = new Promise<void>((resolve) => {
      startProbe = resolve;
    });
    let probe!: Promise<unknown>;
    await lock.withLock("probe", async () => {
      probe = gate.then(() => lock.tryWithLock("probe", async () => "invalid"));
    });
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = lock.withLock("probe", () => ownerGate);
    startProbe();
    expect(await probe).toEqual({ acquired: false });
    releaseOwner();
    await owner;
  });

  it("serializes same-session calls in submission order", async () => {
    const lock = createInProcessSessionLock();
    const log: string[] = [];

    const a = lock.withLock("sess-1", async () => {
      log.push("A-start");
      await new Promise((r) => setTimeout(r, 40));
      log.push("A-end");
    });
    const b = lock.withLock("sess-1", async () => {
      log.push("B-start");
      log.push("B-end");
    });
    const c = lock.withLock("sess-1", async () => {
      log.push("C-start");
      log.push("C-end");
    });

    await Promise.all([a, b, c]);

    expect(log).toEqual([
      "A-start",
      "A-end",
      "B-start",
      "B-end",
      "C-start",
      "C-end",
    ]);
  });

  it("runs different-session calls concurrently", async () => {
    const lock = createInProcessSessionLock();
    // Every holder waits until all three have entered the lock. A global lock
    // would never let the second one in, so the test would time out; no clock
    // is read.
    let entered = 0;
    let allEntered!: () => void;
    const everyoneIn = new Promise<void>((resolve) => {
      allEntered = resolve;
    });
    const hold = async () => {
      entered += 1;
      if (entered === 3) allEntered();
      await everyoneIn;
    };

    await Promise.all([
      lock.withLock("sess-1", hold),
      lock.withLock("sess-2", hold),
      lock.withLock("sess-3", hold),
    ]);

    expect(entered).toBe(3);
  });

  it("releases the slot when fn throws so successors proceed", async () => {
    const lock = createInProcessSessionLock();
    const log: string[] = [];

    const failing = lock.withLock("sess-err", async () => {
      log.push("A-start");
      throw new Error("boom");
    });
    const next = lock.withLock("sess-err", async () => {
      log.push("B-start");
      log.push("B-end");
    });

    await expect(failing).rejects.toThrow("boom");
    await next;

    expect(log).toEqual(["A-start", "B-start", "B-end"]);
  });

  it("cleans up the map entry when no successor is queued", async () => {
    const lock = createInProcessSessionLock();
    expect(lock._sizeForTests()).toBe(0);

    await lock.withLock("sess-x", async () => {
      // While fn runs, the map MUST contain this session's chain.
      expect(lock._sizeForTests()).toBe(1);
    });

    // Post-completion the entry should be GC'd — otherwise the map grows
    // unboundedly as sessions come and go on a long-running server.
    expect(lock._sizeForTests()).toBe(0);
  });

  it("logs a long wait once and still runs the waiter when the owner ends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const lock = createInProcessSessionLock({ slowWaitMs: 1 });
      let finishOwner: () => void = () => {};
      const owner = lock.withLock(
        "sess-slow",
        () => new Promise<void>((resolve) => (finishOwner = resolve)),
      );
      const waiter = lock.withLock("sess-slow", async () => "ran");
      // The owner ends only after the line is written, so the test does not
      // depend on how fast the machine is.
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      expect(String(warn.mock.calls[0]![0])).toContain("sess-slow");
      finishOwner();
      await owner;
      await expect(waiter).resolves.toBe("ran");
      // An uncontended acquire starts no timer.
      await lock.withLock("sess-slow", async () => undefined);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("propagates fn return value to the caller", async () => {
    const lock = createInProcessSessionLock();
    const result = await lock.withLock("sess-ret", async () => 42);
    expect(result).toBe(42);
  });

  it("does not let a detached child inherit a released reentrant lease", async () => {
    const lock = createInProcessSessionLock();
    let releaseChild!: () => void;
    let markChildReady!: () => void;
    const childReady = new Promise<void>((resolve) => {
      markChildReady = resolve;
    });
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let child: Promise<void> | undefined;

    await lock.withLock("session", async () => {
      child = new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          markChildReady();
          void lock
            .withLock("session", async () => {
              await childGate;
            })
            .then(resolve, reject);
        });
      });
    });
    await childReady;

    let contenderEntered = false;
    const contender = lock.withLock("session", async () => {
      contenderEntered = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(contenderEntered).toBe(false);

    releaseChild();
    await Promise.all([child, contender]);
    expect(contenderEntered).toBe(true);
  });
});
