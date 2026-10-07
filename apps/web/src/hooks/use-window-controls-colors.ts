import { useEffect, type RefObject } from "react";
import { getCovelIpc } from "@/lib/desktop-bridge";
import { flattenToHex } from "@/theme-system/color.js";
import { useThemeSnapshot } from "@/theme-system/use-theme-snapshot.js";

/**
 * On Windows the desktop shell paints the window buttons over the top-right
 * corner of the page and has to be told the colours there. The buttons are on
 * the top bar while it shows and on the page otherwise.
 */
export function useWindowControlsColors(
  topBar: RefObject<HTMLElement | null>,
  /** Whether the layout replaces the top bar with the rail. */
  railNav: boolean,
): void {
  const theme = useThemeSnapshot();

  useEffect(() => {
    const ipc = getCovelIpc();
    if (ipc?.platform !== "win32") return;
    let stale = false;

    void (async () => {
      const bar = topBar.current;
      const surface =
        bar && bar.getClientRects().length > 0 ? bar : document.body;
      // A theme switch fades the colours in; read them once they have arrived.
      await Promise.allSettled(
        surface
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished),
      );
      if (stale) return;

      const style = getComputedStyle(surface);
      const background = flattenToHex(
        getComputedStyle(document.body).backgroundColor,
        style.backgroundColor,
      );
      const foreground = background && flattenToHex(background, style.color);
      if (!background || !foreground) return;
      try {
        await ipc.invoke("covel:title-bar:set-colors", {
          background,
          foreground,
        });
      } catch (error) {
        console.warn("[desktop] window button colours not applied", error);
      }
    })();

    return () => {
      stale = true;
    };
  }, [topBar, railNav, theme]);
}
