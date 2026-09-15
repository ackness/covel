import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { buildLinks, buildNodes } from "../graph-canvas-model.js";
import { createGraphDataPools, syncGraphData } from "../graph-canvas-sync.js";
import {
  GraphRelationships,
  connectedNodeIds,
} from "../graph-relationships.js";
import { GraphCanvas } from "../graph-canvas.js";
import {
  setActiveSession,
  applyChanges,
  __clearAllPluginDataForTest,
} from "@/stores/plugin-data-store.js";

const canvas = vi.hoisted(() => ({ graphData: undefined as unknown }));
vi.mock("react-force-graph-2d", () => ({
  default: ({ graphData }: { graphData: unknown }) => {
    canvas.graphData = graphData;
    return null;
  },
}));

afterEach(() => {
  cleanup();
  __clearAllPluginDataForTest();
  vi.unstubAllGlobals();
});
const nodes = buildNodes({
  a: { id: "a", name: "Mira", type: "individual" },
  b: { id: "b", name: "Kai", type: "individual" },
});
const edge = {
  id: "ab",
  source: "a",
  target: "b",
  relation: "friend",
  strength: 0.8,
  fact: "They study together.",
};

describe("relationship graph", () => {
  it("refreshes selected metadata and relationship facts without restarting the simulation", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    setActiveSession("graph-refresh");
    applyChanges("graph", [
      ...nodes.map((node) => ({
        namespace: "nodes",
        key: node.id,
        operation: "set" as const,
        value: node,
      })),
      { namespace: "edges", key: edge.id, operation: "set", value: edge },
    ]);
    render(
      <GraphCanvas
        emit={() => {}}
        on={() => ({
          emit: () => {},
          shouldPreventDefault: false,
          bound: false,
        })}
        element={{
          type: "GraphCanvas",
          props: {
            pluginId: "graph",
            nodesNamespace: "nodes",
            edgesNamespace: "edges",
          },
        }}
      />,
    );
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Mira" }))[0],
    );
    const simulationData = canvas.graphData;
    await act(async () => {
      applyChanges("graph", [
        {
          namespace: "nodes",
          key: "a",
          operation: "set",
          value: { ...nodes[0], summary: "Updated biography" },
        },
        {
          namespace: "edges",
          key: edge.id,
          operation: "set",
          value: { ...edge, fact: "Updated relationship" },
        },
      ]);
    });
    expect(screen.getByText("Updated biography")).toBeTruthy();
    expect(screen.getByText("Updated relationship")).toBeTruthy();
    expect(canvas.graphData).toBe(simulationData);
    await act(async () => {
      applyChanges("graph", [
        { namespace: "nodes", key: "a", operation: "delete", value: null },
      ]);
    });
    expect(screen.queryByText("Updated biography")).toBeNull();
  });

  it("highlights only the selected node and its direct neighbors for resolved or raw links", () => {
    const links = buildLinks({
      ab: edge,
      bc: { ...edge, id: "bc", source: "b", target: "c" },
    });
    links[0] = { ...links[0], source: nodes[0], target: nodes[1] };
    expect([...connectedNodeIds(links, "a")].sort()).toEqual(["a", "b"]);
    expect([...connectedNodeIds(links, "isolated")]).toEqual(["isolated"]);
    expect(connectedNodeIds(links, undefined).size).toBe(0);
  });
  it("starts around the world origin and preserves pins across updates", () => {
    const pools = createGraphDataPools();
    syncGraphData(
      pools,
      { nodes, links: buildLinks({ ab: edge }) },
      { width: 320, height: 480 },
    );
    expect(
      pools.graphData.nodes.reduce((sum, node) => sum + (node.x ?? 0), 0),
    ).toBeCloseTo(0);
    expect(
      pools.graphData.nodes.reduce((sum, node) => sum + (node.y ?? 0), 0),
    ).toBeCloseTo(0);
    const pinned = pools.graphData.nodes[0];
    pinned.x = pinned.fx = 17;
    pinned.y = pinned.fy = -40;
    syncGraphData(
      pools,
      {
        nodes: nodes.map((node) => ({ ...node, summary: "Updated" })),
        links: [],
      },
      { width: 640, height: 320 },
    );
    expect(pools.graphData.nodes[0]).toBe(pinned);
    expect(pinned).toMatchObject({
      fx: 17,
      fy: -40,
      x: 17,
      y: -40,
      summary: "Updated",
    });
  });
  it("omits superseded relationships and navigates links after d3 resolves endpoints", () => {
    const links = buildLinks({
      old: { ...edge, id: "old", invalidAt: "2026-09-01" },
      current: edge,
    });
    expect(links).toHaveLength(1);
    const onSelect = vi.fn();
    render(
      <GraphRelationships
        nodes={nodes}
        links={[{ ...links[0], source: nodes[0], target: nodes[1] }]}
        selectedId="a"
        onSelect={onSelect}
      />,
    );
    const list = screen.getByRole("list");
    expect(within(list).getByText("They study together.")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Kai" }));
    expect(onSelect).toHaveBeenCalledWith(nodes[1]);
  });
});
