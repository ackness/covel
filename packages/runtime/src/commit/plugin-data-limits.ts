/** Size limit on one plugin-data value, shared by every write path. */

/**
 * Largest JSON size (UTF-8 bytes) of one plugin-data value. A value is read
 * back whole by `io.selfData`, snapshots and list calls, so one oversized value
 * taxes every later turn. The largest seeded record in the bundled worlds is
 * about 7 KB; the cap leaves a wide margin for a plugin that keeps a growing
 * list under one key, and still stops a megabyte-per-turn write.
 */
export const MAX_PLUGIN_DATA_VALUE_BYTES = 256 * 1024;

/** The author-facing error for an oversized value, or undefined when it fits. */
export function pluginDataSizeError(
  pluginId: string,
  namespace: string,
  key: string,
  value: unknown,
): string | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  if (bytes <= MAX_PLUGIN_DATA_VALUE_BYTES) return undefined;
  return (
    `plugin "${pluginId}" wrote ${bytes} bytes under ${namespace}/${key}, ` +
    `over the ${MAX_PLUGIN_DATA_VALUE_BYTES}-byte limit for one value; ` +
    `split it across keys or keep only what a later turn reads`
  );
}
