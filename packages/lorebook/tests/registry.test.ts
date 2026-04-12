import { describe, it, expect } from "vitest";
import { LorebookRegistry } from "../src/registry.js";
import type { LorebookEntry } from "../src/types.js";

function mk(
  id: string,
  source: LorebookEntry["source"],
  content: string,
): LorebookEntry {
  return {
    id,
    source,
    keys: [],
    selectiveLogic: "and_any",
    content,
    strategy: "constant",
    position: "after_char_defs",
    insertionOrder: 100,
    enabled: true,
  };
}

describe("LorebookRegistry", () => {
  it("starts empty for every layer", () => {
    const reg = new LorebookRegistry();
    expect(reg.listLayer("world")).toEqual([]);
    expect(reg.listLayer("plugin")).toEqual([]);
    expect(reg.listLayer("session")).toEqual([]);
    expect(reg.getMerged()).toEqual([]);
  });

  it("setLayer replaces the layer wholesale", () => {
    const reg = new LorebookRegistry();
    reg.setLayer("world", [mk("a", "world", "first")]);
    reg.setLayer("world", [mk("b", "world", "second")]);
    const world = reg.listLayer("world");
    expect(world).toHaveLength(1);
    expect(world[0]!.id).toBe("b");
  });

  it("merges layers in world → plugin → session order", () => {
    const reg = new LorebookRegistry();
    reg.setLayer("world", [mk("w1", "world", "W1")]);
    reg.setLayer("plugin", [mk("p1", "plugin", "P1")]);
    reg.setLayer("session", [mk("s1", "session", "S1")]);
    const ids = reg.getMerged().map(e => e.id);
    expect(ids).toEqual(["w1", "p1", "s1"]);
  });

  it("session entry overrides a world entry with the same id (precedence)", () => {
    const reg = new LorebookRegistry();
    reg.setLayer("world", [mk("shared", "world", "from-world")]);
    reg.setLayer("session", [mk("shared", "session", "from-session")]);
    const merged = reg.getMerged();
    // Only one entry remains — the session version wins by id.
    expect(merged).toHaveLength(1);
    expect(merged[0]!.content).toBe("from-session");
    expect(merged[0]!.source).toBe("session");
  });

  it("plugin overrides world but session overrides plugin", () => {
    const reg = new LorebookRegistry();
    reg.setLayer("world", [mk("shared", "world", "W")]);
    reg.setLayer("plugin", [mk("shared", "plugin", "P")]);
    reg.setLayer("session", [mk("shared", "session", "S")]);
    expect(reg.getMerged()[0]!.content).toBe("S");

    // Remove the session-level override and plugin should win.
    reg.remove("session", "shared");
    expect(reg.getMerged()[0]!.content).toBe("P");

    // Remove the plugin override and world is the fallback.
    reg.remove("plugin", "shared");
    expect(reg.getMerged()[0]!.content).toBe("W");
  });

  it("upsert mutates the correct layer based on entry.source", () => {
    const reg = new LorebookRegistry();
    reg.upsert(mk("a", "world", "W"));
    reg.upsert(mk("a", "session", "S"));
    expect(reg.listLayer("world")).toHaveLength(1);
    expect(reg.listLayer("session")).toHaveLength(1);
    // Merged view sees the session version winning.
    expect(reg.getMerged()[0]!.content).toBe("S");
  });
});
