import { describe, expect, it } from "vitest";
import {
  getPendingProposals,
  getModelView,
  ToolError,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { tool, z } from "@covel/tools";
import initializeWorld from "../tools/initialize-world.js";
import register from "../server/index.js";
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
        value: [{ kind: "narration", text: "Commission completed." }],
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
  it("requires current segment input instead of accepting flattened prose", async () => {
    const ctx = trackerContext();
    await expect(
      updateDimensions({ tool, z }).execute(
        { updates: [] },
        {
          ...ctx,
          inputSlots: {
            narrative: {
              ...ctx.inputSlots.narrative,
              value: "A flattened quote.",
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolError",
      code: "unavailable",
      message: "A successful authoritative narrative input is required",
    });
  });

  it("classifies overlong dimension values as correctable without staging writes", async () => {
    const ctx = trackerContext();
    const schema = {
      type: "object",
      properties: { note: { type: "string", maxLength: 240 } },
      required: ["note"],
      additionalProperties: false,
    };
    const stored = {
      definition: { ...definition, schema, initialValue: { note: "" } },
      value: { note: "" },
      version: 1,
    };
    const context = {
      ...ctx,
      world: {
        dimensions: {
          signalLog: {
            name: "Signal log",
            schema,
            value: stored.value,
            version: 1,
          },
        },
      },
      store: {
        ...ctx.store,
        listPluginData: async () => [{ key: "signalLog", value: stored }],
      },
    };
    const instance = updateDimensions({ tool, z });
    await expect(
      instance.execute(
        { updates: [{ id: "signalLog", value: { note: "x".repeat(302) } }] },
        context,
      ),
    ).rejects.toMatchObject({
      code: "invalid-input",
      message: expect.stringContaining("note"),
    });
    expect(stored.value).toEqual({ note: "" });
    const corrected = await instance.execute(
      { updates: [{ id: "signalLog", value: { note: "x".repeat(240) } }] },
      context,
    );
    expect(getPendingProposals(corrected)).toHaveLength(1);
    stored.version = 2;
    await expect(
      instance.execute(
        { updates: [{ id: "signalLog", value: { note: "ok" } }] },
        context,
      ),
    ).rejects.toMatchObject({ name: "DimensionConflictError" });
    const failure = new Error("store unavailable");
    context.store.listPluginData = async () => {
      throw failure;
    };
    await expect(instance.execute({ updates: [] }, context)).rejects.toBe(
      failure,
    );
  });

  it("registers only tools that a runtime can call", () => {
    const registered: string[] = [];
    register({
      toolkit: { tool, z },
      provideExtension() {},
      on() {},
      registerTool(instance: { name: string }) {
        registered.push(instance.name);
      },
    });
    expect(registered.sort()).toEqual([
      "dimension-rule-get",
      "initialize-world",
      "update-dimensions",
    ]);
  });
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
  it("validates dimension schemas/ranges through atomic initialization", async () => {
    const instance = initializeWorld({ tool, z });
    expect(
      getPendingProposals(
        await instance.execute(
          { attributes, definitions: { reputation: definition } },
          base,
        ),
      ),
    ).toHaveLength(2);
    await expect(
      instance.execute(
        {
          attributes,
          definitions: { reputation: { ...definition, initialValue: 101 } },
        },
        base,
      ),
    ).rejects.toThrow();
    await expect(
      instance.execute(
        {
          attributes,
          definitions: {
            reputation: { ...definition, schema: { $ref: "unsafe" } },
          },
        },
        base,
      ),
    ).rejects.toThrow();
  });
  it("keeps structured character attributes separate from global values", async () => {
    const result = await initializeWorld({ tool, z }).execute(
      {
        attributes: [
          ...attributes.slice(1),
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
        attributes: expect.arrayContaining([
          expect.objectContaining({ id: "hp", type: "number" }),
        ]),
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
  it("refuses a settlement that skips a dimension it says follows the clock, in a turn the clock moved", async () => {
    const clock = (elapsedThisTurn: number) => ({
      cardinality: "one",
      value: {
        display: "Year 1 · 07:26",
        unit: "minute",
        elapsedSinceStart: 72,
        elapsedThisTurn,
      },
      source: { pluginId: "clock", runtimeId: "clock/advance", resultId: "c" },
    });
    const settle = (
      params: Record<string, unknown>,
      worldTime?: ReturnType<typeof clock>,
    ) => {
      const ctx = trackerContext();
      return updateDimensions({ tool, z }).execute(params, {
        ...ctx,
        inputSlots: { ...ctx.inputSlots, ...(worldTime ? { worldTime } : {}) },
      });
    };
    const quiet = { followsClock: ["reputation"], updates: [] };
    await expect(settle(quiet, clock(12))).rejects.toThrow(
      /now Year 1 · 07:26, 12 minute later than last turn and 72 minute after the start.*reputation/,
    );
    // The value, or a statement that the rule gives the same value.
    for (const update of [
      { id: "reputation", value: 5 },
      { id: "reputation", reason: "Under one point this turn." },
    ])
      expect(
        getToolContent(
          await settle({ ...quiet, updates: [update] }, clock(12)),
        ),
      ).toHaveProperty("updateCount");
    // Nothing to check: the clock stood still, no clock is bound, the list
    // is left out, or it names something that is not a dimension.
    for (const [params, worldTime] of [
      [quiet, clock(0)],
      [quiet, undefined],
      [{ updates: [] }, clock(12)],
      [{ followsClock: ["storm"], updates: [] }, clock(12)],
    ] as const)
      expect(getToolContent(await settle(params, worldTime))).toMatchObject({
        updateCount: 0,
      });
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
    await expect(run("letter")).rejects.toMatchObject({
      name: "ToolError",
      code: "not-found",
      message:
        'Unknown dimension: letter. It is an entry of the dimension board: use id "board" and start each path with "letter."',
    });
    await expect(run("ledger")).rejects.toMatchObject({
      name: "ToolError",
      code: "not-found",
      message:
        "Unknown dimension: ledger. The dimensions are: reputation, board",
    });
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
      ).rejects.toMatchObject({
        name: "ToolError",
        code: "invalid-input",
        message: `Unsafe change path: ${path}`,
      });
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
    ).rejects.toMatchObject({
      name: "ToolError",
      code: "unavailable",
      message: "A successful authoritative narrative input is required",
    });
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
    expect(result).not.toHaveProperty("_text");
    expect(JSON.stringify(result).length).toBeLessThan(500);
  });
});

describe("world tool model views", () => {
  it.each([
    ["en-US", "World initialized: 15 attributes, 1 dimensions."],
    ["zh-CN", "世界已初始化：15 个属性，1 个维度。"],
  ])(
    "keeps initialization contract content and exposes only a summary in %s",
    async (locale, summary) => {
      const result = await initializeWorld({ tool, z }).execute(
        { attributes, definitions: { reputation: definition } },
        { ...base, locale },
      );
      expect(getToolContent(result)).toEqual({
        success: true,
        preGameDone: true,
        attributeCount: 15,
        dimensionCount: 1,
        worldSchema: { types: ["npc", "companion"], attributes },
      });
      expect(getModelView(result)).toEqual({ summary });
    },
  );

  it.each([
    [
      "en-US",
      "Dimensions updated: 1 change(s).",
      "No change recorded.",
      "This turn's dimensions were already settled.",
    ],
    ["zh-CN", "维度已更新：1 项改动。", "未记录改动。", "本回合的维度已结算。"],
  ])(
    "summarizes updates, no change and a committed retry in %s",
    async (locale, updated, unchanged, settled) => {
      const ctx = { ...trackerContext(), locale };
      const instance = updateDimensions({ tool, z });
      const params = { updates: [{ id: "reputation", value: 5 }] };
      const result = await instance.execute(params, ctx);
      expect(getToolContent(result)).toEqual({ updateCount: 1 });
      expect(getModelView(result)).toEqual({ summary: updated });
      const noChange = await instance.execute({ updates: [] }, ctx);
      expect(getToolContent(noChange)).toEqual({ updateCount: 0 });
      expect(getModelView(noChange)).toEqual({ summary: unchanged });
      const [proposal] = getPendingProposals(result);
      expect(proposal).toBeDefined();
      // A committed source receipt prevents another proposal on a later retry.
      ctx.store.getPluginData = async () => ({
        value: {
          source: proposal.payload.source,
          status: "settled",
          readVersions: proposal.payload.readVersions,
          definitions: { reputation: definition },
          sourceTurnId: "t",
          version: 1,
        },
      });
      const retry = await instance.execute(params, ctx);
      expect(getToolContent(retry)).toEqual({ alreadySettled: true });
      expect(getModelView(retry)).toEqual({ summary: settled });
      expect(getPendingProposals(retry)).toEqual([]);
    },
  );
});

describe("world tool correction errors", () => {
  it("rejects conflicting value and changes as invalid-input", async () => {
    const error = await updateDimensions({ tool, z })
      .execute(
        {
          updates: [
            { id: "reputation", value: 5, changes: [{ path: "x", value: 1 }] },
          ],
        },
        trackerContext(),
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({
      code: "invalid-input",
      message: "reputation: provide either value or changes, not both",
    });
  });

  it("preserves a multiline clock correction and bounds long clock corrections", async () => {
    const ctx = trackerContext();
    const run = (display: string) =>
      updateDimensions({ tool, z })
        .execute(
          {
            followsClock: ["reputation"],
            updates: [],
          },
          {
            ...ctx,
            inputSlots: {
              ...ctx.inputSlots,
              worldTime: {
                cardinality: "one",
                value: {
                  display,
                  elapsedThisTurn: 12,
                  elapsedSinceStart: 72,
                  unit: "minute",
                },
              },
            },
          },
        )
        .catch((error: unknown) => error);
    const error = await run("Year 1\n07:26");
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({
      code: "invalid-input",
      message:
        "The world clock moved this turn: it is now Year 1\n07:26, 12 minute later than last turn and 72 minute after the start. followsClock lists reputation without an update. Add one entry for each: the value its rule gives for this clock, or only {id, reason} when the rule gives the value it already has.",
    });
    const longError = (await run("x".repeat(2100))) as ToolError;
    expect(longError.message).toHaveLength(1901);
    expect(longError.message.endsWith("…")).toBe(true);
  });

  it.each([
    ["missing narrative", "unavailable", "Narrative provenance required"],
    ["unknown dimension", "not-found", "Unknown dimension: reputation"],
    [
      "stale version",
      "conflict",
      "The dimension changed since this narrative started",
    ],
  ])("classifies a rule lookup with %s", async (condition, code, message) => {
    const ctx = trackerContext();
    const error = await ruleGet({ tool, z })
      .execute(
        { id: "reputation", part: "rule" },
        {
          ...ctx,
          ...(condition === "missing narrative" ? { inputSlots: {} } : {}),
          store: {
            ...ctx.store,
            getPluginData: async () =>
              condition === "unknown dimension"
                ? null
                : { value: { ...record, version: 2 } },
          },
        },
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code, message });
    if (condition === "stale version")
      expect((error as ToolError).hint).toBe(
        "Stop; the next turn reads the current version.",
      );
  });
});

describe("world tool annotations", () => {
  it.each([
    {
      plugin: "world-init",
      tool: "dimension-rule-get",
      create: ruleGet,
      annotations: { readOnly: true, idempotent: true, concurrencySafe: true },
    },
    {
      plugin: "world-init",
      tool: "update-dimensions",
      create: updateDimensions,
      annotations: { idempotent: true },
    },
  ])(
    "declares proven annotations for $plugin/$tool",
    async ({ create, annotations }) => {
      const instance = create({ tool, z });
      expect(instance.annotations).toEqual({
        readOnly: false,
        stagesWrites: true,
        concurrencySafe: false,
        ...annotations,
        ...("readOnly" in annotations ? { stagesWrites: false } : {}),
      });
      if ("readOnly" in annotations) {
        const ctx = trackerContext();
        ctx.store.getPluginData = async (namespace: string) =>
          namespace === "_dimensions" ? { value: record } : null;
        const result = await instance.execute(
          { id: "reputation", part: "rule" },
          ctx,
        );
        expect(result).toMatchObject({
          content: definition.updateRule,
          complete: true,
        });
        expect(getPendingProposals(result)).toEqual([]);
      }
    },
  );
});
