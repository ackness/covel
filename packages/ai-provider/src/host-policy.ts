/**
 * What the host this package runs in allows of provider traffic.
 *
 * The package reads no deployment variable itself: the host decides its
 * deployment form once at start and passes the result here, the same way it
 * passes the outbound proxy (`configureOutboundProxy`). Until a host calls
 * {@link configureProviderHostPolicy}, the policy is the personal one, which
 * is what the default `DEPLOYMENT_TIER=self` gives: tools and tests that run
 * on the player's own machine need no setup.
 */
export interface ProviderHostPolicy {
  /**
   * The server is the player's own machine, so a provider endpoint on
   * loopback (a local Ollama) or one whose name resolves to a private address
   * (a LAN server, a TUN proxy) is theirs. On a shared host those addresses
   * are the host's internal network and stay refused.
   */
  readonly localNetwork: boolean;
  /**
   * A wire that a community plugin registered may serve a request that
   * belongs to no session (a settings-page model test). On a personal host
   * the one player approved every loaded plugin; on a shared host another
   * player's approval must not serve the request.
   */
  readonly sessionlessCommunityWires: boolean;
}

/** The policy of a personal host: the desktop app, a self-hosted server, `pnpm dev`. */
export const PERSONAL_PROVIDER_HOST_POLICY: ProviderHostPolicy = Object.freeze({
  localNetwork: true,
  sessionlessCommunityWires: true,
});

let current: ProviderHostPolicy = PERSONAL_PROVIDER_HOST_POLICY;

/** Called once by the host at start, before any provider request. */
export function configureProviderHostPolicy(policy: ProviderHostPolicy): void {
  current = Object.freeze({ ...policy });
}

/** The policy in force. */
export function providerHostPolicy(): ProviderHostPolicy {
  return current;
}
