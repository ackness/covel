import { useEffect } from "react";

const EDITABLE = "input, textarea, select, [contenteditable='true']";

/**
 * Number keys pick the current turn's options: 1 clicks the first visible
 * `.ui-choice`, 2 the second, and so on, counted across every block of the
 * turn the same way the numbers are drawn. It works on whatever the page
 * shows — any plugin's choices rendered through the catalog — and does nothing
 * while the player is typing, a dialog is open, or the turn is still running.
 */
export function useChoiceHotkeys(
  container: HTMLElement | null,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!container || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const { target } = event;
      if (target instanceof Element && target.closest(EDITABLE)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      // Options inside a folded disclosure are not laid out; skip them so
      // the numbers match what the player sees. A disabled option keeps its
      // number and simply does not answer.
      const choices = [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[data-turn-current="true"] button.ui-choice',
        ),
      ].filter((choice) => choice.getClientRects().length > 0);
      const choice = choices[Number(event.key) - 1];
      if (!choice || choice.disabled) return;
      event.preventDefault();
      choice.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [container, enabled]);
}
