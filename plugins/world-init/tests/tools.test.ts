import { describe, expect, it } from "vitest";
import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { tool, z } from "@covel/tools";
import initializeWorld from "../tools/initialize-world.js";
import setWorldSchema from "../tools/set-world-schema.js";
import setWorldDimensions from "../tools/set-world-dimensions.js";
import updateDimensions from "../tools/update-dimensions.js";
import editDimensions from "../runtimes/edit-dimensions/handler.js";
import trackerGuard from "../runtimes/dimension-tracker/guard.js";
import ruleGet from "../tools/dimension-rule-get.js";

const categories = ["stats", "bio", "abilities", "equipment", "social"];
const attributes = Array.from({ length: 15 }, (_, index) => ({
  id: `field${index}`,
  name: `Field ${index}`,
  type: "string",
  category: categories[index % 5],
}));
const definition = {
  name: "Reputation",
  schema: { type: "integer", minimum: 0, maximum: 100 },
  initialValue: 0,
  updateRule: "Completed commissions add five.",
};
const record = { definition, value: 0, version: 1 };
const base = {
  sessionId: "s",
  turnId: "t",
  pluginId: "world-init",
  runtimeId: "world-init/schema-gen",
};
function trackerContext(receipt = null) {
  return {
    ...base,
    runtimeId: "world-init/dimension-tracker",
    locale: "en-US",
    inputSlots: {
      narrative: {
        cardinality: "one",
        value: "Commission completed.",
        source: { pluginId: "story", runtimeId: "story", resultId: "source" },
      },
    },
    world: {
      dimensions: {
        reputation: {
          name: "Reputation",
          schema: definition.schema,
          value: 0,
          version: 1,
        },
      },
    },
    store: {
      listPluginData: async () => [{ key: "reputation", value: record }],
      getPluginData: async () => (receipt ? { value: receipt } : null),
      getSession: async () => ({ completedPlayerTurns: 0, locale: "en-US" }),
    },
  };
}
describe("world-init domain tools", () => {
  it("initializes attributes and arbitrary declarations in one buffered call without lorebook/legacy state writes", async () => {
    const result = await initializeWorld({ tool, z }).execute(
      { attributes, definitions: { reputation: definition } },
      base,
    );
    expect(getToolContent(result)).toMatchObject({
      success: true,
      attributeCount: 15,
      dimensionCount: 1,
      preGameDone: true,
    });
    expect(
      getPendingProposals(result).map((proposal) => proposal.type),
    ).toEqual(["character.schema.set", "dimension.initialize"]);
  });
  it("publishes the current definition contract to the model and rejects raw old values", async () => {
    const toolInstance = initializeWorld({ tool, z });
    expect(toolInstance.jsonSchema.properties).toHaveProperty("definitions");
    expect(toolInstance.jsonSchema.properties).not.toHaveProperty("entries");
    await expect(
      toolInstance.execute(
        { attributes, definitions: { reputation: 0 } },
        base,
      ),
    ).rejects.toThrow();
  });
  it("preserves all five character categories and validates before exposing any proposal", async () => {
    await expect(
      initializeWorld({ tool, z }).execute(
        { attributes: attributes.slice(0, 14) },
        base,
      ),
    ).rejects.toThrow();
    await expect(
      initializeWorld({ tool, z }).execute(
        {
          attributes: attributes.map((attribute) => ({
            ...attribute,
            category: "stats",
          })),
        },
        base,
      ),
    ).rejects.toThrow();
  });
  it("keeps author declarations authoritative over generated definitions", async () => {
    const ctx = {
      ...base,
      world: {
        worldRecord: { metadata: { dimensions: { reputation: definition } } },
      },
    };
    await expect(
      initializeWorld({ tool, z }).execute(
        {
          attributes,
          definitions: { reputation: { ...definition, initialValue: 50 } },
        },
        ctx,
      ),
    ).rejects.toThrow("author");
    expect(
      getPendingProposals(
        await initializeWorld({ tool, z }).execute({ attributes }, ctx),
      )[1].payload.definitions,
    ).toEqual({ reputation: definition });
  });
  it("validates dimension schemas/ranges and exposes a single initialization proposal", async () => {
    const instance = setWorldDimensions({ tool, z });
    expect(
      getPendingProposals(
        await instance.execute(
          { definitions: { reputation: definition } },
          base,
        ),
      ),
    ).toHaveLength(1);
    await expect(
      instance.execute(
        { definitions: { reputation: { ...definition, initialValue: 101 } } },
        base,
      ),
    ).rejects.toThrow();
    await expect(
      instance.execute(
        {
          definitions: {
            reputation: { ...definition, schema: { $ref: "unsafe" } },
          },
        },
        base,
      ),
    ).rejects.toThrow();
  });
  it("keeps structured character attributes separate from global values", async () => {
    const result = await setWorldSchema({ tool, z }).execute(
      {
        attributes: [
          {
            id: "hp",
            name: "Health",
            type: "number",
            category: "stats",
            min: 0,
            max: 100,
            defaultValue: 100,
          },
        ],
      },
      base,
    );
    expect(getPendingProposals(result)[0]).toMatchObject({
      type: "character.schema.set",
      payload: {
        attributes: [expect.objectContaining({ id: "hp", type: "number" })],
      },
    });
  });
  it("takes source identity and read versions from the host, including explicit no-change", async () => {
    const result = await updateDimensions({ tool, z }).execute(
      { updates: [] },
      trackerContext(),
    );
    expect(getPendingProposals(result)[0]).toMatchObject({
      type: "dimension.update",
      payload: {
        source: { resultId: "source", turnNumber: 1 },
        readVersions: { reputation: 1 },
        settlement: "no-change",
        updates: [],
      },
    });
    await expect(
      updateDimensions({ tool, z }).execute(
        { updates: [], source: { resultId: "forged", turnNumber: 1 } },
        trackerContext(),
      ),
    ).rejects.toThrow();
  });
  it("rejects missing narrative provenance and skips model maintenance when no rules exist", async () => {
    await expect(
      updateDimensions({ tool, z }).execute(
        { updates: [] },
        { ...trackerContext(), inputSlots: {} },
      ),
    ).rejects.toThrow("narrative");
    expect(
      await trackerGuard({
        ...trackerContext(),
        store: {
          listPluginData: async () => [
            {
              key: "reputation",
              value: {
                ...record,
                definition: { ...definition, updateRule: "   " },
              },
            },
          ],
        },
      }),
    ).toEqual({ skip: true });
    expect(await trackerGuard(trackerContext())).toEqual({ skip: false });
  });
  it("reports stable conflicts/current versions on player edits rather than overwriting", async () => {
    const ctx = {
      ...trackerContext(),
      manualPayload: {
        updates: [{ id: "reputation", expectedVersion: 2, value: 5 }],
      },
    };
    const result = await editDimensions(ctx);
    expect(result).toMatchObject({
      outcome: "success",
      value: {
        applied: false,
        code: "dimension-version-conflict",
        currentVersions: { reputation: 1 },
      },
    });
    expect(getPendingProposals(result)).toEqual([]);
  });
  it("pages adopted rule text instead of injecting unbounded definitions", async () => {
    const ctx = trackerContext();
    ctx.store.getPluginData = async (namespace) =>
      namespace === "_dimensions"
        ? {
            value: {
              ...record,
              definition: { ...definition, updateRule: "r".repeat(8000) },
            },
          }
        : null;
    const result = await ruleGet({ tool, z }).execute(
      { id: "reputation", part: "rule", limit: 100 },
      ctx,
    );
    expect(result).toMatchObject({
      content: "r".repeat(100),
      complete: false,
      nextOffset: 100,
    });
    expect(result._text.length).toBeLessThan(500);
  });
});
