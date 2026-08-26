/**
 * Limits for the request-scoped `X-Plugin-User-Settings` header.
 *
 * These values deliberately live in shared so browser preflight and server
 * enforcement cannot drift. This module only uses Web Platform APIs and is
 * therefore safe to import from browser bundles.
 */
export const PLUGIN_USER_SETTINGS_HEADER_MAX_BYTES = 8 * 1024;
export const PLUGIN_USER_SETTINGS_HEADER_MAX_BUCKETS = 64;
export const PLUGIN_USER_SETTINGS_HEADER_MAX_KEYS_PER_BUCKET = 64;
export const PLUGIN_USER_SETTINGS_HEADER_MAX_IDENTIFIER_BYTES = 128;

export const PLUGIN_USER_SETTINGS_HEADER_TOO_LARGE_CODE =
  "plugin_user_settings_header_too_large";

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
