import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { resolveUserSettings } from "../turn-executor/turn-executor-helpers.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

/** Capture request/world overrides without merging runtime-specific defaults. */
export function snapshotUserSettings(
  settings: TurnInput["userSettings"],
): TurnInput["userSettings"] {
  return settings === undefined
    ? undefined
    : deepFreeze(structuredClone(settings));
}

/**
 * Build the operation-level per-plugin settings snapshot consumed by hooks.
 *
 * For each active runtime, resolves its `userSettings` (manifest defaults
 * merged with the player's saved values) and merges the result into the
 * owning plugin's bucket. Plugins without declared settings are omitted.
 * Buckets and the top-level map are deep-frozen so hooks can never mutate the
 * snapshot — including nested values. (Current `PluginUserSettingSpec` types
 * only yield scalars, but `spec.default` is typed `unknown`, so a plugin could
 * declare an object default; deep-freezing keeps the read-only contract honest
 * regardless.)
 */
export function buildHookSettings(
  activeRuntimes: readonly Pick<RuntimeManifest, "pluginId" | "userSettings">[],
  allUserSettings: TurnInput["userSettings"],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const buckets = new Map<string, Record<string, unknown>>();
  for (const manifest of activeRuntimes) {
    const resolved = resolveUserSettings(manifest, allUserSettings);
    if (!resolved) continue;
    const bucket = buckets.get(manifest.pluginId) ?? {};
    Object.assign(bucket, resolved);
    buckets.set(manifest.pluginId, bucket);
  }
  // Clone before freezing: manifest defaults and caller values remain owned by
  // their callers, and a later edit must not change this operation's snapshot.
  return deepFreeze(structuredClone(Object.fromEntries(buckets)));
}
