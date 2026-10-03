/**
 * Host version ranges for `covel:` in PLUGIN.md and covel-collection.yaml.
 *
 * Deliberately small: space-separated comparators (`>=0.0.45 <0.1.0`), each an
 * operator `>=`, `>`, `<=`, `<` or `=` (the default) followed by `X.Y.Z`. All
 * comparators must hold. Plugin-to-plugin compatibility is expressed by
 * contract IDs, so there is no caret/tilde/OR syntax and no dependency solving.
 */
import { z } from "zod";

const COMPARATOR = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/;

type Version = readonly [number, number, number];

function parseVersion(value: string): Version | null {
  // A pre-release or build suffix does not change which range a host is in.
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** True when `range` uses only the supported comparator syntax. */
export function isHostVersionRange(range: string): boolean {
  const parts = range.trim().split(/\s+/);
  return parts.length > 0 && parts.every((part) => COMPARATOR.test(part));
}

export const hostVersionRangeSchema = z
  .string()
  .max(200)
  .refine(isHostVersionRange, {
    message:
      'must be space-separated comparators such as ">=0.0.45" or ">=0.0.45 <0.1.0"',
  });

/**
 * Whether a host version satisfies a range. Returns `null` when either side
 * cannot be parsed, so a caller can tell "does not fit" from "cannot tell".
 */
export function satisfiesHostVersionRange(
  hostVersion: string,
  range: string,
): boolean | null {
  const host = parseVersion(hostVersion);
  if (!host || !isHostVersionRange(range)) return null;
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const [, operator = "=", major, minor, patch] = COMPARATOR.exec(part)!;
      const order = compare(host, [
        Number(major),
        Number(minor),
        Number(patch),
      ]);
      switch (operator) {
        case ">=":
          return order >= 0;
        case ">":
          return order > 0;
        case "<=":
          return order <= 0;
        case "<":
          return order < 0;
        default:
          return order === 0;
      }
    });
}
