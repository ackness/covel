import { contrastRatio } from "./color.js";
import type { ThemeDefinition, ThemeScheme } from "./types.js";

export const CONTRAST_PAIRS = [
  {
    id: "body",
    foreground: "--color-foreground",
    background: "--color-background",
    minimum: 4.5,
  },
  {
    id: "muted",
    foreground: "--color-muted-foreground",
    background: "--color-background",
    minimum: 3,
  },
  {
    id: "button",
    foreground: "--color-primary-foreground",
    background: "--color-primary",
    minimum: 4.5,
  },
] as const;
export interface ThemeContrastResult {
  scheme: ThemeScheme;
  pair: (typeof CONTRAST_PAIRS)[number]["id"];
  ratio: number | null;
  minimum: number;
}

function checkContrastTokens(
  tokens: Readonly<Record<string, string>>,
  scheme: ThemeScheme,
): ThemeContrastResult[] {
  return CONTRAST_PAIRS.map((pair) => ({
    scheme,
    pair: pair.id,
    minimum: pair.minimum,
    ratio:
      tokens[pair.foreground] && tokens[pair.background]
        ? contrastRatio(tokens[pair.foreground]!, tokens[pair.background]!)
        : null,
  }));
}

/** Inspect declared token pairs in an isolated document; never mount a preview over the app. */
export function checkThemeContrast(
  theme: Pick<ThemeDefinition, "id" | "schemes" | "cssText">,
): ThemeContrastResult[] {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("sandbox", "allow-same-origin");
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win)
      return theme.schemes.flatMap((scheme) => checkContrastTokens({}, scheme));
    const style = doc.createElement("style");
    style.textContent = theme.cssText;
    doc.head.append(style);
    doc.documentElement.dataset.theme = theme.id;
    return theme.schemes.flatMap((scheme) => {
      doc.documentElement.dataset.scheme = scheme;
      doc.documentElement.classList.toggle("dark", scheme === "dark");
      const computed = win.getComputedStyle(doc.documentElement);
      const resolve = (name: string, seen = new Set<string>()): string => {
        if (seen.has(name)) return "";
        seen.add(name);
        const value = computed.getPropertyValue(name).trim();
        return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, target: string) =>
          resolve(target, new Set(seen)),
        );
      };
      const tokens = Object.fromEntries(
        CONTRAST_PAIRS.flatMap((pair) => [
          pair.foreground,
          pair.background,
        ]).map((token) => [token, resolve(token)]),
      );
      return checkContrastTokens(tokens, scheme);
    });
  } finally {
    frame.remove();
  }
}
