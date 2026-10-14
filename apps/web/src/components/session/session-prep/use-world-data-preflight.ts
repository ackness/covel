import { useState, useCallback, useEffect, useRef } from "react";
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
  prepareWorldForServer: () => Promise<void>,
): UseWorldDataPreflightResult {
  const [worldDataPreflight, setWorldDataPreflight] =
    useState<api.WorldDataPreflightResponse | null>(null);
  const [worldDataPreflightStatus, setWorldDataPreflightStatus] =
    useState<PrepSectionStatus>("idle");
  const [worldDataPreflightError, setWorldDataPreflightError] = useState<
    string | null
  >(null);

  const sequence = useRef(0);

  const runWorldDataPreflight = useCallback(async () => {
    const run = ++sequence.current;
    setWorldDataPreflight(null);
    setWorldDataPreflightStatus("loading");
    setWorldDataPreflightError(null);
    try {
      await prepareWorldForServer();
      if (run !== sequence.current) return;
      const result = await api.preflightWorldData(worldId, {
        plugins: selectedPluginIds,
      });
      if (run !== sequence.current) return;
      setWorldDataPreflight(result);
      setWorldDataPreflightStatus("success");
    } catch (err) {
      if (run !== sequence.current) return;
      setWorldDataPreflight(null);
      setWorldDataPreflightError(
        err instanceof Error ? err.message : String(err),
      );
      setWorldDataPreflightStatus("error");
    }
  }, [worldId, selectedPluginIds, prepareWorldForServer]);

  useEffect(() => {
    setWorldDataPreflight(null);
    setWorldDataPreflightError(null);
    setWorldDataPreflightStatus("loading");
    const timer = window.setTimeout(() => {
      void runWorldDataPreflight();
    }, 250);
    return () => {
      ++sequence.current;
      window.clearTimeout(timer);
    };
  }, [runWorldDataPreflight]);

  return {
    worldDataPreflight,
    worldDataPreflightStatus,
    worldDataPreflightError,
    runWorldDataPreflight,
  };
}
