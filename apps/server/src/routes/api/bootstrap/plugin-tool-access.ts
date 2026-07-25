import type { ParsedPluginMd } from "@covel/plugin-loader";

/**
 * Seed the per-plugin tool allowlist from manifest declarations — builtin
 * names only. Entry-registered names (`tools.plugin`) are added at successful
 * registration time (`registerTool` in plugin-entry.ts): granting them from
 * the declaration alone would let a plugin execute another plugin's same-named
 * tool through the global toolMap. A declared-but-unregistered name simply
 * fails to resolve for the declaring plugin.
 */
export function buildPluginToolAccess(
  manifestCache: ReadonlyMap<string, readonly ParsedPluginMd[]>,
): Map<string, Set<string>> {
  const pluginToolAccess = new Map<string, Set<string>>();
  for (const [pluginId, manifests] of manifestCache) {
    const allowed = new Set<string>();
    for (const parsed of manifests) {
      for (const t of parsed.manifest.tools?.builtin ?? []) allowed.add(t);
    }
    pluginToolAccess.set(pluginId, allowed);
  }
  return pluginToolAccess;
}
