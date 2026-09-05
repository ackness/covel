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

import { describe, it, expect } from "vitest";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

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
    const start = Date.now();

    await Promise.all([
      lock.withLock("sess-1", () => new Promise((r) => setTimeout(r, 50))),
      lock.withLock("sess-2", () => new Promise((r) => setTimeout(r, 50))),
      lock.withLock("sess-3", () => new Promise((r) => setTimeout(r, 50))),
    ]);

    // Sequential execution would take ≥150ms; concurrent ~50ms. Give a
    // comfortable ceiling to avoid CI flake while still catching accidental
    // serialization (e.g. a global lock).
    expect(Date.now() - start).toBeLessThan(120);
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
