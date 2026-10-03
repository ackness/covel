/**
 * The rules of a dice check, in one place: the roller explains them to the
 * narrative, the guard checks a receipt against them when it is sent, and the
 * recorder writes the result by them.
 */

export const DIFFICULTY_DCS = Object.freeze({
  easy: 8,
  normal: 12,
  hard: 16,
  extreme: 20,
});

export const OUTCOMES = Object.freeze([
  "success",
  "failure",
  "critical-success",
  "critical-failure",
]);

/** A modifier outside this range is not an attribute modifier. */
export const MODIFIER_LIMIT = 10;

/** @param {unknown} value */
export function isModifier(value) {
  return Number.isInteger(value) && Math.abs(value) <= MODIFIER_LIMIT;
}

/** @param {unknown} value */
export function isDifficulty(value) {
  return typeof value === "string" && Object.hasOwn(DIFFICULTY_DCS, value);
}

/**
 * The result of one check: the die decides, the narrative does not.
 *
 * @param {number} roll The d20 of this check.
 * @param {number} modifier
 * @param {keyof typeof DIFFICULTY_DCS} difficulty
 */
export function resolveCheck(roll, modifier, difficulty) {
  const dc = DIFFICULTY_DCS[difficulty];
  const total = roll + modifier;
  const outcome =
    roll === 20
      ? "critical-success"
      : roll === 1
        ? "critical-failure"
        : total >= dc
          ? "success"
          : "failure";
  return { roll, modifier, difficulty, dc, total, outcome };
}

/** "7 + 2 = 9 vs DC 12", the way a receipt shows a check. */
export function rollText({ roll, modifier, total, dc }) {
  return `${roll} ${modifier >= 0 ? "+" : "-"} ${Math.abs(modifier)} = ${total} vs DC ${dc}`;
}
