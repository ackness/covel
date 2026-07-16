import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sticky-bottom auto-scroll for streaming message lists.
 *
 * Tracks whether the user is "pinned" to the bottom of a scroll container
 * (within `thresholdPx` tolerance). Auto-follows new content only while
 * pinned. Once the user scrolls up, following stops and `showJumpButton`
 * flips true so the UI can offer a "jump to latest" affordance.
 *
 * High-frequency delta updates use `behavior: "auto"` to avoid the jittery
 * smooth-scroll animation; the explicit jump action uses `"smooth"`.
 */

const DEFAULT_THRESHOLD_PX = 80;

export interface AutoScrollResult {
  /** Attach to the scrollable viewport element. */
  scrollRef: (node: HTMLElement | null) => void;
  /** Sentinel placed at the very bottom of the content. */
  bottomRef: React.RefObject<HTMLDivElement | null>;
  /** True when the user has scrolled away from the bottom. */
  showJumpButton: boolean;
  /** Smoothly scroll to the bottom and re-enable following. */
  jumpToBottom: () => void;
}

export function useAutoScroll(
  /** Value(s) that change as new content streams in (e.g. messages). */
  dep: unknown,
  options?: {
    thresholdPx?: number;
    subscribeToStreaming?: (listener: () => void) => () => void;
  },
): AutoScrollResult {
  const thresholdPx = options?.thresholdPx ?? DEFAULT_THRESHOLD_PX;
  const viewportRef = useRef<HTMLElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Default to pinned: a fresh session should follow the stream.
  const isPinnedRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  const computeIsAtBottom = useCallback(
    (el: HTMLElement): boolean => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      return distance <= thresholdPx;
    },
    [thresholdPx],
  );

  const scrollHandlerRef = useRef<(() => void) | null>(null);
  const scrollRef = useCallback(
    (node: HTMLElement | null) => {
      const prev = viewportRef.current;
      // `addEventListener` handlers are not removed by clearing `.onscroll`, so
      // keep the handler ref and detach it explicitly on node swap (L-12).
      if (prev && scrollHandlerRef.current) {
        prev.removeEventListener("scroll", scrollHandlerRef.current);
      }
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
    },
    [computeIsAtBottom],
  );

  const jumpToBottom = useCallback(() => {
    isPinnedRef.current = true;
    setShowJumpButton(false);
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, []);

  // Follow new content only while pinned. Use "auto" during streaming so
  // rapid deltas don't queue competing smooth-scroll animations.
  useEffect(() => {
    if (!isPinnedRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [dep]);

  // Streaming text lives outside React session state. Follow it imperatively so
  // token arrival does not re-render and reconcile the complete message history.
  useEffect(() => {
    const subscribe = options?.subscribeToStreaming;
    if (!subscribe) return;
    return subscribe(() => {
      if (isPinnedRef.current) {
        bottomRef.current?.scrollIntoView({ behavior: "auto" });
      }
    });
  }, [options?.subscribeToStreaming]);

  return { scrollRef, bottomRef, showJumpButton, jumpToBottom };
}
