import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, FRAMEWORK_TOOL_NAMES } from "../src/registry.js";
import { tool } from "@covel/plugin-handlers-utils";
import type { ToolModule } from "../src/types.js";

const module = (name: string) =>
  tool({
    name,
    description: name,
    parameters: z.object({}),
    execute: async () => ({}),
  });

describe("ToolRegistry", () => {
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
    { annotations: undefined },
    {
      annotations: {
        readOnly: "yes",
        stagesWrites: false,
        idempotent: false,
        concurrencySafe: false,
      },
    },
    { annotations: { readOnly: true } },
    {
      annotations: {
        readOnly: true,
        stagesWrites: true,
        idempotent: false,
        concurrencySafe: false,
      },
    },
    {
      annotations: {
        readOnly: false,
        stagesWrites: false,
        idempotent: false,
        concurrencySafe: true,
      },
    },
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { timeoutMs: 600_001 },
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

  it("validates builtin annotations and timeouts before registration", () => {
    const registry = new ToolRegistry();
    for (const override of [{ annotations: undefined }, { timeoutMs: -1 }]) {
      const malformed = {
        ...module("create-form"),
        ...override,
      } as unknown as ToolModule;
      expect(() => registry.registerBuiltin(malformed)).toThrow(
        "expected a ToolModule",
      );
      expect(registry.builtinTools.size).toBe(0);
    }
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
