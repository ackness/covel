/**
 * The `connect-src` sources of the web app's main page, shared by the web
 * build (which writes the policy into the page) and the server (which widens
 * it for the local model relay).
 *
 * The built page connects to its own origin and to HTTPS only. A shared
 * server, where the player's browser relays requests to a model on their own
 * computer, adds plain http to this computer when it serves the page
 * ({@link withLocalModelRelayConnect}). A personal server and the desktop app
 * serve the page unchanged.
 */
export const PAGE_CONNECT_SOURCES = "'self' blob: data: https:";

/** What the local model relay adds: plain http to this computer only. */
export const LOCAL_MODEL_RELAY_CONNECT_SOURCES =
  "http://127.0.0.1:* http://localhost:*";

/**
 * The page with the local model relay's sources added to its `connect-src`.
 * Only the main page's exact directive is changed; any other document (the
 * plugin frame's `connect-src 'none'`) is returned as it was.
 */
export function withLocalModelRelayConnect(html: string): string {
  const directive = `connect-src ${PAGE_CONNECT_SOURCES};`;
  const index = html.indexOf(directive);
  if (index < 0) return html;
  return (
    html.slice(0, index) +
    `connect-src ${PAGE_CONNECT_SOURCES} ${LOCAL_MODEL_RELAY_CONNECT_SOURCES};` +
    html.slice(index + directive.length)
  );
}
