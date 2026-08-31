const DEFAULT_NOTATION = "1d20";
const MAX_DICE_COUNT = 100;
const MAX_DIE_SIDES = 1000;

/**
 * Parse bounded NdM dice notation without performing any random work.
 *
 * @param {unknown} input
 * @returns {{ ok: true, notation: string, count: number, sides: number } | { ok: false, code: string }}
 */
export function parseDiceNotation(input) {
  const notation =
    input === undefined || input === null || input === ""
      ? DEFAULT_NOTATION
      : typeof input === "string"
        ? input.trim()
        : "";
  const match = /^(\d+)d(\d+)$/i.exec(notation);
  if (!match) return { ok: false, code: "invalid-notation" };

  const count = Number(match[1]);
  const sides = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DICE_COUNT) {
    return { ok: false, code: "invalid-count" };
  }
  if (!Number.isSafeInteger(sides) || sides < 2 || sides > MAX_DIE_SIDES) {
    return { ok: false, code: "invalid-sides" };
  }

  return {
    ok: true,
    notation: `${count}d${sides}`,
    count,
    sides,
  };
}

/**
 * Roll a parsed dice specification using an injected half-open integer RNG.
 *
 * @param {{ notation: string, count: number, sides: number }} spec
 * @param {(min: number, max: number) => number} randomInteger
 */
export function rollDice(spec, randomInteger) {
  const rolls = Array.from({ length: spec.count }, () =>
    randomInteger(1, spec.sides + 1),
  );
  return {
    notation: spec.notation,
    rolls,
    total: rolls.reduce((sum, value) => sum + value, 0),
  };
}
