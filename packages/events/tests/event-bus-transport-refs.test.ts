import { describe, expect, it, vi } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "../src/event-bus.js";

describe("EventBus transport ref failures", () => {
  it.each(["missing", "read-error", "no-store", "foreign-session"] as const)(
    "invalidates replay before delivering successors when a ref has %s",
    async (failure) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const backing = createMemoryStore();
        if (failure === "foreign-session") {
          await backing.saveEvent({
            id: "unavailable",
            sessionId: "other-session",
            type: "event",
            topic: "state",
            payload: { text: "Another session's private event" },
            createdAt: "2026-09-06T00:00:00.000Z",
          });
        }
        const store: DataStore | undefined =
          failure === "no-store"
            ? undefined
            : {
                ...backing,
                async getEventById(sessionId, id) {
                  if (failure === "read-error") {
                    throw new Error("ref read failed");
                  }
                  return backing.getEventById(sessionId, id);
                },
              };
        let receive!: (payload: string) => void;
        const bus = createEventBus(store, {
          transport: {
            publish() {},
            subscribe(handler) {
              receive = handler;
            },
          },
        });
        const observed: string[] = [];
        bus.onEmit((event) => observed.push(event.type));
        bus.onReset?.((reset) => {
          expect(reset).toEqual({
            sessionId: "sess-ref",
            reason: "transport-gap",
          });
          observed.push("reset");
        });

        const inlineFrame = (seq: number): string =>
          JSON.stringify({
            origin: "remote-ref",
            stream: "boot-1",
            seq,
            event: {
              id: `remote:${seq}`,
              topic: "state",
              type: `t${seq}`,
              sessionId: "sess-ref",
              timestamp: "2026-09-06T00:00:00.000Z",
              payload: {},
            },
          });

        receive(inlineFrame(1));
        await vi.waitFor(() => expect(observed).toEqual(["t1"]));
        const before = bus.getEventsAfter("sess-ref", 0);

        receive(
          JSON.stringify({
            origin: "remote-ref",
            stream: "boot-1",
            seq: 2,
            ref: { sessionId: "sess-ref", eventId: "unavailable" },
          }),
        );
        receive(inlineFrame(3));

        await vi.waitFor(() => expect(observed).toEqual(["t1", "reset", "t3"]));
        const after = bus.getEventsAfter("sess-ref", 0);
        expect(after.epoch).not.toBe(before.epoch);
        expect(after.events.map((event) => event.type)).toEqual(["t3"]);
        expect(after.events[0]!.id.endsWith(":1")).toBe(true);
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    },
  );
});
