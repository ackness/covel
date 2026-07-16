import { describe, it, expect, vi } from "vitest";
import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import {
  createMemoryStore,
  type DataStore,
  type EventRecord,
} from "@covel/store";
import {
  createEventBus,
  RECEIVE_GAP_FLUSH_MS,
  RECEIVE_STATES_MAX,
  TRANSPORT_HEARTBEAT_MS,
  type EventBusTransport,
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

/**
 * In-memory stand-in for PG LISTEN/NOTIFY: every published payload is
 * delivered to ALL connected handlers, including the publisher's own
 * (NOTIFY does this too — exercises the origin/self-echo filter).
 */
function createHub() {
  const handlers = new Set<(payload: string) => void>();
  return {
    broadcast(payload: string): void {
      for (const handler of handlers) handler(payload);
    },
    connect(): EventBusTransport {
      return {
        publish: (payload) => {
          for (const handler of handlers) handler(payload);
        },
        subscribe: (handler) => {
          handlers.add(handler);
        },
      };
    },
  };
}

describe("EventBus transport fan-out (audit R-02)", () => {
  it("delivers an emit on bus A to subscribers and replay buffer of bus B", async () => {
    const hub = createHub();
    const busA = createEventBus(undefined, { transport: hub.connect() });
    const busB = createEventBus(undefined, { transport: hub.connect() });
    const receivedB: SubscriptionEvent[] = [];
    busB.onEmit((event) => receivedB.push(event));

    busA.emit(
      makeMessage({
        sessionId: "sess-x",
        topic: "quest.completed",
        payload: { questId: "q-1" },
      }),
    );

    // Frames publish via the per-session serialized outbox (async).
    await vi.waitFor(() => expect(receivedB).toHaveLength(1));
    expect(receivedB[0]!.sessionId).toBe("sess-x");
    expect(receivedB[0]!.topic).toBe("quest.completed");
    expect(receivedB[0]!.payload).toEqual({ questId: "q-1" });
    // B assigns its own (per-pod, per-epoch) sequence id.
    expect(receivedB[0]!.id.endsWith(":1")).toBe(true);
    // The event is also in B's replay buffer.
    expect(busB.getEventsAfter("sess-x", 0).events).toHaveLength(1);
  });

  it("filters self-echoed frames — local subscribers fire exactly once", async () => {
    const hub = createHub();
    const busA = createEventBus(undefined, { transport: hub.connect() });
    const receivedA = vi.fn();
    busA.onEmit(receivedA);

    busA.emit(makeMessage({ sessionId: "sess-echo" }));

    // Let the async outbox publish (and self-echo) settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receivedA).toHaveBeenCalledTimes(1);
    expect(busA.getEventsAfter("sess-echo", 0).events).toHaveLength(1);
  });

  it("fans out oversize events as store refs after persistence", async () => {
    const hub = createHub();
    const store = createMemoryStore(); // shared, like a shared PG database
    const busA = createEventBus(store, { transport: hub.connect() });
    const busB = createEventBus(store, { transport: hub.connect() });
    const receivedB: SubscriptionEvent[] = [];
    busB.onEmit((event) => receivedB.push(event));

    const bigPayload = { blob: "x".repeat(10_000) }; // > 7500-byte inline cap
    busA.emit(
      makeMessage({
        id: "msg-big",
        sessionId: "sess-big",
        topic: "asset.ready",
        payload: bigPayload,
      }),
    );
    await busA.flush(); // ref frame publishes only after saveEvent settles

    await vi.waitFor(() => expect(receivedB).toHaveLength(1));
    expect(receivedB[0]!.sessionId).toBe("sess-big");
    expect(receivedB[0]!.topic).toBe("asset.ready");
    expect(receivedB[0]!.payload).toEqual(bigPayload);
    expect(busB.getEventsAfter("sess-big", 0).events).toHaveLength(1);
  });

  it("delivers oversize-then-inline frames in seq order (re-review H-07)", async () => {
    const hub = createHub();
    const shared = createMemoryStore();
    // Gate the oversize save so the inline event provably arrives while the
    // ref frame is still waiting on persistence — the old code published the
    // inline frame immediately and receivers observed E2 before E1.
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const gatedStore = {
      ...shared,
      async saveEvent(record: EventRecord): Promise<void> {
        if (record.id === "msg-big") await saveGate;
        await shared.saveEvent(record);
      },
    } as DataStore;
    const busA = createEventBus(gatedStore, { transport: hub.connect() });
    const busB = createEventBus(shared, { transport: hub.connect() });
    const receivedB: SubscriptionEvent[] = [];
    busB.onEmit((event) => receivedB.push(event));

    busA.emit(
      makeMessage({
        id: "msg-big",
        sessionId: "sess-ord",
        topic: "big.first",
        payload: { blob: "x".repeat(10_000) },
      }),
    );
    busA.emit(
      makeMessage({
        id: "msg-small",
        sessionId: "sess-ord",
        topic: "small.second",
        payload: { n: 2 },
      }),
    );

    // The inline frame is queued behind the pending ref — nothing crosses yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(receivedB).toHaveLength(0);

    releaseSave();
    await vi.waitFor(() => expect(receivedB).toHaveLength(2));
    expect(receivedB.map((e) => e.topic)).toEqual([
      "big.first",
      "small.second",
    ]);
    expect(receivedB.map((e) => e.id.split(":")[1])).toEqual(["1", "2"]);
  });

  it("keeps transport ordering independent from bidirectional local replay", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hub = createHub();
    const busA = createEventBus(undefined, { transport: hub.connect() });
    const busB = createEventBus(undefined, { transport: hub.connect() });
    const receivedA: SubscriptionEvent[] = [];
    const receivedB: SubscriptionEvent[] = [];
    busA.onEmit((event) => receivedA.push(event));
    busB.onEmit((event) => receivedB.push(event));

    busA.emit(
      makeMessage({
        sessionId: "sess-duplex",
        topic: "state",
        payload: { _subType: "a.first" },
      }),
    );
    await vi.waitFor(() =>
      expect(receivedB.some((event) => event.type === "a.first")).toBe(true),
    );
    busB.emit(
      makeMessage({
        sessionId: "sess-duplex",
        topic: "runtime",
        payload: { _subType: "b.reply" },
      }),
    );
    await vi.waitFor(() =>
      expect(receivedA.some((event) => event.type === "b.reply")).toBe(true),
    );
    busA.emit(
      makeMessage({
        sessionId: "sess-duplex",
        topic: "state",
        payload: { _subType: "a.second" },
      }),
    );

    await vi.waitFor(() =>
      expect(receivedB.map((event) => event.type)).toEqual([
        "a.first",
        "b.reply",
        "a.second",
      ]),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("transport seq gap"),
    );
    warnSpy.mockRestore();
  });

  it("order-buffers out-of-order frames by origin seq (re-review H-07)", async () => {
    const hub = createHub();
    const bus = createEventBus(undefined, { transport: hub.connect() });
    const received: SubscriptionEvent[] = [];
    bus.onEmit((event) => received.push(event));

    const mkFrame = (seq: number): string =>
      JSON.stringify({
        origin: "remote-pod",
        seq,
        event: {
          id: `remote:${seq}`,
          topic: "test.topic",
          type: `t${seq}`,
          sessionId: "sess-reorder",
          timestamp: new Date().toISOString(),
          payload: {},
        },
      });

    hub.broadcast(mkFrame(1));
    hub.broadcast(mkFrame(3)); // parked — predecessor missing
    hub.broadcast(mkFrame(2)); // releases 2, then drains 3

    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.map((e) => e.type)).toEqual(["t1", "t2", "t3"]);

    // A duplicate/late frame is dropped, not re-delivered.
    hub.broadcast(mkFrame(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(3);
  });

  it("invalidates local replay when a real transport seq hole is skipped", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = createHub();
      const bus = createEventBus(undefined, { transport: hub.connect() });
      const resets: Array<{ sessionId: string; reason: string }> = [];
      bus.onReset?.((reset) => resets.push(reset));

      const mkFrame = (seq: number): string =>
        JSON.stringify({
          origin: "remote-with-hole",
          stream: "boot-1",
          seq,
          event: {
            id: `remote:${seq}`,
            topic: "state",
            type: `t${seq}`,
            sessionId: "sess-gap",
            timestamp: new Date().toISOString(),
            payload: {},
          },
        });

      hub.broadcast(mkFrame(1));
      await vi.advanceTimersByTimeAsync(0);
      const before = bus.getEventsAfter("sess-gap", 0);
      expect(before.events.map((event) => event.type)).toEqual(["t1"]);

      hub.broadcast(mkFrame(3));
      await vi.advanceTimersByTimeAsync(RECEIVE_GAP_FLUSH_MS);

      expect(resets).toEqual([
        { sessionId: "sess-gap", reason: "transport-gap" },
      ]);
      const after = bus.getEventsAfter("sess-gap", 0);
      expect(after.epoch).not.toBe(before.epoch);
      expect(after.events.map((event) => event.type)).toEqual(["t3"]);
      expect(after.events[0]!.id.endsWith(":1")).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("detects a missing first frame in a new transport stream", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = createHub();
      const bus = createEventBus(undefined, { transport: hub.connect() });
      const received: SubscriptionEvent[] = [];
      const resets: Array<{ sessionId: string; reason: string }> = [];
      bus.onEmit((event) => received.push(event));
      bus.onReset?.((reset) => resets.push(reset));

      hub.broadcast(
        JSON.stringify({
          origin: "remote-missing-first",
          stream: "boot-1",
          seq: 2,
          event: {
            id: "remote:2",
            topic: "state",
            type: "t2",
            sessionId: "sess-first-gap",
            timestamp: new Date().toISOString(),
            payload: {},
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(received).toEqual([]);
      expect(resets).toEqual([]);

      await vi.advanceTimersByTimeAsync(RECEIVE_GAP_FLUSH_MS);
      expect(resets).toEqual([
        { sessionId: "sess-first-gap", reason: "transport-gap" },
      ]);
      expect(received.map((event) => event.type)).toEqual(["t2"]);
      expect(received[0]!.id.endsWith(":1")).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("revalidates seq 1 after a transport receive state is evicted", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = createHub();
      const bus = createEventBus(undefined, { transport: hub.connect() });
      const targetEvents: SubscriptionEvent[] = [];
      const resets: Array<{ sessionId: string; reason: string }> = [];
      bus.onEmit((event) => {
        if (event.type.startsWith("target-")) targetEvents.push(event);
      });
      bus.onReset?.((reset) => resets.push(reset));

      const frame = (stream: string, seq: number, type: string): string =>
        JSON.stringify({
          origin: "remote-state-pressure",
          stream,
          seq,
          event: {
            id: `${stream}:${seq}`,
            topic: "state",
            type,
            sessionId: "sess-state-pressure",
            timestamp: new Date().toISOString(),
            payload: {},
          },
        });

      hub.broadcast(frame("evicted-stream", 1, "target-1"));
      for (let i = 0; i < RECEIVE_STATES_MAX; i += 1) {
        hub.broadcast(frame(`filler-${i}`, 1, `filler-${i}`));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(targetEvents.map((event) => event.type)).toEqual(["target-1"]);

      // The stream's old receive state is gone. Its next observed frame must
      // re-establish continuity from seq 1; accepting seq 2 would hide a gap.
      hub.broadcast(frame("evicted-stream", 2, "target-2"));
      await vi.advanceTimersByTimeAsync(0);
      expect(targetEvents.map((event) => event.type)).toEqual(["target-1"]);
      expect(resets).toEqual([]);

      await vi.advanceTimersByTimeAsync(RECEIVE_GAP_FLUSH_MS);
      expect(resets).toEqual([
        { sessionId: "sess-state-pressure", reason: "transport-gap" },
      ]);
      expect(targetEvents.map((event) => event.type)).toEqual([
        "target-1",
        "target-2",
      ]);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ignores malformed transport frames and keeps working", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hub = createHub();
    const busA = createEventBus(undefined, { transport: hub.connect() });
    const received = vi.fn();
    busA.onEmit(received);

    hub.broadcast("not-json");
    hub.broadcast(JSON.stringify({ noOrigin: true }));
    hub.broadcast(JSON.stringify({ origin: "other", event: { bad: 1 } }));
    expect(received).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    busA.emit(makeMessage({ sessionId: "sess-ok" }));
    expect(received).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("EventBus transport heartbeat (audit 2026-07-16 M-1)", () => {
  const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

  const realFrame = (seq: number, sessionId: string, type: string): string =>
    JSON.stringify({
      origin: "remote-hb",
      stream: "boot-1",
      seq,
      event: {
        id: `remote:${seq}`,
        topic: "state",
        type,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: {},
      },
    });

  const heartbeat = (seq: number, sessionId: string): string =>
    JSON.stringify({
      origin: "remote-hb",
      stream: "boot-1",
      seq,
      heartbeat: true,
      sessionId,
    });

  it("resets when a heartbeat reveals a lost tail frame", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = createHub();
      const bus = createEventBus(undefined, { transport: hub.connect() });
      const received: SubscriptionEvent[] = [];
      const resets: Array<{ sessionId: string; reason: string }> = [];
      bus.onEmit((event) => received.push(event));
      bus.onReset?.((reset) => resets.push(reset));

      // Frame 1 arrives; the receiver is caught up (expects seq 2 next).
      hub.broadcast(realFrame(1, "sess-tail", "t1"));
      await flushMicrotasks();
      expect(received.map((e) => e.type)).toEqual(["t1"]);
      expect(resets).toEqual([]);

      // Frame 2 is lost. A heartbeat announces the sender's high-water = 2,
      // so the receiver must detect the hole and reset (no successor frame
      // would otherwise ever trip the gap path).
      hub.broadcast(heartbeat(2, "sess-tail"));
      await flushMicrotasks();
      expect(resets).toEqual([
        { sessionId: "sess-tail", reason: "transport-gap" },
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not reset when a heartbeat matches an already-delivered stream", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = createHub();
      const bus = createEventBus(undefined, { transport: hub.connect() });
      const resets: Array<{ sessionId: string; reason: string }> = [];
      bus.onReset?.((reset) => resets.push(reset));

      hub.broadcast(realFrame(1, "sess-live", "t1"));
      hub.broadcast(realFrame(2, "sess-live", "t2"));
      await flushMicrotasks();

      // Caught up: expected is 3, heartbeat high-water is 2 → no gap.
      hub.broadcast(heartbeat(2, "sess-live"));
      await flushMicrotasks();
      expect(resets).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not false-reset when an emit races the heartbeat tick (capture-at-enqueue)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const published: string[] = [];
      const hub = createHub();
      const inner = hub.connect();
      const recording: EventBusTransport = {
        publish: (payload) => {
          published.push(payload);
          return inner.publish(payload);
        },
        subscribe: inner.subscribe,
      };
      const busA = createEventBus(undefined, { transport: recording });
      const busB = createEventBus(undefined, { transport: hub.connect() });
      const receivedB: SubscriptionEvent[] = [];
      const resetsB: Array<{ sessionId: string; reason: string }> = [];
      busB.onEmit((event) => receivedB.push(event));
      busB.onReset?.((reset) => resetsB.push(reset));

      // Frame 1 delivered; B is caught up.
      busA.emit(makeMessage({ sessionId: "sess-race", topic: "a" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(receivedB).toHaveLength(1);

      // Heartbeat tick fires (captures seq 1), THEN a second emit lands before
      // the outbox microtasks flush — the exact race the fix targets.
      vi.advanceTimersByTime(TRANSPORT_HEARTBEAT_MS);
      busA.emit(makeMessage({ sessionId: "sess-race", topic: "b" }));
      await vi.advanceTimersByTimeAsync(0);

      // The heartbeat must carry seq 1 (not the raced 2), so B sees no gap and
      // still receives frame 2.
      const hb = published
        .map((p) => JSON.parse(p) as Record<string, unknown>)
        .find((f) => f.heartbeat === true);
      expect(hb).toMatchObject({ seq: 1 });
      expect(resetsB).toEqual([]);
      expect(receivedB).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("periodically publishes a heartbeat carrying the high-water seq", async () => {
    vi.useFakeTimers();
    try {
      const published: string[] = [];
      const hub = createHub();
      const inner = hub.connect();
      const recording: EventBusTransport = {
        publish: (payload) => {
          published.push(payload);
          return inner.publish(payload);
        },
        subscribe: inner.subscribe,
      };
      const busA = createEventBus(undefined, { transport: recording });

      busA.emit(makeMessage({ sessionId: "sess-hb" }));
      await vi.advanceTimersByTimeAsync(0); // flush the real frame's outbox
      published.length = 0;

      await vi.advanceTimersByTimeAsync(TRANSPORT_HEARTBEAT_MS);
      const hb = published
        .map((p) => JSON.parse(p) as Record<string, unknown>)
        .find((f) => f.heartbeat === true);
      expect(hb).toMatchObject({
        heartbeat: true,
        sessionId: "sess-hb",
        seq: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
