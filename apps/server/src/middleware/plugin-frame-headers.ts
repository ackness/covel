import type { MiddlewareHandler } from "hono";
import { PLUGIN_FRAME_PATH, PLUGIN_FRAME_RESPONSE_CSP } from "@covel/shared";

/**
 * Response headers of the plugin frame host, the static document that runs
 * plugin HTML. The file carries its policy in a `<meta>` so a static host
 * serves it correctly too; this server adds what a `<meta>` cannot say: the
 * document is sandboxed into an opaque origin however it is opened (a direct
 * visit included), and only the app's own origin may frame it.
 *
 * The document is the same for every plugin and every session. Plugin HTML
 * reaches it through the app's message port, never through this URL, so the
 * path gives access to no plugin file.
 */
export function pluginFrameHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.path !== PLUGIN_FRAME_PATH) return;
    c.header("Content-Security-Policy", PLUGIN_FRAME_RESPONSE_CSP);
    c.header("Cache-Control", "no-cache");
  };
}
