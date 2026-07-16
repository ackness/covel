/**
 * Pure origin-trust helpers shared by the main-frame navigation guard
 * (windows.ts) and the sensitive-IPC guard (ipc-handlers.ts). Kept free of any
 * Electron import so the security branch stays unit-testable
 * (see trusted-origin.selfcheck.ts).
 *
 * The app only ever runs on a loopback http origin: the local sidecar
 * (http://127.0.0.1:<port>) in production, the Vite dev server
 * (http://localhost:5173) in dev. Anything else reaching a main-frame
 * navigation or a key/secret IPC is an XSS / redirect pivot that could then
 * call `covelIpc` and read raw provider keys — it must be refused (H-09).
 */

/** Return the origin iff `rawUrl` parses to a loopback **http** URL, else null. */
export function loopbackHttpOrigin(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  // URL.hostname keeps the brackets for IPv6 literals (e.g. "[::1]").
  const host = parsed.hostname;
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  return isLoopback ? parsed.origin : null;
}

/**
 * True iff `candidateUrl` shares the exact loopback-http origin of `trustedUrl`
 * (the main window's committed page). Fail-closed: a data:/file:/https or
 * cross-origin candidate — or a non-loopback trusted page (e.g. the data: URL
 * splash) — returns false.
 */
export function isSameTrustedOrigin(
  trustedUrl: string | null | undefined,
  candidateUrl: string | null | undefined,
): boolean {
  const trusted = loopbackHttpOrigin(trustedUrl);
  if (!trusted) return false;
  return loopbackHttpOrigin(candidateUrl) === trusted;
}
