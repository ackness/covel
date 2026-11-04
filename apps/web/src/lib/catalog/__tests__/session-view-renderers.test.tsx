import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { covelRegistry, segmentTemplateRegistry } from "../../catalog.js";
import { pluginPanelViewToSpec } from "../../plugin-panel-spec.js";
import { PluginPanel } from "@/components/session/plugin-panel.js";
import {
  PluginViewSessionContext,
  type PluginViewSession,
} from "@/components/session/plugin-view-session-context.js";
import {
  SessionActionsContext,
  SessionStateContext,
  type SessionActions,
} from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import {
  setActiveSession,
  loadPluginDataForSession,
  applyChanges,
} from "@/stores/plugin-data-store.js";
import i18n from "@/i18n/index.js";
import graphPanel from "../../../../../../plugins/npc-graph/runtimes/extractor/ui/npc-graph-panel.json";
import libraryPanel from "../../../../../../plugins/codex/ui/codex-panel.json";
// A package page would reuse a panel's spec; mount it twice to prove both read one store.
const graphView = { ...graphPanel, alwaysRender: true };
const libraryView = { ...libraryPanel, alwaysRender: true };

vi.mock("@/settings/use-settings.js", () => ({ useSetting: () => [false] }));
vi.mock("@/components/session/use-session-bridge.js", () => ({
  useSessionBridge: () => ({ projection: null }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));
const actions = { submitComposerAction: vi.fn() } as unknown as SessionActions;
const state = {
  ...initialState,
  session: { id: "s" } as NonNullable<typeof initialState.session>,
};
const slots: PluginViewSession = {
  sessionId: "s",
  renderMessages: (content) => <p>Public {content}</p>,
  renderComposer: () => <button>Host input</button>,
};
function shell(children: React.ReactNode) {
  return (
    <SessionActionsContext.Provider value={actions}>
      <SessionStateContext.Provider value={state}>
        {children}
      </SessionStateContext.Provider>
    </SessionActionsContext.Provider>
  );
}
function widget(component: string, props = {}) {
  const spec = pluginPanelViewToSpec({ component, props })!;
  return (
    <JSONUIProvider registry={covelRegistry} initialState={{}}>
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>
  );
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  setActiveSession("s");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  setActiveSession(null);
  vi.unstubAllGlobals();
});

it("renders community widgets only with a matching current live host and strict literal props", () => {
  const view = render(
    shell(
      <PluginViewSessionContext.Provider value={slots}>
        {widget("SessionMessages")}
        {widget("SessionComposer")}
      </PluginViewSessionContext.Provider>,
    ),
  );
  expect(screen.getByText("Public story")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Host input" })).toBeTruthy();
  view.rerender(
    shell(
      <PluginViewSessionContext.Provider
        value={{ ...slots, sessionId: "other" }}
      >
        {widget("SessionComposer")}
      </PluginViewSessionContext.Provider>,
    ),
  );
  expect(screen.queryByRole("button", { name: "Host input" })).toBeNull();
  view.rerender(
    shell(
      <PluginViewSessionContext.Provider value={slots}>
        {widget("SessionMessages", { content: "raw" })}
        {widget("SessionComposer", { sessionId: "other" })}
      </PluginViewSessionContext.Provider>,
    ),
  );
  expect(screen.queryByText("Public story")).toBeNull();
  expect(screen.queryByRole("button", { name: "Host input" })).toBeNull();
  view.rerender(shell(widget("SessionComposer")));
  expect(screen.getByRole("status").textContent).toContain(
    "only in the current live plugin view",
  );
  expect(segmentTemplateRegistry.SessionMessages).toBeUndefined();
  expect(segmentTemplateRegistry.SessionComposer).toBeUndefined();
});

it("masks an inherited live host in snapshot and debug panels", () => {
  const spec = {
    id: "snapshot",
    label: "Snapshot",
    alwaysRender: true,
    view: { component: "SessionComposer" },
  };
  const view = render(
    shell(
      <PluginViewSessionContext.Provider value={slots}>
        <PluginPanel
          pluginId="community"
          spec={spec}
          stateOverride={{}}
          liveSession={slots}
          fill
        />
      </PluginViewSessionContext.Provider>,
    ),
  );
  expect(screen.queryByRole("button", { name: "Host input" })).toBeNull();
  view.rerender(
    shell(
      <PluginViewSessionContext.Provider value={slots}>
        <PluginPanel
          pluginId="community"
          spec={spec}
          enableDevtools
          liveSession={slots}
          fill
        />
      </PluginViewSessionContext.Provider>,
    ),
  );
  expect(screen.queryByRole("button", { name: "Host input" })).toBeNull();
});

it("hydrates graph and library pages and original panels from the same committed namespaces", async () => {
  const view = render(
    shell(
      <>
        <div data-testid="graph-page">
          <PluginPanel pluginId="npc-graph" spec={graphView} fill />
        </div>
        <div data-testid="graph-panel">
          <PluginPanel pluginId="npc-graph" spec={graphPanel} />
        </div>
        <div data-testid="library-page">
          <PluginPanel pluginId="codex" spec={libraryView} fill />
        </div>
        <div data-testid="library-panel">
          <PluginPanel pluginId="codex" spec={libraryPanel} />
        </div>
      </>,
    ),
  );
  expect(
    await within(screen.getByTestId("graph-page")).findByText(
      "No graph data yet.",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("library-page")).getByText("No matching entries"),
  ).toBeTruthy();
  act(() => {
    loadPluginDataForSession("s", "npc-graph", "nodes", [
      {
        key: "a",
        value: {
          id: "a",
          name: "Mira",
          type: "individual",
          summary: "Public navigator",
        },
      },
      { key: "b", value: { id: "b", name: "Kai", type: "individual" } },
    ]);
    loadPluginDataForSession("s", "npc-graph", "edges", [
      {
        key: "old",
        value: {
          id: "old",
          source: "a",
          target: "b",
          relation: "enemy",
          fact: "SUPERSEDED-FACT",
          strength: -1,
          validAt: 1,
          invalidAt: 2,
        },
      },
      {
        key: "current",
        value: {
          id: "current",
          source: "a",
          target: "b",
          relation: "friend",
          fact: "They sail together.",
          strength: 1,
          validAt: 2,
        },
      },
    ]);
    loadPluginDataForSession("s", "codex", "entries", [
      {
        key: "map",
        value: {
          title: "Moon map",
          content: "The complete chart of the northern islands.",
          category: "item",
          tags: ["silver-sigil"],
          rarity: "rare",
        },
      },
    ]);
  });
  for (const region of ["graph-page", "graph-panel"]) {
    const graph = within(screen.getByTestId(region));
    fireEvent.click(
      (await graph.findAllByRole("button", { name: "Mira" }))[0]!,
    );
    expect(graph.getByText("Public navigator")).toBeTruthy();
    expect(graph.getByText("They sail together.")).toBeTruthy();
    expect(graph.queryByText("SUPERSEDED-FACT")).toBeNull();
  }
  const library = within(screen.getByTestId("library-page"));
  fireEvent.change(library.getByPlaceholderText("Search entries…"), {
    target: { value: "silver-sigil" },
  });
  expect(library.getByText("Moon map")).toBeTruthy();
  fireEvent.click(library.getByText("Moon map"));
  expect(
    library.getByText("The complete chart of the northern islands."),
  ).toBeTruthy();
  expect(library.getByText("1 entries")).toBeTruthy();
  fireEvent.change(library.getByPlaceholderText("Search entries…"), {
    target: { value: "no-such-tag" },
  });
  expect(library.getByText("No matching entries")).toBeTruthy();
  expect(
    within(screen.getByTestId("library-panel")).getByText("Moon map"),
  ).toBeTruthy();
  fireEvent.change(library.getByPlaceholderText("Search entries…"), {
    target: { value: "" },
  });
  act(() =>
    applyChanges("codex", [
      {
        namespace: "entries",
        key: "map",
        operation: "set",
        value: {
          title: "Sun map",
          content: "Updated chart",
          category: "item",
          tags: [],
          rarity: "common",
        },
      },
    ]),
  );
  await waitFor(() => expect(screen.getAllByText("Sun map")).toHaveLength(2));
  act(() => {
    loadPluginDataForSession("s", "codex", "entries", []);
    loadPluginDataForSession("s", "npc-graph", "nodes", []);
  });
  expect(library.getByText("No matching entries")).toBeTruthy();
  expect(
    within(screen.getByTestId("graph-page")).getByText("No graph data yet."),
  ).toBeTruthy();
  act(() => setActiveSession("other"));
  view.rerender(
    shell(<PluginPanel pluginId="codex" spec={libraryView} fill />),
  );
  expect(screen.queryByText("Sun map")).toBeNull();
});

it("does not serialize host slots or public messages into the declarative state store", () => {
  const cache =
    new Map() as import("@/components/session/plugin-panel.js").PluginPanelStateCache;
  const spec = {
    id: "desk",
    label: "Desk",
    alwaysRender: true,
    view: { component: "SessionMessages" },
  };
  render(
    shell(
      <PluginPanel
        pluginId="community"
        spec={spec}
        liveSession={slots}
        fill
        stateCache={cache}
      />,
    ),
  );
  expect(screen.getByText("Public story")).toBeTruthy();
  expect(cache.size).toBe(1);
  const snapshot = JSON.stringify([...cache.values()][0]!.getSnapshot());
  for (const field of [
    "Public story",
    "renderComposer",
    "renderMessages",
    "sessionId",
  ])
    expect(snapshot).not.toContain(field);
});

it("rejects multiplied live widgets again at the host render boundary", async () => {
  const { PluginViewHost } =
    await import("@/components/session/plugin-view-host.js");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fallback = vi.fn();
  const spec = {
    id: "desk",
    label: "Desk",
    alwaysRender: true,
    view: {
      component: "Stack",
      repeat: { statePath: "/entries" },
      children: [{ component: "SessionComposer" }],
    },
  };
  render(
    shell(
      <PluginViewHost
        sessionId="s"
        liveSession={slots}
        entry={{
          mode: "plugin:community:desk",
          pluginId: "community",
          pluginName: "Community",
          viewId: "desk",
          label: "Desk",
          spec,
        }}
        onFallback={fallback}
      />,
    ),
  );
  expect(fallback).toHaveBeenCalledWith("render-error");
  expect(screen.queryByRole("button", { name: "Host input" })).toBeNull();
  error.mockRestore();
});
