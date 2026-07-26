import type { SettingsStoreApi } from "@covel/settings";
import { loadOverrides, resolveActiveOverrides } from "./overrides.js";
import type { ThemeScheme } from "./types.js";

/**
 * Bake the current look — active theme plus the player's token overrides —
 * into a standalone theme package.
 *
 * Snapshotting the *whole* token contract rather than just the overridden
 * tokens is the point: a theme that only carried the changed values would fall
 * back to `index.css` base values everywhere else, so "save as theme" would
 * visibly change the look it was meant to preserve.
 */

/**
 * The shared token contract from `docs/reference/theme-packages.md` §5.
 *
 * `--noise-image` is deliberately absent: it is a multi-kilobyte inline SVG
 * data-URI that every theme inherits unchanged, so baking it in would bloat
 * every exported file for no visual difference.
 */
const SNAPSHOT_TOKENS: readonly string[] = [
  "--color-background",
  "--color-foreground",
  "--color-card",
  "--color-card-foreground",
  "--color-popover",
  "--color-popover-foreground",
  "--color-primary",
  "--color-primary-foreground",
  "--color-secondary",
  "--color-secondary-foreground",
  "--color-muted",
  "--color-muted-foreground",
  "--color-accent",
  "--color-accent-foreground",
  "--color-destructive",
  "--color-destructive-foreground",
  "--color-border",
  "--color-input",
  "--color-ring",
  "--surface-page",
  "--surface-rail",
  "--surface-inset",
  "--surface-elevated",
  "--surface-dialog",
  "--surface-player",
  "--surface-empty",
  "--border-subtle",
  "--rule-color",
  "--rule-strong-color",
  "--rule-style",
  "--rule-thickness",
  "--rule-strong-thickness",
  "--accent-primary",
  "--accent-secondary",
  "--accent-warning",
  "--accent-danger",
  "--accent-success",
  "--radius-card",
  "--radius-control",
  "--radius-dialog",
  "--radius-chip",
  "--panel-header-height",
  "--panel-section-padding-x",
  "--panel-section-padding-y",
  "--rail-width-left",
  "--rail-width-right",
  "--composer-max-width",
  "--session-column-max-width",
  "--ambience-image",
  "--ambience-blend",
  "--ambience-opacity",
  "--noise-opacity",
  "--font-sans",
  "--font-display",
  "--font-serif",
  "--font-mono",
  "--eyebrow-font-family",
  "--eyebrow-font-size",
  "--eyebrow-font-weight",
  "--eyebrow-letter-spacing",
  "--eyebrow-text-transform",
  "--title-font-family",
  "--title-font-style",
  "--title-font-weight",
  "--title-letter-spacing",
  "--title-text-transform",
  "--story-font-family",
  "--story-font-size",
  "--story-line-height",
  "--story-font-weight",
  "--story-letter-spacing",
  "--story-max-width",
  "--meta-font-family",
  "--meta-font-size",
  "--meta-letter-spacing",
  "--meta-text-transform",
  "--shadow-card",
  "--shadow-dialog",
  "--shadow-pop",
];

/**
 * A generated declaration goes back through the theme parser, so a value
 * carrying `;` or a brace could close the rule early and escape the theme's
 * `data-theme` scope. Computed values never contain them, but overrides are
 * stored strings that only passed a length/name check.
 */
const UNSAFE_VALUE = /[;{}]/;

function isSafeDeclaration(value: string): boolean {
  return value.trim().length > 0 && !UNSAFE_VALUE.test(value);
}

/** Run `read` with a scheme temporarily forced, then restore the DOM exactly. */
function withScheme<T>(scheme: ThemeScheme, read: () => T): T {
  const root = document.documentElement;
  const previousScheme = root.getAttribute("data-scheme");
  const wasDark = root.classList.contains("dark");

  root.setAttribute("data-scheme", scheme);
  root.classList.toggle("dark", scheme === "dark");
  try {
    return read();
  } finally {
    if (previousScheme !== null)
      root.setAttribute("data-scheme", previousScheme);
    else root.removeAttribute("data-scheme");
    root.classList.toggle("dark", wasDark);
  }
}

function readSnapshot(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of SNAPSHOT_TOKENS) {
    const value = computed.getPropertyValue(name).trim();
    if (isSafeDeclaration(value)) out[name] = value;
  }
  return out;
}

function declarations(values: Record<string, string>, indent = "  "): string {
  return Object.entries(values)
    .map(([name, value]) => `${indent}${name}: ${value};`)
    .join("\n");
}

