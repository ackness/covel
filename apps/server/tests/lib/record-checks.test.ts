import { describe, expect, it } from "vitest";
import { parsePluginMd } from "@covel/plugin-loader";
import type { DimensionValueSchema } from "@covel/shared";
import { checkRecordDimensionReferences } from "../../src/world-data/record-checks.js";
import { registry, worldIrEntry } from "./world-data-projection-fixtures.js";

const catalogue = registry([
  {
    ...worldIrEntry(),
    id: "condition-probe",
    packageManifest: parsePluginMd(
      `---
id: condition-probe
kind: plugin
description: A community condition shape
contributes:
  data:
    rules:
      version: 1
      schema: ./rules.json
      accepts: [probe.rules@1]
      authoring:
        title: Rules
        references:
          - path: when.**.ref
            to: world-dimension
            within: [at]
            values: [candidate, "choices[]", nested.value]
---`,
      "/probe/PLUGIN.md",
    ),
  },
]);

function check(
  schema: DimensionValueSchema,
  condition: Record<string, unknown>,
) {
  return checkRecordDimensionReferences({
    record: { when: { all: [{ ref: "weather", ...condition }] } },
    contract: "probe.rules@1",
    catalogue,
    dimensions: { weather: { name: "Weather", schema, initialValue: null } },
    pointer: "[2]",
  });
}

describe("declared dimension candidate paths", () => {
  it("uses declared fields for scalar, list and nested candidates", () => {
    const schema = { type: "string", enum: ["rain", "sun"] } as const;
    expect(
      check(schema, { candidate: "rain", choices: ["rain", "sun"] }),
    ).toEqual([]);
    expect(
      check(schema, {
        candidate: "snow",
        choices: ["rain", "snow"],
        nested: { value: 3 },
      }).map((item) => item.pointer),
    ).toEqual([
      "[2].when.all[0].candidate",
      "[2].when.all[0].choices[1]",
      "[2].when.all[0].nested.value",
    ]);
    // No operator-name assumptions; only declarations give a field meaning.
    expect(check(schema, { equals: "snow", in: ["snow"] })).toEqual([]);
    expect(check(schema, {})).toEqual([]);
  });

  it("checks nested property, additional-property and array item schemas", () => {
    const schema = {
      type: "object",
      additionalProperties: { type: "array", items: { type: "integer" } },
    } as const;
    expect(check(schema, { at: ["room", 0], candidate: 2 })).toEqual([]);
    expect(check(schema, { at: "room.0", candidate: "two" })[0]).toMatchObject({
      message: expect.stringContaining("Expected integer"),
    });
    expect(
      check(
        { type: "object", properties: { sunny: { type: "boolean" } } },
        { at: "sunny", candidate: "true" },
      )[0],
    ).toMatchObject({ message: expect.stringContaining("Expected boolean") });
  });

  it("keeps whole arrays, objects and null as candidate values", () => {
    expect(
      check(
        { type: "array", items: { type: "integer" } },
        { candidate: [1, 2] },
      ),
    ).toEqual([]);
    expect(
      check(
        { type: "array", items: { type: "integer" } },
        { candidate: [1, "two"] },
      )[0]?.pointer,
    ).toBe("[2].when.all[0].candidate[1]");
    expect(
      check({ enum: [{ a: 1, b: 2 }] }, { candidate: { b: 2, a: 1 } }),
    ).toEqual([]);
    expect(check({ type: ["string", "null"] }, { candidate: null })).toEqual(
      [],
    );
    expect(
      check({ type: "string" }, { candidate: null })[0]?.message,
    ).toContain("Expected string");
  });

  it.each([
    [{}, "field"],
    [
      { type: ["object", "array"], properties: { field: { type: "string" } } },
      "field",
    ],
    [{ type: "object", additionalProperties: true }, "field"],
    [{ type: "array" }, "0"],
    [{ anyOf: [{ type: "string" }] }, undefined],
  ])("does not reject indeterminate schema paths (%j)", (schema, at) => {
    expect(check(schema as DimensionValueSchema, { at, candidate: 7 })).toEqual(
      [],
    );
  });
});
