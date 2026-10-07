import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWorldDataSource } from "../../src/world-data/source-reader.js";
import {
  findLocaleOverlays,
  readWorldManifestSource,
} from "../../src/world-data/locale-overlays.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import type { OrderedWorldDataSource } from "../../src/world-data/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function world(files: Record<string, string>): Promise<string> {
  const root = path.join(
    await mkdtemp(path.join(tmpdir(), "covel-overlays-")),
    "world",
  );
  roots.push(path.dirname(root));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

function source(root: string, relative: string): OrderedWorldDataSource {
  return {
    id: "items",
    origin: "world",
    overridden: false,
    order: 0,
    resolvedOrder: 0,
    pathOrigin: { descriptorRoot: root, origin: "world" },
    descriptor: {
      kind: "yaml",
      path: relative,
      to: "contract:inventory.items@1",
      key: "id",
    },
  };
}

const ITEMS = `
- id: lantern
  name: 提灯
  quantity: 1
- id: rope
  name: 麻绳
  quantity: 2
`;

describe("locale overlays of world files", () => {
  it("gives a session the main file with its own language's text", async () => {
    const root = await world({
      "data/items.yaml": ITEMS,
      // Only what is translated; structure and numbers come from the main file.
      "data/items.en.yaml": "- id: lantern\n  name: Lantern\n",
    });
    const items = source(root, "data/items.yaml");

    expect((await readWorldDataSource(items, "en-US")).value).toEqual([
      { id: "lantern", name: "Lantern", quantity: 1 },
      { id: "rope", name: "麻绳", quantity: 2 },
    ]);
    // A language with no overlay reads the main file.
    expect((await readWorldDataSource(items, "ru-RU")).value).toEqual([
      { id: "lantern", name: "提灯", quantity: 1 },
      { id: "rope", name: "麻绳", quantity: 2 },
    ]);
  });

  it("keeps nested translations attached to declared identities after insertion", async () => {
    const root = await world({
      "data/items.yaml": `id: world
blocks:
  - { label: new, displayName: 新块 }
  - { label: clues, displayName: 线索 }
  - { label: debts, displayName: 人情 }
`,
      "data/items.en.yaml": `blocks:
  - { label: debts, displayName: Debts }
  - { label: clues, displayName: Clues }
`,
    });
    const items = source(root, "data/items.yaml");
    const read = await readWorldDataSource(
      {
        ...items,
        descriptor: { ...items.descriptor, localeArrayKeys: ["label"] },
      },
      "en-US",
    );
    expect(read.diagnostics).toEqual([]);
    expect(read.value).toEqual({
      id: "world",
      blocks: [
        { label: "new", displayName: "新块" },
        { label: "clues", displayName: "Clues" },
        { label: "debts", displayName: "Debts" },
      ],
    });
  });

  it("uses regenerated portrait refs for an English Mistport session", async () => {
    const bundled = path.resolve(
      import.meta.dirname,
      "../../../../worlds/mistport/media",
    );
    const original = JSON.parse(
      await readFile(path.join(bundled, "presence.json"), "utf8"),
    );
    const portrait = original[0];
    portrait.avatar.id = "b".repeat(64);
    portrait.sprite.id = "b".repeat(64);
    const root = await world({
      "media/presence.json": JSON.stringify(original),
      "media/presence.en.json": await readFile(
        path.join(bundled, "presence.en.json"),
        "utf8",
      ),
    });
    const input = source(root, "media/presence.json");
    const read = await readWorldDataSource(
      {
        ...input,
        descriptor: { ...input.descriptor, kind: "json", key: "characterId" },
      },
      "en-US",
    );
    expect(read.diagnostics).toEqual([]);
    expect((read.value as typeof original)[0]).toMatchObject({
      characterId: portrait.characterId,
      displayName: "Lin Yuanzhou",
      avatar: { id: "b".repeat(64) },
      sprite: { id: "b".repeat(64) },
    });
  });

  it("warns about an overlay entry it cannot place and keeps the main text", async () => {
    const root = await world({
      "data/items.yaml": ITEMS,
      "data/items.en.yaml":
        "- id: lantern\n  name: Lantern\n  quantity: 9\n- id: torch\n  name: Torch\n",
    });
    const read = await readWorldDataSource(
      source(root, "data/items.yaml"),
      "en-US",
    );
    expect(read.value).toEqual([
      { id: "lantern", name: "Lantern", quantity: 1 },
      { id: "rope", name: "麻绳", quantity: 2 },
    ]);
    expect(read.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        path: "data/items.en.yaml",
        pointer: "[id=lantern].quantity",
        localeOverlay: true,
      }),
      expect.objectContaining({
        level: "warning",
        pointer: "[id=torch]",
      }),
    ]);
  });

  it("compiles every overlay into locale maps for the catalog", async () => {
    const root = await world({
      "world.yaml": `
schemaVersion: "1.0"
id: lamp
name: 提灯古冢
version: 0.1.0
summary: 灯灭了。
defaultLocale: zh-CN
supportedLocales: [zh-CN, en-US]
dimensions:
  alarm:
    name: 警戒
    schema: { type: string, x-i18n: true }
    initialValue: 平静
`,
      "world.en-US.yaml": `
name: Lantern Barrow
summary: The lamp went out.
dimensions:
  alarm:
    name: Alarm
    initialValue: Calm
`,
      "WORLD.md": "# 提灯古冢\n",
    });

    const manifest = await readWorldManifestSource(root);
    expect(manifest.issues).toEqual([]);
    expect(manifest.overlays.map((overlay) => overlay.locale)).toEqual([
      "en-US",
    ]);
    expect(manifest.base).toMatchObject({ name: "提灯古冢" });

    const record = await loadSingleWorld(root);
    // Lists and stores show one language; a session reads its own.
    expect(record).toMatchObject({
      name: "提灯古冢",
      description: "灯灭了。",
      metadata: {
        localizedText: {
          name: { "zh-CN": "提灯古冢", "en-US": "Lantern Barrow" },
          description: { "zh-CN": "灯灭了。", "en-US": "The lamp went out." },
        },
        dimensions: {
          alarm: {
            name: { "zh-CN": "警戒", "en-US": "Alarm" },
            initialValue: { "zh-CN": "平静", "en-US": "Calm" },
          },
        },
      },
    });
  });

  it("reads only files named by a locale as overlays", async () => {
    const root = await world({
      "data/items.yaml": ITEMS,
      "data/items.en-US.yaml": "[]",
      "data/items.backup.yaml": "[]",
      "data/items.en.json": "[]",
    });
    expect(
      (await findLocaleOverlays(root, "data/items.yaml")).map(
        (overlay) => overlay.file,
      ),
    ).toEqual(["data/items.en-US.yaml"]);
  });
});
