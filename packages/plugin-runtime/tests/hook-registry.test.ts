import { describe, it, expect } from "vitest";
import { createHookRegistry } from "../src/registry/hook-registry.js";

const stubHandler = async () => ({ allow: true });

describe("hook-registry", () => {
  it("registers and retrieves hooks by event", () => {
    const registry = createHookRegistry();
    registry.register(
      "my-plugin",
      { id: "h1", event: "TurnStart", handlerKind: "command" },
      stubHandler,
      100
    );

    const hooks = registry.getHooksForEvent("TurnStart");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].pluginId).toBe("my-plugin");
  });

  it("sorts hooks by loadingOrder", () => {
    const registry = createHookRegistry();
    registry.register(
      "late",
      { id: "h2", event: "TurnStart", handlerKind: "command" },
      stubHandler,
      200
    );
    registry.register(
      "early",
      { id: "h1", event: "TurnStart", handlerKind: "command" },
      stubHandler,
      10
    );

    const hooks = registry.getHooksForEvent("TurnStart");
    expect(hooks[0].pluginId).toBe("early");
    expect(hooks[1].pluginId).toBe("late");
  });

  it("filters hooks by match criteria", () => {
    const registry = createHookRegistry();
    registry.register(
      "p1",
      {
        id: "h1",
        event: "PreToolUse",
        handlerKind: "command",
        match: { toolIds: ["tool-a"] },
      },
      stubHandler,
      100
    );
    registry.register(
      "p2",
      { id: "h2", event: "PreToolUse", handlerKind: "command" },
      stubHandler,
      100
    );

    const matchA = registry.getHooksForEvent("PreToolUse", { toolId: "tool-a" });
    expect(matchA).toHaveLength(2);

    const matchB = registry.getHooksForEvent("PreToolUse", { toolId: "tool-b" });
    expect(matchB).toHaveLength(1);
    expect(matchB[0].pluginId).toBe("p2");
  });

  it("removes hooks by plugin", () => {
    const registry = createHookRegistry();
    registry.register(
      "p1",
      { id: "h1", event: "TurnStart", handlerKind: "command" },
      stubHandler,
      100
    );
    registry.register(
      "p2",
      { id: "h2", event: "TurnStart", handlerKind: "command" },
      stubHandler,
      100
    );

    registry.removeByPlugin("p1");
    expect(registry.getHooksForEvent("TurnStart")).toHaveLength(1);
  });

  it("returns empty array for unregistered events", () => {
    const registry = createHookRegistry();
    expect(registry.getHooksForEvent("TurnStop")).toHaveLength(0);
  });
});
