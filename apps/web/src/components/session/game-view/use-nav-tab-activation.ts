import { useEffect } from "react";
import type { TFunction } from "i18next";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { onNavEvent } from "@/lib/nav-events.js";

export interface NavTabActivationOptions {
  /** Locale resolver — used to match the activity tab's locale-resolved label. */
  t: TFunction;
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
 * `open-images` / `open-database` expand the right panel and activate the
 * matching Radix Tabs trigger. Behaviour is identical to the inline effect
 * previously embedded in GameView.
 */
export function useNavTabActivation({
  t,
  rightPanelRef,
  onOpenPlugins,
}: NavTabActivationOptions): void {
  useEffect(() => {
    return onNavEvent((event) => {
      if (event === "open-plugins") {
        onOpenPlugins();
        return;
      }
      if (event === "open-images" || event === "open-database") {
        // Make sure the right panel is expanded, then activate the requested
        // activity tab. Radix Tabs use pointerdown to trigger selection
        // (not click), so a plain programmatic .click() is a no-op — we
        // dispatch the matching pointerdown sequence instead.
        const panel = rightPanelRef.current;
        if (panel && panel.isCollapsed()) panel.expand();
        // The aria-label is locale-resolved (framework: t(); plugin: i18n
        // map). Both sides agree on the same translation table, so we resolve
        // the same key here to match whichever locale is active.
        const targetLabel =
          event === "open-images" ? t("nav.images") : t("session.database");
        const activate = () => {
          const tab = document.querySelector<HTMLElement>(
            `button[role="tab"][aria-label="${targetLabel}"]`,
          );
          if (!tab) return;
          // Radix Tabs trigger on the mousedown → mouseup → click sequence;
          // a plain `tab.click()` alone is a no-op because the trigger only
          // commits when it sees the pointerdown half. Replay the full
          // sequence so it matches a real interaction.
          const opts = { bubbles: true, cancelable: true, button: 0 } as const;
          tab.dispatchEvent(new MouseEvent("mousedown", opts));
          tab.dispatchEvent(new MouseEvent("mouseup", opts));
          tab.click();
        };
        // Defer two frames to give the panel time to finish expanding before
        // dispatching pointer events at the now-visible tab.
        requestAnimationFrame(() => requestAnimationFrame(activate));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
}
