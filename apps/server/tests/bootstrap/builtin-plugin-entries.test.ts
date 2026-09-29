import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createPluginRegistry,
  discoverPluginsMulti,
  loadPluginDefinition,
  loadPluginSummary,
  type ParsedRuntimeMd,
} from "@covel/plugin-loader";
import {
  createHookPipeline,
  createPluginRpcRegistry,
  PluginServiceRegistry,
  PluginExtensionHost,
} from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { ToolRegistry } from "@covel/tools";
import { createBootstrapPluginEntries } from "../../src/routes/api/bootstrap/plugin-entry.js";

it("publishes and disposes every real builtin entry against its root declarations", async () => {
  const root = await fs.realpath(
    path.resolve(import.meta.dirname, "../../../../plugins"),
  );
  const discoveries = await discoverPluginsMulti([root]);
  expect(discoveries.length).toBeGreaterThan(0);
  const registry = createPluginRegistry();
  const manifestCache = new Map<string, readonly ParsedRuntimeMd[]>();
  for (const discovery of discoveries) {
    expect(discovery.source).toBe("builtin");
    const relative = path.relative(root, await fs.realpath(discovery.rootPath));
    expect(
      relative.startsWith("..") || path.isAbsolute(relative),
      discovery.id,
    ).toBe(false);
    const definition = await loadPluginDefinition(discovery);
    registry.register({
      id: discovery.id,
      source: "builtin",
      rootPath: discovery.rootPath,
      summary: await loadPluginSummary(discovery, undefined, definition),
      packageManifest: definition.packageManifest,
      manifests: definition.manifests,

      loadedRuntimes: new Map(),
      status: "registered",
    });
    manifestCache.set(discovery.id, definition.manifests);
  }
  const store = createMemoryStore();
  const tools = new ToolRegistry();
  const services = new PluginServiceRegistry({
    list: async () => discoveries.map((item) => item.id),
    ensure: async () => {},
  });
  const extensions = new PluginExtensionHost(services);
  const entries = await createBootstrapPluginEntries({
    discoveryMap: new Map(discoveries.map((item) => [item.id, item])),
    manifestCache,
    pluginRegistry: registry,
    store,
    tools,
    hookPipeline: createHookPipeline(),
    rpcRegistry: createPluginRpcRegistry(),
    services,
    extensions,
    development: false,
  });
  try {
    for (const discovery of discoveries) {
      const entry = registry.get(discovery.id)!;
      expect(entry.error, discovery.id).toBeUndefined();
      await expect(
        entries.ensurePluginEntry(discovery.id),
      ).resolves.toBeUndefined();
      expect(entries.isEntryPublished(discovery.id), discovery.id).toBe(true);
      for (const name of entry.packageManifest?.plugin?.contributes?.tools ??
        []) {
        expect(
          tools.find(name, discovery.id),
          `${discovery.id}: tool ${name}`,
        ).toBeDefined();
      }
      for (const contract of entry.packageManifest?.plugin?.contributes
        ?.services ?? []) {
        expect(
          services
            .list()
            .some(
              (item) =>
                item.pluginId === discovery.id && item.contract === contract,
            ),
          `${discovery.id}: service ${contract}`,
        ).toBe(true);
      }
      for (const extension of entry.packageManifest?.plugin?.contributes
        ?.extensions ?? []) {
        expect(
          extensions
            .list()
            .some(
              (item) =>
                item.pluginId === discovery.id &&
                item.point === extension.point &&
                item.id === extension.id,
            ),
          `${discovery.id}: extension ${extension.point}/${extension.id}`,
        ).toBe(true);
      }
    }
  } finally {
    await entries.close();
    await store.close();
  }
  expect(services.list()).toEqual([]);
  expect(extensions.list()).toEqual([]);
  for (const discovery of discoveries) {
    expect(entries.isEntryPublished(discovery.id)).toBe(false);
    for (const name of registry.get(discovery.id)?.packageManifest?.plugin
      ?.contributes?.tools ?? [])
      expect(tools.find(name, discovery.id)).toBeUndefined();
  }
});
