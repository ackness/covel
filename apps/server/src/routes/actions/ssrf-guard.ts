/**
 * Check if a hostname resolves to a private/internal network address.
 * Covers RFC 1918, RFC 6598 (CGNAT), link-local, loopback, and IPv6 equivalents.
 */
export function isPrivateHost(host: string): boolean {
  // Loopback and special addresses
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;
  // IPv6 private ranges
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  // IPv6 long-form loopback
  if (host === "0:0:0:0:0:0:0:1") return true;
  // IPv4 private ranges
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return true;
  // RFC 1918: 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (host.startsWith("172.")) {
    const parts = host.split(".");
    if (parts.length === 4) {
      const second = parseInt(parts[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
  }
  // RFC 6598 CGNAT: 100.64.0.0/10 (100.64.x.x – 100.127.x.x)
  if (host.startsWith("100.")) {
    const parts = host.split(".");
    if (parts.length === 4) {
      const second = parseInt(parts[1], 10);
      if (second >= 64 && second <= 127) return true;
    }
  }
  return false;
}
