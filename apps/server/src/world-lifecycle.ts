import { z } from "zod";
import type { WorldRecord } from "@covel/store";

/** Host-owned metadata; world documents and browser checkpoints cannot set it. */
export const WORLD_DELETION_KEY = "worldDeletion";
export const WORLD_DELETION_LEASE_MS = 10 * 60 * 1000;

const deletionSchema = z.object({
  nonce: z.string().min(1),
  startedAt: z.iso.datetime(),
  retryable: z.boolean().optional(),
});
export type WorldDeletion = z.infer<typeof deletionSchema>;

export function worldOperationLockId(worldId: string): string {
  return `world:${worldId}`;
}

export function isWorldDeleting(world: WorldRecord): boolean {
  return world.metadata?.[WORLD_DELETION_KEY] !== undefined;
}

export function readWorldDeletion(
  world: WorldRecord,
): WorldDeletion | undefined {
  const parsed = deletionSchema.safeParse(world.metadata?.[WORLD_DELETION_KEY]);
  return parsed.success ? parsed.data : undefined;
}

export function withoutWorldDeletion(
  metadata: WorldRecord["metadata"],
): Record<string, unknown> {
  const { [WORLD_DELETION_KEY]: _deletion, ...rest } = metadata ?? {};
  return rest;
}
