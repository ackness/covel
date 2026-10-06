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
    // Definitions a model sends for a world that declares its own are left
    // out, not refused: the call succeeds with the author's declarations.
    const withGenerated = await initializeWorld({ tool, z }).execute(
      {
        attributes,
        definitions: { reputation: { ...definition, initialValue: 50 } },
      },
      ctx,
    );
    expect(getPendingProposals(withGenerated)[1].payload.definitions).toEqual({
      reputation: definition,
    });
    // The result keeps the shape the runtime's output schema allows.
    expect(Object.keys(getToolContent(withGenerated)).sort()).toEqual([
      "attributeCount",
      "dimensionCount",
      "preGameDone",
      "success",
      "worldSchema",
    ]);
    const withoutGenerated = await initializeWorld({ tool, z }).execute(
      { attributes },
      ctx,
    );
    expect(
      getPendingProposals(withoutGenerated)[1].payload.definitions,
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
  it("supplies the version of an update from the values the execution read", async () => {
    const ctx = trackerContext();
    ctx.world.dimensions.reputation.version = 4;
    ctx.store.listPluginData = async () => [
      { key: "reputation", value: { ...record, version: 4 } },
    ];
    const settle = async (updates: unknown[]) =>
      getPendingProposals(
        await updateDimensions({ tool, z }).execute({ updates }, ctx),
      )[0]?.payload.updates;
    // No version, and a version copied from an earlier turn: the tool is
    // the one that knows what this execution read.
    expect(await settle([{ id: "reputation", value: 5 }])).toEqual([
      { id: "reputation", expectedVersion: 4, value: 5 },
    ]);
    expect(
      await settle([{ id: "reputation", expectedVersion: 2, value: 5 }]),
    ).toEqual([{ id: "reputation", expectedVersion: 4, value: 5 }]);
    // An entry that says nothing changed, with an empty list of its own.
    expect(
      await settle([
        { id: "reputation", value: 5 },
        { id: "reputation", reason: "No change.", updates: [] },
      ]),
    ).toEqual([{ id: "reputation", expectedVersion: 4, value: 5 }]);
    // The whole value written as one change at the empty path, as a model
    // does for a dimension that is a number.
    expect(
      await settle([{ id: "reputation", changes: [{ path: "", value: 5 }] }]),
    ).toEqual([{ id: "reputation", expectedVersion: 4, value: 5 }]);
    // Two changes, one at the empty path, have no single meaning.
    await expect(
      settle([
        {
          id: "reputation",
          changes: [
            { path: "", value: 5 },
            { path: "x", value: 1 },
          ],
        },
      ]),
    ).rejects.toThrow();
  });
  it("says what an unknown dimension is when it is an entry of one", async () => {
    const ctx = trackerContext();
    ctx.world.dimensions = {
      ...ctx.world.dimensions,
      board: {
        name: "Case board",
        schema: { type: "object" },
        value: { letter: { status: "unverified" } },
        version: 1,
      },
    };
    const run = (id: string) =>
      updateDimensions({ tool, z }).execute(
        { updates: [{ id, changes: [{ path: "status", value: "x" }] }] },
        ctx,
      );
    await expect(run("letter")).rejects.toThrow(
      'Unknown dimension: letter. It is an entry of the dimension board: use id "board" and start each path with "letter."',
    );
    await expect(run("ledger")).rejects.toThrow(
      "Unknown dimension: ledger. The dimensions are: reputation, board",
    );
  });
  it("patches large dimensions by path instead of rewriting them", async () => {
    const boardSchema = {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          lead: { type: "string" },
          status: { type: "string", enum: ["unverified", "corroborated"] },
        },
        required: ["lead", "status"],
      },
    };
    const board = {
      letter: { lead: "Torn letter", status: "unverified" },
      report: { lead: "Report 74", status: "unverified" },
    };
    const boardRecord = {
      definition: {
        name: "Case board",
        schema: boardSchema,
        initialValue: {},
        updateRule: "Track leads.",
      },
      value: board,
      version: 3,
    };
    const ctx = trackerContext();
    ctx.world.dimensions = {
      board: {
        name: "Case board",
        schema: boardSchema,
        value: board,
        version: 3,
      },
    };
    ctx.store.listPluginData = async () => [
      { key: "board", value: boardRecord },
    ];
    const result = await updateDimensions({ tool, z }).execute(
      {
        updates: [
          {
            id: "board",
            expectedVersion: 3,
            changes: [
              { path: "letter.status", value: "corroborated" },
              {
                path: "ledger",
                value: { lead: "Pier ledger", status: "unverified" },
              },
            ],
          },
        ],
      },
      ctx,
    );
    expect(getPendingProposals(result)[0]?.payload.updates[0]?.value).toEqual({
      letter: { lead: "Torn letter", status: "corroborated" },
      report: { lead: "Report 74", status: "unverified" },
      ledger: { lead: "Pier ledger", status: "unverified" },
    });
    // The frozen snapshot itself is never mutated.
    expect(board.letter.status).toBe("unverified");
    // An entry with no value and no change means "unchanged": it settles
    // as no change instead of costing another model call.
    const unchanged = await updateDimensions({ tool, z }).execute(
      {
        updates: [
          { id: "board", expectedVersion: 3 },
          { id: "board", expectedVersion: 3, changes: [], reason: "Same." },
        ],
      },
      ctx,
    );
    expect(getPendingProposals(unchanged)[0]?.payload).toMatchObject({
      settlement: "no-change",
      updates: [],
    });
    // Shapes that real-model runs sent and that have one meaning: a slash
    // path, a reason on a change or beside `updates`, and one dimension
    // split over two entries.
    const loose = await updateDimensions({ tool, z }).execute(
      {
        updates: [
          {
            id: "board",
            expectedVersion: 3,
            changes: [
              { path: "letter/status", value: "corroborated", reason: "Seen." },
            ],
            reason: "The letter is confirmed.",
          },
          {
            id: "board",
            expectedVersion: 3,
            changes: [{ path: "report.lead", value: "Report 74, one page" }],
            reason: "A page is missing.",
          },
        ],
        reason: "Two facts this turn.",
      },
      ctx,
    );
    expect(getPendingProposals(loose)[0]?.payload.updates).toEqual([
      expect.objectContaining({
        id: "board",
        reason: "The letter is confirmed. A page is missing.",
        value: {
          letter: { lead: "Torn letter", status: "corroborated" },
          report: { lead: "Report 74, one page", status: "unverified" },
        },
      }),
    ]);
    // A key that holds a slash is still one key.
    const slashed = {
      ...board,
      "pier/7": { lead: "Pier 7", status: "unverified" },
    };
    const kept = await updateDimensions({ tool, z }).execute(
      {
        updates: [
          {
            id: "board",
            expectedVersion: 3,
            changes: [{ path: "pier/7.status", value: "corroborated" }],
          },
        ],
      },
      {
        ...ctx,
        world: {
          dimensions: {
            board: { ...ctx.world.dimensions.board, value: slashed },
          },
        },
      },
    );
    expect(
      getPendingProposals(kept)[0]?.payload.updates[0]?.value["pier/7"],
    ).toEqual({ lead: "Pier 7", status: "corroborated" });
  });
  it("rejects change paths that reach a prototype", async () => {
    const ctx = trackerContext();
    for (const path of ["__proto__.polluted", "a.constructor.prototype.x"]) {
      await expect(
        updateDimensions({ tool, z }).execute(
          {
            updates: [
              {
                id: "reputation",
                expectedVersion: 1,
                changes: [{ path, value: "yes" }],
              },
            ],
          },
          ctx,
        ),
      ).rejects.toThrow(/Unsafe change path/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
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
