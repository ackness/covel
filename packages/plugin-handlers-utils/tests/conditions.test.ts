import { describe, expect, it } from "vitest";
import {
  CONDITION_OPERATORS,
  NUMERIC_CONDITION_OPERATORS,
  compareCondition,
  conditionOperatorOf,
  readConditionPath,
  type ConditionOperator,
} from "../src/conditions.js";

describe("readConditionPath", () => {
  const value = { items: [{ "dot.key": { score: 3 } }], absent: null };

  it.each([
    ["items.0", { "dot.key": { score: 3 } }],
    [["items", 0, "dot.key", "score"], 3],
    [["items", "0", "dot.key"], { score: 3 }],
    ["", value],
    [[], value],
    [undefined, value],
    ["items.9", undefined],
    ["items.bad", undefined],
    ["missing.score", undefined],
    ["absent.score", undefined],
    [["items", 0, "dot.key", "score", "more"], undefined],
  ] as const)("reads %j", (path, expected) => {
    expect(readConditionPath(value, path)).toEqual(expected);
  });

  it.each([null, undefined, false, 0, "text"])(
    "cannot traverse the primitive %j",
    (value) => {
      expect(readConditionPath(value, "field")).toBeUndefined();
      expect(readConditionPath(value, [])).toBe(value);
    },
  );
});

describe("compareCondition", () => {
  it.each<[ConditionOperator, unknown, unknown, boolean]>([
    ["equals", { a: 1, b: [2] }, { b: [2], a: 1 }, true],
    ["equals", [1, 2], [2, 1], false],
    ["equals", 1, "1", false],
    ["notEquals", { a: 1 }, { a: 1 }, false],
    ["notEquals", { a: 1 }, { a: 2 }, true],
    ["in", { a: [1] }, [0, { a: [1] }], true],
    ["in", 1, ["1"], false],
    ["in", 1, "1", false],
    ["gte", 3, 3, true],
    ["gte", 2, 3, false],
    ["gt", 4, 3, true],
    ["gt", 3, 3, false],
    ["lte", 3, 3, true],
    ["lte", 4, 3, false],
    ["lt", 2, 3, true],
    ["lt", 3, 3, false],
    ["exists", false, true, true],
    ["exists", 0, true, true],
    ["exists", "", true, true],
    ["exists", undefined, true, false],
    ["exists", null, true, false],
    ["exists", undefined, false, true],
    ["exists", null, false, true],
    ["exists", 0, false, false],
    ["exists", 1, undefined, true],
  ])("%s(%j, %j) is %j", (operator, actual, expected, result) => {
    expect(compareCondition(operator, actual, expected)).toBe(result);
  });

  it.each(NUMERIC_CONDITION_OPERATORS)(
    "%s requires a numeric actual and preserves bound coercion",
    (operator) => {
      for (const value of ["3", null, undefined, false, {}, NaN])
        expect(compareCondition(operator, value, 3)).toBe(false);
      expect(compareCondition(operator, 3, "2")).toBe(
        compareCondition(operator, 3, 2),
      );
    },
  );

  it("rejects an unknown operator at runtime and in TypeScript", () => {
    // @ts-expect-error Unknown operators are not part of the public type.
    expect(compareCondition("unknown", 1, 1)).toBe(false);
  });
});

describe("conditionOperatorOf", () => {
  it.each(CONDITION_OPERATORS)(
    "recognizes %s even with an undefined operand",
    (operator) => {
      expect(
        conditionOperatorOf({ source: "example", [operator]: undefined }),
      ).toBe(operator);
    },
  );

  it.each([{}, { unknown: true }, { equals: 1, gt: 0 }])(
    "rejects a leaf without exactly one operator: %j",
    (leaf) => expect(conditionOperatorOf(leaf)).toBeNull(),
  );

  it("ignores inherited operators", () => {
    const leaf: Record<string, unknown> = Object.create({ equals: 1 });
    expect(conditionOperatorOf(leaf)).toBeNull();
    leaf.exists = false;
    expect(conditionOperatorOf(leaf)).toBe("exists");
  });
});
