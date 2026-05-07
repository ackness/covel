/**
 * Appearance primitives. Storage lives in the unified SettingsStore
 * (`ui.appearance`); this module only owns DOM-side theme application.
 */
export type Appearance = string;
export const DEFAULT_APPEARANCE = "paper";

/**
 * Apply the appearance to the document root as a data attribute, so CSS
 * variables cascade across the tree without needing React re-renders.
 */
export function applyAppearance(appearance: Appearance): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", appearance);
}
