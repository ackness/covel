import { describe, expect, it } from "vitest";
import { evaluateCondition, localizedText } from "../lib/conditions.js";

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

describe("localizedText", () => {
  it("prefers the exact locale, then the same language, then any text", () => {
    const text = { "zh-CN": "灯塔", "en-US": "Lighthouse" };
    expect(localizedText(text, "en-US")).toBe("Lighthouse");
    expect(localizedText(text, "en-GB")).toBe("Lighthouse");
    expect(localizedText(text, "ru-RU")).toBe("灯塔");
    expect(localizedText("plain", "en-US")).toBe("plain");
  });
});
