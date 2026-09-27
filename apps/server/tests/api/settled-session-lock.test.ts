import { describe, expect, it, vi } from "vitest";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createSettledSessionLock,
  type SettlingJob,
} from "../../src/routes/api/plugin-rpc/settled-session-lock.js";

function setup() {
  const raw = createInProcessSessionLock();
  let pending: readonly SettlingJob[] = [];
  const lock = createSettledSessionLock({
    sessionLock: raw,
    listPendingJobs: async () => pending,
    pollIntervalMs: 1,
  });
  return {
    raw,
    lock,
    setPending: (jobs: readonly SettlingJob[]) => {
      pending = jobs;
    },
  };
}

describe("settled session lock", () => {
  it("allows the worker to commit through the raw lock while the next execution waits", async () => {
    const { raw, lock, setPending } = setup();
    setPending([{ jobId: "previous" }]);
    const next = vi.fn(async () => "next-result");
    const provided = vi.fn();
    const result = lock.withLock(
      "session",
      { provideCredentials: provided },
      next,
    );
    await vi.waitFor(() => expect(provided).toHaveBeenCalled());
    expect(next).not.toHaveBeenCalled();
    await raw.withLock("session", async () => setPending([]));
    await expect(result).resolves.toBe("next-result");
    expect(next).toHaveBeenCalledOnce();
  });

  it("releases the lock when a job appeared between waiting and acquisition", async () => {
    const { raw, lock, setPending } = setup();
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = raw.withLock("session", async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      setPending([{ jobId: "raced" }]);
    });
    await acquired;
    const next = vi.fn(async () => "done");
    const result = lock.withLock("session", {}, next);
    await Promise.resolve();
    release();
    await held;
    await raw.withLock("session", async () => {
      expect(next).not.toHaveBeenCalled();
      setPending([]);
    });
    await expect(result).resolves.toBe("done");
  });

  it("times out once without cancelling the job and permits a late commit", async () => {
    const { raw, lock, setPending } = setup();
    setPending([{ jobId: "slow", maxSettleWaitMs: 10 }]);
    const onTimeout = vi.fn();
    await expect(
      lock.withLock("session", { onTimeout }, async () => "partial"),
    ).resolves.toBe("partial");
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout.mock.calls[0]?.[0]).toMatchObject({
      pendingJobIds: ["slow"],
    });
    await raw.withLock("session", async () => setPending([]));
    await expect(
      lock.withLock("session", { onTimeout }, async () => "complete"),
    ).resolves.toBe("complete");
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("aborts only this waiter and leaves the job available to another waiter", async () => {
    const { raw, lock, setPending } = setup();
    setPending([{ jobId: "running" }]);
    const controller = new AbortController();
    const next = vi.fn(async () => undefined);
    const result = lock.withLock(
      "session",
      { signal: controller.signal },
      next,
    );
    const rejected = expect(result).rejects.toThrow("stop waiting");
    controller.abort(new Error("stop waiting"));
    await rejected;
    expect(next).not.toHaveBeenCalled();
    await raw.withLock("session", async () => setPending([]));
    await lock.withLock("session", {}, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not execute a cancelled callback after its raw lock acquire completes", async () => {
    const { raw, lock } = setup();
    let release!: () => void;
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = raw.withLock(
      "session",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    await acquired;
    const controller = new AbortController();
    const next = vi.fn(async () => undefined);
    const result = lock.withLock(
      "session",
      { signal: controller.signal },
      next,
    );
    const rejected = expect(result).rejects.toThrow("cancelled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancelled"));
    await rejected;
    release();
    await held;
    expect(next).not.toHaveBeenCalled();
  });

  it("lets a nested framework mutation reuse the admitted execution", async () => {
    const { lock, setPending } = setup();
    await expect(
      lock.withLock("session", {}, async () => {
        setPending([{ jobId: "created-by-this-execution" }]);
        return lock.withLock("session", {}, async () => "nested");
      }),
    ).resolves.toBe("nested");
  });
});
