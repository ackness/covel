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

export const PLUGIN_ASSETS_PATH = "/plugin-assets";
export const PLUGIN_ASSET_DIGEST_PATTERN = /^[a-f0-9]{32}$/;
export const PLUGIN_ASSET_RESERVED_DIR = "__covel__";
export const PLUGIN_PAGE_READY_TIMEOUT_MS = 8000;

/** Encode each segment independently, including the package ID. */
export function pluginAssetUrl(
  pluginId: string,
  digest: string,
  relativePath: string,
): string {
  return `${PLUGIN_ASSETS_PATH}/${[pluginId, digest, ...relativePath.split("/")].map(encodeURIComponent).join("/")}`;
}

export const PLUGIN_ASSET_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "sandbox allow-scripts",
  "frame-ancestors 'self'",
].join("; ");

/** Small transport only; rendering, state interpretation and interactions belong to the plugin. */
export const PLUGIN_BRIDGE_SCRIPT = `
(() => {
  let port, state = {}, sequence = 0;
  const listeners = new Set(), pending = new Map();
  // The host's style scheme, as --covel-* custom properties on the document.
  const applyTheme = theme => {
    if (!theme || !theme.tokens) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.tokens))
      root.style.setProperty("--covel-" + name.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), String(value));
    root.style.colorScheme = theme.scheme;
    root.dataset.covelScheme = theme.scheme;
  };
  window.covel = Object.freeze({
    getState: () => state,
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    invoke(action, params = {}) {
      if (!port) return Promise.reject(new Error("Plugin UI is not connected"));
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Plugin UI action timed out")); }, 120000);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ type: "action", id, action, params });
      });
    }
  });
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "covel:connect" || !event.ports[0] || port) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === "state") {
        state = data.value;
        applyTheme(state.theme);
        for (const fn of listeners) fn(state);
      } else if (data?.type === "stream") {
        if (!state.session) return;
        state = { ...state, session: { ...state.session, streaming: {
          seq: data.seq, text: (state.session.streaming?.seq === data.seq ? state.session.streaming.text : "") + data.append
        } } };
        for (const fn of listeners) fn(state);
      } else if (data?.type === "result") {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id); clearTimeout(request.timer);
        data.error ? request.reject(new Error(data.error)) : request.resolve(data.value);
      }
    };
    port.start();
    port.postMessage({ type: "ready" });
  });
})();`;
