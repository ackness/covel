import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tool, z, validateOutput } from "@covel/tools";
import guard from "../guard.js";
import initializeWorld from "../tools/initialize-world.js";
const outputSchema = JSON.parse(
  readFileSync(
    new URL("../runtimes/schema-gen/output.schema.json", import.meta.url),
    "utf8",
  ),
);
const definition = {
  name: "City wall",
  schema: { type: "integer", minimum: 0, maximum: 100 },
  initialValue: 100,
};
function context(worldRecord, characterSchema = null, dimensions = {}) {
  return {
    sessionId: "session",
    turnId: "turn",
    pluginId: "world-init",
    runtimeId: "world-init/schema-gen",
    locale: "en-US",
    world: { worldRecord, characterSchema, characters: [], dimensions },
  };
}
describe("world-init schema guard", () => {
  it("uses the same output schema for generated data while requiring 15 generated attributes", async () => {
    const categories = ["stats", "bio", "abilities", "equipment", "social"];
    const attributes = Array.from({ length: 15 }, (_, index) => ({
      id: `field${index}`,
      name: `Field ${index}`,
      type: "string",
      category: categories[index % categories.length],
    }));
    const initialize = initializeWorld({ tool, z });
    const result = await initialize.execute({ attributes }, context({}));
    const { preGameDone, ...businessOutput } = getToolContent(result);
    expect(preGameDone).toBe(true);
    // The private gate sees the tool envelope; the public contract sees the
    // business output after the kernel extracts the completion signal.
    expect(validateOutput(getToolContent(result), outputSchema)).toEqual({
      valid: true,
    });
    expect(validateOutput(businessOutput, outputSchema)).toEqual({
      valid: true,
    });
    for (const field of [
      "success",
      "attributeCount",
      "dimensionCount",
      "worldSchema",
    ]) {
      const incomplete = { ...businessOutput };
      delete incomplete[field];
      expect(validateOutput(incomplete, outputSchema).valid).toBe(false);
    }
    expect(
      validateOutput({ ...businessOutput, unexpected: true }, outputSchema)
        .valid,
    ).toBe(false);
    await expect(
      initialize.execute({ attributes: attributes.slice(0, 14) }, context({})),
    ).rejects.toThrow();
  });
  it.each([
    { attributes: [] },
    {
      attributes: [
        { id: "energy", name: "Energy", type: "number", category: "stats" },
      ],
    },
  ])(
    "publishes schema-valid output for an authored or existing small schema: %j",
    async ({ attributes }) => {
      const schema = { types: ["spirit"], attributes };
      for (const ctx of [
        context({ metadata: { characterSchema: schema } }),
        context({ metadata: {} }, schema),
      ]) {
        const { skip, ...output } = getToolContent(await guard(ctx));
        expect(skip).toBe(true);
        expect(output).toEqual({
          success: true,
          preGameDone: true,
          attributeCount: attributes.length,
          dimensionCount: 0,
          worldSchema: schema,
        });
        expect(validateOutput(output, outputSchema)).toEqual({ valid: true });
      }
      expect(
        readFileSync(new URL("../PLUGIN.md", import.meta.url), "utf8"),
      ).toContain(
        "world-data-provider@1:\n    schema: ./runtimes/schema-gen/output.schema.json",
      );
    },
  );
  it("skips completed setup without another message or proposals", async () => {
    const schema = { types: ["enemy"], attributes: [] };
    const result = await guard(
      context({ metadata: { dimensions: { cityWall: definition } } }, schema, {
        cityWall: { ...definition, value: 42, version: 2 },
      }),
    );
    expect(getToolContent(result)).not.toHaveProperty("narrativeOutput");
    expect(getPendingProposals(result)).toEqual([]);
    expect(getToolContent(result)).toMatchObject({ dimensionCount: 1 });
  });
  it("adopts only newly declared dimensions when rerunning setup", async () => {
    const schema = { types: ["enemy"], attributes: [] };
    const result = await guard(
      context(
        { dimensions: { cityWall: definition, gate: definition } },
        schema,
        { cityWall: { ...definition, value: 42, version: 2 } },
      ),
    );
    expect(getToolContent(result)).not.toHaveProperty("narrativeOutput");
    expect(getPendingProposals(result)).toMatchObject([
      {
        type: "dimension.initialize",
        payload: { definitions: { gate: definition } },
      },
    ]);
    expect(
      getPendingProposals(result)[0]?.payload.definitions,
    ).not.toHaveProperty("cityWall");
  });
  it("reuses the session schema and idempotently adopts declarations, without resetting state", async () => {
    const schema = { version: 2, types: ["enemy"], attributes: [] };
    const result = await guard(
      context({ metadata: { dimensions: { cityWall: definition } } }, schema),
    );
    expect(getToolContent(result)).toMatchObject({
      skip: true,
      preGameDone: true,
      worldSchema: { types: ["enemy"], attributes: [] },
    });
    expect(
      getPendingProposals(result).map((proposal) => proposal.type),
    ).toEqual(["dimension.initialize"]);
  });
  it("does not derive character-owned fields from global dimensions", async () => {
    expect(
      await guard(
        context({ metadata: { dimensions: { cityWall: definition } } }),
      ),
    ).toEqual({ skip: false, initialized: false });
  });
  it("buffers author character schema and dimensions together", async () => {
    const schema = {
      types: ["spirit"],
      attributes: [
        { id: "energy", name: "Energy", type: "number", category: "stats" },
      ],
    };
    const result = await guard(
      context({
        metadata: {
          characterSchema: schema,
          dimensions: { cityWall: definition },
        },
      }),
    );
    expect(getPendingProposals(result)).toMatchObject([
      { type: "character.schema.set", payload: schema },
      {
        type: "dimension.initialize",
        payload: { definitions: { cityWall: definition } },
      },
    ]);
  });
  it("lets the model generate missing character schema", async () => {
    expect(await guard(context({ metadata: {} }))).toEqual({
      skip: false,
      initialized: false,
    });
  });
});
