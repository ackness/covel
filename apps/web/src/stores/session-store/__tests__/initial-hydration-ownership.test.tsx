import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  SessionRecord,
  SessionPlugin,
  WorldRecord,
} from "@/services/api.js";
import type { DataService, SessionWorkspace } from "@/services/data-service.js";
import type { SubscriptionEvent } from "@/services/subscription.js";
import {
  __clearAllPluginDataForTest,
  getPluginNamespaceSnapshot,
  setActiveSession,
} from "@/stores/plugin-data-store.js";
import { initialState, reducer } from "../reducer.js";
import { restoreSessionState } from "../restore-session.js";
import {
  createSubscriptionEventHandler,
  rehydrateSessionSideState,
} from "../subscription.js";
import { createSseEventHandler } from "../sse-handler.js";
import { hydratePluginDataForUiSpecs } from "../plugin-data-hydration.js";
import { useUiSpecHydrationEffect } from "../effects.js";
import type { SessionAction, SessionState } from "../types.js";

const api = vi.hoisted(() => ({
  fetchUiSpecs: vi.fn(),
  listPluginData: vi.fn(),
  listSessionPlugins: vi.fn(),
  listSuspensions: vi.fn(),
  getSessionView: vi.fn(),
  getSession: vi.fn(),
  getWorld: vi.fn(),
  markServerAck: vi.fn(),
}));
vi.mock("@/services/api", () => api);

