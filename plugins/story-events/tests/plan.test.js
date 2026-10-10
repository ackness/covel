import { describe, expect, it } from "vitest";
import {
  applyPlans,
  conditionIssues,
  MAX_PENDING_PLANNED,
} from "../lib/plan.js";

const refs = {
  dimensions: new Set(["location"]),
  timeFields: new Set(["phase"]),
  eventIds: new Set(["first"]),
};

function planned(id, extra = {}) {
  return {
    id,
    when: { dimension: "location", equals: "pier" },
    payload: "Something happens.",
    ...extra,
  };
}

function apply(events, state = {}) {
  return applyPlans({
    plans: [
      {
        value: { events, retire: state.retire },
        source: { pluginId: "planner", runtimeId: "planner/plot" },
      },
    ],
    authored: state.authored ?? { first: planned("first") },
    planned: state.planned ?? {},
    revealed: state.revealed ?? {},
    dimensions: refs.dimensions,
    timeFields: refs.timeFields,
    turn: 7,
  });
}

describe("conditionIssues", () => {
  it("accepts every leaf kind and reports unknown references", () => {
    expect(
      conditionIssues(
        {
          all: [
            { dimension: "location", equals: "pier" },
            { time: "phase", gte: 2 },
            { not: { revealed: "first", turnsSinceLte: 2 } },
            { turnGte: 9 },
            { turnGte: 4, turnLte: 12 },
          ],
        },
        refs,
      ),
    ).toEqual([]);
    expect(
      conditionIssues(
        {
          any: [
            { dimension: "mood", equals: 1 },
            { time: "weekday", equals: 1 },
            { revealed: "missing" },
            { dimension: "location", gte: "high" },
            { dimension: "location", time: "phase", equals: 1 },
            { turnGte: -1 },
            { turnGte: 3, gte: 3 },
          ],
        },
        refs,
      ),
    ).toEqual([
      "unknown dimension: mood",
      "unknown time field: weekday",
      "unknown event: missing",
      "gte needs a number",
      "a condition leaf references exactly one of dimension, time, revealed, or the session turn (turnGte / turnLte)",
      "turnGte must be a non-negative integer",
      "a turn condition takes no operator",
    ]);
  });
});

describe("applyPlans", () => {
  it("stores a valid event as a once-only planned event with its origin", () => {
    const result = apply([planned("pier-ghost", { title: "Pier Ghost" })]);
    expect(result.accepted).toEqual(["pier-ghost"]);
    expect(result.rejected).toEqual([]);
    expect(result.writes).toEqual([
      {
        key: "pier-ghost",
        value: {
          ...planned("pier-ghost", { title: "Pier Ghost" }),
          once: true,
          origin: { pluginId: "planner", runtimeId: "planner/plot" },
          plannedTurn: 7,
        },
      },
    ]);
  });

  it("lets events in one plan chain on each other", () => {
    const result = apply([
      planned("step-one"),
      planned("step-two", { when: { revealed: "step-one", turnsSinceGte: 1 } }),
    ]);
    expect(result.accepted).toEqual(["step-one", "step-two"]);
  });

  it("never replaces authored or fired events and reports without payloads", () => {
    const result = apply([planned("first"), planned("old-news")], {
      planned: { "old-news": planned("old-news") },
      revealed: { "old-news": { lastTurn: 2 } },
    });
    expect(result.writes).toEqual([]);
    expect(result.rejected).toEqual([
      {
        id: "first",
        origin: "planner/plot",
        reason: "the world already defines this event",
      },
      { id: "old-news", origin: "planner/plot", reason: "already fired" },
    ]);
    expect(apply([{ ...planned("bad"), once: false }], {}).rejected).toEqual([
      {
        id: "bad",
        origin: "planner/plot",
        reason: "unknown event field: once",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("Something happens");
  });

  it("retires pending planned events and caps how many may wait", () => {
    const full = Object.fromEntries(
      Array.from({ length: MAX_PENDING_PLANNED }, (_, i) => [
        `wait-${i}`,
        planned(`wait-${i}`),
      ]),
    );
    const capped = apply([planned("one-more")], { planned: full });
    expect(capped.accepted).toEqual([]);
    expect(capped.rejected[0].reason).toMatch(/at most/);

    const swapped = apply([planned("one-more")], {
      planned: full,
      retire: ["wait-0"],
    });
    expect(swapped.retired).toEqual(["wait-0"]);
    expect(swapped.accepted).toEqual(["one-more"]);
    expect(
      swapped.writes.map((write) => [write.key, write.value === null]),
    ).toEqual([
      ["wait-0", true],
      ["one-more", false],
    ]);
  });
});
