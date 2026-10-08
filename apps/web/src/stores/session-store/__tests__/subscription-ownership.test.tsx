import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearAllStreamingText,
  getStreamingText,
} from "@/stores/streaming-text-store.js";
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
  listMessagesPage: vi.fn(),
  listSuspensions: vi.fn(),
}));
const subscription = vi.hoisted(() => ({ createSessionSubscription: vi.fn() }));
const connection = vi.hoisted(() => ({
  setConnectionState: vi.fn(),
  registerConnectionRetry: vi.fn(() => () => {}),
}));
vi.mock("@/services/api", () => api);
vi.mock("@/services/subscription.js", () => subscription);
vi.mock("@/stores/connection-store.js", () => connection);
vi.mock("@/stores/plugin-data-store.js", () => ({
  replaceSessionPluginData: vi.fn(),
  applyChanges: vi.fn(),
  getPluginNamespaceSnapshot: () => ({}),
  backgroundJobRecord: () => null,
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
    storageMode: "local" as const,
    sessionId: session.id,
    sessionIdRef: { current: session.id as string | null },
    sessionGenerationRef: { current: 1 },
    stateRef: { current: { ...initialState, session } as SessionState },
    activeTurnIdRef: { current: null as string | null },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    workspace: {
      hydrate: vi
        .fn<SessionWorkspace["hydrate"]>()
        .mockResolvedValue(undefined),
      run: vi.fn(async () => {
        throw new Error("Unexpected workspace mutation");
      }),
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearAllStreamingText();
});

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

it("recovers once when a reconnect opens with a stale-cursor reset", async () => {
  const { streams } = setup();
  await act(async () => {
    streams[0]!.state("connected");
    streams[0]!.state("reconnecting");
    streams[0]!.state("connected");
    streams[0]!.emit(event("system.connected"));
    streams[0]!.emit(event("system.reset"));
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(1);

  // A reset after live traffic still means events were missed.
  await act(async () => {
    streams[0]!.emit(event("turn.resumed"));
    streams[0]!.emit(event("system.reset"));
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
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
    characterSchema: null,
    dimensions: {},
    dimensionSettlements: [],
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
    characterSchema: null,
    dimensions: {},
    dimensionSettlements: [],
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
    characterSchema: null,
    dimensions: {},
    dimensionSettlements: [],
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
      status: "succeeded",
      runtimeId: "current/background",
      origin: { activation: "manual", sourceTurnId: "rpc-turn" },
    };
    api.listPluginData.mockResolvedValue([
      { namespace: "_runtime_jobs", key: "job", value: done },
    ]);
    // The job row change is applied as data; its status event alone marks
    // the committed terminal result.
    streams[0]!.emit({
      ...event("plugin-data.changed"),
      id: "terminal-job-row",
      payload: {
        pluginId: "current",
        changes: [
          {
            namespace: "_runtime_jobs",
            key: "job",
            operation: "set",
            value: done,
          },
        ],
      },
    });
    expect(options.workspace.checkpoint).not.toHaveBeenCalled();
    streams[0]!.emit({
      ...event("job-status.updated"),
      id: "terminal-job-event",
      payload: {
        jobId: "job",
        pluginId: "current",
        runtimeId: "current/background",
        state: "succeeded",
        data: { durableStatus: "succeeded", originTurnId: "rpc-turn" },
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
    expect(options.stateRef.current.executionSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: "current/background",
          status: "completed",
        }),
      ]),
    );
    expect(options.workspace.checkpoint).toHaveBeenCalledOnce();
  },
);

it.each(["succeeded", "failed", "cancelled"])(
  "admits a durable %s checkpoint while recovery is buffering UI events",
  async (state) => {
    const pendingPlugins = deferred<ReturnType<typeof plugins>>();
    api.listSessionPlugins.mockReturnValueOnce(pendingPlugins.promise);
    const { streams, options } = setup();
    await act(async () => streams[0]!.emit(event("system.reset")));
    streams[0]!.emit({
      ...event("job-status.updated"),
      id: "durable-terminal",
      payload: {
        jobId: "durable-job",
        pluginId: "current",
        runtimeId: "current/render",
        state,
        data: { durableStatus: state, originTurnId: "source-turn" },
      },
    });
    expect(options.workspace.checkpoint).toHaveBeenCalledExactlyOnceWith(
      session.id,
      "background:durable-terminal",
    );
    await act(async () => pendingPlugins.resolve(plugins("current")));
    expect(options.workspace.checkpoint).toHaveBeenCalledOnce();
  },
);

it("does not checkpoint a handler's terminal progress before its parent commit", async () => {
  const { streams, options } = setup();
  await act(async () =>
    streams[0]!.emit({
      ...event("job-status.updated"),
      payload: {
        jobId: "sub-job",
        pluginId: "current",
        runtimeId: "current/render",
        state: "succeeded",
        data: { runtimeJobId: "parent", originTurnId: "source" },
      },
    }),
  );
  expect(options.workspace.checkpoint).not.toHaveBeenCalled();
});

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
        ...event("job-status.updated"),
        sessionId: leave === "cross-session envelope" ? "other" : session.id,
        payload: {
          jobId: "job",
          pluginId: "current",
          runtimeId: "current/background",
          state: "succeeded",
          data: { durableStatus: "succeeded", originTurnId: "rpc-turn" },
        },
      });
    });
    expect(options.workspace.checkpoint).not.toHaveBeenCalled();
    expect(options.dispatch).not.toHaveBeenCalled();
    expect(api.getSessionView).not.toHaveBeenCalled();
  },
);

