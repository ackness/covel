import { describe, expect, it } from "vitest";
import { storyOutputJsonSchema, storyOutputSchema } from "../src/index.js";
import {
  frameworkContracts,
  frameworkContractSchemas,
  isSingleProviderContract,
} from "../src/framework-contracts.js";

const withoutIdentity = (schema: Readonly<Record<string, unknown>>) => {
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

  it("is the schema of the framework-owned story contract", () => {
    const schema = frameworkContractSchemas["narrative-engine@2"]!;
    expect(schema.$id).toBe("contract:narrative-engine@2");
    expect(withoutIdentity(schema)).toEqual(storyOutputJsonSchema());
    expect(frameworkContracts["narrative-engine@2"]).toMatchObject({
      providers: "single",
      kernel: true,
    });
  });

  it("admits one story provider per session and many character actors", () => {
    expect(isSingleProviderContract("narrative-engine@2")).toBe(true);
    expect(isSingleProviderContract("character-actor@1")).toBe(false);
    expect(isSingleProviderContract("graph-rag@1")).toBe(false);
    expect(isSingleProviderContract("toString")).toBe(false);
  });
});
