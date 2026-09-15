import type { DataStore } from "@covel/store";
import { reconcileSeededWorlds, seedWorlds } from "./world-seed-loader.js";

/** Seed healthy packages, then reconcile only after a complete inventory. */
export async function seedAndReconcileWorlds(
  store: DataStore,
  worldsDirs: readonly string[],
): Promise<void> {
  const liveWorldIds = new Set<string>();
  const claimedWorldIds = new Set<string>();
  const existingIds = (await store.listWorlds()).map((world) => world.id);
  let complete = true;
  // Resolve overrides before writing so a broken override cannot be replaced
  // by a lower-priority seed during the same startup pass.
  for (const dir of [...worldsDirs].reverse()) {
    try {
      const result = await seedWorlds(store, dir, claimedWorldIds);
      for (const id of result.worldIds) {
        liveWorldIds.add(id);
        claimedWorldIds.add(id);
      }
      if (!result.complete) {
        complete = false;
        // An unreadable manifest may hide any existing identity. Keep the
        // last good records until the higher-priority inventory is complete.
        for (const id of existingIds) claimedWorldIds.add(id);
      }
    } catch (error) {
      complete = false;
      for (const id of existingIds) claimedWorldIds.add(id);
      console.warn(`[world-seed] Could not seed worlds from ${dir}:`, error);
    }
  }
  if (!complete || liveWorldIds.size === 0) {
    console.warn(
      "[world-seed] Incomplete or empty inventory; skipping reconciliation.",
    );
    return;
  }
  try {
    const { removed, keptWithSessions } = await reconcileSeededWorlds(
      store,
      liveWorldIds,
    );
    if (removed.length > 0) {
      console.log(
        `[world-seed] Removed stale DB worlds: ${removed.join(", ")}`,
      );
    }
    if (keptWithSessions.length > 0) {
      console.warn(
        `[world-seed] Kept absent worlds with saved sessions: ${keptWithSessions.join(", ")}`,
      );
    }
  } catch (error) {
    console.warn("[world-seed] World reconciliation failed:", error);
  }
}
