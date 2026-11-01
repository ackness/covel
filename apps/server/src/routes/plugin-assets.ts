import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import {
  PLUGIN_ASSETS_PATH,
  PLUGIN_ASSET_DIGEST_PATTERN,
  PLUGIN_ASSET_PAGE_CSP,
  PLUGIN_BRIDGE_SCRIPT,
} from "@covel/shared";
import { pluginPageDocument } from "@covel/shared/plugin-page";
import { isPathInside, type PluginRegistry } from "@covel/plugin-loader";
import { errorBody } from "../api-error.js";
import { findPluginAssetRoot } from "./misc-api/ui-specs.js";

const hash8 = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);
const BRIDGE_HASH = hash8(PLUGIN_BRIDGE_SCRIPT);
const BRIDGE_PATH = `__covel__/bridge-${BRIDGE_HASH}.js`;
const MAX_PAGE_ENTRY_BYTES = 2 * 1024 * 1024;

function injectBridge(html: string, entry: string): string {
  const prefix = "../".repeat(entry.split("/").length - 1);
  return pluginPageDocument(html, `${prefix}${BRIDGE_PATH}`);
}

/** Public files, limited to the registry snapshot's published listing. */
export function createPluginAssetRoutes(registry: PluginRegistry): Hono {
  const app = new Hono();
  const missing = (c: Context) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(errorBody("File not found"), 404);
  };
  app.use(`${PLUGIN_ASSETS_PATH}/*`, (c, next) => {
    // Remove global CORS permissions; verified public scripts opt in below.
    for (const name of [...c.res.headers.keys()])
      if (
        name.toLowerCase().startsWith("access-control-allow-") ||
        name.toLowerCase() === "set-cookie"
      )
        c.header(name, undefined);
    return next();
  });
  app.get(`${PLUGIN_ASSETS_PATH}/:pluginId/:digest/*`, async (c) => {
    const pluginId = c.req.param("pluginId");
    const digest = c.req.param("digest");
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(pluginId) ||
      !PLUGIN_ASSET_DIGEST_PATTERN.test(digest)
    )
      return missing(c);
    const raw = c.req.path.split("/").slice(4).join("/");
    if (/[\\\0]|%2f|%5c|%00|\/\//i.test(raw)) return missing(c);
    const segments = raw.split("/");
    if (segments.some((segment) => !segment || segment.startsWith(".")))
      return missing(c);
    let relativePath: string;
    try {
      const decoded = segments.map((segment) => decodeURIComponent(segment));
      if (
        decoded.some(
          (segment) => /[/\\\0]/.test(segment) || segment.startsWith("."),
        )
      )
        return missing(c);
      relativePath = decoded.join("/");
    } catch {
      return missing(c);
    }
    const root = await findPluginAssetRoot(registry, pluginId, digest);
    if (!root) return missing(c);
    const bridge = root.purpose === "page" && relativePath === BRIDGE_PATH;
    const metadata = root.files.get(relativePath);
    if (!bridge && !metadata) return missing(c);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let body: Buffer | undefined;
    const entry = root.purpose === "page" && relativePath === root.entry;
    let size = Buffer.byteLength(PLUGIN_BRIDGE_SCRIPT);
    if (bridge) body = Buffer.from(PLUGIN_BRIDGE_SCRIPT);
    else {
      try {
        const file = path.join(root.rootDir, relativePath);
        if (root.purpose === "theme") {
          let current = root.rootDir;
          for (const segment of relativePath.split("/")) {
            current = path.join(current, segment);
            if ((await fs.lstat(current)).isSymbolicLink())
              throw new Error("linked bitmap path");
          }
        }
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        const [realRoot, realFile] = await Promise.all([
          fs.realpath(root.rootDir),
          fs.realpath(file),
        ]);
        if (
          realRoot !== root.rootDir ||
          !stat.isFile() ||
          stat.size !== metadata?.size ||
          !isPathInside(realRoot, realFile)
        )
          throw new Error("changed file");
        if (!metadata || (entry && stat.size > MAX_PAGE_ENTRY_BYTES))
          throw new Error("asset exceeds serving limit");
        // Read once with a fixed bound, then serve only these verified bytes.
        const bytes = Buffer.alloc(metadata.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        body = bytes.subarray(0, length);
        if (
          length !== metadata.size ||
          createHash("sha256").update(body).digest("hex") !== metadata.sha256
        )
          throw new Error("changed file");
        if (entry)
          body = Buffer.from(injectBridge(body.toString("utf8"), root.entry!));
        size = body.byteLength;
        await handle.close();
        handle = undefined;
      } catch {
        await handle?.close();
        console.warn(
          `[plugin-assets] ${pluginId}: ${relativePath} changed since the page was indexed`,
        );
        return missing(c);
      }
    }
    c.header(
      "Content-Type",
      bridge ? "text/javascript; charset=utf-8" : metadata?.mime,
    );
    c.header("Content-Length", String(size));
    c.header("X-Content-Type-Options", "nosniff");
    // The plugin digest excludes the injected host bridge. Revalidate HTML so
    // a host upgrade can replace its bridge URL even when plugin files are unchanged.
    c.header(
      "Cache-Control",
      entry ? "no-cache" : "public, max-age=31536000, immutable",
    );
    c.header("Referrer-Policy", "no-referrer");
    // Anonymous CORS keeps script errors and promise rejections observable in
    // opaque frames. Only published JavaScript (including our bridge) opts in;
    // no credentials, fonts, HTML, missing files or API responses are exposed.
    if (
      bridge ||
      (root.purpose === "page" &&
        metadata?.mime === "text/javascript; charset=utf-8")
    )
      c.header("Access-Control-Allow-Origin", "*");
    c.header(
      "Content-Security-Policy",
      entry ? PLUGIN_ASSET_PAGE_CSP : "sandbox",
    );
    const etag = `"${digest}-${size}-${hash8(relativePath)}${entry ? `-${BRIDGE_HASH}` : ""}"`;
    c.header("ETag", etag);
    if (c.req.header("if-none-match") === etag || c.req.method === "HEAD") {
      await handle?.close();
      return c.body(null, c.req.header("if-none-match") === etag ? 304 : 200);
    }
    if (body)
      return new Response(new Uint8Array(body), { headers: c.res.headers });
    return missing(c);
  });
  // Dot-segment normalization may remove the ID/digest before routing. Reserve
  // the entire namespace so unmatched paths cannot reach public files or the SPA.
  app.all(`${PLUGIN_ASSETS_PATH}/*`, missing);
  return app;
}
