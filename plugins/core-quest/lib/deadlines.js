import { dimensionsJsonEqual } from "@covel/plugin-handlers-utils/dimensions";

/**
 * Deadlines of quests and objectives. A deadline is `{ when, label, missed? }`:
 * `when` is one condition that holds once the deadline has passed, `label`
 * is what the player and the narrative read ("Before the water reaches your
 * knees"), and `missed` is what happens when it passes.
 *
 * `when` reads one value of this turn's frozen state:
 *
 * - `{ dimension, path?, <operator> }`: a world dimension, at a path inside it;
 * - `{ time, <operator> }`: a number of the world-time value, such as
 *   `elapsedSinceStart`;
 * - `{ affinity, path?, <operator> }`: how an NPC feels about the player,
 *   `{ score, tier }` from `affinity.tier@1` (`path: tier` or `path: score`);
 * - `{ turnGte: n }`: from session turn `n` on.
 *
 * The operators are those of story-events conditions: `equals`, `notEquals`,
 * `in`, `gte`, `gt`, `lte`, `lt`, `exists`. That plugin cannot be imported
 * here, so this file repeats the leaf part of `story-events/lib/conditions.js`;
 * change both together.
 */

export const OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "gte",
  "gt",
  "lte",
  "lt",
  "exists",
];

function readPath(value, path) {
  const segments =
    typeof path === "string" && path.length ? path.split(".") : [];
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : current[segment];
  }
  return current;
}

function compare(operator, actual, expected) {
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
      return typeof actual === "number" && actual >= expected;
    case "gt":
      return typeof actual === "number" && actual > expected;
    case "lte":
      return typeof actual === "number" && actual <= expected;
    case "lt":
      return typeof actual === "number" && actual < expected;
    default:
      return false;
  }
}

function operatorOf(when) {
  const found = OPERATORS.filter((operator) => Object.hasOwn(when, operator));
  return found.length === 1 ? found[0] : null;
}

/**
 * Whether a deadline has passed: `true`, `false`, or `null` when it cannot be
 * judged (the dimension or world time is not in this session, or `when` is
 * malformed). A deadline that cannot be judged never fails a quest.
 *
 * @param {unknown} when
 * @param {{ dimensions?: Record<string, { value: unknown }>, time?: Record<string, unknown> | null, affinity?: Map<string, { score: number, tier: string }> | null, turn?: number }} state
 */
export function deadlinePassed(when, state) {
  if (!when || typeof when !== "object" || Array.isArray(when)) return null;
  if (Number.isInteger(when.turnGte))
    return Number.isInteger(state.turn) ? state.turn >= when.turnGte : null;
  const operator = operatorOf(when);
  if (!operator) return null;
  if (typeof when.dimension === "string") {
    const entry = state.dimensions?.[when.dimension];
    if (!entry) return null;
    return compare(operator, readPath(entry.value, when.path), when[operator]);
  }
  if (typeof when.time === "string") {
    if (!state.time) return null;
    return compare(operator, state.time[when.time], when[operator]);
  }
  if (typeof when.affinity === "string") {
    const entry = state.affinity?.get(when.affinity.trim().toLowerCase());
    if (!entry) return null;
    return compare(operator, readPath(entry, when.path), when[operator]);
  }
  return null;
}

/** The NPC names that the deadlines of active quests read affinity of. */
export function namedNpcs(quests) {
  const names = new Set();
  for (const quest of quests) {
    if ((quest?.status ?? "active") !== "active") continue;
    for (const deadline of [
      quest.deadline,
      ...(quest.objectives ?? []).map((objective) => objective?.deadline),
    ]) {
      const name = deadline?.when?.affinity;
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    }
  }
  return [...names];
}

/**
 * How much of a time deadline is left, in the clock's base unit, or
 * undefined when the deadline does not count down a number of world time.
 */
export function timeLeft(when, state) {
  if (typeof when?.time !== "string" || !state.time) return undefined;
  const now = state.time[when.time];
  if (typeof now !== "number") return undefined;
  if (typeof when.gte === "number") return when.gte - now;
  if (typeof when.gt === "number") return when.gt - now + 1;
  return undefined;
}
