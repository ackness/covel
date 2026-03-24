import { describe, expect, it } from "vitest";

import { createContextGraph } from "../src/index.js";

describe("createContextGraph", () => {
  it("orders pinned nodes first and then sorts by descending priority", () => {
    const graph = createContextGraph({
      nodes: [
        {
          id: "recent-1",
          source: "recent",
          priority: 40,
          tokenCost: 120,
          pinned: false,
          content: "Recent turn",
          provenance: { sourceType: "recent" }
        },
        {
          id: "world-1",
          source: "world",
          priority: 80,
          tokenCost: 300,
          pinned: true,
          content: "World summary",
          provenance: { sourceType: "world" }
        },
        {
          id: "persona-1",
          source: "persona",
          priority: 60,
          tokenCost: 180,
          pinned: false,
          content: "Persona rules",
          provenance: { sourceType: "persona" }
        }
      ]
    });

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "world-1",
      "persona-1",
      "recent-1"
    ]);
  });

  it("deduplicates nodes by id and keeps the higher priority entry", () => {
    const graph = createContextGraph({
      nodes: [
        {
          id: "world-1",
          source: "world",
          priority: 20,
          tokenCost: 300,
          pinned: false,
          content: "Older world summary",
          provenance: { sourceType: "world" }
        },
        {
          id: "world-1",
          source: "world",
          priority: 80,
          tokenCost: 200,
          pinned: false,
          content: "Fresh world summary",
          provenance: { sourceType: "world" }
        }
      ]
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.content).toBe("Fresh world summary");
  });
});
