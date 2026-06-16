/**
 * World record type and normalisers.
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

import type { WorldDimensions } from "@covel/shared";

export interface WorldRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly lore?: string;
  readonly tags?: readonly string[];
  readonly locale?: string;
  readonly dimensions?: WorldDimensions;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export function normalizeWorldRecord(world: WorldRecord): WorldRecord {
  return {
    ...world,
    dimensions:
      world.dimensions ??
      (world.metadata?.dimensions as WorldRecord["dimensions"]),
  };
}
