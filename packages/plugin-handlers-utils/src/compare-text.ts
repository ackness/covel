/** Move a UTF-16 code unit to where its code point sorts. */
function codePointRank(unit: number): number {
  // Surrogates (astral code points) sort after U+E000..U+FFFF.
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000;
}

/**
 * Compare two strings by Unicode code point, for `Array.prototype.sort`.
 *
 * `a.localeCompare(b)` with no locale uses the language of the machine: the
 * same IDs, keys or names come out in a different order on another server,
 * and so do the prompt lines, stored rows and results built from them. This
 * order is the same everywhere and is the order SQLite and PostgreSQL give
 * `ORDER BY` on a binary-collated text column. Use it for IDs, keys,
 * timestamps and any tie-break. Text a person reads in a sorted list is the
 * one place for a collator, with a locale given.
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    let left = a.charCodeAt(index);
    let right = b.charCodeAt(index);
    if (left === right) continue;
    if (left >= 0xd800 && right >= 0xd800) {
      left = codePointRank(left);
      right = codePointRank(right);
    }
    return left < right ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}