export interface ThemeCssSnapshot {
  readonly cssText: string;
  readonly schemes: readonly ThemeScheme[];
}

/**
 * Build the CSS for a theme that reproduces what is on screen right now.
 *
 * Both schemes are captured by briefly forcing each one and reading the
 * cascade — all inside one synchronous block, and with the player's inline
 * overrides lifted first so the theme's own values are what gets read.
 */
export function buildThemeCss(
  store: SettingsStoreApi,
  themeId: string,
  sourceSchemes?: readonly ThemeScheme[],
): ThemeCssSnapshot {
  const root = document.documentElement;
  const overrides = loadOverrides(store);

  // Lift the inline overrides: they belong to the *current* scheme only, and
  // would otherwise leak into both snapshots.
  const lifted = SNAPSHOT_TOKENS.map(
    (name) => [name, root.style.getPropertyValue(name)] as const,
  ).filter(([, value]) => value !== "");
  for (const [name] of lifted) root.style.removeProperty(name);

  let light: Record<string, string>;
  let dark: Record<string, string>;
  try {
    light = withScheme("light", readSnapshot);
    dark = withScheme("dark", readSnapshot);
  } finally {
    for (const [name, value] of lifted) root.style.setProperty(name, value);
  }

  const applyOverrides = (
    base: Record<string, string>,
    scheme: ThemeScheme,
  ): Record<string, string> => {
    const next = { ...base };
    for (const [name, value] of Object.entries(
      resolveActiveOverrides(overrides, scheme),
    )) {
      if (isSafeDeclaration(value)) next[name] = value;
    }
    return next;
  };

  const lightValues = applyOverrides(light, "light");
  const darkValues = applyOverrides(dark, "dark");
  // Only the deltas go in the `.dark` block — a full duplicate would double
  // the file and hide which tokens actually differ between schemes.
  const darkDelta = Object.fromEntries(
    Object.entries(darkValues).filter(
      ([name, value]) => lightValues[name] !== value,
    ),
  );

  const blocks = [
    `html[data-theme="${themeId}"] {\n${declarations(lightValues)}\n}`,
  ];
  if (Object.keys(darkDelta).length > 0) {
    blocks.push(
      `html[data-theme="${themeId}"].dark {\n${declarations(darkDelta)}\n}`,
    );
  }

  // A single-scheme source (a dark-only theme) snapshots identically in both
  // schemes, so an empty delta means "this theme has one look", NOT "this is a
  // light theme". Reporting light-only there would strip the `.dark` class and
  // silently kill every Tailwind `dark:` variant while the tokens stayed dark.
  const schemes: readonly ThemeScheme[] =
    Object.keys(darkDelta).length > 0
      ? ["light", "dark"]
      : sourceSchemes?.length
        ? sourceSchemes
        : ["light"];

  return {
    cssText: `/* Generated by Covel — Settings → Appearance */\n\n${blocks.join("\n\n")}\n`,
    schemes,
  };
}

/**
 * Fallback id for names that carry no latin characters at all.
 *
 * A shared constant here was a data-loss bug: every Chinese-named theme got
 * the same id, and `saveCustomTheme` de-duplicates by id, so saving a second
 * one silently deleted the first. Deriving the suffix from the name keeps
 * re-saving the *same* name an update (same id, as intended) while two
 * different names no longer collide.
 */
function fallbackThemeId(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    hash = (Math.imul(hash, 31) + name.charCodeAt(index)) | 0;
  }
  return `custom-theme-${(hash >>> 0).toString(36)}`;
}

/** `我的主题 2` → `my-theme-2`-ish; non-latin names get a name-derived id. */
export function slugifyThemeId(input: string): string {
  const trimmed = input.trim();
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // The id is an internal selector token; the label keeps the player's
  // original text either way.
  return slug.length >= 2 ? slug : fallbackThemeId(trimmed);
}

/**
 * Keep the id off the builtin namespace.
 *
 * A custom theme claiming a builtin id is dropped on the next registry sync
 * (builtins always win), so saving one would look like it worked and then
 * silently vanish. Colliding with another *custom* id is left alone — that is
 * the player updating their own theme.
 */
export function ensureThemeId(
  desired: string,
  builtinIds: readonly string[],
): string {
  if (!builtinIds.includes(desired)) return desired;
  let suffix = 2;
  while (builtinIds.includes(`${desired}-${suffix}`)) suffix++;
  return `${desired}-${suffix}`;
}
