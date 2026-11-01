import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sticky-bottom auto-scroll for message lists.
 *
 * Tracks whether the user is "pinned" to the bottom of a scroll container
 * (within `thresholdPx` tolerance). Auto-follows new content only while
 * pinned. Once the user scrolls up, following stops and `showJumpButton`
 * flips true so the UI can offer a "jump to latest" affordance.
 *
 * All scrolling is container-scoped (`viewport.scrollTo`), never
 * `scrollIntoView` — the latter also scrolls the document and can shove the
 * full-height app shell off-screen.
 *
 * New messages use `behavior: "auto"`; the explicit jump action uses `"smooth"`.
 */

const DEFAULT_THRESHOLD_PX = 80;

/** Follow readable content while later semantic units still reserve layout. */
function followTop(viewport: HTMLElement): number {
  const group = Array.from(
    viewport.querySelectorAll('[data-reveal-active="true"]'),
  ).at(-1);
  const hidden = group?.querySelector('[data-reveal-hidden="true"]');
  const anchor = hidden?.previousElementSibling;
  if (!anchor)
    return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const rect = anchor.getBoundingClientRect();
  const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
  // A tall unit starts at its first readable line; a short one follows its end.
  return Math.max(
    0,
    viewport.scrollTop +
      Math.min(rect.top, rect.bottom - viewport.clientHeight) -
      viewportTop,
  );
}

export interface AutoScrollResult {
  /** Attach to the scrollable viewport element. */
  scrollRef: (node: HTMLElement | null) => void;
  /** True when the user has scrolled away from the bottom. */
  showJumpButton: boolean;
  /** Smoothly scroll to the bottom and re-enable following. */
  jumpToBottom: () => void;
}

export function useAutoScroll(
  /** Value(s) that change when content arrives (e.g. messages). */
  dep: unknown,
  options?: {
    thresholdPx?: number;
  },
): AutoScrollResult {
  const thresholdPx = options?.thresholdPx ?? DEFAULT_THRESHOLD_PX;
  const viewportRef = useRef<HTMLElement | null>(null);
  // Default to pinned: a fresh session should follow new messages.
  const isPinnedRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  // Scroll ONLY the tracked viewport. `scrollIntoView` on a bottom sentinel
  // scrolls every scrollable ancestor — including the document — so any
  // transient page overflow (layout settling, a pending interaction form)
  // shoved the whole 100vh app shell off-screen and nothing ever scrolled it
  // back. Container-scoped scrolling cannot touch ancestors by construction.
  const scrollViewportToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ top: followTop(el), behavior });
  }, []);

  const computeIsAtBottom = useCallback(
    (el: HTMLElement): boolean => {
      const distance = followTop(el) - el.scrollTop;
      return distance <= thresholdPx;
    },
    [thresholdPx],
  );

  const scrollHandlerRef = useRef<(() => void) | null>(null);
  const revealObserverRef = useRef<MutationObserver | null>(null);
  const scrollRef = useCallback(
    (node: HTMLElement | null) => {
      const prev = viewportRef.current;
      // `addEventListener` handlers are not removed by clearing `.onscroll`, so
      // keep the handler ref and detach it explicitly on node swap.
      if (prev && scrollHandlerRef.current) {
        prev.removeEventListener("scroll", scrollHandlerRef.current);
      }
      revealObserverRef.current?.disconnect();
      revealObserverRef.current = null;
      viewportRef.current = node;
      scrollHandlerRef.current = null;
      if (!node) return;
      const handler = () => {
        const atBottom = computeIsAtBottom(node);
        isPinnedRef.current = atBottom;
        setShowJumpButton((cur) => (cur === !atBottom ? cur : !atBottom));
      };
      scrollHandlerRef.current = handler;
      node.addEventListener("scroll", handler);
      const observer = new MutationObserver(() => {
        if (isPinnedRef.current) scrollViewportToBottom("auto");
      });
      observer.observe(node, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-reveal-active", "data-reveal-hidden"],
      });
      revealObserverRef.current = observer;
    },
    [computeIsAtBottom, scrollViewportToBottom],
  );

  const jumpToBottom = useCallback(() => {
    isPinnedRef.current = true;
    setShowJumpButton(false);
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollViewportToBottom(prefersReducedMotion ? "auto" : "smooth");
  }, [scrollViewportToBottom]);

  // Follow new content only while pinned.
  useEffect(() => {
    if (!isPinnedRef.current) return;
    scrollViewportToBottom("auto");
  }, [dep, scrollViewportToBottom]);

  return { scrollRef, showJumpButton, jumpToBottom };
}
