import { describe, expect, it } from "vitest";
import { runtimeManifestSchema } from "../src/schemas/plugin.js";

describe("plugin manifest dataSchemas", () => {
  it("normalizes keyed declarations into plugin data schema declarations", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "world-data-runtime",
      description: "World data runtime",
      priority: 500,
      dataSchemas: {
        relationships: {
          schemaVersion: 1,
          acceptsWorldData: true,
          schema: "./schemas/relationships.schema.json",
          description: "Relationship graph",
        },
      },
    });

    expect(manifest.dataSchemas).toEqual({
      relationships: {
        namespace: "relationships",
        schemaVersion: 1,
        acceptsWorldData: true,
        schema: "./schemas/relationships.schema.json",
        description: "Relationship graph",
      },
    });
  });

  it("rejects declarations whose namespace disagrees with the map key", () => {
    expect(() =>
      runtimeManifestSchema.parse({
        name: "world-data-runtime",
        description: "World data runtime",
        priority: 500,
        dataSchemas: {
          relationships: {
            namespace: "characters",
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/relationships.schema.json",
          },
        },
      }),
    ).toThrow(/namespace must match dataSchemas key/);
  });

  it("rejects schema paths outside the plugin package", () => {
    expect(() =>
      runtimeManifestSchema.parse({
        name: "world-data-runtime",
        description: "World data runtime",
        priority: 500,
        dataSchemas: {
          relationships: {
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "../relationships.schema.json",
          },
        },
      }),
    ).toThrow(/plugin-relative \.json path/);
  });
});
