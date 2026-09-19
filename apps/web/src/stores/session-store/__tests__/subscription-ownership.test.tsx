import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import type {
  ConnectionState,
  SessionSubscriptionOptions,
  SubscriptionEvent,
  SubscriptionEventHandler,
} from "@/services/subscription.js";
import type { SessionPlugin, WorldRecord } from "@/services/api.js";
import { initialState, reducer } from "../reducer.js";
import { createSseEventHandler } from "../sse-handler.js";
import type { SessionState } from "../types.js";

const api = vi.hoisted(() => ({
  listSessionPlugins: vi.fn(),
  listPluginData: vi.fn(),
  getWorld: vi.fn(),
  getSessionView: vi.fn(),
  listSuspensions: vi.fn(),
}));
const subscription = vi.hoisted(() => ({ createSessionSubscription: vi.fn() }));
const connection = vi.hoisted(() => ({ setConnectionState: vi.fn() }));
vi.mock("@/services/api", () => api);
vi.mock("@/services/subscription.js", () => subscription);
vi.mock("@/stores/connection-store.js", () => connection);
vi.mock("@/stores/plugin-data-store.js", () => ({
  replaceSessionPluginData: vi.fn(),
  applyChanges: vi.fn(),
  getPluginNamespaceSnapshot: () => ({}),
}));
const { useSessionSubscription } = await import("../subscription.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const session = {
  id: "session",
  worldId: "world",
  incarnation: "incarnation",
  locale: "en-US",
  status: "active" as const,
  phase: "playing" as const,
  completedPlayerTurns: 1,
  setupRuntimes: {},
  activePlugins: [],
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
};
const world: WorldRecord = {
  id: "world",
  name: "Current",
  description: "",
  createdAt: session.createdAt,
};
const plugins = (id: string) => ({
  items: [{ id, active: true } as SessionPlugin],
  commands: [],
});

function setup() {
  const streams: {
    emit: SubscriptionEventHandler;
    state: (state: ConnectionState) => void;
  }[] = [];
  subscription.createSessionSubscription.mockImplementation(
    (_id: string, options: SessionSubscriptionOptions) => {
      const stream = {
        emit: (() => {}) as SubscriptionEventHandler,
        state: options.onStateChange!,
      };
      streams.push(stream);
      return {
        close: vi.fn(),
        on: (_topic: string, handler: SubscriptionEventHandler) => {
          stream.emit = handler;
        },
      };
    },
  );
  const options = {
    sessionId: session.id,
    sessionIdRef: { current: session.id as string | null },
    sessionGenerationRef: { current: 1 },
    stateRef: { current: { ...initialState, session } as SessionState },
    activeTurnIdRef: { current: null },
    workspace: {
      hydrate: vi
        .fn<SessionWorkspace["hydrate"]>()
        .mockResolvedValue(undefined),
      run: async () => {
        throw new Error("Unexpected workspace mutation");
      },
      checkpoint: vi
        .fn<SessionWorkspace["checkpoint"]>()
        .mockResolvedValue(undefined),
    } satisfies SessionWorkspace,
    dispatch: vi.fn(),
  };
  const hook = renderHook(() => useSessionSubscription(options));
  return { ...hook, options, streams };
}

function event(type: string): SubscriptionEvent {
  return {
    type,
    id: type,
    topic: "plugin",
    sessionId: session.id,
    timestamp: session.createdAt,
    payload: { worldId: "world" },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  api.listSessionPlugins.mockResolvedValue(plugins("current"));
  api.listPluginData.mockResolvedValue([]);
  api.getWorld.mockResolvedValue(world);
  api.getSessionView.mockResolvedValue({
    session,
    messages: [],
    gameState: {},
    characters: [],
    executionSteps: [],
    execution: { state: "idle" },
  });
  api.listSuspensions.mockResolvedValue([]);
});

it.each(["plugin.activated", "world.dimensions.changed"])(
  "drops an older %s refresh after the latest refresh publishes",
  async (type) => {
    const pending = deferred<unknown>();
    const fetch =
      type === "plugin.activated" ? api.listSessionPlugins : api.getWorld;
    fetch.mockReturnValueOnce(pending.promise);
    const { streams, options } = setup();
    await act(async () => {
      streams[0]!.emit(event(type));
      streams[0]!.emit(event(type));
    });
    expect(options.dispatch).toHaveBeenCalledWith(
      type === "plugin.activated"
        ? {
            type: "LOAD_SESSION_PLUGINS",
            plugins: plugins("current").items,
            commands: [],
          }
        : { type: "UPDATE_WORLD", world },
    );
    options.dispatch.mockClear();
    await act(async () => {
      pending.resolve(
        type === "plugin.activated"
          ? plugins("obsolete")
          : { ...world, name: "Obsolete" },
      );
    });
    expect(options.dispatch).not.toHaveBeenCalled();
  },
);

