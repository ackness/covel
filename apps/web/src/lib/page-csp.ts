/**
 * Content-Security-Policy of the built main page, delivered as a `<meta>` so
 * the server, the desktop shell and a static host all serve the same page
 * policy. The dev server does not get it: Vite injects inline scripts and a
 * websocket for hot reload.
 *
 * - `script-src` keeps `'unsafe-inline'` because plugin webviews are `srcdoc`
 *   frames, which inherit this policy, and their own inline bridge script
 *   would otherwise not run. Remote scripts and `eval` stay blocked.
 * - `style-src` / `font-src` allow https because an imported theme's own CSS
 *   may load remote stylesheets and fonts (documented in docs/guide/themes.md).
 * - `connect-src` is the app's own origin: every API call and the SSE stream
 *   are same-origin, and media is fetched through signed same-origin URLs.
 * - `img-src` is deliberately absent. Images the player allowed on a host must
 *   load, which a static list cannot express; the Markdown renderer holds back
 *   images on other origins instead (`lib/external-images.ts`).
 */
export const PAGE_CSP = [
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Put the policy first in `<head>`: a meta policy only governs what follows. */
export function injectPageCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}" />`;
  return html.replace(/<head>/i, (head) => `${head}\n    ${meta}`);
}