const session: SessionRecord = {
  id: "session",
  worldId: "world",
  incarnation: "incarnation",
  locale: "en-US",
  status: "active",
  phase: "playing",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  activePlugins: [],
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
};
const world: WorldRecord = {
  id: "world",
  name: "World",
  description: "",
  createdAt: session.createdAt,
};
const plugin = (id: string) => ({ id, active: true }) as SessionPlugin;
const suspension = {
  id: "suspension",
  sessionId: session.id,
  turnId: "turn",
  pluginId: "plugin",
  runtimeId: "runtime",
  createdAt: session.createdAt,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(batched = false) {
  const sessionIdRef = { current: session.id as string | null };
  const sessionGenerationRef = { current: 0 };
  const stateRef = { current: { ...initialState, session } as SessionState };
  const queued: SessionAction[] = [];
  const dispatch = (action: SessionAction) => {
    if (batched) queued.push(action);
    else stateRef.current = reducer(stateRef.current, action);
  };
  const flush = () => {
    for (const action of queued.splice(0))
      stateRef.current = reducer(stateRef.current, action);
  };
  const workspace = {
    hydrate: vi.fn(async () => {}),
  } as unknown as SessionWorkspace;
  const ds = {
    listMessages: vi.fn(async () => []),
    listStatePatches: vi.fn(async () => []),
    addStatePatch: vi.fn(async () => {}),
    loadExecutionSteps: vi.fn(async () => []),
    loadSubmittedBlocks: vi.fn(async () => ({ ids: [], values: {} })),
  } as unknown as DataService;
  const handler = createSubscriptionEventHandler({
    sessionIdRef,
    stateRef,
    dispatch,
    onReset: () => {},
    isCurrent: () => true,
    getRecoveryGeneration: () => 0,
  });
  const actionStream = createSseEventHandler({
    dispatch,
    ds,
    sessionIdRef,
    stateRef,
    runtimeKindRef: { current: new Map() },
    deltaBufferRef: { current: new Map() },
    deltaRafRef: { current: null },
    lastBackfilledTurnIdRef: { current: null },
  });
  const send = (
    transport: string,
    type: string,
    payload: Record<string, unknown>,
  ) => {
    if (transport === "subscription") handler(event(type, payload));
    else
      actionStream({
        type,
        payload,
        sessionId: session.id,
        timestamp: session.createdAt,
        requestId: "request",
        traceId: "trace",
        turnId: "turn",
        flowId: "flow",
        seq: 1,
      });
  };
  const restore = () =>
    restoreSessionState({
      session,
      worlds: [world],
      ds,
      workspace,
      dispatch,
      sessionIdRef,
      sessionGenerationRef,
    });
  return {
    stateRef,
    dispatch,
    handler,
    restore,
    send,
    flush,
    sessionGenerationRef,
    sessionIdRef,
    ds,
  };
}
function event(
  type: string,
  payload: Record<string, unknown> = {},
): SubscriptionEvent {
  return {
    id: type,
    type,
    sessionId: session.id,
    timestamp: session.createdAt,
    topic: "plugin",
    payload,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  __clearAllPluginDataForTest();
  setActiveSession(session.id);
  api.getSession.mockResolvedValue(session);
  api.getWorld.mockResolvedValue(world);
  api.getSessionView.mockResolvedValue({
    session,
    messages: [],
    characters: [],
    gameState: {},
    executionSteps: [],
  });
  api.listSessionPlugins.mockResolvedValue({
    items: [plugin("current")],
    commands: [],
  });
  api.listSuspensions.mockResolvedValue([]);
  api.listPluginData.mockResolvedValue([]);
  api.fetchUiSpecs.mockResolvedValue({
    right: [],
    message: [{ pluginId: "plugin", specs: [] }],
  });
});

it("does not overwrite a plugin toggle with a late initial restore list", async () => {
  const old = deferred<unknown>();
  api.listSessionPlugins.mockReturnValueOnce(old.promise);
  const { stateRef, handler, restore } = setup();
  await restore();
  expect(api.listSessionPlugins).toHaveBeenCalledOnce();
  await act(async () => {
    handler(event("plugin.activated"));
  });
  expect(stateRef.current.sessionPlugins.map(({ id }) => id)).toEqual([
    "current",
  ]);
  await act(async () => {
    old.resolve({ items: [plugin("obsolete")], commands: [] });
  });
  expect(stateRef.current.sessionPlugins.map(({ id }) => id)).toEqual([
    "current",
  ]);
});

it("does not restore a resumed suspension from a late initial list", async () => {
  const old = deferred<unknown>();
  api.listSuspensions.mockReturnValueOnce(old.promise);
  const { stateRef, handler, restore } = setup();
  await restore();
  handler(
    event("turn.suspended", {
      suspensionId: suspension.id,
      turnId: suspension.turnId,
      runtimeId: suspension.runtimeId,
      pluginId: suspension.pluginId,
    }),
  );
  expect(stateRef.current.suspensions).toHaveLength(1);
  handler(event("turn.resumed", { suspensionId: suspension.id }));
  expect(stateRef.current.suspensions).toEqual([]);
  await act(async () => {
    old.resolve([suspension]);
  });
  expect(stateRef.current.suspensions).toEqual([]);
});

it.each([
  { operation: "set", transport: "subscription" },
  { operation: "delete", transport: "subscription" },
  { operation: "set", transport: "action" },
  { operation: "delete", transport: "action" },
])(
  "preserves live $transport namespace $operation and hydrates untouched fields",
  async ({ operation, transport }) => {
    const old = deferred<unknown>();
    api.listPluginData.mockReturnValueOnce(old.promise);
    const { stateRef, send, dispatch, sessionGenerationRef } = setup();
    renderHook(() =>
      useUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef, []),
    );
    await waitFor(() => expect(api.listPluginData).toHaveBeenCalledOnce());
    api.listPluginData.mockResolvedValue([
      ...(operation === "set"
        ? [
            {
              namespace: "message",
              key: "value",
              value: "current",
              updatedAt: session.updatedAt,
            },
          ]
        : []),
      {
        namespace: "message",
        key: "untouched",
        value: "kept",
        updatedAt: session.updatedAt,
      },
    ]);
    send(transport, "plugin-data.changed", {
      pluginId: "plugin",
      changes: [
        { namespace: "message", key: "value", value: "current", operation },
      ],
    });
    await act(async () => {
      old.resolve([
        {
          namespace: "message",
          key: "value",
          value: "obsolete",
          updatedAt: session.updatedAt,
        },
      ]);
    });
    const expected =
      operation === "set"
        ? { value: "current", untouched: "kept" }
        : { untouched: "kept" };
    expect(stateRef.current.pluginData.plugin?.message).toEqual(expected);
    expect(getPluginNamespaceSnapshot("plugin", "message")).toEqual(expected);
    expect(api.listPluginData).toHaveBeenCalledTimes(2);
  },
);

