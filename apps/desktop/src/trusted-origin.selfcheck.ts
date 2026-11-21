/**
 * Runnable self-check for the origin-trust boundary. No test framework —
 * `tsx src/trusted-origin.selfcheck.ts` throws on the first failing assertion.
 */
import assert from "node:assert/strict";
import {
  appUrlOnPort,
  isAllowedSessionPermission,
  isSameStartupSplashDocument,
  isSameTrustedOrigin,
  isTrustedIpcFrame,
  isTrustedRecoveryIpcFrame,
  loopbackHttpOrigin,
} from "./trusted-origin.js";

// loopbackHttpOrigin: only loopback http gets an origin back.
assert.equal(
  loopbackHttpOrigin("http://127.0.0.1:3001/session"),
  "http://127.0.0.1:3001",
);
assert.equal(
  loopbackHttpOrigin("http://localhost:5173/x"),
  "http://localhost:5173",
);
assert.equal(loopbackHttpOrigin("http://[::1]:80/"), "http://[::1]");
assert.equal(loopbackHttpOrigin("https://127.0.0.1:3001/"), null); // https not loopback-http
assert.equal(loopbackHttpOrigin("http://evil.com/"), null);
assert.equal(loopbackHttpOrigin("http://127.0.0.1.evil.example/"), null); // a name, not the address
assert.equal(loopbackHttpOrigin("http://127.evil.example/"), null);
assert.equal(loopbackHttpOrigin("http://169.254.169.254/"), null); // link-local metadata
assert.equal(loopbackHttpOrigin("data:text/html,x"), null);
assert.equal(loopbackHttpOrigin("file:///etc/passwd"), null);
assert.equal(loopbackHttpOrigin(undefined), null);
assert.equal(loopbackHttpOrigin("not a url"), null);

// isSameTrustedOrigin: same loopback app routes allowed; cross-origin and
// plugin-hosted document paths are refused.
const app = "http://127.0.0.1:3001/session";
for (const allowed of [
  "http://127.0.0.1:3001/",
  "http://127.0.0.1:3001/session/other",
  "http://127.0.0.1:3001/sessions/s-1",
  "http://127.0.0.1:3001/settings",
  "http://127.0.0.1:3001/plugin-assets-help",
]) {
  assert.equal(isSameTrustedOrigin(app, allowed), true, allowed);
}
for (const blocked of [
  "http://127.0.0.1:9999/", // different port
  "http://localhost:3001/", // different host
  "https://attacker.example/",
  "http://attacker.example/",
  "data:text/html,x",
  "http://127.0.0.1:3001/plugin-assets",
  "http://127.0.0.1:3001/plugin-assets/",
  "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
  "http://127.0.0.1:3001/plugin-frame.html",
  "http://127.0.0.1:3001/plugin-frame.html.",
  "http://127.0.0.1:3001/plugin-frame.html?v=1",
  "http://127.0.0.1:3001/PLUGIN-FRAME.HTML",
  "http://127.0.0.1:3001/Plugin-Assets/demo/0123456789abcdef0123456789abcdef/index.html",
  "http://127.0.0.1:3001//plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
  "http://127.0.0.1:3001/session/../plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
  "http://127.0.0.1:3001/%70lugin-frame.html",
  "http://127.0.0.1:3001/plugin-assets%2Fdemo/digest/index.html",
  "http://127.0.0.1:3001/%2fplugin-assets/demo/digest/index.html",
  "http://127.0.0.1:3001/session/%2e%2e/plugin-assets/demo/digest/index.html",
  "http://127.0.0.1:3001/%E0%A4%A",
]) {
  assert.equal(isSameTrustedOrigin(app, blocked), false, blocked);
}
// Fail-closed when the trusted page itself is not a trusted app document
// (e.g. the data: splash or a plugin-hosted page) — nothing is trusted.
assert.equal(isSameTrustedOrigin("data:text/html,splash", app), false);
assert.equal(
  isSameTrustedOrigin(
    "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
    app,
  ),
  false,
);
assert.equal(
  isSameTrustedOrigin("http://127.0.0.1:3001/plugin-frame.html", app),
  false,
);
assert.equal(isSameTrustedOrigin(undefined, app), false);

const splash = "data:text/html;charset=utf-8,%3Ch1%3ECovel%3C%2Fh1%3E";

// appUrlOnPort: a restarted sidecar keeps the page the window shows; only the
// port changes. Pages that are not the app (including plugin-hosted paths) open
// the start page.
assert.equal(
  appUrlOnPort("http://127.0.0.1:3001/session?sid=s-1&panel=plugins", 4002),
  "http://127.0.0.1:4002/session?sid=s-1&panel=plugins",
);
assert.equal(
  appUrlOnPort("http://127.0.0.1:3001/debug?sid=s-1#turn-3", 3001),
  "http://127.0.0.1:3001/debug?sid=s-1#turn-3",
);
assert.equal(appUrlOnPort(splash, 4002), "http://127.0.0.1:4002/session");
assert.equal(appUrlOnPort("", 4002), "http://127.0.0.1:4002/session");
assert.equal(appUrlOnPort(undefined, 4002), "http://127.0.0.1:4002/session");
assert.equal(
  appUrlOnPort(
    "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html",
    4002,
  ),
  "http://127.0.0.1:4002/session",
);
assert.equal(
  appUrlOnPort("http://127.0.0.1:3001/plugin-frame.html", 4002),
  "http://127.0.0.1:4002/session",
);
// Only the path is taken from the current page, never its host.
assert.equal(
  appUrlOnPort("https://attacker.example/session?sid=s-1", 4002),
  "http://127.0.0.1:4002/session",
);
assert.equal(isSameStartupSplashDocument(splash, splash), true);
assert.equal(
  isSameStartupSplashDocument(splash, `${splash}%3Cscript%3E`),
  false,
);
assert.equal(
  isSameStartupSplashDocument("data:text/html,x", "data:text/html,x"),
  false,
);
assert.equal(isSameStartupSplashDocument(app, app), false);

