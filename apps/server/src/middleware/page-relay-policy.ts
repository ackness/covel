import type { MiddlewareHandler } from "hono";
import { withLocalModelRelayConnect } from "@covel/shared";

/**
 * On a shared host, serve the web app's page with the local model relay's
 * `connect-src` sources (plain http to the player's own computer) added to
 * its content policy. The built page leaves them out, so a personal server
 * and the desktop app keep the narrower policy.
 *
 * Only a full HTML answer is rewritten; the plugin frame's own policy has no
 * matching directive and stays as it was.
 */
export function localModelRelayPagePolicy(enabled: boolean): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!enabled || c.res.status !== 200) return;
    if (!(c.res.headers.get("content-type") ?? "").startsWith("text/html"))
      return;
    const html = await c.res.text();
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(withLocalModelRelayConnect(html), {
      status: 200,
      headers,
    });
  };
}