it.each([
  { pluginId: "other-plugin", namespace: "message" },
  { pluginId: "plugin", namespace: "state" },
])(
  "keeps message hydration independent of $pluginId/$namespace changes",
  async ({ pluginId, namespace }) => {
    const old = deferred<unknown>();
    api.listPluginData.mockReturnValueOnce(old.promise);
    const { stateRef, handler, dispatch, sessionGenerationRef } = setup();
    renderHook(() =>
      useUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef, []),
    );
    await waitFor(() => expect(api.listPluginData).toHaveBeenCalledOnce());
    handler(
      event("plugin-data.changed", {
        pluginId,
        changes: [
          { namespace, key: "value", value: "current", operation: "set" },
        ],
      }),
    );
    await act(async () => {
      old.resolve([
        {
          namespace: "message",
          key: "value",
          value: "initial",
          updatedAt: session.updatedAt,
        },
      ]);
    });
    expect(stateRef.current.pluginData.plugin?.message).toEqual({
      value: "initial",
    });
    expect(stateRef.current.pluginData[pluginId]?.[namespace]).toEqual({
      value: "current",
    });
    expect(api.listPluginData).toHaveBeenCalledOnce();
  },
);

it("does not re-read or publish a dirty namespace after unmount", async () => {
  const old = deferred<unknown>();
  api.listPluginData.mockReturnValueOnce(old.promise);
  const { stateRef, handler, dispatch, sessionGenerationRef } = setup();
  const { unmount } = renderHook(() =>
    useUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef, []),
  );
  await waitFor(() => expect(api.listPluginData).toHaveBeenCalledOnce());
  handler(
    event("plugin-data.changed", {
      pluginId: "plugin",
      changes: [
        {
          namespace: "message",
          key: "value",
          value: "current",
          operation: "set",
        },
      ],
    }),
  );
  unmount();
  await act(async () => {
    old.resolve([{ namespace: "message", key: "value", value: "obsolete" }]);
  });
  expect(api.listPluginData).toHaveBeenCalledOnce();
  expect(stateRef.current.pluginData.plugin?.message).toEqual({
    value: "current",
  });
  expect(getPluginNamespaceSnapshot("plugin", "message")).toEqual({
    value: "current",
  });
});

it("does not let a previous same-session visit retry over the new visit", async () => {
  const old = deferred<unknown>();
  api.listPluginData.mockReturnValueOnce(old.promise);
  const { stateRef, handler, dispatch, sessionGenerationRef } = setup();
  const { rerender } = renderHook(() =>
    useUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef, []),
  );
  await waitFor(() => expect(api.listPluginData).toHaveBeenCalledOnce());
  handler(
    event("plugin-data.changed", {
      pluginId: "plugin",
      changes: [
        {
          namespace: "message",
          key: "value",
          value: "current",
          operation: "set",
        },
      ],
    }),
  );
  api.listPluginData.mockResolvedValue([
    { namespace: "message", key: "value", value: "new-visit" },
  ]);
  sessionGenerationRef.current += 1;
  rerender();
  await waitFor(() =>
    expect(getPluginNamespaceSnapshot("plugin", "message")).toEqual({
      value: "new-visit",
    }),
  );
  await act(async () => {
    old.resolve([{ namespace: "message", key: "value", value: "obsolete" }]);
  });
  expect(api.listPluginData).toHaveBeenCalledTimes(2);
  expect(stateRef.current.pluginData.plugin?.message).toEqual({
    value: "new-visit",
  });
});

