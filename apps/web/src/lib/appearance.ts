/**
 * Appearance primitives. Storage lives in the unified SettingsStore;
 * this module only owns DOM-side theme application.
 */
export type Appearance = string;
export type ColorScheme = "light" | "dark";
export const DEFAULT_APPEARANCE = "paper";
export const DEFAULT_COLOR_SCHEME: ColorScheme = "dark";

/**
 * Lives here rather than in the theme registry so the override layer can read
 * the active scheme without importing the registry back — that edge would be a
 * cycle. `theme-system/registry.ts` re-exports it for existing callers.
 */
export const THEME_SCHEME_KEY = "ui.scheme";

/**
 * Apply the appearance to the document root as a data attribute, so CSS
 * variables cascade across the tree without needing React re-renders.
 */
export function applyAppearance(appearance: Appearance): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", appearance);
}

export function applyColorScheme(scheme: ColorScheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-scheme", scheme);
  document.documentElement.classList.toggle("dark", scheme === "dark");
  document.documentElement.style.colorScheme = scheme;
}
