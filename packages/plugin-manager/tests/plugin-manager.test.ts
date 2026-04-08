import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createPluginManager } from "../src/plugin-manager.js";
import { topologicalSort } from "../src/topo-sort.js";
import { scanPlugin } from "../src/fs-scanner.js";
import { createPluginRegistry, createToolRegistry, createRuntimeRegistry } from "../src/registries.js";

// Test fixtures: use the demo plugins from the design docs
const PLUGIN_DEMO_DIR = resolve(import.meta.dirname, "../../../docs/plugin-system-v1/plugin-demo");
const IMAGE_DEMO_DIR = resolve(import.meta.dirname, "../../../docs/plugin-system-v1/image-workflow-demo");

describe("topologicalSort", () => {
  it("should sort independent plugins alphabetically", () => {
    const result = topologicalSort([
      { id: "b", dependencies: [] },
      { id: "a", dependencies: [] },
      { id: "c", dependencies: [] },
    ]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("should sort dependent plugins after their dependencies", () => {
    const result = topologicalSort([
      { id: "narrator", dependencies: ["states"] },
      { id: "states", dependencies: [] },
      { id: "guide", dependencies: ["narrator"] },
    ]);
    expect(result.indexOf("states")).toBeLessThan(result.indexOf("narrator"));
    expect(result.indexOf("narrator")).toBeLessThan(result.indexOf("guide"));
  });

  it("should handle circular deps by appending remaining", () => {
    const result = topologicalSort([
      { id: "a", dependencies: ["b"] },
      { id: "b", dependencies: ["a"] },
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("scanPlugin", () => {
  it("should scan demo plugin", async () => {
    const result = await scanPlugin(PLUGIN_DEMO_DIR);
    expect(result.plugin).toBeDefined();
    expect(result.plugin.manifest.id).toBe("demo-plugin");
    expect(result.plugin.manifest.schemaVersion).toBe("covel.plugin/v1");
    expect(result.plugin.runtimes.size).toBe(1);
    expect(result.plugin.runtimes.has("luck-roller")).toBe(true);
  });

  it("should scan image workflow demo", async () => {
    const result = await scanPlugin(IMAGE_DEMO_DIR);
    expect(result.plugin).toBeDefined();
    expect(result.plugin.manifest.id).toBe("image-workflow-demo");
    expect(result.plugin.runtimes.size).toBe(2);
    expect(result.plugin.runtimes.has("prompt-optimizer")).toBe(true);
    expect(result.plugin.runtimes.has("image-generator")).toBe(true);
  });

  it("should resolve runtime file paths", async () => {
    const result = await scanPlugin(PLUGIN_DEMO_DIR);
    const luckRoller = result.plugin.runtimes.get("luck-roller")!;
    expect(luckRoller.instructionsPath).toContain("instructions.md");
    expect(luckRoller.outputSchemaPath).toContain("output.schema.json");
    expect(luckRoller.llmConfigPath).toContain("llm.toml");
    expect(luckRoller.toolFiles.length).toBeGreaterThan(0);
  });
});

describe("PluginRegistry", () => {
  it("should add and list plugins", () => {
    const reg = createPluginRegistry();
    reg.add({
      manifest: {
        schemaVersion: "covel.plugin/v1",
        id: "test-plugin",
        pluginType: "plugin",
        displayName: { "en-US": "Test" },
        version: "0.1.0",
        author: "test",
        description: { "en-US": "Test" },
        defaultLocale: "en-US",
        supportedLocales: ["en-US"],
        runtimeIds: [],
      },
      dir: "/tmp/test",
      runtimes: new Map(),
      generationId: "gen-1",
    });

    expect(reg.list()).toHaveLength(1);
    expect(reg.has("test-plugin")).toBe(true);
  });
});

describe("ToolRegistry", () => {
  it("should register and resolve tools", () => {
    const reg = createToolRegistry();
    reg.register({
      qualifiedId: "demo:roll-luck",
      pluginId: "demo",
      runtimeId: "luck-roller",
      toolId: "roll-luck",
      exported: true,
      execute: async () => ({}),
    });

    const resolved = reg.resolveForRuntime("demo", "luck-roller");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].qualifiedId).toBe("demo:roll-luck");
  });

  it("should resolve exported tools for other plugins", () => {
    const reg = createToolRegistry();
    reg.setRuntimeImports("other-plugin", "some-runtime", ["core-states.update-character"]);
    reg.register({
      qualifiedId: "core-states.update-character",
      pluginId: "core-states",
      runtimeId: "state-tracker",
      toolId: "update-character",
      exported: true,
      execute: async () => ({}),
    });

    const resolved = reg.resolveForRuntime("other-plugin", "some-runtime");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].qualifiedId).toBe("core-states.update-character");
  });

  it("should not resolve non-exported tools for other plugins", () => {
    const reg = createToolRegistry();
    reg.register({
      qualifiedId: "demo:internal-tool",
      pluginId: "demo",
      runtimeId: "luck-roller",
      toolId: "internal-tool",
      exported: false,
      execute: async () => ({}),
    });

    const resolved = reg.resolveForRuntime("other-plugin", "some-runtime");
    expect(resolved).toHaveLength(0);
  });

  it("should not expose exported tools without matching toolImports", () => {
    const reg = createToolRegistry();
    reg.register({
      qualifiedId: "core-states.update-character",
      pluginId: "core-states",
      runtimeId: "state-tracker",
      toolId: "update-character",
      exported: true,
      execute: async () => ({}),
    });

    const resolved = reg.resolveForRuntime("other-plugin", "some-runtime");
    expect(resolved).toHaveLength(0);
  });
});

describe("PluginManager", () => {
  it("should loadAll from demo directory", async () => {
    const mgr = createPluginManager();
    const demoBase = resolve(import.meta.dirname, "../../../docs/plugin-system-v1");
    const results = await mgr.loadAll(demoBase);

    // demo-plugin and image-workflow-demo both declare dependencies: ["core-states"]
    // which is not present, so they may fail dependency check.
    // At minimum, both should appear in results (success or not).
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Verify the scanner found the right plugins
    const ids = results.map((r) => r.pluginId);
    expect(ids).toContain("demo-plugin");
    expect(ids).toContain("image-workflow-demo");
  });

  it("should load a single plugin", async () => {
    const mgr = createPluginManager();
    const result = await mgr.load(PLUGIN_DEMO_DIR);
    expect(result.success).toBe(true);
    expect(result.pluginId).toBe("demo-plugin");
    expect(result.runtimeCount).toBe(1);
  });

  it("should register scanned runtime tools on load", async () => {
    const mgr = createPluginManager();
    await mgr.load(PLUGIN_DEMO_DIR);

    const resolved = mgr.registries.tools.resolveForRuntime("demo-plugin", "luck-roller");
    expect(resolved.some((tool) => tool.toolId === "roll-luck")).toBe(true);
  });

  it("should only expose imported exported tools to consumers", async () => {
    const baseDir = await mkdtemp(resolve(tmpdir(), "covel-v1-tools-"));
    const providerDir = resolve(baseDir, "provider-plugin");
    const consumerDir = resolve(baseDir, "consumer-plugin");

    await mkdir(resolve(providerDir, "runtimes", "provider", "tools"), { recursive: true });
    await mkdir(resolve(consumerDir, "runtimes", "consumer"), { recursive: true });

    await writeFile(
      resolve(providerDir, "plugin.json"),
      JSON.stringify({
        schemaVersion: "covel.plugin/v1",
        id: "provider-plugin",
        pluginType: "plugin",
        displayName: { "en-US": "Provider" },
        version: "0.1.0",
        author: "test",
        description: { "en-US": "Provider" },
        defaultLocale: "en-US",
        supportedLocales: ["en-US"],
        runtimeIds: ["provider"],
      }),
    );
    await writeFile(resolve(providerDir, "PLUGIN.md"), "# Provider");
    await writeFile(
      resolve(providerDir, "runtimes", "provider", "runtime.json"),
      JSON.stringify({
        id: "provider",
        displayName: { "en-US": "Provider Runtime" },
        priority: 500,
        trigger: { type: "turn" },
        instructionsRef: "instructions.md",
        outputSchemaRef: "output.schema.json",
        llmConfigRef: "llm.toml",
      }),
    );
    await writeFile(resolve(providerDir, "runtimes", "provider", "instructions.md"), "# Provider runtime");
    await writeFile(resolve(providerDir, "runtimes", "provider", "output.schema.json"), JSON.stringify({ type: "object" }));
    await writeFile(resolve(providerDir, "runtimes", "provider", "llm.toml"), "[slots.plugin]\nprovider = \"test\"\nmodel = \"test\"");
    await writeFile(
      resolve(providerDir, "runtimes", "provider", "tools", "shared.js"),
      "export const tool = { id: 'shared', description: 'shared', exported: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, async execute() { return { ok: true }; } };",
    );

    await writeFile(
      resolve(consumerDir, "plugin.json"),
      JSON.stringify({
        schemaVersion: "covel.plugin/v1",
        id: "consumer-plugin",
        pluginType: "plugin",
        displayName: { "en-US": "Consumer" },
        version: "0.1.0",
        author: "test",
        description: { "en-US": "Consumer" },
        defaultLocale: "en-US",
        supportedLocales: ["en-US"],
        runtimeIds: ["consumer"],
      }),
    );
    await writeFile(resolve(consumerDir, "PLUGIN.md"), "# Consumer");
    await writeFile(
      resolve(consumerDir, "runtimes", "consumer", "runtime.json"),
      JSON.stringify({
        id: "consumer",
        displayName: { "en-US": "Consumer Runtime" },
        priority: 500,
        trigger: { type: "turn" },
        instructionsRef: "instructions.md",
        outputSchemaRef: "output.schema.json",
        llmConfigRef: "llm.toml",
        toolImports: ["provider-plugin.shared"],
      }),
    );
    await writeFile(resolve(consumerDir, "runtimes", "consumer", "instructions.md"), "# Consumer runtime");
    await writeFile(resolve(consumerDir, "runtimes", "consumer", "output.schema.json"), JSON.stringify({ type: "object" }));
    await writeFile(resolve(consumerDir, "runtimes", "consumer", "llm.toml"), "[slots.plugin]\nprovider = \"test\"\nmodel = \"test\"");

    const mgr = createPluginManager();
    await mgr.loadAll(baseDir);

    const resolved = mgr.registries.tools.resolveForRuntime("consumer-plugin", "consumer");
    expect(resolved.some((tool) => tool.qualifiedId === "provider-plugin.shared")).toBe(true);
  });

  it("should unload a plugin", async () => {
    const mgr = createPluginManager();
    await mgr.load(PLUGIN_DEMO_DIR);
    expect(mgr.list()).toHaveLength(1);

    await mgr.unload("demo-plugin");
    expect(mgr.list()).toHaveLength(0);
  });

  it("should reload a plugin with new generationId", async () => {
    const mgr = createPluginManager();
    await mgr.load(PLUGIN_DEMO_DIR);

    const before = mgr.get("demo-plugin")!;
    const oldGen = before.generationId;

    await mgr.reload("demo-plugin");

    const after = mgr.get("demo-plugin")!;
    expect(after.generationId).not.toBe(oldGen);
  });

  it("should prevent disabling core-plugin", async () => {
    const mgr = createPluginManager();
    // Load a plugin that's a core-plugin type — we'll mock one via direct registry
    const regs = mgr.registries as any;
    regs.pluginStore.add({
      manifest: {
        schemaVersion: "covel.plugin/v1",
        id: "core-test",
        pluginType: "core-plugin",
        displayName: { "en-US": "Core Test" },
        version: "0.1.0",
        author: "test",
        description: { "en-US": "Test" },
        defaultLocale: "en-US",
        supportedLocales: ["en-US"],
        runtimeIds: [],
      },
      dir: "/tmp/core-test",
      runtimes: new Map(),
      generationId: "gen-1",
    });

    await expect(mgr.disable("core-test", "session-1")).rejects.toThrow("Cannot disable core-plugin");
  });
});
