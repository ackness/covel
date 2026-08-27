import { describe, expect, it } from "vitest";
import {
  validateWorldIRV1,
  WORLD_IR_V1_JSON_SCHEMA,
  WORLD_IR_V1_SCHEMA_URI,
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
        preset: "dialogue-mode",
        preferTags: ["mode:dialogue", "role:character"],
        avoidTags: ["mode:traditional-story"],
        requireCapabilities: ["narrative"],
        packs: [
          {
            id: "custom-dialogue",
            label: "Custom Dialogue",
            plugins: ["chat-mode-narrator", "scene-cast"],
            excludedPlugins: ["narrator"],
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

  it("publishes one canonical JSON Schema for the WorldIR URI", () => {
    expect(WORLD_IR_V1_JSON_SCHEMA.$id).toBe(WORLD_IR_V1_SCHEMA_URI);
    expect(Object.isFrozen(WORLD_IR_V1_JSON_SCHEMA.properties.entities)).toBe(
      true,
    );
  });

  it("rejects duplicate WorldIR ids and dangling entity references", () => {
    const result = validateWorldIRV1({
      schemaVersion: 1,
      entities: [{ id: "alice", type: "character" }],
      relations: [
        {
          id: "alice",
          type: "TRUSTS",
          from: "alice",
          to: "missing",
        },
      ],
      events: [],
      statements: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.code)).toEqual(
        expect.arrayContaining(["duplicate_id", "dangling_reference"]),
      );
    }
  });

  it("rejects deeply nested attributes without overflowing the stack", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 3_000; index++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(() =>
      validateWorldIRV1({
        schemaVersion: 1,
        entities: [{ id: "deep", type: "concept", attributes: { root } }],
        relations: [],
        events: [],
        statements: [],
      }),
    ).not.toThrow();
    const result = validateWorldIRV1({
      schemaVersion: 1,
      entities: [{ id: "deep", type: "concept", attributes: { root } }],
      relations: [],
      events: [],
      statements: [],
    });
    expect(result).toEqual(
      expect.objectContaining({
        valid: false,
        errors: [expect.objectContaining({ code: "too_deep" })],
      }),
    );
  });

  it("returns a diagnostic for hostile values instead of throwing", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("blocked ownKeys");
        },
      },
    );

    expect(() => validateWorldIRV1(hostile)).not.toThrow();
    expect(validateWorldIRV1(hostile)).toMatchObject({
      valid: false,
      errors: [{ code: "inspection_failed" }],
    });
  });

  it("enforces bounded collection sizes in both canonical validators", () => {
    const tooManyEntities = {
      schemaVersion: 1,
      entities: Array.from({ length: 33 }, (_, index) => ({
        id: `entity-${index}`,
        type: "concept",
      })),
      relations: [],
      events: [],
      statements: [],
    };

    expect(validateWorldIRV1(tooManyEntities)).toMatchObject({ valid: false });
    expect(WORLD_IR_V1_JSON_SCHEMA.properties.entities.maxItems).toBe(32);
  });
});
