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
import {
  PLUGIN_USER_SETTINGS_HEADER_MAX_BUCKETS,
  PLUGIN_USER_SETTINGS_HEADER_MAX_BYTES,
  PLUGIN_USER_SETTINGS_HEADER_MAX_IDENTIFIER_BYTES,
  PLUGIN_USER_SETTINGS_HEADER_MAX_KEYS_PER_BUCKET,
  PLUGIN_USER_SETTINGS_HEADER_TOO_LARGE_CODE,
  utf8ByteLength,
} from "@covel/shared/plugin-user-settings-header";
import { decodeBase64Json } from "../../lib/base64-json.js";

export type PluginUserSettingsHeaderDecodeResult =
  | {
      readonly ok: true;
      readonly settings: TurnInput["userSettings"] | undefined;
    }
  | {
      readonly ok: false;
      readonly status: 431;
      readonly code: typeof PLUGIN_USER_SETTINGS_HEADER_TOO_LARGE_CODE;
      readonly error: string;
    };

function headerLimitError(error: string): PluginUserSettingsHeaderDecodeResult {
  return {
    ok: false,
    status: 431,
    code: PLUGIN_USER_SETTINGS_HEADER_TOO_LARGE_CODE,
    error,
  };
}

/**
 * Decode the request-scoped player setting buckets.
 *
 * Missing and malformed legacy headers intentionally degrade to no overrides.
 * A header that is syntactically valid but exceeds any declared transport
 * budget is rejected so it cannot become a request-amplification vector.
 */
export function decodePluginUserSettingsHeader(
  raw: string | undefined,
): PluginUserSettingsHeaderDecodeResult {
  if (!raw) return { ok: true, settings: undefined };
  if (utf8ByteLength(raw) > PLUGIN_USER_SETTINGS_HEADER_MAX_BYTES) {
    return headerLimitError("X-Plugin-User-Settings exceeds 8 KiB");
  }

  const json = decodeBase64Json(raw);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: true, settings: undefined };
  }

  const buckets = Object.entries(json as Record<string, unknown>);
  if (buckets.length > PLUGIN_USER_SETTINGS_HEADER_MAX_BUCKETS) {
    return headerLimitError(
      "X-Plugin-User-Settings has too many plugin buckets",
    );
  }

  const out: Record<string, Record<string, unknown>> = {};
  for (const [pluginId, bucket] of buckets) {
    if (
      utf8ByteLength(pluginId) >
      PLUGIN_USER_SETTINGS_HEADER_MAX_IDENTIFIER_BYTES
    ) {
      return headerLimitError("X-Plugin-User-Settings plugin id is too long");
    }
    // Keep compatibility with the old decoder: malformed individual buckets
    // are ignored rather than turning an otherwise valid request into an error.
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket))
      continue;
    const entries = Object.entries(bucket as Record<string, unknown>);
    if (entries.length > PLUGIN_USER_SETTINGS_HEADER_MAX_KEYS_PER_BUCKET) {
      return headerLimitError(
        "X-Plugin-User-Settings bucket has too many keys",
      );
    }
    for (const [settingKey] of entries) {
      if (
        utf8ByteLength(settingKey) >
        PLUGIN_USER_SETTINGS_HEADER_MAX_IDENTIFIER_BYTES
      ) {
        return headerLimitError(
          "X-Plugin-User-Settings setting key is too long",
        );
      }
    }
    out[pluginId] = Object.fromEntries(entries);
  }
  return {
    ok: true,
    settings: Object.keys(out).length > 0 ? out : undefined,
  };
}

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
