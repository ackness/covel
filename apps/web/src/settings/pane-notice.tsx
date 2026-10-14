import { useCallback, useEffect, useRef, useState } from "react";

export interface PaneNoticeState {
  message: string;
  tone: "success" | "error";
}

/** Each new result owns its full display time; an older timer cannot hide it. */
export function usePaneNotice() {
  const [notice, setNotice] = useState<PaneNoticeState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setNotice(null);
  }, []);
  const show = useCallback((next: PaneNoticeState, duration = 5000) => {
    clearTimeout(timer.current);
    setNotice(next);
    timer.current = setTimeout(() => {
      setNotice(null);
      timer.current = undefined;
    }, duration);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { notice, show, clear };
}

export function PaneNotice({ notice }: { notice: PaneNoticeState | null }) {
  if (!notice) return null;
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`rounded border px-3 py-2 text-xs ${notice.tone === "error" ? "border-destructive/20 bg-destructive/10 text-destructive" : "border-primary/20 bg-primary/10 text-primary"}`}
    >
      {notice.message}
    </div>
  );
}
