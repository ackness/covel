import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { buildLinks, buildNodes } from "../graph-canvas-model.js";
import { createGraphDataPools, syncGraphData } from "../graph-canvas-sync.js";
import { GraphRelationships } from "../graph-relationships.js";

afterEach(cleanup);
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
