/**
 * Appearance primitives. Storage lives in the unified SettingsStore
 * (`ui.appearance`); this module only owns the DOM-side application.
 */
export type Appearance = "modern" | "paper" | "abyss";

export const APPEARANCES: readonly Appearance[] = ["modern", "paper", "abyss"];
export const DEFAULT_APPEARANCE: Appearance = "paper";

export function isAppearance(value: unknown): value is Appearance {
  return (
    typeof value === "string" &&
    (APPEARANCES as readonly string[]).includes(value)
  );
}

/**
 * Apply the appearance to the document root as a data attribute, so CSS
 * variables cascade across the tree without needing React re-renders.
 */
export function applyAppearance(appearance: Appearance): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-appearance", appearance);
}
