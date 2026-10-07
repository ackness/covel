/** Return true only for globally routable IPv4/IPv6 unicast addresses. */
export function isPublicIpAddress(rawAddress: string): boolean {
  const address = normalizeHost(rawAddress);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return isPublicIpv4(address);
  if (!address.includes(":")) return false;

  const bytes = parseIpv6(address);
  if (!bytes) return false;

  // IPv4-mapped IPv6 reaches the embedded IPv4 destination.
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return isPublicIpv4(bytes.slice(12).join("."));
  }

  // Global unicast allocation alone does not establish public reachability:
  // IETF protocol assignments, documentation and transition addresses also
  // occupy 2000::/3. Keep globally reachable specific IETF allocations, while
  // rejecting reserved/benchmark space and Teredo/6to4 embedded destinations.
  if ((bytes[0]! & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4 /16
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2]! & 0xfe) === 0) {
    const publicProtocolAllocation =
      bytes[2] === 0 &&
      (bytes[3] === 3 || // AMT /32
        (bytes[3] === 4 && bytes[4] === 1 && bytes[5] === 0x12) || // AS112 /48
        (bytes[3]! >= 0x20 && bytes[3]! <= 0x3f) || // ORCHIDv2 and DET /28
        (bytes[3] === 1 &&
          bytes.slice(4, 15).every((byte) => byte === 0) &&
          bytes[15]! >= 1 &&
          bytes[15]! <= 3)); // IETF anycast
    return publicProtocolAllocation;
  }
  const isDocumentation =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;
  const isAdditionalDocumentation =
    bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2]! & 0xf0) === 0;
  return !isDocumentation && !isAdditionalDocumentation;
}

function isPublicIpv4(address: string): boolean {
  const bytes = address.split(".").map(Number);
  if (
    bytes.length !== 4 ||
    bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    return false;
  }
  const [a, b, c] = bytes as [number, number, number, number];

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function parseIpv6(address: string): Uint8Array | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Words(halves[0] ?? "");
  const right = parseIpv6Words(halves[1] ?? "");
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array<number>(missing).fill(0), ...right];
  if (words.length !== 8) return null;

  return Uint8Array.from(words.flatMap((word) => [word >> 8, word & 0xff]));
}

function parseIpv6Words(part: string): number[] | null {
  if (!part) return [];
  const words = part.split(":");
  const parsed = words.map((word) => Number.parseInt(word, 16));
  return parsed.some(
    (word, index) =>
      !/^[0-9a-f]{1,4}$/i.test(words[index]!) ||
      !Number.isInteger(word) ||
      word < 0 ||
      word > 0xffff,
  )
    ? null
    : parsed;
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}
