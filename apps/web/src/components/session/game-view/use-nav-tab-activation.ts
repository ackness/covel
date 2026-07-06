import { useEffect } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { onNavEvent } from "@/lib/nav-events.js";

export interface NavTabActivationOptions {
  /** Ref to the right panel so it can be expanded before activating a tab. */
  rightPanelRef: React.RefObject<PanelImperativeHandle | null>;
  /** Open the plugin settings surface (topbar "open-plugins" event). */
  onOpenPlugins: () => void;
}

/**
 * Bridges global topbar navigation events to in-page panel actions.
 *
 * The global topbar dispatches via nav-events because it cannot reach this
 * component's local state directly. `open-plugins` opens the plugin settings;
 * `open-images` / `open-database` expand the right panel — the RightPanel
 * subscribes to the same events and switches its controlled tab itself
 * (see right-panel.tsx).
 */
export function useNavTabActivation({
  rightPanelRef,
  onOpenPlugins,
}: NavTabActivationOptions): void {
  useEffect(() => {
    return onNavEvent((event) => {
      if (event === "open-plugins") {
        onOpenPlugins();
        return;
      }
      const panel = rightPanelRef.current;
      if (panel && panel.isCollapsed()) panel.expand();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
