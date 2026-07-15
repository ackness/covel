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

    expect(bus.getEventsAfter("sess-0", 0)).toEqual([]);
    expect(bus.getEventsAfter("sess-1", 0)).toHaveLength(1);
    expect(bus.getEventsAfter("sess-overflow", 0)).toHaveLength(1);
  });

  it("getEventsAfter refreshes LRU position so active sessions survive", () => {
    const bus = createEventBus();

    for (let i = 0; i < MAX_TRACKED_SESSIONS; i += 1) {
      bus.emit(makeMessage({ sessionId: `sess-${i}` }));
    }
    // Touch sess-0 — sess-1 becomes the LRU-oldest.
    bus.getEventsAfter("sess-0", 0);

    bus.emit(makeMessage({ sessionId: "sess-overflow" }));

    expect(bus.getEventsAfter("sess-0", 0)).toHaveLength(1);
    expect(bus.getEventsAfter("sess-1", 0)).toEqual([]);
  });

  it("restarts seq at 1 after eviction (replay returns empty, documented)", () => {
    const bus = createEventBus();

    bus.emit(makeMessage({ sessionId: "sess-evicted" }));
    for (let i = 0; i < MAX_TRACKED_SESSIONS; i += 1) {
      bus.emit(makeMessage({ sessionId: `filler-${i}` }));
    }
    expect(bus.getEventsAfter("sess-evicted", 0)).toEqual([]);

    // Re-emitting recreates the session state with a fresh counter.
    bus.emit(makeMessage({ sessionId: "sess-evicted" }));
    const events = bus.getEventsAfter("sess-evicted", 0);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("1");
    // A client holding a pre-eviction cursor gets an empty replay and must
    // fall back to a full state fetch.
    expect(bus.getEventsAfter("sess-evicted", 500)).toEqual([]);
  });

  it("evicts sessions idle beyond the TTL", () => {
    vi.useFakeTimers({ now: new Date("2026-07-15T00:00:00Z") });
    const bus = createEventBus();

    bus.emit(makeMessage({ sessionId: "sess-idle" }));
    vi.setSystemTime(Date.now() + SESSION_IDLE_TTL_MS + 1);
    // Any touch triggers the lazy sweep.
    bus.emit(makeMessage({ sessionId: "sess-fresh" }));

    expect(bus.getEventsAfter("sess-idle", 0)).toEqual([]);
    expect(bus.getEventsAfter("sess-fresh", 0)).toHaveLength(1);
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
