import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  type EventBus,
  type EventBusTransport,
} from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import type { SessionRecord } from "@covel/store";
import {
  invalidateSessionEvents,
  sessionEventBus,
} from "../../src/routes/api/session/session-events.js";
import { publicSessionIncarnation } from "../../src/routes/api/session/session-guard.js";
import { drain, makeApp } from "./sse-test-utils.js";

function session(): SessionRecord {
  return {
    id: "same-id",
    status: "active",
    phase: "playing",
    locale: "en-US",
    setupRuntimes: {},
    completedPlayerTurns: 0,
    activePlugins: [],
    metadata: { sessionIncarnationNonce: crypto.randomUUID() },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function emit(bus: EventBus, owner: SessionRecord, value: unknown = "private") {
  sessionEventBus(bus, owner).emit({
    id: crypto.randomUUID(),
    type: "event",
    topic: "state",
    sessionId: owner.id,
    timestamp: new Date().toISOString(),
    payload: { value },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const buses: EventBus[] = [];
afterEach(async () => {
  await Promise.all(buses.splice(0).map((bus) => bus.close()));
  vi.restoreAllMocks();
});
async function fixture(transport?: EventBusTransport) {
  const store = createMemoryStore();
  const owner = session();
  await store.createSession(owner);
  const bus = createEventBus(undefined, {
    transport,
    requireSessionIncarnation: true,
  });
  buses.push(bus);
  const app = makeApp(store, bus);
  return { store, owner, bus, app };
}

describe("F-201 subscription incarnation admission", () => {
  it("reads once for connected, replay and 50 live events", async () => {
    const { store, owner, bus, app } = await fixture();
    emit(bus, owner, "replay");
    const cursor = `${bus.getEventsAfter(owner.id, 0).epoch}:0`;
    const reads = vi.spyOn(store, "getSession");
    const res = await app.request(
      `/api/events/stream?sessionId=${owner.id}&lastEventId=${cursor}`,
    );
    const reader = res.body!.getReader();
    const replay = await drain(reader, { want: 1, deadlineMs: 500 });
    expect(replay.some((frame) => frame.data?.includes('"replay"'))).toBe(true);
    for (let n = 0; n < 50; n++) emit(bus, owner, n);
    const live = await drain(reader, { want: 50, deadlineMs: 500 });
    expect(live).toHaveLength(50);
    expect(reads).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  it("does not read for heartbeats", async () => {
    const tick = vi.spyOn(globalThis, "setInterval");
    const { store, owner, app } = await fixture();
    const reads = vi.spyOn(store, "getSession");
    const res = await app.request(`/api/events/stream?sessionId=${owner.id}`);
    const reader = res.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(tick).toHaveBeenCalled());
    const heartbeat = tick.mock.calls.find(([, ms]) => ms === 30000)?.[0];
    expect(typeof heartbeat).toBe("function");
    if (typeof heartbeat === "function") heartbeat();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "system.heartbeat",
    );
    expect(reads).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  it.each([false, true])(
    "closes when deletion/recreation occurs during the initial read (recreate=%s)",
    async (recreate) => {
      const { store, owner, bus, app } = await fixture();
      const entered = deferred<void>();
      const release = deferred<SessionRecord>();
      vi.spyOn(store, "getSession").mockImplementationOnce(async () => {
        entered.resolve();
        return release.promise;
      });
      const opening = app.request(
        `/api/events/stream?sessionId=${owner.id}&topics=runtime`,
      );
      await entered.promise;
      await store.deleteSession(owner.id);
      invalidateSessionEvents(bus, owner);
      if (recreate) {
        const replacement = session();
        await store.createSession(replacement);
        emit(bus, replacement, "new-owner-secret");
      }
      release.resolve(owner);
      expect(await (await opening).text()).toBe("");
    },
  );

  it("rejects recreation that overtakes the old incarnation's invalidation during handshake", async () => {
    const { store, owner, bus, app } = await fixture();
    const entered = deferred<void>();
    const release = deferred<SessionRecord>();
    const reads = vi
      .spyOn(store, "getSession")
      .mockImplementationOnce(async () => {
        entered.resolve();
        return release.promise;
      });
    const opening = app.request(
      `/api/events/stream?sessionId=${owner.id}&topics=runtime`,
    );
    await entered.promise;
    await store.deleteSession(owner.id);
    const replacement = session();
    await store.createSession(replacement);
    emit(bus, replacement, "new-owner-secret");
    release.resolve(owner);
    expect(await (await opening).text()).toBe("");
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("closes on invalidation even when system events are filtered out", async () => {
    const { owner, bus, app, store } = await fixture();
    const reads = vi.spyOn(store, "getSession");
    const res = await app.request(
      `/api/events/stream?sessionId=${owner.id}&topics=runtime`,
    );
    const reader = res.body!.getReader();
    await reader.read();
    await store.deleteSession(owner.id);
    invalidateSessionEvents(bus, owner);
    expect((await reader.read()).done).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("closes on transport loss while the initial store read is pending", async () => {
    let lose = () => {};
    const { owner, store, app } = await fixture({
      publish() {},
      subscribe() {},
      onReset(handler) {
        lose = handler;
        return () => {};
      },
    });
    const entered = deferred<void>();
    const release = deferred<SessionRecord>();
    vi.spyOn(store, "getSession").mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    const opening = app.request(`/api/events/stream?sessionId=${owner.id}`);
    await entered.promise;
    lose();
    release.resolve(owner);
    expect(await (await opening).text()).toBe("");
  });

  it.each([false, true])(
    "rechecks once and closes on transport loss (replaced=%s)",
    async (replaced) => {
      let lose = () => {};
      const { owner, store, app } = await fixture({
        publish() {},
        subscribe() {},
        onReset(handler) {
          lose = handler;
          return () => {};
        },
      });
      const reads = vi.spyOn(store, "getSession");
      const res = await app.request(`/api/events/stream?sessionId=${owner.id}`);
      const reader = res.body!.getReader();
      await reader.read();
      // Let connected finish and the subscription enter live mode.
      await new Promise((resolve) => setImmediate(resolve));
      if (replaced) {
        await store.deleteSession(owner.id);
        await store.createSession(session());
      }
      lose();
      const frames = await drain(reader, { deadlineMs: 500 });
      expect(reads).toHaveBeenCalledTimes(2);
      expect(frames.some((frame) => frame.event === "system.reset")).toBe(
        !replaced,
      );
      expect((await reader.read()).done).toBe(true);
    },
  );

  it("never replays an old incarnation or delivers a delayed old frame from another origin", async () => {
    let receive = (_frame: string) => {};
    const {
      store,
      owner: old,
      bus,
      app,
    } = await fixture({
      publish() {},
      subscribe(handler) {
        receive = handler;
      },
    });
    emit(bus, old, "old-replay-secret");
    const cursor = `${bus.getEventsAfter(old.id, 0).epoch}:0`;
    await store.deleteSession(old.id);
    const current = session();
    await store.createSession(current);
    const reads = vi.spyOn(store, "getSession");
    const res = await app.request(
      `/api/events/stream?sessionId=${current.id}&lastEventId=${cursor}`,
    );
    const reader = res.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setImmediate(resolve));
    receive(
      JSON.stringify({
        origin: "late-other-pod",
        stream: "origin-generation",
        seq: 1,
        event: {
          id: "remote:1",
          sessionId: old.id,
          sessionIncarnation: publicSessionIncarnation(old),
          type: "state.changed",
          topic: "state",
          timestamp: new Date().toISOString(),
          payload: { secret: "old-live-secret" },
        },
      }),
    );
    expect(await drain(reader, { deadlineMs: 500 })).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect((await reader.read()).done).toBe(true);
  });

  it("keeps a delayed producer bound to the session it captured", async () => {
    const { store, owner, bus } = await fixture();
    const producer = sessionEventBus(bus, owner);
    await store.deleteSession(owner.id);
    await store.createSession(session());
    producer.emit({
      id: "late",
      type: "event",
      topic: "state",
      sessionId: owner.id,
      timestamp: "now",
      payload: {},
    });
    expect(bus.getEventsAfter(owner.id, 0).events[0]?.sessionIncarnation).toBe(
      publicSessionIncarnation(owner),
    );
    expect(() =>
      producer.emit({
        id: "wrong-scope",
        type: "event",
        topic: "state",
        sessionId: owner.id,
        sessionIncarnation: "another-incarnation",
        timestamp: "now",
        payload: {},
      }),
    ).toThrow("cannot relabel");
    expect(() =>
      bus.emit({
        id: "unbound",
        type: "event",
        topic: "state",
        sessionId: owner.id,
        timestamp: "now",
        payload: {},
      }),
    ).toThrow("producer incarnation");
  });
});
