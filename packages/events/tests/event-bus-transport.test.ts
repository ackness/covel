import { describe, it, expect, vi } from "vitest";
import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
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
  it("delivers an emit on bus A to subscribers and replay buffer of bus B", () => {
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

    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]!.sessionId).toBe("sess-x");
    expect(receivedB[0]!.topic).toBe("quest.completed");
    expect(receivedB[0]!.payload).toEqual({ questId: "q-1" });
    // B assigns its own (per-pod) sequence id.
    expect(receivedB[0]!.id).toBe("1");
    // The event is also in B's replay buffer.
    expect(busB.getEventsAfter("sess-x", 0)).toHaveLength(1);
  });

  it("filters self-echoed frames — local subscribers fire exactly once", () => {
    const hub = createHub();
    const busA = createEventBus(undefined, { transport: hub.connect() });
    const receivedA = vi.fn();
    busA.onEmit(receivedA);

    busA.emit(makeMessage({ sessionId: "sess-echo" }));

    expect(receivedA).toHaveBeenCalledTimes(1);
    expect(busA.getEventsAfter("sess-echo", 0)).toHaveLength(1);
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
    expect(busB.getEventsAfter("sess-big", 0)).toHaveLength(1);
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
