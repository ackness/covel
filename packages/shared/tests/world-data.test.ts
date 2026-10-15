import { describe, expect, it } from "vitest";
import {
  worldDataDescriptorSchema,
  worldDataDescriptorOverrideSchema,
  worldManifestSchema,
  validateWorldManifest,
} from "../src/index.js";

describe("world data schemas", () => {
  it("allows world.yaml to point at a world data descriptor", () => {
    const result = worldManifestSchema.safeParse({
      id: "haruka-academy",
      name: "Haruka Academy",
      summary: "A school world",
      defaultLocale: "zh-CN",
      worldData: "data/world.data.yaml",
    });
    expect(result.success).toBe(true);
  });

  it("canonicalizes locale fields and rejects path-like locale input", () => {
    const canonical = worldManifestSchema.safeParse({
      id: "locale-world",
      name: "Locale World",
      summary: "Locale test",
      defaultLocale: " ru_ru ",
    });
    expect(canonical.success).toBe(true);
    if (canonical.success) expect(canonical.data.defaultLocale).toBe("ru-RU");

    const traversal = worldManifestSchema.safeParse({
      id: "unsafe-world",
      name: "Unsafe World",
      summary: "Unsafe locale",
      defaultLocale: "x/../../../docs/reference/i18n",
    });
    expect(traversal.success).toBe(false);
  });

  it("allows world.yaml to name a built-in pack, its own plugins and a pitch", () => {
    const world = {
      id: "policy-world",
      name: "Policy World",
      summary: "World with plugin policy",
      defaultLocale: "zh-CN",
      tags: ["school"],
    };
    const result = worldManifestSchema.safeParse({
      ...world,
      pluginPolicy: {
        preset: "dialogue-mode",
        plus: ["affinity", "story-events"],
        pitch: {
          label: "Campus",
          description: "Dialogue with a route board.",
          reason: "Relationships drive the story.",
        },
        packs: ["dialogue-mode", "low-cost"],
        requires: ["narrative-engine@1"],
      },
    });
    expect(result.success).toBe(true);

    // A pack is named, not copied into the world.
    expect(
      worldManifestSchema.safeParse({
        ...world,
        pluginPolicy: {
          packs: [{ id: "custom-dialogue", requested: ["narrator"] }],
        },
      }).success,
    ).toBe(false);
  });

  it("validates a minimal descriptor", () => {
    const result = worldDataDescriptorSchema.safeParse({
      sources: {
        dimensions: {
          kind: "yaml",
          path: "data/dimensions.yaml",
          schema: "covel://world/dimensions",
          to: "world:metadata.dimensions",
        },
        cast: {
          kind: "json",
          path: "data/characters/cast.json",
          to: "contract:character-blueprints@1",
          key: "id",
          after: "dimensions",
          effects: ["characters"],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects numeric-like source ids", () => {
    const result = worldDataDescriptorSchema.safeParse({
      sources: {
        "1": {
          kind: "yaml",
          path: "data/foo.yaml",
          to: "world:metadata.foo",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown source fields", () => {
    const result = worldDataDescriptorSchema.safeParse({
      sources: {
        foo: {
          kind: "yaml",
          path: "data/foo.yaml",
          to: "world:metadata.foo",
          query: "select * from foo",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts descriptor overrides without a format version", () => {
    expect(
      worldDataDescriptorOverrideSchema.safeParse({
        sources: { cast: { enabled: false } },
      }).success,
    ).toBe(true);
  });

  it("keeps removed format fields outside the authoring contract", () => {
    expect(
      worldManifestSchema.safeParse({
        schemaVersion: "1.0",
        id: "old-world",
        name: "Old World",
        summary: "A world with an unused field",
        defaultLocale: "en-US",
      }).success,
    ).toBe(false);
    expect(
      worldDataDescriptorSchema.safeParse({ schemaVersion: 1, sources: {} })
        .success,
    ).toBe(false);
    expect(
      worldDataDescriptorOverrideSchema.safeParse({
        schemaVersion: 1,
        sources: {},
      }).success,
    ).toBe(false);
  });

  it("keeps known fields strict when loading ignores unknown root fields", () => {
    const manifest = {
      id: "sample-world",
      name: "Sample",
      summary: "A small world",
      defaultLocale: "en-US",
      schemaVersion: "1.0",
    };
    const options = { ignoreUnknownRootFields: true };
    const result = validateWorldManifest(manifest, options);
    expect(result.valid).toBe(true);
    expect(result.ignoredFields).toEqual(["schemaVersion"]);
    expect(result.data).not.toHaveProperty("schemaVersion");
    expect(validateWorldManifest({ ...manifest, id: 1 }, options).valid).toBe(
      false,
    );
    // An unknown key of pluginPolicy is reported and left out too…
    const typo = validateWorldManifest(
      { ...manifest, pluginPolicy: { typo: [], plus: ["affinity"] } },
      options,
    );
    expect(typo.valid).toBe(true);
    expect(typo.ignoredFields).toEqual(["schemaVersion", "pluginPolicy.typo"]);
    expect(typo.data).toMatchObject({ pluginPolicy: { plus: ["affinity"] } });
    // …while a known one written wrong drops the section with an error.
    const wrong = validateWorldManifest(
      { ...manifest, pluginPolicy: { plus: "affinity" } },
      options,
    );
    expect(wrong.valid).toBe(true);
    expect(wrong.data).not.toHaveProperty("pluginPolicy");
    expect(wrong.droppedSections).toEqual([
      expect.objectContaining({ path: "pluginPolicy.plus" }),
    ]);
  });
});
