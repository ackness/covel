/**
 * Serializes logged console arguments for "no secret in the logs" checks.
 * `JSON.stringify` renders an `Error` as `{}`, so its message, stack, cause and
 * own enumerable properties are written out explicitly.
 */
export function serializeLogged(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, function replacer(_key, item: unknown) {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    if (item instanceof Error) {
      return {
        ...item,
        name: item.name,
        message: item.message,
        stack: item.stack,
        cause: item.cause,
      };
    }
    return item;
  });
}