it.each(["plugin.activated", "world.dimensions.changed"])(
  "drops %s responses from a previous visit to the same session",
  async (type) => {
    const pending = deferred<unknown>();
    (type === "plugin.activated"
      ? api.listSessionPlugins
      : api.getWorld
    ).mockReturnValueOnce(pending.promise);
    const { streams, options, rerender } = setup();
    streams[0]!.emit(event(type));
    options.sessionGenerationRef.current += 1;
    rerender();
    options.dispatch.mockClear();
    await act(async () => {
      pending.resolve(
        type === "plugin.activated"
          ? plugins("obsolete")
          : { ...world, name: "Obsolete" },
      );
    });
    expect(options.dispatch).not.toHaveBeenCalled();
  },
);

it("invalidates pending event refreshes when reconnect recovery starts", async () => {
  const pending = deferred<unknown>();
  api.listSessionPlugins.mockReturnValueOnce(pending.promise);
  const { streams, options } = setup();
  streams[0]!.emit(event("plugin.activated"));
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  options.dispatch.mockClear();
  await act(async () => {
    pending.resolve(plugins("obsolete"));
  });
  expect(options.dispatch).not.toHaveBeenCalled();
});

it("ignores events and connection updates from a closed visit", () => {
  const { streams, options, rerender } = setup();
  options.sessionGenerationRef.current += 1;
  rerender();
  options.dispatch.mockClear();
  connection.setConnectionState.mockClear();
  streams[0]!.emit(event("turn.resumed"));
  streams[0]!.state("reconnecting");
  expect(options.dispatch).not.toHaveBeenCalled();
  expect(connection.setConnectionState).not.toHaveBeenCalled();
});

it("ignores pending event refreshes after provider unmount", async () => {
  const pending = deferred<unknown>();
  api.listSessionPlugins.mockReturnValueOnce(pending.promise);
  const { streams, options, unmount } = setup();
  streams[0]!.emit(event("plugin.activated"));
  unmount();
  await act(async () => {
    pending.resolve(plugins("obsolete"));
  });
  expect(options.dispatch).not.toHaveBeenCalled();
});

