/**
 * CSS colour normalisation with no dependency.
 *
 * Themes author colours in `oklch()`, but `<input type="color">` only speaks
 * `#rrggbb`. Canvas 2D's `fillStyle` setter is the browser's own CSS colour
 * parser; pixel readback converts modern colour spaces to sRGB. Assigning an
 * invalid colour leaves the previous value untouched, allowing validation.
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
 * Return the browser's CSS colour serialization, or null if invalid.
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
 * Best-effort sRGB `#rrggbb` for a swatch input. Canvas can preserve oklch()
 * in fillStyle, so read its painted pixel instead of treating coordinates in
 * that colour space as RGB channels. The text field retains the exact value.
 */
export function toSwatchHex(input: string): string | null {
  const normalized = normalizeCssColor(input);
  if (!normalized) return null;
  if (/^#[\da-f]{6}$/i.test(normalized)) return normalized;

  const ctx = getContext();
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = normalized;
  ctx.fillRect(0, 0, 1, 1);
  const channels = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[...channels]
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function isValidCssColor(input: string): boolean {
  return normalizeCssColor(input) !== null;
}