it("re-reads an initial UI spec response invalidated by a committed plugin toggle", async () => {
  const old = deferred<unknown>();
  api.fetchUiSpecs.mockReturnValueOnce(old.promise);
  api.fetchUiSpecs.mockResolvedValue({
    right: [],
    message: [{ pluginId: "current-plugin", specs: [] }],
  });
  const { stateRef, handler, dispatch, sessionGenerationRef } = setup();
  renderHook(() =>
    useUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef, []),
  );
  handler(event("plugin.activated"));
  await act(async () => {
    old.resolve({
      right: [],
      message: [{ pluginId: "obsolete-plugin", specs: [] }],
    });
  });
  expect(api.fetchUiSpecs).toHaveBeenCalledTimes(2);
  expect(api.listPluginData).toHaveBeenCalledExactlyOnceWith(
    session.id,
    "current-plugin",
    "message",
  );
  expect(
    stateRef.current.messageUiSpecs.map((entry) => entry.pluginId),
  ).toEqual(["current-plugin"]);
});

it.each(["server", "local fallback"])(
  "preserves live subscription messages while the initial %s history loads",
  async (source) => {
    const pending = deferred<unknown>();
    api.getSessionView.mockReturnValueOnce(pending.promise);
    const history = {
      id: "history",
      role: "assistant" as const,
      content: "Earlier",
      sessionId: session.id,
      createdAt: "2026-09-18T00:00:00Z",
    };
    const { restore, handler, stateRef, ds } = setup();
    vi.mocked(ds.listMessages).mockResolvedValue([history]);
    const restoring = restore();
    await waitFor(() => expect(api.getSessionView).toHaveBeenCalledOnce());
    handler(
      event("interaction.requested", {
        turnId: "manual-turn",
        block: {
          id: "current-block",
          type: "interactive_form",
          data: { interactionId: "check", fields: [] },
          meta: { runtimeId: "plugin/check" },
        },
      }),
    );
    expect(stateRef.current.messages.map((message) => message.id)).toEqual([
      "current-block",
    ]);
    await act(async () => {
      if (source === "server")
        pending.resolve({
          session,
          messages: [history],
          characters: [],
          gameState: {},
          executionSteps: [],
        });
      else pending.reject(new Error("offline"));
      await restoring;
    });
    expect(stateRef.current.messages.map((message) => message.id)).toEqual([
      "history",
      "current-block",
    ]);
  },
);

it.each(["restore", "reconnect"])(
  "re-reads an older game snapshot after %s publishes the current view",
  async (first) => {
    const initial = deferred<unknown>();
    const reconnect = deferred<unknown>();
    const currentView = {
      session,
      messages: [],
      characters: [],
      gameState: { stats: { hp: 9, mp: 3 } },
      executionSteps: [],
      execution: { state: "idle" },
    };
    api.getSessionView
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(reconnect.promise)
      .mockResolvedValue(currentView);
    const { restore, stateRef, sessionIdRef, dispatch } = setup();
    const restoring = restore();
    await waitFor(() => expect(api.getSessionView).toHaveBeenCalledOnce());
    const recovering = rehydrateSessionSideState(
      session.id,
      sessionIdRef,
      dispatch,
      () => true,
      {
        stateRef,
        activeTurnIdRef: { current: null },
      },
    );
    await act(async () => {
      (first === "restore" ? initial : reconnect).resolve(currentView);
      await (first === "restore" ? restoring : recovering);
    });
    expect(stateRef.current.gameState).toEqual({
      ...currentView.gameState,
      characters: [],
    });
    await act(async () => {
      (first === "restore" ? reconnect : initial).resolve({
        ...currentView,
        gameState: { stats: { hp: 1 } },
      });
      await Promise.all([restoring, recovering]);
    });
    expect(stateRef.current.gameState).toEqual({
      ...currentView.gameState,
      characters: [],
    });
    expect(api.getSessionView).toHaveBeenCalledTimes(3);
  },
);

