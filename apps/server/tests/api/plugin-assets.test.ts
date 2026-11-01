// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import { PLUGIN_ASSET_PAGE_CSP, PLUGIN_BRIDGE_SCRIPT } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { createPluginAssetRoutes } from "../../src/routes/plugin-assets.js";
import {
  buildUiSpecsResponse,
  __resetUiSpecsCache,
} from "../../src/routes/misc-api/ui-specs.js";
import { createForeignRequestGuardMiddleware } from "../../src/middleware/foreign-request-guard.js";
import { registerTestPlugins } from "../helpers/register-test-plugins.js";

let root: string;
let registry: PluginRegistry;
let app: Hono;
let prefix: string;
const hash8 = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 8);
const bridgeName = `__covel__/bridge-${hash8(PLUGIN_BRIDGE_SCRIPT)}.js`;
async function put(file: string, content: string | Buffer) {
  const target = path.join(root, "p", file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
async function specs() {
  return buildUiSpecsResponse({ registry, store: createMemoryStore() });
}
async function index() {
  const result = await specs();
  const webview = result.view[0]?.specs[0]?.webview as
    { url: string } | undefined;
  if (!webview) throw new Error(JSON.stringify(result.diagnostics));
  return webview.url.slice(0, webview.url.lastIndexOf("/") + 1);
}
async function register(entry = "index.html") {
  await put(
    "view.json",
    JSON.stringify({
      id: "page",
      label: "Page",
      bridge: "session",
      webview: { root: "./ui/app", entry },
    }),
  );
  await registerTestPlugins(registry, [root]);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-page-route-"));
  registry = createPluginRegistry();
  await put(
    "PLUGIN.md",
    "---\nid: p\ndescription: Page\ncontributes:\n  ui:\n    view: [./view.json]\n---\n",
  );
  await put(
    "ui/app/index.html",
    "<!doctype html><html><head><title>Page</title></head><body>hello</body></html>",
  );
  for (const [file, content] of Object.entries({
    "app.js": "window.loaded = true",
    "style.css": "body {color:red}",
    "img/logo.png": "image",
    "icon.svg": "<svg/>",
    "font.woff2": Buffer.from("wOF2"),
    ".secret": "secret",
    "node_modules/x.js": "secret",
    "app.map": "secret",
    "app.wasm": "secret",
    "app.mjs": "secret",
    "other.html": "secret",
  }))
    await put(`ui/app/${file}`, content);
  await register();
  app = new Hono();
  // Match app.ts, including the route-specific CORP exception after secureHeaders.
  const normalHeaders = secureHeaders();
  const assetHeaders = secureHeaders({ crossOriginResourcePolicy: false });
  app.use("*", (c, next) =>
    (c.req.path.startsWith("/plugin-assets/") ? assetHeaders : normalHeaders)(
      c,
      next,
    ),
  );
  app.use("*", createForeignRequestGuardMiddleware());
  app.use(
    "*",
    cors({
      origin: (origin) => (origin === "http://localhost:5173" ? origin : null),
    }),
  );
  app.route("/", createPluginAssetRoutes(registry));
  // Match production: neither public files nor the SPA may answer asset misses.
  const webRoot = path.join(root, "web");
  await mkdir(path.join(webRoot, "plugin-assets"), { recursive: true });
  await writeFile(
    path.join(webRoot, "index.html"),
    "<title>SPA fallback</title>",
  );
  await writeFile(
    path.join(webRoot, "plugin-assets/public.txt"),
    "Unpublished public file",
  );
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ root: webRoot, path: "/index.html" }));
  prefix = await index();
});
afterEach(async () => {
  __resetUiSpecsCache();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function request(file: string, init?: RequestInit) {
  return app.request(`http://localhost${prefix}${file}`, init);
}
async function missing(file: string) {
  const response = await request(file);
  expect(response.status, file).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.json()).toEqual({ error: "File not found" });
}
describe("public plugin assets", () => {
  it.each([
    "%2e%2e/%2e%2e/PLUGIN.md",
    "%2E%2E/%2E%2E/missing.js",
    "../../PLUGIN.md",
    "%2e%2e/%2e%2e/",
  ])("keeps normalized asset paths out of static serving: %s", async (file) => {
    // Both Fetch and the Node HTTP adapter normalize dot segments before routing.
    await missing(file);
  });
  it.each([
    "/plugin-assets",
    "/plugin-assets/",
    "/plugin-assets/PLUGIN.md",
    "/plugin-assets/public.txt",
    "/plugin-assets/p",
    "/plugin-assets/p/PLUGIN.md",
  ])("reserves incomplete asset paths: %s", async (url) => {
    const response = await app.request(url);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ error: "File not found" });
  });
  it("uses the same missing response for HEAD and unsupported asset methods", async () => {
    for (const [url, method] of [
      ["/plugin-assets/PLUGIN.md", "HEAD"],
      [`${prefix}app.js`, "POST"],
    ] as const) {
      const response = await app.request(url, {
        method,
        headers: { Origin: "http://localhost:5173" },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      if (method === "HEAD") expect(await response.text()).toBe("");
      else expect(await response.json()).toEqual({ error: "File not found" });
    }
  });
  it("keeps the SPA fallback available outside the asset namespace", async () => {
    for (const url of ["/", "/session/example", "/plugin-assets-other/page"]) {
      const response = await app.request(url);
      expect(response.status, url).toBe(200);
      expect(await response.text()).toBe("<title>SPA fallback</title>");
    }
  });
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["app.js", "text/javascript; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"],
    ["img/logo.png", "image/png"],
    ["icon.svg", "image/svg+xml"],
    ["font.woff2", "font/woff2"],
    [bridgeName, "text/javascript; charset=utf-8"],
  ])(
    "serves %s with its cache policy, conditional GET and HEAD",
    async (file, mime) => {
      for (const origin of ["null", "http://localhost:5173"]) {
        const response = await request(file, { headers: { Origin: origin } });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(mime);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(response.headers.get("cache-control")).toBe(
          file === "index.html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        );
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("cross-origin-resource-policy")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        const corsOrigin = file.endsWith(".js") ? "*" : null;
        expect(response.headers.get("access-control-allow-origin")).toBe(
          corsOrigin,
        );
        expect(
          response.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        expect(response.headers.get("access-control-allow-headers")).toBeNull();
        expect(response.headers.get("access-control-allow-methods")).toBeNull();
        const body = await response.arrayBuffer();
        expect(response.headers.get("content-length")).toBe(
          String(body.byteLength),
        );
        const etag = response.headers.get("etag");
        expect(etag).toContain(`-${hash8(file)}`);
        const cached = await request(file, {
          headers: { "If-None-Match": etag ?? "" },
        });
        expect(cached.status).toBe(304);
        expect(await cached.text()).toBe("");
        expect(cached.headers.get("content-type")).toBe(mime);
        expect(cached.headers.get("cache-control")).toBe(
          response.headers.get("cache-control"),
        );
        expect(cached.headers.get("access-control-allow-origin")).toBe(
          corsOrigin,
        );
        const head = await request(file, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect(head.headers.get("etag")).toBe(etag);
        expect(head.headers.get("cache-control")).toBe(
          response.headers.get("cache-control"),
        );
        expect(head.headers.get("content-length")).toBe(
          String(body.byteLength),
        );
        expect(head.headers.get("access-control-allow-origin")).toBe(
          corsOrigin,
        );
        if (file !== "index.html")
          expect(response.headers.get("content-security-policy")).toBe(
            "sandbox",
          );
      }
    },
  );
  it("revalidates unchanged plugin HTML after a host bridge upgrade", async () => {
    const original = await request("index.html");
    const originalHtml = await original.text();
    expect(original.headers.get("cache-control")).toBe("no-cache");
    expect(originalHtml).toContain(bridgeName);
    const oldEtag = original.headers.get("etag");
    if (!oldEtag) throw new Error("Entry response has no ETag");

    const shared = await import("@covel/shared");
    const upgradedBridge = `${shared.PLUGIN_BRIDGE_SCRIPT}\n// upgraded host bridge`;
    const upgradedName = `__covel__/bridge-${hash8(upgradedBridge)}.js`;
    vi.resetModules();
    vi.doMock("@covel/shared", () => ({
      ...shared,
      PLUGIN_BRIDGE_SCRIPT: upgradedBridge,
    }));
    try {
      const { createPluginAssetRoutes: upgradedRoutes } =
        await import("../../src/routes/plugin-assets.js");
      const upgraded = upgradedRoutes(registry);
      // Same URL, digest and plugin files: only the host's bridge changed.
      const response = await upgraded.request(`${prefix}index.html`, {
        headers: { "If-None-Match": oldEtag },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("etag")).not.toBe(oldEtag);
      const html = await response.text();
      expect(html).toContain(upgradedName);
      expect(html).not.toContain(bridgeName);
      expect(response.headers.get("content-length")).toBe(
        String(Buffer.byteLength(html)),
      );
      const bridge = await upgraded.request(`${prefix}${upgradedName}`);
      expect(bridge.status).toBe(200);
      expect(bridge.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(await bridge.text()).toBe(upgradedBridge);
      expect((await upgraded.request(`${prefix}${bridgeName}`)).status).toBe(
        404,
      );
      const currentEtag = response.headers.get("etag");
      if (!currentEtag) throw new Error("Upgraded entry response has no ETag");
      const cached = await upgraded.request(`${prefix}index.html`, {
        headers: { "If-None-Match": currentEtag },
      });
      expect(cached.status).toBe(304);
      expect(cached.headers.get("cache-control")).toBe("no-cache");
      expect(await cached.text()).toBe("");
    } finally {
      vi.doUnmock("@covel/shared");
      vi.resetModules();
    }
  });
  it("injects the shared bridge immediately after head under the exact page policy", async () => {
    const response = await request("index.html", {
      headers: { Origin: "null", "Sec-Fetch-Dest": "iframe" },
    });
    expect(response.headers.get("content-security-policy")).toBe(
      PLUGIN_ASSET_PAGE_CSP,
    );
    const html = await response.text();
    expect(html).toContain(
      `<head><script crossorigin="anonymous" src="${bridgeName}"></script><title>`,
    );
    const bridge = await request(bridgeName);
    expect(bridge.status).toBe(200);
    expect(bridge.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(bridge.headers.get("content-security-policy")).toBe("sandbox");
    expect(await bridge.text()).toBe(PLUGIN_BRIDGE_SCRIPT);
  });
  it("enables rejection reporting for page scripts before the browser fetches them", async () => {
    await put(
      "ui/app/index.html",
      '<head><script defer src="app.js"></script></head>',
    );
    await register();
    prefix = await index();
    const response = await request("index.html");
    expect(await response.text()).toBe(
      `<head><script crossorigin="anonymous" src="${bridgeName}"></script>` +
        '<script crossorigin="anonymous" defer src="app.js"></script></head>',
    );
    for (const file of ["app.js", bridgeName]) {
      const script = await request(file, { headers: { Origin: "null" } });
      expect(script.status).toBe(200);
      expect(script.headers.get("access-control-allow-origin")).toBe("*");
      expect(script.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const missing = await request("missing.js", {
      headers: { Origin: "null" },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
  });
  it.each([
    [
      '<HTML><HEAD class="x"><title>x</title></HEAD></HTML>',
      '<HEAD class="x">',
    ],
    ["<html><body>x</body></html>", "<html>"],
    ["<!DOCTYPE html>hello", "<!DOCTYPE html>"],
    ["hello", ""],
  ])("injects into HTML variant %s", async (html, insertion) => {
    await put("ui/app/index.html", html);
    await register();
    prefix = await index();
    const result = await (await request("index.html")).text();
    const script = `<script crossorigin="anonymous" src="${bridgeName}"></script>`;
    expect(result).toBe(
      insertion ? html.replace(insertion, insertion + script) : script + html,
    );
  });
  it("uses document-relative upward segments for nested entry HTML", async () => {
    await put("ui/app/pages/two.html", "<head></head>");
    await register("pages/two.html");
    const result = await specs();
    const webview = result.view[0]?.specs[0]?.webview as { url: string };
    const response = await app.request(webview.url);
    const html = await response.text();
    expect(html).toBe(
      `<head><script crossorigin="anonymous" src="../${bridgeName}"></script></head>`,
    );
    const resolved = new URL(
      `../${bridgeName}`,
      `http://localhost${webview.url}`,
    );
    expect(await (await app.request(resolved)).text()).toBe(
      PLUGIN_BRIDGE_SCRIPT,
    );
  });
  it.each([
    "..%2f..%2fPLUGIN.md",
    "..%2f..%2fpackage.json",
    "%2e%2e/PLUGIN.md",
    "../PLUGIN.md",
    "server/index.js",
    "missing.js",
    "a/../b",
    "a//b.js",
    "%5csecret",
    "%00",
    "a%2Fb.js",
    "/absolute",
    ".secret",
    "%2esecret",
    "node_modules/x.js",
    "app.map",
    "app.wasm",
    "app.mjs",
    "other.html",
    "img/",
    "__covel__/other.js",
    "__covel__/bridge-00000000.js",
    "%ZZ",
  ])("uniformly rejects %s", missing);
  it("refuses wrong digests, unknown ids, invalid ids and error-status plugins", async () => {
    const validPrefix = prefix;
    for (const path of [
      prefix.replace(/\/([a-f0-9]{32})\//, `/${"0".repeat(32)}/`),
      prefix.replace("/p/", "/unknown/"),
      prefix.replace("/p/", "/bad.id/"),
      prefix.replace(/\/[a-f0-9]{32}\//, "/bad/"),
    ]) {
      prefix = path;
      await missing("index.html");
    }
    prefix = validPrefix;
    const plugin = registry.getAll().get("p");
    if (!plugin) throw new Error("missing plugin");
    registry.register({ ...plugin, status: "error" });
    await missing("index.html");
  });
  it("invalidates every old URL on re-registration and includes all files in the digest", async () => {
    const old = prefix;
    await put("ui/app/app.js", "window.changed=true");
    await register();
    const next = await index();
    expect(next).not.toBe(old);
    await missing("app.js");
    prefix = next;
    expect((await request("app.js")).status).toBe(200);
  });
  it("refuses a size change after indexing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await put("ui/app/app.js", "changed");
    await missing("app.js");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("changed since the page was indexed"),
    );
  });
  it("refuses entries above the serving cap but scans them without the inline HTML limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await put("ui/app/index.html", "x".repeat(2 * 1024 * 1024 + 1));
    await register();
    prefix = await index();
    await missing("index.html");
  });
  it.skipIf(process.platform === "win32")(
    "neither indexes links nor serves a file replaced by a link",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const original = await request("app.js");
      expect(original.status).toBe(200);
      const originalBytes = Buffer.from(await original.arrayBuffer());
      const replacement = Buffer.alloc(originalBytes.byteLength, "s");
      expect(replacement.byteLength).toBe(originalBytes.byteLength);
      expect(replacement.equals(originalBytes)).toBe(false);
      await put("secret.js", replacement);
      await symlink(
        path.join(root, "p/secret.js"),
        path.join(root, "p/ui/app/link.js"),
      );
      await symlink(
        path.join(root, "p"),
        path.join(root, "p/ui/app/linked"),
        "dir",
      );
      await register();
      prefix = await index();
      await missing("link.js");
      await missing("linked/secret.js");
      expect((await request("app.js")).status).toBe(200);
      await rm(path.join(root, "p/ui/app/app.js"));
      await symlink(
        path.join(root, "p/secret.js"),
        path.join(root, "p/ui/app/app.js"),
      );
      await missing("app.js");
    },
  );
  it("reports reserved directory diagnostics and omits its asset root", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await mkdir(path.join(root, "p/ui/app/__covel__"));
    await register();
    const result = await specs();
    expect(result.view).toEqual([]);
    expect(result.diagnostics[0]?.issues).toContainEqual(
      expect.objectContaining({
        path: "webview.root",
        message: "the name __covel__ is reserved",
      }),
    );
    await missing("index.html");
  });
});
it.skipIf(process.platform === "win32")(
  "refuses replacement of the indexed root by a directory symlink",
  async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = path.join(root, "p/ui/app");
    await rm(original, { recursive: true });
    await put("outside/app.js", "window.loaded = true");
    await symlink(path.join(root, "p/outside"), original, "dir");
    await missing("app.js");
  },
);

it.each([
  "index.html",
  "app.js",
  "style.css",
  "icon.svg",
  "img/logo.png",
  "font.woff2",
])(
  "refuses same-size changes to %s before GET, HEAD or conditional success",
  async (file) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await request(file);
    expect(before.status).toBe(200);
    const etag = before.headers.get("etag")!;
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(path.join(root, "p/ui/app", file));
    const changed = Buffer.alloc(bytes.length, "x");
    expect(changed.equals(bytes)).toBe(false);
    await put(`ui/app/${file}`, changed);
    for (const init of [
      {},
      { method: "HEAD" },
      { headers: { "If-None-Match": etag } },
    ]) {
      const result = await request(file, init);
      expect(result.status).toBe(404);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.headers.get("etag")).toBeNull();
      expect(await result.text()).not.toContain(changed.toString());
    }
    const old = prefix;
    await register();
    const next = await index();
    expect(next).not.toBe(old);
    await missing(file);
    prefix = next;
    const fresh = await request(file);
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain(changed.toString());
  },
);

async function themeIndex(overlap = false) {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV7sAAAAASUVORK5CYII=",
    "base64",
  );
  const assetRoot = overlap ? "ui/app" : "ui/theme-art";
  await put(`${assetRoot}/img/paper.png`, bytes);
  if (overlap) await put(`${assetRoot}/img/logo.png`, bytes);
  await put(
    "theme.json",
    JSON.stringify({
      id: "reading",
      label: "Reading",
      css: "./theme.css",
      assets: { root: `./${assetRoot}` },
    }),
  );
  await put("theme.css", ".surface{background-image:url(img/paper.png)}");
  await put(
    "PLUGIN.md",
    "---\nid: p\ndescription: Theme and page\ncontributes:\n  ui:\n    view: [./view.json]\n    theme: [./theme.json]\n---\n",
  );
  await registerTestPlugins(registry, [root]);
  const result = await specs();
  const theme = result.theme[0]?.specs[0];
  if (!theme?.assets) throw new Error(JSON.stringify(result.diagnostics));
  return {
    prefix: `/plugin-assets/p/${theme.assets.digest}/`,
    bytes,
    assetRoot,
    theme,
  };
}
it("serves theme-only bitmaps with immutable headers, GET/HEAD/ETag and no bridge", async () => {
  const theme = await themeIndex();
  for (const method of ["GET", "HEAD"]) {
    const response = await app.request(`${theme.prefix}img/paper.png`, {
      method,
      headers: { Origin: "null" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    if (method === "GET")
      expect(Buffer.from(await response.arrayBuffer())).toEqual(theme.bytes);
    else expect(await response.text()).toBe("");
    const cached = await app.request(`${theme.prefix}img/paper.png`, {
      headers: { "If-None-Match": response.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
  }
  expect((await app.request(`${theme.prefix}${bridgeName}`)).status).toBe(404);
  expect((await app.request(`${prefix}index.html`)).status).toBe(200);
  expect(await (await app.request(`${prefix}index.html`)).text()).toContain(
    bridgeName,
  );
});
it("keeps publication purpose separate for overlapping page and bitmap roots", async () => {
  const theme = await themeIndex(true);
  const pagePrefix = await index();
  expect(theme.prefix).not.toBe(pagePrefix);
  for (const file of [
    "index.html",
    "app.js",
    "icon.svg",
    "font.woff2",
    bridgeName,
  ]) {
    expect((await app.request(`${theme.prefix}${file}`)).status, file).toBe(
      404,
    );
    expect((await app.request(`${pagePrefix}${file}`)).status, file).toBe(200);
  }
  expect((await app.request(`${theme.prefix}img/paper.png`)).status).toBe(200);
  expect((await app.request(`${theme.prefix}%2e%2e/PLUGIN.md`)).status).toBe(
    404,
  );
});
it("refuses same-size theme replacements until re-registration and retires the old digest", async () => {
  const first = await themeIndex();
  const changed = Buffer.from(first.bytes);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await put(`${first.assetRoot}/img/paper.png`, changed);
  expect((await app.request(`${first.prefix}img/paper.png`)).status).toBe(404);
  await registerTestPlugins(registry, [root]);
  const result = await specs();
  const current = result.theme[0]!.specs[0]!;
  expect(current.contentHash).not.toBe(first.theme.contentHash);
  expect(current.assets!.digest).not.toBe(first.theme.assets!.digest);
  expect((await app.request(`${first.prefix}img/paper.png`)).status).toBe(404);
  const response = await app.request(
    `/plugin-assets/p/${current.assets!.digest}/img/paper.png`,
  );
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(changed);
});
it.skipIf(process.platform === "win32")(
  "rejects linked theme parents even when they point inside the same root with identical bytes",
  async () => {
    const theme = await themeIndex();
    await put(`${theme.assetRoot}/other/paper.png`, theme.bytes);
    await rm(path.join(root, "p", theme.assetRoot, "img"), { recursive: true });
    await symlink(
      path.join(root, "p", theme.assetRoot, "other"),
      path.join(root, "p", theme.assetRoot, "img"),
      "dir",
    );
    expect((await app.request(`${theme.prefix}img/paper.png`)).status).toBe(
      404,
    );
  },
);
