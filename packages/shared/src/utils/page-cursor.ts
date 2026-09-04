import type { TimeCursor } from "../types/protocol.js";

const CURSOR_VERSION = 1;

/** Encode an internal keyset position as an opaque, versioned API cursor. */
export function encodePageCursor(cursor: TimeCursor): string {
  const json = JSON.stringify({
    v: CURSOR_VERSION,
    createdAt: cursor.createdAt,
    id: cursor.id,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/** Decode an API cursor. Invalid or unsupported cursors return `null`. */
export function decodePageCursor(value: string): TimeCursor | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("v" in parsed) ||
      parsed.v !== CURSOR_VERSION ||
      !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      parsed.createdAt.length === 0 ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}
