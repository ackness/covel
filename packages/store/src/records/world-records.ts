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
  // Metadata is the persisted canonical field. A projected top-level value
  // must not undo a later metadata replacement or explicit removal.
  const dimensions = Object.hasOwn(world.metadata ?? {}, "dimensions")
    ? (world.metadata?.dimensions as WorldRecord["dimensions"])
    : world.dimensions;
  return {
    ...world,
    dimensions,
    ...(dimensions === undefined
      ? {}
      : { metadata: { ...world.metadata, dimensions } }),
  };
}
