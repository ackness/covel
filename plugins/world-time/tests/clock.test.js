import { describe, expect, it } from "vitest";
import { worldTimeSchema, validateDimensions } from "@covel/shared";
import {
  DEFAULT_TIME,
  advanceTime,
  describeTime,
  initialTick,
} from "../clock.js";

const calendar = {
  ...DEFAULT_TIME,
  calendar: {
    era: "Tide",
    months: [
      { name: "Short", days: 2 },
      { name: "Long", days: 3 },
    ],
    hoursPerDay: 10,
    minutesPerHour: 6,
    periods: [
      { name: "Light", startHour: 0 },
      { name: "Dark", startHour: 5 },
    ],
  },
  initial: { year: 3, month: 1, day: 2, hour: 9, minute: 5 },
};
const phases = {
  kind: "phases",
  name: "Dream",
  cycleLabel: "Loop",
  phases: ["Dawn", "Dusk", "Night"],
  initial: { cycle: 0, phase: 0 },
  evolution: { mode: "backward", defaultStep: 1, maxStep: 12 },
};

describe("world-owned time", () => {
  it("advances and reverses an authored week from its initial anchor", () => {
    const definition = {
      ...calendar,
      calendar: { ...calendar.calendar, weekdays: ["A", "B", "C"] },
      initial: { ...calendar.initial, weekday: 1 },
    };
    expect(worldTimeSchema.safeParse(definition).success).toBe(true);
    const start = initialTick(definition);
    expect(describeTime(definition, start).weekday).toBe("B");
    expect(describeTime(definition, start + 60).weekday).toBe("C");
    expect(describeTime(definition, start - 120).weekday).toBe("C");
  });
  it("validates as an ordinary dimension including external dimension imports", () => {
    expect(validateDimensions({ time: calendar }).valid).toBe(true);
    expect(validateDimensions({ time: phases }).valid).toBe(true);
    expect(
      validateDimensions({
        time: { ...calendar, initial: { ...calendar.initial, day: 3 } },
      }).valid,
    ).toBe(false);
  });
  it("carries custom minutes, hours and unequal month lengths deterministically", () => {
    const tick = initialTick(calendar);
    const next = advanceTime(calendar, tick, { amount: 1 }, "turn");
    expect(describeTime(calendar, next.tick)).toMatchObject({
      year: 3,
      month: 2,
      day: 1,
      hour: 0,
      minute: 0,
      period: "Light",
    });
    expect(describeTime(calendar, next.tick + 3 * 60)).toMatchObject({
      year: 4,
      month: 1,
      day: 1,
    });
  });
  it("supports reverse calendar movement across the epoch", () => {
    const definition = {
      ...calendar,
      evolution: { ...calendar.evolution, mode: "backward" },
    };
    expect(
      describeTime(
        definition,
        advanceTime(definition, 0, { amount: 1 }, "t").tick,
      ),
    ).toMatchObject({ year: 0, month: 2, day: 3, hour: 9, minute: 5 });
  });
  it("wraps coarse phases backwards without inventing clock hours", () => {
    const next = advanceTime(phases, initialTick(phases), {}, "t");
    expect(describeTime(phases, next.tick)).toEqual({
      cycle: -1,
      phase: 2,
      period: "Night",
      display: "Loop -1 · Night",
    });
  });
  it("allows explicit bidirectional movement and freezing", () => {
    const definition = {
      ...phases,
      evolution: { ...phases.evolution, mode: "bidirectional" },
    };
    expect(
      advanceTime(
        definition,
        5,
        { amount: 2, unit: "cycle", direction: "backward" },
        "t",
      ).tick,
    ).toBe(-1);
    expect(advanceTime(definition, 5, { amount: 0 }, "t").tick).toBe(5);
  });
  it("samples signed random time reproducibly within the authored range", () => {
    const definition = {
      ...phases,
      evolution: {
        mode: "random",
        defaultStep: 1,
        maxStep: 4,
        randomRange: { min: -4, max: 4 },
      },
    };
    const samples = Array.from(
      { length: 100 },
      (_, i) => advanceTime(definition, 0, {}, `turn-${i}`).delta,
    );
    expect(samples.every((value) => value >= -4 && value <= 4)).toBe(true);
    expect(samples.some((value) => value < 0)).toBe(true);
    expect(samples.some((value) => value > 0)).toBe(true);
    expect(advanceTime(definition, 0, {}, "stable")).toEqual(
      advanceTime(definition, 0, {}, "stable"),
    );
    expect(() => advanceTime(definition, 0, { amount: 1 }, "t")).toThrow(
      /omit/,
    );
  });
  it("rejects unsupported units, direction violations, excessive spans and overflow", () => {
    expect(() =>
      advanceTime(phases, 0, { amount: 1, unit: "hour" }, "t"),
    ).toThrow(/Unit/);
    expect(() => advanceTime(calendar, 0, { unit: "day" }, "t")).toThrow(
      /Specify amount/,
    );
    expect(() =>
      advanceTime(calendar, 0, { direction: "backward" }, "t"),
    ).toThrow(/policy/);
    expect(() => advanceTime(phases, 0, { amount: 13 }, "t")).toThrow(
      /maxStep/,
    );
    expect(() =>
      advanceTime(calendar, Number.MAX_SAFE_INTEGER, { amount: 1 }, "t"),
    ).toThrow(/safe integer/);
  });
  it("rejects invalid phase indices, unordered periods and random ranges", () => {
    expect(
      worldTimeSchema.safeParse({ ...phases, initial: { cycle: 1, phase: 3 } })
        .success,
    ).toBe(false);
    expect(
      worldTimeSchema.safeParse({
        ...phases,
        evolution: { mode: "random", defaultStep: 1, maxStep: 2 },
      }).success,
    ).toBe(false);
    expect(
      worldTimeSchema.safeParse({
        ...calendar,
        calendar: {
          ...calendar.calendar,
          periods: [
            { name: "Late", startHour: 9 },
            { name: "Early", startHour: 2 },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
