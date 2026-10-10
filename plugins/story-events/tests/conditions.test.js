import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../lib/conditions.js";

const state = {
  dimensions: {
    location: { value: "lighthouse", version: 3 },
    reputation: { value: { score: 64, title: "trusted" }, version: 5 },
    discoveries: { value: ["harbor", "lighthouse"], version: 2 },
  },
  time: { phase: 3, cycle: 2 },
};

describe("evaluateCondition", () => {
  it("combines dimension and time leaves with all / any / not", () => {
    const when = {
      all: [
        { time: "phase", in: [3, 4] },
        { dimension: "location", equals: "lighthouse" },
        { dimension: "reputation", path: "score", gte: 60 },
        { not: { dimension: "reputation", path: "title", equals: "wanted" } },
        {
          any: [
            { dimension: "discoveries", path: [0], equals: "nowhere" },
            { dimension: "discoveries", path: "1", equals: "lighthouse" },
          ],
        },
      ],
    };
    expect(evaluateCondition(when, state)).toEqual({ met: true, issues: [] });
  });

  it("does not coerce types in numeric comparisons", () => {
    const stringScore = {
      dimensions: { reputation: { value: { score: "64" }, version: 1 } },
      time: null,
    };
    expect(
      evaluateCondition(
        { dimension: "reputation", path: "score", gte: 60 },
        stringScore,
      ).met,
    ).toBe(false);
  });

  it("treats unknown dimensions and missing world time as unmet and reports why", () => {
    expect(evaluateCondition({ dimension: "renown", gte: 1 }, state)).toEqual({
      met: false,
      issues: ["unknown dimension: renown"],
    });
    expect(
      evaluateCondition(
        { time: "phase", equals: 3 },
        { dimensions: {}, time: null },
      ),
    ).toEqual({ met: false, issues: ["world time is unavailable"] });
  });

  it("never lets `not` turn an unavailable reference into a met condition", () => {
    const noTime = { dimensions: state.dimensions, time: null };
    expect(
      evaluateCondition({ not: { time: "phase", equals: 3 } }, noTime),
    ).toEqual({ met: false, issues: ["world time is unavailable"] });
    expect(
      evaluateCondition({ not: { dimension: "renown", gte: 1 } }, state),
    ).toEqual({ met: false, issues: ["unknown dimension: renown"] });
    expect(
      evaluateCondition({ not: { not: { time: "phase", equals: 3 } } }, noTime)
        .met,
    ).toBe(false);
    // A reference that exists is still negated normally.
    expect(
      evaluateCondition({ not: { time: "phase", equals: 9 } }, state),
    ).toEqual({ met: true, issues: [] });
  });

  it("keeps the decidable branches of all / any around an unavailable reference", () => {
    const noTime = { dimensions: state.dimensions, time: null };
    const unavailable = { time: "phase", equals: 3 };
    const holds = { dimension: "location", equals: "lighthouse" };
    const fails = { dimension: "location", equals: "harbor" };
    expect(evaluateCondition({ any: [unavailable, holds] }, noTime).met).toBe(
      true,
    );
    expect(evaluateCondition({ any: [unavailable, fails] }, noTime).met).toBe(
      false,
    );
    expect(evaluateCondition({ all: [unavailable, holds] }, noTime).met).toBe(
      false,
    );
    // `all` is already false, so negating it holds whatever the time is.
    expect(
      evaluateCondition({ not: { all: [unavailable, fails] } }, noTime),
    ).toEqual({ met: true, issues: ["world time is unavailable"] });
    expect(
      evaluateCondition({ not: { any: [unavailable, fails] } }, noTime).met,
    ).toBe(false);
  });

  it("rejects leaves without exactly one operator", () => {
    const result = evaluateCondition(
      { dimension: "location", equals: "lighthouse", in: ["lighthouse"] },
      state,
    );
    expect(result.met).toBe(false);
    expect(result.issues).toEqual([
      "a condition leaf needs exactly one operator",
    ]);
  });

  it("checks presence with exists", () => {
    expect(
      evaluateCondition(
        { dimension: "reputation", path: "title", exists: true },
        state,
      ).met,
    ).toBe(true);
    expect(
      evaluateCondition(
        { dimension: "reputation", path: "missing", exists: false },
        state,
      ).met,
    ).toBe(true);
  });
});

describe("revealed leaves", () => {
  const chain = {
    dimensions: {},
    time: null,
    turn: 9,
    eventIds: new Set(["first", "second"]),
    revealed: { first: { firstTurn: 4, lastTurn: 5 } },
  };

  it("holds once the referenced event fired, bounded by turns since", () => {
    expect(evaluateCondition({ revealed: "first" }, chain).met).toBe(true);
    expect(evaluateCondition({ revealed: "second" }, chain).met).toBe(false);
    expect(
      evaluateCondition({ revealed: "first", turnsSinceGte: 4 }, chain).met,
    ).toBe(true);
    expect(
      evaluateCondition({ revealed: "first", turnsSinceGte: 5 }, chain).met,
    ).toBe(false);
    expect(
      evaluateCondition({ revealed: "first", turnsSinceLte: 3 }, chain).met,
    ).toBe(false);
    expect(evaluateCondition({ not: { revealed: "second" } }, chain).met).toBe(
      true,
    );
  });

  it("reports references to events that do not exist", () => {
    expect(evaluateCondition({ revealed: "missing" }, chain)).toEqual({
      met: false,
      issues: ["unknown event: missing"],
    });
  });
});

describe("turn leaves", () => {
  it("holds from, up to, or between session turns", () => {
    const at = (turn) => ({ ...state, turn });
    expect(evaluateCondition({ turnGte: 6 }, at(5)).met).toBe(false);
    expect(evaluateCondition({ turnGte: 6 }, at(6)).met).toBe(true);
    expect(evaluateCondition({ turnLte: 6 }, at(7)).met).toBe(false);
    expect(evaluateCondition({ turnGte: 4, turnLte: 6 }, at(5)).met).toBe(true);
    // "Not yet turn 6" is an event that expires.
    expect(evaluateCondition({ not: { turnGte: 6 } }, at(5)).met).toBe(true);
    expect(evaluateCondition({ not: { turnGte: 6 } }, at(6)).met).toBe(false);
  });

  it("stays unmet, also under `not`, when the turn is unknown", () => {
    expect(evaluateCondition({ not: { turnGte: 6 } }, state)).toEqual({
      met: false,
      issues: ["the session turn is unavailable"],
    });
  });
});
