import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * 无限向上滚动：顶部 sentinel 进入视口时加载更旧消息，并在合并到列表前部后按
 * scrollHeight 差值补偿 scrollTop，保持视图不跳动（无限上滚的标准做法）。
 *
 * 仓库没有 React Query / 无限滚动库，这里用 useState/useEffect + IntersectionObserver
 * 手写。观察器以滚动视口为 root，只在 `hasOlder` 为真时挂载。
 */

interface UseLoadOlderMessagesArgs {
  /** 实际滚动的视口元素（Radix ScrollArea 的 viewport），null 时不启用。 */
  readonly viewportEl: HTMLElement | null;
  /** 是否还有更旧消息可加载（olderMessagesCursor 非 null）。 */
  readonly hasOlder: boolean;
  /** 当前列表首条消息 id —— 变化即表示前部合并了更旧消息，触发滚动补偿。 */
  readonly firstMessageId: string | undefined;
  /** 拉取并 prepend 更旧一页（内部走 store action → dispatch PREPEND_MESSAGES）。 */
  readonly onLoadOlder: () => Promise<void>;
}

interface UseLoadOlderMessagesResult {
  /** 挂到消息列表顶部的哨兵元素。 */
  readonly topSentinelRef: React.RefObject<HTMLDivElement | null>;
  /** 正在加载更旧消息 —— 用于展示加载指示。 */
  readonly loadingOlder: boolean;
}

/** 顶部提前量：滚动到距顶部该像素内就预取，减少可见空白。 */
const TOP_TRIGGER_MARGIN_PX = 200;

export function useLoadOlderMessages({
  viewportEl,
  hasOlder,
  firstMessageId,
  onLoadOlder,
}: UseLoadOlderMessagesArgs): UseLoadOlderMessagesResult {
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // 加载前的滚动锚点（视口高度 + 位置）。加载后按新旧高度差补偿 scrollTop。
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  // ref 版 loading，供 IntersectionObserver 回调同步判重（避免闭包陈旧 / 并发触发）。
  const loadingRef = useRef(false);

  const trigger = useCallback(async () => {
    if (loadingRef.current || !hasOlder) return;
    const vp = viewportEl;
    if (!vp) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    anchorRef.current = { height: vp.scrollHeight, top: vp.scrollTop };
    try {
      await onLoadOlder();
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasOlder, viewportEl, onLoadOlder]);

  // 顶部 sentinel 进入视口即触发加载。仅在有更旧消息且视口就绪时挂载观察器。
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel || !viewportEl || !hasOlder) return;
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
  }, [viewportEl, hasOlder, trigger]);

  // 更旧消息合并到前部后（首条 id 变化），按 scrollHeight 差值补偿 scrollTop。
  // useLayoutEffect 在绘制前同步调整，避免可见跳动。anchor 为空时（普通追加 /
  // 首次加载）直接跳过。
  useLayoutEffect(() => {
    const vp = viewportEl;
    const anchor = anchorRef.current;
    if (!vp || !anchor) return;
    const delta = vp.scrollHeight - anchor.height;
    if (delta > 0) vp.scrollTop = anchor.top + delta;
    anchorRef.current = null;
  }, [firstMessageId, viewportEl]);

  return { topSentinelRef, loadingOlder };
}