it("only hydrates the currently owned local session after a subscription 404", async () => {
  const { options, unmount } = setup();
  const callback =
    subscription.createSessionSubscription.mock.calls.at(-1)![1]
      .recoverMissingSession;
  expect(callback).toBeTypeOf("function");
  await callback();
  expect(options.workspace.hydrate).toHaveBeenCalledWith(session.id, {
    isCurrent: expect.any(Function),
  });
  const guard = options.workspace.hydrate.mock.calls[0]![1]!.isCurrent!;
  expect(guard()).toBe(true);
  options.sessionIdRef.current = "another-session";
  expect(guard()).toBe(false);
  await callback();
  expect(options.workspace.hydrate).toHaveBeenCalledOnce();
  unmount();
});

function historyMessage(n: number) {
  return {
    id: `m${n}`,
    role: "assistant" as const,
    content: `Message ${n}`,
    turnId: `t${n}`,
    runtimeId: "story/main",
    kind: "story" as const,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  };
}
const historyWindow = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => historyMessage(start + i));

it("fills a nonoverlapping snapshot gap without dropping loaded history", async () => {
  const { streams, options } = setup();
  options.stateRef.current.messages = historyWindow(1, 20).map((m) => ({
    ...m,
    timestamp: m.createdAt,
  }));
  options.dispatch.mockImplementation((action) => {
    options.stateRef.current = reducer(options.stateRef.current, action);
  });
  api.getSessionView.mockResolvedValue({
    session,
    messages: historyWindow(41, 120),
    messagesCursor: "opaque-41",
    executionSteps: [],
    execution: { state: "idle" },
    characters: [],
    gameState: {},
  });
  api.listMessagesPage.mockResolvedValue({
    items: historyWindow(1, 40),
    nextCursor: null,
  });
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  expect(options.stateRef.current.messages.map((m) => m.id)).toEqual(
    historyWindow(1, 120).map((m) => m.id),
  );
  expect(api.listMessagesPage).toHaveBeenCalledExactlyOnceWith(session.id, {
    cursor: "opaque-41",
    limit: 40,
  });
  expect(options.stateRef.current.olderMessagesCursor).toBeNull();
});

function setupHistoryGap() {
  const hook = setup();
  hook.options.stateRef.current.messages = historyWindow(1, 20).map((m) => ({
    ...m,
    timestamp: m.createdAt,
  }));
  hook.options.dispatch.mockImplementation((action) => {
    hook.options.stateRef.current = reducer(
      hook.options.stateRef.current,
      action,
    );
  });
  api.getSessionView.mockResolvedValue({
    session,
    messages: historyWindow(81, 160),
    messagesCursor: "opaque-81",
    executionSteps: [],
    execution: { state: "completed", turnId: "old" },
    characters: [],
    gameState: {},
  });
  return hook;
}

