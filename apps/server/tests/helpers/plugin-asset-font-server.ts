import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createPluginAssetRoutes } from "../../src/routes/plugin-assets.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { registerTestPlugins } from "./register-test-plugins.js";

async function close(server: Server | undefined) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

/** Real HTTP delivery: Playwright route.fulfill() supplies CORS headers by default. */
export async function startPluginAssetFontServer(
  font: Buffer,
  pageCsp: string,
) {
  const root = await mkdtemp(path.join(tmpdir(), "covel-font-http-"));
  let server: Server | undefined;
  const responses: {
    origin: string | null;
    mode: string | null;
    status: number;
    allowOrigin: string | null;
    allowCredentials: string | null;
    contentType: string | null;
  }[] = [];
  try {
    const plugin = path.join(root, "font-probe");
    await mkdir(path.join(plugin, "ui"), { recursive: true });
    const script = `
      const probe = async (family, source) => {
        const font = new FontFace(family, 'url("' + source + '") format("woff2")');
        document.fonts.add(font);
        try { await font.load(); } catch { /* Report the actual loading state. */ }
        return font.status;
      };
      (async () => {
        // Probe the URL first, before any identical data: font could be cached.
        const url = await probe("UrlFont", "font.woff2");
        const embedded = await probe("EmbeddedFont", "data:font/woff2;base64,${font.toString("base64")}");
        document.querySelector("#fonts").textContent = JSON.stringify({ embedded, url, origin: self.origin });
      })();`;
    for (const [file, content] of Object.entries({
      "PLUGIN.md":
        "---\nid: font-probe\ndescription: Font probe\ncontributes:\n  ui:\n    view: [./view.json]\n---\n",
      "view.json": JSON.stringify({
        id: "font",
        label: "Font",
        webview: { root: "./ui", entry: "index.html" },
      }),
      "ui/index.html":
        '<!doctype html><html><head><script src="app.js" defer></script></head><body><p id="fonts">loading</p></body></html>',
      "ui/app.js": script,
      "ui/font.woff2": font,
    }))
      await writeFile(path.join(plugin, file), content);
    const registry = createPluginRegistry();
    await registerTestPlugins(registry, [root]);
    const projection = await buildUiSpecsResponse({
      registry,
      store: createMemoryStore(),
    });
    const webview = projection.view[0]?.specs[0]?.webview as
      { url?: string } | undefined;
    const entryUrl = webview?.url;
    if (!entryUrl) throw new Error("Font view was not indexed");
    const app = new Hono();
    app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
    // Stress the asset route's stripping even if outer middleware grants CORS.
    app.use("*", cors({ origin: (origin) => origin }));
    app.get("/font-harness", (c) => {
      c.header("Content-Security-Policy", pageCsp);
      return c.html(
        `<!doctype html><iframe sandbox="allow-scripts" src="${entryUrl}" referrerpolicy="no-referrer"></iframe>`,
      );
    });
    app.route("/", createPluginAssetRoutes(registry));
    const listener = getRequestListener(
      async (request) => {
        const response = await app.fetch(request);
        if (new URL(request.url).pathname.endsWith("/font.woff2")) {
          // Observe the final Fetch response passed to the adapter. Its direct
          // writeHead(status, headers) call does not populate getHeader()'s cache.
          responses.push({
            origin: request.headers.get("origin"),
            mode: request.headers.get("sec-fetch-mode"),
            status: response.status,
            allowOrigin: response.headers.get("access-control-allow-origin"),
            allowCredentials: response.headers.get(
              "access-control-allow-credentials",
            ),
            contentType: response.headers.get("content-type"),
          });
        }
        return response;
      },
      { overrideGlobalObjects: false },
    );
    const httpServer = createServer(listener);
    server = httpServer;
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("Font server has no port");
    return {
      url: `http://127.0.0.1:${address.port}/font-harness`,
      responses,
      dispose: async () => {
        try {
          await close(server);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await close(server);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
