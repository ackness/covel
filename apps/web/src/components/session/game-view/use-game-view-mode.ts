import { useCallback, useState } from "react";
import { parsePluginViewMode, type PluginViewMode } from "@covel/shared";
import type { WorldRecord } from "@/services/api.js";
import type { GameViewMode } from "./game-view-header.js";
import type { PluginViewEntry, PluginViews } from "./use-plugin-views.js";

type World = Pick<WorldRecord, "metadata"> | null;
export const hostDefault = (world: World) =>
  world?.metadata?.defaultViewMode === "stage" ? "stage" : "parsed";
export function worldViewMode(world: World): GameViewMode {
  const mode = world?.metadata?.defaultViewMode;
  return typeof mode === "string" && parsePluginViewMode(mode)
    ? (mode as PluginViewMode)
    : hostDefault(world);
}

/** Keep the player's intent through loading/errors; only mount a usable view. */
export function useGameViewMode(
  world: World,
  views?: PluginViews,
  canUse?: (entry: PluginViewEntry) => boolean,
  scope = "",
) {
  const [storedMode, setViewMode] = useState<GameViewMode>(() =>
    worldViewMode(world),
  );
  const [awaitingWorld, setAwaitingWorld] = useState(!world);
  const [visit, setVisit] = useState(scope);
  if (visit !== scope) {
    setVisit(scope);
    setAwaitingWorld(!world);
    setViewMode(worldViewMode(world));
  }
  if (awaitingWorld && world) {
    setAwaitingWorld(false);
    setViewMode(worldViewMode(world));
  }
  const choose = useCallback(
    (mode: GameViewMode) => {
      if (
        parsePluginViewMode(mode) &&
        !views?.views.some(
          (entry) => entry.mode === mode && entry.spec.surface !== "composer",
        )
      )
        return;
      setAwaitingWorld(false);
      setViewMode(mode);
    },
    [views],
  );
  const pluginMode = parsePluginViewMode(storedMode);
  const entry = views?.views.find(
    (entry) => entry.mode === storedMode && entry.spec.surface !== "composer",
  );
  const consentView = entry && canUse && !canUse(entry) ? entry : undefined;
  const available = !pluginMode || (entry && !consentView);
  return [
    available ? storedMode : hostDefault(world),
    choose,
    {
      hostDefault: hostDefault(world),
      requestedMode: storedMode,
      fellBack: Boolean(
        pluginMode && views && views.status !== "loading" && !available,
      ),
      consentView,
    },
  ] as const;
}
