/**
 * The local model relay: on a shared server, a provider endpoint on the
 * player's own computer or local network (`http://127.0.0.1:…`,
 * `https://192.168.1.20/…`, `http://gateway.local/…`) is reached through the
 * player's browser instead of the server's network.
 *
 * The host supplies a {@link ProviderRelay} per request (`GatewayOptions.relay`);
 * the gateway copies it into each `ProviderConfig`. `postJson` and `getJson`
 * hand a request for such an endpoint to the relay, which returns an ordinary
 * `Response` whose body streams as the browser reads the local server. Public
 * endpoints never go through the relay: the server reaches them itself, under
 * the shared host's network rules.
 */

import { isLocalNetworkBaseUrl } from "@covel/shared";

/** One HTTP request the browser makes for the server. */
export interface ProviderRelayRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** The serialized JSON body of a POST. */
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface ProviderRelay {
  fetch(request: ProviderRelayRequest): Promise<Response>;
}

/**
 * True for an endpoint the relay may carry: one on the player's computer or
 * local network (`isLocalNetworkBaseUrl` in `@covel/shared`).
 */
export function isRelayableBaseUrl(baseUrl: string | undefined): boolean {
  return isLocalNetworkBaseUrl(baseUrl);
}