it("accepts an empty authoritative initial view after committed state was deleted", async () => {
  const pending = deferred<unknown>();
  api.getSessionView.mockReturnValueOnce(pending.promise);
  const { restore, stateRef, send } = setup();
  const restoring = restore();
  await waitFor(() => expect(api.getSessionView).toHaveBeenCalledOnce());
  send("action", "state.changed", { table: "stats", field: "hp", value: 9 });
  await act(async () => {
    pending.resolve({
      session,
      messages: [],
      characters: [],
      gameState: { stats: { hp: 1 } },
      executionSteps: [],
    });
    await restoring;
  });
  expect(stateRef.current.gameState).toEqual({ characters: [] });
  expect(api.getSessionView).toHaveBeenCalledTimes(2);
});

it("keeps newer contents for a shared message ID and adopts the initial history cursor", async () => {
  const pending = deferred<unknown>();
  api.getSessionView.mockReturnValueOnce(pending.promise);
  const { restore, handler, stateRef } = setup();
  const restoring = restore();
  await waitFor(() => expect(api.getSessionView).toHaveBeenCalledOnce());
  const block = {
    id: "current-block",
    type: "interactive_form",
    data: { interactionId: "current", fields: [] },
    meta: { runtimeId: "plugin/check" },
  };
  handler(event("interaction.requested", { turnId: "turn", block }));
  await act(async () => {
    pending.resolve({
      session,
      characters: [],
      gameState: {},
      executionSteps: [],
      messagesCursor: "older-edge",
      messages: [
        {
          id: block.id,
          role: "assistant",
          content: "Obsolete",
          sessionId: session.id,
          createdAt: session.createdAt,
          turnId: "turn",
          block: { ...block, data: { interactionId: "obsolete" } },
        },
      ],
    });
    await restoring;
  });
  expect(stateRef.current.messages).toHaveLength(1);
  expect(stateRef.current.messages[0]?.block).toEqual(block);
  expect(stateRef.current.olderMessagesCursor).toBe("older-edge");
});

it("projects committed state changes with the same table/field shape as session views", () => {
  const { stateRef, send } = setup();
  stateRef.current = {
    ...stateRef.current,
    gameState: { stats: { hp: 1, mp: 3 }, weather: { sky: "clear" } },
  };
  send("action", "state.changed", { table: "stats", field: "hp", value: 9 });
  expect(stateRef.current.gameState).toEqual({
    stats: { hp: 9, mp: 3 },
    weather: { sky: "clear" },
  });
});

it("keeps live state patches when the local fallback returns an older history", async () => {
  api.getSessionView.mockRejectedValue(new Error("offline"));
  const pending =
    deferred<Awaited<ReturnType<DataService["listStatePatches"]>>>();
  const { restore, stateRef, send, ds } = setup();
  vi.mocked(ds.listStatePatches).mockReturnValueOnce(pending.promise);
  const restoring = restore();
  await waitFor(() => expect(ds.listStatePatches).toHaveBeenCalledOnce());
  send("action", "state.changed", { table: "stats", field: "hp", value: 9 });
  await act(async () => {
    pending.resolve([
      {
        id: "history-patch",
        sessionId: session.id,
        summary: "Earlier",
        packageName: "plugin",
        data: { stats: { hp: 1, mp: 3 } },
        createdAt: session.createdAt,
      },
      {
        ...stateRef.current.statePatches[0]!,
        sessionId: session.id,
        data: { stats: { hp: 1 } },
        createdAt: session.createdAt,
      },
    ]);
    await restoring;
  });
  expect(stateRef.current.gameState).toEqual({ stats: { hp: 9, mp: 3 } });
  expect(stateRef.current.statePatches).toHaveLength(2);
  expect(stateRef.current.hasGameStateSnapshot).toBe(false);
});

