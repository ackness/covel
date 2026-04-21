export type Appearance = "modern" | "paper";

export const APPEARANCES: readonly Appearance[] = ["modern", "paper"];
export const APPEARANCE_STORAGE_KEY = "covel:appearance";
export const DEFAULT_APPEARANCE: Appearance = "modern";

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value);
}

export function getStoredAppearance(): Appearance | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearance(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function setStoredAppearance(appearance: Appearance): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // storage unavailable (private mode / quota); silently skip
  }
}

export function resolveInitialAppearance(): Appearance {
  return getStoredAppearance() ?? DEFAULT_APPEARANCE;
}

/**
 * Apply the appearance to the document root as a data attribute, so CSS
 * variables cascade across the tree without needing React re-renders.
 * Safe to call during module init to avoid an FOUC on first paint.
 */
export function applyAppearance(appearance: Appearance): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-appearance", appearance);
}

const APPEARANCE_EVENT = "covel:appearance-changed";

export function emitAppearanceChange(appearance: Appearance): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Appearance>(APPEARANCE_EVENT, { detail: appearance }));
}

export function subscribeAppearance(
  handler: (appearance: Appearance) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<Appearance>).detail;
    if (isAppearance(detail)) handler(detail);
  };
  window.addEventListener(APPEARANCE_EVENT, listener);
  return () => window.removeEventListener(APPEARANCE_EVENT, listener);
}
