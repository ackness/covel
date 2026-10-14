import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuspensionRecord } from "@covel/store";
import {
  __resetSweepClockForTests,
  maybeSweepExpiredSuspensions,
  resolveSuspensionTtlMs,
} from "../../src/routes/api/suspension-sweep.js";

const TTL_ENV = "COVEL_SUSPENSION_TTL_MS";
const DEFAULT_TTL = 604_800_000;

function makeStore(expired = 0) {
  const records = Array.from(
    { length: expired },
    (_, i) => ({ id: `susp-${i}`, sessionId: "sess" }) as SuspensionRecord,
  );
  const listExpiredSuspensions = vi.fn(async (_cutoff: string) => records);
  const releaseStaleSuspensionClaims = vi.fn(async (_cutoff: string) => 0);
  return {
    store: { listExpiredSuspensions, releaseStaleSuspensionClaims },
    expire: vi.fn(
      async (_suspension: SuspensionRecord, _cutoff: string) => true,
    ),
    listExpiredSuspensions,
    releaseStaleSuspensionClaims,
  };
}

describe("suspension-sweep helper", () => {
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

  it("computes cutoff = now - TTL and lists the expired suspensions once", async () => {
    process.env[TTL_ENV] = "1000";
    const store = makeStore();
    const now = 10_000;

    await maybeSweepExpiredSuspensions(store, { now, force: true });

    expect(store.listExpiredSuspensions).toHaveBeenCalledTimes(1);
    expect(store.listExpiredSuspensions).toHaveBeenCalledWith(
      new Date(now - 1000).toISOString(),
    );
  });

  it("releases claims older than an hour, or every claim when the caller owns the store", async () => {
    const store = makeStore();
    const now = 10_000_000;

    await maybeSweepExpiredSuspensions(store, { now, force: true });
    await maybeSweepExpiredSuspensions(store, {
      now,
      force: true,
      claimMaxAgeMs: 0,
    });

    expect(store.releaseStaleSuspensionClaims.mock.calls).toEqual([
      [new Date(now - 3_600_000).toISOString()],
      [new Date(now).toISOString()],
    ]);
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
    expect(store.listExpiredSuspensions).not.toHaveBeenCalled();
  });

  it("runs at most once per SWEEP_INTERVAL_MS unless forced", async () => {
    process.env[TTL_ENV] = "1000";
    const store = makeStore();

    // A forced sweep stamps the interval clock at now=1_000_000.
    await maybeSweepExpiredSuspensions(store, { now: 1_000_000, force: true });
    // A later non-forced call 1 minute on is still inside the 1h gate.
    await maybeSweepExpiredSuspensions(store, { now: 1_060_000 });

    expect(store.listExpiredSuspensions).toHaveBeenCalledTimes(1);
  });

  it("force=true always sweeps regardless of the interval clock (startup path)", async () => {
    process.env[TTL_ENV] = "1000";
    const store = makeStore();

    await maybeSweepExpiredSuspensions(store, { now: 0, force: true });
    await maybeSweepExpiredSuspensions(store, { now: 1, force: true });

    expect(store.listExpiredSuspensions).toHaveBeenCalledTimes(2);
  });

  it("swallows store errors and never throws into the caller", async () => {
    process.env[TTL_ENV] = "1000";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      store: {
        listExpiredSuspensions: vi.fn(async () => {
          throw new Error("boom");
        }),
        releaseStaleSuspensionClaims: vi.fn(async () => 0),
      },
      expire: vi.fn(async () => true),
    };

    const n = await maybeSweepExpiredSuspensions(store, {
      now: 10_000,
      force: true,
    });

    expect(n).toBe(0);
  });

  it("abandons each expired suspension through expire, and one failure keeps the rest", async () => {
    process.env[TTL_ENV] = "1000";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = makeStore(3);
    store.expire
      .mockRejectedValueOnce(new Error("lock lost"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const now = 10_000;

    const n = await maybeSweepExpiredSuspensions(store, { now, force: true });

    expect(n).toBe(1);
    expect(
      store.expire.mock.calls.map(([record, cutoff]) => [record.id, cutoff]),
    ).toEqual([
      ["susp-0", new Date(now - 1000).toISOString()],
      ["susp-1", new Date(now - 1000).toISOString()],
      ["susp-2", new Date(now - 1000).toISOString()],
    ]);
  });

  it("returns the number of suspensions it abandoned", async () => {
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
