import { describe, it, expect } from "vitest";
import { createMapRegistry, type MapRegistry } from "../src/utils/map-registry.js";

interface TestItem {
  id: string;
  name: string;
}

describe("createMapRegistry", () => {
  let registry: MapRegistry<TestItem>;

  function item(id: string, name = `item-${id}`): TestItem {
    return { id, name };
  }

  // Fresh registry for each test
  const setup = () => createMapRegistry<TestItem>();

  // ── Basic CRUD ──────────────────────────────────────────────────
  it("starts empty", () => {
    registry = setup();
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it("add + get returns the item", () => {
    registry = setup();
    registry.add("a", item("a"));
    expect(registry.get("a")).toEqual(item("a"));
  });

  it("has returns true for existing key", () => {
    registry = setup();
    registry.add("a", item("a"));
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(false);
  });

  it("list returns all values", () => {
    registry = setup();
    registry.add("a", item("a"));
    registry.add("b", item("b"));
    expect(registry.list()).toHaveLength(2);
  });

  it("remove deletes the item and returns true", () => {
    registry = setup();
    registry.add("a", item("a"));
    expect(registry.remove("a")).toBe(true);
    expect(registry.get("a")).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it("remove returns false for non-existent key", () => {
    registry = setup();
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("clear removes all items", () => {
    registry = setup();
    registry.add("a", item("a"));
    registry.add("b", item("b"));
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  // ── Duplicate key handling ─────���────────────────────────────────
  it("throws on duplicate key by default", () => {
    registry = setup();
    registry.add("a", item("a"));
    expect(() => registry.add("a", item("a", "duplicate"))).toThrow();
  });

  it("overwrites when overwrite=true", () => {
    registry = setup();
    registry.add("a", item("a", "original"));
    registry.add("a", item("a", "updated"), true);
    expect(registry.get("a")?.name).toBe("updated");
    expect(registry.size).toBe(1);
  });

  // ── Iteration ──────────────���────────────────────────────────────
  it("entries yields [key, value] pairs", () => {
    registry = setup();
    registry.add("x", item("x"));
    registry.add("y", item("y"));
    const entries = [...registry.entries()];
    expect(entries).toHaveLength(2);
    expect(entries[0]![0]).toBe("x");
    expect(entries[0]![1]).toEqual(item("x"));
  });

  it("keys returns all keys", () => {
    registry = setup();
    registry.add("x", item("x"));
    registry.add("y", item("y"));
    expect(registry.keys().sort()).toEqual(["x", "y"]);
  });

  // ── Size tracking ──────���────────────────────────────────────────
  it("size tracks add/remove correctly", () => {
    registry = setup();
    expect(registry.size).toBe(0);
    registry.add("a", item("a"));
    expect(registry.size).toBe(1);
    registry.add("b", item("b"));
    expect(registry.size).toBe(2);
    registry.remove("a");
    expect(registry.size).toBe(1);
  });
});
