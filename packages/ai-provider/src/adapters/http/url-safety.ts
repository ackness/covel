const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const BLOCKED_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^fc00:/i,
  /^fe80:/i,
];

const BLOCKED_HOSTNAMES = ["metadata.google.internal", "metadata.internal"];
const TRAILING_VERSION_RE = /\/(v\d[a-z0-9]*)$/i;

function isDomainAllowed(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (BLOCKED_HOSTNAMES.includes(hostname)) return false;
  return !BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(hostname));
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
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
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
