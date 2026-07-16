import { describe, it, expect, afterEach, vi } from "vitest";
import type { CovelMessage } from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  createEventBus,
  MAX_TRACKED_SESSIONS,
  PERSIST_MAX_IN_FLIGHT,
  PERSIST_QUEUE_MAX,
  SESSION_IDLE_TTL_MS,
} from "../src/event-bus.js";

function makeMessage(overrides?: Partial<CovelMessage>): CovelMessage {
  return {
    id: crypto.randomUUID(),
    type: "event",
    topic: "test.topic",
    payload: {},
    sessionId: "sess-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session state eviction (audit R-03)", () => {
  it("evicts the least-recently-touched session beyond the global cap", () => {
    const bus = createEventBus();

    for (let i = 0; i < MAX_TRACKED_SESSIONS; i += 1) {
      bus.emit(makeMessage({ sessionId: `sess-${i}` }));
    }
    // One more session pushes the oldest (sess-0) out. Note: no read of
    // sess-0 before this — getEventsAfter refreshes LRU position.
    bus.emit(makeMessage({ sessionId: "sess-overflow" }));

    expect(bus.getEventsAfter("sess-0", 0).gap).toBe(true);
    expect(bus.getEventsAfter("sess-0", 0).events).toEqual([]);
    expect(bus.getEventsAfter("sess-1", 0).events).toHaveLength(1);
    expect(bus.getEventsAfter("sess-overflow", 0).events).toHaveLength(1);
  });

  it("getEventsAfter refreshes LRU position so active sessions survive", () => {
    const bus = createEventBus();

    for (let i = 0; i < MAX_TRACKED_SESSIONS; i += 1) {
      bus.emit(makeMessage({ sessionId: `sess-${i}` }));
    }
    // Touch sess-0 — sess-1 becomes the LRU-oldest.
    bus.getEventsAfter("sess-0", 0);

    bus.emit(makeMessage({ sessionId: "sess-overflow" }));

    expect(bus.getEventsAfter("sess-0", 0).events).toHaveLength(1);
    expect(bus.getEventsAfter("sess-1", 0).gap).toBe(true);
  });

  it("mints a fresh epoch after eviction so old cursors are detectable (H-06)", () => {
    const bus = createEventBus();

    bus.emit(makeMessage({ sessionId: "sess-evicted" }));
    const before = bus.getEventsAfter("sess-evicted", 0).epoch;
    expect(before).toBeDefined();

    for (let i = 0; i < MAX_TRACKED_SESSIONS; i += 1) {
      bus.emit(makeMessage({ sessionId: `filler-${i}` }));
    }
    // Evicted: replay reports a gap, no epoch.
    const evicted = bus.getEventsAfter("sess-evicted", 0);
    expect(evicted.gap).toBe(true);
    expect(evicted.epoch).toBeUndefined();

    // Re-emitting recreates the state: seq restarts at 1 BUT under a new
    // epoch, so the wire id `${epoch}:1` never collides with the old ":1".
    bus.emit(makeMessage({ sessionId: "sess-evicted" }));
    const recreated = bus.getEventsAfter("sess-evicted", 0);
    expect(recreated.events).toHaveLength(1);
    expect(recreated.epoch).toBeDefined();
    expect(recreated.epoch).not.toBe(before);
    expect(recreated.events[0]!.id).toBe(`${recreated.epoch}:1`);
    // A client holding a pre-eviction cursor sees a gap and must reset.
    expect(bus.getEventsAfter("sess-evicted", 500).gap).toBe(true);
  });

  it("evicts sessions idle beyond the TTL", () => {
    vi.useFakeTimers({ now: new Date("2026-07-15T00:00:00Z") });
    const bus = createEventBus();

    bus.emit(makeMessage({ sessionId: "sess-idle" }));
    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS + 1);
    // Any touch triggers the lazy sweep.
    bus.emit(makeMessage({ sessionId: "sess-fresh" }));

    expect(bus.getEventsAfter("sess-idle", 0).gap).toBe(true);
    expect(bus.getEventsAfter("sess-fresh", 0).events).toHaveLength(1);
  });
});

describe("session pinning (re-review H-06)", () => {
  it("a pinned session survives LRU pressure; unpinned it becomes evictable", () => {
    const bus = createEventBus();

    bus.emit(makeMessage({ sessionId: "sess-pinned" }));
    const pin = bus.pin("sess-pinned");

    // Flood way past the global cap — sess-pinned would be LRU-oldest.
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 10; i += 1) {
      bus.emit(makeMessage({ sessionId: `filler-${i}` }));
    }
    const survived = bus.getEventsAfter("sess-pinned", 0);
    expect(survived.gap).toBe(false);
    expect(survived.events).toHaveLength(1);
    expect(survived.epoch).toBe(pin.epoch);

    // Release the pin (idempotent), then flood again — now it evicts.
    pin.release();
    pin.release();
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 10; i += 1) {
      bus.emit(makeMessage({ sessionId: `filler2-${i}` }));
    }
    expect(bus.getEventsAfter("sess-pinned", 0).gap).toBe(true);
  });

  it("a pinned session survives the idle TTL sweep", () => {
    vi.useFakeTimers({ now: new Date("2026-07-15T00:00:00Z") });
    const bus = createEventBus();

    bus.emit(makeMessage({ sessionId: "sess-pinned" }));
    bus.emit(makeMessage({ sessionId: "sess-idle" }));
    const pin = bus.pin("sess-pinned");

    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS + 1);
    bus.emit(makeMessage({ sessionId: "sess-fresh" }));

    expect(bus.getEventsAfter("sess-pinned", 0).gap).toBe(false);
    expect(bus.getEventsAfter("sess-idle", 0).gap).toBe(true);
    pin.release();
  });

  it("pin() creates the state (with epoch) for a not-yet-emitted session", () => {
    const bus = createEventBus();
    const pin = bus.pin("sess-new");
    expect(pin.epoch).toBeDefined();

    bus.emit(makeMessage({ sessionId: "sess-new" }));
    const replay = bus.getEventsAfter("sess-new", 0);
    expect(replay.epoch).toBe(pin.epoch);
    expect(replay.events[0]!.id).toBe(`${pin.epoch}:1`);
    pin.release();
  });
});

describe("bounded persist queue (audit R-03)", () => {
  it("caps in-flight saves, drops oldest on queue overflow with a warning, and drains on flush", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending: Array<() => void> = [];
    const saveEvent = vi.fn(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const store = { saveEvent } as unknown as DataStore;
    const bus = createEventBus(store);

    const OVERFLOW = 5;
    const total = PERSIST_MAX_IN_FLIGHT + PERSIST_QUEUE_MAX + OVERFLOW;
    for (let i = 0; i < total; i += 1) {
      bus.emit(makeMessage({ id: `msg-${i}` }));
    }

    // Only the concurrency cap's worth of saves started; the rest queued.
    expect(saveEvent).toHaveBeenCalledTimes(PERSIST_MAX_IN_FLIGHT);
    // Overflow dropped the oldest queued saves and warned (rate-limited).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("persist queue full"),
    );

    const flushed = bus.flush();
    while (pending.length > 0) {
      for (const resolve of pending.splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await flushed;

    // Everything except the dropped overflow was persisted.
    expect(saveEvent).toHaveBeenCalledTimes(
      PERSIST_MAX_IN_FLIGHT + PERSIST_QUEUE_MAX,
    );
  });

  it("flush resolves immediately when nothing is pending", async () => {
    const bus = createEventBus();
    bus.emit(makeMessage());
    await expect(bus.flush()).resolves.toBeUndefined();
  });
});
