/**
 * CSS colour normalisation with no dependency.
 *
 * Themes author colours in `oklch()`, but `<input type="color">` only speaks
 * `#rrggbb`. Canvas 2D's `fillStyle` setter is the browser's own CSS colour
 * parser: assigning any valid colour normalises it to `#rrggbb` (or
 * `rgba(...)` when translucent), and assigning an *invalid* one leaves the
 * previous value untouched — which is what makes validation possible.
 */

let cachedContext: CanvasRenderingContext2D | null | undefined;

function getContext(): CanvasRenderingContext2D | null {
  if (cachedContext !== undefined) return cachedContext;
  if (typeof document === "undefined") {
    cachedContext = null;
    return null;
  }
  cachedContext = document.createElement("canvas").getContext("2d");
  return cachedContext;
}

/**
 * Normalise any CSS colour to `#rrggbb` / `rgba(...)`, or null if invalid.
 *
 * Probing twice with different seeds is the validity check: a rejected
 * assignment leaves each seed in place, so the two reads disagree.
 */
export function normalizeCssColor(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const ctx = getContext();
  if (!ctx) return null;

  ctx.fillStyle = "#000000";
  ctx.fillStyle = value;
  const first = ctx.fillStyle;

  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = value;
  const second = ctx.fillStyle;

  if (typeof first !== "string" || first !== second) return null;
  return first;
}

/**
 * Best-effort `#rrggbb` for a swatch input. Translucent colours normalise to
 * `rgba(...)`, whose opaque part still drives the swatch — the exact value
 * stays editable in the paired text field.
 */
export function toSwatchHex(input: string): string | null {
  const normalized = normalizeCssColor(input);
  if (!normalized) return null;
  if (normalized.startsWith("#")) return normalized;

  const parts = normalized.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;

  const toHex = (raw: string): string =>
    Math.max(0, Math.min(255, Math.round(Number(raw))))
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(parts[0]!)}${toHex(parts[1]!)}${toHex(parts[2]!)}`;
}

export function isValidCssColor(input: string): boolean {
  return normalizeCssColor(input) !== null;
}
