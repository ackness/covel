import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { readRuntimeEnv } from "@covel/shared";
import { isPublicIpAddress, parseIpv6 } from "./ip-safety.js";
export { isPublicIpAddress } from "./ip-safety.js";

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Whether a resolver answer in a private/benchmark range may be accepted.
 *
 * True only for the CORE PROVIDER path (`trustedProviderPath` — the user's own
 * configured LLM baseUrl via postJson/getJson) on the `self` tier
 * (desktop / self-deploy, the default when DEPLOYMENT_TIER is unset — already
 * loopback-bound with owner/operator tokens as no-ops). There, DNS-answer
 * filtering does more harm than good: local TUN proxies (Clash / mihomo /
 * sing-box / Surge) map every hostname into a private/benchmark range and
 * route by SNI, and a LAN Ollama endpoint legitimately resolves to
 * 192.168.x.x — both were wrongly rejected as "SSRF". The socket is still
 * pinned to the exact answer, preserving the anti-rebinding guarantee.
 *
 * NEVER granted to:
 *  - the plugin `fetchWithRetry` path (`trustedProviderPath: false`) — third-party
 *    plugin code must not reach internal services even on a local machine;
 *  - IP-LITERAL URLs — a raw `https://10.0.0.1` stays subject to the
 *    public-only rule (url-safety's string check also blocks it upstream);
 *  - hosted tiers (demo / commercial) — they may run inside a cloud network
 *    where private answers reach real internal services.
 */
function allowResolvedPrivateAddresses(
  isLiteral: boolean,
  trustedProviderPath: boolean,
): boolean {
  return (
    trustedProviderPath &&
    !isLiteral &&
    readRuntimeEnv().deploymentTier === "self"
  );
}

/**
 * Resolve one request target, reject every non-public answer, and return a
 * dispatcher whose socket lookup is pinned to those exact answers. Resolving
 * before creating the dispatcher makes the policy easy to audit; overriding
 * the connector lookup closes the validation-to-connect DNS-rebinding gap.
 */
export async function createPinnedDispatcher(
  url: URL,
  trustedProviderPath = false,
): Promise<Agent> {
  const addresses = await resolveAllowedAddresses(
    url.hostname,
    trustedProviderPath,
  );

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
        // Core provider path — the user's own configured baseUrl.
        resolveAllowedAddresses(hostname, true).then(
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
  trustedProviderPath = false,
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

  // Core provider path on the self tier: accept any resolver answer (see the
  // helper's rationale) — local proxies and LAN endpoints resolve to private
  // ranges, and the socket stays pinned to these exact addresses regardless.
  if (allowResolvedPrivateAddresses(literalFamily !== 0, trustedProviderPath)) {
    return addresses;
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

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}
