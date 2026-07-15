import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import { parseSubscriptionEventId } from "@covel/shared";
import { createEventBus, type EventBus } from "../src/event-bus.js";

/** Seq part of a `${epoch}:${seq}` wire id. */
const seqOf = (event: SubscriptionEvent): number =>
  parseSubscriptionEventId(event.id)!.seq;

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

describe("EventBus Subscription Features", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  describe("sequence numbering", () => {
    it("should assign incrementing sequence IDs to subscription events", () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((event) => events.push(event));

      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-1" }));

      expect(events).toHaveLength(3);
      expect(seqOf(events[0]!)).toBeLessThan(seqOf(events[1]!));
      expect(seqOf(events[1]!)).toBeLessThan(seqOf(events[2]!));
    });

    it("should use per-session sequence counters", () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((event) => events.push(event));

      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-2" }));
      bus.emit(makeMessage({ sessionId: "sess-1" }));

      const sess1Events = events.filter((e) => e.sessionId === "sess-1");
      const sess2Events = events.filter((e) => e.sessionId === "sess-2");

      expect(sess1Events).toHaveLength(2);
      expect(sess2Events).toHaveLength(1);
      // sess-1: first event should be seq 1, second should be seq 2
      expect(seqOf(sess1Events[0]!)).toBe(1);
      expect(seqOf(sess1Events[1]!)).toBe(2);
      // sess-2: first event should be seq 1
      expect(seqOf(sess2Events[0]!)).toBe(1);
    });
  });

  describe("getEventsAfter", () => {
    it("should return events after a given sequence number", () => {
      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-1" }));

      const after1 = bus.getEventsAfter("sess-1", 1);
      expect(after1.gap).toBe(false);
      expect(after1.events).toHaveLength(2);
      expect(seqOf(after1.events[0]!)).toBe(2);
      expect(seqOf(after1.events[1]!)).toBe(3);
    });

    it("should return no events when nothing is newer than the cursor", () => {
      bus.emit(makeMessage({ sessionId: "sess-1" }));

      const result = bus.getEventsAfter("sess-1", 1);
      expect(result.events).toHaveLength(0);
      expect(result.gap).toBe(false);
    });

    it("should signal a gap for unknown session", () => {
      const result = bus.getEventsAfter("unknown-session", 0);
      expect(result.events).toHaveLength(0);
      expect(result.gap).toBe(true);
      expect(result.epoch).toBeUndefined();
    });

    it("should return all events when afterSeq is 0", () => {
      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-1" }));

      const all = bus.getEventsAfter("sess-1", 0);
      expect(all.events).toHaveLength(2);
      expect(all.gap).toBe(false);
    });

    it("should signal a gap when the cursor is ahead of the latest seq", () => {
      bus.emit(makeMessage({ sessionId: "sess-1" }));

      const result = bus.getEventsAfter("sess-1", 99);
      expect(result.events).toHaveLength(0);
      expect(result.gap).toBe(true);
      expect(result.latestSeq).toBe(1);
    });
  });

  describe("onEmit", () => {
    it("should fire callback for every emitted event", () => {
      const callback = vi.fn();
      bus.onEmit(callback);

      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-2" }));

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("should provide a SubscriptionEvent with correct fields", () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((event) => events.push(event));

      bus.emit(
        makeMessage({
          sessionId: "sess-1",
          topic: "quest.completed",
          payload: { questId: "q-1" },
        }),
      );

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.sessionId).toBe("sess-1");
      expect(event.topic).toBe("quest.completed");
      expect(event.type).toBe("quest.completed");
      expect(event.payload).toEqual({ questId: "q-1" });
      expect(event.timestamp).toBeDefined();
      expect(seqOf(event)).toBe(1);
    });

    it("should support multiple onEmit callbacks", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      bus.onEmit(cb1);
      bus.onEmit(cb2);

      bus.emit(makeMessage());

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe("onEmit unsubscribe", () => {
    it("should stop callbacks after unsubscribe is called", () => {
      const callback = vi.fn();
      const unsubscribe = bus.onEmit(callback);

      bus.emit(makeMessage());
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.emit(makeMessage());
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("ring buffer overflow", () => {
    it("should drop oldest events and report the gap (H-05)", () => {
      // Emit 1050 events
      for (let i = 0; i < 1050; i++) {
        bus.emit(makeMessage({ sessionId: "sess-1" }));
      }

      // getEventsAfter(0) should return at most 1000 events
      const all = bus.getEventsAfter("sess-1", 0);
      expect(all.events.length).toBeLessThanOrEqual(1000);

      // The oldest events (seq 1-50) were dropped: the ring wrapped past the
      // cursor, so the replay is incomplete and must be flagged as a gap.
      expect(all.gap).toBe(true);
      expect(all.oldestSeq).toBe(51);
      expect(all.latestSeq).toBe(1050);
      expect(seqOf(all.events[0]!)).toBe(51);
      expect(seqOf(all.events[all.events.length - 1]!)).toBe(1050);

      // A cursor inside the retained window replays cleanly, no gap.
      const tail = bus.getEventsAfter("sess-1", 1040);
      expect(tail.gap).toBe(false);
      expect(tail.events).toHaveLength(10);

      // A cursor exactly at the retention boundary is still bridgeable.
      expect(bus.getEventsAfter("sess-1", 50).gap).toBe(false);
      // One before the boundary is not.
      expect(bus.getEventsAfter("sess-1", 49).gap).toBe(true);
    });
  });

  describe("multi-session isolation", () => {
    it("should maintain separate event buffers per session", () => {
      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-1" }));
      bus.emit(makeMessage({ sessionId: "sess-2" }));

      const sess1 = bus.getEventsAfter("sess-1", 0).events;
      const sess2 = bus.getEventsAfter("sess-2", 0).events;

      expect(sess1).toHaveLength(2);
      expect(sess2).toHaveLength(1);

      // All sess1 events should have sessionId 'sess-1'
      for (const event of sess1) {
        expect(event.sessionId).toBe("sess-1");
      }
      // All sess2 events should have sessionId 'sess-2'
      for (const event of sess2) {
        expect(event.sessionId).toBe("sess-2");
      }
    });
  });
});
