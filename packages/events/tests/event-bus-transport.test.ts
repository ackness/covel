import { describe, it, expect, vi } from "vitest";
import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import {
  createMemoryStore,
  type DataStore,
  type EventRecord,
} from "@covel/store";
import { createEventBus, type EventBusTransport } from "../src/event-bus.js";

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
