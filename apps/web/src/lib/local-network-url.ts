import { isLocalNetworkBaseUrl, isLoopbackHostUrl } from "@covel/shared";

/**
 * What a player should know about a model endpoint on a shared server:
 *
 * - `relay`: on their computer or local network; this browser carries the
 *   requests (the local model relay), so the page must stay open and the
 *   model server must allow this site through CORS.
 * - `lan-http`: a plain-http address on the local network, which browsers do
 *   not let an HTTPS page reach.
 * - `needs-https`: a public address over plain http, which the server does
 *   not call.
 *
 * A hint for the settings page, not a security check: the server and the
 * relay apply their own rules.
 */
export type SharedServerEndpointNote = "relay" | "lan-http" | "needs-https";

export function sharedServerEndpointNote(
  baseUrl: string | undefined,
  relaySupported: boolean,
): SharedServerEndpointNote | undefined {
  const text = baseUrl?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (isLocalNetworkBaseUrl(url.href)) {
    if (!relaySupported) return "needs-https";
    return url.protocol === "http:" && !isLoopbackHostUrl(url)
      ? "lan-http"
      : "relay";
  }
  return url.protocol === "https:" ? undefined : "needs-https";
}
