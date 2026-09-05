import { describe, expect, it } from "vitest";
import {
  runtimeManifestInputSchema,
  validateRuntimeManifestSemantics,
} from "../src/schemas/plugin.js";
import { PLUGIN_SCOPED_FIELDS } from "../src/types/plugin.js";

describe("plugin manifest dataSchemas", () => {
  it("accepts scoped slash commands and rejects malformed arguments", () => {
    const manifest = runtimeManifestInputSchema.parse({
      name: "command-plugin",
      description: "Commands",
      commands: [
        {
          name: "inspect",
          aliases: ["i"],
          description: { en: "Inspect runtime state", zh: "检查运行时状态" },
          action: "inspect-state",
          context: ["session", "active-runtimes", "models"],
          arguments: [
            { name: "runtime", type: "string", required: true },
            { name: "details", type: "boolean" },
          ],
        },
      ],
    });

    expect(manifest.commands?.[0]).toMatchObject({
      name: "inspect",
      action: "inspect-state",
      context: ["session", "active-runtimes", "models"],
    });
    expect(() =>
      runtimeManifestInputSchema.parse({
        name: "bad-command-plugin",
        description: "Bad commands",
        commands: [
          {
            name: "Bad/Command",
            description: "bad",
            action: "inspect",
          },
        ],
      }),
    ).toThrow(/lowercase kebab-case/);
    expect(() =>
      runtimeManifestInputSchema.parse({
        name: "bad-variadic-plugin",
        description: "Bad commands",
        commands: [
          {
            name: "inspect",
            description: "bad",
            action: "inspect",
            arguments: [{ name: "rest", variadic: true }, { name: "after" }],
          },
        ],
      }),
    ).toThrow(/must be last/);
  });

  it("accepts single-shot agent tool completion", () => {
    const manifest = runtimeManifestInputSchema.parse({
      name: "single-shot-tool-runtime",
      description: "Calls one tool and finishes",
      stage: "post-turn",
      completeAfterTools: ["persist-result"],
      llm: {
        reasoningEffort: "disabled",
        toolChoice: { name: "persist-result" },
      },
    });

    expect(manifest.completeAfterTools).toEqual(["persist-result"]);
    expect(manifest.llm).toEqual({
      reasoningEffort: "disabled",
      toolChoice: { name: "persist-result" },
    });
  });

  it("normalizes keyed declarations into plugin data schema declarations", () => {
    const manifest = runtimeManifestInputSchema.parse({
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
      runtimeManifestInputSchema.parse({
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
      runtimeManifestInputSchema.parse({
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

  it("accepts a plugin-relative entry path and rejects traversal", () => {
    const manifest = runtimeManifestInputSchema.parse({
      name: "tts-runtime",
      description: "TTS runtime",
      stage: "post-turn",
      entry: "server/index.js",
    });
    expect(manifest.entry).toBe("server/index.js");

    expect(() =>
      runtimeManifestInputSchema.parse({
        name: "tts-runtime",
        description: "TTS runtime",
        entry: "../outside/entry.js",
      }),
    ).toThrow(/plugin-relative/);
  });

  it("accepts strict plugin-scoped world projection declarations", () => {
    const manifest = runtimeManifestInputSchema.parse({
      name: "world-projector",
      description: "Projects world characters into plugin data",
      stage: "setup",
      worldProjections: {
        characters: {
          from: "plugin://character-blueprint/blueprints",
          handler: "server/project-characters.js",
          outputs: {
            characters: { namespace: "characters", key: "characterId" },
          },
        },
      },
    });

    expect(manifest.worldProjections?.characters).toEqual({
      from: "plugin://character-blueprint/blueprints",
      handler: "server/project-characters.js",
      outputs: {
        characters: { namespace: "characters", key: "characterId" },
      },
    });
  });

  it("rejects unsafe or structurally invalid world projections", () => {
    const base = {
      name: "world-projector",
      description: "Projects world data",
      stage: "setup" as const,
    };

    expect(() =>
      runtimeManifestInputSchema.parse({
        ...base,
        worldProjections: {
          Characters: {
            from: "plugin://characters",
            handler: "server/project.js",
            outputs: {
              characters: { namespace: "characters", key: "characterId" },
            },
          },
        },
      }),
    ).toThrow(/projection\/output id/);

    expect(() =>
      runtimeManifestInputSchema.parse({
        ...base,
        worldProjections: {
          characters: {
            from: "plugin://characters",
            handler: "../outside/project.js",
            outputs: {},
          },
        },
      }),
    ).toThrow(/plugin-relative/);

    expect(() =>
      runtimeManifestInputSchema.parse({
        ...base,
        worldProjections: {
          characters: {
            from: " ",
            handler: "server/project.js",
            outputs: {
              characters: { namespace: "characters", key: "character.id" },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("accepts catalogue tags and relation metadata", () => {
    const manifest = runtimeManifestInputSchema.parse({
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
    const manifest = runtimeManifestInputSchema.parse({
      name: "manual-tool",
      description: "Manual tool",
      trigger: { type: "manual" },
    });

    expect(validateRuntimeManifestSemantics(manifest)).toEqual([]);
  });

  it("warns when a capability looks like a misspelled framework-known tag", () => {
    const manifest = runtimeManifestInputSchema.parse({
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
    const manifest = runtimeManifestInputSchema.parse({
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
      "commands",
      "dataSchemas",
      "displayName",
      "entry",
      "events",
      "memoryBlocks",
      "relations",
      "tags",
      "userSettings",
      "worldProjections",
    ]);
  });

  it("keeps the strictest conflict rules where the framework enforces them", () => {
    // Declarative data contracts fail closed; userSettings warns.
    expect(PLUGIN_SCOPED_FIELDS.dataSchemas.conflict).toMatch(/throw/i);
    expect(PLUGIN_SCOPED_FIELDS.worldProjections.conflict).toMatch(/throw/i);
    expect(PLUGIN_SCOPED_FIELDS.userSettings.conflict).toMatch(/warn/i);
    // Entry modules are additive across declarations.
    expect(PLUGIN_SCOPED_FIELDS.entry.merge).toBe("union");
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
    const manifest = runtimeManifestInputSchema.parse({
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
    expect(() =>
      runtimeManifestInputSchema.parse({ ...base, relations }),
    ).toThrow();
  });

  it("rejects an empty id", () => {
    expect(() =>
      runtimeManifestInputSchema.parse({
        ...base,
        relations: { requires: [""] },
      }),
    ).toThrow();
  });
});
