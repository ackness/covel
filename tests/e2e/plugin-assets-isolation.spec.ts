import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  PLUGIN_ASSET_PAGE_CSP,
  PLUGIN_BRIDGE_SCRIPT,
} from "../../packages/shared/src/plugin-frame.js";
import { PAGE_CSP } from "../../apps/web/src/lib/page-csp.js";
import { startPluginAssetFontServer } from "../../apps/server/tests/helpers/plugin-asset-font-server.js";

const harness = "/__plugin-assets-harness";
const prefix = `/plugin-assets/p/${"a".repeat(32)}`;
const entryUrl = `${prefix}/index.html`;
const navigationTarget = "https://example.invalid/";
const navigationOrigin = new URL(navigationTarget).origin;
const attemptMarker = "covel:test:navigation-attempt";
// Use the same valid, locally installed font for data: and URL probes.
const fontBytes = readFileSync(
  new URL(
    "../../apps/web/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    import.meta.url,
  ),
);
const attempts = {
  location: "location.href = target",
  open: "window.open(target)",
  form: "const form = document.createElement('form'); form.action = target; document.body.append(form); form.submit()",
  refresh:
    "const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = '0;url=' + target; document.head.append(meta)",
  top: "top.location.href = target",
};

async function mount(page: Page, attempt?: string) {
  const escaped: string[] = [];
  // These observations survive replacement of the iframe's original document.
  const observed = { attempted: false, blockedByFrameCsp: false };
  page.on("console", (message) => {
    const text = message.text();
    if (text === attemptMarker) observed.attempted = true;
    if (text.includes(navigationOrigin) && text.includes("frame-src"))
      observed.blockedByFrameCsp = true;
  });
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "example.invalid") {
      escaped.push(url.href);
      return route.fulfill({ contentType: "text/html", body: "escaped" });
    }
    if (url.pathname === harness)
      return route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": PAGE_CSP },
        body: "<!doctype html><body></body>",
      });
    if (url.pathname === entryUrl)
      return route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": PLUGIN_ASSET_PAGE_CSP },
        body: `<!doctype html><html><head><script src="__covel__/bridge.js"></script><link rel="stylesheet" href="style.css"><script>window.inlineRan=true</script><script src="app.js" defer></script></head><body><img id="logo" src="img/logo.svg"><p id="status">loading</p></body></html>`,
      });
    if (url.pathname === `${prefix}/__covel__/bridge.js`)
      return route.fulfill({
        contentType: "text/javascript",
        body: PLUGIN_BRIDGE_SCRIPT,
        headers: { "Content-Security-Policy": "sandbox" },
      });
    if (url.pathname === `${prefix}/app.js`)
      return route.fulfill({
        contentType: "text/javascript",
        body: `
        const attempt = async fn => { try { await fn(); return 'allowed'; } catch { return 'blocked'; } };
        let navigationAttempted = false;
        Promise.all([
          attempt(() => fetch('${prefix}/data.json')),
          attempt(() => fetch('https://example.invalid/'))
        ]).then(([local, remote]) => {
          window.covel.subscribe(state => {
            if (!state.synthetic) return;
            document.querySelector('#status').textContent = JSON.stringify({
              bridge: typeof window.covel, local, remote, inline: !!window.inlineRan,
              cookie: (() => { try { return document.cookie; } catch { return 'blocked'; } })(),
              electron: typeof window.electron,
              style: getComputedStyle(document.body).color,
              image: document.querySelector('#logo').naturalWidth,
            });
            ${
              attempt
                ? `if (!navigationAttempted) {
              navigationAttempted = true;
              document.body.dataset.attempted = 'true';
              console.info(${JSON.stringify(attemptMarker)});
              try { const target = ${JSON.stringify(navigationTarget)}; ${attempt}; }
              catch { document.body.dataset.navigationBlocked = 'true'; }
            }`
                : ""
            }
          });
        });
      `,
        headers: { "Content-Security-Policy": "sandbox" },
      });
    if (url.pathname === `${prefix}/style.css`)
      return route.fulfill({
        contentType: "text/css",
        body: "body { color: rgb(12, 34, 56); }",
      });
    if (url.pathname === `${prefix}/img/logo.svg`)
      return route.fulfill({
        contentType: "image/svg+xml",
        headers: { "Content-Security-Policy": "sandbox" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
      });
    if (url.pathname === `${prefix}/data.json`)
      return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.continue();
  });
  await page.goto(harness);
  await page.evaluate(
    async ({ entryUrl }) => {
      // Source import deliberately places this spec in chromium-dev.
      const bridgeModule = "/src/components/session/plugin-bridge.ts";
      const { connectPluginBridge } = await import(
        /* @vite-ignore */ bridgeModule
      );
      const iframe = document.createElement("iframe");
      iframe.sandbox.add("allow-scripts");
      iframe.src = entryUrl;
      iframe.referrerPolicy = "no-referrer";
      let connected = false;
      iframe.onload = () => {
        if (connected || !iframe.contentWindow) return;
        connected = true;
        connectPluginBridge(iframe.contentWindow, undefined, () => ({
          state: { synthetic: true },
          locked: false,
          handlers: {},
        }));
      };
      document.body.append(iframe);
    },
    { entryUrl },
  );
  return { escaped, observed };
}

