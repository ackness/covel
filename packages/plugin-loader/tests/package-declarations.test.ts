import { describe, expect, it } from "vitest";
import { parsePluginMd } from "../src/parse-plugin-md.js";
import { createPluginRegistry } from "../src/registry.js";
import {
  pluginDeclarations,
  pluginRuntimeManifests,
  resolvePluginDeclarations,
  resolvePluginRuntimeManifest,
  validatePluginDeclarations,
} from "../src/declarations.js";
import type { PluginRegistryEntry } from "../src/types.js";

function declaration(name: string, fields: Record<string, unknown> = {}) {
  return parsePluginMd(
    `---\n${Object.entries({ name, description: name, ...fields })
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n")}\n---\n`,
    `${name}/PLUGIN.md`,
  );
}

const setting = { key: "limit", type: "number", label: "Limit", default: 3 };
const schema = {
  schemaVersion: 1,
  acceptsWorldData: true,
  schema: "./schemas/data.json",
};

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

describe("package declarations", () => {
  it("rejects duplicate identities before source declarations can be deduplicated", () => {
    const root = declaration("probe");
    const child = {
      ...declaration("probe", { stage: "narrative" }),
      sourcePath: "probe/runtimes/run/PLUGIN.md",
    };
    expect(() => validatePluginDeclarations([root, child])).toThrow(
      "Duplicate manifest name",
    );
    expect(() => validatePluginDeclarations([root, root])).not.toThrow();
  });

  it("keeps zero-runtime packages discoverable without scheduling their capabilities", async () => {
    const root = declaration("probe", {
      entry: "./server.js",
      capabilities: ["memory-panel"],
      userSettings: [setting],
    });
    const record = entry({
      packageManifest: root,
      manifest: root,
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
    expect(registry.findPluginByCapability("session", "memory-panel")).toBe(
      "probe",
    );
  });

  it("inherits shared settings and schemas without copying UI or package capabilities", () => {
    const root = declaration("probe", {
      userSettings: [setting],
      dataSchemas: { data: schema },
      ui: { right: ["./root.json"] },
      capabilities: ["memory-panel"],
    });
    const runtime = declaration("probe/run", {
      stage: "narrative",
      userSettings: [{ ...setting, key: "other" }],
      capabilities: ["compute"],
    });
    const record = entry({ packageManifest: root, manifests: [runtime] });
    const effective = resolvePluginRuntimeManifest(record, runtime.manifest);
    expect(effective.userSettings?.map(({ key }) => key)).toEqual([
      "limit",
      "other",
    ]);
    expect(effective.dataSchemas).toEqual(root.manifest.dataSchemas);
    expect(effective.capabilities).toEqual(["compute"]);
    expect(effective.ui).toBeUndefined();
    expect(runtime.manifest.userSettings).toHaveLength(1);
    expect(pluginDeclarations(record)).toEqual([root, runtime]);
  });

  it.each([
    [
      "userSettings",
      { userSettings: [setting] },
      { userSettings: [{ ...setting, default: 4 }] },
    ],
    [
      "dataSchemas",
      { dataSchemas: { data: schema } },
      { dataSchemas: { data: { ...schema, schemaVersion: 2 } } },
    ],
    [
      "commands",
      { commands: [{ name: "probe", description: "Probe", action: "one" }] },
      { commands: [{ name: "probe", description: "Probe", action: "two" }] },
    ],
    [
      "events",
      {
        events: [
          {
            topic: "probe.event",
            schema: "./schemas/one.json",
            description: "Probe",
          },
        ],
      },
      {
        events: [
          {
            topic: "probe.event",
            schema: "./schemas/two.json",
            description: "Probe",
          },
        ],
      },
    ],
  ])(
    "rejects conflicting %s with both source locations",
    (field, first, second) => {
      const root = declaration("probe", first as Record<string, unknown>);
      const runtime = declaration(
        "probe/run",
        second as Record<string, unknown>,
      );
      expect(() => validatePluginDeclarations([root, runtime])).toThrow(
        `Conflicting ${field}`,
      );
      expect(() => validatePluginDeclarations([root, runtime])).toThrow(
        "probe/PLUGIN.md and probe/run/PLUGIN.md",
      );
      expect(() =>
        createPluginRegistry().register(
          entry({ packageManifest: root, manifests: [runtime] }),
        ),
      ).toThrow(`Conflicting ${field}`);
    },
  );

  it("deduplicates a compact root runtime and equal local contributions", () => {
    const root = declaration("probe", {
      stage: "narrative",
      userSettings: [setting],
    });
    expect(
      pluginDeclarations(entry({ packageManifest: root, manifests: [root] })),
    ).toEqual([root]);
    expect(
      resolvePluginDeclarations([
        root,
        declaration("probe/other", { userSettings: [setting] }),
      ]).userSettings,
    ).toHaveLength(1);
  });

  it("retains the declared runtime interpretation of hand-built fixtures", () => {
    const runtime = declaration("probe");
    expect(pluginRuntimeManifests(entry({ manifest: runtime }))).toEqual([
      runtime,
    ]);
  });
});
