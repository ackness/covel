import { describe, expect, it } from "vitest";
import {
  worldDataDescriptorSchema,
  worldManifestSchema,
} from "../src/index.js";

describe("world data schemas", () => {
  it("allows world.yaml to point at a world data descriptor", () => {
    const result = worldManifestSchema.safeParse({
      schemaVersion: "1",
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
      schemaVersion: "1",
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
      schemaVersion: "1",
      id: "unsafe-world",
      name: "Unsafe World",
      summary: "Unsafe locale",
      defaultLocale: "x/../../../docs/reference/i18n",
    });
    expect(traversal.success).toBe(false);
  });

  it("allows world.yaml to declare pluginPolicy presets and tag preferences", () => {
    const result = worldManifestSchema.safeParse({
      schemaVersion: "1.0",
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

  it("validates a minimal v1 descriptor", () => {
    const result = worldDataDescriptorSchema.safeParse({
      schemaVersion: 1,
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
          to: "plugin:character-blueprint/blueprints",
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
});
