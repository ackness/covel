import { describe, expect, it } from "vitest";
import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { materializeDimensionRecords } from "@covel/plugin-handlers-utils/dimensions";
import { tool, z } from "@covel/tools";
import deriveFromClock from "../runtimes/dimension-clock/handler.js";
import register from "../server/index.js";
import updateDimensions from "../tools/update-dimensions.js";

const countdown = {
  source: "clock.elapsedSinceStart",
  start: 180,
  perUnit: -1,
  min: 0,
  max: 180,
};
const definition = {
  name: "Countdown",
  schema: {
    type: "object",
    properties: {
      minutesRemaining: {
        type: "integer",
        minimum: 0,
        maximum: 180,
        "x-derive": countdown,
      },
      stage: {
        type: "string",
        enum: ["distant", "approaching", "imminent", "overhead"],
        "x-derive": {
          ...countdown,
          ranges: [
            { from: 121, value: "distant" },
            { from: 31, value: "approaching" },
            { from: 1, value: "imminent" },
            { value: "overhead" },
          ],
        },
      },
      frontPassed: { type: "boolean" },
    },
    required: ["minutesRemaining", "stage", "frontPassed"],
    additionalProperties: false,
  },
  initialValue: { minutesRemaining: 180, stage: "distant", frontPassed: false },
  updateRule: "Set frontPassed when the front has moved on.",
};
const reputation = {
  name: "Reputation",
  schema: { type: "integer", minimum: 0, maximum: 100 },
  initialValue: 0,
  updateRule: "Completed commissions add five.",
};
type Records = Parameters<typeof materializeDimensionRecords>[0];
const start = (): Records =>
  ({
    storm: { definition, value: definition.initialValue, version: 1 },
    reputation: { definition: reputation, value: 0, version: 1 },
  }) as never;
const snapshot = (records: Records) =>
  Object.fromEntries(
    Object.entries(records).map(([id, record]) => [
      id,
      {
        name: record.definition.name,
        schema: record.definition.schema,
        value: record.value,
        version: record.version,
      },
    ]),
  );
const base = {
  sessionId: "s",
  turnId: "t",
  pluginId: "world-init",
  runtimeId: "world-init/dimension-clock",
};

/** Run the runtime at one clock and commit what it proposes. */
async function turn(records: Records, elapsedSinceStart?: number) {
  const result = await deriveFromClock({
    ...base,
    world: { dimensions: snapshot(records) },
    inputs:
      elapsedSinceStart === undefined
        ? {}
        : { worldTime: { value: { elapsedSinceStart } } },
  });
  const proposals = getPendingProposals(result);
  return {
    proposals,
    records: proposals.reduce(
      (next, proposal) => materializeDimensionRecords(next, proposal as never),
      records,
    ),
  };
}

describe("dimension-clock runtime", () => {
  it("writes the value of this turn's clock as one versioned update", async () => {
    const { proposals, records } = await turn(start(), 75);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "dimension.update",
      payload: {
        updates: [
          {
            id: "storm",
            expectedVersion: 1,
            value: {
              minutesRemaining: 105,
              stage: "approaching",
              frontPassed: false,
            },
          },
        ],
      },
    });
    // Not a settlement of the narrative: that stays with the tracker.
    expect(proposals[0]!.payload).not.toHaveProperty("source");
    expect(records.storm).toMatchObject({ version: 2 });
    expect(records.reputation).toMatchObject({ value: 0, version: 1 });
  });

  it("writes nothing at the start, without a clock, or when the turn is run again", async () => {
    expect((await turn(start(), 0)).proposals).toEqual([]);
    expect((await turn(start())).proposals).toEqual([]);
    const { records } = await turn(start(), 75);
    expect((await turn(records, 75)).proposals).toEqual([]);
  });

  it("follows the clock over turns, a skipped turn and a fork back", async () => {
    let records = start();
    const seen: unknown[] = [];
    // 150 after a turn at which nothing ran; 20 is a fork to an early turn.
    for (const elapsed of [10, 70, 150, 185, 20]) {
      records = (await turn(records, elapsed)).records;
      const value = records.storm!.value as Record<string, unknown>;
      seen.push([elapsed, value.minutesRemaining, value.stage]);
    }
    expect(seen).toEqual([
      [10, 170, "distant"],
      [70, 110, "approaching"],
      [150, 30, "imminent"],
      [185, 0, "overhead"],
      [20, 160, "distant"],
    ]);
  });
});