// isTrustedIpcFrame: requires main frame, trusted app path, matching loopback
// origin, and non-opaque frame.origin.
const appOrigin = "http://127.0.0.1:3001";
const pluginPageUrl =
  "http://127.0.0.1:3001/plugin-assets/demo/0123456789abcdef0123456789abcdef/index.html";
assert.equal(
  isTrustedIpcFrame(
    {
      isMainFrame: true,
      url: "http://127.0.0.1:3001/settings",
      origin: appOrigin,
    },
    app,
  ),
  true,
);
assert.equal(
  isTrustedIpcFrame(
    { isMainFrame: true, url: "http://127.0.0.1:3001/", origin: appOrigin },
    app,
  ),
  true,
);
assert.equal(
  isTrustedIpcFrame({ isMainFrame: false, url: app, origin: appOrigin }, app),
  false,
);
assert.equal(
  isTrustedIpcFrame({ isMainFrame: true, url: app, origin: "null" }, app),
  false,
);
assert.equal(
  isTrustedIpcFrame(
    { isMainFrame: true, url: pluginPageUrl, origin: "null" },
    app,
  ),
  false,
);
assert.equal(
  isTrustedIpcFrame(
    { isMainFrame: true, url: pluginPageUrl, origin: appOrigin },
    app,
  ),
  false,
);
assert.equal(
  isTrustedIpcFrame(
    {
      isMainFrame: true,
      url: "http://127.0.0.1:3001/plugin-frame.html",
      origin: appOrigin,
    },
    app,
  ),
  false,
);
assert.equal(
  isTrustedIpcFrame({ isMainFrame: true, url: app, origin: undefined }, app),
  false,
);
assert.equal(
  isTrustedIpcFrame(
    { isMainFrame: true, url: app, origin: "http://127.0.0.1:9999" },
    app,
  ),
  false,
);
assert.equal(
  isTrustedIpcFrame({ isMainFrame: true, url: splash, origin: "null" }, splash),
  false,
);

// isTrustedRecoveryIpcFrame: allows trusted app frame OR the committed main-frame
// splash data document (opaque origin), never sandboxed plugin frames.
assert.equal(
  isTrustedRecoveryIpcFrame(
    { isMainFrame: true, url: app, origin: appOrigin },
    app,
  ),
  true,
);
assert.equal(
  isTrustedRecoveryIpcFrame(
    { isMainFrame: true, url: splash, origin: "null" },
    splash,
  ),
  true,
);
assert.equal(
  isTrustedRecoveryIpcFrame(
    { isMainFrame: false, url: splash, origin: "null" },
    splash,
  ),
  false,
);
assert.equal(
  isTrustedRecoveryIpcFrame(
    { isMainFrame: true, url: splash, origin: appOrigin },
    splash,
  ),
  false,
);
assert.equal(
  isTrustedRecoveryIpcFrame(
    { isMainFrame: true, url: pluginPageUrl, origin: "null" },
    app,
  ),
  false,
);
assert.equal(
  isTrustedRecoveryIpcFrame(
    { isMainFrame: true, url: app, origin: "null" },
    app,
  ),
  false,
);

// isAllowedSessionPermission: deny by default; allow only clipboard-sanitized-write
// from the trusted main-frame app document.
assert.equal(
  isAllowedSessionPermission({
    permission: "clipboard-sanitized-write",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: `${appOrigin}/`,
    trustedUrl: app,
  }),
  true,
);
assert.equal(
  isAllowedSessionPermission({
    permission: "clipboard-sanitized-write",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  }),
  true,
);
for (const denied of [
  {
    permission: "media",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  },
  {
    permission: "geolocation",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  },
  {
    permission: "notifications",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  },
  {
    permission: "clipboard-read",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  },
  {
    permission: "openExternal",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  },
  {
    permission: "clipboard-sanitized-write",
    isMainFrame: false,
    requestingUrl: app,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  },
  {
    permission: "clipboard-sanitized-write",
    isMainFrame: true,
    requestingUrl: pluginPageUrl,
    requestingOrigin: "null",
    trustedUrl: app,
  },
  {
    permission: "clipboard-sanitized-write",
    isMainFrame: true,
    requestingUrl: pluginPageUrl,
    requestingOrigin: appOrigin,
    trustedUrl: app,
  },
  {
    permission: "clipboard-sanitized-write",
    isMainFrame: true,
    requestingUrl: app,
    requestingOrigin: "null",
    trustedUrl: app,
  },
  {
    permission: "clipboard-sanitized-write",
    isMainFrame: true,
    requestingUrl: splash,
    requestingOrigin: "null",
    trustedUrl: splash,
  },
]) {
  assert.equal(
    isAllowedSessionPermission(denied),
    false,
    JSON.stringify(denied),
  );
}

console.log("trusted-origin selfcheck: OK");
