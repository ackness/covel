import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CovelMessage, SubscriptionEvent } from "@covel/shared";
import { parseSubscriptionEventId } from "@covel/shared";
import { createEventBus, type EventBus } from "../src/event-bus.js";
import { createMemoryStore } from "@covel/store";

/** Seq part of a `${epoch}:${seq}` wire id. */
const seqOf = (event: SubscriptionEvent): number =>
  parseSubscriptionEventId(event.id)!.seq;

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

  describe("onEmit", () => {
    it("should call callback for every emitted event", () => {
      const cb = vi.fn();
      bus.onEmit(cb);

      bus.emit(makeMessage({ topic: "quest.completed" }));
      bus.emit(makeMessage({ topic: "combat.started" }));

      expect(cb).toHaveBeenCalledTimes(2);
    });

    it("should not call callback after unsubscribe", () => {
      const cb = vi.fn();
      const unsub = bus.onEmit(cb);

      bus.emit(makeMessage({ topic: "quest.completed" }));
      expect(cb).toHaveBeenCalledTimes(1);

      unsub();
      bus.emit(makeMessage({ topic: "quest.completed" }));
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("should assign per-session monotonic epoch:seq ids", () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((e) => events.push(e));

      bus.emit(makeMessage({ id: "a", sessionId: "sess-1" }));
      bus.emit(makeMessage({ id: "b", sessionId: "sess-2" }));
      bus.emit(makeMessage({ id: "c", sessionId: "sess-1" }));

      expect(events.map((e) => [e.sessionId, seqOf(e)])).toEqual([
        ["sess-1", 1],
        ["sess-2", 1],
        ["sess-1", 2],
      ]);
      // Distinct sessions get distinct epochs; a session keeps its epoch.
      const epochOf = (e: SubscriptionEvent) =>
        parseSubscriptionEventId(e.id)!.epoch;
      expect(epochOf(events[0]!)).toBe(epochOf(events[2]!));
      expect(epochOf(events[0]!)).not.toBe(epochOf(events[1]!));
    });

    it("should honor _subTopic/_subType payload overrides and strip them", () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((e) => events.push(e));

      bus.emit(
        makeMessage({
          topic: "raw.topic",
          payload: { _subTopic: "plugin-data", _subType: "x.changed", k: 1 },
        }),
      );

      expect(events[0]!.topic).toBe("plugin-data");
      expect(events[0]!.type).toBe("x.changed");
      expect(events[0]!.payload).toEqual({ k: 1 });
    });
  });

  describe("getEventsAfter (SSE replay)", () => {
    it("should return events after the given sequence number", () => {
      bus.emit(makeMessage({ id: "msg-1", sessionId: "sess-1" }));
      bus.emit(makeMessage({ id: "msg-2", sessionId: "sess-1" }));
      bus.emit(makeMessage({ id: "msg-3", sessionId: "sess-1" }));

      expect(bus.getEventsAfter("sess-1", 0).events).toHaveLength(3);
      expect(bus.getEventsAfter("sess-1", 2).events).toHaveLength(1);
      expect(bus.getEventsAfter("sess-1", 3).events).toHaveLength(0);
      // Complete replays report no gap and the retained range.
      const replay = bus.getEventsAfter("sess-1", 2);
      expect(replay.gap).toBe(false);
      expect(replay.oldestSeq).toBe(1);
      expect(replay.latestSeq).toBe(3);
      expect(replay.epoch).toBeDefined();
    });

    it("should signal a gap for an unknown session (H-05)", () => {
      expect(bus.getEventsAfter("unknown", 0)).toEqual({
        events: [],
        gap: true,
        epoch: undefined,
        oldestSeq: 0,
        latestSeq: 0,
      });
    });
  });

  describe("backward compatibility (no store)", () => {
    it("should work without a store parameter", () => {
      const noStoreBus = createEventBus();
      const cb = vi.fn();
      noStoreBus.onEmit(cb);

      noStoreBus.emit(makeMessage({ topic: "test" }));

      expect(cb).toHaveBeenCalledTimes(1);
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

  describe("flush (durability barrier)", () => {
    it("awaits in-flight audit-event persistence", async () => {
      const store = createMemoryStore();
      const storeBus = createEventBus(store);
      storeBus.emit(
        makeMessage({
          id: "msg-flush",
          sessionId: "sess-f",
          topic: "quest.completed",
        }),
      );

      // flush() resolves only after the save settles — no timeout race.
      await storeBus.flush();

      const events = await store.listEvents("sess-f");
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe("msg-flush");
    });

    it("resolves as a no-op when there is no store", async () => {
      const noStoreBus = createEventBus();
      noStoreBus.emit(makeMessage({ topic: "x" }));
      await expect(noStoreBus.flush()).resolves.toBeUndefined();
    });
  });
});
