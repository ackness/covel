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
    plugins.set(pluginId, { ...plugin, enabled: true });
  }

  function disable(pluginId: string): void {
    const plugin = plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" not found.`);
    plugins.set(pluginId, { ...plugin, enabled: false });
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
   *
   * @param manifest - The plugin manifest to validate
   * @param allKnownIds - Optional set of all known plugin IDs (e.g. from a pre-scan).
   *   When provided, `requires` is checked against this set instead of just the
   *   already-loaded plugins, so that load order doesn't affect validation.
   * @param acceptedIds - Optional set of already-accepted plugin IDs for conflict
   *   checking. When provided, `conflicts` is checked against this set instead of
   *   `allKnownIds`, so that the first plugin by loadingOrder wins and later
   *   conflicting ones are skipped (rather than both being rejected).
   */
  function validateConstraints(
    manifest: PluginManifest,
    allKnownIds?: ReadonlySet<string>,
    acceptedIds?: ReadonlySet<string>,
  ): string[] {
    const errors: string[] = [];

    for (const req of manifest.requires ?? []) {
      const known = allKnownIds ? allKnownIds.has(req) : plugins.has(req);
      if (!known) {
        errors.push(`Missing required plugin: "${req}"`);
      }
    }

    // Check conflicts against accepted set (already loaded this pass) if provided,
    // falling back to allKnownIds, then to the loaded plugins map.
    const conflictSet = acceptedIds ?? allKnownIds;
    for (const conflict of manifest.conflicts ?? []) {
      const conflicted = conflictSet
        ? conflictSet.has(conflict)
        : plugins.has(conflict);
      if (conflicted) {
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
