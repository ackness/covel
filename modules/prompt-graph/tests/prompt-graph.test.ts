import { describe, expect, it } from "vitest";

import { createContextGraph } from "../../context-graph/src/index.js";
import { compilePromptGraph } from "../src/index.js";

describe("compilePromptGraph", () => {
  it("packs pinned nodes first and then trims optional nodes to the prompt budget", () => {
    const contextGraph = createContextGraph({
      nodes: [
        {
          id: "world-1",
          source: "world",
          priority: 90,
          tokenCost: 300,
          pinned: true,
          content: "Pinned world summary",
          provenance: { sourceType: "world" }
        },
        {
          id: "persona-1",
          source: "persona",
          priority: 70,
          tokenCost: 150,
          pinned: false,
          content: "Persona layer",
          provenance: { sourceType: "persona" }
        },
        {
          id: "archive-1",
          source: "archive",
          priority: 40,
          tokenCost: 200,
          pinned: false,
          content: "Archive summary",
          provenance: { sourceType: "archive" }
        }
      ]
    });

    const promptGraph = compilePromptGraph({
      contextGraph,
      maxTokens: 460
    });

    expect(promptGraph.nodes.map((node) => node.id)).toEqual([
      "world-1",
      "persona-1"
    ]);
    expect(promptGraph.totalTokenCost).toBe(450);
  });

  it("keeps pinned nodes even when they exceed the nominal budget", () => {
    const contextGraph = createContextGraph({
      nodes: [
        {
          id: "world-1",
          source: "world",
          priority: 90,
          tokenCost: 500,
          pinned: true,
          content: "Pinned world summary",
          provenance: { sourceType: "world" }
        },
        {
          id: "recent-1",
          source: "recent",
          priority: 30,
          tokenCost: 60,
          pinned: false,
          content: "Recent detail",
          provenance: { sourceType: "recent" }
        }
      ]
    });

    const promptGraph = compilePromptGraph({
      contextGraph,
      maxTokens: 200
    });

    expect(promptGraph.nodes.map((node) => node.id)).toEqual(["world-1"]);
    expect(promptGraph.totalTokenCost).toBe(500);
  });
});
