import { describe, it, expect } from "vitest";
import { createPluginRegistry } from "../src/registry/plugin-registry.js";
import type { PluginManifest } from "@covel/shared";

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: "1.0",
    id: "test-plugin",
    displayName: "Test",
    version: "0.1.0",
    author: "test",
    description: "desc",
    defaultLocale: "zh-CN",
    supportedLocales: ["zh-CN"],
    ...overrides,
  };
}

describe("plugin-registry", () => {
  it("adds and retrieves a plugin", () => {
    const registry = createPluginRegistry();
    const manifest = makeManifest();
    registry.add(manifest, "/path/to/plugin");

    expect(registry.has("test-plugin")).toBe(true);
    expect(registry.get("test-plugin")?.manifest.id).toBe("test-plugin");
  });

  it("throws on duplicate plugin ID", () => {
    const registry = createPluginRegistry();
    registry.add(makeManifest(), "/path");
    expect(() => registry.add(makeManifest(), "/path2")).toThrow("already registered");
  });

  it("enables and disables plugins", () => {
    const registry = createPluginRegistry();
    registry.add(makeManifest(), "/path");

    registry.disable("test-plugin");
    expect(registry.listEnabled()).toHaveLength(0);
    expect(registry.list()).toHaveLength(1);

    registry.enable("test-plugin");
    expect(registry.listEnabled()).toHaveLength(1);
  });

  it("removes a plugin", () => {
    const registry = createPluginRegistry();
    registry.add(makeManifest(), "/path");

    expect(registry.remove("test-plugin")).toBe(true);
    expect(registry.has("test-plugin")).toBe(false);
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("validates required dependencies", () => {
    const registry = createPluginRegistry();
    const manifest = makeManifest({ id: "dependent", requires: ["missing-dep"] });
    const errors = registry.validateConstraints(manifest);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("missing-dep");
  });

  it("validates conflicts", () => {
    const registry = createPluginRegistry();
    registry.add(makeManifest({ id: "existing" }), "/path");

    const manifest = makeManifest({ id: "new-plugin", conflicts: ["existing"] });
    const errors = registry.validateConstraints(manifest);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("existing");
  });

  it("passes validation when deps are met and no conflicts", () => {
    const registry = createPluginRegistry();
    registry.add(makeManifest({ id: "dep-a" }), "/path");

    const manifest = makeManifest({ id: "new-plugin", requires: ["dep-a"] });
    const errors = registry.validateConstraints(manifest);
    expect(errors).toHaveLength(0);
  });
});
