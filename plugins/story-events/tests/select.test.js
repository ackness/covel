import { describe, expect, it } from "vitest";
import { selectEvent } from "../lib/select.js";

const state = {
  dimensions: { alarm: { value: 4, version: 2 } },
  time: { phase: 3 },
};
const loud = {
  id: "choir",
  when: { dimension: "alarm", gte: 3 },
  payload: "x",
};
const louder = {
  id: "king",
  when: { dimension: "alarm", gte: 4 },
  payload: "y",
  priority: 5,
};

describe("selectEvent", () => {
  it("picks the highest-priority met event, breaking ties by ID", () => {
    expect(
      selectEvent({ events: [loud, louder], revealed: {}, state, turn: 3 })
        .event?.id,
    ).toBe("king");
    const tie = { ...loud, id: "a-first" };
    expect(
      selectEvent({ events: [loud, tie], revealed: {}, state, turn: 3 }).event
        ?.id,
    ).toBe("a-first");
  });

  it("fires once by default and respects cooldown for repeatable events", () => {
    const revealed = { choir: { lastTurn: 2 } };
    expect(
      selectEvent({ events: [loud], revealed, state, turn: 9 }).event,
    ).toBeNull();
    const repeat = { ...loud, once: false, cooldownTurns: 2 };
    expect(
      selectEvent({ events: [repeat], revealed, state, turn: 4 }).event,
    ).toBeNull();
    expect(
      selectEvent({ events: [repeat], revealed, state, turn: 5 }).event?.id,
    ).toBe("choir");
  });

  it("skips disabled events and reports unresolved references without payloads", () => {
    const disabled = { ...loud, enabled: false };
    const broken = {
      id: "broken",
      when: { dimension: "renown", gte: 1 },
      payload: "secret",
    };
    const result = selectEvent({
      events: [disabled, broken],
      revealed: {},
      state,
      turn: 1,
    });
    expect(result.event).toBeNull();
    expect(result.diagnostics).toEqual(["broken: unknown dimension: renown"]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret");
  });
});
