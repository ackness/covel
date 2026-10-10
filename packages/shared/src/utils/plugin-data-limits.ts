/** Size limit on one plugin-data value, shared by every write path. */

/**
 * Largest JSON size (UTF-8 bytes) of one plugin-data value. A value is read
 * back whole by `io.selfData`, snapshots and list calls, so one oversized value
 * taxes every later turn. The largest seeded record in the bundled worlds is
 * about 7 KB; the cap leaves a wide margin for a plugin that keeps a growing
 * list under one key, and still stops a megabyte-per-turn write.
 */
export const MAX_PLUGIN_DATA_VALUE_BYTES = 256 * 1024;

/** UTF-8 size of a value's JSON form, the quantity the limit applies to. */
export function pluginDataSizeBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

/** The author-facing error for an oversized value, or undefined when it fits. */
export function pluginDataSizeError(
  pluginId: string,
  namespace: string,
  key: string,
  value: unknown,
): string | undefined {
  const bytes = pluginDataSizeBytes(value);
  if (bytes <= MAX_PLUGIN_DATA_VALUE_BYTES) return undefined;
  return (
    `plugin "${pluginId}" wrote ${bytes} bytes under ${namespace}/${key}, ` +
    `over the ${MAX_PLUGIN_DATA_VALUE_BYTES}-byte limit for one value; ` +
    `split it across keys or keep only what a later turn reads`
  );
}

/**
 * The same refusal written for a model that called a write tool: what it
 * sent, the limit, and what to do, so that the next call can succeed.
 */
export function pluginDataToolSizeError(
  namespace: string,
  key: string,
  value: unknown,
): string | undefined {
  const bytes = pluginDataSizeBytes(value);
  if (bytes <= MAX_PLUGIN_DATA_VALUE_BYTES) return undefined;
  return (
    `The value for ${namespace}/${key} is ${bytes} bytes; the limit for one value is ` +
    `${MAX_PLUGIN_DATA_VALUE_BYTES} bytes. Nothing was written. Store less, or split it across several keys.`
  );
}
