import { isPublicIpAddress } from "./ip-safety.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const BLOCKED_HOSTNAMES = ["metadata.google.internal", "metadata.internal"];
// Google exposes its OpenAI-compatible wire below /v1beta/openai.
const TRAILING_VERSION_RE = /\/(v\d[a-z0-9]*)(?:\/openai)?$/i;

/**
 * Canonicalise `URL.hostname` for the IP blocklist: URL wraps IPv6 literals in
 * brackets (`[fc00::1]`), which defeated the anchored IPv6 patterns. Strip the
 * brackets and lower-case so the checks see the real address.
 */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isDomainAllowed(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOSTNAMES.includes(host)) return false;
  // Literal targets bypass socket DNS lookup, so enforce the full policy here.
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))
    return isPublicIpAddress(host);
  return true;
}

export function validateBaseUrl(url: string): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (
    parsed.protocol === "http:" &&
    !LOOPBACK_HOSTNAMES.has(normalizeHost(parsed.hostname))
  ) {
    return false;
  }

  return isDomainAllowed(parsed.hostname);
}

export function buildProviderUrl(baseUrl: string, path: string): string {
  if (
    baseUrl &&
    !baseUrl.startsWith("https://") &&
    !baseUrl.startsWith("http://localhost") &&
    !baseUrl.startsWith("http://127.0.0.1")
  ) {
    console.warn(
      `[ai-provider] Non-HTTPS base URL detected: ${baseUrl}. API keys may be sent in plaintext.`,
    );
  }

  let base = baseUrl.replace(/\/+$/, "");
  let p = path.startsWith("/") ? path : `/${path}`;

  if (p.startsWith("/api/")) {
    // Some providers publish a base URL that already includes `/api/vN`, while
    // their endpoint paths repeat the same prefix. Preserve arbitrary `/api/`
    // paths, but collapse an identical version prefix once.
    const apiVersionPrefix = p.match(/^\/api\/v\d[a-z0-9]*(?=\/|$)/i)?.[0];
    if (
      apiVersionPrefix &&
      base.toLowerCase().endsWith(apiVersionPrefix.toLowerCase())
    ) {
      return `${base}${p.slice(apiVersionPrefix.length)}`;
    }
    return `${base}${p}`;
  }

  const baseVersionMatch = base.match(TRAILING_VERSION_RE);
  const effectiveVersion = baseVersionMatch?.[1] ?? "v1";

  if (!baseVersionMatch) {
    base = `${base}/${effectiveVersion}`;
  }

  const pathVersionPrefix = `/${effectiveVersion}/`;
  if (p === `/${effectiveVersion}` || p.startsWith(pathVersionPrefix)) {
    p = p.slice(effectiveVersion.length + 1) || "/";
  }

  return `${base}${p}`;
}
