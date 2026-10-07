// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { imageSizeOf } from "../../src/world-data/image-size.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";

/** The start of a PNG file: signature and the header chunk with its size. */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("GET /api/worlds/:id/gallery", () => {
  let home: string;
  let worlds: string;
  let store: DataStore;
  let app: Hono;

  const writeWorld = async (id: string, descriptor?: string) => {
    const dir = path.join(worlds, id);
    await mkdir(path.join(dir, "data"), { recursive: true });
    await writeFile(
      path.join(dir, "world.yaml"),
      `schemaVersion: "1.0"\nid: ${id}\nname: Ash Harbor\nsummary: A port.\ndefaultLocale: en-US\n${
        descriptor ? "worldData: data/world.data.yaml\n" : ""
      }`,
    );
    if (descriptor)
      await writeFile(path.join(dir, "data/world.data.yaml"), descriptor);
    return dir;
  };
  const register = async (dir: string) => {
    await store.createWorld((await loadSingleWorld(dir, { source: "file" }))!);
  };
  const items = async (id: string) =>
    (
      (await (await app.request(`/api/worlds/${id}/gallery`)).json()) as {
        items: { id: string; url: string; width: number; height: number }[];
      }
    ).items;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "covel-gallery-"));
    worlds = path.join(home, "worlds");
    store = createMemoryStore();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store" as never, store as never);
      c.set("worldsDirs" as never, [worlds] as never);
      await next();
    });
    app.route("/api/worlds", worldRoutes);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("lists the images of the package's media sources with their sizes", async () => {
    const dir = await writeWorld(
      "ash-harbor",
      [
        "schemaVersion: 1",
        "sources:",
        "  scenes:",
        "    kind: media",
        "    path: media/scenes",
        "    to: media",
        "    indexTo: contract:image-index@1",
        "  portraits:",
        "    kind: media",
        "    path: media/portraits",
        "    to: media",
        "    indexTo: contract:image-index@1",
        "  drafts:",
        "    kind: media",
        "    path: media/drafts",
        "    to: media",
        "    indexTo: contract:image-index@1",
        "    enabled: false",
        "",
      ].join("\n"),
    );
    for (const folder of ["scenes", "portraits", "drafts"])
      await mkdir(path.join(dir, "media", folder), { recursive: true });
    await writeFile(
      path.join(dir, "media/scenes/quay.png"),
      pngHeader(1536, 1024),
    );
    await writeFile(path.join(dir, "media/scenes/theme.mp3"), "not an image");
    await writeFile(path.join(dir, "media/scenes/broken.png"), "not a png");
    await writeFile(
      path.join(dir, "media/portraits/mara.png"),
      pngHeader(1024, 1536),
    );
    await writeFile(
      path.join(dir, "media/drafts/sketch.png"),
      pngHeader(10, 10),
    );
    await register(dir);

    const gallery = await items("ash-harbor");

    // Sources keep the descriptor's order; a file without a readable size,
    // a file that is no image and a disabled source are left out.
    expect(
      gallery.map(({ id, width, height }) => ({ id, width, height })),
    ).toEqual([
      { id: "scenes/quay.png", width: 1536, height: 1024 },
      { id: "portraits/mara.png", width: 1024, height: 1536 },
    ]);

    const image = await app.request(gallery[0]!.url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(
      pngHeader(1536, 1024),
    );

    const etag = image.headers.get("etag")!;
    const cached = await app.request(gallery[0]!.url, {
      headers: { "if-none-match": etag },
    });
    expect(cached.status).toBe(304);
  });

  it("serves only files the listing contains", async () => {
    const dir = await writeWorld(
      "ash-harbor",
      "schemaVersion: 1\nsources:\n  scenes:\n    kind: media\n    path: media/scenes\n    to: media\n    indexTo: contract:image-index@1\n  drafts:\n    kind: media\n    path: media/drafts\n    to: media\n    indexTo: contract:image-index@1\n    enabled: false\n",
    );
    await mkdir(path.join(dir, "media/scenes"), { recursive: true });
    await mkdir(path.join(dir, "media/drafts"), { recursive: true });
    await writeFile(path.join(dir, "media/scenes/quay.png"), pngHeader(4, 4));
    await writeFile(path.join(dir, "media/drafts/sketch.png"), pngHeader(4, 4));
    await writeFile(path.join(home, "secret.png"), pngHeader(4, 4));
    await symlink(
      path.join(home, "secret.png"),
      path.join(dir, "media/scenes/link.png"),
    );
    await register(dir);

    expect((await items("ash-harbor")).map((item) => item.id)).toEqual([
      "scenes/quay.png",
    ]);
    for (const url of [
      "/api/worlds/ash-harbor/gallery/drafts/sketch.png",
      "/api/worlds/ash-harbor/gallery/scenes/link.png",
      "/api/worlds/ash-harbor/gallery/scenes/..%2F..%2Fworld.yaml",
      "/api/worlds/ash-harbor/gallery/unknown/quay.png",
      "/api/worlds/other-world/gallery/scenes/quay.png",
    ])
      expect((await app.request(url)).status, url).toBe(404);
  });

  it("follows media/gallery.json when the package has one", async () => {
    const dir = await writeWorld("ash-harbor");
    await mkdir(path.join(dir, "media/gallery"), { recursive: true });
    await mkdir(path.join(dir, "media/portraits"), { recursive: true });
    for (const [file, width, height] of [
      ["gallery/quay.png", 1536, 1024],
      ["gallery/quay-web.png", 1536, 1024],
      ["gallery/late.png", 1536, 1024],
      ["portraits/mara.png", 1024, 1536],
      ["secret.png", 8, 8],
    ] as const)
      await writeFile(path.join(dir, "media", file), pngHeader(width, height));
    await writeFile(
      path.join(dir, "media/gallery.json"),
      JSON.stringify({
        schemaVersion: 1,
        defaultLocale: "en-US",
        images: [
          {
            id: "quay",
            kind: "scene",
            filename: "gallery/quay.png",
            webFilename: "gallery/quay-web.png",
            name: "The Quay",
            description: "Where the fires start.",
            spoilerLevel: "opening",
            sha256: "editorial fields are not read",
          },
          { id: "mara", kind: "portrait", filename: "portraits/mara.png" },
          // Past the opening, outside `media/`, not in a directory: not shown.
          { id: "late", filename: "gallery/late.png", spoilerLevel: "ending" },
          { id: "escape", filename: "../world.yaml" },
          { id: "flat", filename: "secret.png" },
          // A kind this version does not know is still a picture.
          { id: "poster", kind: "poster", filename: "gallery/quay.png" },
        ],
      }),
    );
    await writeFile(
      path.join(dir, "media/gallery.zh-CN.json"),
      JSON.stringify({
        images: [{ id: "quay", name: "码头", description: "火从这里烧起。" }],
      }),
    );
    await register(dir);

    const gallery = (await items("ash-harbor")) as unknown as Record<
      string,
      unknown
    >[];

    expect(gallery.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "quay", kind: "scene" },
      { id: "mara", kind: "portrait" },
      { id: "poster", kind: undefined },
    ]);
    // Every language of the package; the display version of the file.
    expect(gallery[0]).toMatchObject({
      name: { "en-US": "The Quay", "zh-CN": "码头" },
      description: {
        "en-US": "Where the fires start.",
        "zh-CN": "火从这里烧起。",
      },
      width: 1536,
      height: 1024,
    });
    expect(String(gallery[0]!.url)).toContain("/gallery/gallery/quay-web.png");
    expect((await app.request(String(gallery[0]!.url))).status).toBe(200);
    for (const url of [
      "/api/worlds/ash-harbor/gallery/gallery/late.png",
      "/api/worlds/ash-harbor/gallery/media/secret.png",
    ])
      expect((await app.request(url)).status, url).toBe(404);
  });

  it("lists the media sources when gallery.json cannot be read", async () => {
    const dir = await writeWorld(
      "ash-harbor",
      "schemaVersion: 1\nsources:\n  scenes:\n    kind: media\n    path: media/scenes\n    to: media\n    indexTo: contract:image-index@1\n",
    );
    await mkdir(path.join(dir, "media/scenes"), { recursive: true });
    await writeFile(path.join(dir, "media/scenes/quay.png"), pngHeader(4, 4));
    await writeFile(path.join(dir, "media/gallery.json"), "{ not json");
    await register(dir);

    expect((await items("ash-harbor")).map((item) => item.id)).toEqual([
      "scenes/quay.png",
    ]);
  });

  it("offers the theme music world.yaml names, and nothing it cannot play", async () => {
    const writeThemed = async (id: string, themeMusic: string) => {
      const dir = await writeWorld(id);
      await writeFile(
        path.join(dir, "world.yaml"),
        `schemaVersion: "1.0"\nid: ${id}\nname: Ash Harbor\nsummary: A port.\ndefaultLocale: en-US\nthemeMusic: ${themeMusic}\n`,
      );
      await mkdir(path.join(dir, "media/music"), { recursive: true });
      await writeFile(path.join(dir, "media/music/theme.mp3"), "ID3 theme");
      await writeFile(path.join(dir, "media/music/notes.txt"), "not music");
      await register(dir);
      return (await (
        await app.request(`/api/worlds/${id}/gallery`)
      ).json()) as { themeMusic?: { url: string; mime: string } };
    };

    const { themeMusic } = await writeThemed(
      "ash-harbor",
      "media/music/theme.mp3",
    );
    expect(themeMusic).toMatchObject({ mime: "audio/mpeg" });
    const audio = await app.request(themeMusic!.url);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(await audio.text()).toBe("ID3 theme");

    // Not audio, outside `media/<directory>/`, or missing: no theme.
    for (const [id, declared] of [
      ["text-theme", "media/music/notes.txt"],
      ["root-theme", "world.yaml"],
      ["escape-theme", "media/music/../../world.yaml"],
      ["missing-theme", "media/music/absent.mp3"],
    ] as const)
      expect((await writeThemed(id, declared)).themeMusic, id).toBeUndefined();
    expect(
      (await app.request("/api/worlds/text-theme/gallery/music/notes.txt"))
        .status,
    ).toBe(404);
    // An audio file the world does not name as its theme is not served.
    expect(
      (await app.request("/api/worlds/missing-theme/gallery/music/theme.mp3"))
        .status,
    ).toBe(404);
  });

  it("answers with no images for a world without a package", async () => {
    await register(await writeWorld("ash-harbor"));
    await store.createWorld({
      ...(await store.getWorld("ash-harbor"))!,
      id: "store-only",
    });

    expect(await items("ash-harbor")).toEqual([]);
    expect(await items("store-only")).toEqual([]);
    expect((await app.request("/api/worlds/missing/gallery")).status).toBe(404);
  });
});

describe("imageSizeOf", () => {
  it("reads the size from JPEG and WebP headers", () => {
    // SOI, an APP0 segment to skip, then a baseline frame of 640×480.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(imageSizeOf(jpeg)).toEqual({ width: 640, height: 480 });

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8X", 12, "latin1");
    webp.writeUIntLE(1535, 24, 3);
    webp.writeUIntLE(1023, 27, 3);
    expect(imageSizeOf(webp)).toEqual({ width: 1536, height: 1024 });

    expect(imageSizeOf(Buffer.from("<svg></svg>"))).toBeNull();
  });
});
