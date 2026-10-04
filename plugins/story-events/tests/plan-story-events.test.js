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

  it("reports unknown references and fired events so the model can correct them", async () => {
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
        "meg-offer: this event already fired",
        "meg-offer: unknown dimension: weather. The dimensions are: factionStanding",
        "meg-offer: unknown time field: period. The numeric fields of worldTime.value are: phase",
        "meg-offer: unknown event: kings-secret. `revealed` takes the ID of an event in storyEvents.value (meg-offer, dock-fire) or of an event in this call. Use one of them or remove the condition",
      ].join("\n"),
    );
  });

  it("says how to write a condition that mixes kinds or operators", async () => {
    const event = (all) => ({
      events: [{ id: "watch", title: "Watch", all, payload: "Brief." }],
    });
    await expect(
      run(event([{ dimension: "factionStanding", revealed: "meg-offer" }])),
    ).rejects.toThrow(
      "watch: a condition references exactly one of dimension, time, revealed; this one has dimension and revealed. Write one condition for each",
    );
    await expect(
      run(event([{ time: "phase", gte: 2, lte: 4 }])),
    ).rejects.toThrow(
      "watch: a dimension or time condition has exactly one operator; this one has gte and lte. For a range, write two conditions",
    );
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
