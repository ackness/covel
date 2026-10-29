import { expect, it } from "vitest";
import { parse } from "yaml";
import { convertStImport } from "../../src/world-import/st/convert.js";
import {
  convert,
  characterBook,
  v2Card,
  worldInfo,
} from "../helpers/st-card-fixtures.js";

it("combines standalone object and array books with character books", async () => {
  const result = await convert([
    worldInfo(),
    { name: "Array", entries: characterBook().entries },
    v2Card(),
  ]);
  expect(result.report.counts.loreEntries).toBe(3);
  const entries = parse(
    result.entries
      .find((entry) => entry.relativePath === "data/lorebook.yaml")!
      .content.toString(),
  );
  expect(new Set(entries.map((entry: { id: string }) => entry.id)).size).toBe(
    3,
  );
  for (const entry of entries) {
    expect(entry.content.trim()).not.toBe("");
    expect(entry.strategy === "constant" || entry.keys.length > 0).toBe(true);
  }
});
it.each([
  { label: "disabled", constant: true, disable: true, enabled: false },
  { label: "selective", constant: false, disable: false, enabled: true },
])(
  "keeps $label lore solely in the lorebook",
  async ({ constant, disable, enabled }) => {
    const content = "The forbidden beacon hides a sleeping dragon.";
    const result = await convert([
      worldInfo([{ key: ["beacon"], content, constant, disable }]),
    ]);
    const md = result.entries
      .find((entry) => entry.relativePath === "WORLD.md")
      ?.content.toString();
    expect(md).toContain("## Premise\n\nIsland almanac");
    expect(md).not.toContain(content);
    expect(result.report.world.summary).not.toContain(content);
    const entries = parse(
      result.entries
        .find((entry) => entry.relativePath === "data/lorebook.yaml")!
        .content.toString(),
    );
    expect(entries).toEqual([
      expect.objectContaining({
        content,
        keys: ["beacon"],
        enabled,
        strategy: constant ? "constant" : "selective",
      }),
    ]);
  },
);
it("maps activation, positions and depth, and aggregates unsupported features", async () => {
  const result = await convert([
    worldInfo([
      { key: ["/evil/gi"], content: "Skipped" },
      {
        keys: ["one", "one"],
        content: "One",
        constant: false,
        disable: true,
        position: 0,
        scanDepth: 99,
        secondary_keys: ["two"],
        selective: true,
        probability: 80,
      },
      {
        key: [],
        content: "Two",
        constant: true,
        position: "before_char",
        scanDepth: -10,
        keysecondary: ["one"],
        probability: 20,
      },
      {
        key: ["three"],
        content: "Three",
        position: "after_char",
        scanDepth: null,
      },
      { key: ["four"], content: "Four", position: 1 },
      { content: "", constant: true },
    ]),
  ]);
  const entries = parse(
    result.entries
      .find((entry) => entry.relativePath === "data/lorebook.yaml")!
      .content.toString(),
  );
  expect(entries).toHaveLength(4);
  expect(entries[0]).toMatchObject({
    keys: ["one"],
    enabled: false,
    position: "before_plugin",
    extra: { scanDepth: 20 },
  });
  expect(entries[1]).toMatchObject({
    strategy: "constant",
    position: "before_plugin",
    extra: { scanDepth: 0 },
  });
  expect(entries[2].extra).toBeUndefined();
  expect(entries[3].position).toBe("after_plugin");
  for (const feature of ["secondary-keys", "probability"])
    expect(result.report.items).toContainEqual(
      expect.objectContaining({
        code: "lorebook-feature-dropped",
        field: feature,
        count: 2,
      }),
    );
  expect(result.report.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "regex-keys-dropped" }),
      expect.objectContaining({ code: "entry-skipped-no-keys" }),
      expect.objectContaining({ code: "entries-skipped-empty" }),
    ]),
  );
});
it("uses unique ids for repeated source names", async () => {
  const result = await convert([worldInfo(), worldInfo()]);
  expect(
    result.entries
      .find((entry) => entry.relativePath === "data/lorebook.yaml")!
      .content.toString(),
  ).toContain("st-island-almanac-1-2");
});
it("drops entries beyond 2000", async () => {
  const result = await convert([
    worldInfo(
      Array.from({ length: 2002 }, () => ({ content: "Text", constant: true })),
    ),
  ]);
  expect(result.report.counts.loreEntries).toBe(2000);
  expect(result.report.items).toContainEqual(
    expect.objectContaining({ code: "entries-limit", count: 2 }),
  );
});
it("rejects a lorebook output larger than 2 MiB", async () => {
  const book = worldInfo(
    Array.from({ length: 120 }, () => ({
      content: "x".repeat(19000),
      constant: true,
    })),
  );
  await expect(convert([book])).rejects.toMatchObject({
    code: "lorebook-too-large",
  });
});
it("rejects unusable empty books and invalid inputs", async () => {
  await expect(convert([worldInfo([])])).rejects.toMatchObject({
    code: "no-usable-text",
  });
  await expect(convert([worldInfo([{ content: 7 }])])).rejects.toMatchObject({
    code: "lorebook-invalid",
  });
  await expect(
    convertStImport({
      files: [],
      locale: "en-US",
      isIdTaken: async () => false,
    }),
  ).rejects.toMatchObject({ code: "files-required" });
});
it("drops long regex keys before trimming literal keys and bounds key count", async () => {
  const result = await convert([
    worldInfo([
      {
        content: "Text",
        keys: [
          "/" + "x".repeat(250) + "/gi",
          ...Array.from({ length: 66 }, (_, i) => `${i} ${"k".repeat(220)}`),
        ],
      },
    ]),
  ]);
  const entries = parse(
    result.entries
      .find((entry) => entry.relativePath === "data/lorebook.yaml")!
      .content.toString(),
  );
  expect(entries[0].keys).toHaveLength(64);
  expect(entries[0].keys.every((key: string) => key.length <= 200)).toBe(true);
  expect(result.report.items).toContainEqual(
    expect.objectContaining({ code: "regex-keys-dropped", count: 1 }),
  );
});
it("defaults invalid insertion orders instead of persisting non-finite values", async () => {
  const result = await convert([
    worldInfo([
      { content: "Text", constant: true, insertion_order: "invalid" },
    ]),
  ]);
  const entries = parse(
    result.entries
      .find((entry) => entry.relativePath === "data/lorebook.yaml")!
      .content.toString(),
  );
  expect(entries[0].insertionOrder).toBe(100);
});
