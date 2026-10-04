import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { i18nTextSchema, type I18nText } from "@covel/shared";
import { z } from "zod";
import { loadWorldDataDescriptor } from "./descriptor.js";
import { readImageSize, type ImageSize } from "./image-size.js";
import { compileLocaleOverlays } from "./locale-overlays.js";
import { MAX_MEDIA_FILE_BYTES } from "./media.js";
import { resolveContainedPath } from "./safe-path.js";
import { readWorldManifest } from "./session-import/utils.js";
import { readWorldDataSource } from "./source-reader.js";

/**
 * The images a world package ships, readable before any session exists.
 *
 * A session imports a package's `kind: media` sources into the media store;
 * the world list has no session, so it reads the same files from the package.
 *
 * A package says what its gallery holds in `media/gallery.json`: which images,
 * in which order, with a name and an introduction for each. A package without
 * that file shows the raster images of its public media sources. Either way
 * only listed files are readable — never a path the caller names, and never
 * SVG, which is scriptable when opened on its own.
 */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** A world list shows a selection; a package may hold far more files. */
const MAX_GALLERY_FILES = 60;

const GALLERY_MANIFEST = "media/gallery.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;

const WORLD_GALLERY_KINDS = [
  "hero",
  "map",
  "scene",
  "still",
  "portrait",
] as const;
export type WorldGalleryKind = (typeof WORLD_GALLERY_KINDS)[number];

/**
 * The part of `media/gallery.json` the gallery shows. The file also carries
 * editorial fields (sources, generation records, checksums); they are not read.
 */
const galleryManifestSchema = z.looseObject({
  defaultLocale: z.string().optional(),
  images: z.array(
    z.looseObject({
      id: z.string().min(1).max(128),
      // An unknown kind is shown as a picture; it never fails the gallery.
      kind: z.enum(WORLD_GALLERY_KINDS).optional().catch(undefined),
      filename: z.string().min(1),
      webFilename: z.string().min(1).optional(),
      name: i18nTextSchema.optional().catch(undefined),
      description: i18nTextSchema.optional().catch(undefined),
      background: i18nTextSchema.optional().catch(undefined),
      location: i18nTextSchema.optional().catch(undefined),
      spoilerLevel: z.string().optional().catch(undefined),
    }),
  ),
});

export interface WorldGalleryFile {
  /** Stable identity of the picture in this world. */
  readonly id: string;
  /**
   * First half of the file's address: the directory under `media/` for a
   * picture of the gallery file, else the ID of the media source.
   */
  readonly source: string;
  readonly file: string;
  readonly absolutePath: string;
  readonly mime: string;
  readonly bytes: number;
  /** Changes when the file does; part of the URL, so a cached copy stays valid. */
  readonly version: string;
  /** What the package says the picture is; absent without a gallery file. */
  readonly kind?: WorldGalleryKind;
  readonly name?: I18nText;
  readonly description?: I18nText;
  readonly background?: I18nText;
  readonly location?: I18nText;
}

export interface WorldGalleryImage extends WorldGalleryFile, ImageSize {}

interface GalleryOptions {
  readonly worldRoot: string;
  readonly worldId: string;
  readonly covelHome?: string;
}

async function describeFile(
  absolutePath: string,
  types: Readonly<Record<string, string>> = IMAGE_TYPES,
): Promise<Pick<WorldGalleryFile, "mime" | "bytes" | "version"> | null> {
  const mime = types[path.extname(absolutePath).toLowerCase()];
  if (!mime) return null;
  const fileStat = await stat(absolutePath);
  if (
    !fileStat.isFile() ||
    fileStat.size === 0 ||
    fileStat.size > MAX_MEDIA_FILE_BYTES
  )
    return null;
  return {
    mime,
    bytes: fileStat.size,
    version: `${Math.trunc(fileStat.mtimeMs).toString(36)}-${fileStat.size.toString(36)}`,
  };
}

/**
 * The pictures of `media/gallery.json`, or null when the package has no such
 * file or it cannot be read as one. Text fields carry every language the
 * package has (`gallery.<locale>.json`), for the viewer to pick from.
 */
