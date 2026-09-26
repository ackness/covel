import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, FRAMEWORK_TOOL_NAMES } from "../src/registry.js";
import { tool } from "../src/tool.js";
import type { ToolModule } from "../src/types.js";
import {
  builtinUITools,
  createCharacterTools,
  createEmitEventTool,
  createMemoryTools,
  createPluginDataTools,
  createWorldDimensionTools,
  runtimeDoneTool,
  SEARCH_TOOLS_TOOL_NAME,
  suspendTool,
} from "../src/index.js";

const module = (name: string) =>
  tool({
    name,
    description: name,
    parameters: z.object({}),
    execute: async () => ({}),
  });

describe("ToolRegistry", () => {
  it("reserves the full builtin factory output including optional and virtual tools", () => {
    const names = [
      ...builtinUITools,
      suspendTool,
      runtimeDoneTool,
      ...createCharacterTools({} as Parameters<typeof createCharacterTools>[0]),
      ...createPluginDataTools(
        {} as Parameters<typeof createPluginDataTools>[0],
      ),
      ...createMemoryTools({} as Parameters<typeof createMemoryTools>[0]),
      ...createWorldDimensionTools(
        {} as Parameters<typeof createWorldDimensionTools>[0],
      ),
      createEmitEventTool({} as Parameters<typeof createEmitEventTool>[0]),
    ].map((entry) => entry.name);
    expect([...new Set([...names, SEARCH_TOOLS_TOOL_NAME])].sort()).toEqual(
      [...FRAMEWORK_TOOL_NAMES].sort(),
    );
  });
  it("isolates same-named registrations and their disposers", () => {
    const registry = new ToolRegistry();
    const a = module("lookup");
    const b = module("lookup");
    const dispose = registry.registerPlugin("a", a);
    registry.registerPlugin("b", b);
    expect(registry.find("lookup", "a")).toBe(a);
    expect(registry.find("lookup", "b")).toBe(b);
    expect(registry.find("lookup", "c")).toBeUndefined();
    expect(() => registry.registerPlugin("a", module("lookup"))).toThrow(
      "already registered",
    );
    dispose();
    const replacement = module("lookup");
    registry.registerPlugin("a", replacement);
    dispose();
    expect(registry.find("lookup", "a")).toBe(replacement);
    expect(registry.find("lookup", "b")).toBe(b);
  });

  it.each(FRAMEWORK_TOOL_NAMES)(
    "reserves %s before optional builtin registration",
    (name) => {
      const registry = new ToolRegistry();
      expect(() => registry.registerPlugin("a", module(name))).toThrow(
        "reserved",
      );
      expect(registry.pluginTools.size).toBe(0);
    },
  );

  it.each([
    { name: " lookup " },
    { name: "   " },
    { description: undefined },
    { parametersSchema: undefined },
    { jsonSchema: null },
    { jsonSchema: [] },
  ])("rejects malformed plugin tool declarations: %j", (override) => {
    const registry = new ToolRegistry();
    const malformed = {
      ...module("lookup"),
      ...override,
    } as unknown as ToolModule;
    expect(() => registry.registerPlugin("a", malformed)).toThrow(
      "expected a ToolModule",
    );
    expect(registry.pluginTools.size).toBe(0);
  });

  it("keeps builtin resolution and provenance independent of plugin registration", () => {
    const registry = new ToolRegistry();
    const builtin = module("create-form");
    registry.registerBuiltin(builtin);
    registry.registerPlugin("a", module("lookup"));
    expect(registry.find("create-form", "b")).toBe(builtin);
    expect(registry.source("create-form")).toBe("builtin");
    expect(registry.source("lookup")).toBe("local");
    expect(() => registry.registerBuiltin(module("unreserved"))).toThrow(
      "reserve",
    );
  });
});
