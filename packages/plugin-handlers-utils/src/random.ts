/** Validate the integer range shared by host and test random sources. */
export function validateRandomIntRange(min: number, max: number): void {
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    max <= min ||
    max - min >= 2 ** 48
  )
    throw new RangeError(
      `ctx.random.int needs safe integers with min < max: ${min}, ${max}`,
    );
}
