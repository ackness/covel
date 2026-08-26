import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Download, RotateCcw, Save, Upload } from "lucide-react";
import { resolveI18nText } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { ThemeManagerWidget } from "@/components/theme-manager.js";
import { TokenControl } from "@/components/appearance/TokenControl.js";
import { useSetting, useSettingsStore } from "@/settings/use-settings.js";
import { THEME_SCHEME_KEY } from "@/lib/appearance.js";
import {
  getRegisteredThemes,
  saveCustomTheme,
} from "@/theme-system/registry.js";
import {
  buildThemeCss,
  ensureThemeId,
  slugifyThemeId,
} from "@/theme-system/theme-export.js";
import { TOKEN_GROUPS, type TokenGroup } from "@/theme-system/token-schema.js";
import {
  APPEARANCE_TOKENS_KEY,
  clearOverrides,
  clearTokenOverride,
  countOverrides,
  getTokenOverride,
  loadOverrides,
  readTokenDefaults,
  replaceOverrides,
  setTokenOverride,
  type AppearanceOverrides,
} from "@/theme-system/overrides.js";
import type { ThemeScheme } from "@/theme-system/types.js";

export function AppearancePane() {
  const { t, i18n } = useTranslation();
  const store = useSettingsStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const [rawOverrides] = useSetting<unknown>(APPEARANCE_TOKENS_KEY);
  const [appearance, setAppearance] = useSetting<string>("ui.appearance");
  const [scheme] = useSetting<ThemeScheme>(THEME_SCHEME_KEY);

  const overrides = useMemo<AppearanceOverrides>(
    () => loadOverrides(store),
    [store, rawOverrides],
  );

  // The baseline the controls sit on is whatever the *theme* resolves to, so
  // it has to be re-read whenever the theme or scheme changes underneath.
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  useEffect(() => {
    setDefaults(readTokenDefaults());
  }, [appearance, scheme]);

  const customCount = countOverrides(overrides);
  const activeScheme: ThemeScheme = scheme === "light" ? "light" : "dark";

  const [themeName, setThemeName] = useState("");
  const [saving, setSaving] = useState(false);

  /**
   * Bake the active theme + overrides into a standalone theme package, switch
   * to it, and drop the overrides — they are now part of the theme, so keeping
   * them would leave the player with a permanently "customised" badge over a
   * theme that already contains those exact values.
   */
  async function handleSaveAsTheme(): Promise<void> {
    const label = themeName.trim();
    if (!label || saving) return;
    setSaving(true);
    setError(null);
    try {
      const registered = getRegisteredThemes();
      const builtinIds = registered
        .filter((theme) => theme.source === "builtin")
        .map((theme) => theme.id);
      const id = ensureThemeId(slugifyThemeId(label), builtinIds);
      // Carry the source theme's scheme support: a dark-only theme must not
      // come out of the snapshot labelled light-only.
      const sourceSchemes = registered.find(
        (theme) => theme.id === appearance,
      )?.schemes;
      const snapshot = buildThemeCss(store, id, sourceSchemes);

      await saveCustomTheme(store, {
        id,
        label,
        source: "custom",
        schemes: snapshot.schemes,
        cssText: snapshot.cssText,
      });
      await setAppearance(id);
      await clearOverrides(store);
      setThemeName("");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t("appearance.saveThemeFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  function handleExport(): void {
    const blob = new Blob([JSON.stringify(overrides, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "covel-appearance.json";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  async function handleImport(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object") {
        throw new Error(t("appearance.importInvalid"));
      }
      // Unknown tokens and non-string values are dropped downstream, so a
      // hand-edited or hostile file can only ever set real tokens.
      await replaceOverrides(store, parsed as AppearanceOverrides);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t("appearance.importInvalid"),
      );
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-5">
      <ThemeManagerWidget />

      <div className="ui-section pb-3">
        <div className="ui-section-head">
          <span className="ui-section-title">
            {t("appearance.customizeTitle")}
          </span>
          <span className="ui-tag ml-2">
            {customCount > 0
              ? t("appearance.customizedCount", { count: customCount })
              : t("appearance.usingThemeDefaults")}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t("appearance.import")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={customCount === 0}
              onClick={handleExport}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t("appearance.export")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={customCount === 0}
              onClick={() => void clearOverrides(store)}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {t("appearance.resetAll")}
            </Button>
          </div>
        </div>
        <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
          {t("appearance.customizeDesc", {
            scheme: t(`settings.themeScheme.${activeScheme}`),
          })}
        </p>

        <div className="ui-frame flex flex-wrap items-center gap-2 p-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              {t("appearance.saveAsThemeTitle")}
            </p>
            <p className="ui-meta normal-case tracking-normal text-[10px] leading-relaxed">
              {t("appearance.saveAsThemeHint")}
            </p>
          </div>
          <input
            type="text"
            value={themeName}
            // A placeholder is not a reliable accessible name and disappears
            // as soon as the player types.
            aria-label={t("appearance.saveAsThemeTitle")}
            placeholder={t("appearance.themeNamePlaceholder")}
            onChange={(event) => setThemeName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSaveAsTheme();
            }}
            className="w-44 rounded-(--radius-control) border border-(--rule-color) bg-(--surface-page) px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-(--accent-primary)"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={saving || themeName.trim().length === 0}
            onClick={() => void handleSaveAsTheme()}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {t("appearance.saveAsTheme")}
          </Button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(event) => void handleImport(event)}
        />
        {error && (
          <div className="ui-band text-xs" data-tone="danger">
            <span className="text-(--accent-danger)">{error}</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {TOKEN_GROUPS.map((group, index) => (
          <TokenGroupSection
            key={group.id}
            group={group}
            defaultOpen={index === 0}
            locale={i18n.language}
            overrides={overrides}
            scheme={activeScheme}
            defaults={defaults}
            onCommit={(name, value) =>
              void setTokenOverride(store, name, value)
            }
            onReset={(name) => void clearTokenOverride(store, name)}
            onResetGroup={() =>
              void clearOverrides(
                store,
                group.tokens.map((token) => token.name),
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

interface TokenGroupSectionProps {
  readonly group: TokenGroup;
  readonly defaultOpen: boolean;
  readonly locale: string;
  readonly overrides: AppearanceOverrides;
  readonly scheme: ThemeScheme;
  readonly defaults: Record<string, string>;
  readonly onCommit: (name: string, value: string) => void;
  readonly onReset: (name: string) => void;
  readonly onResetGroup: () => void;
}

function TokenGroupSection({
  group,
  defaultOpen,
  locale,
  overrides,
  scheme,
  defaults,
  onCommit,
  onReset,
  onResetGroup,
}: TokenGroupSectionProps) {
  const { t } = useTranslation();
  const touched = group.tokens.filter(
    (token) => getTokenOverride(overrides, token.name, scheme) !== null,
  ).length;

  return (
    <details
      open={defaultOpen}
      className="ui-frame group/section overflow-hidden [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 hover:bg-(--surface-inset)">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50 transition-transform group-open/section:rotate-90" />
        <span className="ui-section-title">
          {resolveI18nText(group.label, locale) ?? group.id}
        </span>
        {touched > 0 && <span className="ui-tag ui-tag-solid">{touched}</span>}
        <span className="ui-meta ml-auto hidden truncate normal-case tracking-normal sm:block">
          {resolveI18nText(group.description, locale) ?? ""}
        </span>
      </summary>

      <div className="border-t border-(--rule-color) px-3 pb-2">
        {group.tokens.map((spec) => (
          <TokenControl
            key={spec.name}
            spec={spec}
            themeDefault={defaults[spec.name] ?? ""}
            override={getTokenOverride(overrides, spec.name, scheme)}
            onCommit={(value) => onCommit(spec.name, value)}
            onReset={() => onReset(spec.name)}
          />
        ))}
        {touched > 0 && (
          <div className="flex justify-end pt-1">
            <Button size="sm" variant="ghost" onClick={onResetGroup}>
              <RotateCcw className="mr-1.5 h-3 w-3" />
              {t("appearance.resetGroup")}
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
