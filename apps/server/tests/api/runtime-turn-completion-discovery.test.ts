import { describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  type ParsedPluginMd,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { buildFrameworkCapabilities } from "../../src/routes/api/discovery.js";
import { buildPluginDetail } from "../../src/lib/plugin-descriptor.js";
import { buildAvailablePluginList } from "../../src/routes/api/session/plugins.js";

function makeEntry(manifests: readonly RuntimeManifest[]): PluginRegistryEntry {
  const parsed: ParsedPluginMd[] = manifests.map((manifest) => ({
    manifest,
    promptTemplate: "",
    rawFrontmatter: {},
  }));
  return {
    id: "media-tools",
    summary: {
      id: "media-tools",
      name: "Media Tools",
      description: "Test media runtimes",
      pluginType: "plugin",
      runtimeCount: parsed.length,
    },
    manifests: parsed,
    manifest: parsed[0],
    loadedRuntimes: new Map(
      parsed.map((item) => [
        item.manifest.name,
        { manifest: item.manifest, promptTemplate: "" },
      ]),
    ),
    status: "registered",
    source: "builtin",
  };
}

describe("runtime turnCompletion discovery", () => {
  const awaited: RuntimeManifest = {
    name: "media-tools/prepare",
    pluginId: "media-tools",
    description: "Prepare media metadata",
    stage: "post-turn",
  };
  const detached: RuntimeManifest = {
    name: "media-tools/render",
    pluginId: "media-tools",
    description: "Render media",
    runtimeType: "function",
    execution: "background",
    stage: "post-turn",
    turnCompletion: {
      mode: "detached",
      maxQueueMs: 15_000,
      maxExecutionMs: 90_000,
    },
  };

  it("returns an explicit effective policy from the plugin contract", () => {
    const contract = buildPluginDetail(makeEntry([awaited, detached]));

    expect(contract.runtimes.map((runtime) => runtime.turnCompletion)).toEqual([
      { mode: "await" },
      {
        mode: "detached",
        maxQueueMs: 15_000,
        maxExecutionMs: 90_000,
        overlap: "serial",
        stalePolicy: "reject",
      },
    ]);
  });

  it("exposes explicit execution modes for manual and event background work", () => {
    const contract = buildPluginDetail(makeEntry([awaited, detached]));
    expect(contract.runtimes.map((runtime) => runtime.execution)).toEqual([
      "sync",
      "background",
    ]);

    const registry = createPluginRegistry();
    registry.register(makeEntry([awaited, detached]));
    const [plugin] = buildAvailablePluginList(
      ["media-tools"],
      registry,
    ) as Array<{
      runtimes: Array<{ execution: string }>;
    }>;
    expect(plugin?.runtimes.map((runtime) => runtime.execution)).toEqual([
      "sync",
      "background",
    ]);
  });

  it("exposes the same effective policy in the session plugin list", () => {
    const registry = createPluginRegistry();
    registry.register({
      ...makeEntry([awaited, detached]),
      // Catalog projection must describe declarations, regardless of whether
      // executable artifacts have been loaded for this process.
      loadedRuntimes: new Map(),
    });

    const [plugin] = buildAvailablePluginList(
      ["media-tools"],
      registry,
    ) as Array<{
      runtimes: Array<{ turnCompletion: Record<string, unknown> }>;
    }>;

    expect(plugin?.runtimes.map((runtime) => runtime.turnCompletion)).toEqual([
      { mode: "await" },
      {
        mode: "detached",
        maxQueueMs: 15_000,
        maxExecutionMs: 90_000,
        overlap: "serial",
        stalePolicy: "reject",
      },
    ]);
  });

  it("advertises the supported policy values", () => {
    const capabilities = buildFrameworkCapabilities().framework as {
      pluginManifest: { turnCompletionModes: string[] };
    };
    expect(capabilities.pluginManifest.turnCompletionModes).toEqual([
      "await",
      "detached",
    ]);
  });
});
