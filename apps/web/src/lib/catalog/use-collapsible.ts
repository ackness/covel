import { useState } from "react";

/**
 * useCollapsible — shared expand/collapse state for catalog components.
 *
 * Returns the current `expanded` boolean and a stable `toggle` function.
 * Used by Card and EntryCard to avoid duplicating identical useState logic.
 */
export function useCollapsible(defaultExpanded: boolean): {
  expanded: boolean;
  toggle: () => void;
} {
  const [expanded, setExpanded] = useState(defaultExpanded);

  function toggle() {
    setExpanded((v) => !v);
  }

  return { expanded, toggle };
}
