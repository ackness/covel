import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  discoverPlugins,
  loadPluginDefinition,
  parsePluginMd,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { buildPluginSummary } from "../../src/lib/plugin-descriptor.js";

function entry(root: ReturnType<typeof parsePluginMd>): PluginRegistryEntry {
  return {
    id: "probe",
    summary: {
      id: "probe",
      name: "Probe",
      description: "Probe",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    packageManifest: root,
    manifests: [],
    loadedRuntimes: new Map(),
    status: "registered",
    source: "builtin",
  };
}
describe("plugin catalog settings", () => {
  it("projects root settings for entry-only packages without runtime declarations", () => {
    const root = parsePluginMd(
      `---\nid: probe\nkind: plugin\ndescription: Probe\ncontributes:\n  settings:\n    - {key: voice, type: text, label: Voice, default: calm}\n---\n`,
      "probe/PLUGIN.md",
    );
    expect(buildPluginSummary(entry(root)).userSettings).toEqual([
      { key: "voice", type: "text", label: "Voice", default: "calm" },
    ]);
  });
  it("does not discover settings from compiled runtime artifacts", () => {
    const root = parsePluginMd(
      "---\nid: probe\nkind: plugin\ndescription: Probe\n---\n",
      "probe/PLUGIN.md",
    );
    const value: PluginRegistryEntry = {
      ...entry(root),
      manifests: [
        {
          runtime: { type: "agent" },
          manifest: {
            name: "probe/run",
            pluginId: "probe",
            description: "Run",
            userSettings: [{ key: "stale", type: "text", label: "Stale" }],
          },
          promptTemplate: "",
          rawFrontmatter: {},
        },
      ],
    };
    expect(buildPluginSummary(value).userSettings).toEqual([]);
  });
  it("exposes the real narrator narrative-person setting from the canonical package", async () => {
    const discovery = (
      await discoverPlugins(
        path.resolve(import.meta.dirname, "../../../../plugins"),
      )
    ).find((plugin) => plugin.id === "narrator")!;
    const definition = await loadPluginDefinition(discovery);
    const value: PluginRegistryEntry = {
      ...entry(definition.packageManifest),
      id: discovery.id,
      manifests: definition.manifests,
    };
    expect(buildPluginSummary(value).userSettings).toContainEqual(
      expect.objectContaining({
        key: "narrativePerson",
        type: "select",
        default: "second",
      }),
    );
  });
});
