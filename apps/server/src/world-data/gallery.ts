import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { readImageSize, type ImageSize } from "./image-size.js";
import { MAX_MEDIA_FILE_BYTES } from "./media.js";
import { readWorldManifest } from "./session-import/utils.js";
import { readWorldDataSource } from "./source-reader.js";

/**
 * The images a world package ships, readable before any session exists.
 *
 * A session imports a package's `kind: media` sources into the media store;
 * the world list has no session, so it reads the same files from the package.
 * Only raster images of public media sources are listed — never a path the
 * caller names, and never SVG, which is scriptable when opened on its own.
 */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** A world list shows a selection; a package may hold far more files. */
const MAX_GALLERY_FILES = 60;

export interface WorldGalleryFile {
  /** ID of the media source in the world's data descriptor. */
  readonly source: string;
  readonly file: string;
  readonly absolutePath: string;
  readonly mime: string;
  readonly bytes: number;
  /** Changes when the file does; part of the URL, so a cached copy stays valid. */
  readonly version: string;
}

export interface WorldGalleryImage extends WorldGalleryFile, ImageSize {}

export async function listWorldGalleryFiles(options: {
  worldRoot: string;
  worldId: string;
  covelHome?: string;
}): Promise<WorldGalleryFile[]> {
  const manifest = await readWorldManifest(options.worldRoot);
  const descriptor = await loadWorldDataDescriptor({
    worldRoot: options.worldRoot,
    worldDataPath: manifest.worldData,
    worldId: options.worldId,
    covelHome: options.covelHome,
  });
  const files: WorldGalleryFile[] = [];
  for (const source of descriptor.sources) {
    const { kind, enabled, visibility } = source.descriptor;
    if (kind !== "media" || enabled === false || visibility === "hidden")
      continue;
    // Contained in the descriptor root and not a symlink, or no path at all.
    const resolved = (await readWorldDataSource(source)).path;
    if (!resolved) continue;
    const resolvedStat = await stat(resolved);
    const candidates = resolvedStat.isDirectory()
      ? (await readdir(resolved, { withFileTypes: true }))
          // `isFile()` is false for a symlink, so a link cannot leave the package.
          .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
          .map((entry) => path.join(resolved, entry.name))
          .sort((a, b) => a.localeCompare(b))
      : resolvedStat.isFile()
        ? [resolved]
        : [];
    for (const absolutePath of candidates) {
      if (files.length >= MAX_GALLERY_FILES) return files;
      const mime = IMAGE_TYPES[path.extname(absolutePath).toLowerCase()];
      if (!mime) continue;
      const fileStat = await stat(absolutePath);
      if (fileStat.size === 0 || fileStat.size > MAX_MEDIA_FILE_BYTES) continue;
      files.push({
        source: source.id,
        file: path.basename(absolutePath),
        absolutePath,
        mime,
        bytes: fileStat.size,
        version: `${Math.trunc(fileStat.mtimeMs).toString(36)}-${fileStat.size.toString(36)}`,
      });
    }
  }
  return files;
}

// Keyed by path and version, so an edited file is measured again.
const sizeCache = new Map<string, ImageSize | null>();
const SIZE_CACHE_LIMIT = 2000;

/** The gallery with pixel sizes; a file whose header cannot be read is left out. */
export async function listWorldGallery(options: {
  worldRoot: string;
  worldId: string;
  covelHome?: string;
}): Promise<WorldGalleryImage[]> {
  const images: WorldGalleryImage[] = [];
  for (const file of await listWorldGalleryFiles(options)) {
    const key = `${file.absolutePath}\u0000${file.version}`;
    let size = sizeCache.get(key);
    if (size === undefined) {
      size = await readImageSize(file.absolutePath).catch(() => null);
      if (sizeCache.size >= SIZE_CACHE_LIMIT) sizeCache.clear();
      sizeCache.set(key, size);
    }
    if (size) images.push({ ...file, ...size });
  }
  return images;
}
