import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CovelMessage } from "@covel/shared";
import { createMemoryStore, type EventRecord } from "@covel/store";
import { createEventBus, PERSIST_MAX_IN_FLIGHT } from "../src/event-bus.js";

function message(id: string, sessionId = "sess-flush"): CovelMessage {
  return {
    id,
    type: "event",
    topic: "test.topic",
    payload: {},
    sessionId,
    timestamp: "2026-09-05T00:00:00.000Z",
  };
}

function controlledPersistence() {
  const store = createMemoryStore();
  const pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const saveEvent = vi.fn(async (record: EventRecord) => {
    await new Promise<void>((resolve, reject) => {
      pending.set(record.id, { resolve, reject });
    });
    await store.saveEvent(record);
  });
  return {
    bus: createEventBus({ ...store, saveEvent }),
    store,
    saveEvent,
    pending,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("EventBus flush completion", () => {
  it("keeps all callers waiting until the last in-flight save settles", async () => {
    const { bus, store, pending } = controlledPersistence();
    bus.emit(message("first"));
    bus.emit(message("last"));
    const completed: string[] = [];
    const firstFlush = bus.flush().then(() => completed.push("first"));
    const secondFlush = bus.flush().then(() => completed.push("second"));

    await setImmediate();
    expect(completed).toEqual([]);
    pending.get("first")!.resolve();
    await setImmediate();
    expect(completed).toEqual([]);

    pending.get("last")!.resolve();
    await Promise.all([firstFlush, secondFlush]);
    expect(completed).toEqual(["first", "second"]);
    expect(await store.listEvents("sess-flush")).toHaveLength(2);
  });

  it("includes another session's queued event emitted while flush is waiting", async () => {
    const { bus, store, pending } = controlledPersistence();
    for (let i = 0; i < PERSIST_MAX_IN_FLIGHT; i += 1) {
      bus.emit(message(`initial-${i}`));
    }
    const completed = vi.fn();
    const flushed = bus.flush().then(completed);
    bus.emit(message("later", "sess-other"));
    expect(pending.has("later")).toBe(false);

    for (const save of pending.values()) save.resolve();
    // Let all released saves and their completion handlers settle. The
    // later save is still gated, so flush must remain pending.
    await setImmediate();
    expect(pending.has("later")).toBe(true);
    expect(completed).not.toHaveBeenCalled();

    pending.get("later")!.resolve();
    await flushed;
    expect(completed).toHaveBeenCalledOnce();
    expect(
      (await store.listEvents("sess-other")).map((event) => event.id),
    ).toEqual(["later"]);
  });

  it("waits again when a new busy period follows a completed flush", async () => {
    const { bus, pending } = controlledPersistence();
    bus.emit(message("first-period"));
    const firstFlush = bus.flush();
    pending.get("first-period")!.resolve();
    await firstFlush;
    await expect(bus.flush()).resolves.toBeUndefined();

    bus.emit(message("next-period"));
    const completed = vi.fn();
    const nextFlush = bus.flush().then(completed);
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();

    pending.get("next-period")!.resolve();
    await nextFlush;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each(["throw", "reject"] as const)(
    "drains after a save %s and continues persisting later events",
    async (failureMode) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { bus, store, saveEvent, pending } = controlledPersistence();
      const failure = new Error("synthetic save failure");
      if (failureMode === "throw") {
        saveEvent.mockImplementationOnce(() => {
          throw failure;
        });
      }
      bus.emit(message("failed"));
      const failedFlush = bus.flush();
      if (failureMode === "reject") pending.get("failed")!.reject(failure);
      await expect(failedFlush).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to persist event "failed"'),
        failure,
      );
      expect(await store.listEvents("sess-flush")).toEqual([]);

      bus.emit(message("recovered"));
      const completed = vi.fn();
      const recoveredFlush = bus.flush().then(completed);
      await setImmediate();
      expect(completed).not.toHaveBeenCalled();
      pending.get("recovered")!.resolve();
      await recoveredFlush;
      expect(
        (await store.listEvents("sess-flush")).map((event) => event.id),
      ).toEqual(["recovered"]);
    },
  );
});