async function listManifestFiles(
  options: GalleryOptions,
  defaultLocale: string | undefined,
): Promise<WorldGalleryFile[] | null> {
  const manifestPath = await resolveContainedPath(
    options.worldRoot,
    GALLERY_MANIFEST,
    { rejectSymlinks: true },
  );
  if (!manifestPath) return null;
  let manifest: z.infer<typeof galleryManifestSchema>;
  try {
    if ((await stat(manifestPath)).size > MAX_MANIFEST_BYTES)
      throw new Error(`larger than ${MAX_MANIFEST_BYTES} bytes`);
    const base = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    const baseLocale =
      (base as { defaultLocale?: unknown } | null)?.defaultLocale ??
      defaultLocale;
    const compiled = await compileLocaleOverlays({
      root: options.worldRoot,
      relativePath: GALLERY_MANIFEST,
      base,
      baseLocale: typeof baseLocale === "string" ? baseLocale : undefined,
      arrayKey: "id",
    });
    manifest = galleryManifestSchema.parse(compiled.value);
  } catch (error) {
    // A broken gallery file must not take the world's pictures away.
    console.warn(
      `[world-gallery] ${options.worldId}: ${GALLERY_MANIFEST} is not usable, listing media sources instead:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  const files: WorldGalleryFile[] = [];
  const seen = new Set<string>();
  for (const image of manifest.images) {
    if (files.length >= MAX_GALLERY_FILES) break;
    // The gallery is seen before play: it shows nothing past the opening.
    if (image.spoilerLevel && image.spoilerLevel !== "opening") continue;
    // The display version when the package has one; paths are under `media/`.
    const relative = image.webFilename ?? image.filename;
    const segments = relative.split("/");
    if (
      segments.length !== 2 ||
      segments.some(
        (segment) => !segment || segment.startsWith(".") || segment === "..",
      ) ||
      seen.has(relative)
    )
      continue;
    const absolutePath = await resolveContainedPath(
      options.worldRoot,
      path.join("media", relative),
      { rejectSymlinks: true },
    );
    const described = absolutePath ? await describeFile(absolutePath) : null;
    if (!absolutePath || !described) continue;
    seen.add(relative);
    files.push({
      id: image.id,
      source: segments[0]!,
      file: segments[1]!,
      absolutePath,
      ...described,
      ...(image.kind ? { kind: image.kind } : {}),
      ...(image.name ? { name: image.name } : {}),
      ...(image.description ? { description: image.description } : {}),
      ...(image.background ? { background: image.background } : {}),
      ...(image.location ? { location: image.location } : {}),
    });
  }
  return files;
}

/** The raster images of the package's public media sources. */
async function listSourceFiles(
  options: GalleryOptions,
  worldDataPath: string | undefined,
): Promise<WorldGalleryFile[]> {
  const descriptor = await loadWorldDataDescriptor({
    worldRoot: options.worldRoot,
    worldDataPath,
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
      const described = await describeFile(absolutePath);
      if (!described) continue;
      const file = path.basename(absolutePath);
      files.push({
        id: `${source.id}/${file}`,
        source: source.id,
        file,
        absolutePath,
        ...described,
      });
    }
  }
  return files;
}

export async function listWorldGalleryFiles(
  options: GalleryOptions,
): Promise<WorldGalleryFile[]> {
  const manifest = await readWorldManifest(options.worldRoot);
  return (
    (await listManifestFiles(options, manifest.defaultLocale)) ??
    (await listSourceFiles(options, manifest.worldData))
  );
}

export type WorldThemeMusic = Pick<
  WorldGalleryFile,
  "source" | "file" | "absolutePath" | "mime" | "bytes" | "version"
>;

/**
 * The music `world.yaml` names for the world list (`themeMusic`), or null when
 * it names none or the file cannot be served: it must be an `.mp3` or `.wav`
 * file one directory under `media/`.
 */
export async function resolveWorldThemeMusic(
  options: Pick<GalleryOptions, "worldRoot">,
): Promise<WorldThemeMusic | null> {
  const declared = (await readWorldManifest(options.worldRoot)).themeMusic;
  const segments = declared?.split("/") ?? [];
  if (
    segments.length !== 3 ||
    segments[0] !== "media" ||
    segments.some(
      (segment) => !segment || segment.startsWith(".") || segment === "..",
    )
  )
    return null;
  const absolutePath = await resolveContainedPath(
    options.worldRoot,
    segments.join("/"),
    { rejectSymlinks: true },
  );
  const described = absolutePath
    ? await describeFile(absolutePath, AUDIO_TYPES)
    : null;
  if (!absolutePath || !described) return null;
  return {
    source: segments[1]!,
    file: segments[2]!,
    absolutePath,
    ...described,
  };
}

// Keyed by path and version, so an edited file is measured again.
const sizeCache = new Map<string, ImageSize | null>();
const SIZE_CACHE_LIMIT = 2000;

/** The gallery with pixel sizes; a file whose header cannot be read is left out. */
export async function listWorldGallery(
  options: GalleryOptions,
): Promise<WorldGalleryImage[]> {
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
