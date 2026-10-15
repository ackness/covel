import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  MAX_TRACKED_SESSIONS,
  type EventBus,
  type EventBusTransport,
} from "@covel/events";
import { PluginExtensionHost, PluginServiceRegistry } from "@covel/runtime";
import { uiSlotV1 } from "@covel/shared";
import { createUiSlotHost } from "../../src/ui-slots/host.js";
import { wrapStoreWithPluginDataEvents } from "../../src/routes/api/bootstrap/plugin-data-store-events.js";
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
  vi.unstubAllEnvs();
});
async function fixture(transport?: EventBusTransport) {
  const store = createMemoryStore();
  const owner = session();
  await store.createSession(owner);
  const bus = createEventBus(undefined, {
    transport,
    requireSessionIncarnation: true,
    strictEmissions: true,
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

  it("counts producer and UI host reads without reading hidden writes or each received event", async () => {
    const { store, owner, bus, app } = await fixture();
    const wrapped = wrapStoreWithPluginDataEvents(store, bus);
    const services = new PluginServiceRegistry({
      list: async () => [],
      ensure: async () => {},
    });
    const host = createUiSlotHost({
      store: wrapped,
      eventBus: bus,
      services,
      extensionHost: new PluginExtensionHost(services, [uiSlotV1]),
    });
    // A projection captures the UI host's incarnation once.
    await host.get(owner.id);
    const reads = vi.spyOn(store, "getSession");
    const response = await app.request(
      `/api/events/stream?sessionId=${owner.id}`,
    );
    const reader = response.body!.getReader();
    await reader.read();
    const record = {
      id: "row",
      sessionId: owner.id,
      pluginId: "test-plugin",
      namespace: "_hidden.test",
      key: "key",
      value: {},
      createdAt: owner.createdAt,
      updatedAt: owner.updatedAt,
    };
    try {
      await wrapped.setPluginData(record);
      await wrapped.compareAndSetPluginData(record, record.updatedAt);
      await wrapped.compareAndSetPluginDataBatch(owner.id, record.pluginId, []);
      await wrapped.compareAndSetPluginDataBatch(owner.id, record.pluginId, [
        {
          namespace: record.namespace,
          key: record.key,
          value: {},
          expectedVersion: null,
          timestamp: record.updatedAt,
        },
      ]);
      await wrapped.setPluginDataBatch([]);
      await wrapped.setPluginDataBatch([record]);
      await wrapped.deletePluginData(
        owner.id,
        record.pluginId,
        record.namespace,
        record.key,
      );
      expect(reads).toHaveBeenCalledTimes(1);
      for (let n = 0; n < 50; n++) {
        await wrapped.setPluginData({
          ...record,
          namespace: "visible",
          value: n,
        });
      }
      expect(await drain(reader, { want: 50, deadlineMs: 1000 })).toHaveLength(
        50,
      );
      // One admission read and one producer capture per public write. The UI
      // listener and subscriber do not repeat those reads for matching events.
      expect(reads).toHaveBeenCalledTimes(51);
    } finally {
      await reader.cancel();
      await host.close();
    }
  });

  it("does not pin or evict replay state for unauthorized handshakes", async () => {
    const { store, owner, bus, app } = await fixture();
    emit(bus, owner);
    const epoch = bus.getEventsAfter(owner.id, 0).epoch;
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.spyOn(store, "getSession").mockImplementation(async (id) => ({
      ...owner,
      id,
    }));
    const pin = vi.spyOn(bus, "pin");
    for (let n = 1; n < MAX_TRACKED_SESSIONS; n++) {
      emit(bus, { ...owner, id: `retained-${n}` });
    }
    const response = await app.request(
      "/api/events/stream?sessionId=unauthorized",
    );
    expect(response.status).toBe(401);
    expect(pin).not.toHaveBeenCalled();
    expect(bus.getEventsAfter(owner.id, 0).epoch).toBe(epoch);
    expect(bus.getEventsAfter(owner.id, 0).events).toHaveLength(1);
  });

  it("logs and drops invalid production emissions without throwing after a commit", async () => {
    const bus = createEventBus(undefined, { requireSessionIncarnation: true });
    buses.push(bus);
    const owner = session();
    const producer = sessionEventBus(bus, owner);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const message = {
      id: "invalid",
      type: "event" as const,
      topic: "state",
      sessionId: owner.id,
      timestamp: "now",
      payload: {},
    };
    expect(() => bus.emit(message)).not.toThrow();
    expect(() =>
      producer.emit({ ...message, sessionId: "another-session" }),
    ).not.toThrow();
    expect(() =>
      producer.emit({ ...message, sessionIncarnation: "wrong" }),
    ).not.toThrow();
    expect(log).toHaveBeenCalledTimes(3);
    expect(bus.getEventsAfter(owner.id, 0).events).toEqual([]);
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
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    emit(bus, current, "current-owner-content");
    const frames = await drain(reader, { want: 1, deadlineMs: 500 });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toContain("current-owner-content");
    expect(JSON.stringify(frames)).not.toContain("old-");
    await reader.cancel();
  });

  it.each([false, true])(
    "preserves arrivals during a stale-frame recheck (invalidated=%s)",
    async (invalidated) => {
      const { store, owner, bus, app } = await fixture();
      const response = await app.request(
        `/api/events/stream?sessionId=${owner.id}`,
      );
      const reader = response.body!.getReader();
      await reader.read();
      const entered = deferred<void>();
      const release = deferred<SessionRecord>();
      vi.spyOn(store, "getSession").mockImplementationOnce(async () => {
        entered.resolve();
        return release.promise;
      });
      emit(bus, session(), "stale-content");
      await entered.promise;
      emit(bus, owner, "arrived-during-recheck");
      if (invalidated) invalidateSessionEvents(bus, owner);
      release.resolve(owner);
      try {
        if (invalidated) expect((await reader.read()).done).toBe(true);
        else {
          const frames = await drain(reader, { want: 1, deadlineMs: 500 });
          expect(frames).toHaveLength(1);
          expect(frames[0]?.data).toContain("arrived-during-recheck");
        }
      } finally {
        await reader.cancel();
      }
    },
  );

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
