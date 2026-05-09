// -- World Overlay (IndexedDB via app-kv-store) -------------

import {
  getWorldOverlay as idbGetWorldOverlay,
  setWorldOverlay as idbSetWorldOverlay,
  removeWorldOverlay as idbRemoveWorldOverlay,
  type WorldOverlay,
} from "../app-kv-store.js";

export type { WorldOverlay };

export async function getWorldOverlay(
  worldId: string,
): Promise<WorldOverlay | null> {
  return idbGetWorldOverlay(worldId);
}

export async function setWorldOverlay(
  worldId: string,
  overlay: WorldOverlay,
): Promise<void> {
  return idbSetWorldOverlay(worldId, overlay);
}

export async function removeWorldOverlay(worldId: string): Promise<void> {
  return idbRemoveWorldOverlay(worldId);
}
