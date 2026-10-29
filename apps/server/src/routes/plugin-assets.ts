import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import {
  PLUGIN_ASSETS_PATH,
  PLUGIN_ASSET_DIGEST_PATTERN,
  PLUGIN_ASSET_PAGE_CSP,
  PLUGIN_BRIDGE_SCRIPT,
} from "@covel/shared";
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
  const script = `<script src="${prefix}${BRIDGE_PATH}"></script>`;
  for (const pattern of [
    /<head\b[^>]*>/i,
    /<html\b[^>]*>/i,
    /<!doctype\b[^>]*>/i,
  ]) {
    if (pattern.test(html))
      return html.replace(pattern, (match) => match + script);
  }
  return script + html;
}

/** Public immutable files, limited to the registry snapshot's published listing. */
export function createPluginAssetRoutes(registry: PluginRegistry): Hono {
  const app = new Hono();
  app.get(`${PLUGIN_ASSETS_PATH}/:pluginId/:digest/*`, async (c) => {
    // CORS is global; opaque frames must load classic subresources without CORS.
    for (const name of [...c.res.headers.keys()])
      if (
        name.toLowerCase().startsWith("access-control-allow-") ||
        name.toLowerCase() === "set-cookie"
      )
        c.header(name, undefined);
    const missing = () => {
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      return c.json(errorBody("File not found"), 404);
    };
    const pluginId = c.req.param("pluginId");
    const digest = c.req.param("digest");
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(pluginId) ||
      !PLUGIN_ASSET_DIGEST_PATTERN.test(digest)
    )
      return missing();
    const raw = c.req.path.split("/").slice(4).join("/");
    if (/[\\\0]|%2f|%5c|%00|\/\//i.test(raw)) return missing();
    const segments = raw.split("/");
    if (segments.some((segment) => !segment || segment.startsWith(".")))
      return missing();
    let relativePath: string;
    try {
      const decoded = segments.map((segment) => decodeURIComponent(segment));
      if (
        decoded.some(
          (segment) => /[/\\\0]/.test(segment) || segment.startsWith("."),
        )
      )
        return missing();
      relativePath = decoded.join("/");
    } catch {
      return missing();
    }
    const root = await findPluginAssetRoot(registry, pluginId, digest);
    if (!root) return missing();
    const bridge = relativePath === BRIDGE_PATH;
    const metadata = root.files.get(relativePath);
    if (!bridge && !metadata) return missing();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let body: Buffer | undefined;
    const entry = relativePath === root.entry;
    let size = Buffer.byteLength(PLUGIN_BRIDGE_SCRIPT);
    if (bridge) body = Buffer.from(PLUGIN_BRIDGE_SCRIPT);
    else {
      try {
        const file = path.join(root.rootDir, relativePath);
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
        size = stat.size;
        if (entry) {
          if (size > MAX_PAGE_ENTRY_BYTES)
            throw new Error("entry exceeds 2 MiB");
          body = Buffer.from(
            injectBridge(await handle.readFile("utf8"), root.entry),
          );
          size = body.byteLength;
          await handle.close();
          handle = undefined;
        }
      } catch {
        await handle?.close();
        console.warn(
          `[plugin-assets] ${pluginId}: ${relativePath} changed since the page was indexed`,
        );
        return missing();
      }
    }
    c.header(
      "Content-Type",
      bridge ? "text/javascript; charset=utf-8" : metadata?.mime,
    );
    c.header("Content-Length", String(size));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("Referrer-Policy", "no-referrer");
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
    if (!handle) return missing();
    return new Response(
      Readable.toWeb(handle.createReadStream()) as ReadableStream,
      { headers: c.res.headers },
    );
  });
  return app;
}