it("merges multiple bridge pages once in durable order and retains the oldest cursor", async () => {
  const { streams, options } = setupHistoryGap();
  options.stateRef.current.olderMessagesCursor = "oldest-cursor";
  api.listMessagesPage
    .mockResolvedValueOnce({
      items: historyWindow(41, 80),
      nextCursor: "opaque-41",
    })
    .mockResolvedValueOnce({
      items: [...historyWindow(1, 40), historyMessage(40)],
      nextCursor: null,
    });
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  expect(options.stateRef.current.messages.map((m) => m.id)).toEqual(
    historyWindow(1, 160).map((m) => m.id),
  );
  expect(
    api.listMessagesPage.mock.calls.map(([, opts]) => opts.cursor),
  ).toEqual(["opaque-81", "opaque-41"]);
  expect(options.stateRef.current.olderMessagesCursor).toBe("oldest-cursor");
});

it.each(["network", "repeated cursor", "duplicate page"])(
  "keeps the old window on %s and retries reads after showing the error",
  async (failure) => {
    vi.useFakeTimers();
    const { streams, options, unmount } = setupHistoryGap();
    if (failure === "network")
      api.listMessagesPage.mockRejectedValue(new Error("offline"));
    else if (failure === "repeated cursor")
      api.listMessagesPage.mockResolvedValue({
        items: historyWindow(41, 80),
        nextCursor: "opaque-81",
      });
    else
      api.listMessagesPage.mockResolvedValue({
        items: historyWindow(81, 120),
        nextCursor: "opaque-41",
      });
    await act(async () => {
      streams[0]!.emit(event("system.reset"));
    });
    expect(options.stateRef.current.messages.map((m) => m.id)).toEqual(
      historyWindow(1, 20).map((m) => m.id),
    );
    expect(options.stateRef.current.executionError).toMatch(
      /Unable to restore message history/,
    );
    expect(api.listMessagesPage).toHaveBeenCalledOnce();
    api.listMessagesPage.mockResolvedValue({
      items: historyWindow(1, 80),
      nextCursor: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(options.stateRef.current.messages.map((m) => m.id)).toEqual(
      historyWindow(1, 160).map((m) => m.id),
    );
    expect(options.stateRef.current.executionError).toBeNull();
    expect(options.workspace.run).not.toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  },
);

it("keeps retrying when the snapshot fails after a failed bridge page", async () => {
  vi.useFakeTimers();
  const { streams, options, unmount } = setupHistoryGap();
  options.stateRef.current.olderMessagesCursor = "oldest-cursor";
  api.listMessagesPage.mockRejectedValueOnce(new Error("page offline"));
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  expect(options.stateRef.current.executionError).toContain("page offline");
  expect(api.getSessionView).toHaveBeenCalledOnce();

  api.getSessionView.mockRejectedValueOnce(new Error("snapshot offline"));
  api.listMessagesPage.mockResolvedValue({
    items: historyWindow(1, 80),
    nextCursor: null,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
  expect(options.stateRef.current.executionError).toContain("snapshot offline");
  expect(options.stateRef.current.messages.map((m) => m.id)).toEqual(
    historyWindow(1, 20).map((m) => m.id),
  );
  expect(options.stateRef.current.olderMessagesCursor).toBe("oldest-cursor");
  expect(api.listMessagesPage).toHaveBeenCalledOnce();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(3);
  expect(options.stateRef.current.messages.map((m) => m.id)).toEqual(
    historyWindow(1, 160).map((m) => m.id),
  );
  expect(options.stateRef.current.olderMessagesCursor).toBe("oldest-cursor");
  expect(options.stateRef.current.executionError).toBeNull();
  expect(options.workspace.run).not.toHaveBeenCalled();
  unmount();
});

it("completes history recovery even when the separate world read fails", async () => {
  vi.useFakeTimers();
  const { streams, options, unmount } = setupHistoryGap();
  api.listMessagesPage
    .mockRejectedValueOnce(new Error("page offline"))
    .mockResolvedValue({ items: historyWindow(1, 80), nextCursor: null });
  api.getWorld.mockRejectedValue(new Error("world offline"));
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  expect(options.stateRef.current.executionError).toContain("page offline");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(options.stateRef.current.messages.map((m) => m.id)).toEqual(
    historyWindow(1, 160).map((m) => m.id),
  );
  expect(options.stateRef.current.executionError).toBeNull();
  expect(api.getWorld).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
  expect(options.workspace.run).not.toHaveBeenCalled();
  unmount();
});

it.each(["revisit", "unmount"])(
  "abandons bridge pagination after %s",
  async (leave) => {
    const pending = deferred<unknown>();
    const { streams, options, rerender, unmount } = setupHistoryGap();
    api.listMessagesPage.mockReturnValueOnce(pending.promise);
    await act(async () => {
      streams[0]!.emit(event("system.reset"));
    });
    if (leave === "unmount") unmount();
    else {
      options.sessionGenerationRef.current += 2;
      rerender();
    }
    options.dispatch.mockClear();
    await act(async () => {
      pending.resolve({
        items: historyWindow(41, 80),
        nextCursor: "opaque-41",
      });
    });
    expect(api.listMessagesPage).toHaveBeenCalledOnce();
    expect(options.dispatch).not.toHaveBeenCalled();
  },
);

it("a replaced recovery cannot continue pagination or publish its older window", async () => {
  const pending = deferred<unknown>();
  const { streams, options } = setupHistoryGap();
  api.listMessagesPage
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ items: historyWindow(1, 80), nextCursor: null });
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  expect(options.stateRef.current.messages).toHaveLength(160);
  options.dispatch.mockClear();
  await act(async () => {
    pending.resolve({ items: historyWindow(41, 80), nextCursor: "opaque-41" });
  });
  expect(api.listMessagesPage).toHaveBeenCalledTimes(2);
  expect(options.dispatch).not.toHaveBeenCalled();
});

it("bridge publication preserves a newer healthy POST tail and queued delta", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.set(++frameId, cb);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const pending = deferred<unknown>();
  const { streams, options } = setupHistoryGap();
  api.listMessagesPage
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ items: historyWindow(1, 80), nextCursor: null });
  await act(async () => {
    streams[0]!.emit(event("system.reset"));
  });
  options.dispatch({ type: "SET_EXECUTING", value: true });
  options.activeTurnIdRef.current = "new";
  const stream = createSseEventHandler({
    ...options,
    ds: {} as DataService,
    runtimeKindRef: { current: new Map([["story/main", "story"]]) },
    lastBackfilledTurnIdRef: { current: null },
  });
  stream({
    type: "narrative.delta",
    sessionId: session.id,
    turnId: "new",
    requestId: "new",
    traceId: "trace",
    flowId: "flow",
    seq: 1,
    timestamp: session.createdAt,
    payload: { runtimeId: "story/main", pluginId: "story", delta: "healthy" },
  });
  for (const cb of [...frames.values()]) cb(0);
  expect(getStreamingText("stream_new_story/main")).toBe("healthy");
  stream({
    type: "narrative.delta",
    sessionId: session.id,
    turnId: "new",
    requestId: "new",
    traceId: "trace",
    flowId: "flow",
    seq: 2,
    timestamp: session.createdAt,
    payload: { runtimeId: "story/main", pluginId: "story", delta: " queued" },
  });
  await act(async () => {
    pending.resolve({ items: historyWindow(1, 80), nextCursor: null });
  });
  expect(options.stateRef.current.messages.at(-1)?.id).toBe(
    "stream_new_story/main",
  );
  expect(getStreamingText("stream_new_story/main")).toBe("healthy");
  expect(options.stateRef.current.executing).toBe(true);
  expect(options.stateRef.current.executionRecovery).toBeNull();
  expect(
    options.stateRef.current.messages.filter((m) => m.id.startsWith("m")),
  ).toHaveLength(160);
  expect(options.deltaBufferRef.current.size).toBe(1);
  // Prevent this test's scheduled flush from escaping the fixture.
  const { clearNarrativeDeltaBuffer } = await import("../sse-handler.js");
  clearNarrativeDeltaBuffer(options.deltaBufferRef, options.deltaRafRef);
});
