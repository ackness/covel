import { describe, expect, it } from "vitest";
import {
  applyDimensionDerivations,
  dimensionSchemaWithoutDerived,
  dimensionValueWithoutDerived,
  keepDerivedDimensionFields,
  worldDimensionDefinitionSchema,
  type DimensionValueSchema,
} from "../src/dimensions.js";

const countdown = {
  source: "clock.elapsedSinceStart",
  start: 180,
  perUnit: -1,
  min: 0,
  max: 180,
} as const;
const schema: DimensionValueSchema = {
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
};
const initialValue = {
  minutesRemaining: 180,
  stage: "distant",
  frontPassed: false,
};
const definition = {
  name: "Countdown",
  schema,
  initialValue,
  updateRule: "Set frontPassed when the front has moved on.",
};
const at = (elapsedSinceStart: number, value: unknown = initialValue) =>
  applyDimensionDerivations(schema, value as never, {
    clock: { elapsedSinceStart },
  });

describe("clock-derived dimension fields", () => {
  it("computes the number and the label of each range edge from the clock", () => {
    expect(
      [0, 59, 60, 149, 150, 179, 180, 400].map((elapsed) => {
        const value = at(elapsed) as typeof initialValue;
        return [elapsed, value.minutesRemaining, value.stage];
      }),
    ).toEqual([
      [0, 180, "distant"],
      [59, 121, "distant"],
      [60, 120, "approaching"],
      [149, 31, "approaching"],
      [150, 30, "imminent"],
      [179, 1, "imminent"],
      [180, 0, "overhead"],
      // Past the end the number stays on its bound.
      [400, 0, "overhead"],
    ]);
    // A clock that ran backwards past the start stays on the other bound.
    expect(at(-30)).toMatchObject({ minutesRemaining: 180, stage: "distant" });
  });

  it("depends on the clock only, not on the value before", () => {
    const late = at(170);
    // A turn run again at the same clock, and a fork back to an earlier one.
    expect(at(170, late)).toEqual(late);
    expect(at(40, late)).toEqual(at(40));
    // Fields without a derivation pass through.
    expect(at(100, { ...initialValue, frontPassed: true })).toEqual({
      minutesRemaining: 80,
      stage: "approaching",
      frontPassed: true,
    });
    // Without a clock nothing is computed.
    expect(applyDimensionDerivations(schema, late, {})).toEqual(late);
  });

  it("rounds a fractional rate to an integer field and derives a whole value", () => {
    const fuel: DimensionValueSchema = {
      type: "integer",
      "x-derive": {
        source: "clock.elapsedSinceStart",
        start: 10,
        perUnit: 0.4,
      },
    };
    expect(
      applyDimensionDerivations(fuel, 10, { clock: { elapsedSinceStart: 4 } }),
    ).toBe(12);
  });

  it("hides derived fields from a writer and keeps them against its write", () => {
    expect(dimensionSchemaWithoutDerived(schema)).toEqual({
      type: "object",
      properties: { frontPassed: { type: "boolean" } },
      required: ["frontPassed"],
      additionalProperties: false,
    });
    const current = at(100);
    expect(dimensionValueWithoutDerived(schema, current)).toEqual({
      frontPassed: false,
    });
    // A whole value without the derived fields, and one that sets them.
    const writes: Record<string, string | number | boolean>[] = [
      { frontPassed: true },
      { frontPassed: true, minutesRemaining: 5, stage: "overhead" },
    ];
    for (const written of writes)
      expect(keepDerivedDimensionFields(schema, written, current)).toEqual({
        minutesRemaining: 80,
        stage: "approaching",
        frontPassed: true,
      });
  });
});

describe("x-derive validation", () => {
  const issues = (
    patch: (draft: {
      schema: { properties: Record<string, Record<string, unknown>> };
      initialValue: Record<string, unknown>;
      updateRule?: string;
    }) => void,
  ) => {
    const draft = structuredClone(definition) as never;
    patch(draft);
    const parsed = worldDimensionDefinitionSchema.safeParse(draft);
    return parsed.success
      ? []
      : parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        );
  };

  it("accepts the declaration", () => {
    expect(issues(() => {})).toEqual([]);
  });

  it("requires the initial value to be the value at the start", () => {
    expect(
      issues((draft) => {
        draft.initialValue.minutesRemaining = 170;
        draft.initialValue.stage = "approaching";
      }),
    ).toEqual([
      "initialValue.minutesRemaining: Must be 180: the value x-derive gives at the start",
      'initialValue.stage: Must be "distant": the value x-derive gives at the start',
    ]);
  });

  it("names what is wrong with a declaration", () => {
    const stage = (draft: Parameters<Parameters<typeof issues>[0]>[0]) =>
      draft.schema.properties.stage!["x-derive"] as {
        ranges: { from?: number; to?: number; value: unknown }[];
      };
    const minutes = (draft: Parameters<Parameters<typeof issues>[0]>[0]) =>
      draft.schema.properties.minutesRemaining!["x-derive"] as Record<
        string,
        unknown
      >;
    // A label the field does not allow.
    expect(
      issues((draft) => {
        stage(draft).ranges[1]!.value = "close";
      }).join("\n"),
    ).toContain('"close" is not a value this field allows');
    // A last range that leaves numbers without a label.
    expect(
      issues((draft) => {
        stage(draft).ranges.at(-1)!.to = 0;
      }).join("\n"),
    ).toContain("give it no from and no to");
    // A number that can leave the range the field accepts.
    expect(
      issues((draft) => {
        delete minutes(draft).min;
      }).join("\n"),
    ).toContain("The field's minimum is 0: set min to it or above");
    // An unknown source, an unknown key, text without labels.
    expect(
      issues((draft) => {
        minutes(draft).source = "clock.hour";
      }),
    ).not.toEqual([]);
    expect(
      issues((draft) => {
        minutes(draft).formula = "180 - t";
      }),
    ).not.toEqual([]);
    expect(
      issues((draft) => {
        delete (stage(draft) as { ranges?: unknown }).ranges;
      }).join("\n"),
    ).toContain("A derived string needs ranges that name its values");
  });

  it("refuses a derived value with no fixed place", () => {
    const parsed = worldDimensionDefinitionSchema.safeParse({
      name: "Log",
      schema: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            age: { type: "integer", "x-derive": { source: countdown.source } },
          },
        },
      },
      initialValue: {},
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "not an array element or a dynamically named record",
    );
  });
});
