import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginPanel } from "../plugin-panel.js";
import {
  __clearAllPluginDataForTest,
  loadPluginData,
  setActiveSession,
} from "@/stores/plugin-data-store.js";

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { gameState: { characters: [] }, session: { id: "session-a" } },
  }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  __clearAllPluginDataForTest();
  vi.unstubAllGlobals();
});

const graphSpec = {
  id: "graph",
  dataSource: {
    namespace: "vertices",
    bindings: { nodes: "vertices", edges: "connections" },
  },
  view: {
    component: "GraphCanvas",
    props: {
      nodes: { $state: "/sources/nodes" },
      edges: { $state: "/sources/edges" },
      node: {
        idField: "identifier",
        labelField: "caption",
        typeField: "category",
        summaryField: "bio",
        labelsField: "tags",
        colors: { location: "#123456" },
        defaultColor: "#654321",
      },
      edge: {
        idField: "identifier",
        sourceField: "from",
        targetField: "to",
        relationField: "kind",
        strengthField: "score",
        factField: "note",
        inactiveField: "closedAt",
        colors: { positive: "green", negative: "red", neutral: "gray" },
      },
    },
  },
};

it("renders two named owner namespaces and clears them across sessions", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  setActiveSession("session-a");
  loadPluginData("other-plugin", "vertices", [
    { key: "foreign", value: { identifier: "foreign", caption: "Foreign" } },
  ]);
  loadPluginData("map-plugin", "vertices", [
    {
      key: "port",
      value: { identifier: "port", caption: "Harbor", category: "location" },
    },
    {
      key: "gate",
      value: { identifier: "gate", caption: "Gate", category: "location" },
    },
  ]);
  loadPluginData("map-plugin", "connections", [
    {
      key: "route",
      value: {
        identifier: "route",
        from: "port",
        to: "gate",
        kind: "route",
        score: 1,
        note: "Open passage",
      },
    },
  ]);
  render(<PluginPanel pluginId="map-plugin" spec={graphSpec} />);
  expect(
    (await screen.findAllByRole("button", { name: "Harbor" })).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("Open passage")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Foreign" })).toBeNull();
  await act(async () => {
    loadPluginData("other-plugin", "vertices", [
      {
        key: "foreign-next",
        value: { identifier: "foreign-next", caption: "Foreign Next" },
      },
    ]);
  });
  expect(screen.queryByRole("button", { name: "Foreign Next" })).toBeNull();
  expect(screen.getByText("Open passage")).toBeTruthy();

  await act(async () => setActiveSession("session-b"));
  expect(screen.queryAllByRole("button", { name: "Harbor" })).toEqual([]);
  await act(async () => {
    loadPluginData("map-plugin", "vertices", [
      {
        key: "tower",
        value: { identifier: "tower", caption: "Tower", category: "location" },
      },
    ]);
  });
  expect(await screen.findByRole("button", { name: "Tower" })).toBeTruthy();
  expect(screen.queryByText("Open passage")).toBeNull();
});
