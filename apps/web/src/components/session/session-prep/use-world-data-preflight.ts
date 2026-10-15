import { useState, useCallback, useEffect, useRef } from "react";
import { z } from "zod";
import * as api from "@/services/api.js";
import { ApiError } from "@/services/api/request.js";
import type { PrepSectionStatus } from "./types.js";

export interface UseWorldDataPreflightResult {
  worldDataPreflight: api.WorldDataPreflightResponse | null;
  worldDataPreflightStatus: PrepSectionStatus;
  worldDataPreflightError: string | null;
  /**
   * The plugins that each keep world dimensions when the selection has more
   * than one (`409 dimension_provider_conflict`); the player keeps one.
   */
  dimensionProviderConflict: readonly string[] | null;
  runWorldDataPreflight: () => Promise<void>;
}

const conflictDetailsSchema = z.object({
  candidates: z.array(z.string()).min(2),
});

/** The candidates of a `dimension_provider_conflict` answer, else null. */
export function dimensionProviderCandidates(
  error: unknown,
): readonly string[] | null {
  if (
    !(error instanceof ApiError) ||
    error.code !== "dimension_provider_conflict"
  )
    return null;
  const details = conflictDetailsSchema.safeParse(error.details);
  return details.success ? details.data.candidates : null;
}

export function useWorldDataPreflight(
  worldId: string,
  enabledPluginIds: string[],
  prepareWorldForServer: () => Promise<void>,
): UseWorldDataPreflightResult {
  const [worldDataPreflight, setWorldDataPreflight] =
    useState<api.WorldDataPreflightResponse | null>(null);
  const [worldDataPreflightStatus, setWorldDataPreflightStatus] =
    useState<PrepSectionStatus>("idle");
  const [worldDataPreflightError, setWorldDataPreflightError] = useState<
    string | null
  >(null);
  const [dimensionProviderConflict, setDimensionProviderConflict] = useState<
    readonly string[] | null
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
        plugins: enabledPluginIds,
      });
      if (run !== sequence.current) return;
      setWorldDataPreflight(result);
      setDimensionProviderConflict(null);
      setWorldDataPreflightStatus("success");
    } catch (err) {
      if (run !== sequence.current) return;
      setWorldDataPreflight(null);
      setDimensionProviderConflict(dimensionProviderCandidates(err));
      setWorldDataPreflightError(
        err instanceof Error ? err.message : String(err),
      );
      setWorldDataPreflightStatus("error");
    }
  }, [worldId, enabledPluginIds, prepareWorldForServer]);

  useEffect(() => {
    setWorldDataPreflight(null);
    setWorldDataPreflightError(null);
    setDimensionProviderConflict(null);
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
    dimensionProviderConflict,
    runWorldDataPreflight,
  };
}
