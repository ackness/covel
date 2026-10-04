import { describe, expect, it, vi } from "vitest";
import { loadPluginMessages } from "@covel/plugin-test-utils";
import { validateDimensions } from "@covel/shared";
import { worldTimeSchema } from "../schema.js";
import {
  DEFAULT_TIME,
  advanceTime,
  describeTime,
  initialTick,
  loadTime,
  timeUnits,
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
  it("keeps time out of kernel dimensions and validates plugin definitions", () => {
    expect(validateDimensions({ time: calendar }).valid).toBe(false);
    expect(worldTimeSchema.safeParse(calendar).success).toBe(true);
    expect(worldTimeSchema.safeParse(phases).success).toBe(true);
    expect(
      worldTimeSchema.safeParse({
        ...calendar,
        initial: { ...calendar.initial, day: 3 },
      }).success,
    ).toBe(false);
  });
  it("adopts imported definitions before the first turn and uses the default when absent", async () => {
    const imported = {
      getPluginData: async (namespace) =>
        namespace === "definitions"
          ? { value: { id: "world", definition: phases } }
          : null,
    };
    expect(await loadTime(imported, "en")).toMatchObject({
      definition: phases,
      tick: initialTick(phases),
    });
    expect(
      await loadTime({ getPluginData: async () => null }, "en"),
    ).toMatchObject({
      definition: DEFAULT_TIME,
      tick: initialTick(DEFAULT_TIME),
    });
  });
  it("names the default calendar in the session's language only", async () => {
    const store = { getPluginData: async () => null };
    const messages = await loadPluginMessages(
      new URL("..", import.meta.url),
      "zh-CN",
    );
    const chinese = await loadTime(store, "zh-CN", {
      locale: "zh-CN",
      messages,
    });

    // Plain text: the definition is stored and given to the narrative, and a
    // table of every language would put all of them into each prompt.
    expect(chinese.definition.name).toBe("世界时间");
    expect(chinese.definition.calendar.months[2].name).toBe("3月");
    expect(chinese.definition.calendar.periods.map((p) => p.name)).toEqual([
      "深夜",
      "早晨",
      "下午",
      "夜晚",
    ]);
    expect(chinese.display).toBe("世界历 1 · 1月 1 · 08:00 · 早晨");
    expect(JSON.stringify(DEFAULT_TIME)).not.toMatch(/[\u4e00-\u9fff]/);
    expect((await loadTime(store, "en")).display).toBe(
      "World era 1 · Month 1 1 · 08:00 · Morning",
    );
  });
  it.each([
    { ...phases, initial: { cycle: 0, phase: 99 } },
    { ...calendar, initial: { ...calendar.initial, day: 99 } },
  ])(
    "rejects invalid imported calendar semantics without committing a clock",
    async (definition) => {
      const store = {
        getPluginData: async (namespace) =>
          namespace === "definitions"
            ? { value: { id: "world", definition } }
            : null,
        setPluginData: vi.fn(),
      };
      await expect(loadTime(store, "en")).rejects.toThrow();
      expect(store.setPluginData).not.toHaveBeenCalled();
    },
  );
  it("does not reinterpret an existing clock after imported definitions change", async () => {
    const adopted = {
      schemaVersion: 1,
      definition: calendar,
      tick: initialTick(calendar) + 30,
    };
    const store = {
      getPluginData: async (namespace) => ({
        value:
          namespace === "clock"
            ? adopted
            : {
                id: "world",
                definition: { ...phases, initial: { cycle: 0, phase: 99 } },
              },
      }),
    };
    expect(await loadTime(store, "en")).toMatchObject(adopted);
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
  it("names the units of the clock and takes zero in any unit", () => {
    expect(timeUnits(phases)).toEqual(["phase", "cycle"]);
    expect(timeUnits(calendar)).toEqual(["minute", "hour", "day"]);
    // A short scene on a phase clock: the model reports minutes.
    expect(() =>
      advanceTime(phases, 0, { amount: 15, unit: "minute" }, "t"),
    ).toThrow(/Use unit "phase" or "cycle"\. Use amount 0/);
    expect(() =>
      advanceTime(calendar, 0, { amount: 1, unit: "phase" }, "t"),
    ).toThrow(/Use unit "minute", "hour" or "day"/);
    expect(
      advanceTime(phases, 5, { amount: 0, unit: "minute" }, "t"),
    ).toMatchObject({ tick: 5 });
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
