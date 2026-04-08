import { randomUUID } from "node:crypto";
import type {
  PluginManager,
  PluginInfo,
  PluginLoadResult,
  PluginRegistries,
} from "./types.js";
import { scanPlugin, scanAllPlugins } from "./fs-scanner.js";
import { createPluginRegistries } from "./registries.js";
import { topologicalSort } from "./topo-sort.js";
import { loadRuntimeTools } from "./tool-loader.js";

/**
 * Create a V1 PluginManager.
 */
export function createPluginManager(): PluginManager {
  const regs = createPluginRegistries();

  // Session-level enable/disable state
  const sessionDisabled = new Map<string, Set<string>>();

  async function loadAll(baseDir: string): Promise<PluginLoadResult[]> {
    const scanResults = await scanAllPlugins(baseDir);
    const results: PluginLoadResult[] = [];

    // Collect manifests for topo sort
    const manifests = scanResults
      .filter((r) => r.plugin?.manifest)
      .map((r) => ({
        id: r.plugin.manifest.id,
        dependencies: r.plugin.manifest.dependencies ?? [],
      }));

    const sorted = topologicalSort(manifests);

    // Load in dependency order
    for (const pluginId of sorted) {
      const scan = scanResults.find((r) => r.plugin?.manifest?.id === pluginId);
      if (!scan) continue;

      if (scan.errors.length > 0 && !scan.plugin) {
        results.push({ pluginId, success: false, errors: scan.errors });
        continue;
      }

      const plugin = scan.plugin;

      // Check dependencies are loaded
      const missingDeps = (plugin.manifest.dependencies ?? []).filter(
        (dep) => !regs.pluginStore.has(dep),
      );
      if (missingDeps.length > 0) {
        const depErrors = [`Missing dependencies: ${missingDeps.join(", ")}`];
        results.push({
          pluginId: plugin.manifest.id,
          success: false,
          errors: [...scan.errors, ...depErrors],
        });
        continue;
      }

      // Register plugin
      regs.pluginStore.add(plugin);

      // Register runtimes
      for (const [, rt] of plugin.runtimes) {
        regs.runtimeStore.register(plugin.manifest.id, rt);
        regs.toolStore.setRuntimeImports?.(
          plugin.manifest.id,
          rt.manifest.id,
          rt.manifest.toolImports ?? [],
        );
      }

      // Register tools
      const toolErrors: string[] = [];
      for (const [, rt] of plugin.runtimes) {
        const loadedTools = await loadRuntimeTools(plugin, rt);
        toolErrors.push(...loadedTools.errors);
        for (const tool of loadedTools.tools) {
          regs.toolStore.register(tool);
        }
      }

      results.push({
        pluginId: plugin.manifest.id,
        success: true,
        errors: [...scan.errors, ...toolErrors].length > 0 ? [...scan.errors, ...toolErrors] : undefined,
        runtimeCount: plugin.runtimes.size,
      });
    }

    // Add any plugins not in topo sort (load errors)
    for (const scan of scanResults) {
      if (!scan.plugin?.manifest) {
        results.push({
          pluginId: "unknown",
          success: false,
          errors: scan.errors,
        });
      }
    }

    return results;
  }

  async function load(pluginDir: string): Promise<PluginLoadResult> {
    const scan = await scanPlugin(pluginDir);
    if (!scan.plugin || scan.errors.length > 0) {
      return {
        pluginId: scan.plugin?.manifest?.id ?? "unknown",
        success: scan.errors.length === 0,
        errors: scan.errors.length > 0 ? scan.errors : undefined,
      };
    }

    const plugin = scan.plugin;
    regs.pluginStore.add(plugin);
    for (const [, rt] of plugin.runtimes) {
      regs.runtimeStore.register(plugin.manifest.id, rt);
      regs.toolStore.setRuntimeImports?.(
        plugin.manifest.id,
        rt.manifest.id,
        rt.manifest.toolImports ?? [],
      );
    }
    const toolErrors: string[] = [];
    for (const [, rt] of plugin.runtimes) {
      const loadedTools = await loadRuntimeTools(plugin, rt);
      toolErrors.push(...loadedTools.errors);
      for (const tool of loadedTools.tools) {
        regs.toolStore.register(tool);
      }
    }

    return {
      pluginId: plugin.manifest.id,
      success: true,
      errors: toolErrors.length > 0 ? toolErrors : undefined,
      runtimeCount: plugin.runtimes.size,
    };
  }

  async function reload(pluginId: string): Promise<void> {
    const existing = regs.pluginStore.getLoaded(pluginId);
    if (!existing) throw new Error(`Plugin "${pluginId}" not loaded.`);

    const scan = await scanPlugin(existing.dir);
    if (!scan.plugin) throw new Error(`Failed to reload plugin "${pluginId}".`);

    const nextPlugin = {
      ...scan.plugin,
      generationId: randomUUID(),
    };

    // Atomic swap: remove old registrations, add new
    regs.runtimeStore.removeByPlugin(pluginId);
    regs.toolStore.unregisterByPlugin(pluginId);
    regs.pluginStore.swap(pluginId, nextPlugin);

    for (const [, rt] of nextPlugin.runtimes) {
      regs.runtimeStore.register(pluginId, rt);
      regs.toolStore.setRuntimeImports?.(
        pluginId,
        rt.manifest.id,
        rt.manifest.toolImports ?? [],
      );
    }
    for (const [, rt] of nextPlugin.runtimes) {
      const loadedTools = await loadRuntimeTools(nextPlugin, rt);
      for (const tool of loadedTools.tools) {
        regs.toolStore.register(tool);
      }
    }
  }

  async function unload(pluginId: string): Promise<void> {
    regs.runtimeStore.removeByPlugin(pluginId);
    regs.toolStore.unregisterByPlugin(pluginId);
    regs.pluginStore.remove(pluginId);
  }

  async function enable(pluginId: string, sessionId: string): Promise<void> {
    const disabled = sessionDisabled.get(sessionId);
    if (disabled) disabled.delete(pluginId);
  }

  async function disable(pluginId: string, sessionId: string): Promise<void> {
    const plugin = regs.pluginStore.getLoaded(pluginId);
    if (plugin?.manifest.pluginType === "core-plugin") {
      throw new Error(`Cannot disable core-plugin "${pluginId}".`);
    }
    if (!sessionDisabled.has(sessionId)) sessionDisabled.set(sessionId, new Set());
    sessionDisabled.get(sessionId)!.add(pluginId);
  }

  function listPlugins(): PluginInfo[] {
    return regs.pluginStore.list();
  }

  function getPlugin(pluginId: string): PluginInfo | undefined {
    const loaded = regs.pluginStore.getLoaded(pluginId);
    if (!loaded) return undefined;
    return {
      id: loaded.manifest.id,
      pluginType: loaded.manifest.pluginType,
      displayName: loaded.manifest.displayName,
      version: loaded.manifest.version,
      runtimeIds: loaded.manifest.runtimeIds,
      generationId: loaded.generationId,
      enabled: true,
    };
  }

  return {
    loadAll,
    load,
    reload,
    unload,
    enable,
    disable,
    list: listPlugins,
    get: getPlugin,
    registries: regs,
  };
}
