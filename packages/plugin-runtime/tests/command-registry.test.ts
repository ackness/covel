import { describe, it, expect } from "vitest";
import { createCommandRegistry, CommandError } from "../src/index.js";

describe("command registry", () => {
  it("registers and retrieves a command", () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "help",
      pluginId: "core",
      description: "Show help",
      handler: async () => ({ content: "help text" }),
    });

    const cmd = registry.get("help");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("help");
    expect(cmd!.pluginId).toBe("core");
  });

  it("getOrThrow throws on missing command", () => {
    const registry = createCommandRegistry();
    expect(() => registry.getOrThrow("missing")).toThrow(CommandError);
  });

  it("rejects duplicate command names", () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "test",
      pluginId: "a",
      description: "test A",
      handler: async () => ({}),
    });

    expect(() =>
      registry.register({
        name: "test",
        pluginId: "b",
        description: "test B",
        handler: async () => ({}),
      })
    ).toThrow(CommandError);
  });

  it("validates command name format", () => {
    const registry = createCommandRegistry();
    expect(() =>
      registry.register({
        name: "Bad_Name",
        pluginId: "core",
        description: "invalid",
        handler: async () => ({}),
      })
    ).toThrow(CommandError);
  });

  it("lists commands sorted alphabetically", () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "zebra",
      pluginId: "core",
      description: "Z command",
      handler: async () => ({}),
    });
    registry.register({
      name: "alpha",
      pluginId: "core",
      description: "A command",
      handler: async () => ({}),
    });

    const list = registry.list();
    expect(list.map((c) => c.name)).toEqual(["alpha", "zebra"]);
  });

  it("generates summaries with help and autocomplete", () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "guide",
      pluginId: "core-guide",
      description: "Show guidance",
      handler: async () => ({}),
      help: { usage: "/guide [topic]", examples: ["/guide combat"] },
      autocomplete: {
        positionalHints: ["topic"],
        flagHints: [{ name: "--verbose", description: "Verbose output", takesValue: false }],
      },
    });

    const summaries = registry.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].usage).toBe("/guide [topic]");
    expect(summaries[0].examples).toEqual(["/guide combat"]);
    expect(summaries[0].positionalHints).toEqual(["topic"]);
    expect(summaries[0].flagHints).toHaveLength(1);
  });

  it("generates default usage when no help provided", () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "ping",
      pluginId: "core",
      description: "Ping",
      handler: async () => ({}),
    });

    const summaries = registry.listSummaries();
    expect(summaries[0].usage).toBe("/ping");
  });
});
