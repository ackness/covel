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
      [
        "meg-offer: only pending planned events can be retired",
        "meg-offer: this event already fired",
        "meg-offer: unknown dimension: weather",
        "meg-offer: unknown time field: period",
        "meg-offer: unknown event: kings-secret",
      ].join("\n"),
    );
  });

  it("accepts an empty plan", async () => {
    expect(await run({ events: [] })).toEqual({
      events: [],
      reason: "Thread from this turn.",
    });
  });
});

describe("story-event.plan@1 schema", () => {
  it("matches the copy owned by story-events", async () => {
    const { readFile } = await import("node:fs/promises");
    const read = (path) =>
      readFile(new URL(path, import.meta.url), "utf8").then(JSON.parse);
    expect(await read("../schemas/story-event-plan.schema.json")).toEqual(
      await read("../../story-events/schemas/story-event-plan.schema.json"),
    );
  });
});
