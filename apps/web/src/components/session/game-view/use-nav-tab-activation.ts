import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  onNavEvent,
  type NavEvent,
  type RightPanelRequest,
  type SessionPanel,
} from "@/lib/nav-events.js";

export interface NavTabActivationOptions {
  /** Ref to the right panel so it can be expanded before activating a tab. */
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  /** Open the plugin settings surface (topbar "open-plugins" event). */
  onOpenPlugins: () => void;
  /** Open the mobile context drawer when no resizable rail is mounted. */
  onOpenContext?: () => void;
  requestedPanel?: SessionPanel;
  onPanelHandled?: () => void;
}

/**
 * Consume route panel intents after GameView mounts and receive in-session
 * commands. Keep right-panel requests above the drawer's mounting boundary.
 */
export function useNavTabActivation({
  rightPanelRef,
  onOpenPlugins,
  onOpenContext,
  requestedPanel,
  onPanelHandled,
}: NavTabActivationOptions): RightPanelRequest | null {
  const [panelRequest, setPanelRequest] = useState<RightPanelRequest | null>(
    null,
  );
  const handledPanel = useRef<SessionPanel | undefined>(undefined);
  const activate = useCallback(
    (event: NavEvent) => {
      if (event === "open-plugins") {
        onOpenPlugins();
        return;
      }
      // Keep the request above the drawer so lazy panel mounting cannot lose it.
      setPanelRequest({ event });
      if (onOpenContext) {
        onOpenContext();
        return;
      }
      const panel = rightPanelRef.current;
      if (panel && panel.isCollapsed()) panel.expand();
    },
    [onOpenContext, onOpenPlugins, rightPanelRef],
  );
  useEffect(() => onNavEvent(activate), [activate]);
  useEffect(() => {
    if (!requestedPanel) {
      handledPanel.current = undefined;
      return;
    }
    if (handledPanel.current === requestedPanel) return;
    handledPanel.current = requestedPanel;
    activate(requestedPanel === "plugins" ? "open-plugins" : "open-images");
    onPanelHandled?.();
  }, [requestedPanel, activate, onPanelHandled]);
  return panelRequest;
}
