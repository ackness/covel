import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/services/api";
import type { DataService } from "@/services/data-service.js";
import { ignoreError } from "@/lib/ignore-error.js";
import { refreshSessionResource } from "./session-resource-reads.js";
import {
  loadPluginDataForSession,
  replacePluginDataForSession,
} from "@/stores/plugin-data-store.js";
import type { SessionDispatch, SessionState } from "./types.js";
import { pluginDataNamespaces } from "./plugin-data-records.js";

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
  const pending = useRef<(() => void) | null>(null);
  const sessionId = state.session?.id;
  const incarnation = state.session?.incarnation;
  useEffect(
    () => () => {
      pending.current?.();
      pending.current = null;
    },
    [ds, sessionId, incarnation],
  );
  useEffect(() => {
    const session = state.session;
    if (!session || state.executionSteps.length === 0) return;
    // This is a display cache; durable recovery comes from the server journal.
    const steps = state.executionSteps.slice(-500);
    const save = () => {
      pending.current = null;
      void ds
        .saveExecutionSteps(session.id, steps, session)
        .catch(ignoreError("save execution steps"));
    };
    pending.current = save;
    const timer = setTimeout(save, 250);
    return () => clearTimeout(timer);
  }, [state.executionSteps, sessionId, incarnation, ds]);
}

export function useUiSpecHydrationEffect(
  sessionId: string | null | undefined,
  dispatch: SessionDispatch,
  sessionGenerationRef: { current: number },
  plugins: readonly api.SessionPlugin[],
): void {
  const { i18n } = useTranslation();
  const activePluginKey = plugins
    .filter((plugin) => plugin.active)
    .map((plugin) => plugin.id)
    .sort()
    .join("\u001f");
  const generation = sessionGenerationRef.current;
  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs: [] });
      return;
    }
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && sessionGenerationRef.current === generation;
    void refreshSessionResource(dispatch, ["ui-specs", sessionId, "provider"], {
      isCurrent,
      read: () => api.fetchUiSpecs(sessionId),
      apply: (res) => {
        const specs = res.message ?? [];
        dispatch({ type: "LOAD_MESSAGE_UI_SPECS", specs });
        const rightPluginIds = new Set(
          res.right.map((entry) => entry.pluginId),
        );
        for (const pluginId of rightPluginIds) {
          void refreshSessionResource(
            dispatch,
            ["plugin-data", sessionId, pluginId],
            {
              isCurrent,
              read: () => api.listPluginData(sessionId, pluginId),
              apply: (items) => {
                const namespaces = pluginDataNamespaces(items);
                if (
                  replacePluginDataForSession(sessionId, pluginId, namespaces)
                ) {
                  dispatch({
                    type: "REPLACE_PLUGIN_DATA_FOR_PLUGIN",
                    pluginId,
                    namespaces,
                  });
                }
              },
            },
          ).catch(ignoreError("load plugin data for right panel"));
        }
        const messagePluginIds = new Set(specs.map((entry) => entry.pluginId));
        for (const pluginId of messagePluginIds) {
          if (rightPluginIds.has(pluginId)) continue;
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
                dispatch({
                  type: "REPLACE_PLUGIN_DATA_NAMESPACE",
                  pluginId,
                  namespace: "message",
                  data: Object.fromEntries(
                    items.map((item) => [item.key, item.value]),
                  ),
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
  }, [
    sessionId,
    dispatch,
    generation,
    sessionGenerationRef,
    activePluginKey,
    i18n.language,
  ]);
}
