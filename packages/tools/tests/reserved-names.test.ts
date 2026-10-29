import { describe, expect, it } from "vitest";
import {
  createDefaultToolRegistry,
  createMemoryTools,
  FRAMEWORK_TOOL_NAMES,
  type DefaultToolRegistryDeps,
} from "../src/index.js";

describe("framework tool names", () => {
  it("equals the default registry, optional memory tools and search-tools in both directions", () => {
    const registry = createDefaultToolRegistry({
      store: {} as DefaultToolRegistryDeps["store"],
      eventDirectory: {
        listTopics: async () => [],
        validate: async () => ({ ok: false, reason: "not configured" }),
      },
    });
    const memoryTools = createMemoryTools({ search: async () => [] });
    const actual = new Set([
      ...registry.builtinTools.keys(),
      ...memoryTools.map((module) => module.name),
      "search-tools",
    ]);
    expect([...actual].sort()).toEqual([...FRAMEWORK_TOOL_NAMES].sort());
  });

  it("annotates the builtin reads and keeps other builtins on safe defaults", () => {
    const registry = createDefaultToolRegistry({
      store: {} as DefaultToolRegistryDeps["store"],
      eventDirectory: {
        listTopics: async () => [],
        validate: async () => ({ ok: false, reason: "not configured" }),
      },
    });
    const reads = new Set([
      "world-dimension-get",
      "world-dimension-list",
      "plugin-data-get",
      "plugin-data-list",
      "memory-search",
    ]);
    for (const module of [
      ...registry.builtinTools.values(),
      ...createMemoryTools({ search: async () => [] }),
    ]) {
      const readOnly = reads.has(module.name);
      expect(module.annotations, module.name).toEqual({
        readOnly,
        stagesWrites: !readOnly,
        concurrencySafe: readOnly,
        idempotent: readOnly,
      });
    }
  });
});
