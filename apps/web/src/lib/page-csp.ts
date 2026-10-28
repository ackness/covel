/**
 * Content-Security-Policy of the built main page, delivered as a `<meta>` so
 * the server, the desktop shell and a static host all serve the same page
 * policy. Development relaxes script/connect sources for Vite hot reload,
 * while retaining the same CSS resource restrictions.
 *
 * - `script-src` is the app's own files only: no inline script, no `eval`, no
 *   remote script. The built page has no inline script of its own, and plugin
 *   HTML runs in a frame document with a separate policy (`frame-src` below).
 * - `frame-src` is the app's own origin: the only frame the app creates is the
 *   plugin frame host (`public/plugin-frame.html`), a sandboxed opaque origin.
 * - Theme CSS is untrusted: images/fonts/styles cannot use remote origins.
 * - HTTPS connect is for explicit image imports by application JavaScript;
 *   CSS resource loads use img-src/font-src/style-src, never connect-src.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  // Equal to PAGE_CONNECT_SOURCES in @covel/shared (a test keeps them equal;
  // the Vite config loads this file, so it imports no workspace package). A
  // shared server adds plain http to this computer for the local model relay
  // when it serves the page (withLocalModelRelayConnect).
  "connect-src 'self' blob: data: https:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Put the policy first in `<head>`: a meta policy only governs what follows. */
export function injectPageCsp(html: string, development = false): string {
  const policy = development
    ? PAGE_CSP.replace(
        "script-src 'self'",
        "script-src 'self' 'unsafe-inline'",
      ).replace("connect-src 'self'", "connect-src ws: wss: 'self'")
    : PAGE_CSP;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
  return html.replace(/<head>/i, (head) => `${head}\n    ${meta}`);
}
