import { useCallback, useState } from "react";
import type { WorldRecord } from "@/services/api.js";
import type { GameViewMode } from "./game-view-header.js";

const worldViewMode = (world: Pick<WorldRecord, "metadata"> | null) =>
  world?.metadata?.defaultViewMode === "stage" ? "stage" : "parsed";

/**
 * The view a session shows: the world's `defaultViewMode` until the player
 * picks one. The world can arrive after the view mounts, as when a reload
 * restores the session, and its default applies then.
 */
export function useGameViewMode(world: Pick<WorldRecord, "metadata"> | null) {
  const [viewMode, setViewMode] = useState<GameViewMode>(() =>
    worldViewMode(world),
  );
  const [awaitingWorld, setAwaitingWorld] = useState(!world);
  if (awaitingWorld && world) {
    setAwaitingWorld(false);
    setViewMode(worldViewMode(world));
  }
  const chooseViewMode = useCallback((mode: GameViewMode) => {
    setAwaitingWorld(false);
    setViewMode(mode);
  }, []);
  return [viewMode, chooseViewMode] as const;
}
