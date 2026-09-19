import { describe, expect, it, vi } from "vitest";
import type { CovelMessage } from "@covel/shared";
import { createEventBus, type EventBusTransport } from "../src/event-bus.js";
import type { EventStore } from "../src/event-store.js";

function message(payload: Record<string, unknown> = {}): CovelMessage {
  return {
    id: "event",
    sessionId: "session",
    type: "event",
    topic: "state",
    timestamp: "2026-09-19T00:00:00.000Z",
    payload,
  };
}

describe("EventBus close", () => {
  it("still releases the transport when its unsubscribe callback throws", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const close = vi.fn(async () => {});
    try {
      const bus = createEventBus(undefined, {
        transport: {
          publish: vi.fn(),
          subscribe: () => () => {
            throw new Error("unsubscribe failed");
          },
          close,
        },
      });
      await bus.close();
      await bus.close();
      expect(close).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("drains persistence and ordered transport before closing its connection", async () => {
    let save!: () => void;
    let publish!: () => void;
    const saved = new Promise<void>((resolve) => {
      save = resolve;
    });
    const published = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const store: EventStore = {
      saveEvent: vi.fn(() => saved),
      getEventById: vi.fn(),
    };
    const unsubscribe = vi.fn();
    const transport: EventBusTransport = {
      publish: vi.fn(() => published),
      subscribe: () => unsubscribe,
      close: vi.fn(async () => {}),
    };
    const bus = createEventBus(store, { transport });
    bus.emit(message({ text: "x".repeat(9_000) }));
    bus.emit({ ...message(), id: "second" });
    const closing = bus.close();
    expect(bus.close()).toBe(closing);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(transport.publish).not.toHaveBeenCalled();
    save();
    await vi.waitFor(() => expect(transport.publish).toHaveBeenCalledOnce());
    expect(transport.close).not.toHaveBeenCalled();
    publish();
    await closing;
    expect(transport.publish).toHaveBeenCalledTimes(2);
    expect(transport.close).toHaveBeenCalledOnce();
    bus.emit(message());
    expect(store.saveEvent).toHaveBeenCalledTimes(2);
  });

  it("waits for in-flight received references and ignores late delivery", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: EventStore = {
      saveEvent: vi.fn(),
      getEventById: vi.fn(async () => {
        await blocked;
        return null;
      }),
    };
    let receive!: (payload: string) => void;
    const transport: EventBusTransport = {
      publish: vi.fn(),
      subscribe: (handler) => {
        receive = handler;
      },
      close: vi.fn(async () => {}),
    };
    const bus = createEventBus(store, { transport });
    const observer = vi.fn();
    bus.onEmit(observer);
    receive(
      JSON.stringify({
        origin: "remote",
        seq: 1,
        ref: { sessionId: "session", eventId: "remote-event" },
      }),
    );
    await vi.waitFor(() => expect(store.getEventById).toHaveBeenCalledOnce());
    const closing = bus.close();
    expect(transport.close).not.toHaveBeenCalled();
    receive(
      JSON.stringify({
        origin: "remote",
        seq: 2,
        ref: { sessionId: "session", eventId: "late-event" },
      }),
    );
    release();
    await closing;
    expect(store.getEventById).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("clears pending receive-gap timers during shutdown", async () => {
    vi.useFakeTimers();
    try {
      let receive!: (payload: string) => void;
      const bus = createEventBus(undefined, {
        transport: {
          publish: vi.fn(),
          subscribe: (handler) => {
            receive = handler;
          },
        },
      });
      const reset = vi.fn();
      bus.onReset?.(reset);
      receive(
        JSON.stringify({
          origin: "remote",
          seq: 2,
          event: {
            id: "remote:2",
            sessionId: "session",
            type: "state.changed",
            topic: "state",
            timestamp: "2026-09-19T00:00:00.000Z",
            payload: {},
          },
        }),
      );
      expect(vi.getTimerCount()).toBe(1);
      await bus.close();
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(reset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
