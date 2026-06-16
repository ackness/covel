import { useState, useCallback, useEffect } from "react";
import * as api from "@/services/api.js";
import type { PrepSectionStatus } from "./types.js";

export interface UseWorldDataPreflightResult {
  worldDataPreflight: api.WorldDataPreflightResponse | null;
  worldDataPreflightStatus: PrepSectionStatus;
  worldDataPreflightError: string | null;
  runWorldDataPreflight: () => Promise<void>;
}

export function useWorldDataPreflight(
  worldId: string,
  selectedPluginIds: string[],
): UseWorldDataPreflightResult {
  const [worldDataPreflight, setWorldDataPreflight] =
    useState<api.WorldDataPreflightResponse | null>(null);
  const [worldDataPreflightStatus, setWorldDataPreflightStatus] =
    useState<PrepSectionStatus>("idle");
  const [worldDataPreflightError, setWorldDataPreflightError] = useState<
    string | null
  >(null);

  const runWorldDataPreflight = useCallback(async () => {
    setWorldDataPreflightStatus("loading");
    setWorldDataPreflightError(null);
    try {
      const result = await api.preflightWorldData(worldId, {
        plugins: selectedPluginIds,
      });
      setWorldDataPreflight(result);
      setWorldDataPreflightStatus("success");
    } catch (err) {
      setWorldDataPreflight(null);
      setWorldDataPreflightError(
        err instanceof Error ? err.message : String(err),
      );
      setWorldDataPreflightStatus("error");
    }
  }, [worldId, selectedPluginIds]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runWorldDataPreflight();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [runWorldDataPreflight]);

  return {
    worldDataPreflight,
    worldDataPreflightStatus,
    worldDataPreflightError,
    runWorldDataPreflight,
  };
}
