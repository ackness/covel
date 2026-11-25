import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Minimize2, Maximize2, X } from "lucide-react";
import { PluginPanel } from "@/components/session/plugin-panel.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  closePluginWindow,
  focusPluginWindow,
  toggleMinimizePluginWindow,
  usePlatformUiState,
  type OpenFloatingWindow,
} from "@/lib/platform-ui-events.js";
import type { UISlotEntry, UISlotSpec } from "@/services/api.js";
import { InstancePluginPanel } from "./instance-panel-host.js";

function FloatingWindowItem({
  win,
  index,
  spec,
  scope,
}: {
  readonly win: OpenFloatingWindow;
  readonly index: number;
  readonly spec: UISlotSpec;
  readonly scope: "instance" | "session";
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const width = Math.min(Math.max(spec.defaultWidth ?? 400, 240), 960);
  const height = Math.min(Math.max(spec.defaultHeight ?? 320, 180), 720);

  const [pos, setPos] = useState(() => ({
    x: 24 + (index % 4) * 28,
    y: 72 + (index % 4) * 28,
  }));

  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const stopDrag = () => {
    dragStartRef.current = null;
  };

  const title =
    resolveDisplayText(spec.label, locale) || spec.id || win.pluginId;

  return (
    <section
      aria-label={title}
      data-testid={`floating-window-${win.key}`}
      onMouseDown={() => focusPluginWindow(win.key)}
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${width}px`,
        height: win.minimized ? "auto" : `${height}px`,
        zIndex: 40 + win.zIndex,
        maxWidth: "calc(100vw - 24px)",
        maxHeight: "calc(100vh - 24px)",
      }}
      className="fixed flex flex-col overflow-hidden rounded-lg border border-border bg-background/95 shadow-xl backdrop-blur-md"
    >
      <header
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          dragStartRef.current = {
            pointerX: e.clientX,
            pointerY: e.clientY,
            origX: pos.x,
            origY: pos.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const drag = dragStartRef.current;
          if (!drag) return;
          const dx = e.clientX - drag.pointerX;
          const dy = e.clientY - drag.pointerY;
          const maxX =
            typeof window !== "undefined"
              ? Math.max(8, window.innerWidth - 160)
              : 1000;
          const maxY =
            typeof window !== "undefined"
              ? Math.max(8, window.innerHeight - 60)
              : 700;
          setPos({
            x: Math.min(Math.max(8, drag.origX + dx), maxX),
            y: Math.min(Math.max(8, drag.origY + dy), maxY),
          });
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag}
        className="flex cursor-move items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 select-none"
      >
        <span className="truncate text-xs font-medium">{title}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => toggleMinimizePluginWindow(win.key)}
            aria-label={
              win.minimized
                ? t("platform.windowRestore", "Restore")
                : t("platform.windowMinimize", "Minimize")
            }
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {win.minimized ? (
              <Maximize2 className="h-3.5 w-3.5" />
            ) : (
              <Minimize2 className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => closePluginWindow(win.key)}
            aria-label={t("common.close", "Close")}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      <div
        hidden={win.minimized}
        className={
          win.minimized ? "hidden" : "min-h-0 flex-1 overflow-y-auto p-3"
        }
      >
        {scope === "instance" ? (
          <InstancePluginPanel
            pluginId={win.pluginId}
            panelId={spec.id}
            spec={spec}
            fill
          />
        ) : (
          <PluginPanel
            pluginId={win.pluginId}
            panelId={spec.id}
            spec={spec as unknown as Record<string, unknown>}
            fill
          />
        )}
      </div>
    </section>
  );
}

export function FloatingWindowHost({
  scope,
  entries,
  sessionId,
}: {
  readonly scope: "instance" | "session";
  readonly entries: readonly UISlotEntry[];
  readonly sessionId?: string;
}) {
  const { openWindows } = usePlatformUiState();
  const matched =
    openWindows.length === 0 || entries.length === 0
      ? []
      : openWindows.flatMap((win, index) => {
          const entry = entries.find((item) => item.pluginId === win.pluginId);
          const spec = entry?.specs.find((item) => {
            if (item.id !== win.windowId) return false;
            const specScope =
              item.windowScope === "instance" ? "instance" : "session";
            return specScope === scope;
          });
          return spec ? [{ win, index, spec }] : [];
        });

  const sessionWindowKeysRef = useRef<string[]>([]);
  sessionWindowKeysRef.current =
    scope === "session" ? matched.map(({ win }) => win.key) : [];

  useEffect(() => {
    if (scope !== "session") return;
    return () => {
      for (const key of sessionWindowKeysRef.current) {
        closePluginWindow(key);
      }
    };
  }, [scope, sessionId]);

  if (matched.length === 0) return null;

  return (
    <>
      {matched.map(({ win, index, spec }) => (
        <FloatingWindowItem
          key={win.key}
          win={win}
          index={index}
          spec={spec}
          scope={scope}
        />
      ))}
    </>
  );
}
