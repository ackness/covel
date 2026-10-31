import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  compilePluginTheme,
  isPluginThemeBitmap,
  diskPluginThemeFiles,
  discoverPluginAt,
  loadPluginDefinition,
  loadPluginUiSpecs,
  parsePluginMd,
  validatePluginFiles,
  validatePluginPackage,
} from "../src/index.js";
import { readMessageCatalogs } from "../src/locale-messages.js";
import { planPluginAssetRoot } from "../src/ui-assets.js";
const fixture = path.resolve(
  import.meta.dirname,
  "../../../tests/third-party/theme-pack-probe",
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "theme-loader-"));
  roots.push(base);
  const root = path.join(base, "theme-pack-probe");
  await cp(fixture, root, { recursive: true });
  return root;
}
async function put(root: string, file: string, value: string | Uint8Array) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), value);
}
async function definition(root: string) {
  const found = await discoverPluginAt(root);
  if (!found) throw new Error("fixture undiscovered");
  return loadPluginDefinition(found);
}
async function load(root: string) {
  const d = await definition(root);
  return loadPluginUiSpecs(
    root,
    d.packageManifest.plugin.id,
    d.packageManifest.manifest.ui,
  );
}
async function archive(root: string) {
  const entries = new Map<string, Uint8Array>();
  const visit = async (relative: string) => {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else entries.set(name, await readFile(path.join(root, name)));
    }
  };
  await visit("");
  const files = {
    read(relative: string, limit: number) {
      const data = entries.get(relative.replace(/^\.\//, ""));
      if (!data || data.byteLength > limit)
        throw new Error("missing or oversized archive entry");
      return data;
    },
    list(relative: string) {
      const prefix = relative.replace(/^\.\//, "") + "/";
      return [...entries]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, data]) => ({
          relativePath: name.slice(prefix.length),
          size: data.byteLength,
        }))
        .reverse();
    },
  };
  const parsed = parsePluginMd(
    Buffer.from(entries.get("PLUGIN.md")!).toString("utf8"),
    path.join(root, "PLUGIN.md"),
  );
  const validate = () =>
    validatePluginFiles(
      parsed,
      [],
      (absolute) =>
        Buffer.from(
          files.read(path.relative(root, absolute), Infinity),
        ).toString("utf8"),
      undefined,
      files,
    );
  return { files, validate };
}
it("loads a localized zero-runtime package through real static manifests and compiles the CSS", async () => {
  const root = await setup();
  const d = await definition(root);
  expect(d.manifests).toEqual([]);
  expect(d.executionAssessment?.mode).toBe("declarative");
  expect(d.packageManifest.manifest.ui?.theme).toEqual([
    "./ui/reading-theme.json",
  ]);
  const loaded = await load(root);
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.themes[0]?.label).toEqual({ en: "Reading room", zh: "阅读室" });
  expect(loaded.themes[0]?.cssText).toContain(
    '[data-covel-theme-part="story"]',
  );
  expect(loaded.themes[0]?.cssText).not.toContain(".story");
  expect(loaded.themes[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(loaded.assets[0]).toMatchObject({ purpose: "theme" });
  expect(loaded.assets[0]?.entry).toBeUndefined();
  expect((await validatePluginPackage(root)).issues).toEqual([]);
});
it("uses the same byte compiler for disk, archive adapters and static validation", async () => {
  const root = await setup();
  const a = await archive(root);
  expect(a.validate).not.toThrow();
  const catalogs = await readMessageCatalogs(root);
  const disk = compilePluginTheme({
    pluginId: "theme-pack-probe",
    declaredPath: "./ui/reading-theme.json",
    files: diskPluginThemeFiles(root),
    catalogs,
  });
  const zipped = compilePluginTheme({
    pluginId: "theme-pack-probe",
    declaredPath: "./ui/reading-theme.json",
    files: a.files,
    catalogs,
  });
  expect(zipped.theme).toEqual(disk.theme);
  expect([...zipped.asset!.files]).toEqual([...disk.asset!.files]);
  await put(root, "ui/reading-theme.css", ".story{position:fixed}");
  expect((await validatePluginPackage(root)).ok).toBe(false);
  expect((await archive(root)).validate).toThrow("property is not allowed");
});
it("fails closed when static adapters cannot inspect bitmap bytes", async () => {
  const root = await setup();
  const { packageManifest } = await definition(root);
  expect(() => validatePluginFiles(packageManifest, [], () => "")).toThrow(
    "theme",
  );
});
it.each(["ui/reading-theme.css", "ui/reading-assets/paper.png"])(
  "isolates a missing %s from a valid sibling and view",
  async (missing) => {
    const root = await setup();
    await rm(path.join(root, missing));
    await put(
      root,
      "ui/good.json",
      JSON.stringify({
        id: "good",
        label: "Good",
        layout: { preset: "stage" },
      }),
    );
    await put(
      root,
      "ui/view.json",
      JSON.stringify({
        id: "ordinary",
        label: "Ordinary",
        view: { component: "Text", props: { content: "Visible" } },
      }),
    );
    const loaded = await loadPluginUiSpecs(root, "theme-pack-probe", {
      theme: ["./ui/reading-theme.json", "./ui/good.json"],
      view: ["./ui/view.json"],
    });
    expect(loaded.themes.map((theme) => theme.id)).toEqual(["good"]);
    expect(loaded.slots.view).toHaveLength(1);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(JSON.stringify(loaded.diagnostics)).not.toContain(root);
  },
);
it.each([
  "<svg><script>alert(1)</script></svg>",
  "<!doctype html><h1>page</h1>",
])(
  "rejects disguised bitmap bytes on disk and archive (%#)",
  async (content) => {
    const root = await setup();
    await put(root, "ui/reading-assets/paper.png", content);
    expect((await load(root)).themes).toEqual([]);
    expect((await validatePluginPackage(root)).ok).toBe(false);
    expect((await archive(root)).validate).toThrow("bitmap");
  },
);
it("does not publish HTML, scripts, SVG or fonts from theme roots", async () => {
  const root = await setup();
  for (const name of ["page.html", "app.js", "vector.svg", "font.woff2"])
    await put(root, `ui/reading-assets/${name}`, "not public");
  const loaded = await load(root);
  expect(loaded.diagnostics).toEqual([]);
  expect([...loaded.assets[0]!.files.keys()]).toEqual(["paper.png"]);
  expect((await definition(root)).executionAssessment?.mode).toBe("code");
});
it("keeps first valid IDs across declarations and permits another owner to use the same local ID", async () => {
  const root = await setup();
  await put(
    root,
    "ui/bad.json",
    JSON.stringify({ id: "reading", label: "Invalid", css: "ui/missing.css" }),
  );
  const loaded = await loadPluginUiSpecs(root, "theme-pack-probe", {
    theme: [
      "./ui/bad.json",
      "./ui/reading-theme.json",
      "./ui/reading-theme.json",
    ],
  });
  expect(loaded.themes).toHaveLength(1);
  expect(loaded.diagnostics).toHaveLength(2);
  const other = await loadPluginUiSpecs(root, "other-owner", {
    theme: ["./ui/reading-theme.json"],
  });
  expect(other.themes[0]?.id).toBe("reading");
  expect(other.themes[0]?.contentHash).not.toBe(loaded.themes[0]?.contentHash);
});
it("content identity covers exact CSS, same-size bitmaps, metadata and translations", async () => {
  const root = await setup();
  const hash = async () => (await load(root)).themes[0]!.contentHash;
  const initial = await hash();
  expect(await hash()).toBe(initial);
  const file = path.join(root, "ui/reading-assets/paper.png");
  const bytes = await readFile(file);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(file, bytes);
  const bitmapHash = await hash();
  expect(bitmapHash).not.toBe(initial);
  const css = await readFile(path.join(root, "ui/reading-theme.css"), "utf8");
  await put(root, "ui/reading-theme.css", css.replace("1.8", "1.9"));
  const cssHash = await hash();
  expect(cssHash).not.toBe(bitmapHash);
  const json = await readFile(path.join(root, "ui/reading-theme.json"), "utf8");
  await put(
    root,
    "ui/reading-theme.json",
    json.replace("Reading room", "Reading nook"),
  );
  const metadataHash = await hash();
  expect(metadataHash).not.toBe(cssHash);
  await put(root, "ui/reading-theme.json", json);
  await put(root, "locales/zh.yaml", "messages:\n  Reading room: 读书室\n");
  expect(await hash()).not.toBe(cssHash);
});
it("bounds JSON and CSS reads before parsing", async () => {
  const root = await setup();
  await put(root, "ui/reading-theme.json", " ".repeat(32 * 1024 + 1));
  expect((await load(root)).themes).toEqual([]);
  expect((await archive(root)).validate).toThrow("bounded");
  const root2 = await setup();
  await put(root2, "ui/reading-theme.css", " ".repeat(64 * 1024 + 1));
  expect((await load(root2)).themes).toEqual([]);
  expect((await archive(root2)).validate).toThrow("bounded");
});
it("enforces asset count, single-file and total byte limits", async () => {
  const image = { relativePath: "a.png", size: 2 * 1024 * 1024 };
  expect(planPluginAssetRoot([image], { purpose: "theme" }).issues).toEqual([]);
  expect(
    planPluginAssetRoot([{ ...image, size: image.size + 1 }], {
      purpose: "theme",
    }).issues,
  ).not.toEqual([]);
  expect(
    planPluginAssetRoot(
      Array.from({ length: 32 }, (_, i) => ({
        relativePath: `${i}.png`,
        size: 1,
      })),
      { purpose: "theme" },
    ).issues,
  ).toEqual([]);
  for (const [count, size] of [
    [33, 1],
    [5, 2 * 1024 * 1024],
  ] as const)
    expect(
      planPluginAssetRoot(
        Array.from({ length: count }, (_, i) => ({
          relativePath: `${i}.png`,
          size,
        })),
        { purpose: "theme" },
      ).issues,
    ).not.toEqual([]);
  const root = await setup();
  const bytes = await readFile(path.join(root, "ui/reading-assets/paper.png"));
  for (let i = 0; i < 32; i++)
    await put(root, `ui/reading-assets/${i}.png`, bytes);
  expect((await load(root)).themes).toEqual([]);
  expect((await archive(root)).validate).toThrow("32 listed files");
});
it.each([
  ".",
  "../outside",
  "./ui/../ui/reading-assets",
  "./node_modules/art",
  "./ui/__covel__",
])("refuses asset-root path %s", async (relative) => {
  const root = await setup();
  const json = JSON.parse(
    await readFile(path.join(root, "ui/reading-theme.json"), "utf8"),
  );
  json.assets.root = relative;
  await put(root, "ui/reading-theme.json", JSON.stringify(json));
  expect((await load(root)).themes).toEqual([]);
  expect((await archive(root)).validate).toThrow("invalid theme field");
});
it("refuses reserved directories even when empty", async () => {
  const root = await setup();
  await mkdir(path.join(root, "ui/reading-assets/__covel__"));
  expect((await load(root)).themes).toEqual([]);
});
it.skipIf(process.platform === "win32")(
  "rejects linked descriptors, CSS, bitmaps and parent directories",
  async () => {
    for (const name of [
      "ui/reading-theme.json",
      "ui/reading-theme.css",
      "ui/reading-assets/paper.png",
      "ui/reading-assets",
    ]) {
      const root = await setup();
      const outside = await setup();
      await rm(path.join(root, name), { recursive: true });
      await symlink(
        path.join(outside, name),
        path.join(root, name),
        name.endsWith("assets") ? "dir" : "file",
      );
      expect(
        (
          await loadPluginUiSpecs(root, "theme-pack-probe", {
            theme: ["./ui/reading-theme.json"],
          })
        ).themes,
      ).toEqual([]);
      expect((await validatePluginPackage(root)).ok).toBe(false);
    }
  },
);

it("includes original CSS bytes in identity even when decoding removes a BOM", async () => {
  const root = await setup();
  const before = (await load(root)).themes[0]!;
  const file = path.join(root, "ui/reading-theme.css");
  const bytes = await readFile(file);
  await writeFile(file, Buffer.concat([Buffer.from([239, 187, 191]), bytes]));
  expect((await load(root)).themes[0]!.contentHash).not.toBe(
    before.contentHash,
  );
});
it.each(["individual", "combined"])(
  "enforces %s bitmap byte bounds through real disk and static adapters",
  async (kind) => {
    const root = await setup();
    const image = await readFile(
      path.join(root, "ui/reading-assets/paper.png"),
    );
    const bytes = Buffer.alloc(
      2 * 1024 * 1024 + (kind === "individual" ? 1 : 0),
    );
    image.copy(bytes);
    await put(root, "ui/reading-assets/paper.png", bytes);
    if (kind === "combined")
      for (let index = 0; index < 4; index++)
        await put(root, `ui/reading-assets/${index}.png`, bytes);
    expect((await load(root)).themes).toEqual([]);
    expect((await validatePluginPackage(root)).ok).toBe(false);
    expect((await archive(root)).validate).toThrow(
      kind === "individual" ? "2 MiB" : "8 MiB",
    );
  },
);

it("checks every permitted bitmap signature against the exact MIME bytes", async () => {
  const root = await setup();
  const png = await readFile(path.join(root, "ui/reading-assets/paper.png"));
  const jpeg = Buffer.from([255, 216, 255, 224, 255, 217]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(7)]);
  const webp = Buffer.alloc(20);
  webp.write("RIFF");
  webp.write("WEBP", 8);
  webp.write("VP8 ", 12);
  const avif = Buffer.alloc(24);
  avif.writeUInt32BE(24);
  avif.write("ftyp", 4);
  avif.write("avif", 8);
  const images = [
    { bytes: png, mime: "image/png" },
    { bytes: jpeg, mime: "image/jpeg" },
    { bytes: gif, mime: "image/gif" },
    { bytes: webp, mime: "image/webp" },
    { bytes: avif, mime: "image/avif" },
  ];
  for (const image of images) {
    expect(isPluginThemeBitmap(image.bytes, image.mime)).toBe(true);
    for (const other of images)
      if (other.mime !== image.mime)
        expect(isPluginThemeBitmap(image.bytes, other.mime)).toBe(false);
  }
  const highBits = Buffer.from(gif);
  highBits[0] = highBits[0]! | 128;
  expect(isPluginThemeBitmap(highBits, "image/gif")).toBe(false);
});

it("rejects duplicate manifest theme IDs statically while discovery keeps the first valid one", async () => {
  const root = await setup();
  const declaration = await readFile(path.join(root, "PLUGIN.md"), "utf8");
  await put(
    root,
    "PLUGIN.md",
    declaration.replace(
      "[./ui/reading-theme.json]",
      "[./ui/reading-theme.json, ./ui/copy.json]",
    ),
  );
  await put(
    root,
    "ui/copy.json",
    await readFile(path.join(root, "ui/reading-theme.json")),
  );
  const loaded = await load(root);
  expect(loaded.themes).toHaveLength(1);
  expect(loaded.assets).toHaveLength(1);
  expect(loaded.diagnostics).toContainEqual(
    expect.objectContaining({
      slot: "theme",
      issues: [{ path: "id", message: "duplicate theme id" }],
    }),
  );
  const report = await validatePluginPackage(root);
  expect(report.ok).toBe(false);
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("duplicate theme id"),
    }),
  );
  expect((await archive(root)).validate).toThrow("duplicate theme id");
});
