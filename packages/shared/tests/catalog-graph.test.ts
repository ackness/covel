import { describe, expect, it } from "vitest";
import { graphCanvasPropsSchema } from "../src/schemas/catalog.js";

describe("generic graph props", () => {
  it("accepts unweighted edges without relationship metadata or polarity colors", () => {
    const result = graphCanvasPropsSchema.safeParse({
      nodes: [{ id: "a", name: "Harbor" }],
      edges: [],
      node: {
        idField: "id",
        labelField: "name",
        colors: {},
        defaultColor: "gray",
      },
      edge: {
        idField: "id",
        sourceField: "from",
        targetField: "to",
        defaultColor: "blue",
      },
      emptyText: { "en-US": "No routes", "zh-CN": "暂无路线" },
    });
    expect(result.success).toBe(true);
  });
  it("still requires edge endpoints and rejects unknown mappings", () => {
    for (const edge of [
      { idField: "id" },
      { idField: "id", sourceField: "a", targetField: "b", unknown: true },
    ]) {
      expect(
        graphCanvasPropsSchema.safeParse({
          nodes: [],
          edges: [],
          node: {
            idField: "id",
            labelField: "name",
            colors: {},
            defaultColor: "gray",
          },
          edge,
        }).success,
      ).toBe(false);
    }
  });
});
