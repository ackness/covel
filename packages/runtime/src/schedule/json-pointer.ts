/** RFC 6901 JSON Pointers over plain values. */

/** RFC 6901 unescape for a single reference token. */
export function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Resolve an RFC 6901 JSON Pointer against a value. Empty pointer = whole
 * document. `found: false` distinguishes an absent path from a present `null`.
 */
export function resolveJsonPointer(
  value: unknown,
  pointer: string,
): { readonly found: boolean; readonly value?: unknown } {
  if (pointer === "") return { found: true, value };
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer))
    return { found: false };
  const tokens = pointer.split("/").slice(1).map(unescapeToken);
  let cursor: unknown = value;
  for (const token of tokens) {
    if (cursor === null || typeof cursor !== "object") return { found: false };
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        return { found: false };
      }
      cursor = cursor[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cursor, token)) {
        return { found: false };
      }
      cursor = (cursor as Record<string, unknown>)[token];
    }
  }
  return { found: true, value: cursor };
}