describe("the tracker beside a derived field", () => {
  const settle = async (records: Records, updates: unknown[]) => {
    const result = await updateDimensions({ tool, z }).execute(
      { followsClock: [], updates },
      {
        ...base,
        runtimeId: "world-init/dimension-tracker",
        locale: "en-US",
        inputSlots: {
          narrative: {
            cardinality: "one",
            value: "The front rolls off to the east.",
            source: { pluginId: "story", runtimeId: "story", resultId: "r" },
          },
        },
        world: { dimensions: snapshot(records) },
        store: {
          listPluginData: async () =>
            Object.entries(records).map(([key, value]) => ({ key, value })),
          getPluginData: async () => null,
          getSession: async () => ({ completedPlayerTurns: 3 }),
        },
      } as never,
    );
    expect(getToolContent(result)).toMatchObject({ success: true });
    return getPendingProposals(result)[0]!.payload.updates;
  };

  it("settles its own field and cannot move the derived ones", async () => {
    const { records } = await turn(start(), 185);
    const settled = {
      minutesRemaining: 0,
      stage: "overhead",
      frontPassed: true,
    };
    // A change of its field, a whole value without the fields it is not
    // shown, and a write of a derived field.
    for (const update of [
      { id: "storm", changes: [{ path: "frontPassed", value: true }] },
      { id: "storm", value: { frontPassed: true } },
      {
        id: "storm",
        changes: [
          { path: "frontPassed", value: true },
          { path: "minutesRemaining", value: 60 },
          { path: "stage", value: "distant" },
        ],
      },
    ])
      expect(await settle(records, [update])).toEqual([
        { id: "storm", expectedVersion: 2, value: settled },
      ]);
  });

  it("is given the rule without the derived fields or their values", async () => {
    type Segment = { id: string; content: string };
    type Handler = (input: unknown, ctx: unknown) => Promise<Segment[]>;
    const handlers = new Map<string, Handler>();
    register({
      provideExtension: (
        _point: string,
        id: string,
        { handler }: { handler: Handler },
      ) => handlers.set(id, handler),
      registerTool: () => {},
      toolkit: { tool, z },
      on: () => {},
    } as never);
    const { records } = await turn(start(), 75);
    const ctx = {
      locale: "en-US",
      pluginData: {
        list: async () =>
          Object.entries(records).map(([key, value]) => ({ key, value })),
      },
      world: { dimensions: snapshot(records) },
    };
    const tracker = (await handlers.get("dimension-rules")!({}, ctx))
      .map((segment) => segment.content)
      .join("\n");
    expect(tracker).toContain('storm: {"frontPassed":false}');
    expect(tracker).toContain('"required":["frontPassed"]');
    expect(tracker).not.toMatch(/minutesRemaining|stage|x-derive/);
    // The narrator reads the computed value, in the part that changes by turn.
    const story = await handlers.get("dimensions")!({}, ctx);
    expect(
      story.find((segment) => segment.id === "dimensions")!.content,
    ).toMatch(/105/);
  });

  it("counts a dimension with only derived fields as changing in play", async () => {
    const handlers = new Map<string, (i: unknown, c: unknown) => unknown>();
    register({
      provideExtension: (
        _point: string,
        id: string,
        { handler }: { handler: (i: unknown, c: unknown) => unknown },
      ) => handlers.set(id, handler),
      registerTool: () => {},
      toolkit: { tool, z },
      on: () => {},
    } as never);
    const { frontPassed: _field, ...properties } = definition.schema.properties;
    const derivedOnly = {
      name: "Countdown",
      schema: {
        ...definition.schema,
        properties,
        required: ["minutesRemaining", "stage"],
      },
      initialValue: { minutesRemaining: 180, stage: "distant" },
    };
    const records = {
      storm: {
        definition: derivedOnly,
        value: derivedOnly.initialValue,
        version: 1,
      },
    } as never as Records;
    const segments = (await handlers.get("dimensions")!(
      {},
      {
        locale: "en-US",
        pluginData: {
          list: async () =>
            Object.entries(records).map(([key, value]) => ({ key, value })),
        },
        world: { dimensions: snapshot(records) },
      },
    )) as { id: string }[];
    expect(segments.map((segment) => segment.id)).toEqual(["dimensions"]);
  });
});
