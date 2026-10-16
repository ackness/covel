import { describe, expect, it, vi } from "vitest";
import { createEventBus, type EventBusTransport } from "../src/event-bus.js";
import type { EventStoreRecord } from "../src/event-store.js";
import type { CovelMessage, SubscriptionEvent } from "@covel/shared";

function message(
  incarnation: string,
  payload: Record<string, unknown> = {},
): CovelMessage {
  return {
    id: crypto.randomUUID(),
    type: "event",
    topic: "state",
    sessionId: "same-id",
    sessionIncarnation: incarnation,
    timestamp: new Date().toISOString(),
    payload,
  };
}

describe("F-201 event incarnation transport", () => {
  it("preserves captured tags for inline/ref events and ordered invalidation", async () => {
    const handlers = new Set<(frame: string) => void>();
    const transport = (): EventBusTransport => ({
      publish(frame) {
        for (const receive of handlers) receive(frame);
      },
      subscribe(receive) {
        handlers.add(receive);
        return () => {
          handlers.delete(receive);
        };
      },
    });
    const records = new Map<string, EventStoreRecord>();
    const store = {
      async saveEvent(record: EventStoreRecord) {
        records.set(record.id, record);
      },
      async getEventById(_session: string, id: string) {
        return records.get(id) ?? null;
      },
    };
    const a = createEventBus(store, {
      transport: transport(),
      requireSessionIncarnation: true,
      strictEmissions: true,
    });
    const b = createEventBus(store, {
      transport: transport(),
      requireSessionIncarnation: true,
      strictEmissions: true,
    });
    const delivered: SubscriptionEvent[] = [];
    b.onEmit((event) => delivered.push(event));
    try {
      a.emit(message("old", { secret: "x".repeat(10000) }));
      a.emit(
        message("old", {
          _subType: "session.invalidated",
          ignored: "x".repeat(10000),
        }),
      );
      a.emit(message("new", { value: "replacement" }));
      await vi.waitFor(() => expect(delivered).toHaveLength(3));
      expect(
        delivered.map((event) => [event.sessionIncarnation, event.type]),
      ).toEqual([
        ["old", "state"],
        ["old", "session.invalidated"],
        ["new", "state"],
      ]);
      expect(delivered[0]?.payload.secret).toBe("x".repeat(10000));
      expect(delivered[1]?.payload).toEqual({});
      expect(records.size).toBe(1);
      expect(b.getEventsAfter("same-id", 0).events).toEqual(delivered);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it.each([false, true])(
    "rejects untagged remote content in a session-serving bus (mixed ref=%s)",
    async (mixedRef) => {
      let receive = (_frame: string) => {};
      const bus = createEventBus(undefined, {
        requireSessionIncarnation: true,
        strictEmissions: true,
        transport: {
          publish() {},
          subscribe(handler) {
            receive = handler;
          },
        },
      });
      const delivered = vi.fn();
      const reset = vi.fn();
      bus.onEmit(delivered);
      bus.onReset!(reset);
      receive(
        JSON.stringify({
          origin: "other",
          stream: "generation",
          seq: 1,
          ...(mixedRef
            ? {
                ref: {
                  sessionId: "same-id",
                  eventId: "ref",
                  sessionIncarnation: "current",
                },
              }
            : {}),
          event: {
            id: "other:1",
            sessionId: "same-id",
            topic: "state",
            type: "state.changed",
            payload: { secret: true },
          },
        }),
      );
      expect(delivered).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalledOnce();
      await bus.close();
    },
  );

  it("invalidates pinned replay on transport loss even without a later sequence gap", async () => {
    let loss = () => {};
    const off = vi.fn();
    const bus = createEventBus(undefined, {
      transport: {
        publish() {},
        subscribe() {},
        onReset(handler) {
          loss = handler;
          return off;
        },
      },
    });
    const pin = bus.pin("same-id");
    const reset = vi.fn();
    bus.onReset!(reset);
    bus.emit(message("current"));
    loss();
    expect(reset).toHaveBeenCalledExactlyOnceWith({ reason: "transport-gap" });
    expect(bus.getEventsAfter("same-id", 0).epoch).not.toBe(pin.epoch);
    expect(bus.getEventsAfter("same-id", 0).events).toEqual([]);
    pin.release();
    await bus.close();
    expect(off).toHaveBeenCalledOnce();
  });
});
