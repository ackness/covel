import { dimensionsJsonEqual } from "./dimension-schemas.js";

/** Operators a condition leaf can name. Data sources belong to the caller. */
export const CONDITION_OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "gte",
  "gt",
  "lte",
  "lt",
  "exists",
] as const;

/** One supported condition comparison. */
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Operators that compare a numeric actual value against a bound. */
export const NUMERIC_CONDITION_OPERATORS: readonly ConditionOperator[] = [
  "gte",
  "gt",
  "lte",
  "lt",
];

/**
 * Read a dot path or an array of keys/indices. An omitted or empty path returns
 * the value itself; missing segments or traversal through non-objects return
 * undefined. Array segments are converted to numeric indices.
 */
export function readConditionPath(
  value: unknown,
  path?: string | readonly (string | number)[],
): unknown {
  const segments = Array.isArray(path)
    ? path
    : typeof path === "string" && path.length
      ? path.split(".")
      : [];
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * Compare a value using JSON equality or a numeric bound. Callers validate
 * expected operands: numeric comparisons retain JavaScript bound coercion but
 * require a numeric actual value. `exists: false` tests for null or undefined;
 * every other expectation tests for presence. Unknown operators return false.
 */
export function compareCondition(
  operator: ConditionOperator,
  actual: unknown,
  expected: unknown,
): boolean {
  switch (operator) {
    case "exists":
      return (actual !== undefined && actual !== null) === (expected !== false);
    case "equals":
      return dimensionsJsonEqual(actual, expected);
    case "notEquals":
      return !dimensionsJsonEqual(actual, expected);
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((item) => dimensionsJsonEqual(actual, item))
      );
    case "gte":
      return typeof actual === "number" && actual >= (expected as number);
    case "gt":
      return typeof actual === "number" && actual > (expected as number);
    case "lte":
      return typeof actual === "number" && actual <= (expected as number);
    case "lt":
      return typeof actual === "number" && actual < (expected as number);
    default:
      return false;
  }
}

/** The single own operator a leaf names, or null when it names none or several. */
export function conditionOperatorOf(
  leaf: Record<string, unknown>,
): ConditionOperator | null {
  const found = CONDITION_OPERATORS.filter((operator) =>
    Object.hasOwn(leaf, operator),
  );
  return found.length === 1 ? (found[0] ?? null) : null;
}
