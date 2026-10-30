import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storyOutputJsonSchema, storyOutputSchema } from "../src/index.js";

const pluginsRoot = path.resolve(import.meta.dirname, "../../../plugins");
const contractFile = (pluginId: string) =>
  JSON.parse(
    readFileSync(
      path.join(pluginsRoot, pluginId, "schemas/narrative-engine.schema.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
const withoutIdentity = (schema: Record<string, unknown>) => {
  const { $id: _id, title: _title, ...rest } = schema;
  return rest;
};

describe("story output schema", () => {
  it("accepts one narration segment and rejects malformed stories", () => {
    expect(
      storyOutputSchema.safeParse({
        segments: [{ kind: "narration", text: "雨停了。" }],
      }).success,
    ).toBe(true);
    for (const story of [
      { segments: [] },
      { segments: [{ kind: "monologue", text: "x" }] },
      { segments: [{ kind: "narration", text: "" }] },
      { segments: [{ kind: "dialogue", speaker: "长".repeat(81), text: "x" }] },
    ])
      expect(
        storyOutputSchema.safeParse(story).success,
        JSON.stringify(story),
      ).toBe(false);
  });

  it("exports a JSON Schema that requires segments and leaves out the derived text", () => {
    const schema = storyOutputJsonSchema();
    expect(schema.required).toEqual(["segments"]);
    expect(schema.additionalProperties).toBe(true);
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "cues",
      "segments",
      "yield",
    ]);
    expect(properties).not.toHaveProperty("narrativeOutput");
  });

  it.each(["narrator", "chat-mode-narrator"])(
    "the %s contract file equals the schema apart from $id and title",
    (pluginId) => {
      const file = contractFile(pluginId);
      expect(file.$id).toBe("contract:narrative-engine@2");
      expect(withoutIdentity(file)).toEqual(storyOutputJsonSchema());
    },
  );

  it("notices a property added to a contract file", () => {
    const file = contractFile("narrator");
    const properties = file.properties as Record<string, unknown>;
    const changed = {
      ...file,
      properties: { ...properties, extra: { type: "string" } },
    };
    expect(withoutIdentity(changed)).not.toEqual(storyOutputJsonSchema());
  });
});
