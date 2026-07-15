/**
 * `/api/events/stream` reset-protocol + resource-cleanup tests
 * (re-review H-05 / H-06 / H-08).
 *
 * - H-05: when replay cannot bridge the client's cursor (ring buffer wrapped,
 *   session evicted, foreign/legacy epoch), the server emits an id-less
 *   `system.reset` control frame instead of a silent partial replay.
 * - H-06: an epoch change (state re-created) is detected via the
 *   `${epoch}:${seq}` wire id and answered with `reason: "epoch-change"`.
 * - H-08: a throw during handshake/replay still releases the onEmit listener,
 *   the session pin, and the connection slot (single-finally cleanup).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Hono } from "hono";
import { createEventBus, RING_BUFFER_MAX, type EventBus } from "@covel/events";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  drain,
  emitSeq,
  isSystemFrame,
  makeApp,
  seedSession,
  type Frame,
} from "./sse-test-utils.js";

const SESSION_ID = "sess-reset";

function findReset(frames: Frame[]): Frame | undefined {
  return frames.find((f) => f.event === "system.reset");
}

function nonControlFrames(frames: Frame[]): Frame[] {
  return frames.filter((f) => !isSystemFrame(f) && f.event !== "system.reset");
}

/**
 * Wrap a bus with listener/pin accounting (and optional method overrides) so
 * tests can assert that the route's cleanup path releases everything.
 */
function instrumentBus(
  bus: EventBus,
  overrides?: Partial<EventBus>,
): { bus: EventBus; counts: () => { listeners: number; pins: number } } {
  let listeners = 0;
  let pins = 0;
  const wrapped: EventBus = {
    ...bus,
    onEmit(cb) {
      listeners += 1;
      const unsub = bus.onEmit(cb);
      return () => {
        listeners -= 1;
        unsub();
      };
    },
    pin(sessionId) {
      pins += 1;
      const pin = bus.pin(sessionId);
      return {
        epoch: pin.epoch,
        release: () => {
          pins -= 1;
          pin.release();
        },
      };
    },
    ...overrides,
  };
  return { bus: wrapped, counts: () => ({ listeners, pins }) };
}

async function requestFrames(
  app: Hono,
  lastEventId: string,
  deadlineMs = 400,
): Promise<Frame[]> {
  const ac = new AbortController();
  try {
    const res = await app.request(
      `/api/events/stream?sessionId=${SESSION_ID}&topics=state&lastEventId=${encodeURIComponent(lastEventId)}`,
      { signal: ac.signal },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const frames = await drain(reader, { deadlineMs });
    await reader.cancel().catch(() => {});
    return frames;
  } finally {
    ac.abort();
  }
}

describe("H-05/H-06 system.reset control frame", () => {
  let store: DataStore;
  let eventBus: EventBus;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    eventBus = createEventBus();
    app = makeApp(store, eventBus);
    await seedSession(store, SESSION_ID);
  });

  it("emits reason=epoch-change for a foreign-epoch cursor and skips replay", async () => {
    for (let n = 1; n <= 3; n++) emitSeq(eventBus, SESSION_ID, "state", n);
    const currentEpoch = eventBus.getEventsAfter(SESSION_ID, 3).epoch!;

    const frames = await requestFrames(app, "deadbeef-99:2");

    const reset = findReset(frames);
    expect(reset).toBeDefined();
    // Control frames never carry an SSE id (cursor-clobber guard).
    expect(reset!.id).toBeUndefined();
    const data = JSON.parse(reset!.data!) as Record<string, unknown>;
    expect(data.reason).toBe("epoch-change");
    expect(data.sessionId).toBe(SESSION_ID);
    expect(data.epoch).toBe(currentEpoch);
    expect(data.oldestSeq).toBe(1);
    expect(data.latestSeq).toBe(3);
    // A reset replaces replay — no stale event frames alongside it.
    expect(nonControlFrames(frames)).toHaveLength(0);
  });

  it("emits reason=epoch-change for a legacy plain-number cursor", async () => {
    for (let n = 1; n <= 2; n++) emitSeq(eventBus, SESSION_ID, "state", n);

    const frames = await requestFrames(app, "2");

    const reset = findReset(frames);
    expect(reset).toBeDefined();
    expect((JSON.parse(reset!.data!) as Record<string, unknown>).reason).toBe(
      "epoch-change",
    );
    expect(nonControlFrames(frames)).toHaveLength(0);
  });

  it("emits reason=gap when the ring buffer wrapped past the cursor", async () => {
    const TOTAL = RING_BUFFER_MAX + 10;
    for (let n = 1; n <= TOTAL; n++) emitSeq(eventBus, SESSION_ID, "state", n);
    const epoch = eventBus.getEventsAfter(SESSION_ID, TOTAL).epoch!;

    const frames = await requestFrames(app, `${epoch}:1`);

    const reset = findReset(frames);
    expect(reset).toBeDefined();
    const data = JSON.parse(reset!.data!) as Record<string, unknown>;
    expect(data.reason).toBe("gap");
    expect(data.epoch).toBe(epoch);
    expect(data.oldestSeq).toBe(TOTAL - RING_BUFFER_MAX + 1);
    expect(data.latestSeq).toBe(TOTAL);
    expect(nonControlFrames(frames)).toHaveLength(0);
  });

  it("does not reset for a bridgeable same-epoch cursor — replays instead", async () => {
    for (let n = 1; n <= 5; n++) emitSeq(eventBus, SESSION_ID, "state", n);
    const epoch = eventBus.getEventsAfter(SESSION_ID, 5).epoch!;

    const frames = await requestFrames(app, `${epoch}:3`);

    expect(findReset(frames)).toBeUndefined();
    const replayed = nonControlFrames(frames);
    expect(replayed.map((f) => f.id)).toEqual([`${epoch}:4`, `${epoch}:5`]);
  });
});

describe("H-08 cleanup on handshake/replay failure", () => {
  let store: DataStore;
  let eventBus: EventBus;

  beforeEach(async () => {
    store = createMemoryStore();
    eventBus = createEventBus();
    await seedSession(store, SESSION_ID);
  });

  it("a throw during replay still unsubscribes the listener and releases the pin", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bus, counts } = instrumentBus(eventBus, {
      getEventsAfter() {
        throw new Error("replay boom");
      },
    });
    const app = makeApp(store, bus);

    const res = await app.request(
      `/api/events/stream?sessionId=${SESSION_ID}&lastEventId=${encodeURIComponent("some-epoch:1")}`,
    );
    expect(res.status).toBe(200);
    // The handler's finally must have run by stream close — read to the end.
    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    await vi.waitFor(() => {
      expect(counts()).toEqual({ listeners: 0, pins: 0 });
    });
    // The route logged the failure with session context.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(SESSION_ID),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("normal connect/disconnect releases the listener and pin too", async () => {
    const { bus, counts } = instrumentBus(eventBus);
    const app = makeApp(store, bus);

    const ac = new AbortController();
    const res = await app.request(
      `/api/events/stream?sessionId=${SESSION_ID}`,
      { signal: ac.signal },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await drain(reader, { deadlineMs: 100 });
    expect(counts()).toEqual({ listeners: 1, pins: 1 });

    ac.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => {
      expect(counts()).toEqual({ listeners: 0, pins: 0 });
    });
  });
});
