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
      supportedLocales: ["ru_ru", "zh_hant_tw"],
    });
    expect(canonical.success).toBe(true);
    if (canonical.success) {
      expect(canonical.data.defaultLocale).toBe("ru-RU");
      expect(canonical.data.supportedLocales).toEqual(["ru-RU", "zh-Hant-TW"]);
    }

    const traversal = worldManifestSchema.safeParse({
      id: "unsafe-world",
      name: "Unsafe World",
      summary: "Unsafe locale",
      defaultLocale: "x/../../../docs/reference/i18n",
    });
    expect(traversal.success).toBe(false);
  });

  it("allows world.yaml to declare pluginPolicy presets and tag preferences", () => {
    const result = worldManifestSchema.safeParse({
      id: "policy-world",
      name: "Policy World",
      summary: "World with plugin policy",
      defaultLocale: "zh-CN",
      supportedLocales: ["zh-CN"],
      tags: ["school"],
      pluginPolicy: {
        presetId: "dialogue-mode",
        preferredTags: ["mode:dialogue", "role:character"],
        avoidedTags: ["mode:traditional-story"],
        packs: [
          {
            id: "custom-dialogue",
            label: "Custom Dialogue",
            requested: ["chat-mode-narrator", "scene-cast"],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
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
    expect(
      validateWorldManifest(
        { ...manifest, pluginPolicy: { typo: [] } },
        options,
      ).valid,
    ).toBe(false);
  });
});
