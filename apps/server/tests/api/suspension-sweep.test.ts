import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSweepClockForTests,
  maybeSweepExpiredSuspensions,
  resolveSuspensionTtlMs,
} from "../../src/routes/api/suspension-sweep.js";

const TTL_ENV = "COVEL_SUSPENSION_TTL_MS";
const DEFAULT_TTL = 604_800_000;

function makeStore(deleted = 0) {
  return { deleteExpiredSuspensions: vi.fn(async () => deleted) };
}

describe("suspension-sweep helper (S4-T4.c)", () => {
  const original = process.env[TTL_ENV];

  beforeEach(() => {
    __resetSweepClockForTests();
    delete process.env[TTL_ENV];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[TTL_ENV];
    else process.env[TTL_ENV] = original;
    vi.restoreAllMocks();
  });

  it("resolveSuspensionTtlMs falls back to 604800000 when unset and honors an override", () => {
    expect(resolveSuspensionTtlMs()).toBe(DEFAULT_TTL);
    process.env[TTL_ENV] = "1000";
    expect(resolveSuspensionTtlMs()).toBe(1000);
  });

  it("computes cutoff = now - TTL and calls deleteExpiredSuspensions once", async () => {
    process.env[TTL_ENV] = "1000";
    const store = makeStore();
    const now = 10_000;

    await maybeSweepExpiredSuspensions(store, { now, force: true });

    expect(store.deleteExpiredSuspensions).toHaveBeenCalledTimes(1);
    expect(store.deleteExpiredSuspensions).toHaveBeenCalledWith(
      new Date(now - 1000).toISOString(),
    );
  });

  it("returns 0 and never touches the store when TTL <= 0 (disabled escape hatch)", async () => {
    process.env[TTL_ENV] = "0";
    const store = makeStore();

    // Even forced, a disabled TTL is a no-op.
    const n = await maybeSweepExpiredSuspensions(store, {
      now: 10_000,
      force: true,
    });

    expect(n).toBe(0);
    expect(store.deleteExpiredSuspensions).not.toHaveBeenCalled();
  });

  it("runs at most once per SWEEP_INTERVAL_MS unless forced", async () => {
    process.env[TTL_ENV] = "1000";
    const store = makeStore();

    // A forced sweep stamps the interval clock at now=1_000_000.
    await maybeSweepExpiredSuspensions(store, { now: 1_000_000, force: true });
    // A later non-forced call 1 minute on is still inside the 1h gate.
    await maybeSweepExpiredSuspensions(store, { now: 1_060_000 });

    expect(store.deleteExpiredSuspensions).toHaveBeenCalledTimes(1);
  });

  it("force=true always sweeps regardless of the interval clock (startup path)", async () => {
    process.env[TTL_ENV] = "1000";
    const store = makeStore();

    await maybeSweepExpiredSuspensions(store, { now: 0, force: true });
    await maybeSweepExpiredSuspensions(store, { now: 1, force: true });

    expect(store.deleteExpiredSuspensions).toHaveBeenCalledTimes(2);
  });

  it("swallows store errors and never throws into the caller", async () => {
    process.env[TTL_ENV] = "1000";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      deleteExpiredSuspensions: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const n = await maybeSweepExpiredSuspensions(store, {
      now: 10_000,
      force: true,
    });

    expect(n).toBe(0);
  });

  it("returns the store's deleted count", async () => {
    process.env[TTL_ENV] = "1000";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = makeStore(3);

    const n = await maybeSweepExpiredSuspensions(store, {
      now: 10_000,
      force: true,
    });

    expect(n).toBe(3);
  });
});
