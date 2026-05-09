import { useEffect } from "react";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import type { SessionDispatch, SessionState } from "./types.js";

export function useBootEffect(
  state: Pick<SessionState, "booted" | "bootError">,
  boot: () => Promise<void>,
): void {
  useEffect(() => {
    if (!state.booted && !state.bootError) {
      boot();
    }
  }, [boot, state.booted, state.bootError]);
}

export function usePersistExecutionStepsEffect(
  state: Pick<SessionState, "executionSteps" | "session">,
  ds: DataService,
): void {
  useEffect(() => {
    const sid = state.session?.id;
    if (!sid || state.executionSteps.length === 0) return;
    ds.saveExecutionSteps(sid, state.executionSteps).catch(() => {});
  }, [state.executionSteps, state.session?.id, ds]);
}

export function useMessageUiSpecHydrationEffect(
  sessionId: string | null | undefined,
  dispatch: SessionDispatch,
): void {
  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
      return;
    }
    let cancelled = false;
    api
      .fetchUiSpecs(sessionId)
      .then((res) => {
        if (cancelled) return;
        const specs = res.message ?? [];
        dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs });

        const pluginIds = new Set(specs.map((entry) => entry.pluginId));
        for (const pluginId of pluginIds) {
          api
            .listPluginData(sessionId, pluginId, "message")
            .then((items) => {
              if (cancelled || items.length === 0) return;
              dispatch({
                type: "PLUGIN_DATA_CHANGED",
                pluginId,
                changes: items.map((item) => ({
                  namespace: item.namespace,
                  key: item.key,
                  value: item.value,
                  operation: "set",
                })),
              });
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, dispatch]);
}
