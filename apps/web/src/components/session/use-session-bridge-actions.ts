import { useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/stores/session-store.js";
import { fetchUiSpecs } from "@/services/api.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { emitNavEvent } from "@/lib/nav-events.js";
import { postPluginRpcWithApproval } from "./plugin-rpc-ui.js";
import { createInteractionHandles } from "./session-bridge-interactions.js";
import { createSessionBridgeActions } from "./session-bridge-actions.js";
import { useSessionBridge } from "./use-session-bridge.js";
import type { PluginViewEntry } from "./game-view/use-plugin-views.js";

/** Mounted only after every grant has persisted; one instance per frame attempt. */
export function useSessionBridgeActions(
  entry: PluginViewEntry,
  sessionId: string,
  consentCurrent: () => boolean,
) {
  const session = useSession();
  const { t } = useTranslation();
  const current = useRef(session);
  current.current = session;
  const permission = useRef(consentCurrent);
  permission.current = consentCurrent;
  const alive = useRef(true);
  const handles = useMemo(() => createInteractionHandles(), []);
  handles.sync(session.state.messages, session.state.submittedBlockIds);
  const guard = useMemo(
    () => () =>
      alive.current &&
      permission.current() &&
      current.current.state.session?.id === sessionId &&
      current.current.state.sessionPlugins.some(
        (plugin) =>
          plugin.id === entry.pluginId &&
          plugin.active &&
          !plugin.approvalRequired &&
          !plugin.paused,
      ),
    [sessionId, entry.pluginId],
  );
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const bridge = useSessionBridge(sessionId, handles.issue);
  const handlers = useMemo(
    () =>
      createSessionBridgeActions({
        pluginId: entry.pluginId,
        capabilities: entry.spec.capabilities ?? [],
        isCurrent: guard,
        read: () => current.current.state,
        handles,
        actions: {
          submitComposerAction: (...args) =>
            current.current.submitComposerAction(...args),
          submitInteraction: (...args) =>
            current.current.submitInteraction(...args),
          abortActiveTurn: () => current.current.abortActiveTurn(),
        },
        ownPanels: async () => {
          const result = await fetchUiSpecs(sessionId);
          return guard()
            ? result.right
                .filter((item) => item.pluginId === entry.pluginId)
                .flatMap((item) =>
                  item.specs.flatMap((spec) => (spec.id ? [spec.id] : [])),
                )
            : [];
        },
        openPanel: (panelId) =>
          emitNavEvent({
            type: "open-plugin-panel",
            pluginId: entry.pluginId,
            panelId,
          }),
        invokeRuntime: (runtimeId, payload, isCurrent) =>
          postPluginRpcWithApproval({
            sessionId,
            pluginId: entry.pluginId,
            request: {
              kind: "runtime",
              pluginId: entry.pluginId,
              runtimeId,
              ...(payload !== undefined ? { payload } : {}),
            },
            actionLabel: runtimeId,
            confirm: requestConfirm,
            t,
            isCurrent,
          }),
      }),
    [entry.pluginId, entry.spec.capabilities, guard, handles, sessionId, t],
  );
  return {
    ...bridge,
    handlers,
    isCurrent: guard,
    retire: () => {
      alive.current = false;
      handles.close();
    },
  };
}
