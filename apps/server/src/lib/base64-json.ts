/**
 * Decode a base64-encoded JSON request header into an unknown value.
 * Returns `null` on a missing header or any decode/parse failure — callers
 * apply their own shape validation to the result.
 */
export function decodeBase64Json(header: string | undefined): unknown {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
