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
import type { ForceLink } from "../graph-types.js";
import type { GraphCanvasProps } from "@covel/shared";

const canvas = vi.hoisted(() => ({ graphData: undefined as unknown }));
vi.mock("react-force-graph-2d", () => ({
  default: ({ graphData }: { graphData: unknown }) => {
    canvas.graphData = graphData;
    return null;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const graphProps: GraphCanvasProps = {
  nodes: {},
  edges: {},
  node: {
    idField: "id",
    labelField: "name",
    typeField: "type",
    summaryField: "summary",
    labelsField: "labels",
    colors: { individual: "#60a5fa", group: "#a78bfa", faction: "#f59e0b" },
    defaultColor: "#9ca3af",
  },
  edge: {
    idField: "id",
    sourceField: "source",
    targetField: "target",
    relationField: "relation",
    strengthField: "strength",
    factField: "fact",
    inactiveField: "invalidAt",
    colors: { positive: "#22c55e", negative: "#ef4444", neutral: "#94a3b8" },
  },
  height: 480,
};
const sourceNodes = {
  a: { id: "a", name: "Mira", type: "individual" },
  b: { id: "b", name: "Kai", type: "individual" },
};
const nodes = buildNodes(sourceNodes, graphProps.node);
const graphLinks = (value: unknown) => buildLinks(value, graphProps.edge);
const edge = {
  id: "ab",
  source: "a",
  target: "b",
  relation: "friend",
  strength: 0.8,
  fact: "They study together.",
};

describe("relationship graph", () => {
  it("uses only explicitly configured colors for prototype-named types", () => {
    const namedNodes = {
      a: { id: "a", name: "A", type: "constructor" },
      b: { id: "b", name: "B", type: "toString" },
    };
    expect(
      buildNodes(namedNodes, graphProps.node).map((node) => node.color),
    ).toEqual([graphProps.node.defaultColor, graphProps.node.defaultColor]);

    const colors = Object.fromEntries([
      ["constructor", "#123456"],
      ["toString", "#654321"],
    ]);
    expect(
      buildNodes(namedNodes, { ...graphProps.node, colors }).map(
        (node) => node.color,
      ),
    ).toEqual(["#123456", "#654321"]);
  });

  it("maps another plugin's field names, types, colors, and inactive marker", () => {
    const alternative: GraphCanvasProps = {
      ...graphProps,
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
    };
    expect(
      buildNodes(
        {
          place: {
            identifier: "place",
            caption: "Harbor",
            category: "location",
            bio: "A safe harbor",
            tags: ["coastal"],
          },
        },
        alternative.node,
      ),
    ).toMatchObject([
      {
        id: "place",
        name: "Harbor",
        color: "#123456",
        summary: "A safe harbor",
      },
    ]);
    expect(
      buildLinks(
        {
          link: {
            identifier: "link",
            from: "place",
            to: "gate",
            kind: "route",
            score: -0.5,
            note: "Guarded",
          },
          expired: {
            identifier: "expired",
            from: "place",
            to: "gate",
            score: 0.5,
            closedAt: 0,
          },
        },
        alternative.edge,
      ),
    ).toMatchObject([
      { edgeId: "link", relation: "route", fact: "Guarded", color: "red" },
    ]);
  });

  it("refreshes selected metadata and relationship facts without restarting the simulation", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const renderGraph = (props: GraphCanvasProps) => (
      <GraphCanvas
        emit={() => {}}
        on={() => ({
          emit: () => {},
          shouldPreventDefault: false,
          bound: false,
        })}
        element={{
          type: "GraphCanvas",
          props,
        }}
      />
    );
    const { rerender } = render(
      renderGraph({ ...graphProps, nodes: sourceNodes, edges: { ab: edge } }),
    );
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Mira" }))[0],
    );
    const simulationData = canvas.graphData;
    await act(async () => {
      rerender(
        renderGraph({
          ...graphProps,
          nodes: {
            ...sourceNodes,
            a: { ...sourceNodes.a, summary: "Updated biography" },
          },
          edges: { ab: { ...edge, fact: "Updated relationship" } },
        }),
      );
    });
    expect(screen.getByText("Updated biography")).toBeTruthy();
    expect(screen.getByText("Updated relationship")).toBeTruthy();
    expect(canvas.graphData).toBe(simulationData);
    await act(async () => {
      rerender(
        renderGraph({
          ...graphProps,
          nodes: {
            ...sourceNodes,
            a: { ...sourceNodes.a, summary: "Updated biography" },
          },
          edges: { ab: { ...edge, source: "b", target: "a" } },
        }),
      );
    });
    expect(canvas.graphData).not.toBe(simulationData);
    expect(canvas.graphData).toMatchObject({
      links: [{ source: "b", target: "a" }],
    });
    await act(async () => {
      rerender(
        renderGraph({
          ...graphProps,
          nodes: { b: sourceNodes.b },
          edges: { ab: edge },
        }),
      );
    });
    expect(screen.queryByText("Updated biography")).toBeNull();
  });

  it("highlights only the selected node and its direct neighbors for resolved or raw links", () => {
    const links = graphLinks({
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
      { nodes, links: graphLinks({ ab: edge }) },
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
    const links = graphLinks({
      old: { ...edge, id: "old", invalidAt: 3 },
      opening: { ...edge, id: "opening", invalidAt: 0 },
      unknownTurn: { ...edge, id: "unknown", invalidAt: -1 },
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

  it.each([false, true])(
    "rebinds changed endpoints without moving pinned nodes (resolved: %s)",
    (resolved) => {
      const pools = createGraphDataPools();
      const geom = { width: 320, height: 480 };
      const original = graphLinks({ ab: edge });
      syncGraphData(pools, { nodes, links: original }, geom);
      const pinned = pools.nodePool.get("a")!;
      pinned.fx = pinned.x = 17;
      pinned.fy = pinned.y = -40;
      const pooled = pools.graphData.links[0];
      if (resolved) {
        pooled.source = pinned;
        pooled.target = pools.nodePool.get("b")!;
      }
      expect(original[0].source).toBe("a");
      expect(original[0].target).toBe("b");
      expect(syncGraphData(pools, { nodes, links: original }, geom)).toBe(
        false,
      );
      const reversed: ForceLink = {
        ...original[0],
        source: "b",
        target: "a",
      };
      expect(syncGraphData(pools, { nodes, links: [reversed] }, geom)).toBe(
        true,
      );
      expect(pools.graphData.links[0]).toBe(pooled);
      expect(pooled).toMatchObject({ source: "b", target: "a" });
      expect(pools.nodePool.get("a")).toBe(pinned);
      expect(pinned).toMatchObject({ x: 17, fx: 17, y: -40, fy: -40 });
      expect(syncGraphData(pools, { nodes, links: [reversed] }, geom)).toBe(
        false,
      );
    },
  );
});
