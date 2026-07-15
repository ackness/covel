import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Resolve one request target, reject every non-public answer, and return a
 * dispatcher whose socket lookup is pinned to those exact answers. Resolving
 * before creating the dispatcher makes the policy easy to audit; overriding
 * the connector lookup closes the validation-to-connect DNS-rebinding gap.
 */
export async function createPinnedDispatcher(url: URL): Promise<Agent> {
  const addresses = await resolveAllowedAddresses(url.hostname);

  let nextAddress = 0;
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options.all) {
          callback(null, [...addresses]);
          return;
        }
        const selected = addresses[nextAddress++ % addresses.length]!;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

/**
 * Lazy variant for the core provider HTTP path (`adapters/http/request.ts`):
 * instead of resolving up front, the returned dispatcher runs the same
 * resolve-and-validate policy inside the connector's lookup. Validation thus
 * happens at connect time on the exact addresses the socket will use (no
 * validate-to-connect DNS-rebinding gap), keep-alive reuse stays cheap, and
 * a mocked `fetch` in tests never triggers real DNS.
 */
export function createConnectPinnedDispatcher(): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        resolveAllowedAddresses(hostname).then(
          (addresses) => {
            if (options.all) {
              callback(null, [...addresses]);
              return;
            }
            const first = addresses[0]!;
            callback(null, first.address, first.family);
          },
          (error: unknown) => {
            callback(
              error instanceof Error ? error : new Error(String(error)),
              "",
              4,
            );
          },
        );
      },
    },
  });
}

/**
 * Resolve a hostname (or accept an IP literal) and enforce the SSRF policy
 * on every answer: loopback hostnames must resolve to loopback addresses,
 * anything else must resolve to publicly routable addresses only.
 */
async function resolveAllowedAddresses(
  rawHostname: string,
): Promise<readonly ResolvedAddress[]> {
  const hostname = normalizeHost(rawHostname);
  const literalFamily = isIP(hostname);
  let addresses: readonly ResolvedAddress[];

  if (literalFamily !== 0) {
    addresses = [toResolvedAddress(hostname, literalFamily)];
  } else {
    addresses = (await lookup(hostname, { all: true, verbatim: true })).map(
      ({ address, family }) => toResolvedAddress(address, family),
    );
  }

  if (addresses.length === 0) {
    throw new Error(
      `SSRF policy rejected ${hostname}: DNS returned no addresses`,
    );
  }

  const allowLoopback = LOOPBACK_HOSTNAMES.has(hostname);
  for (const result of addresses) {
    const allowed = allowLoopback
      ? isLoopbackIpAddress(result.address)
      : isPublicIpAddress(result.address);
    if (!allowed) {
      throw new Error(
        `SSRF policy rejected ${hostname}: DNS resolved to disallowed address ${result.address}`,
      );
    }
  }

  return addresses;
}

function isLoopbackIpAddress(rawAddress: string): boolean {
  const address = normalizeHost(rawAddress);
  if (isIP(address) === 4) return address.startsWith("127.");
  if (isIP(address) !== 6) return false;
  const bytes = parseIpv6(address);
  if (!bytes) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return true;
  }
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff &&
    bytes[12] === 127
  );
}

function toResolvedAddress(address: string, family: number): ResolvedAddress {
  if (family !== 4 && family !== 6) {
    throw new Error(`SSRF policy rejected DNS address with family ${family}`);
  }
  return { address, family };
}

/** Return true only for globally routable IPv4/IPv6 unicast addresses. */
export function isPublicIpAddress(rawAddress: string): boolean {
  const address = normalizeHost(rawAddress);
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

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

  // Public IPv6 unicast is currently allocated from 2000::/3. This rejects
  // loopback, unspecified, ULA, link-local, multicast and transition prefixes
  // (including ones that can embed private IPv4). Reject the documentation
  // prefix separately because it sits inside 2000::/3.
  const isDocumentation =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;
  return (bytes[0]! & 0xe0) === 0x20 && !isDocumentation;
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

function parseIpv6(address: string): Uint8Array | null {
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
