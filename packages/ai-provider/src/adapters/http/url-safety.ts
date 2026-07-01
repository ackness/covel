const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const BLOCKED_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^f[cd][0-9a-f]{2}:/i, // fc00::/7 unique-local (fc00–fdff)
  /^fe[89ab][0-9a-f]:/i, // fe80::/10 link-local (fe80–febf)
];

const BLOCKED_HOSTNAMES = ["metadata.google.internal", "metadata.internal"];
const TRAILING_VERSION_RE = /\/(v\d[a-z0-9]*)$/i;

/**
 * Canonicalise `URL.hostname` for the IP blocklist: URL wraps IPv6 literals in
 * brackets (`[fc00::1]`), which defeated the anchored IPv6 patterns. Strip the
 * brackets and lower-case so the checks see the real address.
 */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

/**
 * Extract the embedded dotted IPv4 from an IPv4-mapped IPv6 host so the IPv4
 * blocklist applies to it. Handles both the textual form (`::ffff:10.0.0.1`)
 * and Node's hex-collapsed canonical form (`::ffff:a00:1`). Without this, e.g.
 * `https://[::ffff:169.254.169.254]` reached cloud metadata unblocked, since
 * Node routes IPv4-mapped IPv6 to the real IPv4 target. Returns null when the
 * host is not IPv4-mapped.
 */
function ipv4FromMappedV6(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1]!;
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

function isDomainAllowed(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOSTNAMES.includes(host)) return false;
  // An IPv4-mapped IPv6 address reaches the same IPv4 target — check the v4.
  const target = ipv4FromMappedV6(host) ?? host;
  return !BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(target));
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
