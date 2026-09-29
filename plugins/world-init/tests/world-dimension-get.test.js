import { describe, expect, it } from "vitest";
import { tool, z } from "@covel/tools";
import makeTool from "../tools/world-dimension-get.js";

const dimensionTool = makeTool({ tool, z });
function context(value = null, pendingProposals = []) {
  return {
    sessionId: "session",
    pluginId: "world-init",
    runtimeId: "world-init/schema-gen",
    turnId: "turn",
    pendingProposals,
    world: {
      worldRecord: {
        id: "world",
        metadata: {
          dimensions: {
            geography: {
              regions: [{ name: { "en-US": "Harbor", "zh-CN": "港口" } }],
            },
          },
        },
      },
    },
    store: {
      getSession: async () => ({ worldId: "world", locale: "en-US" }),
      getPluginData: async () => (value === null ? null : { value }),
    },
  };
}
describe("world-init dimension queries", () => {
  it("reads authored dimensions and resolves nested localized values", async () => {
    const result = await dimensionTool.execute(
      { queries: [{ dimension: "geography", path: "regions[0].name" }] },
      context(),
    );
    expect(result.results[0]).toMatchObject({
      found: true,
      source: "world-metadata",
      value: "Harbor",
    });
  });
  it("prefers own session overrides to authored dimensions", async () => {
    const result = await dimensionTool.execute(
      { queries: [{ dimension: "geography", path: "regions[0]" }] },
      context({ regions: ["own"] }),
    );
    expect(result.results[0]).toMatchObject({
      source: "plugin-data",
      value: "own",
    });
  });
  it("uses pending own writes and refuses foreign plugin overrides", async () => {
    const write = {
      id: "p",
      type: "plugin.data",
      sessionId: "session",
      turnId: "turn",
      timestamp: "2026-01-01T00:00:00Z",
      source: { pluginId: "world-init", runtimeId: "world-init/schema-gen" },
      payload: {
        namespace: "entries",
        key: "geography",
        value: { regions: ["pending"] },
      },
    };
    const foreign = {
      ...write,
      source: { pluginId: "foreign", runtimeId: "foreign" },
      payload: { ...write.payload, value: { regions: ["foreign"] } },
    };
    const result = await dimensionTool.execute(
      { queries: [{ dimension: "geography", path: "regions[0]" }] },
      context(null, [write, foreign]),
    );
    expect(result.results[0]).toMatchObject({ value: "pending" });
  });
  it("returns a missing result for malformed and absent paths", async () => {
    const result = await dimensionTool.execute(
      {
        queries: [
          { dimension: "geography", path: "regions[bad]" },
          { dimension: "geography", path: "missing" },
        ],
      },
      context(),
    );
    expect(result.results.every((item) => !item.found)).toBe(true);
  });
});
