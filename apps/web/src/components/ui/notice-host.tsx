/**
 * NoticeHost: the one place cards and toasts appear, top-right under the app
 * bar and the session header. Cards stack first and stay until their
 * condition ends; toasts below them fade out.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  dismissNotice,
  dismissToast,
  toastDuration,
  useNotices,
} from "@/lib/notice-center.js";
import { NoticeView } from "./notice-parts.js";

const DEFAULT_TOP = "4rem";
const GAP_PX = 8;

// Host chrome along the top of the page (app bar, session header, plugin
// page bar). Notices sit under the lowest one, so they never cover it.
const anchors = new Set<Element>();
const anchorListeners = new Set<() => void>();
function anchorsChanged(): void {
  for (const listener of [...anchorListeners]) listener();
}

/** Mark an element as top chrome that notices must stay below. */
export function useNoticeAnchor(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    anchors.add(element);
    anchorsChanged();
    return () => {
      anchors.delete(element);
      anchorsChanged();
    };
  }, [ref]);
}

/** Keep `--covel-notice-top` at the bottom edge of the lowest anchor. */
function useNoticeTop(): void {
  useEffect(() => {
    let frame = 0;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());
    const observed = new Set<Element>();
    const measure = () => {
      frame = 0;
      let bottom = 0;
      for (const element of anchors) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
        if (resizeObserver && !observed.has(element)) {
          resizeObserver.observe(element);
          observed.add(element);
        }
      }
      for (const element of observed) {
        if (!anchors.has(element)) {
          resizeObserver?.unobserve(element);
          observed.delete(element);
        }
      }
      const root = document.documentElement.style;
      if (bottom > 0)
        root.setProperty(
          "--covel-notice-top",
          `${Math.round(bottom + GAP_PX)}px`,
        );
      else root.removeProperty("--covel-notice-top");
    };
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    }
    measure();
    anchorListeners.add(schedule);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      anchorListeners.delete(schedule);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      document.documentElement.style.removeProperty("--covel-notice-top");
    };
  }, []);
}

/** Height of the card stack, so toasts start right under it. */
function useStackHeight(ref: RefObject<HTMLElement | null>, active: boolean) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) {
      setHeight(0);
      return;
    }
    const update = () => setHeight(element.getBoundingClientRect().height);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return height;
}

export function NoticeHost() {
  const { t } = useTranslation();
  const toasts = useNotices((state) => state.toasts);
  const cards = useNotices((state) =>
    state.cards.filter((card) => !card.collapsed),
  );
  useNoticeTop();

  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Hover and keyboard focus independently pause auto-dismiss.
  const pausedRef = useRef<Map<number, Set<"hover" | "focus">>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    for (const toast of toasts) {
      if (timers.has(toast.id) || pausedRef.current.has(toast.id)) continue;
      timers.set(
        toast.id,
        setTimeout(() => {
          timers.delete(toast.id);
          dismissToast(toast.id);
        }, toastDuration(toast)),
      );
    }
    for (const id of [...pausedRef.current.keys()]) {
      if (!toasts.some((toast) => toast.id === id))
        pausedRef.current.delete(id);
    }
    for (const id of [...timers.keys()]) {
      if (!toasts.some((toast) => toast.id === id)) {
        clearTimeout(timers.get(id)!);
        timers.delete(id);
      }
    }
  }, [toasts]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, []);

  const pause = (id: number, reason: "hover" | "focus") => {
    const reasons = pausedRef.current.get(id) ?? new Set();
    reasons.add(reason);
    pausedRef.current.set(id, reasons);
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
  };

  // Resume with a full reading interval after both hover and focus leave.
  const resume = (id: number, reason: "hover" | "focus") => {
    const reasons = pausedRef.current.get(id);
    reasons?.delete(reason);
    if (reasons?.size) return;
    pausedRef.current.delete(id);
    const toast = toasts.find((entry) => entry.id === id);
    if (!toast || timersRef.current.has(id)) return;
    timersRef.current.set(
      id,
      setTimeout(() => {
        timersRef.current.delete(id);
        dismissToast(id);
      }, toastDuration(toast)),
    );
  };

  const stackRef = useRef<HTMLDivElement>(null);
  const stackHeight = useStackHeight(stackRef, cards.length > 0);

  if (toasts.length === 0 && cards.length === 0) return null;

  const top = `var(--covel-notice-top, ${DEFAULT_TOP})`;
  const column =
    "pointer-events-none fixed right-4 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 max-sm:left-4 max-sm:w-auto";
  // Every child of <body> is its own stacking context at z-index 1 (see
  // index.css), the app root included. Cards stay until resolved, so they
  // render inside the app, under the session header (z 40) with its menus
  // and under popovers and dialogs. Toasts are brief results, often of an
  // action taken inside a dialog, so they go to <body> and sit above it all.
  return (
    <>
      {cards.length > 0 && (
        <div
          ref={stackRef}
          data-notice-host=""
          data-notice-cards=""
          data-covel-host-controls=""
          aria-live="polite"
          style={{ top }}
          className={`${column} z-30 max-h-[calc(100dvh-8rem)] overflow-y-auto`}
        >
          {cards.map(({ notice }) => (
            <NoticeView
              key={notice.key}
              notice={notice}
              closeLabel={
                notice.onDismiss
                  ? t("toast.dismiss", "Dismiss")
                  : t("notice.collapse")
              }
              onClose={() =>
                notice.onDismiss
                  ? notice.onDismiss()
                  : dismissNotice(notice.key)
              }
            />
          ))}
        </div>
      )}
      {toasts.length > 0 &&
        createPortal(
          <div
            data-notice-host=""
            data-notice-toasts=""
            data-covel-host-controls=""
            aria-live="polite"
            style={{
              top: stackHeight
                ? `calc(${top} + ${Math.round(stackHeight + GAP_PX)}px)`
                : top,
            }}
            className={`${column} z-100`}
          >
            {toasts.map((toast) => (
              <NoticeView
                key={toast.id}
                notice={toast}
                closeLabel={t("toast.dismiss", "Dismiss")}
                onClose={() => dismissToast(toast.id)}
                onMouseEnter={() => pause(toast.id, "hover")}
                onMouseLeave={() => resume(toast.id, "hover")}
                onFocus={() => pause(toast.id, "focus")}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    resume(toast.id, "focus");
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
