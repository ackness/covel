import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeManifest } from "@covel/shared";
import {
  contractReferenceDiagnostics,
  discoverPlugins,
  loadPluginDefinition,
  type ParsedPluginMd,
  type ParsedRuntimeMd,
  type PluginRegistryEntry,
} from "../src/index.js";

const pluginsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../plugins",
);

function entry(
  id: string,
  options: {
    provides?: string[];
    schemas?: string[];
    runtimes?: Partial<RuntimeManifest>[];
  },
): PluginRegistryEntry {
  const manifests = (options.runtimes ?? []).map(
    (runtime) =>
      ({
        runtime: { type: runtime.runtimeType ?? "agent" },
        manifest: { name: id, pluginId: id, description: id, ...runtime },
        promptTemplate: "",
        rawFrontmatter: {},
      }) as ParsedRuntimeMd,
  );
  return {
    id,
    summary: {
      id,
      name: id,
      description: id,
      pluginType: "plugin",
      runtimeCount: manifests.length,
    },
    packageManifest: {
      manifest: { name: id, pluginId: id, description: id },
      plugin: { id, kind: "plugin", provides: options.provides },
      contractSchemas: Object.fromEntries(
        (options.schemas ?? []).map((contract) => [contract, {}]),
      ),
      promptTemplate: "",
      rawFrontmatter: {},
    } as ParsedPluginMd,
    manifests,
    loadedRuntimes: new Map(),
    status: "registered",
  };
}

describe("contractReferenceDiagnostics", () => {
  it("accepts every builtin contract reference", async () => {
    const entries: PluginRegistryEntry[] = [];
    for (const discovery of await discoverPlugins(pluginsDir)) {
      const definition = await loadPluginDefinition(discovery);
      entries.push({
        id: discovery.id,
        summary: {
          id: discovery.id,
          name: discovery.id,
          description: "",
          pluginType: "plugin",
          runtimeCount: definition.manifests.length,
        },
        packageManifest: definition.packageManifest,
        manifests: definition.manifests,
        loadedRuntimes: new Map(),
        status: "registered",
      });
    }
    expect(contractReferenceDiagnostics(entries)).toEqual([]);
  });

  it("reports unpublished data contracts and unproduced references", () => {
    const messages = contractReferenceDiagnostics([
      entry("provider", {
        provides: ["gate@1", "data@1"],
        runtimes: [{ outputContract: "data@1" }],
      }),
      entry("consumer", {
        runtimes: [
          {
            inputs: { value: { from: { capability: "data@1" } } },
            needs: [{ capability: "gate@1" }],
          },
        ],
      }),
    ]);
    expect(messages).toEqual([
      expect.stringContaining(
        "contract data@1 consumed by consumer inputs.value has no published schema",
      ),
      expect.stringContaining(
        "contract gate@1 referenced by consumer needs is provided by provider but no runtime",
      ),
    ]);
  });

  it("reports each incomplete replacement even when another package produces the contract", () => {
    expect(
      contractReferenceDiagnostics([
        entry("builtin", {
          provides: ["data@1"],
          schemas: ["data@1"],
          runtimes: [{ outputContract: "data@1" }],
        }),
        entry("replacement", { provides: ["data@1"] }),
        entry("consumer", {
          runtimes: [
            {
              input: {
                inject: [
                  {
                    kind: "runtime-export",
                    name: "facts",
                    from: { capability: "data@1" },
                    recordAs: "facts",
                  },
                ],
              },
            },
          ],
        }),
      ]),
    ).toEqual([
      expect.stringContaining(
        "provided by replacement but no runtime in those plugins",
      ),
    ]);
  });
});
