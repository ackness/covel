import { describe, expect, it } from "vitest";
import {
  runtimeManifestInputSchema,
  validateRuntimeManifestSemantics,
} from "../src/schemas/plugin.js";
import { pluginManifestSchema } from "../src/schemas/plugin-manifest.js";

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

  it("accepts versioned package contracts and rejects legacy relation fields", () => {
    const root = {
      id: "probe",
      kind: "plugin",
      description: "Probe",
      tags: ["mode:story"],
      provides: ["story@1"],
      requires: ["world@1"],
      optional: ["audio@1"],
      conflicts: ["other-story@1"],
    };
    expect(pluginManifestSchema.parse(root)).toEqual(root);
    for (const field of [
      "relations",
      "capabilities",
      "fallbackFor",
      "memoryBlocks",
      "summaryFocus",
      "postHistory",
      "authorsNote",
    ]) {
      expect(
        pluginManifestSchema.safeParse({ ...root, [field]: [] }).success,
      ).toBe(false);
    }
    expect(
      pluginManifestSchema.safeParse({ ...root, requires: [""] }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({ ...root, provides: ["unversioned"] })
        .success,
    ).toBe(false);
  });
});

describe("plugin manifest semantic diagnostics", () => {
  it("does not warn for manual runtimes without stage", () => {
    const manifest = runtimeManifestInputSchema.parse({
      name: "manual",
      description: "Manual",
      trigger: { type: "manual" },
    });
    expect(validateRuntimeManifestSemantics(manifest)).toEqual([]);
  });
});
