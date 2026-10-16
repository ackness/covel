import { useEffect, useRef } from "react";

/** Dismiss a menu outside its container or with Escape. */
export function useDismissibleMenu(
  open: boolean,
  onOpenChange: (open: boolean) => void,
  restoreFocusOnEscape = false,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node))
        onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
        if (restoreFocusOnEscape) triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange, restoreFocusOnEscape]);
  return { containerRef, triggerRef };
}
