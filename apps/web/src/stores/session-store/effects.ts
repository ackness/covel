import { useEffect } from "react";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { refreshSessionResource } from "./session-resource-reads.js";
import { loadPluginDataForSession } from "@/stores/plugin-data-store.js";
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
    ds.saveExecutionSteps(sid, state.executionSteps, state.session!).catch(
      ignoreError("save execution steps"),
    );
  }, [state.executionSteps, state.session?.id, state.session?.incarnation, ds]);
}

export function useMessageUiSpecHydrationEffect(
  sessionId: string | null | undefined,
  dispatch: SessionDispatch,
  sessionGenerationRef: { current: number },
): void {
  const generation = sessionGenerationRef.current;
  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
      return;
    }
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && sessionGenerationRef.current === generation;
    void refreshSessionResource(dispatch, ["ui-specs", sessionId, "message"], {
      isCurrent,
      read: () => api.fetchUiSpecs(sessionId),
      apply: (res) => {
        const specs = res.message ?? [];
        dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs });
        const pluginIds = new Set(specs.map((entry) => entry.pluginId));
        for (const pluginId of pluginIds) {
          void refreshSessionResource(
            dispatch,
            ["plugin-data", sessionId, pluginId, "message"],
            {
              isCurrent,
              read: () => api.listPluginData(sessionId, pluginId, "message"),
              apply: (items) => {
                loadPluginDataForSession(
                  sessionId,
                  pluginId,
                  "message",
                  items.map((item) => ({ key: item.key, value: item.value })),
                );
                if (items.length === 0) return;
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
              },
            },
          ).catch(ignoreError("load plugin data for message ui spec"));
        }
      },
    }).catch(() => {
      if (isCurrent()) dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, dispatch, generation, sessionGenerationRef]);
}
