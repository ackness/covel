import { describe, expect, it } from "vitest";
import {
  parsePluginMd,
  parseRuntimeMd,
  compileInlineRuntime,
} from "../src/parse-plugin-md.js";
import { createPluginRegistry } from "../src/registry.js";
import {
  pluginDeclarations,
  pluginRuntimeManifests,
  resolvePluginDeclarations,
  resolvePluginRuntimeManifest,
  validatePluginDeclarations,
} from "../src/declarations.js";
import type { PluginRegistryEntry } from "../src/types.js";

function declaration(fields: Record<string, unknown> = {}) {
  return parsePluginMd(
    `---\n${JSON.stringify({ id: "probe", kind: "plugin", description: "Probe", ...fields })}\n---\n`,
    "probe/PLUGIN.md",
  );
}
function child(
  root: ReturnType<typeof declaration>,
  fields: Record<string, unknown> = {},
) {
  return parseRuntimeMd(
    `---\n${JSON.stringify({ type: "agent", schedule: { stage: "narrative" }, ...fields })}\n---\n`,
    "probe/runtimes/run/RUNTIME.md",
    root.plugin!,
  );
}
function entry(overrides: Partial<PluginRegistryEntry>): PluginRegistryEntry {
  return {
    id: "probe",
    summary: {
      id: "probe",
      name: "Probe",
      description: "Probe",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    status: "registered",
    loadedRuntimes: new Map(),
    ...overrides,
  };
}
const setting = { key: "limit", type: "number", label: "Limit", default: 3 };

describe("package declarations", () => {
  it("rejects duplicate identities before deduplicating source declarations", () => {
    const root = declaration();
    expect(() =>
      validatePluginDeclarations([
        root,
        { ...root, sourcePath: "other/PLUGIN.md" },
      ]),
    ).toThrow("Duplicate manifest name");
    expect(() => validatePluginDeclarations([root, root])).not.toThrow();
  });
  it("keeps zero-runtime packages discoverable without scheduling their declarations", async () => {
    const root = declaration({
      entry: "./server.js",
      provides: ["panel@1"],
      contributes: { settings: [setting] },
    });
    const record = entry({
      packageManifest: root,
      manifests: [],
    });
    const registry = createPluginRegistry();
    registry.register(record);
    await registry.applyPersistedActivations(
      "session",
      ["probe"],
      async () => {},
    );
    expect(pluginRuntimeManifests(record)).toEqual([]);
    expect(pluginDeclarations(record)).toEqual([root]);
    expect(registry.getActiveRuntimes("session")).toEqual([]);
    expect(registry.getActivePluginDeclarations("session")).toEqual([
      root.manifest,
    ]);
  });
  it("inherits root settings and data context without copying UI or output contracts", () => {
    const root = declaration({
      provides: ["compute@1"],
      contributes: {
        settings: [setting],
        data: { facts: { version: 1, schema: "./schemas/facts.json" } },
        ui: { right: ["./root.json"] },
      },
    });
    const runtime = child(root, { io: { output: { contract: "compute@1" } } });
    const record = entry({ packageManifest: root, manifests: [runtime] });
    const effective = resolvePluginRuntimeManifest(record, runtime.manifest);
    expect(effective.userSettings).toEqual([setting]);
    expect(effective.dataSchemas).toEqual(root.manifest.dataSchemas);
    expect(effective.outputContract).toBe("compute@1");
    expect(effective.ui).toBeUndefined();
    expect(pluginDeclarations(record)).toEqual([root]);
  });
  it("publishes one package contribution set for multiple runtimes", async () => {
    const root = declaration({
      contributes: {
        actions: ["inspect"],
        commands: [{ name: "probe", description: "Probe", action: "inspect" }],
        events: [
          {
            topic: "probe.ready",
            description: "Ready",
            schema: "./ready.json",
          },
        ],
        settings: [setting],
      },
    });
    const first = child(root);
    const second = parseRuntimeMd(
      `---\n${JSON.stringify({ type: "agent", schedule: { stage: "post-turn" } })}\n---\n`,
      "probe/runtimes/second/RUNTIME.md",
      root.plugin,
    );
    const registry = createPluginRegistry();
    registry.register(
      entry({ packageManifest: root, manifests: [first, second] }),
    );
    registry.syncSessionActivations("session", ["probe"]);
    expect(registry.getActivePluginDeclarations("session")).toEqual([
      root.manifest,
    ]);
    expect(
      registry.getActiveRuntimes("session").map((runtime) => runtime.name),
    ).toEqual(["probe/run", "probe/second"]);
    for (const runtime of registry.getActiveRuntimes("session")) {
      expect(runtime.userSettings).toEqual([setting]);
      expect(runtime).not.toHaveProperty("commands");
      expect(runtime).not.toHaveProperty("events");
    }
    expect(root.manifest).not.toHaveProperty("stage");
    expect(root.manifest).not.toHaveProperty("runtimeType");
  });
  it.each(["settings", "data", "commands", "events", "ui"])(
    "rejects package contribution %s on a child runtime",
    (field) => {
      const root = declaration();
      expect(() => child(root, { contributes: { [field]: [] } })).toThrow(
        "invalid manifest",
      );
    },
  );
  it("keeps inline execution separate and validates command action ownership", () => {
    const root = declaration({
      runtime: { type: "agent", schedule: { stage: "narrative" } },
      contributes: { settings: [setting] },
    });
    expect(
      pluginDeclarations(
        entry({
          packageManifest: root,
          manifests: [compileInlineRuntime(root)!],
        }),
      ),
    ).toEqual([root]);
    expect(resolvePluginDeclarations([root]).userSettings).toEqual([setting]);
    const invalid = declaration({
      contributes: {
        commands: [{ name: "probe", description: "Probe", action: "inspect" }],
      },
    });
    expect(() => validatePluginDeclarations([invalid])).toThrow(
      "contributes.actions",
    );
  });
});
