import { describe, expect, it } from "vitest";
import { z } from "zod";
import createTool from "../tools/plan-story-events.js";

const planTool = createTool({ tool: (definition) => definition, z });

function context() {
  return {
    inputSlots: {
      storyEvents: {
        cardinality: "one",
        value: {
          turn: 5,
          revealed: [{ eventId: "meg-offer", lastTurn: 4 }],
          planned: [{ eventId: "dock-fire", plannedTurn: 2 }],
        },
      },
      dimensions: {
        cardinality: "one",
        value: {
          factionStanding: {
            name: "Factions",
            schema: {},
            value: {},
            version: 1,
          },
          alarm: {
            name: "Alarm",
            schema: {
              type: "object",
              properties: {
                level: { type: "integer", minimum: 0, maximum: 6 },
                stage: { type: "string", enum: ["quiet", "awake"] },
              },
              additionalProperties: false,
            },
            value: { level: 1, stage: "quiet" },
            version: 3,
          },
          map: {
            name: "Map",
            schema: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["rumored", "explored"] },
                  note: { type: "string" },
                },
                additionalProperties: false,
              },
            },
            value: { hall: { status: "rumored" } },
            version: 2,
          },
        },
      },
      worldTime: { cardinality: "one", value: { phase: 2, period: "Dusk" } },
    },
  };
}

function run(params) {
  return planTool.execute(
    planTool.parameters.parse({ reason: "Thread from this turn.", ...params }),
    context(),
  );
}

const plan = (event) => ({
  events: [{ id: "watch", title: "Watch", payload: "Brief.", ...event }],
});
const when = async (event) => (await run(plan(event))).events[0].when;

