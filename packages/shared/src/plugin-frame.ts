/**
 * The document that hosts plugin HTML (`webview` panels). It is a static file
 * of the web build, loaded by URL into a sandboxed frame, so it runs under the
 * policy below instead of inheriting the main page's: a `srcdoc` or `blob:`
 * frame takes its embedder's policy, a document loaded from a URL has its own.
 */
export const PLUGIN_FRAME_PATH = "/plugin-frame.html";

/**
 * Policy of the frame document, carried by its `<meta>` and inherited by the
 * `srcdoc` frame it creates for the plugin's HTML. Inline script and style are
 * the plugin's code; nothing loads from the network and the plugin document
 * cannot be navigated to a network address (`frame-src 'none'`).
 */
export const PLUGIN_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "frame-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The same policy as a response header, plus what a `<meta>` cannot express:
 * the document is an opaque origin even when opened outside the app's frame,
 * and only the app's own origin may frame it.
 */
export const PLUGIN_FRAME_RESPONSE_CSP = `${PLUGIN_FRAME_CSP}; sandbox allow-scripts; frame-ancestors 'self'`;
