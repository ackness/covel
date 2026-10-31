import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
} from "@covel/plugin-loader";
import {
  CHARACTER_ACTOR_CONTRACT,
  characterActorOutputSchema,
  characterActorOutputJsonSchema,
} from "@covel/plugin-handlers-utils";

describe("character actor package", () => {
  it("loads the framework schema and a tool-free actor in both languages", async () => {
    const discovery = (
      await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
    ).find(({ id }) => id === "character-agent");
    const definition = await loadPluginDefinition(discovery);
    expect(definition.manifests).toHaveLength(1);
    const manifest = definition.manifests[0].manifest;
    expect(manifest).toMatchObject({
      subagentOnly: true,
      trigger: { type: "manual" },
      outputKind: "system",
      outputContract: CHARACTER_ACTOR_CONTRACT,
      model: "plugin",
    });
    expect(manifest.tools?.builtin ?? []).toEqual([]);
    expect(manifest.tools?.services ?? []).toEqual([]);
    expect(
      definition.packageManifest.plugin.contracts ?? {},
    ).not.toHaveProperty(CHARACTER_ACTOR_CONTRACT);
    for (const locale of ["en-US", "zh-CN"]) {
      const loaded = await loadRuntime(discovery, manifest.name, locale);
      expect(loaded.outputContractSchema).toEqual(
        characterActorOutputJsonSchema(),
      );
      expect(loaded.promptTemplate).toContain("segments");
      expect(loaded.promptTemplate).toContain("intent");
      expect(loaded.promptTemplate).not.toMatch(/\{\{/);
    }
  });
  it("accepts short speech and actions and rejects authoring outside the actor role", () => {
    const reply = {
      segments: [
        { kind: "dialogue", text: "Wait by the gate." },
        { kind: "action", text: "She lowers the lamp." },
      ],
    };
    expect(characterActorOutputSchema.parse(reply)).toEqual(reply);
    for (const value of [
      { segments: [] },
      { ...reply, effects: [] },
      { segments: [{ kind: "narration", text: "Night falls." }] },
      { segments: [{ kind: "dialogue", speaker: "Mara", text: "Hello." }] },
      { segments: [{ kind: "action", text: "x".repeat(4001) }] },
      { segments: Array.from({ length: 9 }, () => reply.segments[0]) },
    ])
      expect(characterActorOutputSchema.safeParse(value).success).toBe(false);
  });
});
