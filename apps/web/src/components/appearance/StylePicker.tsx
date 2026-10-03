import { useTranslation } from "react-i18next";
import { resolveI18nText } from "@covel/shared";
import { Check } from "lucide-react";
import { useSetting } from "@/settings/use-settings.js";
import { THEME_SCHEME_KEY } from "@/lib/appearance.js";
import { getRegisteredThemes } from "@/theme-system/registry.js";
import { groupThemes } from "@/theme-system/groups.js";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
import {
  resolveThemeLayout,
  type ResolvedThemeLayout,
} from "@/theme-system/layout.js";
import type { ThemeDefinition, ThemeScheme } from "@/theme-system/types.js";

interface PreviewColors {
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
  readonly border: string;
  readonly card: string;
}

const PREVIEW_TOKENS = {
  background: "--color-background",
  foreground: "--color-foreground",
  accent: "--color-primary",
  border: "--color-border",
  card: "--color-card",
} as const;

/**
 * Read a theme's headline colours straight from its CSS so a card can show the
 * package before it is applied — its rules only match once `data-theme` is on
 * the document root. A value that references another variable would resolve
 * against the *active* theme, so those fall through to the fallback.
 */
export function readPreviewColors(
  cssText: string,
  scheme: ThemeScheme,
): Partial<PreviewColors> {
  const darkAt = cssText.search(/\.dark\b/);
  const segments =
    scheme === "dark" && darkAt !== -1
      ? [cssText.slice(darkAt), cssText]
      : [darkAt === -1 ? cssText : cssText.slice(0, darkAt), cssText];
  const colors: Partial<Record<keyof PreviewColors, string>> = {};
  for (const [name, token] of Object.entries(PREVIEW_TOKENS) as Array<
    [keyof PreviewColors, string]
  >) {
    const pattern = new RegExp(`${token}\\s*:\\s*([^;}]+)[;}]`);
    for (const segment of segments) {
      const value = segment.match(pattern)?.[1]?.trim();
      if (value && !value.includes("var(")) {
        colors[name] = value;
        break;
      }
    }
  }
  return colors;
}

