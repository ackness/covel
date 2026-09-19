import type { Context } from "hono";
import type { WorldRecord } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import {
  isWorldDeleting,
  worldOperationLockId,
} from "../../../world-lifecycle.js";

/**
 * World admission is short-lived. A session owner may acquire this lock, but a
 * world owner must release it before acquiring session locks or invoking hooks.
 */
export async function withWritableWorld<T>(
  c: Context,
  worldId: string,
  mutate: (world: WorldRecord) => Promise<T>,
): Promise<T | Response> {
  return c
    .get("sessionLock")
    .withLock(worldOperationLockId(worldId), async () => {
      const world = await c.get("store").getWorld(worldId);
      if (!world) {
        return c.json(
          errorBody("World not found", { code: "world_not_found" }),
          404,
        );
      }
      if (isWorldDeleting(world)) {
        return c.json(
          errorBody("World deletion is in progress; retry deletion", {
            code: "world_deleting",
          }),
          409,
        );
      }
      return mutate(world);
    });
}