it("coalesces committed state notices during a snapshot read without replaying them or appending patch history", async () => {
  const pending = deferred<unknown>();
  const current = {
    session,
    messages: [],
    characters: [{ id: "hero", name: "Current" }],
    gameState: { stats: { hp: 9, mp: 3 }, weather: { sky: "clear" } },
    executionSteps: [],
    execution: { state: "idle" },
  };
  api.getSessionView
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(current);
  const { streams, options } = setup();
  options.dispatch.mockImplementation((action) => {
    options.stateRef.current = reducer(options.stateRef.current, action);
  });
  streams[0]!.emit(event("state.changed"));
  expect(api.getSessionView).toHaveBeenCalledOnce();
  streams[0]!.emit(event("state.changed"));
  streams[0]!.emit(event("character.upserted"));
  await act(async () => {
    pending.resolve({
      ...current,
      characters: [],
      gameState: { stats: { hp: 1 } },
    });
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
  expect(options.stateRef.current.gameState).toEqual({
    ...current.gameState,
    characters: current.characters,
  });
  expect(options.stateRef.current.statePatches).toEqual([]);
});

it("refreshes once when a state commit follows snapshot publication but other recovery reads are pending", async () => {
  const pending = deferred<unknown>();
  api.listSessionPlugins.mockReturnValueOnce(pending.promise);
  const { streams, options } = setup();
  options.dispatch.mockImplementation((action) => {
    options.stateRef.current = reducer(options.stateRef.current, action);
  });
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  expect(api.getSessionView).toHaveBeenCalledOnce();
  api.getSessionView.mockResolvedValue({
    session,
    messages: [],
    characters: [],
    gameState: { stats: { hp: 9, mp: 3 }, weather: { sky: "clear" } },
    executionSteps: [],
    execution: { state: "idle" },
  });
  streams[0]!.emit(event("state.changed"));
  streams[0]!.emit(event("state.changed"));
  await act(async () => {
    pending.resolve(plugins("current"));
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
  expect(options.stateRef.current.gameState).toEqual({
    stats: { hp: 9, mp: 3 },
    weather: { sky: "clear" },
    characters: [],
  });
  expect(options.stateRef.current.statePatches).toEqual([]);
});

it("does not duplicate action-stream patch history when the subscription observes the same commits", async () => {
  vi.spyOn(Date, "now").mockReturnValue(123456789);
  const pending = deferred<unknown>();
  const current = {
    session,
    messages: [],
    characters: [],
    gameState: { stats: { hp: 9, mp: 4 } },
    executionSteps: [],
    execution: { state: "idle" },
  };
  api.getSessionView
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(current);
  const { streams, options } = setup();
  options.dispatch.mockImplementation((action) => {
    options.stateRef.current = reducer(options.stateRef.current, action);
  });
  const ds = { addStatePatch: vi.fn(async () => {}) } as unknown as DataService;
  const actionStream = createSseEventHandler({
    ...options,
    ds,
    runtimeKindRef: { current: new Map() },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  });
  for (const [field, value] of [
    ["hp", 9],
    ["mp", 4],
  ] as const) {
    const envelope = {
      type: "state.changed",
      payload: { table: "stats", field, value },
      sessionId: session.id,
      timestamp: session.createdAt,
      requestId: "request",
      traceId: "trace",
      turnId: "turn",
      flowId: "flow",
      seq: value,
    };
    actionStream(envelope);
    actionStream(envelope);
    streams[0]!.emit({
      ...event("state.changed"),
      payload: { table: "stats", field, value },
    });
  }
  await act(async () => {
    pending.resolve({ ...current, gameState: {} });
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
  expect(options.stateRef.current.gameState).toEqual({
    ...current.gameState,
    characters: [],
  });
  expect(options.stateRef.current.statePatches).toHaveLength(2);
  expect(
    new Set(options.stateRef.current.statePatches.map((patch) => patch.id))
      .size,
  ).toBe(2);
  expect(ds.addStatePatch).toHaveBeenCalledTimes(4);
  expect(
    new Set(vi.mocked(ds.addStatePatch).mock.calls.map(([, patch]) => patch.id))
      .size,
  ).toBe(2);
});

it("does not retry a failed current snapshot merely because committed notices arrived", async () => {
  const pending = deferred<unknown>();
  api.getSessionView
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValue(new Error("offline"));
  const { streams } = setup();
  streams[0]!.emit(event("state.changed"));
  streams[0]!.emit(event("state.changed"));
  await act(async () => {
    pending.resolve({ session, messages: [], characters: [], gameState: {} });
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
});

it.each(["unmount", "revisit"] as const)(
  "does not re-read or publish a dirty committed-state recovery after %s",
  async (leave) => {
    const pending = deferred<unknown>();
    api.getSessionView.mockReturnValueOnce(pending.promise);
    const { streams, options, unmount, rerender } = setup();
    streams[0]!.emit(event("state.changed"));
    streams[0]!.emit(event("character.upserted"));
    if (leave === "unmount") unmount();
    else {
      options.sessionGenerationRef.current += 1;
      rerender();
    }
    options.dispatch.mockClear();
    await act(async () => {
      pending.resolve({ session, messages: [], characters: [], gameState: {} });
    });
    expect(api.getSessionView).toHaveBeenCalledOnce();
    expect(options.dispatch).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "checkpoints terminal background events before recovery replay with state follow-up=%s",
  async (stateFollowup) => {
    const pendingPlugins = deferred<ReturnType<typeof plugins>>();
    api.listSessionPlugins.mockReturnValueOnce(pendingPlugins.promise);
    const { streams, options } = setup();
    options.dispatch.mockImplementation((action) => {
      options.stateRef.current = reducer(options.stateRef.current, action);
    });
    await act(async () => {
      streams[0]!.emit(event("system.reset"));
    });
    expect(options.stateRef.current.hasGameStateSnapshot).toBe(true);
    const done = {
      status: "done",
      runtimeId: "current/background",
      durationMs: 1,
    };
    api.listPluginData.mockResolvedValue([
      { namespace: "_jobs", key: "job", value: done },
    ]);
    streams[0]!.emit({
      ...event("plugin-data.changed"),
      id: "terminal-job-event",
      payload: {
        pluginId: "current",
        changes: [
          { namespace: "_jobs", key: "job", operation: "set", value: done },
        ],
      },
    });
    expect(options.workspace.checkpoint).toHaveBeenCalledExactlyOnceWith(
      session.id,
      "background:terminal-job-event",
    );
    if (stateFollowup) streams[0]!.emit(event("state.changed"));
    await act(async () => {
      pendingPlugins.resolve(plugins("current"));
    });
    expect(api.getSessionView).toHaveBeenCalledTimes(2);
    expect(options.stateRef.current.pluginData.current?._jobs?.job).toEqual(
      done,
    );
    expect(options.workspace.checkpoint).toHaveBeenCalledOnce();
  },
);

it.each(["session switch", "revisit", "cross-session envelope", "unmount"])(
  "does not checkpoint terminal background events after %s",
  async (leave) => {
    const { streams, options, unmount, rerender } = setup();
    if (leave === "session switch") options.sessionIdRef.current = "other";
    else if (leave === "revisit") {
      options.sessionGenerationRef.current += 1;
      rerender();
    } else if (leave === "unmount") unmount();
    await act(async () => {
      streams[0]!.emit({
        ...event("plugin-data.changed"),
        sessionId: leave === "cross-session envelope" ? "other" : session.id,
        payload: {
          pluginId: "current",
          changes: [
            {
              namespace: "_jobs",
              key: "job",
              operation: "set",
              value: { status: "done" },
            },
          ],
        },
      });
    });
    expect(options.workspace.checkpoint).not.toHaveBeenCalled();
    expect(options.dispatch).not.toHaveBeenCalled();
    expect(api.getSessionView).not.toHaveBeenCalled();
  },
);
