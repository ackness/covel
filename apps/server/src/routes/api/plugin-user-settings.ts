/**
 * Plugin user-settings resolution at the turn boundary.
 *
 * The effective value for `plugin.<id>.<key>` is resolved in three layers:
 *
 *   player override (X-Plugin-User-Settings header) → world default
 *   (WorldRecord.metadata.pluginSettings) → manifest default (userSettings[].default)
 *
 * This module merges the first two into a `TurnInput["userSettings"]` bucket;
 * `resolveUserSettings` (in @covel/runtime) fills any still-missing declared
 * key from the manifest default. Wiring this on the main turn route is what
 * lets a player's UI-saved plugin settings and a world's authored defaults
 * actually reach the scheduled loop (agent `{{ userSettings.* }}`, guards, and
 * hooks all read `input.userSettings`).
 */
import type { TurnInput, WorldPluginSettings } from "@covel/shared";

/**
 * Read a world's authored plugin-setting defaults off its metadata blob.
 * Returns undefined when absent or malformed — `metadata` is a loose Record,
 * so only well-formed `pluginId → { settingKey: value }` shapes survive.
 */
export function readWorldPluginSettings(
  metadata: Record<string, unknown> | null | undefined,
): WorldPluginSettings | undefined {
  const raw = metadata?.pluginSettings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [pluginId, bucket] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket))
      continue;
    out[pluginId] = { ...(bucket as Record<string, unknown>) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge world-authored defaults under the player's per-session overrides, per
 * plugin and per key: the player value wins, the world default fills the rest.
 * Returns a `TurnInput["userSettings"]` bucket, or undefined when both inputs
 * are empty (so callers can omit the field rather than set an empty object).
 */
export function mergePluginUserSettings(
  worldDefaults: WorldPluginSettings | undefined,
  playerOverrides: TurnInput["userSettings"] | undefined,
): TurnInput["userSettings"] | undefined {
  if (!worldDefaults && !playerOverrides) return undefined;
  const pluginIds = new Set([
    ...Object.keys(worldDefaults ?? {}),
    ...Object.keys(playerOverrides ?? {}),
  ]);
  const out: Record<string, Record<string, unknown>> = {};
  for (const pluginId of pluginIds) {
    out[pluginId] = {
      ...worldDefaults?.[pluginId],
      ...playerOverrides?.[pluginId],
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
