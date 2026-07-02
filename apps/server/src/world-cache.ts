/**
 * Tiny per-world cache for the turn hot path.
 *
 * `WorldRecord.metadata` is read every turn (plugin pluginSettings) and every
 * memory op (world memoryBlocks), but a world is effectively immutable within a
 * session's lifetime. Caching the record keyed by `worldId` keeps the cache
 * naturally bounded by the (small, finite) number of worlds — not by the
 * unbounded number of sessions — and a short TTL lets a re-imported / re-seeded
 * world refresh on its own without wiring invalidation into every `upsertWorld`
 * call site.
 */
import type { DataStore, WorldRecord } from "@covel/store";

const TTL_MS = 30_000;

interface Entry {
  readonly world: WorldRecord | null;
  readonly at: number;
}

const cache = new Map<string, Entry>();

/**
 * Read a world by id, served from a short-TTL per-`worldId` cache. Falls
 * through to `store.getWorld` on a miss / expiry. Bounded by the number of
 * distinct worlds, so it never accumulates per session.
 */
export async function getCachedWorld(
  store: Pick<DataStore, "getWorld">,
  worldId: string,
): Promise<WorldRecord | null> {
  const now = Date.now();
  const hit = cache.get(worldId);
  if (hit && now - hit.at < TTL_MS) return hit.world;
  const world = await store.getWorld(worldId);
  cache.set(worldId, { world, at: now });
  return world;
}
