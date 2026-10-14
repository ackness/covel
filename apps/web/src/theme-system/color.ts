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
function normalizeCssColor(input: string): string | null {
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
  return channelsHex(channels);
}

function channelsHex(channels: Uint8ClampedArray): string {
  return `#${[...channels]
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The sRGB `#rrggbb` of CSS colours painted over each other, the first at the
 * bottom. Null when a colour is invalid or the result is not opaque.
 */
export function flattenToHex(...layers: readonly string[]): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  for (const layer of layers) {
    const normalized = normalizeCssColor(layer);
    if (!normalized) return null;
    ctx.fillStyle = normalized;
    ctx.fillRect(0, 0, 1, 1);
  }
  const channels = ctx.getImageData(0, 0, 1, 1).data;
  return channels[3] === 255 ? channelsHex(channels) : null;
}

export function isValidCssColor(input: string): boolean {
  return normalizeCssColor(input) !== null;
}

/** Relative luminance of an opaque sRGB hex colour (WCAG contrast formula). */
export function relativeLuminance(hex: string): number {
  const linear = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** Null means a transparent, missing, or unsupported background cannot be assessed. */
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const bg = /^#[\da-f]{6}$/i.test(background)
    ? background
    : flattenToHex(background);
  if (!bg) return null;
  const fg = /^#[\da-f]{6}$/i.test(foreground)
    ? foreground
    : flattenToHex(bg, foreground);
  if (!fg) return null;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
