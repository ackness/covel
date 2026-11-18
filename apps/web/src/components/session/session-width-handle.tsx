import { useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";

const widths = {
  reading: { initial: 608, minimum: 352, maximum: 1200, reserve: 288 },
  stage: { initial: 768, minimum: 480, maximum: 1280, reserve: 64 },
} as const;

type Surface = keyof typeof widths;

export function useSessionWidth(surface: Surface, active = true) {
  const limits = widths[surface];
  const key = `covel:session-width:${surface}`;
  const [preferred, setPreferred] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      if (stored >= limits.minimum && stored <= limits.maximum) return stored;
    } catch {
      return limits.initial;
    }
    return limits.initial;
  });
  const [draft, setDraft] = useState<number>();
  const [hostWidth, setHostWidth] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHostWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  const maximum = Math.max(
    limits.minimum,
    Math.min(limits.maximum, hostWidth - limits.reserve),
  );
  const enabled = hostWidth >= (surface === "reading" ? 800 : 640);
  const width = enabled
    ? Math.min(draft ?? preferred, maximum)
    : limits.initial;

  function change(value: number, persist: boolean) {
    const next = Math.round(Math.max(limits.minimum, Math.min(maximum, value)));
    if (!persist) {
      setDraft(next);
      return;
    }
    save(next);
  }

  function save(value: number) {
    setDraft(undefined);
    setPreferred(value);
    try {
      localStorage.setItem(key, String(value));
    } catch {
      return;
    }
  }

  return {
    host,
    hostWidth,
    width,
    enabled,
    handle: {
      surface,
      width,
      minimum: limits.minimum,
      maximum,
      change,
      reset: () => save(limits.initial),
      cancel: () => setDraft(undefined),
    },
  };
}

export function SessionWidthHandle({
  label,
  controls,
  surface,
  width,
  minimum,
  maximum,
  change,
  reset,
  cancel,
}: ReturnType<typeof useSessionWidth>["handle"] & {
  label: string;
  controls: string;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ id: number; start: number; width: number }>(null);
  const scale = surface === "reading" ? -1 : 2;
  const left = surface === "reading";

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={width}
      aria-valuetext={t("session.panelWidthPixels", { width })}
      title={label}
      className={`ui-session-width-handle ${left ? "left-0 hidden lg:flex" : "right-0 flex"}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        drag.current = { id: event.pointerId, start: event.clientX, width };
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        change(start.width + (event.clientX - start.start) * scale, false);
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        if (event.clientX !== start.start)
          change(start.width + (event.clientX - start.start) * scale, true);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        drag.current = null;
        cancel();
        delete event.currentTarget.dataset.dragging;
      }}
      onDoubleClick={reset}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          reset();
          return;
        }
        const targets: Record<string, number> = {
          ArrowLeft: width - 32 * Math.sign(scale),
          ArrowRight: width + 32 * Math.sign(scale),
          Home: minimum,
          End: maximum,
        };
        const next = targets[event.key];
        if (typeof next !== "number") return;
        event.preventDefault();
        change(next, true);
      }}
    >
      <GripVertical aria-hidden="true" className="size-3.5" />
    </div>
  );
}
