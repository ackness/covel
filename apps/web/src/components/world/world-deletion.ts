import type { WorldRecord } from "@/services/api.js";

/** File-backed worlds are repository-managed; player-created worlds are not. */
export function isWorldDeletable(world: WorldRecord): boolean {
  return world.metadata?.source !== "file";
}
