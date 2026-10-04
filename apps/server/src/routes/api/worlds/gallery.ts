/**
 * World gallery routes — the images a world package ships, for the world list
 * and the world details, where no session (and so no media token) exists yet.
 *
 * The files are distribution content of a catalogue entry, readable by whoever
 * can list worlds. A request names a media source and a file of that source;
 * it is answered only when the gallery listing itself contains that file.
 */

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { errorBody } from "../../../api-error.js";
import {
  listWorldGallery,
  listWorldGalleryFiles,
} from "../../../world-data/gallery.js";
import { resolveWorldRoot } from "../../../world-data/session-import/utils.js";
import { type WorldEnv } from "./shared.js";

export const worldGalleryRoutes = new Hono<WorldEnv>();

function galleryFileUrl(
  worldId: string,
  source: string,
  file: string,
  version: string,
): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/gallery/${encodeURIComponent(source)}/${encodeURIComponent(file)}?v=${version}`;
}

// GET /worlds/:id/gallery
worldGalleryRoutes.get("/:id/gallery", async (c) => {
  const worldId = c.req.param("id");
  if (!(await c.get("store").getWorld(worldId))) {
    return c.json(errorBody("World not found"), 404);
  }
  // A world kept only in the store has no package, and so no images.
  const worldRoot = await resolveWorldRoot(worldId, c.get("worldsDirs") ?? []);
  if (!worldRoot) return c.json({ items: [] });
  const images = await listWorldGallery({
    worldRoot,
    worldId,
    covelHome: c.get("covelHome"),
  });
  return c.json({
    items: images.map((image) => ({
      id: `${image.source}/${image.file}`,
      source: image.source,
      url: galleryFileUrl(worldId, image.source, image.file, image.version),
      width: image.width,
      height: image.height,
    })),
  });
});

// GET /worlds/:id/gallery/:source/:file
worldGalleryRoutes.get("/:id/gallery/:source/:file", async (c) => {
  const worldId = c.req.param("id");
  const worldRoot = await resolveWorldRoot(worldId, c.get("worldsDirs") ?? []);
  const source = c.req.param("source");
  const file = c.req.param("file");
  const match = worldRoot
    ? (
        await listWorldGalleryFiles({
          worldRoot,
          worldId,
          covelHome: c.get("covelHome"),
        })
      ).find((entry) => entry.source === source && entry.file === file)
    : undefined;
  if (!match) return c.json(errorBody("Image not found"), 404);

  const etag = `"${match.version}"`;
  const headers = {
    etag,
    // The listing puts the file's version in the URL, so that URL never goes
    // stale; any other URL is checked against the file each time.
    "cache-control":
      c.req.query("v") === match.version
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    "x-content-type-options": "nosniff",
  };
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(
    Readable.toWeb(createReadStream(match.absolutePath)) as ReadableStream,
    {
      status: 200,
      headers: {
        ...headers,
        "content-type": match.mime,
        "content-length": String(match.bytes),
      },
    },
  );
});
