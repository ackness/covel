import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  SessionRecord,
  SessionPlugin,
  UISpecsResponse,
} from "@/services/api.js";
import {
  __clearAllPluginDataForTest,
  getPluginNamespaceSnapshot,
  setActiveSession,
} from "@/stores/plugin-data-store.js";
import { useUiSpecHydrationEffect } from "@/stores/session-store/effects.js";
import { reducePluginDataChanged } from "@/stores/session-store/event-reducers.js";
import { initialState, reducer } from "@/stores/session-store/reducer.js";
import type {
  SessionAction,
  SessionState,
} from "@/stores/session-store/types.js";
import { RightPanel } from "../right-panel.js";

const api = vi.hoisted(() => ({
  fetchUiSpecs: vi.fn(),
  fetchServerHealth: vi.fn(),
  listPluginData: vi.fn(),
}));
const context = vi.hoisted(() => ({ plugins: [] as SessionPlugin[] }));
vi.mock("@/services/api.js", () => api);
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { sessionPlugins: context.plugins } }),
}));
vi.mock("../world-document-panel.js", () => ({
  WorldDocumentPanel: () => <div />,
}));
vi.mock("../database-panel.js", () => ({ DatabasePanel: () => <div /> }));
vi.mock("../memory-update-notice.js", () => ({
  MemoryUpdateNotice: () => null,
}));
vi.mock("../plugin-panel.js", () => ({ PluginPanel: () => <div /> }));

const session: SessionRecord = {
  id: "session",
  worldId: "world",
  incarnation: "incarnation",
  locale: "en-US",
  status: "active",
  phase: "playing",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  activePlugins: ["provider"],
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
};
const specs = {
  right: [
    {
      pluginId: "provider",
      specs: [
        {
          id: "panel",
          group: "panel",
          groupLabel: "Panel",
          label: "Panel",
          icon: "book-open",
          view: { component: "Text" },
        },
      ],
    },
  ],
  message: [],
} as unknown as UISpecsResponse;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  __clearAllPluginDataForTest();
  setActiveSession(session.id);
  context.plugins = [{ id: "provider", active: true } as SessionPlugin];
  api.fetchUiSpecs.mockResolvedValue(specs);
  api.fetchServerHealth.mockResolvedValue({});
});

it.each(["set", "delete"] as const)(
  "keeps a live right-panel namespace %s while the initial seed finishes",
  async (operation) => {
    const old = deferred<unknown>();
    api.listPluginData.mockReturnValueOnce(old.promise).mockResolvedValue([
      ...(operation === "set"
        ? [
            {
              namespace: "panel",
              key: "value",
              value: "current",
              updatedAt: session.updatedAt,
            },
          ]
        : []),
      {
        namespace: "unlisted-namespace",
        key: "untouched",
        value: "retained",
        updatedAt: session.updatedAt,
      },
    ]);
    let state: SessionState = { ...initialState, session };
    const dispatch = (action: SessionAction) => {
      state = reducer(state, action);
    };
    const generation = { current: 1 };
    renderHook(() =>
      useUiSpecHydrationEffect(
        session.id,
        dispatch,
        generation,
        context.plugins,
      ),
    );
    render(
      <RightPanel sessionId={session.id} world={null} statePatches={[]} />,
    );
    await waitFor(() =>
      expect(api.listPluginData).toHaveBeenCalledExactlyOnceWith(
        session.id,
        "provider",
      ),
    );
    reducePluginDataChanged(
      dispatch,
      {
        pluginId: "provider",
        changes: [
          { namespace: "panel", key: "value", value: "current", operation },
        ],
      },
      session.id,
    );
    await act(async () => {
      old.resolve([
        {
          namespace: "panel",
          key: "value",
          value: "obsolete",
          updatedAt: session.updatedAt,
        },
      ]);
    });
    expect(getPluginNamespaceSnapshot("provider", "panel")).toEqual(
      operation === "set" ? { value: "current" } : {},
    );
    expect(
      getPluginNamespaceSnapshot("provider", "unlisted-namespace"),
    ).toEqual({ untouched: "retained" });
    expect(api.listPluginData).toHaveBeenCalledTimes(2);
  },
);

it("refreshes the provider seed when active plugins change and removes vanished namespaces", async () => {
  const old = deferred<unknown>();
  api.listPluginData.mockReturnValueOnce(old.promise).mockResolvedValue([]);
  let state: SessionState = { ...initialState, session };
  const dispatch = (action: SessionAction) => {
    state = reducer(state, action);
  };
  reducePluginDataChanged(
    dispatch,
    {
      pluginId: "provider",
      changes: [
        { namespace: "removed", key: "stale", value: true, operation: "set" },
      ],
    },
    session.id,
  );
  reducePluginDataChanged(
    dispatch,
    {
      pluginId: "other",
      changes: [
        { namespace: "message", key: "kept", value: true, operation: "set" },
      ],
    },
    session.id,
  );
  const generation = { current: 1 };
  const { rerender } = renderHook(() =>
    useUiSpecHydrationEffect(session.id, dispatch, generation, context.plugins),
  );
  await waitFor(() => expect(api.listPluginData).toHaveBeenCalledOnce());
  context.plugins = [
    ...context.plugins,
    { id: "other", active: true } as SessionPlugin,
  ];
  rerender();
  await waitFor(() => expect(api.listPluginData).toHaveBeenCalledTimes(2));
  await act(async () => {
    old.resolve([{ namespace: "removed", key: "stale", value: true }]);
  });
  expect(state.pluginData.provider).toEqual({});
  expect(getPluginNamespaceSnapshot("provider", "removed")).toEqual({});
  expect(state.pluginData.other?.message).toEqual({ kept: true });
  expect(getPluginNamespaceSnapshot("other", "message")).toEqual({
    kept: true,
  });
  expect(api.listPluginData).toHaveBeenCalledTimes(2);
});

it.each(["namespace", "key"] as const)(
  "preserves an own __proto__ %s in the provider seed without changing Object.prototype",
  async (field) => {
    const probe = "__browserSeedPrototypeProbe__";
    const original = Object.getOwnPropertyDescriptor(Object.prototype, probe);
    const namespace = field === "namespace" ? "__proto__" : "panel";
    const key = field === "key" ? "__proto__" : probe;
    const value = { marker: "retained" };
    api.listPluginData.mockResolvedValue([{ namespace, key, value }]);
    let state: SessionState = { ...initialState, session };
    const dispatch = (action: SessionAction) => {
      state = reducer(state, action);
    };
    const generation = { current: 1 };
    const hook = renderHook(() =>
      useUiSpecHydrationEffect(
        session.id,
        dispatch,
        generation,
        context.plugins,
      ),
    );
    try {
      await act(async () => {});
      expect(Object.getOwnPropertyDescriptor(Object.prototype, probe)).toEqual(
        original,
      );
      expect(Object.hasOwn(state.pluginData.provider!, namespace)).toBe(true);
      const external = getPluginNamespaceSnapshot("provider", namespace);
      expect(Object.hasOwn(external, key)).toBe(true);
      expect(Object.hasOwn(state.pluginData.provider![namespace]!, key)).toBe(
        true,
      );
      expect(external[key]).toEqual(value);
      expect(state.pluginData.provider![namespace]![key]).toEqual(value);
    } finally {
      hook.unmount();
      if (original) Object.defineProperty(Object.prototype, probe, original);
      else Reflect.deleteProperty(Object.prototype, probe);
    }
  },
);
