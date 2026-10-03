import { describe, expect, it } from "vitest";
import {
  applyLocaleOverlay,
  findInlineLocaleMaps,
  isLocaleMapFor,
  splitLocaleMaps,
} from "../src/index.js";

const main = {
  id: "mistport",
  name: "雾港",
  version: 3,
  characterSchema: {
    attributes: [
      { id: "fogRot", name: "雾蚀", type: "number", max: 100 },
      { id: "origin", name: "出身", type: "string" },
    ],
  },
  openingChips: ["查看告示", "询问书记官"],
  tags: ["mystery"],
};
const english = {
  name: "Mistport",
  characterSchema: { attributes: [{ id: "fogRot", name: "Fog Rot" }] },
  openingChips: ["Read the notice"],
};
const compileOptions = {
  mode: "compile",
  locale: "en-US",
  baseLocale: "zh-CN",
} as const;

describe("applyLocaleOverlay", () => {
  it("compiles translated leaves into locale maps and leaves the rest alone", () => {
    const { value, issues } = applyLocaleOverlay(main, english, compileOptions);
    expect(issues).toEqual([]);
    expect(value).toEqual({
      id: "mistport",
      name: { "zh-CN": "雾港", "en-US": "Mistport" },
      version: 3,
      characterSchema: {
        attributes: [
          {
            id: "fogRot",
            name: { "zh-CN": "雾蚀", "en-US": "Fog Rot" },
            type: "number",
            max: 100,
          },
          // No translation: the main text is the fallback.
          { id: "origin", name: "出身", type: "string" },
        ],
      },
      openingChips: [
        { "zh-CN": "查看告示", "en-US": "Read the notice" },
        "询问书记官",
      ],
      tags: ["mystery"],
    });
  });

  it("adds a second overlay to the maps the first one made", () => {
    const first = applyLocaleOverlay(main, english, compileOptions).value;
    const { value, issues } = applyLocaleOverlay(
      first,
      { name: "Туманный порт" },
      { ...compileOptions, locale: "ru-RU" },
    );
    expect(issues).toEqual([]);
    expect((value as typeof main).name).toEqual({
      "zh-CN": "雾港",
      "en-US": "Mistport",
      "ru-RU": "Туманный порт",
    });
  });

  it("resolves to plain data in one language", () => {
    const { value, issues } = applyLocaleOverlay(main, english, {
      ...compileOptions,
      mode: "resolve",
    });
    expect(issues).toEqual([]);
    expect(value).toMatchObject({
      name: "Mistport",
      characterSchema: {
        attributes: [
          { id: "fogRot", name: "Fog Rot", type: "number", max: 100 },
          { id: "origin", name: "出身", type: "string" },
        ],
      },
      // A list of plain texts is translated as a whole.
      openingChips: ["Read the notice"],
    });
    expect(
      applyLocaleOverlay(
        main,
        { openingChips: [null, "Ask the clerk"] },
        { ...compileOptions, mode: "resolve" },
      ).value,
    ).toMatchObject({ openingChips: ["查看告示", "Ask the clerk"] });
  });

  it("accepts a full copy of the main file as an overlay", () => {
    const copy = structuredClone(main);
    copy.name = "Mistport";
    const { value, issues } = applyLocaleOverlay(main, copy, {
      ...compileOptions,
      mode: "resolve",
    });
    expect(issues).toEqual([]);
    expect(value).toEqual(copy);
    // Compiling a copy makes a map only where the text differs.
    expect(applyLocaleOverlay(main, copy, compileOptions).value).toMatchObject({
      id: "mistport",
      name: { "zh-CN": "雾港", "en-US": "Mistport" },
      tags: ["mystery"],
    });
  });

  it("reports what an overlay may not do and keeps the main value", () => {
    const { value, issues } = applyLocaleOverlay(
      main,
      {
        version: 4,
        subtitle: "Chronicles",
        characterSchema: {
          attributes: [{ id: "luck", name: "Luck" }],
        },
        tags: "mystery",
        name: { en: "Mistport" },
      },
      compileOptions,
    );
    expect(value).toEqual(main);
    expect(issues).toEqual([
      {
        path: "version",
        message: "changes a number; an overlay may only translate text",
      },
      { path: "subtitle", message: "is not in the main file" },
      {
        path: "characterSchema.attributes[id=luck]",
        message: "has no entry with this id in the main file",
      },
      { path: "tags", message: "gives text where the main file has a list" },
      {
        path: "name",
        message: "gives an object where the main file has a string",
      },
    ]);
  });
});