describe("plan-story-events", () => {
  it("builds a story-events condition tree from all and none", async () => {
    const result = await run({
      events: [
        {
          id: "fangs-collect",
          title: "The Fangs Collect",
          all: [
            { revealed: "meg-offer", turnsSinceGte: 3 },
            {
              dimension: "factionStanding",
              path: "saltFangs.attitude",
              lte: 0,
            },
          ],
          none: [{ revealed: "dock-fire" }],
          payload: "Two Salt Fangs wait at the hero's lodging.",
        },
      ],
      retire: ["dock-fire"],
    });
    expect(result).toEqual({
      events: [
        {
          id: "fangs-collect",
          title: "The Fangs Collect",
          when: {
            all: [
              { revealed: "meg-offer", turnsSinceGte: 3 },
              {
                dimension: "factionStanding",
                path: "saltFangs.attitude",
                lte: 0,
              },
              { not: { revealed: "dock-fire" } },
            ],
          },
          payload: "Two Salt Fangs wait at the hero's lodging.",
        },
      ],
      retire: ["dock-fire"],
      reason: "Thread from this turn.",
    });
  });

  it("turns a wait into the session turn the event waits for", async () => {
    // The ledger says this is turn 5.
    expect(await when({ all: [{ afterTurns: 2 }] })).toEqual({ turnGte: 7 });
    expect(
      await when({
        all: [{ dimension: "alarm", path: "level", gte: 3 }],
        none: [{ afterTurns: 4 }],
      }),
    ).toEqual({
      all: [
        { dimension: "alarm", path: "level", gte: 3 },
        { not: { turnGte: 9 } },
      ],
    });
    await expect(
      run(plan({ all: [{ afterTurns: 2, gte: 1 }] })),
    ).rejects.toThrow("watch: an `afterTurns` condition has no other field");
  });

  it("plans what follows a fired event under a new ID", async () => {
    // The shape of a recorded call: the event fired this turn, its thread was
    // still open, and the model planned the next step under the ID and the
    // title it read in `revealed`.
    const follow = (id) =>
      run({
        events: [
          {
            id,
            title: "Again",
            all: [{ afterTurns: 1 }, { revealed: "meg-offer" }],
            payload: "The offer comes back with a price.",
          },
        ],
      });
    expect((await follow("meg-offer")).events).toMatchObject([
      { id: "meg-offer-2", when: { all: [{}, { revealed: "meg-offer" }] } },
    ]);
    // A pending event keeps its ID: the plan replaces it.
    expect((await follow("dock-fire")).events[0].id).toBe("dock-fire");
  });

  it("leaves out a text among the events", async () => {
    // The end of a recorded call: `…"payload":"…"},"reason ="]}`.
    const event = plan({ all: [{ afterTurns: 1 }] }).events[0];
    const result = await planTool.execute(
      planTool.parameters.parse({ events: [event, "reason ="] }),
      context(),
    );
    expect(result.events).toHaveLength(1);
    // A call of texts alone holds no event to keep, and it is refused.
    expect(() =>
      planTool.parameters.parse({ events: ["The fangs come back."] }),
    ).toThrow();
  });

  it("takes a plan without a reason", async () => {
    // The reason is a note for debugging. A call without it was rejected.
    const result = await planTool.execute(
      planTool.parameters.parse({ events: [] }),
      context(),
    );
    expect(result).toEqual({ events: [] });
  });

  it("reports unknown references so the model can correct them", async () => {
    await expect(
      run({
        events: [
          {
            id: "meg-offer",
            title: "Again",
            all: [
              { dimension: "weather", equals: "rain" },
              { time: "period", equals: "Dusk" },
              { revealed: "kings-secret" },
            ],
            payload: "Never stored.",
          },
        ],
        retire: ["meg-offer"],
      }),
    ).rejects.toThrow(
      // Each message says what can be used instead, so that the next call
      // does not guess again.
      [
        "meg-offer: only pending planned events can be retired",
        "meg-offer-2: unknown dimension: weather. The dimensions are: factionStanding, alarm, map",
        "meg-offer-2: unknown time field: period. The numeric fields of worldTime.value are: phase",
        'meg-offer-2: unknown event: kings-secret. `revealed` takes the ID of a story event in storyEvents.value (meg-offer, dock-fire) or of an event in this call. Something that happened in the narrative is not a story event. Use one of these IDs, or remove the condition; to make the event come later, use { "afterTurns": n }',
      ].join("\n"),
    );
  });

  it("says how to write a condition that mixes kinds or operators", async () => {
    const mixed = (all) => run(plan({ all }));
    await expect(
      mixed([{ dimension: "factionStanding", revealed: "meg-offer" }]),
    ).rejects.toThrow(
      "watch: a condition has exactly one of dimension, time, revealed, afterTurns; this one has dimension and revealed. Write one condition for each",
    );
    await expect(
      mixed([{ dimension: "alarm", time: "phase", gte: 3 }]),
    ).rejects.toThrow(
      'watch: a condition has `dimension` or `time`, not both; this one has alarm and phase. A world-time condition is { "time", operator }. A dimension condition is { "dimension", "path", operator }',
    );
    await expect(mixed([{ time: "phase", gte: 2, lte: 4 }])).rejects.toThrow(
      "watch: a time condition has exactly one operator (equals, notEquals, in, gte, gt, lte, lt, exists); this one has gte and lte. For a range, write two conditions",
    );
    await expect(mixed([{ dimension: "map" }])).rejects.toThrow(
      "this one has none. For a range, write two conditions",
    );
    await expect(
      mixed([{ dimension: "alarm", path: "level", turnsSinceGte: 2, gte: 1 }]),
    ).rejects.toThrow(
      "watch: turnsSinceGte belongs to a `revealed` condition, not to a dimension condition",
    );
  });

  it("refuses a condition that the dimension's schema can never meet", async () => {
    const never = (condition) => run(plan({ all: [condition] }));
    await expect(
      never({ dimension: "alarm", path: "noise", gte: 2 }),
    ).rejects.toThrow(
      "watch: alarm.noise: the dimension has no such field. Its fields: level (integer), stage (quiet | awake)",
    );
    await expect(never({ dimension: "map", equals: "hall" })).rejects.toThrow(
      "watch: map is object, not one value: `equals` can never hold. Set `path` to one of its fields: <key>.status (rumored | explored), <key>.note (string)",
    );
    await expect(
      never({ dimension: "alarm", path: "stage", gte: 2 }),
    ).rejects.toThrow(
      "watch: alarm.stage is string: `gte` needs a number. Number fields of alarm: level (integer)",
    );
    await expect(
      never({ dimension: "alarm", path: "stage", in: ["loud", "singing"] }),
    ).rejects.toThrow(
      'watch: alarm.stage is never "loud" or "singing". Its values: quiet, awake',
    );
    await expect(never({ time: "phase", in: ["Dusk"] })).rejects.toThrow(
      "watch: time field phase is a number (now 2): compare it with a number",
    );
    // What the schema does not rule out stays the model's to write: a key
    // of a map that is not there yet, and a dimension without a schema.
    expect(
      await when({
        all: [
          { dimension: "map", path: "crypt.status", equals: "explored" },
          { dimension: "factionStanding", path: "fangs.attitude", gte: 1 },
          { dimension: "alarm", path: "stage", in: ["awake", "loud"] },
        ],
      }),
    ).toEqual({
      all: [
        { dimension: "map", path: "crypt.status", equals: "explored" },
        { dimension: "factionStanding", path: "fangs.attitude", gte: 1 },
        { dimension: "alarm", path: "stage", in: ["awake", "loud"] },
      ],
    });
  });

  it("settles the slips that have one meaning", async () => {
    // A bound written as an entry of its own, after its `revealed` condition.
    expect(
      await when({ all: [{ revealed: "meg-offer" }, { turnsSinceGte: 2 }] }),
    ).toEqual({ revealed: "meg-offer", turnsSinceGte: 2 });
    // A condition written on the event; fields given as null; a description
    // beside the payload.
    expect(
      await when({
        all: [{ time: "phase", gte: 3 }],
        revealed: "meg-offer",
        turnsSinceGte: 1,
        none: null,
        description: "The same in one line.",
      }),
    ).toEqual({
      all: [
        { time: "phase", gte: 3 },
        { revealed: "meg-offer", turnsSinceGte: 1 },
      ],
    });
    // `none` written as an entry of `all`, and `notExists`.
    expect(
      await when({
        all: [
          { time: "phase", gte: 3 },
          { none: [{ dimension: "map", path: "crypt", notExists: false }] },
        ],
      }),
    ).toEqual({
      all: [
        { time: "phase", gte: 3 },
        { not: { dimension: "map", path: "crypt", exists: true } },
      ],
    });
    // The operator and its value as two keys; a place for a note left empty.
    expect(
      await when({
        all: [
          { dimension: "alarm", path: "level", operator: "gte", value: 3 },
          { dimension: "map", path: "crypt", operator: "exists" },
        ],
        retireNote: "",
      }),
    ).toEqual({
      all: [
        { dimension: "alarm", path: "level", gte: 3 },
        { dimension: "map", path: "crypt", exists: true },
      ],
    });
    // The world-time input named as the dimension of a time condition.
    expect(
      await when({
        all: [
          { dimension: "worldTime", time: "phase", gte: 3 },
          { dimension: "worldTime", path: "phase", lte: 5 },
        ],
      }),
    ).toEqual({
      all: [
        { time: "phase", gte: 3 },
        { time: "phase", lte: 5 },
      ],
    });
    // A path where the dimension ID goes, and the ID at the start of the path.
    const hall = { dimension: "map", path: "hall.status", equals: "explored" };
    expect(
      await when({
        all: [
          { dimension: "map.hall.status", path: "status", equals: "explored" },
          { dimension: "map.hall", path: "status", equals: "explored" },
          { dimension: "map.hall.status", equals: "explored" },
          { dimension: "alarm.level", path: "alarm.level", gte: 2 },
          { dimension: "alarm", path: "alarm.level", gte: 2 },
        ],
      }),
    ).toEqual({
      all: [
        hall,
        hall,
        hall,
        { dimension: "alarm", path: "level", gte: 2 },
        { dimension: "alarm", path: "level", gte: 2 },
      ],
    });
    // A reading that the schema rules out is not taken.
    await expect(
      run(plan({ all: [{ dimension: "alarm.noise", gte: 2 }] })),
    ).rejects.toThrow("watch: unknown dimension: alarm.noise.");
    // A number comparison on an object with one number field.
    expect(await when({ all: [{ dimension: "alarm", gte: 3 }] })).toEqual({
      dimension: "alarm",
      path: "level",
      gte: 3,
    });
  });

  it("leaves out a guard on an event that does not exist", async () => {
    expect(
      await when({
        all: [{ time: "phase", gte: 3 }],
        none: [{ revealed: "keeper-found" }, { revealed: "dock-fire" }],
      }),
    ).toEqual({
      all: [{ time: "phase", gte: 3 }, { not: { revealed: "dock-fire" } }],
    });
    // In `all` the event would never fire: that stays an error.
    await expect(
      run(plan({ all: [{ revealed: "keeper-found" }] })),
    ).rejects.toThrow("watch: unknown event: keeper-found.");
  });

  it("keeps a description as an error when there is no payload", () => {
    expect(() =>
      planTool.parameters.parse({
        reason: "Thread.",
        events: [
          {
            id: "watch",
            title: "Watch",
            all: [{ afterTurns: 1 }],
            description: "What happens.",
          },
        ],
      }),
    ).toThrow();
  });

  it("takes a reason of a few sentences", async () => {
    const reason = "The keeper lied about the ledger. ".repeat(12).trim();
    expect(reason.length).toBeGreaterThan(300);
    expect((await run({ events: [], reason })).reason).toBe(reason);
  });

  it("accepts an empty plan", async () => {
    expect(await run({ events: [] })).toEqual({
      events: [],
      reason: "Thread from this turn.",
    });
  });
});
