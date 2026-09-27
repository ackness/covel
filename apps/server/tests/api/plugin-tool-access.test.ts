import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { tool, z } from "@covel/tools";
import { setupPluginTools } from "../../src/routes/api/bootstrap/tools.js";

describe("plugin-scoped tools", () => {
  it("advertises and executes the caller's implementation without cross-plugin fallback", async () => {
    const { tools, toolExecutor } = await setupPluginTools({
      store: createMemoryStore(),
      registry: createPluginRegistry(),
      discoveryMap: new Map(),
      manifestCache: new Map(),
      llmAdapter: {} as never,
      eventDirectory: { get: () => undefined, list: () => [] } as never,
    });
    try {
      for (const pluginId of ["alpha", "beta"]) {
        tools.registerPlugin(
          pluginId,
          tool({
            name: "lookup",
            description: pluginId,
            parameters: z.object({}),
            execute: async () => ({ owner: pluginId }),
          }),
        );
      }
      for (const pluginId of ["alpha", "beta", "missing"]) {
        const context = {
          pluginId,
          runtimeId: `${pluginId}/main`,
          sessionId: "s",
          turnId: "t",
          authorizedToolNames: new Set(["lookup", "beta/lookup"]),
        };
        if (pluginId !== "missing") {
          expect(toolExecutor.getToolInfo("lookup", context)).toEqual(
            expect.objectContaining({ name: "lookup", description: pluginId }),
          );
        } else {
          expect(toolExecutor.getToolInfo("lookup", context)).toBeUndefined();
        }
        const result = await toolExecutor.execute(
          { toolCallId: pluginId, name: "lookup", arguments: "{}" },
          context,
        );
        expect(result.success).toBe(pluginId !== "missing");
        if (result.success)
          expect(result.parsedResult).toEqual({ owner: pluginId });
        expect(
          toolExecutor.getToolInfo("beta/lookup", context),
        ).toBeUndefined();
      }
      const denied = await toolExecutor.execute(
        { toolCallId: "undeclared", name: "lookup", arguments: "{}" },
        {
          pluginId: "alpha",
          runtimeId: "alpha/other",
          sessionId: "s",
          turnId: "t",
          authorizedToolNames: new Set(),
        },
      );
      expect(denied.success).toBe(false);
      expect(denied.result).toContain("UNAUTHORIZED");
    } finally {
      await toolExecutor.close();
    }
  });
});
