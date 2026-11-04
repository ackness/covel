/**
 * NoticeHost: the one place cards and toasts appear, top-right under the app
 * bar and the session header. Cards stack first and stay until their
 * condition ends; toasts below them fade out.
 */

import { useEffect, useRef } from "react";
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
/** Elements whose bottom edge the notices sit under. */
const HEADER_SELECTOR = ".ui-app-header, .ui-session-header";
const GAP_PX = 8;

/** Keep `--covel-notice-top` at the bottom edge of the header area. */
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
      for (const element of document.querySelectorAll(HEADER_SELECTOR)) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0) bottom = Math.max(bottom, rect.bottom);
        if (resizeObserver && !observed.has(element)) {
          resizeObserver.observe(element);
          observed.add(element);
        }
      }
      for (const element of observed) {
        if (!element.isConnected) {
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
    // Headers mount and unmount with routes; re-measure when the page changes.
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(schedule);
    mutations?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      mutations?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      document.documentElement.style.removeProperty("--covel-notice-top");
    };
  }, []);
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

  if (toasts.length === 0 && cards.length === 0) return null;

  // Rendered under `document.body`: the app root is its own stacking context,
  // so a notice inside it would sit under every dialog, whatever its z-index.
  return createPortal(
    <div
      data-notice-host
      data-covel-host-controls=""
      aria-live="polite"
      aria-atomic="false"
      style={{ top: `var(--covel-notice-top, ${DEFAULT_TOP})` }}
      className="pointer-events-none fixed right-4 z-100 flex max-h-[calc(100dvh-5rem)] w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto max-sm:left-4 max-sm:w-auto"
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
            notice.onDismiss ? notice.onDismiss() : dismissNotice(notice.key)
          }
        />
      ))}
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
  );
}
