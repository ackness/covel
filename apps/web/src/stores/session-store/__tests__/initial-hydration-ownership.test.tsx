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
import { createSubscriptionEventHandler } from "../subscription.js";
import { createSseEventHandler } from "../sse-handler.js";
import { useMessageUiSpecHydrationEffect } from "../effects.js";
import type { SessionAction, SessionState } from "../types.js";

const api = vi.hoisted(() => ({
  fetchUiSpecs: vi.fn(),
  listPluginData: vi.fn(),
  listSessionPlugins: vi.fn(),
  listSuspensions: vi.fn(),
  getSessionView: vi.fn(),
  getSession: vi.fn(),
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const sessionIdRef = { current: session.id as string | null };
  const sessionGenerationRef = { current: 0 };
  const stateRef = { current: { ...initialState, session } as SessionState };
  const dispatch = (action: SessionAction) => {
    stateRef.current = reducer(stateRef.current, action);
  };
  const workspace = {
    hydrate: vi.fn(async () => {}),
  } as unknown as SessionWorkspace;
  const ds = {
    loadExecutionSteps: vi.fn(async () => []),
    loadSubmittedBlocks: vi.fn(async () => ({ ids: [], values: {} })),
  } as unknown as DataService;
  const handler = createSubscriptionEventHandler({
    sessionIdRef,
    stateRef,
    dispatch,
    workspace,
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
  return { stateRef, dispatch, handler, restore, send, sessionGenerationRef };
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
      useMessageUiSpecHydrationEffect(
        session.id,
        dispatch,
        sessionGenerationRef,
      ),
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
      useMessageUiSpecHydrationEffect(
        session.id,
        dispatch,
        sessionGenerationRef,
      ),
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
    useMessageUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef),
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
    useMessageUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef),
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
    useMessageUiSpecHydrationEffect(session.id, dispatch, sessionGenerationRef),
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