it("does not rebuild deleted fields from cached patches after an authoritative empty snapshot", async () => {
  api.getSessionView.mockRejectedValueOnce(new Error("offline"));
  const pending =
    deferred<Awaited<ReturnType<DataService["listStatePatches"]>>>();
  const { restore, stateRef, sessionIdRef, dispatch, ds } = setup();
  vi.mocked(ds.listStatePatches).mockReturnValueOnce(pending.promise);
  const restoring = restore();
  await waitFor(() => expect(ds.listStatePatches).toHaveBeenCalledOnce());
  await rehydrateSessionSideState(session.id, sessionIdRef, dispatch);
  await act(async () => {
    pending.resolve([
      {
        id: "history-patch",
        sessionId: session.id,
        summary: "Earlier",
        packageName: "plugin",
        data: { stats: { hp: 1 } },
        createdAt: session.createdAt,
      },
    ]);
    await restoring;
  });
  expect(stateRef.current.gameState).toEqual({ characters: [] });
  expect(stateRef.current.statePatches).toHaveLength(1);
});

it("preserves independent character commits delivered before React publishes the next state ref", () => {
  const { send, flush, stateRef } = setup(true);
  const characters = [
    { id: "one", name: "One", type: "npc" },
    { id: "two", name: "Two", type: "npc" },
  ];
  for (const character of characters)
    send("action", "character.upserted", { character });
  flush();
  expect(stateRef.current.gameState.characters).toEqual(characters);
  expect(stateRef.current.hasGameStateSnapshot).toBe(false);
});

it.each([
  { empty: false, source: "provider" },
  { empty: true, source: "provider" },
  { empty: false, source: "start" },
  { empty: true, source: "start" },
])(
  "replaces the $source message-only namespace in both stores when its snapshot is empty=$empty",
  async ({ empty, source }) => {
    const { stateRef, handler, dispatch, sessionGenerationRef } = setup();
    handler(
      event("plugin-data.changed", {
        pluginId: "plugin",
        changes: [
          {
            namespace: "message",
            key: "removed-turn",
            value: { turnId: "removed-turn", text: "Old" },
            operation: "set",
          },
          {
            namespace: "unrelated",
            key: "keep",
            value: true,
            operation: "set",
          },
        ],
      }),
    );
    api.fetchUiSpecs.mockResolvedValue({
      right: [],
      message: [
        {
          pluginId: "plugin",
          specs: [{ id: "message", dataSource: { namespace: "message" } }],
        },
      ],
    });
    const value = { turnId: "current-turn", text: "Current" };
    api.listPluginData.mockResolvedValue(
      empty ? [] : [{ namespace: "message", key: "current-turn", value }],
    );
    if (source === "provider") {
      renderHook(() =>
        useUiSpecHydrationEffect(
          session.id,
          dispatch,
          sessionGenerationRef,
          [],
        ),
      );
      await act(async () => {});
    } else await hydratePluginDataForUiSpecs(session.id, dispatch);
    const expected = empty ? {} : { "current-turn": value };
    expect(getPluginNamespaceSnapshot("plugin", "message")).toEqual(expected);
    expect(stateRef.current.pluginData.plugin?.message).toEqual(expected);
    expect(stateRef.current.pluginData.plugin?.unrelated).toEqual({
      keep: true,
    });
    if (source === "provider")
      expect(stateRef.current.messages.map((message) => message.id)).toEqual(
        empty ? [] : ["plugin-message:plugin:current-turn"],
      );
  },
);

it("retains an own __proto__ message key in both hydration stores", async () => {
  const { stateRef, dispatch, sessionGenerationRef } = setup();
  const value = { marker: "retained" };
  api.listPluginData.mockResolvedValue([
    { namespace: "message", key: "__proto__", value },
  ]);
  renderHook(() =>
    useUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef, []),
  );
  await act(async () => {});
  const external = getPluginNamespaceSnapshot("plugin", "message");
  expect(Object.hasOwn(external, "__proto__")).toBe(true);
  expect(
    Object.hasOwn(stateRef.current.pluginData.plugin!.message!, "__proto__"),
  ).toBe(true);
  expect(external["__proto__"]).toEqual(value);
  expect(stateRef.current.pluginData.plugin!.message!["__proto__"]).toEqual(
    value,
  );
});

