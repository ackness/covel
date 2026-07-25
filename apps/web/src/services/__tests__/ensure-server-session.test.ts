/**
 * Regression test: a failed session-context sync must NOT be swallowed.
 *
 * The kernel builds its LLM context from server-side messages. If
 * `syncToServer` fails after a server restart and we run the turn anyway, the
 * player watches the narrator forget the entire story with nothing on screen
 * explaining why. `ensureServerSession` used to catch the sync failure and
 * resolve, so `ensureServerThenRun` fired the action regardless.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;
const T0 = new Date("2026-07-25T00:00:00Z");
/** `ensureServerSession` skips the probe entirely while the last ack is < 10 min old. */
const PAST_STALE_THRESHOLD = new Date("2026-07-25T00:11:00Z");

function healthResponse(bootId: string): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ status: "ok", bootId }),
  } as Response;
}

/**
 * `knownBootId` / `lastServerAckTime` are module-level, so every test needs a
 * fresh module instance or state from an earlier case leaks in.
 */
async function freshHealthModule() {
  vi.resetModules();
  return import("../api/health.js");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("ensureServerSession", () => {
  it("propagates a sync failure when the server restarted", async () => {
    const { ensureServerSession } = await freshHealthModule();
    globalThis.fetch = vi.fn().mockResolvedValue(healthResponse("boot-1"));
    // First pass records boot-1 (knownBootId starts null, so no sync yet).
    await ensureServerSession("sess-1", vi.fn());

    vi.setSystemTime(PAST_STALE_THRESHOLD);
    globalThis.fetch = vi.fn().mockResolvedValue(healthResponse("boot-2"));
    const syncFn = vi.fn().mockRejectedValue(new Error("syncMessages 500"));

    await expect(ensureServerSession("sess-1", syncFn)).rejects.toThrow(
      "syncMessages 500",
    );
    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it("propagates a sync failure when the health probe itself failed", async () => {
    const { ensureServerSession } = await freshHealthModule();
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    const syncFn = vi.fn().mockRejectedValue(new Error("syncMessages 500"));

    await expect(ensureServerSession("sess-2", syncFn)).rejects.toThrow(
      "syncMessages 500",
    );
    // Exactly once — the old shape ran the same doomed sync twice.
    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it("syncs and resolves when the probe failed but the sync worked", async () => {
    const { ensureServerSession } = await freshHealthModule();
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
    const syncFn = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureServerSession("sess-3", syncFn),
    ).resolves.toBeUndefined();
    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it("probes but does not sync when the bootId is unchanged", async () => {
    const { ensureServerSession } = await freshHealthModule();
    globalThis.fetch = vi.fn().mockResolvedValue(healthResponse("boot-9"));
    const syncFn = vi.fn();

    await ensureServerSession("sess-4", syncFn); // records boot-9
    vi.setSystemTime(PAST_STALE_THRESHOLD);
    const probe = vi.fn().mockResolvedValue(healthResponse("boot-9"));
    globalThis.fetch = probe;
    await ensureServerSession("sess-4", syncFn);

    expect(probe).toHaveBeenCalledTimes(1); // the gate really did re-open
    expect(syncFn).not.toHaveBeenCalled();
  });
});
