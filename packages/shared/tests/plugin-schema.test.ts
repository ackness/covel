import { describe, expect, it } from "vitest";
import {
  runtimeManifestSchema,
  validateRuntimeManifestSemantics,
} from "../src/schemas/plugin.js";
import { PLUGIN_SCOPED_FIELDS } from "../src/types/plugin.js";

describe("plugin manifest dataSchemas", () => {
  it("normalizes keyed declarations into plugin data schema declarations", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "world-data-runtime",
      description: "World data runtime",
      stage: "narrative",
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
        stage: "narrative",
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
        stage: "narrative",
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
      stage: "post-turn",
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
      stage: "narrative",
      capabilities: ["narrative"],
      tags: ["mode:dialogue", "role:narrator", "cost:llm"],
      relations: {
        provides: ["narrative-engine"],
        // Needs cast state — the rationale lives in a comment now that a
        // relation entry is just the id.
        requires: ["scene-cast"],
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
  it("does not warn for manual runtimes without priority", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "manual-tool",
      description: "Manual tool",
      trigger: { type: "manual" },
    });

    expect(validateRuntimeManifestSemantics(manifest)).toEqual([]);
  });

  it("warns when a capability looks like a misspelled framework-known tag", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "typo-plugin",
      description: "Typo plugin",
      stage: "narrative",
      capabilities: ["narrativee"],
    });

    const diagnostics = validateRuntimeManifestSemantics(manifest);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("capability-typo");
    expect(diagnostics[0].message).toContain('"narrativee"');
    expect(diagnostics[0].message).toContain('"narrative"');
  });

  it("does not warn for exact framework-known or clearly custom capabilities", () => {
    const manifest = runtimeManifestSchema.parse({
      name: "ok-plugin",
      description: "OK plugin",
      stage: "narrative",
      capabilities: ["narrative", "world-data-provider", "battle-simulator"],
    });

    expect(validateRuntimeManifestSemantics(manifest)).toEqual([]);
  });
});

describe("plugin-scoped field registry", () => {
  // The registry exists so a new plugin-scoped field cannot be added without
  // stating how it merges — `userSettings` shipped with no conflict handling
  // precisely because that decision had no home. The type-level exhaustiveness
  // check enforces membership at compile time; this pins the payload so a
  // silent edit to a merge rule shows up as a failing test.
  it("registers every field the manifest declares as plugin-scoped", () => {
    expect(Object.keys(PLUGIN_SCOPED_FIELDS).sort()).toEqual([
      "dataSchemas",
      "displayName",
      "entry",
      "events",
      "memoryBlocks",
      "relations",
      "tags",
      "userSettings",
      "wires",
    ]);
  });

  it("keeps the strictest conflict rules where the framework enforces them", () => {
    // dataSchemas is the only field that hard-fails; userSettings warns.
    expect(PLUGIN_SCOPED_FIELDS.dataSchemas.conflict).toMatch(/throw/i);
    expect(PLUGIN_SCOPED_FIELDS.userSettings.conflict).toMatch(/warn/i);
    // entry/wires read as single-declaration fields but are additive.
    expect(PLUGIN_SCOPED_FIELDS.entry.merge).toBe("union");
    expect(PLUGIN_SCOPED_FIELDS.wires.merge).toBe("union");
    // displayName is the sole root-only field.
    expect(PLUGIN_SCOPED_FIELDS.displayName.merge).toBe("root-only");
  });

  it("points every field at the code implementing its merge", () => {
    for (const [field, spec] of Object.entries(PLUGIN_SCOPED_FIELDS)) {
      expect(spec.where, `${field} must name its implementation`).toMatch(
        /^(apps|packages)\/.+\.ts/,
      );
      expect(
        spec.conflict.length,
        `${field} must describe conflicts`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("plugin manifest relations", () => {
  const base = {
    name: "relating-plugin",
    description: "Relating plugin",
    stage: "narrative" as const,
  };

  it("accepts plugin ids and pluginId/runtimeId strings", () => {
    const manifest = runtimeManifestSchema.parse({
      ...base,
      relations: {
        provides: ["narrative-engine"],
        requires: ["scene-cast", "npc-graph/extractor"],
        conflicts: ["narrator"],
      },
    });

    expect(manifest.relations?.requires).toEqual([
      "scene-cast",
      "npc-graph/extractor",
    ]);
  });

  // Every object spelling is gone: they were interchangeable ways to write one
  // id, and the extra keys (`type` / `optional` / `reason`) had no consumer.
  it.each([
    ["plugin", { requires: [{ plugin: "scene-cast" }] }],
    ["runtime", { requires: [{ runtime: "npc-graph/extractor" }] }],
    ["target string", { requires: [{ target: "scene-cast" }] }],
    ["target object", { requires: [{ target: { plugin: "scene-cast" } }] }],
    ["capability", { requires: [{ capability: "narrative" }] }],
    ["tag", { recommends: [{ tag: "mode:dialogue" }] }],
    ["metadata only", { requires: [{ optional: true, reason: "why" }] }],
  ])("rejects the removed object form: %s", (_label, relations) => {
    expect(() => runtimeManifestSchema.parse({ ...base, relations })).toThrow();
  });

  it("rejects an empty id", () => {
    expect(() =>
      runtimeManifestSchema.parse({ ...base, relations: { requires: [""] } }),
    ).toThrow();
  });
});
