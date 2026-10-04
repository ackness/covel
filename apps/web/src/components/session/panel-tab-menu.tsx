import { useEffect, useRef, useState } from "react";
import { LayoutGrid, type LucideIcon } from "lucide-react";

export interface PanelTabMenuItem {
  readonly value: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * Every tab of the context panel in one grid, for a tab bar too short to show
 * them all: the bar scrolls, and this lists what the scroll hides. It opens
 * under the whole bar, so it is placed by the bar, not by its own button.
 */
export function PanelTabMenu({
  items,
  active,
  label,
  onSelect,
}: {
  readonly items: readonly PanelTabMenuItem[];
  readonly active: string;
  readonly label: string;
  readonly onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={`ui-panel-tab-menu flex size-8 items-center justify-center rounded-(--radius-control) text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground ${
          open ? "bg-accent text-accent-foreground" : ""
        }`}
      >
        <LayoutGrid className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="ui-dialog-shell absolute inset-x-2 top-full z-30 mt-1 grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {items.map((item) => {
            const ItemIcon = item.icon;
            return (
              <button
                key={item.value}
                type="button"
                role="menuitemradio"
                aria-checked={item.value === active}
                onClick={() => {
                  onSelect(item.value);
                  setOpen(false);
                }}
                className="flex h-9 min-w-0 items-center gap-2 rounded-(--radius-control) px-2.5 text-left text-[13px] hover:bg-muted/60 aria-checked:bg-accent aria-checked:font-medium aria-checked:text-accent-foreground"
              >
                <ItemIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
