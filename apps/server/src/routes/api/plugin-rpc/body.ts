import type {
  PluginRpcActionRequest,
  PluginRpcRuntimeRequest,
} from "@covel/shared";

export type PluginRpcBody = Partial<PluginRpcActionRequest> &
  Partial<PluginRpcRuntimeRequest>;

/**
 * Decode the `X-Plugin-User-Settings` request header: base64(json) whose
 * body is `{ [pluginId]: { [settingKey]: value } }`.
 *
 * Malformed input is treated as "no settings" so a single corrupt client
 * request degrades to manifest defaults instead of failing a turn.
 */
export function decodePluginUserSettingsHeader(
  raw: string | undefined,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
  if (!raw) return undefined;
  try {
    const json = JSON.parse(
      Buffer.from(raw, "base64").toString("utf-8"),
    ) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json))
      return undefined;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [pluginId, bucket] of Object.entries(
      json as Record<string, unknown>,
    )) {
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket))
        continue;
      out[pluginId] = { ...(bucket as Record<string, unknown>) };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
