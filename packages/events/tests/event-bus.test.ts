import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CovelMessage } from "@covel/shared";
import { createEventBus, type EventBus } from "../src/event-bus.js";
import { createMemoryStore } from "@covel/store";

function makeMessage(overrides?: Partial<CovelMessage>): CovelMessage {
  return {
    id: "msg-1",
    type: "event",
    topic: "test.topic",
    payload: {},
    sessionId: "sess-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus(createMemoryStore());
  });

  describe("emit + on", () => {
    it("should call handler when subscribed topic is emitted", () => {
      const handler = vi.fn();
      bus.on("quest.completed", handler);

      const msg = makeMessage({ topic: "quest.completed" });
      bus.emit(msg);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should pass the exact message object to the handler", () => {
      const handler = vi.fn();
      bus.on("quest.completed", handler);

      const msg = makeMessage({
        topic: "quest.completed",
        payload: { questId: "q-1" },
      });
      bus.emit(msg);

      expect(handler).toHaveBeenCalledWith(msg);
    });

    it("should call multiple subscribers on the same topic", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.on("quest.completed", handler1);
      bus.on("quest.completed", handler2);

      bus.emit(makeMessage({ topic: "quest.completed" }));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should not call handler subscribed to a different topic", () => {
      const handler = vi.fn();
      bus.on("A", handler);

      bus.emit(makeMessage({ topic: "B" }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("should not call handler after unsubscribe", () => {
      const handler = vi.fn();
      const unsub = bus.on("quest.completed", handler);

      bus.emit(makeMessage({ topic: "quest.completed" }));
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();
      bus.emit(makeMessage({ topic: "quest.completed" }));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("once", () => {
    it("should fire handler only once", () => {
      const handler = vi.fn();
      bus.once("quest.completed", handler);

      bus.emit(makeMessage({ topic: "quest.completed" }));
      bus.emit(makeMessage({ topic: "quest.completed" }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPendingEvents", () => {
    it("should accumulate emitted events for a session", () => {
      const msg1 = makeMessage({ id: "msg-1", sessionId: "sess-1" });
      const msg2 = makeMessage({ id: "msg-2", sessionId: "sess-1" });
      bus.emit(msg1);
      bus.emit(msg2);

      const pending = bus.getPendingEvents("sess-1");
      expect(pending).toHaveLength(2);
      expect(pending).toContainEqual(msg1);
      expect(pending).toContainEqual(msg2);
    });

    it("should filter events by session id", () => {
      const msg1 = makeMessage({ id: "msg-1", sessionId: "sess-1" });
      const msg2 = makeMessage({ id: "msg-2", sessionId: "sess-2" });
      bus.emit(msg1);
      bus.emit(msg2);

      const pending = bus.getPendingEvents("sess-1");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual(msg1);
    });

    it("should return empty array for unknown session", () => {
      expect(bus.getPendingEvents("unknown")).toEqual([]);
    });
  });

  describe("acknowledge", () => {
    it("should remove acknowledged event from pending", () => {
      const msg = makeMessage({ id: "msg-1", sessionId: "sess-1" });
      bus.emit(msg);

      expect(bus.getPendingEvents("sess-1")).toHaveLength(1);

      bus.acknowledge("msg-1");

      expect(bus.getPendingEvents("sess-1")).toHaveLength(0);
    });

    it("should not throw when acknowledging unknown id", () => {
      expect(() => bus.acknowledge("nonexistent")).not.toThrow();
    });
  });

  describe("clearSession", () => {
    it("should remove all pending events for the session", () => {
      bus.emit(makeMessage({ id: "msg-1", sessionId: "sess-1" }));
      bus.emit(makeMessage({ id: "msg-2", sessionId: "sess-1" }));
      bus.emit(makeMessage({ id: "msg-3", sessionId: "sess-1" }));

      bus.clearSession("sess-1");

      expect(bus.getPendingEvents("sess-1")).toEqual([]);
    });

    it("M4: should clean up ring buffer and seq counter on clearSession", () => {
      // Emit some events to populate ring buffer and seq counter
      bus.emit(makeMessage({ id: "msg-1", sessionId: "sess-1" }));
      bus.emit(makeMessage({ id: "msg-2", sessionId: "sess-1" }));
      bus.emit(makeMessage({ id: "msg-3", sessionId: "sess-1" }));

      // Verify events exist in ring buffer
      expect(bus.getEventsAfter("sess-1", 0)).toHaveLength(3);

      bus.clearSession("sess-1");

      // Ring buffer should be empty after clearSession
      expect(bus.getEventsAfter("sess-1", 0)).toHaveLength(0);

      // After clearing, new events should start from seq 1 (reset counter)
      const events: import("@covel/shared").SubscriptionEvent[] = [];
      bus.onEmit((e) => events.push(e));
      bus.emit(makeMessage({ id: "msg-4", sessionId: "sess-1" }));
      expect(events[0]!.id).toBe("1");
    });
  });

  describe("wildcard support", () => {
    it("should call wildcard subscriber for any topic", () => {
      const handler = vi.fn();
      bus.on("*", handler);

      bus.emit(makeMessage({ topic: "quest.completed" }));
      bus.emit(makeMessage({ topic: "combat.started" }));

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("backward compatibility (no store)", () => {
    it("should work without a store parameter", () => {
      const noStoreBus = createEventBus();
      const handler = vi.fn();
      noStoreBus.on("test", handler);

      noStoreBus.emit(makeMessage({ topic: "test" }));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(noStoreBus.getPendingEvents("sess-1")).toHaveLength(1);
    });
  });

  describe("store persistence", () => {
    it("should call store.saveEvent when store is provided", async () => {
      const store = createMemoryStore();
      const storeBus = createEventBus(store);

      const msg = makeMessage({
        id: "msg-persist",
        sessionId: "sess-1",
        topic: "quest.completed",
      });
      storeBus.emit(msg);

      // Allow the fire-and-forget promise to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      const events = await store.listEvents("sess-1");
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe("msg-persist");
      expect(events[0]!.topic).toBe("quest.completed");
    });
  });
});
