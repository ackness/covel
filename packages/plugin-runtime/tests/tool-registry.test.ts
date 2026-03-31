import { describe, it, expect } from "vitest";
import { createToolRegistry } from "../src/registry/tool-registry.js";

const stubHandler = async () => ({ output: "ok" });

describe("tool-registry", () => {
  it("registers and retrieves a tool", () => {
    const registry = createToolRegistry();
    registry.register("my-plugin", { id: "greet", kind: "query" }, stubHandler);

    const tool = registry.get("my-plugin", "greet");
    expect(tool).toBeDefined();
    expect(tool!.pluginId).toBe("my-plugin");
    expect(tool!.definition.kind).toBe("query");
  });

  it("retrieves by qualified ID", () => {
    const registry = createToolRegistry();
    registry.register("p", { id: "t", kind: "mutate" }, stubHandler);

    expect(registry.getByQualifiedId("p:t")).toBeDefined();
    expect(registry.getByQualifiedId("p:missing")).toBeUndefined();
  });

  it("throws on duplicate registration", () => {
    const registry = createToolRegistry();
    registry.register("p", { id: "t", kind: "query" }, stubHandler);

    expect(() =>
      registry.register("p", { id: "t", kind: "query" }, stubHandler)
    ).toThrow("already registered");
  });

  it("lists tools by plugin", () => {
    const registry = createToolRegistry();
    registry.register("a", { id: "t1", kind: "query" }, stubHandler);
    registry.register("a", { id: "t2", kind: "mutate" }, stubHandler);
    registry.register("b", { id: "t1", kind: "query" }, stubHandler);

    expect(registry.listByPlugin("a")).toHaveLength(2);
    expect(registry.listByPlugin("b")).toHaveLength(1);
  });

  it("removes tools by plugin", () => {
    const registry = createToolRegistry();
    registry.register("a", { id: "t1", kind: "query" }, stubHandler);
    registry.register("a", { id: "t2", kind: "query" }, stubHandler);
    registry.register("b", { id: "t1", kind: "query" }, stubHandler);

    registry.removeByPlugin("a");
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.listAll()[0].pluginId).toBe("b");
  });
});