test("multi-file pages load classic resources and the bridge without network or inline script", async ({
  page,
}) => {
  const { escaped } = await mount(page);
  const status = page.frameLocator("iframe").locator("#status");
  await expect(status).toContainText('"bridge":"object"');
  await expect(status).toContainText('"local":"blocked"');
  await expect(status).toContainText('"remote":"blocked"');
  await expect(status).toContainText('"inline":false');
  await expect(status).toContainText('"cookie":"blocked"');
  await expect(status).toContainText('"electron":"undefined"');
  await expect(status).toContainText('"style":"rgb(12, 34, 56)"');
  await expect(status).toContainText('"image":2');
  expect(escaped).toEqual([]);
});
test("multi-file pages load embedded fonts and reject URL fonts without CORS over real HTTP", async ({
  page,
}) => {
  // route.fulfill() automatically grants CORS to Origin: null. Use the real
  // asset route over HTTP, without interception, to exercise browser CORS checks.
  const server = await startPluginAssetFontServer(fontBytes, PAGE_CSP);
  try {
    await page.goto(server.url);
    const report = page.frameLocator("iframe").locator("#fonts");
    await expect(report).toHaveText(
      JSON.stringify({ embedded: "loaded", url: "error", origin: "null" }),
    );
    // The unique server/port and observed request rule out a memory-cache result.
    await expect
      .poll(() => server.responses)
      .toEqual([
        {
          origin: "null",
          mode: "cors",
          status: 200,
          allowOrigin: null,
          allowCredentials: null,
          contentType: "font/woff2",
        },
      ]);
  } finally {
    try {
      await page.goto("about:blank");
    } finally {
      await server.dispose();
    }
  }
});
for (const [name, attempt] of Object.entries(attempts))
  test(`multi-file page blocks ${name} escape`, async ({ page }) => {
    const { escaped, observed } = await mount(page, attempt);
    const body = page.frameLocator("iframe").locator("body");
    await expect.poll(() => observed.attempted).toBe(true);
    if (name === "location" || name === "refresh") {
      // Chromium can replace the entry with an empty CSP error document.
      // Prove CSP enforcement rather than waiting on the discarded body's marker.
      await expect
        .poll(() => ({
          blockedByFrameCsp: observed.blockedByFrameCsp,
          escaped: [...escaped],
        }))
        .toEqual({ blockedByFrameCsp: true, escaped: [] });
    } else {
      await expect(body).toHaveAttribute("data-attempted", "true");
    }
    if (name === "top")
      await expect(body).toHaveAttribute("data-navigation-blocked", "true");
    // Observe queued navigations after the attempt, without visiting any remote host.
    await page.waitForTimeout(250);
    expect(escaped).toEqual([]);
    expect(page.url()).toContain(harness);
    const childFrames = page
      .frames()
      .filter((frame) => frame !== page.mainFrame());
    expect(childFrames).toHaveLength(1);
    const child = childFrames[0];
    if (!child) throw new Error("Plugin iframe disappeared");
    const entry = new URL(entryUrl, page.url()).href;
    const allowedUrls =
      name === "location" || name === "refresh"
        ? [entry, "chrome-error://chromewebdata/"]
        : [entry];
    expect(allowedUrls, `Unexpected iframe URL: ${child.url()}`).toContain(
      child.url(),
    );
  });
