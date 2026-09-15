import type { DataStore } from "@covel/store";
import { reconcileSeededWorlds, seedWorlds } from "./world-seed-loader.js";

/** Seed healthy packages, then reconcile only after a complete inventory. */
export async function seedAndReconcileWorlds(
  store: DataStore,
  worldsDirs: readonly string[],
): Promise<void> {
  const liveWorldIds = new Set<string>();
  let complete = true;
  for (const dir of worldsDirs) {
    try {
      const result = await seedWorlds(store, dir);
      for (const id of result.worldIds) liveWorldIds.add(id);
      if (!result.complete) complete = false;
    } catch (error) {
      complete = false;
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
