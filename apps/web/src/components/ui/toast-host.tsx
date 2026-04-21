/**
 * ToastHost — stacked notifications fed by the global toast channel.
 *
 * Keeps up to MAX_TOASTS visible at a time, auto-dismisses based on kind,
 * and offers a "copy detail" affordance for error toasts that carry a
 * verbose payload (e.g. server response body).
 */

import { useEffect, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Copy, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  subscribeToast,
  type ToastEvent,
  type ToastKind,
} from "@/lib/toast-channel";

const MAX_TOASTS = 3;

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  error: 6000,
  info: 3000,
  success: 3000,
};

const ICONS: Record<ToastKind, ComponentType<{ className?: string }>> = {
  error: AlertTriangle,
  info: Info,
  success: CheckCircle2,
};

const TONE_CLASS: Record<ToastKind, string> = {
  error:
    "border-destructive/50 bg-background text-foreground [&_[data-slot=icon]]:text-destructive",
  info:
    "border-border bg-background text-foreground [&_[data-slot=icon]]:text-primary",
  success:
    "border-emerald-500/40 bg-background text-foreground [&_[data-slot=icon]]:text-emerald-500",
};

export function ToastHost() {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ToastEvent[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const unsub = subscribeToast((event) => {
      setToasts((prev) => {
        const next = [...prev, event];
        // Drop oldest entries so the stack stays bounded.
        return next.length > MAX_TOASTS
          ? next.slice(next.length - MAX_TOASTS)
          : next;
      });
    });
    return unsub;
  }, []);

  // Arm / re-arm auto-dismiss timers as new toasts arrive.
  useEffect(() => {
    const timers = timersRef.current;
    for (const toast of toasts) {
      if (timers.has(toast.id)) continue;
      const handle = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
        timers.delete(toast.id);
      }, AUTO_DISMISS_MS[toast.kind]);
      timers.set(toast.id, handle);
    }
    // Clean up timers whose toasts were dismissed manually.
    for (const id of Array.from(timers.keys())) {
      if (!toasts.some((toast) => toast.id === id)) {
        clearTimeout(timers.get(id)!);
        timers.delete(id);
      }
    }
  }, [toasts]);

  // Clear every pending timer on unmount.
  useEffect(() => {
    return () => {
      for (const handle of timersRef.current.values()) clearTimeout(handle);
      timersRef.current.clear();
    };
  }, []);

  const dismiss = (id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  const copyDetail = async (detail: string) => {
    try {
      await navigator.clipboard.writeText(detail);
    } catch {
      // Clipboard unavailable (insecure context, permissions) — fall back to
      // a textarea selection hack. Best-effort; user can still read the detail
      // because it stays in the DOM after copy attempt.
      const textarea = document.createElement("textarea");
      textarea.value = detail;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } catch {
        // swallow — nothing else to try
      } finally {
        document.body.removeChild(textarea);
      }
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-2.5 shadow-lg backdrop-blur-md",
              "animate-in slide-in-from-bottom-2 fade-in",
              TONE_CLASS[toast.kind],
            )}
          >
            <Icon data-slot="icon" className="mt-0.5 size-4 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm leading-tight">
              <p className="break-words font-medium">{toast.message}</p>
              {toast.detail ? (
                <p className="break-words text-xs text-muted-foreground line-clamp-3">
                  {toast.detail}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {toast.detail ? (
                <button
                  type="button"
                  onClick={() => copyDetail(toast.detail!)}
                  title={t("toast.copy", "Copy detail")}
                  aria-label={t("toast.copy", "Copy detail")}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Copy className="size-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                title={t("toast.dismiss", "Dismiss")}
                aria-label={t("toast.dismiss", "Dismiss")}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
