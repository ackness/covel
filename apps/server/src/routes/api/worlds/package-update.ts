import type { WorldRecord } from "@covel/store";
import { worldPackageDigest } from "../../../world-data/package-digest.js";
import { resolveWorldRoot } from "../../../world-data/session-import/utils.js";
import { isPackageWorld } from "./shared.js";

/** Response-only status: listing a world never applies or acknowledges an update. */
export async function withWorldPackageUpdate(
  world: WorldRecord,
  worldsDirs: readonly string[],
): Promise<WorldRecord & { updateAvailable?: boolean }> {
  const imported = world.metadata?.packageDigest;
  if (!isPackageWorld(world) || typeof imported !== "string") return world;
  try {
    const root = await resolveWorldRoot(world.id, worldsDirs);
    if (!root) return world;
    const current = await worldPackageDigest(root);
    return current === undefined
      ? world
      : { ...world, updateAvailable: current !== imported };
  } catch (error) {
    console.warn(
      `[world-package] Cannot check updates for ${world.id}:`,
      error,
    );
    return world;
  }
}
