import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPlugins, loadPluginDefinition } from "@covel/plugin-loader";
import {
  enforcePluginRegistrationContract,
  PluginServiceRegistry,
} from "@covel/runtime";
import entry from "../server/index.js";

describe("policy service registration", () => {
  it("matches its one code-only read declaration and disposes the real registration", async () => {
    const discovery = (
      await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
    ).find(({ id }) => id === "turn-policy");
    const definition = await loadPluginDefinition(discovery);
    expect(definition.manifests).toEqual([]);
    expect(definition.packageManifest.plugin.contributes.services).toEqual([
      "turn-policy@1",
    ]);
    const registry = new PluginServiceRegistry({
      list: async () => ["caller", "turn-policy"],
      ensure: async () => {},
    });
    const disposers = [];
    const checked = enforcePluginRegistrationContract(
      {
        pluginId: "turn-policy",
        registerService: (service) =>
          disposers.push(registry.register("turn-policy", service)),
      },
      definition.packageManifest.plugin.contributes,
    );
    entry(checked.api);
    checked.validate();
    expect(registry.list()).toMatchObject([
      {
        pluginId: "turn-policy",
        name: "turn-policy",
        contract: "turn-policy@1",
      },
    ]);
    expect(
      await registry.resolveImport(
        { sessionId: "scene", pluginId: "caller" },
        "turn-policy@1",
      ),
    ).toMatchObject({ status: "not-model-facing" });
    for (const dispose of disposers) dispose();
    expect(registry.list()).toEqual([]);
  });
});
