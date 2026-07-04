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
 * Derive the set of reserved plugin IDs from an already-discovered plugin
 * collection. The reserved set is exactly the bundled plugins — those the
 * loader tagged `source: 'builtin'` because they were discovered in the
 * first (shipped `plugins/`) directory passed to `discoverPluginsMulti`.
 *
 * Third-party plugins (loaded from `~/.covel/plugins/`) must not declare one
 * of these names — the install endpoint rejects them in
 * `validatePluginBundle()` so a community plugin can never shadow a builtin's
 * `plugin_data` namespace.
 *
 * Why derive instead of hand-maintaining a constant array:
 *  - It stays in lock-step with the directory contents under `plugins/`
 *    automatically — adding/removing a bundled plugin needs no edit here, so
 *    the reservation list can never silently drift out of sync.
 *  - It honours the framework↔plugin isolation rule: no concrete plugin ID is
 *    hardcoded in framework control flow. The IDs are *data* read from the
 *    discovered plugin set.
 *  - It survives repackaging: discovery resolves the real plugins directory at
 *    boot, so this function never depends on a fixed on-disk path. The caller
 *    (server bootstrap) computes the set once from the live discovery result
 *    and injects it where the install route can consume it.
 */
export function deriveBuiltinPluginIds(
  discovered: Iterable<{
    readonly id: string;
    readonly source?: PluginSource;
  }>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of discovered) {
    if (entry.source === "builtin") {
      ids.add(entry.id);
    }
  }
  return ids;
}

/**
 * Determine trust level for a plugin.
 *
 * - builtin: shipped under `plugins/` (auto-load, no approval)
 * - official: whitelisted (auto-load, no approval)
 * - community: everything else (requires user confirmation, tools need approval)
 *
 * The caller should always pass an explicit `source` derived from the load
 * path; the no-source fallback treats everything as community — it deliberately
 * does NOT infer `builtin` from the name, since names are author-controlled.
 */
export function getPluginTrustInfo(
  _pluginId: string,
  source?: PluginSource,
): PluginTrustInfo {
  const resolvedSource = source ?? detectSource();

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

function detectSource(): PluginSource {
  // ponytail: no official plugins yet; reintroduce a whitelist when the first one ships
  return "community";
}
