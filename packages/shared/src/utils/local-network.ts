/**
 * Endpoints on the player's own computer or local network: the ones a shared
 * server cannot reach and the player's browser can (the local model relay).
 */

/** Names that only a resolver on the player's network can answer. */
const LOCAL_NAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".lan",
  ".internal",
  ".home.arpa",
];

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isLocalIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Shared address space: carrier-grade NAT and overlays such as Tailscale.
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isLocalIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  // ::1, unique local fc00::/7 and link-local fe80::/10.
  return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * True for an `http(s)` endpoint on the player's computer or local network:
 * a loopback or private address, or a name under a local-only suffix. An
 * endpoint with credentials in its URL is never one.
 */
export function isLocalNetworkBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = hostOf(url);
  return (
    host === "localhost" ||
    LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isLocalIPv4(host) ||
    isLocalIPv6(host)
  );
}

/** True when the URL names the computer itself: `localhost`, `127.0.0.1`, `::1`. */
export function isLoopbackHostUrl(url: string | URL): boolean {
  try {
    return LOOPBACK_NAMES.has(
      hostOf(typeof url === "string" ? new URL(url) : url),
    );
  } catch {
    return false;
  }
}