describe("splitLocaleMaps", () => {
  const inline = {
    id: "mistport",
    name: { "zh-CN": "雾港", "en-US": "Mistport" },
    characterSchema: {
      attributes: [
        {
          id: "fogRot",
          name: { "zh-CN": "雾蚀", "en-US": "Fog Rot" },
          type: "number",
        },
        { id: "origin", name: "出身", type: "string" },
      ],
    },
    openingChips: [
      "查看告示",
      { "zh-CN": "询问书记官", "en-US": "Ask the clerk" },
    ],
  };

  it("moves every other language into a sparse overlay", () => {
    const { base, overlays } = splitLocaleMaps(inline, "zh-CN");
    expect(base).toEqual({
      id: "mistport",
      name: "雾港",
      characterSchema: {
        attributes: [
          { id: "fogRot", name: "雾蚀", type: "number" },
          { id: "origin", name: "出身", type: "string" },
        ],
      },
      openingChips: ["查看告示", "询问书记官"],
    });
    expect(overlays).toEqual({
      "en-US": {
        name: "Mistport",
        characterSchema: { attributes: [{ id: "fogRot", name: "Fog Rot" }] },
        openingChips: [null, "Ask the clerk"],
      },
    });
  });

  it("round-trips: compiling the overlays gives the inline form back", () => {
    const { base, overlays } = splitLocaleMaps(inline, "zh-CN");
    const { value, issues } = applyLocaleOverlay(base, overlays["en-US"], {
      mode: "compile",
      locale: "en-US",
      baseLocale: "zh-CN",
    });
    expect(issues).toEqual([]);
    expect(value).toEqual(inline);
  });

  it("uses the map key that matches the base language, whatever its spelling", () => {
    expect(
      splitLocaleMaps({ label: { zh: "行囊", en: "Inventory" } }, "zh-CN"),
    ).toEqual({
      base: { label: "行囊" },
      overlays: { en: { label: "Inventory" } },
    });
  });
});

describe("inline locale maps", () => {
  it("needs a base-language key: short field names are also language codes", () => {
    expect(
      isLocaleMapFor({ "zh-CN": "雾蚀", "en-US": "Fog Rot" }, "zh-CN"),
    ).toBe(true);
    expect(isLocaleMapFor({ zh: "行囊", en: "Inventory" }, "zh-CN")).toBe(true);
    // `id` is Indonesian, `to` Tongan, `no` Norwegian.
    expect(isLocaleMapFor({ id: "fogRot" }, "zh-CN")).toBe(false);
    expect(isLocaleMapFor({ to: "lorebook", no: "x" }, "zh-CN")).toBe(false);
    expect(splitLocaleMaps({ ref: { id: "fogRot" } }, "zh-CN")).toEqual({
      base: { ref: { id: "fogRot" } },
      overlays: {},
    });
  });

  it("lists the inline maps left in a main file", () => {
    expect(
      findInlineLocaleMaps(
        {
          name: { "zh-CN": "雾港", "en-US": "Mistport" },
          attributes: [
            { id: "fogRot", name: { "zh-CN": "雾蚀", "en-US": "Fog Rot" } },
          ],
          tags: ["mystery"],
        },
        "zh-CN",
      ),
    ).toEqual([
      { path: "name", locales: ["zh-CN", "en-US"] },
      { path: "attributes[0].name", locales: ["zh-CN", "en-US"] },
    ]);
    expect(findInlineLocaleMaps({ name: "雾港" }, "zh-CN")).toEqual([]);
  });
});
