import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Infinite scroll upward: loads older messages when the top sentinel enters the
 * viewport, then compensates `scrollTop` by the `scrollHeight` delta after
 * prepending to keep the visible scroll position steady.
 *
 * Implemented directly with `useState`/`useEffect` and `IntersectionObserver`
 * (using the scroll viewport as `root`) while `hasOlder` is true.
 */

interface UseLoadOlderMessagesArgs {
  /** Native scrollable viewport element; inactive when null. */
  readonly viewportEl: HTMLElement | null;
  /** Whether older messages remain (`olderMessagesCursor !== null`). */
  readonly hasOlder: boolean;
  /** First message id in the list — changes trigger scroll compensation after prepend. */
  readonly firstMessageId: string | undefined;
  /** Fetches and prepends an older page (via store `PREPEND_MESSAGES`). */
  readonly onLoadOlder: () => Promise<void>;
}

interface UseLoadOlderMessagesResult {
  /** Sentinel element attached to the top of the message list. */
  readonly topSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** True while fetching an older page, used to display the loading indicator. */
  readonly loadingOlder: boolean;
  /** True when the last fetch failed; cleared on retry or next load start. */
  readonly loadFailed: boolean;
  /** Retries fetching the older page from the error banner button. */
  readonly retry: () => void;
}

/** Top prefetch threshold in px before reaching the edge to avoid blank gaps. */
const TOP_TRIGGER_MARGIN_PX = 200;

export function useLoadOlderMessages({
  viewportEl,
  hasOlder,
  firstMessageId,
  onLoadOlder,
}: UseLoadOlderMessagesArgs): UseLoadOlderMessagesResult {
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Pre-fetch scroll anchor (height + offset) to preserve scroll position after prepend.
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  // Ref-backed loading flag for synchronous IntersectionObserver deduplication.
  const loadingRef = useRef(false);

  const trigger = useCallback(async () => {
    if (loadingRef.current || !hasOlder) return;
    const vp = viewportEl;
    if (!vp) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    setLoadFailed(false);
    anchorRef.current = { height: vp.scrollHeight, top: vp.scrollTop };
    try {
      await onLoadOlder();
    } catch {
      anchorRef.current = null;
      setLoadFailed(true);
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasOlder, viewportEl, onLoadOlder]);

  // Trigger loading when the top sentinel enters the viewport (only when older pages exist).
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel || !viewportEl || !hasOlder || loadFailed) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void trigger();
      },
      {
        root: viewportEl,
        rootMargin: `${TOP_TRIGGER_MARGIN_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [viewportEl, hasOlder, loadFailed, trigger]);

  // Adjust scrollTop by the scrollHeight delta before paint once older messages
  // are prepended (firstMessageId changes); skip on append or initial load.
  useLayoutEffect(() => {
    const vp = viewportEl;
    const anchor = anchorRef.current;
    if (!vp || !anchor) return;
    const delta = vp.scrollHeight - anchor.height;
    if (delta > 0) vp.scrollTop = anchor.top + delta;
    anchorRef.current = null;
  }, [firstMessageId, viewportEl]);

  return {
    topSentinelRef,
    loadingOlder,
    loadFailed,
    retry: () => void trigger(),
  };
}
