import type { PluginManifest } from "@covel/shared";
import type { LoadedPlugin } from "../types.js";

/**
 * Manage loaded plugins: add, remove, enable, disable, query.
 */
export function createPluginRegistry() {
  const plugins = new Map<string, LoadedPlugin>();

  function add(manifest: PluginManifest, dir: string): LoadedPlugin {
    if (plugins.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already registered.`);
    }
    const loaded: LoadedPlugin = { manifest, dir, enabled: true };
    plugins.set(manifest.id, loaded);
    return loaded;
  }

  function remove(pluginId: string): boolean {
    return plugins.delete(pluginId);
  }

  function get(pluginId: string): LoadedPlugin | undefined {
    return plugins.get(pluginId);
  }

  function enable(pluginId: string): void {
    const plugin = plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found.`);
    plugin.enabled = true;
  }

  function disable(pluginId: string): void {
    const plugin = plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found.`);
    plugin.enabled = false;
  }

  function list(): LoadedPlugin[] {
    return Array.from(plugins.values());
  }

  function listEnabled(): LoadedPlugin[] {
    return Array.from(plugins.values()).filter((p) => p.enabled);
  }

  function has(pluginId: string): boolean {
    return plugins.has(pluginId);
  }

  /**
   * Check dependency and conflict constraints.
   * Returns an array of error messages (empty if valid).
   */
  function validateConstraints(manifest: PluginManifest): string[] {
    const errors: string[] = [];

    for (const req of manifest.requires ?? []) {
      if (!plugins.has(req)) {
        errors.push(`Missing required plugin: "${req}"`);
      }
    }

    for (const conflict of manifest.conflicts ?? []) {
      if (plugins.has(conflict)) {
        errors.push(`Conflicts with loaded plugin: "${conflict}"`);
      }
    }

    return errors;
  }

  return {
    add,
    remove,
    get,
    enable,
    disable,
    list,
    listEnabled,
    has,
    validateConstraints,
  };
}

export type PluginRegistry = ReturnType<typeof createPluginRegistry>;
