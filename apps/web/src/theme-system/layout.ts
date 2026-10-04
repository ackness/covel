import { z } from "zod";

/**
 * Layout is the structural half of a theme package: where navigation sits, how
 * the context panel presents its tabs, what the session does with world art,
 * and which world-select arrangement to use. CSS tokens cannot express these,
 * so a package names a preset (and may override single options) and the app
 * shell reads the resolved result.
 */
const THEME_NAV_PLACEMENTS = ["top", "rail"] as const;
const THEME_PANEL_TABS = ["rail", "bar"] as const;
const THEME_SESSION_BACKDROPS = ["ambient", "scene", "banner", "none"] as const;
const THEME_WORLD_LISTS = ["covers", "cards", "list", "showcase"] as const;
const THEME_TURN_NOTES = ["fold", "inline", "margin"] as const;
const THEME_LAYOUT_PRESET_IDS = ["classic", "book", "stage", "panel"] as const;

export type ThemeNavPlacement = (typeof THEME_NAV_PLACEMENTS)[number];
export type ThemePanelTabs = (typeof THEME_PANEL_TABS)[number];
export type ThemeSessionBackdrop = (typeof THEME_SESSION_BACKDROPS)[number];
export type ThemeWorldList = (typeof THEME_WORLD_LISTS)[number];
export type ThemeTurnNotes = (typeof THEME_TURN_NOTES)[number];
export type ThemeLayoutPresetId = (typeof THEME_LAYOUT_PRESET_IDS)[number];

export interface ThemeLayoutOptions {
  /** Primary navigation: a top bar, or an icon rail down the left edge. */
  readonly nav: ThemeNavPlacement;
  /** Context-panel tabs: a vertical icon rail, or a labelled bar on top. */
  readonly panelTabs: ThemePanelTabs;
  /**
   * World art in the session: a faint ambient wash, the full-bleed current
   * scene with the story in a side column, a chapter banner that opens the
   * story, or nothing.
   */
  readonly backdrop: ThemeSessionBackdrop;
  /**
   * World-select arrangement: full-bleed cover plates, cover-over-copy cards,
   * a reading list, or one hero world with a thumbnail strip.
   */
  readonly worldList: ThemeWorldList;
  /**
   * Where a turn's read-only results (checks, state changes, discoveries) go:
   * folded under the story, shown open for the latest turn, or set in the
   * page margin beside it when the column is wide enough.
   */
  readonly turnNotes: ThemeTurnNotes;
}

/** What a theme package declares: a preset plus optional per-option overrides. */
export interface ThemeLayoutSpec extends Partial<ThemeLayoutOptions> {
  readonly preset?: ThemeLayoutPresetId;
}

export interface ResolvedThemeLayout extends ThemeLayoutOptions {
  readonly preset: ThemeLayoutPresetId;
}

const DEFAULT_LAYOUT_PRESET: ThemeLayoutPresetId = "classic";

export const THEME_LAYOUT_PRESETS: Record<
  ThemeLayoutPresetId,
  ThemeLayoutOptions
> = {
  classic: {
    nav: "top",
    panelTabs: "rail",
    backdrop: "ambient",
    worldList: "covers",
    turnNotes: "fold",
  },
  book: {
    nav: "top",
    panelTabs: "bar",
    backdrop: "banner",
    worldList: "list",
    turnNotes: "margin",
  },
  stage: {
    nav: "top",
    panelTabs: "bar",
    backdrop: "scene",
    worldList: "showcase",
    turnNotes: "inline",
  },
  panel: {
    nav: "rail",
    panelTabs: "bar",
    backdrop: "none",
    worldList: "cards",
    turnNotes: "inline",
  },
};

export const themeLayoutSpecSchema = z
  .object({
    preset: z.enum(THEME_LAYOUT_PRESET_IDS).optional(),
    nav: z.enum(THEME_NAV_PLACEMENTS).optional(),
    panelTabs: z.enum(THEME_PANEL_TABS).optional(),
    backdrop: z.enum(THEME_SESSION_BACKDROPS).optional(),
    worldList: z.enum(THEME_WORLD_LISTS).optional(),
    turnNotes: z.enum(THEME_TURN_NOTES).optional(),
  })
  .strict();

export function resolveThemeLayout(
  spec: ThemeLayoutSpec | null | undefined,
): ResolvedThemeLayout {
  const preset = spec?.preset ?? DEFAULT_LAYOUT_PRESET;
  const base = THEME_LAYOUT_PRESETS[preset];
  return {
    preset,
    nav: spec?.nav ?? base.nav,
    panelTabs: spec?.panelTabs ?? base.panelTabs,
    backdrop: spec?.backdrop ?? base.backdrop,
    worldList: spec?.worldList ?? base.worldList,
    turnNotes: spec?.turnNotes ?? base.turnNotes,
  };
}

/** Stored and imported packages are untrusted: an invalid layout is dropped. */
export function parseThemeLayoutSpec(
  value: unknown,
): ThemeLayoutSpec | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = themeLayoutSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Publish the resolved layout on the document root. Each option gets its own
 * attribute so framework CSS keys on the option (`html[data-backdrop="scene"]`)
 * rather than on a preset name — a package that overrides one option still
 * gets the matching structural styles.
 */
export function applyThemeLayout(layout: ResolvedThemeLayout): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-layout", layout.preset);
  root.setAttribute("data-nav", layout.nav);
  root.setAttribute("data-panel-tabs", layout.panelTabs);
  root.setAttribute("data-backdrop", layout.backdrop);
  root.setAttribute("data-world-list", layout.worldList);
  root.setAttribute("data-turn-notes", layout.turnNotes);
}