function LayoutThumbnail({
  layout,
  colors,
}: {
  readonly layout: ResolvedThemeLayout;
  readonly colors: Partial<PreviewColors>;
}) {
  const background = colors.background ?? "var(--surface-page)";
  const foreground = colors.foreground ?? "var(--color-foreground)";
  const accent = colors.accent ?? "var(--accent-primary)";
  const border = colors.border ?? "var(--rule-color)";
  const card = colors.card ?? "var(--surface-elevated)";
  const line = (width: string, opacity = 0.55) => (
    <span
      className="block h-0.75 rounded-full"
      style={{ width, background: foreground, opacity }}
    />
  );
  const scene = layout.backdrop === "scene";
  const margin = layout.turnNotes === "margin";
  return (
    <div
      aria-hidden="true"
      className="flex aspect-16/10 w-full overflow-hidden rounded-(--radius-control) border"
      style={{ background, borderColor: border }}
    >
      {layout.nav === "rail" && (
        <div
          className="flex w-[9%] shrink-0 flex-col items-center gap-1 border-r pt-1.5"
          style={{ borderColor: border }}
        >
          <span
            className="h-1.5 w-1.5 rounded-xs"
            style={{ background: accent }}
          />
          {line("45%", 0.35)}
          {line("45%", 0.35)}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {layout.nav === "top" && (
          <div
            className="flex h-[13%] shrink-0 items-center gap-1 border-b px-1.5"
            style={{ borderColor: border }}
          >
            <span
              className="h-1.5 w-1.5 rounded-xs"
              style={{ background: accent }}
            />
            {line("10%", 0.35)}
            {line("10%", 0.35)}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div
            className="flex min-w-0 flex-1 p-1.5"
            style={
              scene
                ? {
                    background: `linear-gradient(120deg, color-mix(in oklab, ${accent} 45%, ${background}), ${background} 75%)`,
                  }
                : undefined
            }
          >
            <div
              className={`flex flex-col justify-center gap-1 ${scene ? "ml-auto w-[58%] rounded-xs border p-1" : margin ? "ml-[6%] w-[58%]" : "mx-auto w-[78%]"}`}
              style={
                scene ? { background: card, borderColor: border } : undefined
              }
            >
              {layout.backdrop === "banner" && (
                <span
                  className="mb-0.5 block h-2 w-full rounded-xs"
                  style={{
                    background: `color-mix(in oklab, ${accent} 45%, ${background})`,
                  }}
                />
              )}
              {line("100%")}
              {line("92%")}
              {line("64%")}
              <span
                className="mt-0.5 block h-1 w-[38%] rounded-full"
                style={{ background: accent }}
              />
            </div>
            {margin && (
              <div className="ml-[7%] flex w-[20%] flex-col justify-center gap-1">
                {line("100%", 0.3)}
                {line("70%", 0.3)}
              </div>
            )}
          </div>
          <div
            className={`flex w-[27%] shrink-0 border-l ${layout.panelTabs === "bar" ? "flex-col" : ""}`}
            style={{ borderColor: border, background: card }}
          >
            <div
              className={`flex shrink-0 gap-0.5 ${
                layout.panelTabs === "bar"
                  ? "border-b px-1 py-1"
                  : "w-[26%] flex-col items-center border-r py-1"
              }`}
              style={{ borderColor: border }}
            >
              <span
                className="h-1 w-1.5 rounded-full"
                style={{ background: accent }}
              />
              <span
                className="h-1 w-1.5 rounded-full"
                style={{ background: foreground, opacity: 0.3 }}
              />
              <span
                className="h-1 w-1.5 rounded-full"
                style={{ background: foreground, opacity: 0.3 }}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 p-1">
              {line("90%", 0.4)}
              {line("70%", 0.4)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Primary style chooser. A card is a style — a group of theme packages — drawn
 * with the layout it asks for; a style with several packages offers them as
 * colourways. Management (import, export, delete) stays in the theme library.
 */
export function StylePicker() {
  const { t, i18n } = useTranslation();
  const [appearance, setAppearance] = useSetting<string>("ui.appearance");
  const [scheme, setScheme] = useSetting<ThemeScheme>(THEME_SCHEME_KEY);
  // Subscribing keeps the cards in step with imports and removals.
  useSetting<unknown>(CUSTOM_THEMES_KEY);
  const groups = groupThemes(getRegisteredThemes());
  const activeScheme: ThemeScheme = scheme === "light" ? "light" : "dark";
  // Show each package in the scheme it would actually open in.
  const previewScheme = (theme: ThemeDefinition): ThemeScheme =>
    theme.schemes.includes(activeScheme)
      ? activeScheme
      : (theme.schemes[0] ?? activeScheme);
  const text = (value: ThemeDefinition["label"] | undefined) =>
    resolveI18nText(value, i18n.language);

  return (
    <div className="ui-section pb-4">
      <div className="ui-section-head">
        <span className="ui-section-title">{t("appearance.styleTitle")}</span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {t("appearance.styleDesc")}
      </p>
      {/* Style cards are toggle buttons, not radios: each card holds its own
          colourway radio group, and radio groups must not nest. */}
      <div
        role="group"
        aria-label={t("appearance.styleTitle")}
        className="grid grid-cols-2 gap-3 md:grid-cols-3"
      >
        {groups.map((group) => {
          const active = group.members.find(
            (member) => member.id === appearance,
          );
          const selected = active !== undefined;
          // An unselected style previews, and opens on, its first colourway.
          const shown = active ?? group.members[0]!;
          const label = text(group.label) ?? group.id;
          const description = text(shown.description);
          return (
            <div
              key={group.id}
              className={`ui-style-card flex flex-col gap-2 rounded-(--radius-card) border p-2.5 transition-colors ${
                selected
                  ? "border-(--accent-primary) bg-[color-mix(in_oklab,var(--accent-primary)_7%,transparent)]"
                  : "border-(--rule-color) hover:border-(--rule-strong-color)"
              }`}
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  if (!selected) void setAppearance(shown.id);
                }}
                className="flex flex-col gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-(--radius-control)"
              >
                <LayoutThumbnail
                  layout={resolveThemeLayout(shown.layout)}
                  colors={readPreviewColors(
                    shown.cssText,
                    previewScheme(shown),
                  )}
                />
                <span className="flex items-center gap-1.5">
                  <span className="ui-section-title truncate">{label}</span>
                  {selected && (
                    <Check
                      className="h-3.5 w-3.5 shrink-0 text-(--accent-primary)"
                      aria-hidden
                    />
                  )}
                </span>
                {description && (
                  <span className="text-xs leading-relaxed text-muted-foreground line-clamp-3">
                    {description}
                  </span>
                )}
              </button>

              {group.members.length > 1 && (
                <div
                  role="radiogroup"
                  aria-label={`${label} · ${t("appearance.paletteLabel")}`}
                  className="flex flex-wrap gap-1.5"
                >
                  {group.members.map((member) => {
                    const colors = readPreviewColors(
                      member.cssText,
                      previewScheme(member),
                    );
                    const current = member.id === appearance;
                    return (
                      <button
                        key={member.id}
                        type="button"
                        role="radio"
                        aria-checked={current}
                        onClick={() => void setAppearance(member.id)}
                        className={`ui-style-palette inline-flex h-7 items-center gap-1.5 rounded-(--radius-chip) border px-2 text-[11px] transition-colors ${
                          current
                            ? "border-(--accent-primary) text-foreground"
                            : "border-(--rule-color) text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="h-3 w-3 shrink-0 rounded-full border"
                          style={{
                            background: `linear-gradient(135deg, ${colors.background ?? "var(--surface-page)"} 50%, ${colors.accent ?? "var(--accent-primary)"} 50%)`,
                            borderColor: colors.border ?? "var(--rule-color)",
                          }}
                        />
                        {/* The package the style is named after is its
                            original colourway. */}
                        {member.id === group.id
                          ? t("appearance.paletteDefault")
                          : (text(member.label) ?? member.id)}
                      </button>
                    );
                  })}
                </div>
              )}

              {active && active.schemes.length > 1 && (
                <div
                  className="mt-auto flex w-fit items-center overflow-hidden rounded-(--radius-control) border border-(--rule-color)"
                  role="group"
                  aria-label={t("settings.themeSchemeLabel")}
                >
                  {(["light", "dark"] as const).map((next) => (
                    <button
                      key={next}
                      type="button"
                      aria-pressed={activeScheme === next}
                      onClick={() => void setScheme(next)}
                      className={`h-7 px-2.5 text-[11px] transition-colors ${
                        activeScheme === next
                          ? "bg-foreground text-(--surface-page)"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t(`settings.themeScheme.${next}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
