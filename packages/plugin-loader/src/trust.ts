/**
 * Plugin trust classification.
 *
 * Trust is derived from where the plugin was loaded, not from its name. The
 * load-path-based `source` (set by the bootstrap layer when scanning `plugins/`
 * vs `~/.covel/plugins/`) is non-forgeable; the `name` field is author-controlled
 * and therefore not a security boundary.
 */

import type { PluginSource, PluginTrustInfo } from "./types.js";

/**
 * Reserved IDs for plugins shipped under `plugins/`. Third-party plugins
 * (loaded from `~/.covel/plugins/`) must not declare these names — the
 * install endpoint rejects them in `validatePluginBundle()` so a community
 * plugin can never shadow a builtin's `plugin_data` namespace.
 *
 * Keep this list in sync with the directory contents under `plugins/`.
 */
export const BUILTIN_PLUGIN_IDS = new Set<string>([
  "narrator",
  "pregame",
  "memory",
  "codex",
  "guide",
  "char-creator",
  "world-init",
  "npc-graph",
]);

/** Officially blessed but not shipped with the framework — empty for now. */
const OFFICIAL_IDS = new Set<string>([]);

/**
 * Determine trust level for a plugin.
 *
 * - builtin: shipped under `plugins/` (auto-load, no approval)
 * - official: whitelisted (auto-load, no approval)
 * - community: everything else (requires user confirmation, tools need approval)
 *
 * The caller should always pass an explicit `source` derived from the load
 * path; the no-source fallback only treats `OFFICIAL_IDS` as official and
 * everything else as community — it deliberately does NOT infer `builtin`
 * from the name, since names are author-controlled.
 */
export function getPluginTrustInfo(
  pluginId: string,
  source?: PluginSource,
): PluginTrustInfo {
  const resolvedSource = source ?? detectSource(pluginId);

  switch (resolvedSource) {
    case "builtin":
    case "official":
      return {
        source: resolvedSource,
        autoLoad: true,
        requiresApproval: false,
      };
    case "community":
      return {
        source: "community",
        autoLoad: false,
        requiresApproval: true,
      };
  }
}

function detectSource(pluginId: string): PluginSource {
  if (OFFICIAL_IDS.has(pluginId)) {
    return "official";
  }
  return "community";
}