it("preserves and deletes special own plugin-data properties in both live stores", () => {
  const { stateRef, handler } = setup();
  const value = { marker: "retained" };
  for (const namespace of ["__proto__", "message"]) {
    handler(
      event("plugin-data.changed", {
        pluginId: "plugin",
        changes: [{ namespace, key: "__proto__", value, operation: "set" }],
      }),
    );
    const external = getPluginNamespaceSnapshot("plugin", namespace);
    expect(Object.hasOwn(stateRef.current.pluginData.plugin!, namespace)).toBe(
      true,
    );
    expect(Object.hasOwn(external, "__proto__")).toBe(true);
    expect(
      Object.hasOwn(
        stateRef.current.pluginData.plugin![namespace]!,
        "__proto__",
      ),
    ).toBe(true);
    expect(external["__proto__"]).toEqual(value);
    handler(
      event("plugin-data.changed", {
        pluginId: "plugin",
        changes: [{ namespace, key: "__proto__", operation: "delete" }],
      }),
    );
    expect(
      Object.hasOwn(
        getPluginNamespaceSnapshot("plugin", namespace),
        "__proto__",
      ),
    ).toBe(false);
    expect(
      Object.hasOwn(
        stateRef.current.pluginData.plugin![namespace]!,
        "__proto__",
      ),
    ).toBe(false);
  }
});

it("preserves special own namespace/key properties in whole-plugin recovery without prototype pollution", async () => {
  const probe = "__browserRecoveryPrototypeProbe__";
  const original = Object.getOwnPropertyDescriptor(Object.prototype, probe);
  api.listSessionPlugins.mockResolvedValue({
    items: [plugin("plugin")],
    commands: [],
  });
  api.listPluginData.mockResolvedValue([
    { namespace: "__proto__", key: probe, value: "kept" },
    { namespace: "panel", key: "__proto__", value: { marker: "kept" } },
  ]);
  const { stateRef, sessionIdRef, dispatch } = setup();
  try {
    await rehydrateSessionSideState(session.id, sessionIdRef, dispatch);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, probe)).toEqual(
      original,
    );
    expect(
      Object.hasOwn(stateRef.current.pluginData.plugin!, "__proto__"),
    ).toBe(true);
    expect(
      Object.hasOwn(getPluginNamespaceSnapshot("plugin", "__proto__"), probe),
    ).toBe(true);
    expect(
      Object.hasOwn(stateRef.current.pluginData.plugin!.panel!, "__proto__"),
    ).toBe(true);
    expect(
      Object.hasOwn(getPluginNamespaceSnapshot("plugin", "panel"), "__proto__"),
    ).toBe(true);
    expect(getPluginNamespaceSnapshot("plugin", "__proto__")[probe]).toBe(
      "kept",
    );
  } finally {
    if (original) Object.defineProperty(Object.prototype, probe, original);
    else Reflect.deleteProperty(Object.prototype, probe);
  }
});

it("preserves special own namespace/key properties through the start-game namespace seed", async () => {
  const { dispatch, stateRef } = setup();
  api.fetchUiSpecs.mockResolvedValue({
    right: [
      {
        pluginId: "plugin",
        specs: [{ dataSource: { namespace: "__proto__" } }],
      },
    ],
    message: [],
  });
  const value = { marker: "retained" };
  api.listPluginData.mockResolvedValue([
    { namespace: "__proto__", key: "__proto__", value },
  ]);
  await hydratePluginDataForUiSpecs(session.id, dispatch);
  const namespaces = stateRef.current.pluginData.plugin!;
  expect(Object.hasOwn(namespaces, "__proto__")).toBe(true);
  expect(Object.hasOwn(namespaces["__proto__"]!, "__proto__")).toBe(true);
  expect(
    Object.hasOwn(
      getPluginNamespaceSnapshot("plugin", "__proto__"),
      "__proto__",
    ),
  ).toBe(true);
  expect(
    getPluginNamespaceSnapshot("plugin", "__proto__")["__proto__"],
  ).toEqual(value);
});
