import { describe, expect, it } from "vitest";
import {
  runtimeManifestSchema,
  validateRuntimeManifestSemantics,
} from "../src/schemas/plugin.js";

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

  it("accepts a plugin-relative wires path and rejects traversal", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "tts-runtime",
      description: "TTS runtime",
      priority: 700,
      wires: "lib/wires.js",
    });
    expect(manifest.wires).toBe("lib/wires.js");

    expect(() =>
      runtimeManifestSchema.parse({
        name: "tts-runtime",
        description: "TTS runtime",
        wires: "../outside/wires.js",
      }),
    ).toThrow(/plugin-relative/);
  });

  it("accepts catalogue tags and relation metadata", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "dialogue-narrator",
      description: "Dialogue narrator",
      priority: 500,
      capabilities: ["narrative"],
      tags: ["mode:dialogue", "role:narrator", "cost:llm"],
      relations: {
        provides: ["narrative-engine"],
        requires: [{ capability: "scene-cast", reason: "Needs cast state" }],
        conflicts: ["narrator"],
      },
    });

    expect(manifest.tags).toEqual([
      "mode:dialogue",
      "role:narrator",
      "cost:llm",
    ]);
    expect(manifest.relations?.provides).toEqual(["narrative-engine"]);
  });
});

describe("plugin manifest semantic diagnostics", () => {
  it("warns when manual runtimes also declare priority", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "manual-tool",
      description: "Manual tool",
      priority: 700,
      trigger: { type: "manual" },
    });

    expect(validateRuntimeManifestSemantics(manifest)).toEqual([
      {
        code: "manual-trigger-priority",
        severity: "warning",
        path: ["priority"],
        message:
          "Runtime \"manual-tool\" declares trigger.type='manual' but also sets priority=700. Manual runtimes are UI-only and should omit priority entirely.",
      },
    ]);
  });

  it("does not warn for manual runtimes without priority", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "manual-tool",
      description: "Manual tool",
      trigger: { type: "manual" },
    });

    expect(validateRuntimeManifestSemantics(manifest)).toEqual([]);
  });
});
